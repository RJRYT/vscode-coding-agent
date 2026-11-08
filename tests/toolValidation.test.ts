import { describe, expect, it } from 'vitest';
import { parseToolArguments, validateToolArguments } from '../src/toolValidation';

describe('tool argument validation', () => {
  it('parses valid JSON objects', () => {
    expect(parseToolArguments('{"path":"src/index.ts"}')).toEqual({ path: 'src/index.ts' });
  });

  it('rejects malformed JSON instead of silently using empty arguments', () => {
    expect(() => parseToolArguments('{bad')).toThrow(/Malformed tool-call JSON/);
  });

  it('rejects unknown tool names', () => {
    expect(() => validateToolArguments('delete_everything', {})).toThrow(/Unsupported tool name/);
  });

  it('requires exactly one file-edit mode', () => {
    expect(() => validateToolArguments('propose_file_edit', { path: 'a.ts', summary: 'edit' })).toThrow(/exactly one/);
    expect(() => validateToolArguments('propose_file_edit', { path: 'a.ts', summary: 'edit', edits: [], createContent: 'x' })).toThrow(/exactly one/);
  });


  it('accepts large file-edit payloads beyond the former 1 MB restriction', () => {
    const oldText = 'a'.repeat(300_000);
    const newText = 'b'.repeat(1_200_000);
    const result = validateToolArguments('propose_file_edit', {
      path: 'src/large.ts', summary: 'Large focused replacement',
      edits: [{ oldText, newText }],
    });
    expect(result.name).toBe('propose_file_edit');
  });


  it('accepts newText larger than the obsolete 5 million character cap', () => {
    const newText = 'z'.repeat(5_000_001);
    const result = validateToolArguments('propose_file_edit', {
      path: 'src/large.ts', summary: 'Replace a large generated section',
      edits: [{ oldText: 'UNIQUE_OLD_ANCHOR', newText }],
    });
    expect(result.name).toBe('propose_file_edit');
  });

  it('reports missing or non-string newText separately from size violations', () => {
    expect(() => validateToolArguments('propose_file_edit', {
      path: 'src/a.ts', summary: 'Edit', edits: [{ oldText: 'old', newText: null }],
    })).toThrow(/missing replacement text/);
  });


  it('normalizes common model/provider replacement aliases', () => {
    for (const key of ['new_text', 'replacement', 'replacementText', 'replacement_text', 'after', 'new_content']) {
      const result = validateToolArguments('propose_file_edit', {
        path: 'src/a.ts', summary: 'Edit', edits: [{ oldText: 'before', [key]: 'after' }],
      });
      expect(result).toMatchObject({ name: 'propose_file_edit', args: { edits: [{ oldText: 'before', newText: 'after' }] } });
    }
  });

  it('never converts a missing replacement into an accidental deletion', () => {
    expect(() => validateToolArguments('propose_file_edit', {
      path: 'src/a.ts', summary: 'Edit', edits: [{ oldText: 'before' }],
    })).toThrow(/will not guess replacement code/);
  });

  it('accepts an explicitly empty newText for intentional deletion', () => {
    const result = validateToolArguments('propose_file_edit', {
      path: 'src/a.ts', summary: 'Delete code', edits: [{ oldText: 'obsolete', newText: '' }],
    });
    expect(result).toMatchObject({ args: { edits: [{ oldText: 'obsolete', newText: '' }] } });
  });

  it('accepts shell operators and longer approved commands', () => {
    const command = 'npm test && npm run lint 2>&1 | tee verification.log';
    expect(validateToolArguments('run_terminal_command', { command, reason: 'Verify the project' }).name)
      .toBe('run_terminal_command');
  });

  it('validates patch anchors and terminal arguments', () => {
    expect(() => validateToolArguments('propose_file_edit', { path: 'a.ts', summary: 'edit', edits: [{ oldText: '', newText: 'x' }] })).toThrow(/oldText/);
    expect(() => validateToolArguments('run_terminal_command', { command: 'npm test' })).toThrow(/reason/);
    expect(validateToolArguments('run_terminal_command', { command: 'npm test', reason: 'Run tests' }).name).toBe('run_terminal_command');
  });
});

it('unwraps JSON-encoded arguments and recognized gateway envelopes', () => {
  expect(parseToolArguments(JSON.stringify(JSON.stringify({ path: 'src/index.ts' })))).toEqual({ path: 'src/index.ts' });
  expect(parseToolArguments(JSON.stringify({ arguments: JSON.stringify({ path: 'src/index.ts' }) }))).toEqual({ path: 'src/index.ts' });
});

it('normalizes object-wrapped replacement text from compatible providers', () => {
  const result = validateToolArguments('propose_file_edit', {
    path: 'src/a.ts', summary: 'Edit',
    edits: [{ oldText: 'before', replacement: { text: 'after' } }],
  });
  expect(result).toMatchObject({ args: { edits: [{ oldText: 'before', newText: 'after' }] } });
});

it('uses a top-level replacement only when there is exactly one edit', () => {
  const result = validateToolArguments('propose_file_edit', {
    path: 'src/a.ts', summary: 'Edit', edits: [{ oldText: 'before' }], newText: 'after',
  });
  expect(result).toMatchObject({ args: { edits: [{ oldText: 'before', newText: 'after' }] } });
});

it('does not apply a top-level replacement ambiguously to multiple edits', () => {
  expect(() => validateToolArguments('propose_file_edit', {
    path: 'src/a.ts', summary: 'Edit',
    edits: [{ oldText: 'one' }, { oldText: 'two' }], newText: 'replacement',
  })).toThrow(/missing replacement text/);
});

it('accepts offset and limit pagination on workspace tools', () => {
  expect(validateToolArguments('list_workspace_files', { limit: 25, offset: 50 }).args)
    .toMatchObject({ limit: 25, offset: 50 });
  expect(validateToolArguments('read_file', { path: 'src/a.ts', limit: 100, offset: 200 }).args)
    .toMatchObject({ path: 'src/a.ts', limit: 100, offset: 200 });
  expect(validateToolArguments('search_workspace', { query: 'export', limit: 20, offset: 40 }).args)
    .toMatchObject({ query: 'export', limit: 20, offset: 40 });
});


describe('provider argument compatibility', () => {
  it('normalizes a top-level single edit into the canonical edits array', () => {
    const result = validateToolArguments('propose_file_edit', {
      path: 'src/a.ts', description: 'Update the import', oldText: 'import old from \'old\';', newText: 'import fresh from \'fresh\';',
    });
    expect(result).toMatchObject({
      name: 'propose_file_edit',
      args: { summary: 'Update the import', edits: [{ oldText: "import old from 'old';", newText: "import fresh from 'fresh';" }] },
    });
  });

  it('accepts description as a summary alias', () => {
    const result = validateToolArguments('propose_file_edit', {
      path: 'src/a.ts', description: 'Create a new file', createContent: 'export {};',
    });
    expect(result).toMatchObject({ args: { summary: 'Create a new file', createContent: 'export {};' } });
  });

  it('rejects conflicting edit and create payloads clearly', () => {
    expect(() => validateToolArguments('propose_file_edit', {
      path: 'src/a.ts', summary: 'Ambiguous', edits: [{ oldText: 'a', newText: 'b' }], createContent: 'x',
    })).toThrow(/exactly one operation/);
  });
});
