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

/**
 * Resolve exact, unique text anchors against one immutable source snapshot.
 * No fuzzy matching is used: a missing or ambiguous anchor is rejected.
 */
export function applyExactTextPatches(source: string, changes: TextPatch[]): PatchResult {
  if (!Array.isArray(changes) || changes.length === 0) {
    throw new Error('At least one targeted edit is required.');
  }
  if (changes.length > 20) {
    throw new Error('A single edit request may contain at most 20 targeted changes.');
  }

  const resolved: ResolvedTextPatch[] = [];
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
    if (change.oldText.length > 5_000_000 || change.newText.length > 5_000_000) {
      throw new Error(`Edit ${index + 1} exceeds the 5 MB text limit. Split the change into smaller edits if necessary.`);
    }
    // An exact full-snapshot replacement is safe: it is still anchored to the
    // complete current contents and the caller revalidates the snapshot after approval.

    const start = source.indexOf(change.oldText);
    if (start < 0) {
      throw new Error(
        `Edit ${index + 1} could not be matched exactly. Read the latest file contents and retry with an exact anchor.`
      );
    }
    const second = source.indexOf(change.oldText, start + 1);
    if (second >= 0) {
      throw new Error(
        `Edit ${index + 1} is ambiguous because its oldText occurs more than once. Include more surrounding context so it matches exactly once.`
      );
    }

    resolved.push({ ...change, start, end: start + change.oldText.length });
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
