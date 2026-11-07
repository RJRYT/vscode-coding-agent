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

export class CommandSecurityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CommandSecurityError';
  }
}

/**
 * Terminal commands are executed only after an explicit approval card in a
 * trusted VS Code workspace. Keep validation permissive so normal shell
 * composition (pipes, chaining, redirects, subshells and multiline scripts)
 * works. The approval UI is the authorization boundary.
 */
export function validateCommand(command: string): void {
  if (typeof command !== 'string' || !command.trim()) {
    throw new CommandSecurityError('Command is empty.');
  }
  if (command.length > 20_000) {
    throw new CommandSecurityError('Command exceeds the 20,000-character limit.');
  }
  if (command.includes('\0')) {
    throw new CommandSecurityError('Command contains a null byte.');
  }
}

export function buildSafeCommand(command: string): string {
  validateCommand(command);
  // The full shell expression is shown in the approval card before execution.
  return command.trim();
}
