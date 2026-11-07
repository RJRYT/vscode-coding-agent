import { MAX_PATCH_TEXT_CHARS, MAX_PATCH_TOTAL_CHARS } from './limits';
export interface TextPatch {
  oldText: string;
  newText: string;
}

export interface ResolvedTextPatch extends TextPatch {
  start: number;
  end: number;
}

export interface PatchResult {
  text: string;
  patches: ResolvedTextPatch[];
}

function normalizeNewlines(value: string): string {
  return value.replace(/\r\n/g, '\n');
}

function dominantNewline(source: string): string {
  const crlf = (source.match(/\r\n/g) ?? []).length;
  const lf = (source.match(/(?<!\r)\n/g) ?? []).length;
  return crlf > lf ? '\r\n' : '\n';
}

function withNewlineStyle(value: string, newline: string): string {
  return normalizeNewlines(value).replace(/\n/g, newline);
}

/** Translate an offset in LF-normalized text back to the original source. */
function normalizedOffsetToSource(source: string, normalizedOffset: number): number {
  let normalizedIndex = 0;
  for (let sourceIndex = 0; sourceIndex < source.length; sourceIndex++) {
    if (normalizedIndex === normalizedOffset) return sourceIndex;
    if (source[sourceIndex] === '\r' && source[sourceIndex + 1] === '\n') {
      sourceIndex++; // CRLF represents one normalized LF character.
    }
    normalizedIndex++;
  }
  return source.length;
}


interface AnchorMatch { start: number; end: number; replacementText: string; mode: string }

function findUnique(source: string, anchor: string): { start: number; end: number } | undefined {
  if (!anchor) return undefined;
  const start = source.indexOf(anchor);
  if (start < 0) return undefined;
  if (source.indexOf(anchor, start + 1) >= 0) {
    throw new Error('ambiguous');
  }
  return { start, end: start + anchor.length };
}

