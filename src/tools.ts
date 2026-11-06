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
import { applyExactTextPatches, createPatchPreview, TextPatch } from './patchEngine';

const execAsync = promisify(child_process.exec);

export interface ToolResult {
  content: string;
  isError?: boolean;
  status?: 'success' | 'failed' | 'rejected' | 'timeout' | 'cancelled' | 'invalid' | 'unsupported' | 'stale';
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
  patchCount?: number;
}) => Promise<boolean>;

export interface EditProgress {
  id: string;
  path: string;
  stage: 'preparing' | 'staging' | 'applying' | 'saving' | 'verifying' | 'completed' | 'failed';
  current: number;
  total: number;
  message: string;
}

export class ToolRegistry {
  private readonly askApproval: AskApproval;

  constructor(
    askApproval: AskApproval,
    private readonly onEditProgress?: (progress: EditProgress) => void
  ) {
    this.askApproval = askApproval;
  }

  toolDefinitions(): Array<{ type: string; function: { name: string; description: string; parameters: object } }> {
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
            'Propose a SAFE, targeted edit to an existing workspace file using exact unique text anchors. Never send the whole file. Read the latest file first. For each edit, oldText must match exactly once and newText contains only the replacement for that section. To create a new file only, use createContent.',
          parameters: {
            type: 'object',
            properties: {
              path: { type: 'string', description: 'Workspace-relative path.' },
              summary: { type: 'string', description: 'Short explanation of the change.' },
              edits: {
                type: 'array',
                minItems: 1,
                maxItems: 20,
                description: 'Targeted exact replacements for an existing file. Do not replace the whole file.',
                items: {
                  type: 'object',
                  properties: {
                    oldText: { type: 'string', description: 'Exact existing snippet including enough surrounding context to occur exactly once.' },
                    newText: { type: 'string', description: 'Replacement snippet. Preserve all unchanged code inside the anchor.' },
                  },
                  required: ['oldText', 'newText'],
                },
              },
              createContent: { type: 'string', description: 'Complete content for a brand-new file only. Never use this for an existing file.' },
            },
            required: ['path', 'summary'],
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

  getActiveEditorContext(): ToolResult {
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
    edits: TextPatch[] | undefined,
    createContent: string | undefined,
    summary: string,
    signal?: AbortSignal
  ): Promise<ToolResult> {
    if (isSensitivePath(relativePath)) {
      throw new Error('Editing environment files, private keys, and secret files is blocked.');
    }
    const root = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!root) throw new Error('No workspace folder is open.');
    if (!vscode.workspace.isTrusted) {
      throw new Error('File editing is disabled in an untrusted workspace. Trust this workspace first.');
    }

    const uri = safeUri(relativePath, root);
    await assertPathInsideWorkspace(uri, root);
    let exists = false;
    try {
      const stat = await vscode.workspace.fs.stat(uri);
      if (stat.type & vscode.FileType.Directory) throw new Error('The requested path is a directory, not a file.');
      exists = true;
    } catch (error: unknown) {
      if (!isFileNotFound(error)) throw error;
    }

    if (!exists) {
      if (typeof createContent !== 'string') {
        throw new Error(`File ${relativePath} does not exist. Use createContent only to create a new file.`);
      }
      if (Array.isArray(edits) && edits.length) {
        throw new Error('A new file must use createContent; targeted edits are only for existing files.');
      }
      if (createContent.length > MAX_FILE_EDIT_BYTES || createContent.includes('\0')) {
        throw new Error('New file content is too large or contains binary data.');
      }
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const approved = await this.requestApproval({
        id,
        kind: 'file',
        title: `Create ${relativePath}`,
        summary: summary || 'New file proposed by Nemotron',
        path: relativePath,
        oldPreview: '(new file)',
        newPreview: createContent.slice(0, 12_000),
        patchCount: 1,
      }, signal);
      if (!approved) {
        return { content: `User rejected the creation of ${relativePath}. Do not retry the same change.`, status: 'rejected' };
      }
      if (signal?.aborted) throw new Error('Request cancelled before the approved file creation could be applied.');
      try {
        this.reportProgress({ id, path: relativePath, stage: 'preparing', current: 0, total: 1, message: 'Preparing new file…' });
        await new Promise((resolve) => setTimeout(resolve, 45));
        if (signal?.aborted) throw new Error('Request cancelled before the new file could be written.');
        await assertPathInsideWorkspace(uri, root);
        try {
          await vscode.workspace.fs.stat(uri);
          throw new Error(`The file ${relativePath} was created while approval was pending. Nothing was overwritten.`);
        } catch (error: any) {
          if (!isFileNotFound(error)) throw error;
        }
        this.reportProgress({ id, path: relativePath, stage: 'applying', current: 1, total: 1, message: 'Writing approved new file…' });
        await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(uri.fsPath)));
        await vscode.workspace.fs.writeFile(uri, Buffer.from(createContent, 'utf8'));
        this.reportProgress({ id, path: relativePath, stage: 'verifying', current: 1, total: 1, message: 'Verifying saved file…' });
        const saved = new TextDecoder('utf-8').decode(await vscode.workspace.fs.readFile(uri));
        if (saved !== createContent) throw new Error(`Verification failed for ${relativePath}. The file was written but does not match the approved content.`);
        const document = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(document, { preview: false, preserveFocus: true });
        this.reportProgress({ id, path: relativePath, stage: 'completed', current: 1, total: 1, message: 'New file saved and verified.' });
        return { content: `Successfully created and verified ${relativePath}.` };
      } catch (error) {
        this.reportProgress({ id, path: relativePath, stage: 'failed', current: 0, total: 1, message: error instanceof Error ? error.message : String(error) });
        throw error;
      }
    }

