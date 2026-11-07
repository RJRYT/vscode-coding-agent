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
    name === 'secrets.json' ||
    name === '.secrets' ||
    name === 'credentials.json'
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

const ALLOWED_COMMANDS = new Set([
  'npm', 'npx', 'pnpm', 'yarn', 'node', 'tsc', 'eslint', 'prettier', 'vitest', 'jest', 'git',
  'ls', 'dir', 'pwd', 'whoami', 'which', 'where', 'find', 'tree', 'grep', 'rg', 'head', 'tail', 'wc', 'sort', 'uniq', 'cat', 'type', 'more', 'less', 'python', 'python3', 'get-childitem', 'get-location', 'select-string', 'test-path', 'get-item', 'get-content',
]);

const BLOCKED_COMMAND_PATTERNS = [
  /(^|\s)(rm|rmdir|del|erase|format|shutdown|reboot|mkfs)(\s|$)/i,
  /(^|\s)(npm|pnpm|yarn)\s+(install|i|add|remove|uninstall|publish|ci)(\s|$)/i,
  /(^|\s)git\s+(reset|clean|restore|rm|push|pull|fetch|merge|rebase|commit|stash)(\s|$)/i,
  /(^|\s)(curl|wget|Invoke-WebRequest|iwr)\s+.*\|/i,
  /(^|\s)(printenv|env)(\s|$)/i,
  /(^|\s)(cat|type|more|less|Get-Content)\s+[^\n]*(\.env|id_rsa|id_ed25519|\.pem|\.key)/i,
  /\b(sed\s+-i|perl\s+-i|python\s+-c|node\s+-e|bash\s+-c|powershell\s+.*-command)\b/i,
];

const SAFE_SHELL_META = /[;&|`$<>\r\n]/;

export class CommandSecurityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CommandSecurityError';
  }
}

/**
 * Validate a command before showing it to the user for approval.
 * The approval dialog is the authorization boundary; validation blocks shell
 * chaining, destructive primitives, secret dumping and opaque inline scripts,
 * while allowing ordinary project inspection and build/test commands.
 */
export function validateCommand(command: string): void {
  if (typeof command !== 'string' || !command.trim()) {
    throw new CommandSecurityError('Command is empty.');
  }
  if (command.length > 1200) throw new CommandSecurityError('Command is too long.');
  const trimmed = command.trim();
  if (SAFE_SHELL_META.test(trimmed)) {
    throw new CommandSecurityError('Shell chaining, pipes, redirection and command substitution are not allowed. Submit one command at a time.');
  }
  for (const pattern of BLOCKED_COMMAND_PATTERNS) {
    if (pattern.test(trimmed)) {
      throw new CommandSecurityError('This command is blocked because it can modify system state, expose secrets, or execute opaque inline code.');
    }
  }
  const tokens = trimmed.split(/\s+/);
  const executable = tokens[0].replace(/\\/g, '/').split('/').pop()!.toLowerCase().replace(/\.(exe|cmd|bat)$/, '');
  if (!ALLOWED_COMMANDS.has(executable)) {
    throw new CommandSecurityError(`Command '${executable}' is not allowed. Use an approved development or inspection command.`);
  }
  if (executable === 'git') {
    const subcommand = (tokens[1] || '').toLowerCase();
    if (!['status', 'diff', 'log', 'branch', 'show', 'blame', 'ls-files', 'rev-parse'].includes(subcommand)) {
      throw new CommandSecurityError(`Git operation '${subcommand || '(missing)'}' is not allowed.`);
    }
  }
  if (['npm', 'pnpm', 'yarn'].includes(executable)) {
    const action = (tokens[1] || '').toLowerCase();
    if (!['run', 'test', 'start', 'exec', 'view', 'ls', 'list', 'outdated', 'audit', 'version', '--version'].includes(action)) {
      throw new CommandSecurityError(`Package-manager operation '${action || '(missing)'}' is not allowed.`);
    }
  }
  if (executable === 'npx') {
    const tool = (tokens[1] || '').toLowerCase();
    if (!['tsc', 'eslint', 'prettier', 'vitest', 'jest', 'vite', 'next', 'tsx', 'ts-node', 'tsup', 'playwright', 'webpack', 'rollup', 'tailwindcss', 'nodemon'].includes(tool)) {
      throw new CommandSecurityError(`npx tool '${tool || '(missing)'}' is not in the development-tool allowlist.`);
    }
  }
  // Reject option-like command injection and explicit sensitive path arguments.
  const normalizedTokens = tokens.map((token) => token.replace(/^['\"]|['\"]$/g, ''));
  if (normalizedTokens.some((token) => /(^|[\/])(?:\.env(?:\.|$)|\.npmrc$|\.netrc$|\.ssh(?:[\/]|$)|\.aws(?:[\/]|$)|\.gnupg(?:[\/]|$)|id_rsa|id_ed25519|credentials(?:\.json)?$|secrets\.json$|\.secrets$|\.pem$|\.key$|\.p12$|\.pfx$)/i.test(token))) {
    throw new CommandSecurityError('Access to secret or private-key paths through terminal commands is blocked.');
  }
}

export function buildSafeCommand(command: string): string {
  validateCommand(command);
  // Preserve quoting for paths and arguments. Validation rejects shell
  // operators and line breaks before this string reaches exec.
  return command.trim();
}
