import * as path from 'node:path';
import { realpath } from 'node:fs/promises';
import * as vscode from 'vscode';

export class PathSecurityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PathSecurityError';
  }
}

export function isSensitivePath(relativePath: string): boolean {
  const normalized = relativePath.replace(/\\/g, '/').toLowerCase();
  const parts = normalized.split('/');
  const name = parts[parts.length - 1] || '';
  return (
    parts.some((part) => ['.ssh', '.aws', '.gnupg'].includes(part)) ||
    name === '.env' ||
    name.startsWith('.env.') ||
    name === '.npmrc' ||
    name === '.netrc' ||
    name === 'credentials' ||
    name === 'id_rsa' ||
    name === 'id_ed25519' ||
    name.endsWith('.pem') ||
    name.endsWith('.key') ||
    name.endsWith('.p12') ||
    name.endsWith('.pfx') ||
    name.endsWith('.p8') ||
    name.includes('secret')
  );
}

export function safeUri(relativePath: string, workspaceRoot: vscode.Uri): vscode.Uri {
  if (typeof relativePath !== 'string' || !relativePath.trim()) {
    throw new PathSecurityError('A relative file path is required.');
  }
  if (
    path.isAbsolute(relativePath) ||
    relativePath.startsWith('\\\\') ||
    /^[a-zA-Z]:/.test(relativePath)
  ) {
    throw new PathSecurityError('Absolute paths are not allowed.');
  }
  const portable = relativePath.replace(/\\/g, '/');
  const normalized = path.posix.normalize(portable).replace(/^\.\//, '');
  if (
    !normalized ||
    normalized === '.' ||
    path.posix.isAbsolute(normalized) ||
    normalized === '..' ||
    normalized.startsWith('../') ||
    normalized.split('/').includes('..')
  ) {
    throw new PathSecurityError('Path traversal is not allowed.');
  }
  return vscode.Uri.joinPath(workspaceRoot, normalized);
}

export async function assertPathInsideWorkspace(
  uri: vscode.Uri,
  workspaceRoot: vscode.Uri
): Promise<void> {
  const root = await realpath(workspaceRoot.fsPath);
  let cursor = uri.fsPath;
  const missing: string[] = [];
  let resolved = '';
  let done = false;
  while (!done) {
    try {
      const existing = await realpath(cursor);
      resolved = path.join(existing, ...missing);
      done = true;
    } catch {
      const parent = path.dirname(cursor);
      if (parent === cursor) throw new PathSecurityError('Unable to verify this path.');
      missing.unshift(path.basename(cursor));
      cursor = parent;
    }
  }
  const relative = path.relative(root, resolved);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new PathSecurityError('The requested path resolves outside the opened workspace.');
  }
}

const ALLOWED_COMMANDS = [
  'npm',
  'npx',
  'node',
  'tsc',
  'eslint',
  'prettier',
  'vitest',
  'jest',
  'git',
];

const ALLOWED_ARGS: Record<string, string[]> = {
  npm: ['run', 'exec', 'view', 'ls', 'list', 'outdated', 'audit'],
  npx: ['tsc', 'eslint', 'prettier', 'vitest', 'jest'],
  node: ['--version', '--check'],
  tsc: ['--noEmit', '--init', '--version', '--help'],
  eslint: ['--version', '--init', '--help'],
  prettier: ['--version', '--help'],
  vitest: ['run', '--version', '--help'],
  jest: ['--version', '--help'],
  git: ['status', 'diff', 'log', 'branch', 'show', 'blame', 'ls-files'],
};

const SAFE_ARG_CHARS = /^[A-Za-z0-9_,.\/@:-]+$/;

function shellEscape(arg: string): string {
  if (SAFE_ARG_CHARS.test(arg)) return arg;
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

export class CommandSecurityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CommandSecurityError';
  }
}

export function validateCommand(command: string): void {
  if (typeof command !== 'string' || !command.trim()) {
    throw new CommandSecurityError('Command is empty.');
  }
  if (command.length > 1200) {
    throw new CommandSecurityError('Command is too long.');
  }

  const trimmed = command.trim();
  if (/[;&|`$(){}<>]/.test(trimmed)) {
    throw new CommandSecurityError(
      'Command contains shell metacharacters or redirection operators.'
    );
  }
  if (
    /\b(rm|mv|cp|del|erase|rmdir|mkdir|touch|tee|chmod|chown|shutdown|reboot|format|git\s+(reset|checkout|clean|restore|rm|apply|push|pull|fetch|merge|rebase|commit|stash)\b|npm\s+(install|ci|uninstall|publish|add|remove)\b|pnpm\s+(add|install|remove|i)\b|yarn\s+(add|install|remove)\b|patch|printenv|env)\b/i.test(
      trimmed
    )
  ) {
    throw new CommandSecurityError(
      'This command appears to modify files, dependencies, or system state and is blocked.'
    );
  }
  if (
    /\b(sed\s+-i|perl\s+-i|python\s+-c|node\s+-e|bash\s+-c|powershell\s+.*-command)\b/i.test(
      trimmed
    )
  ) {
    throw new CommandSecurityError('Inline script execution is blocked.');
  }
  if (
    /\b(cat|type|more|less|Get-Content)\s+/i.test(trimmed) &&
    /(\.env|id_rsa|id_ed25519|\.pem|\.key|secret)/i.test(trimmed)
  ) {
    throw new CommandSecurityError('Reading secret files via command is blocked.');
  }

  const tokens = trimmed.split(/\s+/);
  const cmd = tokens[0].toLowerCase();
  if (!ALLOWED_COMMANDS.includes(cmd)) {
    throw new CommandSecurityError(
      `Command '${cmd}' is not in the allowlist. Use npm/npx/tsc/eslint/prettier/vitest/jest/git only.`
    );
  }

  const allowed = ALLOWED_ARGS[cmd] ?? [];
  for (let i = 1; i < tokens.length; i++) {
    const arg = tokens[i];
    if (!allowed.some((prefix) => arg.startsWith(prefix))) {
      throw new CommandSecurityError(`Argument '${arg}' is not allowed for command '${cmd}'.`);
    }
  }
}

export function buildSafeCommand(command: string): string {
  validateCommand(command);
  const tokens = command.trim().split(/\s+/);
  return tokens.map(shellEscape).join(' ');
}
