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

  it('requires a file-edit mode and normalizes empty edit arrays', () => {
    expect(() => validateToolArguments('propose_file_edit', { path: 'a.ts', summary: 'edit' })).toThrow(/No file operation supplied/);
    expect(validateToolArguments('propose_file_edit', { path: 'a.ts', summary: 'edit', edits: [], createContent: 'x' }))
      .toMatchObject({ args: { createContent: 'x' } });
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
    expect(validateToolArguments('run_terminal_command', { command: 'npm test' }).name).toBe('run_terminal_command');
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


describe('expanded workspace and Git tool contracts', () => {
  it('normalizes a top-level single-file edit and description alias', () => {
    expect(validateToolArguments('propose_file_edit', {
      path: 'src/a.ts', description: 'Update file', oldText: 'before', newText: 'after',
    })).toMatchObject({ args: { path: 'src/a.ts', summary: 'Update file', edits: [{ oldText: 'before', newText: 'after' }] } });
  });

  it('accepts filePath aliases and a single edit with an empty deletion replacement', () => {
    expect(validateToolArguments('propose_file_edit', {
      file_path: 'src/a.ts', reason: 'Remove obsolete text', oldText: 'obsolete', newText: '',
    })).toMatchObject({ args: { path: 'src/a.ts', edits: [{ oldText: 'obsolete', newText: '' }] } });
  });

  it('normalizes object-shaped edits and content aliases', () => {
    expect(validateToolArguments('propose_file_edit', {
      path: 'src/a.ts', edits: { oldText: 'before', newText: 'after' }, limit: 50, offset: 10,
    })).toMatchObject({ args: { edits: [{ oldText: 'before', newText: 'after' }] } });
    expect(validateToolArguments('propose_file_edit', {
      path: 'src/new.ts', content: 'export {};', description: 'Create module',
    })).toMatchObject({ args: { createContent: 'export {};' } });
    expect(validateToolArguments('propose_file_edit', {
      path: 'src/newer.ts', edits: [], content: 'export const created = true;',
    })).toMatchObject({ args: { createContent: 'export const created = true;' } });
  });

  it('preserves both operation candidates so the workspace can choose by actual path existence', () => {
    expect(validateToolArguments('propose_file_edit', {
      path: 'src/a.ts', edits: [{ oldText: 'a', newText: 'b' }], createContent: 'new file',
    })).toMatchObject({ args: { edits: [{ oldText: 'a', newText: 'b' }], createContent: 'new file' } });
  });

  it('accepts folder lifecycle operations and path aliases', () => {
    expect(validateToolArguments('create_folder', { filePath: 'src/new', description: 'Create module' }))
      .toMatchObject({ name: 'create_folder', args: { path: 'src/new', summary: 'Create module' } });
    expect(validateToolArguments('delete_file', { path: 'src/old.ts' }).name).toBe('delete_file');
    expect(validateToolArguments('delete_folder', { path: 'src/old', offset: 0, limit: 5, description: 'clean old folder' }).name).toBe('delete_folder');
  });

  it('validates Git actions and arguments', () => {
    expect(validateToolArguments('git_manager', { action: 'stage', paths: ['src/a.ts'] }))
      .toMatchObject({ name: 'git_manager', args: { action: 'stage', paths: ['src/a.ts'] } });
    expect(validateToolArguments('git_manager', { action: 'branch_create', branch: 'feature/demo' }).name).toBe('git_manager');
    expect(() => validateToolArguments('git_manager', { action: 'delete_everything' })).toThrow(/Unsupported git action/);
  });

  it('accepts a path argument on active editor context and common pagination extras', () => {
    expect(validateToolArguments('get_active_editor_context', { path: 'src/a.ts', offset: 0, limit: 50, oldText: 'generic noise', description: 'context' }))
      .toMatchObject({ args: { path: 'src/a.ts' } });
    expect(validateToolArguments('run_terminal_command', { command: 'npm test', reason: 'tests', path: 'src' }).name)
      .toBe('run_terminal_command');
  });
});

it('normalizes JSON-stringified, double-encoded, and fenced edit collections', () => {
  const edit = { oldText: 'before', newText: 'after' };
  for (const edits of [
    JSON.stringify([edit]),
    JSON.stringify(JSON.stringify([edit])),
    `\`\`\`json\n${JSON.stringify([edit])}\n\`\`\``,
    edit,
  ]) {
    expect(validateToolArguments('propose_file_edit', { path: 'src/a.ts', edits }))
      .toMatchObject({ args: { edits: [{ oldText: 'before', newText: 'after' }] } });
  }
});

it('falls back to top-level edit anchors when a gateway sends an unusable edits field', () => {
  expect(validateToolArguments('propose_file_edit', {
    path: 'src/a.ts', edits: '[malformed gateway payload', oldText: 'before', newText: 'after',
  })).toMatchObject({ args: { edits: [{ oldText: 'before', newText: 'after' }] } });
});

it('reports malformed edits with a useful payload preview when no fallback exists', () => {
  expect(() => validateToolArguments('propose_file_edit', {
    path: 'src/a.ts', edits: '[malformed gateway payload',
  })).toThrow(/Invalid edits payload.*malformed gateway payload/);
});
