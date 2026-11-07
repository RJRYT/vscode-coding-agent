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

  it('validates patch anchors and terminal arguments', () => {
    expect(() => validateToolArguments('propose_file_edit', { path: 'a.ts', summary: 'edit', edits: [{ oldText: '', newText: 'x' }] })).toThrow(/oldText/);
    expect(() => validateToolArguments('run_terminal_command', { command: 'npm test' })).toThrow(/reason/);
    expect(validateToolArguments('run_terminal_command', { command: 'npm test', reason: 'Run tests' }).name).toBe('run_terminal_command');
  });

  it('accepts large but bounded patch anchors consistently with the patch engine', () => {
    const oldText = 'x'.repeat(300_000);
    const result = validateToolArguments('propose_file_edit', {
      path: 'large.ts',
      summary: 'Update a focused large section',
      edits: [{ oldText, newText: 'updated section' }],
    });
    expect(result.name).toBe('propose_file_edit');
  });

});
