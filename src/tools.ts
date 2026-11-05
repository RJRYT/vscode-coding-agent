import * as path from 'node:path';
import * as vscode from 'vscode';
import { isSensitivePath, safeUri, assertPathInsideWorkspace, validateCommand } from './security';
import {
  EXCLUDES,
  MAX_FILE_READ_BYTES,
  MAX_FILE_EDIT_BYTES,
  MAX_FILE_REPLACE_BYTES,
  MAX_SEARCH_FILE_BYTES,
  MAX_SEARCH_TOTAL_BYTES,
  MAX_SEARCH_FILES,
  MAX_SEARCH_RESULT_LIMIT,
  COMMAND_TIMEOUT_MS,
  COMMAND_MAX_BUFFER,
} from './config';
import * as child_process from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(child_process.exec);

export interface ToolResult {
  content: string;
  isError?: boolean;
}

export type AskApproval = (payload: {
  id: string;
  kind: 'file' | 'command';
  title: string;
  summary: string;
  path?: string;
  oldPreview?: string;
  newPreview?: string;
  command?: string;
}) => Promise<boolean>;

export class ToolRegistry {
  private readonly askApproval: AskApproval;

  constructor(
    private readonly context: vscode.ExtensionContext,
    askApproval: AskApproval
  ) {
    this.askApproval = askApproval;
  }

