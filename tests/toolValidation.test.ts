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