    if (typeof createContent === 'string') {
      throw new Error('Full-file replacement is disabled. Existing files must be changed with targeted edits.');
    }
    if (!Array.isArray(edits)) {
      throw new Error('Full-file content replacement is blocked. Use edits: [{ oldText, newText }] with exact unique snippets.');
    }

    const document = await vscode.workspace.openTextDocument(uri);
    if (document.isDirty) {
      throw new Error(` ${relativePath} has unsaved editor changes. Save it first; the agent will not overwrite or implicitly save your unsaved work.`.trim());
    }
    const originalText = document.getText();
    const originalDiskBytes = Buffer.from(await vscode.workspace.fs.readFile(uri));
    const originalVersion = document.version;
    if (Buffer.byteLength(originalText, 'utf8') > MAX_FILE_REPLACE_BYTES) {
      throw new Error('Refusing to edit a file larger than 200 KB.');
    }
    if (originalText.includes('\0')) throw new Error('Refusing to edit a binary file.');

    const patchResult = applyExactTextPatches(originalText, edits);
    if (Buffer.byteLength(patchResult.text, 'utf8') > MAX_FILE_EDIT_BYTES) {
      throw new Error('The resulting file would exceed 250 KB. Split the change into smaller files.');
    }
    const preview = createPatchPreview(patchResult.patches);
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const approved = await this.requestApproval({
      id,
      kind: 'file',
      title: `Apply ${patchResult.patches.length} targeted edit${patchResult.patches.length === 1 ? '' : 's'} to ${relativePath}`,
      summary: summary || 'Targeted patch proposed by Nemotron. Unmatched file content will remain untouched.',
      path: relativePath,
      oldPreview: preview.oldPreview,
      newPreview: preview.newPreview,
      patchCount: patchResult.patches.length,
    }, signal);
    if (!approved) {
      return { content: `User rejected the targeted patch for ${relativePath}. Do not retry the same change.`, status: 'rejected' };
    }
    if (signal?.aborted) throw new Error('Request cancelled before the approved patch could be applied.');

    const progress = (stage: EditProgress['stage'], current: number, message: string) =>
      this.reportProgress({ id, path: relativePath, stage, current, total: patchResult.patches.length, message });

