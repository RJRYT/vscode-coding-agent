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
  matchingMode?: 'exact' | 'line-ending-normalized';
}

function normalizeWithOffsets(value: string): { text: string; offsets: number[] } {
  let text = '';
  const offsets: number[] = [];
  for (let index = 0; index < value.length; index++) {
    offsets.push(index);
    const char = value[index];
    if (char === '\r') {
      text += '\n';
      if (value[index + 1] === '\n') index++;
    } else {
      text += char;
    }
  }
  offsets.push(value.length);
  return { text, offsets };
}

function normalizeLineEndings(value: string): string {
  return value.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function preferredEol(source: string): string {
  const crlf = (source.match(/\r\n/g) || []).length;
  const lf = (source.match(/(?<!\r)\n/g) || []).length;
  return crlf > lf ? '\r\n' : '\n';
}

function countOccurrences(source: string, needle: string): { first: number; count: number } {
  let first = -1;
  let count = 0;
  let from = 0;
  while (true) {
    const index = source.indexOf(needle, from);
    if (index < 0) break;
    if (first < 0) first = index;
    count++;
    from = index + 1;
  }
  return { first, count };
}

/**
 * Resolve exact unique anchors against one immutable VS Code document snapshot.
 * A line-ending-only normalization fallback handles LF/CRLF differences without
 * fuzzy whitespace matching. Offsets are mapped back to the original snapshot.
 */
export function applyExactTextPatches(source: string, changes: TextPatch[]): PatchResult {
  if (!Array.isArray(changes) || changes.length === 0) {
    throw new Error('At least one targeted edit is required.');
  }
  if (changes.length > 20) {
    throw new Error('A single edit request may contain at most 20 targeted changes. Combine nearby changes.');
  }

  const maxAnchorBytes = 1_000_000;
  const normalizedSource = normalizeWithOffsets(source);
  const eol = preferredEol(source);
  const resolved: ResolvedTextPatch[] = [];
  let usedNormalizedMatching = false;

  for (let index = 0; index < changes.length; index++) {
    const change = changes[index];
    if (!change || typeof change.oldText !== 'string' || typeof change.newText !== 'string' || !change.oldText.length) {
      throw new Error(`Edit ${index + 1} must include non-empty oldText and string newText values.`);
    }
    if (change.oldText === change.newText) {
      throw new Error(`Edit ${index + 1} does not change any text.`);
    }
    if (change.oldText.includes('\0') || change.newText.includes('\0')) {
      throw new Error(`Edit ${index + 1} contains a null byte.`);
    }
    if (Buffer.byteLength(change.oldText, 'utf8') > maxAnchorBytes ||
        Buffer.byteLength(change.newText, 'utf8') > maxAnchorBytes) {
      throw new Error(`Edit ${index + 1} exceeds the 1 MB per-anchor limit.`);
    }

    let start = -1;
    let end = -1;
    const exact = countOccurrences(source, change.oldText);
    if (exact.count === 1) {
      start = exact.first;
      end = start + change.oldText.length;
    } else if (exact.count > 1) {
      throw new Error(
        `Edit ${index + 1} is ambiguous: its oldText occurs ${exact.count} times. Include a few more surrounding lines so the anchor is unique.`
      );
    } else {
      const normalizedAnchor = normalizeLineEndings(change.oldText);
      const normalized = countOccurrences(normalizedSource.text, normalizedAnchor);
      if (normalized.count === 1) {
        start = normalizedSource.offsets[normalized.first];
        end = normalizedSource.offsets[normalized.first + normalizedAnchor.length];
        usedNormalizedMatching = true;
      } else if (normalized.count > 1) {
        throw new Error(
          `Edit ${index + 1} is ambiguous after line-ending normalization. Include more surrounding lines so the anchor is unique.`
        );
      } else {
        throw new Error(
          `Edit ${index + 1} could not be matched in the current VS Code document. The file may have changed since it was read, or indentation/content differs. Read the file again and use an exact, distinctive snippet copied from the latest editor content. Line-ending differences (LF/CRLF) are handled automatically; other whitespace is intentionally not guessed.`
        );
      }
    }

    // Preserve the file's existing line-ending convention in inserted text.
    const newText = normalizeLineEndings(change.newText).replace(/\n/g, eol);
    resolved.push({ oldText: source.slice(start, end), newText, start, end });
  }

  const ordered = [...resolved].sort((a, b) => a.start - b.start);
  for (let index = 1; index < ordered.length; index++) {
    if (ordered[index].start < ordered[index - 1].end) {
      throw new Error('Two proposed edits overlap. Combine overlapping changes into one edit or use separate non-overlapping anchors.');
    }
  }

  let text = source;
  for (const patch of [...ordered].reverse()) {
    text = text.slice(0, patch.start) + patch.newText + text.slice(patch.end);
  }

  return { text, patches: ordered, ...(usedNormalizedMatching ? { matchingMode: 'line-ending-normalized' as const } : {}) };
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
