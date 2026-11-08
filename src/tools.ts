import * as path from 'node:path';
import * as vscode from 'vscode';
import { isSensitivePath, safeUri, assertPathInsideWorkspace, validateCommand, buildSafeCommand } from './security';
import {
  EXCLUDES,
  MAX_FILE_READ_BYTES,
  MAX_FILE_EDIT_BYTES,
  MAX_FILE_REPLACE_BYTES,
  MAX_CREATE_CONTENT_CHARS,
  MAX_COMMAND_LENGTH,
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
import type { AgentLogger } from './logger';

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
  diff?: string;
}, signal?: AbortSignal) => Promise<boolean>;

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
    private readonly onEditProgress?: (progress: EditProgress) => void,
    private readonly logger?: AgentLogger
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
              offset: { type: 'integer', description: 'Optional zero-based pagination offset.' },
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
            properties: { path: { type: 'string' }, limit: { type: 'integer', description: 'Optional maximum number of lines to return (1-2000).' }, offset: { type: 'integer', description: 'Optional zero-based starting line offset.' } },
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
              offset: { type: 'integer', description: 'Optional zero-based pagination offset.' },
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
            'Propose an edit to an existing workspace file using exact text anchors. Read the latest file first. Each edit must contain oldText AND replacement text (prefer newText). Copy literal source text from read_file; never send JSON-escaped source quotes. It may be a focused section or the complete current file snapshot for a deliberate full-file rewrite. Large edits are supported up to 50 million characters per field, subject to a 50 million character combined request budget. To create a new file only, use createContent.',
          parameters: {
            type: 'object',
            properties: {
              path: { type: 'string', description: 'Workspace-relative path.' },
              summary: { type: 'string', description: 'Short explanation of the change.' },
              description: { type: 'string', description: 'Compatibility alias for summary.' },
              oldText: { type: 'string', description: 'Compatibility anchor for a single existing-file edit. Prefer edits[0].oldText.' },
              oldtext: { type: 'string' }, old_text: { type: 'string' },
              originalText: { type: 'string' }, original_text: { type: 'string' },
              original: { type: 'string' }, search: { type: 'string' }, find: { type: 'string' },
              old_content: { type: 'string' }, old_code: { type: 'string' }, before: { type: 'string' }, old: { type: 'string' },
              newText: { type: 'string', description: 'For a single edit, compatibility replacement fallback. Prefer edits[0].newText.' },
              newtext: { type: 'string' },
              new_text: { type: 'string' },
              replacement: { type: 'string' },
              replacementText: { type: 'string' },
              replacement_text: { type: 'string' },
              replacement_content: { type: 'string' },
              replacementContent: { type: 'string' },
              updatedText: { type: 'string' },
              updated_text: { type: 'string' },
              newContent: { type: 'string' },
              new_content: { type: 'string' },
              replaceWith: { type: 'string' },
              replace_with: { type: 'string' },
              replace: { type: 'string' },
              afterText: { type: 'string' },
              after_text: { type: 'string' },
              after: { type: 'string' },
              insertText: { type: 'string' },
              insert_text: { type: 'string' },
              insert: { type: 'string' },
              value: { type: 'string' },
              text: { type: 'string' },
              content: { type: 'string' },
              body: { type: 'string' },
              replacementValue: { type: 'string' },
              new_value: { type: 'string' },
              new: { type: 'string' },
              edits: {
                type: 'array',
                minItems: 1,
                maxItems: 20,
                description: 'Exact replacements for an existing file. Use focused anchors where practical; a full-file oldText is allowed only when it exactly matches the current file snapshot.',
                items: {
                  type: 'object',
                  properties: {
                    oldText: { type: 'string', description: 'Exact source text copied from read_file. Do not JSON-escape source quotes.' },
                    oldtext: { type: 'string' }, old_text: { type: 'string' },
                    originalText: { type: 'string' }, original_text: { type: 'string' },
                    original: { type: 'string' }, search: { type: 'string' }, find: { type: 'string' },
                    old_content: { type: 'string' }, old_code: { type: 'string' }, before: { type: 'string' }, old: { type: 'string' },
                    newText: { type: 'string', description: 'Required replacement source. Use an empty string only for intentional deletion.' },
                    newtext: { type: 'string' }, new_text: { type: 'string' },
                    replacement: { type: 'string' }, replacementText: { type: 'string' }, replacement_text: { type: 'string' },
                    replacement_content: { type: 'string' }, replacementContent: { type: 'string' },
                    updatedText: { type: 'string' }, updated_text: { type: 'string' },
                    newContent: { type: 'string' }, new_content: { type: 'string' },
                    replaceWith: { type: 'string' }, replace_with: { type: 'string' }, replace: { type: 'string' },
                    afterText: { type: 'string' }, after_text: { type: 'string' }, after: { type: 'string' },
                    insertText: { type: 'string' }, insert_text: { type: 'string' }, insert: { type: 'string' },
                    value: { type: 'string' }, text: { type: 'string' }, content: { type: 'string' }, body: { type: 'string' },
                    replacementValue: { type: 'string' }, new_value: { type: 'string' }, new: { type: 'string' },
                  },
                  required: ['oldText', 'newText'],
                },
              },
              createContent: { type: 'string', description: 'Complete content for a brand-new file only. Existing files must use edits with exact oldText anchors.' },
            },
            required: ['path'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'run_terminal_command',
          description:
            'Propose a shell command or multiline shell script to run in the workspace root. The user must approve the exact command before execution. Shell pipes, chaining, redirection, subshells and ordinary development commands are supported. Commands run with the current user permissions in a trusted workspace; do not expose secrets or perform destructive actions unless explicitly requested by the user.',
          parameters: {
            type: 'object',
            properties: { command: { type: 'string', maxLength: 20000 }, reason: { type: 'string' } },
            required: ['command', 'reason'],
          },
        },
      },
    ];
  }

  async listFiles(glob?: string, rawLimit?: number, rawOffset?: number): Promise<ToolResult> {
    const pattern = typeof glob === 'string' && glob.trim() ? glob : '**/*';
    const limit = Math.min(Math.max(Number(rawLimit) || 100, 1), 150);
    const offset = Math.max(0, Math.min(Number(rawOffset) || 0, 100_000));
    const files = await vscode.workspace.findFiles(pattern, EXCLUDES, Math.min(10_000, limit + offset + 1));
    const page = files.slice(offset, offset + limit);
    return {
      content: page.length
        ? `${page.map((uri: vscode.Uri) => vscode.workspace.asRelativePath(uri, false)).join('\n')}\n\n[Showing ${offset + 1}-${offset + page.length}${files.length > offset + page.length ? ' of more' : ''}; use offset for the next page.]`
        : 'No files matched at this offset.',
    };
  }

  async readFile(relativePath: string, rawLimit?: number, rawOffset?: number): Promise<ToolResult> {
    if (isSensitivePath(relativePath)) {
      throw new Error('Reading environment files, private keys, and secret files is blocked.');
    }
    const root = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!root) throw new Error('No workspace folder is open.');
    const uri = safeUri(relativePath, root);
    await assertPathInsideWorkspace(uri, root);
    // Prefer the open VS Code document buffer over disk bytes. The editor may
    // contain unsaved changes; patch proposals operate on this same live buffer.
    const openDocument = vscode.workspace.textDocuments.find((document) =>
      document.uri.toString() === uri.toString()
    );
    let text: string;
    let sourceLabel: string;
    if (openDocument) {
      text = openDocument.getText();
      sourceLabel = openDocument.isDirty ? 'live editor buffer; includes unsaved changes' : 'open editor buffer';
    } else {
      let bytes: Uint8Array;
      try {
        bytes = await vscode.workspace.fs.readFile(uri);
      } catch (error: unknown) {
        if (isFileNotFound(error)) {
          const parent = path.posix.dirname(relativePath.replace(/\\/g, '/'));
          const siblings = await Promise.resolve(vscode.workspace.findFiles(
            parent === '.' ? '*' : `${parent}/*`, EXCLUDES, 30
          )).catch(() => [] as vscode.Uri[]);
          const basenameToken = path.posix.basename(relativePath).toLowerCase().split('.')[0];
          let suggestions = siblings
            .map((candidate: vscode.Uri) => vscode.workspace.asRelativePath(candidate, false))
            .filter((candidate: string) => basenameToken && candidate.toLowerCase().includes(basenameToken))
            .slice(0, 8);
          if (!suggestions.length && basenameToken) {
            const workspaceFiles = await Promise.resolve(vscode.workspace.findFiles('**/*', EXCLUDES, 2500)).catch(() => [] as vscode.Uri[]);
            suggestions = workspaceFiles
              .map((candidate: vscode.Uri) => vscode.workspace.asRelativePath(candidate, false))
              .filter((candidate) => candidate.toLowerCase().includes(basenameToken))
              .slice(0, 8);
          }
          return {
            content: `File not found in the current workspace: ${relativePath}. This is a missing-path result, not a read failure. Do not retry this same path. Use list_workspace_files or search_workspace to discover the real filename. If this is a genuinely new file requested by the user, create it with propose_file_edit using createContent.\n${suggestions.length ? `Similar existing paths:\n${suggestions.join('\n')}` : `No similar files were found under ${parent}.`}`,
            isError: true,
            status: 'failed',
          };
        }
        throw error;
      }
      if (bytes.byteLength > MAX_FILE_READ_BYTES) {
        throw new Error('File is larger than 50 MB. Use workspace search to inspect a relevant section.');
      }
      if (bytes.includes(0)) {
        throw new Error('This appears to be a binary file. Binary file reading is not supported yet.');
      }
      text = Buffer.from(bytes).toString('utf8');
      sourceLabel = 'disk snapshot';
    }
    if (Buffer.byteLength(text, 'utf8') > MAX_FILE_READ_BYTES) {
      throw new Error('File is larger than 50 MB. Use workspace search to inspect a relevant section.');
    }
    if (text.includes('\0')) throw new Error('This appears to be a binary file. Binary file reading is not supported yet.');
    const allLines = text.split(/\r?\n/);
    const offset = Math.max(0, Math.min(Number(rawOffset) || 0, Math.max(0, allLines.length - 1)));
    const limit = rawLimit === undefined ? allLines.length : Math.max(1, Math.min(Number(rawLimit) || 2000, 2000));
    const selectedLines = allLines.slice(offset, offset + limit);
    const paginated = offset > 0 || selectedLines.length < allLines.length;
    return { content: `--- ${relativePath} ---\nSnapshot source: ${sourceLabel}\nCaptured: ${new Date().toISOString()}\nLines: ${offset + 1}-${offset + selectedLines.length} of ${allLines.length}${paginated ? ' (partial snapshot; request another range for more lines)' : ' (complete snapshot)'}\n\n${selectedLines.join('\n')}` };
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

  async searchWorkspace(query: string, glob?: string, rawLimit?: number, rawOffset?: number): Promise<ToolResult> {
    const needle = query?.trim();
    if (!needle) throw new Error('Search query is empty.');

    const limit = Math.min(Math.max(Number(rawLimit) || 30, 1), MAX_SEARCH_RESULT_LIMIT);
    const offset = Math.max(0, Math.min(Number(rawOffset) || 0, 100_000));
    const include = glob?.trim() ? glob : '**/*';
    const files = await vscode.workspace.findFiles(include, EXCLUDES, MAX_SEARCH_FILES);
    const results: string[] = [];
    const normalizedNeedle = needle.toLocaleLowerCase();

    let scannedBytes = 0;
    let scannedFiles = 0;
    let skippedLargeFiles = 0;

    for (const uri of files) {
      if (results.length >= offset + limit || scannedBytes >= MAX_SEARCH_TOTAL_BYTES) break;

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
        for (let index = 0; index < lines.length && results.length < offset + limit; index++) {
          const line = lines[index];
          if (line.toLocaleLowerCase().includes(normalizedNeedle)) {
            results.push(`${relativePath}:${index + 1}: ${line.trim().slice(0, 260)}`);
          }
        }
      } catch (error: unknown) {
        this.logger?.write({ level: 'warn', event: 'workspace.search_file_skipped', details: { path: relativePath, reason: error instanceof Error ? error.message : String(error) } });
      }
    }

    const pageResults = results.slice(offset, offset + limit);
    if (!pageResults.length) {
      const note =
        files.length >= MAX_SEARCH_FILES || scannedBytes >= MAX_SEARCH_TOTAL_BYTES
          ? ` Search was bounded to ${scannedFiles} readable files / ${Math.round(scannedBytes / (1024 * 1024))} MB.`
          : '';
      return { content: `No matches found.${note}` };
    }

    const notes: string[] = [];
    if (results.length >= offset + limit) notes.push(`Result page: ${offset + 1}-${offset + pageResults.length}; use offset for the next page.`);
    if (files.length >= MAX_SEARCH_FILES) notes.push('File scan capped at 2,500 files.');
    if (scannedBytes >= MAX_SEARCH_TOTAL_BYTES) notes.push('Read budget capped at 20 MB.');
    if (skippedLargeFiles) notes.push(`${skippedLargeFiles} large files skipped.`);
    return {
      content: notes.length ? `${pageResults.join('\n')}\n\n[${notes.join(' ')}]` : pageResults.join('\n'),
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
      if (createContent.length > MAX_CREATE_CONTENT_CHARS || Buffer.byteLength(createContent, 'utf8') > MAX_FILE_EDIT_BYTES || createContent.includes('\0')) {
        throw new Error('New file content exceeds the 50 MB limit or contains binary data.');
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
        diff: createUnifiedDiff('', createContent),
        patchCount: 1,
      }, signal);
      if (!approved && signal?.aborted) throw new Error('Request cancelled while waiting for file-creation approval.');
      if (!approved) {
        return { content: `User rejected the creation of ${relativePath}. Do not retry the same change.`, status: 'rejected' };
      }
      if (signal?.aborted) throw new Error('Request cancelled before the approved file creation could be applied.');
      let createdByAgent = false;
      try {
        this.reportProgress({ id, path: relativePath, stage: 'preparing', current: 0, total: 1, message: 'Preparing new file…' });
        await new Promise((resolve) => setTimeout(resolve, 45));
        if (signal?.aborted) throw new Error('Request cancelled before the new file could be written.');
        await assertPathInsideWorkspace(uri, root);
        try {
          await vscode.workspace.fs.stat(uri);
          throw new Error(`The file ${relativePath} was created while approval was pending. Nothing was overwritten.`);
        } catch (error: unknown) {
          if (!isFileNotFound(error)) throw error;
        }
        this.reportProgress({ id, path: relativePath, stage: 'applying', current: 1, total: 1, message: 'Writing approved new file…' });
        await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(uri.fsPath)));
        await vscode.workspace.fs.writeFile(uri, Buffer.from(createContent, 'utf8'));
        createdByAgent = true;
        this.reportProgress({ id, path: relativePath, stage: 'verifying', current: 1, total: 1, message: 'Verifying saved file…' });
        const saved = new TextDecoder('utf-8').decode(await vscode.workspace.fs.readFile(uri));
        if (saved !== createContent) throw new Error(`Verification failed for ${relativePath}. The file was written but does not match the approved content.`);
        const document = await vscode.workspace.openTextDocument(uri);
        try { await vscode.window.showTextDocument(document, { preview: false, preserveFocus: true }); }
        catch (error: unknown) { this.logger?.write({ level: 'warn', event: 'workspace.open_created_file_failed', details: { path: relativePath, reason: error instanceof Error ? error.message : String(error) } }); }
        this.reportProgress({ id, path: relativePath, stage: 'completed', current: 1, total: 1, message: 'New file saved and verified.' });
        return { content: `Successfully created and verified ${relativePath}.` };
      } catch (error: unknown) {
        // Remove a partially created file only when it still exactly matches our own payload.
        if (createdByAgent) {
          try {
            const current = new TextDecoder('utf-8').decode(await vscode.workspace.fs.readFile(uri));
            if (current === createContent) await vscode.workspace.fs.delete(uri);
          } catch { /* No created file to compensate, or it has changed since creation. */ }
        }
        this.logger?.write({ level: 'error', event: 'workspace.file_create_failed', details: { path: relativePath, reason: error instanceof Error ? error.message : String(error) } });
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
    // Patch the live VS Code document snapshot so unsaved user edits are preserved.
    // Approval preview and stale checks are based on this exact in-memory version.
    const wasDirtyAtProposal = document.isDirty;
    const originalText = document.getText();
    const originalDiskBytes = Buffer.from(await vscode.workspace.fs.readFile(uri));
    const originalVersion = document.version;
    if (Buffer.byteLength(originalText, 'utf8') > MAX_FILE_REPLACE_BYTES) {
      throw new Error('Refusing to edit a file larger than 50 MB.');
    }
    if (originalText.includes('\0')) throw new Error('Refusing to edit a binary file.');

    const patchResult = applyExactTextPatches(originalText, edits);
    if (Buffer.byteLength(patchResult.text, 'utf8') > MAX_FILE_EDIT_BYTES) {
      throw new Error('The resulting file would exceed the 50 MB edit limit. Split the change into smaller files.');
    }
    const preview = createPatchPreview(patchResult.patches);
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const approved = await this.requestApproval({
      id,
      kind: 'file',
      title: `Apply ${patchResult.patches.length} targeted edit${patchResult.patches.length === 1 ? '' : 's'} to ${relativePath}`,
      summary: (summary || 'Targeted patch proposed by Nemotron. Unmatched file content will remain untouched.') + (wasDirtyAtProposal ? ' Existing unsaved editor changes are preserved and will also be saved when this approved patch is applied.' : ''),
      path: relativePath,
      oldPreview: preview.oldPreview,
      newPreview: preview.newPreview,
      diff: createUnifiedDiff(preview.oldPreview, preview.newPreview),
      patchCount: patchResult.patches.length,
    }, signal);
    if (!approved && signal?.aborted) throw new Error('Request cancelled while waiting for patch approval.');
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
      if (document.version !== originalVersion || document.getText() !== originalText) {
        throw new Error('The file changed while approval was pending. Nothing was applied. Read the latest file and propose a fresh patch.');
      }
      const currentDiskBytes = Buffer.from(await vscode.workspace.fs.readFile(uri));
      const currentDiskText = new TextDecoder('utf-8').decode(currentDiskBytes);
      const originalDiskText = new TextDecoder('utf-8').decode(originalDiskBytes);
      const diskChanged = wasDirtyAtProposal
        ? currentDiskText !== originalDiskText && currentDiskText !== originalText
        : !currentDiskBytes.equals(originalDiskBytes);
      if (diskChanged) {
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
        // Compensate in the editor only if it still contains exactly our approved result.
        // This preserves the original unsaved snapshot when the user had dirty changes.
        if (document.getText() === patchResult.text) {
          const rollback = new vscode.WorkspaceEdit();
          rollback.replace(uri, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), originalText);
          await vscode.workspace.applyEdit(rollback);
        }
        throw new Error('VS Code could not save the approved patch. The editor was restored to its pre-edit snapshot when safe; review and save manually if the document was already dirty.');
      }

      progress('verifying', patchResult.patches.length, 'Verifying the saved file against the approved result…');
      const diskText = new TextDecoder('utf-8').decode(await vscode.workspace.fs.readFile(uri));
      if (diskText !== patchResult.text || document.getText() !== patchResult.text) {
        throw new Error('Post-save verification did not match the approved patch. The editor contents were preserved; inspect the file before continuing.');
      }

      try { await vscode.window.showTextDocument(document, { preview: false, preserveFocus: true }); }
      catch (error: unknown) { this.logger?.write({ level: 'warn', event: 'workspace.open_edited_file_failed', details: { path: relativePath, reason: error instanceof Error ? error.message : String(error) } }); }
      progress('completed', patchResult.patches.length, `Saved and verified ${patchResult.patches.length} targeted change${patchResult.patches.length === 1 ? '' : 's'}.`);
      return {
        content: `Successfully applied and verified ${patchResult.patches.length} targeted edit${patchResult.patches.length === 1 ? '' : 's'} in ${relativePath}. All text outside the approved exact-match sections was preserved.`,
      };
    } catch (error: unknown) {
      this.logger?.write({ level: 'error', event: 'workspace.file_edit_failed', details: { path: relativePath, reason: error instanceof Error ? error.message : String(error) } });
      progress('failed', 0, error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  private requestApproval(payload: Parameters<AskApproval>[0], signal?: AbortSignal): Promise<boolean> {
    if (signal?.aborted) return Promise.reject(new Error('Request cancelled while waiting for approval.'));
    return this.askApproval(payload, signal);
  }

  private reportProgress(progress: EditProgress): void {
    this.onEditProgress?.(progress);
  }

  async runCommand(command: string, reason: string, signal?: AbortSignal): Promise<ToolResult> {
    if (typeof command !== 'string' || !command.trim()) throw new Error('Command is empty.');
    if (command.length > MAX_COMMAND_LENGTH) throw new Error(`Command exceeds the ${MAX_COMMAND_LENGTH.toLocaleString()} character limit.`);
    validateCommand(command);

    const root = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!root) throw new Error('No workspace folder is open.');
    if (!vscode.workspace.isTrusted) throw new Error('Terminal execution is disabled in an untrusted workspace. Trust this workspace first.');
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const approved = await this.requestApproval({
      id,
      kind: 'command',
      title: 'Run terminal command',
      summary: reason || 'Command proposed by Nemotron',
      command,
    }, signal);
    if (!approved && signal?.aborted) throw new Error('Request cancelled while waiting for command approval.');
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
      const result = await execAsync(buildSafeCommand(command), {
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
    } catch (error: unknown) {
      const details = asCommandError(error);
      this.logger?.write({ level: 'warn', event: 'terminal.command_failed', details: { command, cwd, code: String(details.code ?? 'unknown'), reason: details.message ?? 'non-zero exit' } });
      const timedOut = details.killed === true || details.signal === 'SIGTERM' || details.code === 'ETIMEDOUT';
      return {
        content: [
          'Command execution result: FAILURE',
          `Command: ${command}`,
          `Working directory: ${cwd}`,
          `Exit code: ${typeof details.code === 'number' ? details.code : 'unknown'}`,
          `Standard output:\n${String(details.stdout || '(empty)').slice(0, 7000)}`,
          `Standard error:\n${String(details.stderr || details.message || '(empty)').slice(0, 2000)}`,
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
  const message = String(e?.message || '');
  return e?.code === 'FileNotFound' || e?.code === 'ENOENT' || e?.name === 'FileNotFound' ||
    /FileNotFound|ENOENT|no such file or directory/i.test(message);
}


function createUnifiedDiff(oldText: string, newText: string): string {
  const oldLines = oldText.split(/\r?\n/);
  const newLines = newText.split(/\r?\n/);
  const max = 160;
  const a = oldLines.slice(0, max);
  const b = newLines.slice(0, max);
  // A compact LCS diff is sufficient for approval previews; actual edits still
  // use the already-validated exact anchors and are not computed from this view.
  const dp: number[][] = Array.from({ length: a.length + 1 }, () => Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) {
    dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  }
  const rows: Array<{ kind: 'add' | 'remove' | 'same'; text: string }> = [];
  let i = 0, j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) rows.push({ kind: 'same', text: a[i++] }), j++;
    else if (j < b.length && (i === a.length || dp[i][j + 1] >= dp[i + 1][j])) rows.push({ kind: 'add', text: b[j++] });
    else rows.push({ kind: 'remove', text: a[i++] });
  }
  const output = rows.map((row) => `${row.kind === 'add' ? '+' : row.kind === 'remove' ? '-' : ' '} ${row.text}`);
  if (oldLines.length > max || newLines.length > max) output.push('… diff preview truncated …');
  return output.join('\n');
}

interface CommandErrorDetails { code?: string | number; signal?: string | null; killed?: boolean; stdout?: string; stderr?: string; message?: string; }

function asCommandError(error: unknown): CommandErrorDetails {
  if (!error || typeof error !== 'object') return { message: String(error) };
  const value = error as Record<string, unknown>;
  return {
    code: typeof value.code === 'string' || typeof value.code === 'number' ? value.code : undefined,
    signal: typeof value.signal === 'string' ? value.signal : null,
    killed: value.killed === true,
    stdout: typeof value.stdout === 'string' ? value.stdout : undefined,
    stderr: typeof value.stderr === 'string' ? value.stderr : undefined,
    message: typeof value.message === 'string' ? value.message : undefined,
  };
}