    try {
      progress('preparing', 0, 'Rechecking the file before applying the approved patch…');
      await new Promise((resolve) => setTimeout(resolve, 50));
      if (signal?.aborted) throw new Error('Request cancelled before the approved patch could be applied.');
      await assertPathInsideWorkspace(uri, root);
      if (document.isDirty) {
        throw new Error('The file became dirty while approval was pending. Nothing was applied. Save or discard those changes and retry.');
      }
      if (document.version !== originalVersion || document.getText() !== originalText) {
        throw new Error('The file changed while approval was pending. Nothing was applied. Read the latest file and propose a fresh patch.');
      }
      const currentDiskBytes = Buffer.from(await vscode.workspace.fs.readFile(uri));
      if (!currentDiskBytes.equals(originalDiskBytes)) {
        throw new Error('The file changed on disk while approval was pending. Nothing was applied. Read the latest file and propose a fresh patch.');
      }

      for (let index = 0; index < patchResult.patches.length; index++) {
        progress('staging', index + 1, `Staging targeted change ${index + 1} of ${patchResult.patches.length}…`);
        await new Promise((resolve) => setTimeout(resolve, 55));
      }

      // All replacements are resolved against the same immutable document version.
      // VS Code applies this single WorkspaceEdit as one atomic undoable editor operation.
      progress('applying', patchResult.patches.length, 'Applying the approved patch atomically…');
      const workspaceEdit = new vscode.WorkspaceEdit();
      for (const patch of patchResult.patches) {
        const start = document.positionAt(patch.start);
        const end = document.positionAt(patch.end);
        workspaceEdit.replace(uri, new vscode.Range(start, end), patch.newText);
      }
      const applied = await vscode.workspace.applyEdit(workspaceEdit);
      if (!applied) throw new Error('VS Code could not apply the approved patch. The file was not changed.');

      progress('saving', patchResult.patches.length, 'Saving the updated file…');
      const saved = await document.save();
      if (!saved) {
        throw new Error('The patch is applied in the editor but VS Code could not save it to disk. Review the editor and save manually.');
      }

      progress('verifying', patchResult.patches.length, 'Verifying the saved file against the approved result…');
      const diskText = new TextDecoder('utf-8').decode(await vscode.workspace.fs.readFile(uri));
      if (diskText !== patchResult.text || document.getText() !== patchResult.text) {
        throw new Error('Post-save verification did not match the approved patch. The editor contents were preserved; inspect the file before continuing.');
      }

      await vscode.window.showTextDocument(document, { preview: false, preserveFocus: true });
      progress('completed', patchResult.patches.length, `Saved and verified ${patchResult.patches.length} targeted change${patchResult.patches.length === 1 ? '' : 's'}.`);
      return {
        content: `Successfully applied and verified ${patchResult.patches.length} targeted edit${patchResult.patches.length === 1 ? '' : 's'} in ${relativePath}. All text outside the approved exact-match sections was preserved.`,
      };
    } catch (error) {
      progress('failed', 0, error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  private requestApproval(
    payload: Parameters<AskApproval>[0],
    signal?: AbortSignal
  ): Promise<boolean> {
    if (!signal) return this.askApproval(payload);
    if (signal.aborted) return Promise.reject(new Error('Request cancelled while waiting for approval.'));
    return new Promise<boolean>((resolve, reject) => {
      const onAbort = () => {
        signal.removeEventListener('abort', onAbort);
        reject(new Error('Request cancelled while waiting for approval.'));
      };
      signal.addEventListener('abort', onAbort, { once: true });
      this.askApproval(payload).then(
        (approved) => {
          signal.removeEventListener('abort', onAbort);
          resolve(approved);
        },
        (error) => {
          signal.removeEventListener('abort', onAbort);
          reject(error);
        }
      );
    });
  }

  private reportProgress(progress: EditProgress): void {
    this.onEditProgress?.(progress);
  }

  async runCommand(command: string, reason: string, signal?: AbortSignal): Promise<ToolResult> {
    if (typeof command !== 'string' || !command.trim()) throw new Error('Command is empty.');
    if (command.length > 1200) throw new Error('Command is too long.');
    validateCommand(command);

    const root = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!root) throw new Error('No workspace folder is open.');
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const approved = await this.requestApproval({
      id,
      kind: 'command',
      title: 'Run terminal command',
      summary: reason || 'Command proposed by Nemotron',
      command,
    }, signal);
    if (!approved) {
      return {
        content:
          'User rejected the terminal command. Do not retry it; continue without running it or explain the limitation.',
        status: 'rejected',
      };
    }
    if (signal?.aborted) throw new Error('Request cancelled before the approved terminal command could start.');
    const cwd = root.fsPath;
    const shell = process.platform === 'win32' ? undefined : '/bin/bash';
    try {
      const result = await execAsync(command, {
        cwd,
        timeout: COMMAND_TIMEOUT_MS,
        maxBuffer: COMMAND_MAX_BUFFER,
        windowsHide: true,
        shell,
        signal,
      });
      return {
        content: [
          'Command execution result: SUCCESS',
          `Command: ${command}`,
          `Working directory: ${cwd}`,
          'Exit code: 0',
          `Standard output:\n${String(result.stdout || '(empty)').slice(0, 7000)}`,
          `Standard error:\n${String(result.stderr || '(empty)').slice(0, 2000)}`,
          'Timed out: no',
        ].join('\n'),
        status: 'success',
      };
    } catch (error: any) {
      const timedOut = error?.killed === true || error?.signal === 'SIGTERM' || error?.code === 'ETIMEDOUT';
      return {
        content: [
          'Command execution result: FAILURE',
          `Command: ${command}`,
          `Working directory: ${cwd}`,
          `Exit code: ${typeof error?.code === 'number' ? error.code : 'unknown'}`,
          `Standard output:\n${String(error?.stdout || '(empty)').slice(0, 7000)}`,
          `Standard error:\n${String(error?.stderr || error?.message || '(empty)').slice(0, 2000)}`,
          `Timed out: ${timedOut ? 'yes' : 'no'}`,
        ].join('\n'),
        isError: true,
        status: signal?.aborted ? 'cancelled' : timedOut ? 'timeout' : 'failed',
      };
    }
  }
}

function isFileNotFound(error: unknown): boolean {
  const e = error as { code?: string; name?: string; message?: string } | undefined;
  return e?.code === 'FileNotFound' || e?.name === 'FileNotFound' || String(e?.message || '').includes('FileNotFound');
}