  toolDefinitions(): any[] {
    return [
      {
        type: 'function',
        function: {
          name: 'list_workspace_files',
          description:
            'List relevant files in the opened workspace. Use a glob such as **/*.tsx or **/*config*.',
          parameters: {
            type: 'object',
            properties: {
              glob: { type: 'string', description: 'Optional glob pattern; defaults to **/*.' },
              limit: { type: 'integer', description: 'Maximum number of paths (max 150).' },
            },
            required: [],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'read_file',
          description:
            'Read a UTF-8 text file from the workspace. Paths must be relative to the workspace root.',
          parameters: {
            type: 'object',
            properties: { path: { type: 'string' } },
            required: ['path'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'get_active_editor_context',
          description:
            'Get the active editor file and selected text (or nearby file contents when there is no selection). Useful when the user refers to the currently open file or selected code.',
          parameters: { type: 'object', properties: {}, required: [] },
        },
      },
      {
        type: 'function',
        function: {
          name: 'search_workspace',
          description:
            'Search text in workspace files. Returns matching file paths, line numbers, and short matching lines.',
          parameters: {
            type: 'object',
            properties: {
              query: { type: 'string' },
              glob: { type: 'string', description: 'Optional file glob, for example **/*.{ts,x}.' },
              limit: { type: 'integer' },
            },
            required: ['query'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'propose_file_edit',
          description:
            'Propose creating or replacing a workspace text file. The user must approve the preview before the change is written. Always read an existing file first.',
          parameters: {
            type: 'object',
            properties: {
              path: { type: 'string' },
              content: { type: 'string' },
              summary: { type: 'string' },
            },
            required: ['path', 'content', 'summary'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'run_terminal_command',
          description:
            'Propose a shell command to run in the workspace root. The user must approve it. Use for tests, builds, lint, or type checks only; do not use terminal commands to install packages or edit source files.',
          parameters: {
            type: 'object',
            properties: { command: { type: 'string' }, reason: { type: 'string' } },
            required: ['command', 'reason'],
          },
        },
      },
    ];
  }

  async listFiles(glob?: string, rawLimit?: number): Promise<ToolResult> {
    const pattern = typeof glob === 'string' && glob.trim() ? glob : '**/*';
    const limit = Math.min(Math.max(Number(rawLimit) || 100, 1), 150);
    const files = await vscode.workspace.findFiles(pattern, EXCLUDES, limit);
    return {
      content: files.length
        ? files.map((uri: vscode.Uri) => vscode.workspace.asRelativePath(uri, false)).join('\n')
        : 'No files matched.',
    };
  }

  async readFile(relativePath: string): Promise<ToolResult> {
    if (isSensitivePath(relativePath)) {
      throw new Error('Reading environment files, private keys, and secret files is blocked.');
    }
    const root = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!root) throw new Error('No workspace folder is open.');
    const uri = safeUri(relativePath, root);
    await assertPathInsideWorkspace(uri, root);
    const bytes = await vscode.workspace.fs.readFile(uri);
    if (bytes.byteLength > MAX_FILE_READ_BYTES) {
      throw new Error(
        'File is larger than 120 KB. Search for a smaller relevant section or inspect it in the editor.'
      );
    }
    if (bytes.includes(0)) {
      throw new Error(
        'This appears to be a binary file. Binary file reading is not supported yet.'
      );
    }
    const text = Buffer.from(bytes).toString('utf8');
    return { content: `--- ${relativePath} ---\n${text}` };
  }

  async getActiveEditorContext(): Promise<ToolResult> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return { content: 'No active text editor.' };
    if (!vscode.workspace.getWorkspaceFolder(editor.document.uri)) {
      return { content: 'The active editor is outside the opened workspace.' };
    }
    const relativePath = vscode.workspace.asRelativePath(editor.document.uri, false);
    if (isSensitivePath(relativePath)) {
      return {
        content: 'The active file appears to contain secrets and is blocked from agent context.',
      };
    }
    const selection = editor.selection;
    if (!selection.isEmpty) {
      const selected = editor.document.getText(selection).slice(0, 30_000);
      return {
        content: `Active file: ${relativePath}\nSelected lines: ${selection.start.line + 1}-${selection.end.line + 1}\n\n${selected}`,
      };
    }
    const content = editor.document.getText();
    return {
      content: `Active file: ${relativePath}\n\n${content.slice(0, 60_000)}${content.length > 60_000 ? '\n[File context truncated at 60 KB]' : ''}`,
    };
  }

  async searchWorkspace(query: string, glob?: string, rawLimit?: number): Promise<ToolResult> {
    const needle = query?.trim();
    if (!needle) throw new Error('Search query is empty.');

    const limit = Math.min(Math.max(Number(rawLimit) || 30, 1), MAX_SEARCH_RESULT_LIMIT);
    const include = glob?.trim() ? glob : '**/*';
    const files = await vscode.workspace.findFiles(include, EXCLUDES, MAX_SEARCH_FILES);
    const results: string[] = [];
    const normalizedNeedle = needle.toLocaleLowerCase();

    let scannedBytes = 0;
    let scannedFiles = 0;
    let skippedLargeFiles = 0;

    for (const uri of files) {
      if (results.length >= limit || scannedBytes >= MAX_SEARCH_TOTAL_BYTES) break;

      const relativePath = vscode.workspace.asRelativePath(uri, false);
      if (isSensitivePath(relativePath)) continue;

      try {
        const stat = await vscode.workspace.fs.stat(uri);
        if (
          stat.size > MAX_SEARCH_FILE_BYTES ||
          scannedBytes + stat.size > MAX_SEARCH_TOTAL_BYTES
        ) {
          skippedLargeFiles++;
          continue;
        }

        const bytes = await vscode.workspace.fs.readFile(uri);
        scannedBytes += bytes.byteLength;
        scannedFiles++;
        if (bytes.includes(0)) continue;

        const contents = Buffer.from(bytes).toString('utf8');
        const lines = contents.split(/\r?\n/);
        for (let index = 0; index < lines.length && results.length < limit; index++) {
          const line = lines[index];
          if (line.toLocaleLowerCase().includes(normalizedNeedle)) {
            results.push(`${relativePath}:${index + 1}: ${line.trim().slice(0, 260)}`);
          }
        }
      } catch {
        // Ignore unreadable, deleted, or otherwise inaccessible files and continue the search.
      }
    }

    if (!results.length) {
      const note =
        files.length >= MAX_SEARCH_FILES || scannedBytes >= MAX_SEARCH_TOTAL_BYTES
          ? ` Search was bounded to ${scannedFiles} readable files / ${Math.round(scannedBytes / (1024 * 1024))} MB.`
          : '';
      return { content: `No matches found.${note}` };
    }

    const notes: string[] = [];
    if (results.length >= limit) notes.push(`Result limit: ${limit}.`);
    if (files.length >= MAX_SEARCH_FILES) notes.push('File scan capped at 2,500 files.');
    if (scannedBytes >= MAX_SEARCH_TOTAL_BYTES) notes.push('Read budget capped at 20 MB.');
    if (skippedLargeFiles) notes.push(`${skippedLargeFiles} large files skipped.`);
    return {
      content: notes.length ? `${results.join('\n')}\n\n[${notes.join(' ')}]` : results.join('\n'),
    };
  }

  async proposeFileEdit(
    relativePath: string,
    content: string,
    summary: string
  ): Promise<ToolResult> {
    if (typeof content !== 'string') throw new Error('File content must be a string.');
    if (isSensitivePath(relativePath)) {
      throw new Error('Editing environment files, private keys, and secret files is blocked.');
    }
    const root = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!root) throw new Error('No workspace folder is open.');
    const uri = safeUri(relativePath, root);
    await assertPathInsideWorkspace(uri, root);
    if (content.length > MAX_FILE_EDIT_BYTES) {
      throw new Error(
        'Proposed file content is larger than 250 KB. Split the change into smaller files.'
      );
    }
    let oldContent = '';
    let exists = false;
    try {
      const current = await vscode.workspace.fs.readFile(uri);
      if (current.byteLength > MAX_FILE_REPLACE_BYTES) {
        throw new Error('Refusing to replace a file larger than 200 KB.');
      }
      if (current.includes(0)) {
        throw new Error('Refusing to replace a binary file.');
      }
      oldContent = Buffer.from(current).toString('utf8');
      exists = true;
    } catch (error: any) {
      if (
        error?.code !== 'FileNotFound' &&
        error?.name !== 'FileNotFound' &&
        !String(error?.message || '').includes('FileNotFound')
      ) {
        throw error;
      }
    }
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const approved = await this.askApproval({
      id,
      kind: 'file',
      title: exists ? `Edit ${relativePath}` : `Create ${relativePath}`,
      summary: summary || 'File change proposed by Nemotron',
      path: relativePath,
      oldPreview: oldContent,
      newPreview: content,
    });
    if (!approved) {
      return {
        content: `User rejected the proposed change to ${relativePath}. Do not retry the same change; explain or propose a different approach.`,
      };
    }
    await assertPathInsideWorkspace(uri, root);
    await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(uri.fsPath)));
    await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'));
    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(document, { preview: false, preserveFocus: true });
    return { content: `Successfully ${exists ? 'updated' : 'created'} ${relativePath}.` };
  }

  async runCommand(command: string, reason: string): Promise<ToolResult> {
    if (typeof command !== 'string' || !command.trim()) throw new Error('Command is empty.');
    if (command.length > 1200) throw new Error('Command is too long.');
    validateCommand(command);

    const root = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!root) throw new Error('No workspace folder is open.');
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const approved = await this.askApproval({
      id,
      kind: 'command',
      title: 'Run terminal command',
      summary: reason || 'Command proposed by Nemotron',
      command,
    });
    if (!approved) {
      return {
        content:
          'User rejected the terminal command. Do not retry it; continue without running it or explain the limitation.',
      };
    }
    const cwd = root.fsPath;
    const shell = process.platform === 'win32' ? undefined : '/bin/bash';
    try {
      const result = await execAsync(command, {
        cwd,
        timeout: COMMAND_TIMEOUT_MS,
        maxBuffer: COMMAND_MAX_BUFFER,
        windowsHide: true,
        shell,
      });
      const output =
        `${result.stdout || ''}${result.stderr ? `\n[stderr]\n${errorStderr(result.stderr)}` : ''}`.trim();
      return {
        content: `Command completed successfully.\n${output.slice(0, 9000) || '(no output)'}`,
      };
    } catch (error: any) {
      const output =
        `${error?.stdout || ''}${error?.stderr ? `\n[stderr]\n${errorStderr(error.stderr)}` : ''}`.trim();
      return {
        content: `Command failed (exit ${error?.code ?? 'unknown'}).\n${output.slice(0, 9000) || error?.message || 'No output.'}`,
      };
    }
  }
}

function errorStderr(stderr: string | Buffer | undefined): string {
  if (!stderr) return '';
  return Buffer.isBuffer(stderr) ? stderr.toString('utf8') : String(stderr);
}
