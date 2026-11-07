import { describe, expect, it, vi } from 'vitest';
vi.mock('vscode', () => ({}));
import { buildSafeCommand, validateCommand } from '../src/security';

describe('command security', () => {
  it.each([
    'npm run compile',
    'npm test',
    'npx vite build',
    'git status --short',
    'git diff --check',
    'node --check src/index.js',
    'python --version',
    'ls -la',
    'rg "TODO" src',
    'npm test && npm run lint',
    'npm run build 2>&1 | tee build.log',
    'git status --short; git diff --check',
    'node -e "console.log(1 + 1)"',
    'cat package.json > /tmp/package-copy.json',
  ])('allows approved development command: %s', (command) => {
    expect(() => validateCommand(command)).not.toThrow();
    expect(buildSafeCommand(command)).toBe(command);
  });

  it('rejects empty commands and null bytes', () => {
    expect(() => validateCommand('   ')).toThrow(/empty/);
    expect(() => validateCommand('echo\0bad')).toThrow(/null byte/);
  });
});