/** Decode a model's accidentally double-escaped source snippet, e.g. \"src\" -> "src". */
function decodeEscapedAnchor(value: string): string | undefined {
  const candidates = new Set<string>();
  let current = value;
  for (let depth = 0; depth < 4; depth++) {
    let next = current
      .replace(/\\+"/g, '"')
      .replace(/\\n/g, '\n')
      .replace(/\\r/g, '\r')
      .replace(/\\t/g, '\t')
      .replace(/\\\\/g, '\\');
    if (next === current) {
      try {
        const wrapped = JSON.parse(`"${current.replace(/"/g, '\\"')}"`);
        if (typeof wrapped === 'string') next = wrapped;
      } catch {
        // Not a complete JSON string fragment; try the explicit escape rules above.
      }
    }
    if (next === current) break;
    candidates.add(next);
    current = next;
  }
  for (const candidate of candidates) {
    if (candidate !== value && candidate.trim()) return candidate;
  }
  return undefined;
}

function lineRecords(value: string): Array<{ text: string; start: number; end: number }> {
  const records: Array<{ text: string; start: number; end: number }> = [];
  let start = 0;
  for (let index = 0; index <= value.length; index++) {
    if (index === value.length || value[index] === '\n') {
      const end = index > start && value[index - 1] === '\r' ? index - 1 : index;
      records.push({ text: value.slice(start, end), start, end });
      start = index + 1;
    }
  }
  return records;
}

/**
 * Conservative formatting recovery: match a complete contiguous line block
 * while ignoring only leading/trailing horizontal whitespace on each line.
 * Internal spaces, tokens, punctuation and line order must still match.
 */
function findWhitespaceEquivalent(source: string, anchor: string, replacement: string): AnchorMatch | undefined {
  const anchorLines = lineRecords(normalizeNewlines(anchor));
  const sourceLines = lineRecords(source);
  if (!anchorLines.length || anchorLines.some((line) => !line.text.trim())) return undefined;
  const expected = anchorLines.map((line) => line.text.trim());
  const matches: number[] = [];
  for (let start = 0; start <= sourceLines.length - expected.length; start++) {
    let matchesBlock = true;
    for (let offset = 0; offset < expected.length; offset++) {
      if (sourceLines[start + offset].text.trim() !== expected[offset]) {
        matchesBlock = false;
        break;
      }
    }
    if (matchesBlock) matches.push(start);
    if (matches.length > 1) throw new Error('ambiguous');
  }
  if (!matches.length) return undefined;
  const first = sourceLines[matches[0]];
  const last = sourceLines[matches[0] + expected.length - 1];
  const replacementLines = normalizeNewlines(replacement).split('\n');
  const adjusted = replacementLines.map((line, index) => {
    if (!line.trim()) return line;
    const anchorLine = anchorLines[Math.min(index, anchorLines.length - 1)].text;
    const sourceLine = sourceLines[matches[0] + Math.min(index, expected.length - 1)].text;
    const anchorIndent = anchorLine.match(/^[\t ]*/)?.[0] ?? '';
    const sourceIndent = sourceLine.match(/^[\t ]*/)?.[0] ?? '';
    if (anchorIndent === sourceIndent) return line;
    if (anchorIndent && line.startsWith(anchorIndent)) return sourceIndent + line.slice(anchorIndent.length);
    if (!anchorIndent) return sourceIndent + line;
    return line;
  }).join('\n');
  return {
    start: first.start,
    end: last.end,
    replacementText: withNewlineStyle(adjusted, dominantNewline(source)),
    mode: 'line-whitespace-normalized',
  };
}

function resolveAnchor(source: string, oldText: string, newText: string): AnchorMatch | undefined {
  try {
    const exact = findUnique(source, oldText);
    if (exact) return { ...exact, replacementText: newText, mode: 'exact' };
  } catch { throw new Error('ambiguous'); }

  const normalizedSource = normalizeNewlines(source);
  const normalizedAnchor = normalizeNewlines(oldText);
  try {
    const normalized = findUnique(normalizedSource, normalizedAnchor);
    if (normalized) {
      return {
        start: normalizedOffsetToSource(source, normalized.start),
        end: normalizedOffsetToSource(source, normalized.end),
        replacementText: withNewlineStyle(newText, dominantNewline(source)),
        mode: 'line-ending-normalized',
      };
    }
  } catch { throw new Error('ambiguous'); }

  const decoded = decodeEscapedAnchor(oldText);
  if (decoded) {
    try {
      const escaped = findUnique(source, decoded);
      if (escaped) return { ...escaped, replacementText: newText, mode: 'json-escape-normalized' };
    } catch { throw new Error('ambiguous'); }
    try {
      const escapedNormalized = findUnique(normalizedSource, normalizeNewlines(decoded));
      if (escapedNormalized) {
        return {
          start: normalizedOffsetToSource(source, escapedNormalized.start),
          end: normalizedOffsetToSource(source, escapedNormalized.end),
          replacementText: withNewlineStyle(newText, dominantNewline(source)),
          mode: 'json-escape-and-line-ending-normalized',
        };
      }
    } catch { throw new Error('ambiguous'); }
  }

  const whitespace = findWhitespaceEquivalent(source, oldText, newText);
  if (whitespace) return whitespace;
  if (decoded) {
    const decodedWhitespace = findWhitespaceEquivalent(source, decoded, newText);
    if (decodedWhitespace) return { ...decodedWhitespace, mode: 'json-escape-and-whitespace-normalized' };
  }
  return undefined;
}

/**
 * Resolve exact, unique text anchors against one immutable source snapshot.
 * Only exact, line-ending, JSON-escape, and conservative complete-line whitespace recovery are allowed. Ambiguous anchors are rejected.
 */
export function applyExactTextPatches(source: string, changes: TextPatch[]): PatchResult {
  if (!Array.isArray(changes) || changes.length === 0) {
    throw new Error('At least one targeted edit is required.');
  }
  if (changes.length > 20) {
    throw new Error('A single edit request may contain at most 20 targeted changes.');
  }

  const resolved: ResolvedTextPatch[] = [];
  let totalPatchChars = 0;
  for (let index = 0; index < changes.length; index++) {
    const change = changes[index];
    if (
      !change ||
      typeof change.oldText !== 'string' ||
      typeof change.newText !== 'string' ||
      change.oldText.length === 0
    ) {
      throw new Error(`Edit ${index + 1} must include non-empty oldText and string newText values.`);
    }
    if (change.oldText === change.newText) {
      throw new Error(`Edit ${index + 1} does not change any text.`);
    }
    if (change.oldText.includes('\0') || change.newText.includes('\0')) {
      throw new Error(`Edit ${index + 1} contains a null byte.`);
    }
    if (change.oldText.length > MAX_PATCH_TEXT_CHARS || change.newText.length > MAX_PATCH_TEXT_CHARS) {
      throw new Error(`Edit ${index + 1} exceeds the ${MAX_PATCH_TEXT_CHARS.toLocaleString()}-character per-field limit.`);
    }
    totalPatchChars += change.oldText.length + change.newText.length;
    if (totalPatchChars > MAX_PATCH_TOTAL_CHARS) {
      throw new Error(`Combined patch payload exceeds ${MAX_PATCH_TOTAL_CHARS.toLocaleString()} characters. Split the changes into separate tool calls.`);
    }
    // An exact full-snapshot replacement is safe: it is still anchored to the
    // complete current contents and the caller revalidates the snapshot after approval.

    let match: AnchorMatch | undefined;
    try {
      match = resolveAnchor(source, change.oldText, change.newText);
    } catch (error) {
      if (error instanceof Error && error.message === 'ambiguous') {
        throw new Error(`Edit ${index + 1} is ambiguous. Include more surrounding source context so the anchor matches exactly once.`);
      }
      throw error;
    }
    if (!match) {
      const firstLine = change.oldText.split(/\r?\n/, 1)[0].trim().slice(0, 100);
      throw new Error(
        `Edit ${index + 1} could not be matched in the current file snapshot. Anchor preview: ${JSON.stringify(firstLine)}. The anchor may be JSON-escaped, formatted differently, or stale. Reread the file and copy the exact source text into oldText; do not include JSON escaping around source quotes.`
      );
    }
    const { start, end, replacementText } = match;


    resolved.push({ ...change, newText: replacementText, start, end });
  }

  const ordered = [...resolved].sort((a, b) => a.start - b.start);
  for (let index = 1; index < ordered.length; index++) {
    if (ordered[index].start < ordered[index - 1].end) {
      throw new Error('Two proposed edits overlap. Combine them into one targeted edit or adjust their anchors.');
    }
  }

  let text = source;
  for (const patch of [...ordered].reverse()) {
    text = text.slice(0, patch.start) + patch.newText + text.slice(patch.end);
  }

  return { text, patches: ordered };
}

export function createPatchPreview(patches: ResolvedTextPatch[], maxChars = 12_000): {
  oldPreview: string;
  newPreview: string;
} {
  const format = (kind: 'oldText' | 'newText') => {
    let output = '';
    for (let index = 0; index < patches.length; index++) {
      const block = `// Change ${index + 1} of ${patches.length}\n${patches[index][kind]}\n\n`;
      if (output.length + block.length > maxChars) {
        output += '\n[Preview truncated. The full targeted changes will be applied after approval.]';
        break;
      }
      output += block;
    }
    return output.trim();
  };
  return { oldPreview: format('oldText'), newPreview: format('newText') };
}
