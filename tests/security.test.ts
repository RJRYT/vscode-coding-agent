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
  ])('allows approved development command: %s', (command) => {
    expect(() => validateCommand(command)).not.toThrow();
    expect(buildSafeCommand(command)).toBe(command);
  });

  it.each([
    'npm install',
    'git reset --hard',
    'rm -rf src',
    'npm run test && rm -rf .',
    'cat .env',
    'node -e "process.exit(1)"',
  ])('blocks dangerous command: %s', (command) => {
    expect(() => validateCommand(command)).toThrow();
  });
});
