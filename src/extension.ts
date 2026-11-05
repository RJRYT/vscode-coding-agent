import * as vscode from 'vscode';
import * as path from 'node:path';
import { realpath } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(exec);
const API_KEY_SECRET = 'nemotronAgent.nvidiaApiKey';
const MODEL_DEFAULT = 'nvidia/nemotron-3.5-super-vl-120b-a12b';
const EXCLUDES = '**/{node_modules,.git,dist,build,out,.next,coverage,vendor}/**,**/.env*,**/*.{pem,key,p12,pfx}';

type ChatMessage = { role: 'system' | 'user' | 'assistant' | 'tool'; content?: string | null; tool_call_id?: string; tool_calls?: any[]; name?: string };
type PendingApproval = { resolve: (approved: boolean) => void; timeout: NodeJS.Timeout };

class NemotronAgentView implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private history: ChatMessage[] = [];
  private pending = new Map<string, PendingApproval>();
  private busy = false;
  private abortController?: AbortController;

  constructor(private readonly context: vscode.ExtensionContext) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = this.getHtml(view.webview);
    view.webview.onDidReceiveMessage(async (message) => {
      switch (message?.type) {
        case 'ready':
          this.post({ type: 'status', text: await this.context.secrets.get(API_KEY_SECRET) ? 'Ready · NVIDIA key configured' : 'Add your NVIDIA API key to start' });
          break;
        case 'send':
          if (typeof message.text === 'string') await this.handleUserMessage(message.text);
          break;
        case 'approve':
          this.resolveApproval(String(message.id), true);
          break;
        case 'reject':
          this.resolveApproval(String(message.id), false);
          break;
        case 'newChat':
          this.resetConversation();
          break;
        case 'stop':
          this.stopRequest();
          break;
        case 'setKey':
          await vscode.commands.executeCommand('nemotronAgent.setApiKey');
          this.post({ type: 'status', text: await this.context.secrets.get(API_KEY_SECRET) ? 'Ready · NVIDIA key configured' : 'API key not configured' });
          break;
      }
    });
  }

  private post(message: unknown): void {
    void this.view?.webview.postMessage(message);
  }

  resetConversation(): void {
    this.stopRequest();
    this.history = [];
    this.post({ type: 'reset' });
  }

  private stopRequest(): void {
    this.abortController?.abort();
    this.abortController = undefined;
    for (const [id] of this.pending) this.resolveApproval(id, false);
    this.busy = false;
    this.post({ type: 'busy', value: false });
  }

  private async handleUserMessage(text: string): Promise<void> {
    const prompt = text.trim();
    if (!prompt || this.busy) return;
    const apiKey = await this.context.secrets.get(API_KEY_SECRET);
    if (!apiKey) {
      this.post({ type: 'status', text: 'NVIDIA API key required' });
      this.post({ type: 'error', text: 'NVIDIA API key is not configured. Click Key to add it, then send your request again.' });
      void vscode.commands.executeCommand('nemotronAgent.setApiKey');
      return;
    }
    if (!vscode.workspace.workspaceFolders?.length) {
      this.post({ type: 'status', text: 'No workspace is open' });
      this.post({ type: 'error', text: 'Open a project folder in VS Code before using the coding agent.' });
      return;
    }

    this.busy = true;
    const controller = new AbortController();
    this.abortController = controller;
    this.history.push({ role: 'user', content: prompt });
    this.post({ type: 'userMessage', text: prompt });
    this.post({ type: 'assistantStart' });
    this.post({ type: 'busy', value: true });
    this.post({ type: 'status', text: 'Thinking…' });

    try {
      await this.agentLoop(apiKey, controller.signal);
    } catch (error) {
      const err = error instanceof Error ? error.message : String(error);
      const aborted = controller.signal.aborted || (error instanceof Error && error.name === 'AbortError');
      if (!aborted) {
        this.post({ type: 'error', text: err });
      } else {
        this.post({ type: 'status', text: 'Stopped.' });
      }
    } finally {
      this.busy = false;
      this.abortController = undefined;
      this.post({ type: 'busy', value: false });
    }
  }

  private async agentLoop(apiKey: string, signal: AbortSignal): Promise<void> {
    const config = vscode.workspace.getConfiguration('nemotronAgent');
    const model = config.get<string>('model', MODEL_DEFAULT);
    const baseUrl = config.get<string>('baseUrl', 'https://integrate.api.nvidia.com/v1').replace(/\/$/, '');
    const maxTokens = config.get<number>('maxTokens', 16384);
    const maxRounds = config.get<number>('maxToolRounds', 8);
    const system = this.systemPrompt();

    for (let round = 0; round <= maxRounds; round++) {
      if (signal.aborted) throw new Error('The operation was aborted.');
      const messages: ChatMessage[] = [{ role: 'system', content: system }, ...this.history];
      this.post({ type: 'status', text: round === 0 ? 'Nemotron is thinking…' : 'Working with workspace tools…' });
      const response = await this.requestModel({ baseUrl, apiKey, model, maxTokens, messages, signal, tools: this.toolDefinitions(), reasoning: config.get<boolean>('reasoning', true) });

      const assistantMessage: ChatMessage = {
        role: 'assistant',
        content: response.content || null,
        ...(response.toolCalls.length ? { tool_calls: response.toolCalls } : {})
      };
      this.history.push(assistantMessage);

      if (!response.toolCalls.length) {
        if (!response.content?.trim()) this.post({ type: 'delta', text: 'I could not produce a visible answer. Please try again.' });
        this.post({ type: 'assistantDone' });
        return;
      }

      if (round === maxRounds) {
        this.history.push({ role: 'assistant', content: `I reached the configured tool-call limit (${maxRounds}). Ask me to continue.` });
        this.post({ type: 'delta', text: `\n\nI reached the configured tool-call limit (${maxRounds}). Ask me to continue.` });
        this.post({ type: 'assistantDone' });
        return;
      }

      for (const toolCall of response.toolCalls) {
        if (signal.aborted) throw new Error('The operation was aborted.');
        const name = toolCall.function?.name;
        let args: any;
        try { args = JSON.parse(toolCall.function?.arguments || '{}'); }
        catch { args = {}; }
        this.post({ type: 'toolStart', name, args });
        let result: string;
        try { result = await this.executeTool(name, args); }
        catch (error) { result = `Tool error: ${error instanceof Error ? error.message : String(error)}`; }
        this.history.push({ role: 'tool', tool_call_id: toolCall.id, content: result });
        this.post({ type: 'toolDone', name, result: result.slice(0, 1200) });
      }
    }
  }

  private systemPrompt(): string {
    const folders = vscode.workspace.workspaceFolders ?? [];
    const rootNames = folders.map((f) => f.name).join(', ');
    return `You are Nemotron Agent, a careful senior software engineer working inside Visual Studio Code. You are an autonomous coding assistant similar to Codex, but you must use the provided workspace tools for repository facts and changes.\n\nWORKSPACE: ${rootNames}\n\nRULES:\n- Inspect relevant files before proposing changes. Search before guessing.\n- Make focused, complete changes that fit the existing architecture, naming, formatting, and dependencies.\n- Never claim a change was made unless propose_file_edit completed successfully.\n- Use propose_file_edit for every file creation or modification. It requires explicit user approval. Never attempt to modify files through terminal commands, scripts, or other indirect means.\n- Use run_terminal_command only for necessary checks, builds, tests, lint, or type-check commands. It requires user approval. Never use terminal commands to install packages or edit, delete, overwrite, or move source files.\n- Do not run destructive commands, install global packages, access secrets, or operate outside the opened workspace. If a task appears to need a destructive action, explain and ask first rather than issuing it.\n- Read only the files needed for the task. Avoid dependency folders, generated output, secrets, and environment files.\n- Prefer minimal diffs. Preserve unrelated user changes.\n- After edits, run relevant tests/build/lint when appropriate and summarize exact files changed and checks performed.\n- If requirements are unclear, ask one concise question; otherwise make a reasonable, clearly stated assumption.\n- Be direct. Do not dump entire files into chat unless needed.`;
  }

  private toolDefinitions(): any[] {
    return [
      {
        type: 'function',
        function: {
          name: 'list_workspace_files',
          description: 'List relevant files in the opened workspace. Use a glob such as **/*.tsx or **/*config*.',
          parameters: {
            type: 'object',
            properties: {
              glob: { type: 'string', description: 'Optional glob pattern; defaults to **/*.' },
              limit: { type: 'integer', description: 'Maximum number of paths (max 150).' }
            },
            required: []
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'read_file',
          description: 'Read a UTF-8 text file from the workspace. Paths must be relative to the workspace root.',
          parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }
        }
      },
      {
        type: 'function',
        function: {
          name: 'get_active_editor_context',
          description: 'Get the active editor file and selected text (or nearby file contents when there is no selection). Useful when the user refers to the currently open file or selected code.',
          parameters: { type: 'object', properties: {}, required: [] }
        }
      },
      {
        type: 'function',
        function: {
          name: 'search_workspace',
          description: 'Search text in workspace files. Returns matching file paths, line numbers, and short matching lines.',
          parameters: {
            type: 'object',
            properties: {
              query: { type: 'string' },
              glob: { type: 'string', description: 'Optional file glob, for example **/*.{ts,tsx}.' },
              limit: { type: 'integer' }
            },
            required: ['query']
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'propose_file_edit',
          description: 'Propose creating or replacing a workspace text file. The user must approve the preview before the change is written. Always read an existing file first.',
          parameters: {
            type: 'object',
            properties: { path: { type: 'string' }, content: { type: 'string' }, summary: { type: 'string' } },
            required: ['path', 'content', 'summary']
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'run_terminal_command',
          description: 'Propose a shell command to run in the workspace root. The user must approve it. Use for tests, builds, lint, or type checks only; do not use it to install packages or edit source files.',
          parameters: {
            type: 'object',
            properties: { command: { type: 'string' }, reason: { type: 'string' } },
            required: ['command', 'reason']
          }
        }
      }
    ];
  }

  private async requestModel(args: { baseUrl: string; apiKey: string; model: string; maxTokens: number; messages: ChatMessage[]; signal: AbortSignal; tools: any[]; reasoning: boolean }): Promise<{ content: string; reasoning: string; toolCalls: any[] }> {
    const response = await fetch(`${args.baseUrl}/chat/completions`, {
      method: 'POST',
      signal: args.signal,
      headers: { 'Authorization': `Bearer ${args.apiKey}`, 'Content-Type': 'application/json', 'Accept': 'text/event-stream' },
      body: JSON.stringify({
        model: args.model,
        messages: args.messages,
        tools: args.tools,
        tool_choice: 'auto',
        parallel_tool_calls: false,
        temperature: 1,
        top_p: 0.95,
        max_tokens: args.maxTokens,
        stream: true,
        chat_template_kwargs: { enable_thinking: args.reasoning, force_nonempty_content: true }
      })
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`NVIDIA API returned ${response.status}: ${body.slice(0, 1400)}`);
    }
    if (!response.body) throw new Error('NVIDIA API returned an empty response stream.');

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let content = '';
    let reasoning = '';
    const toolCalls = new Map<number, any>();

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
      const blocks = buffer.split('\n\n');
      buffer = blocks.pop() ?? '';
      for (const block of blocks) {
        const dataLine = block.split('\n').find((line) => line.startsWith('data:'));
        if (!dataLine) continue;
        const raw = dataLine.slice(5).trim();
        if (!raw || raw === '[DONE]') continue;
        let payload: any;
        try { payload = JSON.parse(raw); } catch { continue; }
        if (payload.error) throw new Error(payload.error.message || 'NVIDIA stream returned an error.');
        const delta = payload.choices?.[0]?.delta;
        if (!delta) continue;
        if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
          reasoning += delta.reasoning_content;
          this.post({ type: 'reasoningDelta', text: delta.reasoning_content });
        }
        if (typeof delta.content === 'string' && delta.content) {
          content += delta.content;
          this.post({ type: 'delta', text: delta.content });
        }
        for (const call of delta.tool_calls ?? []) {
          const index = Number(call.index ?? 0);
          const existing = toolCalls.get(index) ?? { id: '', type: 'function', function: { name: '', arguments: '' } };
          if (call.id) existing.id = call.id;
          if (call.function?.name) existing.function.name += call.function.name;
          if (call.function?.arguments) existing.function.arguments += call.function.arguments;
          toolCalls.set(index, existing);
        }
      }
    }
    const orderedCalls = [...toolCalls.entries()].sort((a, b) => a[0] - b[0]).map(([, call]) => call);
    return { content, reasoning, toolCalls: orderedCalls };
  }

  private async executeTool(name: string, args: any): Promise<string> {
    switch (name) {
      case 'list_workspace_files': return this.listFiles(args.glob, args.limit);
      case 'read_file': return this.readFile(args.path);
      case 'get_active_editor_context': return this.getActiveEditorContext();
      case 'search_workspace': return this.searchWorkspace(args.query, args.glob, args.limit);
      case 'propose_file_edit':
        if (!vscode.workspace.isTrusted) return 'File editing is disabled until this workspace is trusted in VS Code.';
        return this.proposeFileEdit(args.path, args.content, args.summary);
      case 'run_terminal_command':
        if (!vscode.workspace.isTrusted) return 'Terminal commands are disabled until this workspace is trusted in VS Code.';
        return this.runCommand(args.command, args.reason);
      default: return `Unknown tool: ${name}`;
    }
  }

  private workspaceRoot(): vscode.Uri {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!root) throw new Error('No workspace folder is open.');
    return root;
  }

  private safeUri(relativePath: string): vscode.Uri {
    if (typeof relativePath !== 'string' || !relativePath.trim()) throw new Error('A relative file path is required.');
    if (path.isAbsolute(relativePath) || relativePath.startsWith('\\\\') || /^[a-zA-Z]:/.test(relativePath)) throw new Error('Absolute paths are not allowed.');
    const portable = relativePath.replace(/\\/g, '/');
    const normalized = path.posix.normalize(portable).replace(/^\.\//, '');
    if (!normalized || normalized === '.' || path.posix.isAbsolute(normalized) || normalized === '..' || normalized.startsWith('../') || normalized.split('/').includes('..')) throw new Error('Path traversal is not allowed.');
    return vscode.Uri.joinPath(this.workspaceRoot(), normalized);
  }

  private async listFiles(glob?: string, rawLimit?: number): Promise<string> {
    const pattern = typeof glob === 'string' && glob.trim() ? glob : '**/*';
    const limit = Math.min(Math.max(Number(rawLimit) || 100, 1), 150);
    const files = await vscode.workspace.findFiles(pattern, EXCLUDES, limit);
    return files.length ? files.map((uri: vscode.Uri) => vscode.workspace.asRelativePath(uri, false)).join('\n') : 'No files matched.';
  }

  private async assertPathInsideWorkspace(uri: vscode.Uri): Promise<void> {
    const root = await realpath(this.workspaceRoot().fsPath);
    let cursor = uri.fsPath;
    const missing: string[] = [];
    let resolved = '';
    while (true) {
      try {
        const existing = await realpath(cursor);
        resolved = path.join(existing, ...missing);
        break;
      } catch {
        const parent = path.dirname(cursor);
        if (parent === cursor) throw new Error('Unable to verify this path.');
        missing.unshift(path.basename(cursor));
        cursor = parent;
      }
    }
    const relative = path.relative(root, resolved);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error('The requested path resolves outside the opened workspace.');
    }
  }

  private isSensitivePath(relativePath: string): boolean {
    const normalized = relativePath.replace(/\\/g, '/').toLowerCase();
    const parts = normalized.split('/');
    const name = parts[parts.length - 1] || '';
    return parts.some((part) => ['.ssh', '.aws', '.gnupg'].includes(part)) || name === '.env' || name.startsWith('.env.') || name === '.npmrc' || name === '.netrc' || name === 'credentials' || name === 'id_rsa' || name === 'id_ed25519' || name.endsWith('.pem') || name.endsWith('.key') || name.endsWith('.p12') || name.endsWith('.pfx') || name.endsWith('.p8') || name.includes('secret');
  }

  private async readFile(relativePath: string): Promise<string> {
    if (this.isSensitivePath(relativePath)) throw new Error('Reading environment files, private keys, and secret files is blocked.');
    const uri = this.safeUri(relativePath);
    await this.assertPathInsideWorkspace(uri);
    const bytes = await vscode.workspace.fs.readFile(uri);
    if (bytes.byteLength > 120_000) throw new Error('File is larger than 120 KB. Search for a smaller relevant section or inspect it in the editor.');
    if (bytes.includes(0)) throw new Error('This appears to be a binary file. Binary file reading is not supported yet.');
    const text = Buffer.from(bytes).toString('utf8');
    return `--- ${relativePath} ---\n${text}`;
  }

  private async getActiveEditorContext(): Promise<string> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return 'No active text editor.';
    if (!vscode.workspace.getWorkspaceFolder(editor.document.uri)) return 'The active editor is outside the opened workspace.';
    const relativePath = vscode.workspace.asRelativePath(editor.document.uri, false);
    if (this.isSensitivePath(relativePath)) return 'The active file appears to contain secrets and is blocked from agent context.';
    const selection = editor.selection;
    if (!selection.isEmpty) {
      const selected = editor.document.getText(selection).slice(0, 30_000);
      return `Active file: ${relativePath}\nSelected lines: ${selection.start.line + 1}-${selection.end.line + 1}\n\n${selected}`;
    }
    const content = editor.document.getText();
    return `Active file: ${relativePath}\n\n${content.slice(0, 60_000)}${content.length > 60_000 ? '\n[File context truncated at 60 KB]' : ''}`;
  }

  private async searchWorkspace(query: string, glob?: string, rawLimit?: number): Promise<string> {
    const needle = query?.trim();
    if (!needle) throw new Error('Search query is empty.');

    const limit = Math.min(Math.max(Number(rawLimit) || 30, 1), 60);
    const include = glob?.trim() ? glob : '**/*';
    const files = await vscode.workspace.findFiles(include, EXCLUDES, 2500);
    const results: string[] = [];
    const normalizedNeedle = needle.toLocaleLowerCase();

    // Keep this bounded: this is a stable-API fallback for text search, not a full ripgrep replacement.
    const maxFileBytes = 512 * 1024;
    const maxTotalBytes = 20 * 1024 * 1024;
    let scannedBytes = 0;
    let scannedFiles = 0;
    let skippedLargeFiles = 0;

    for (const uri of files) {
      if (results.length >= limit || scannedBytes >= maxTotalBytes) break;

      const relativePath = vscode.workspace.asRelativePath(uri, false);
      if (this.isSensitivePath(relativePath)) continue;

      try {
        const stat = await vscode.workspace.fs.stat(uri);
        if (stat.size > maxFileBytes || scannedBytes + stat.size > maxTotalBytes) {
          skippedLargeFiles++;
          continue;
        }

        const bytes = await vscode.workspace.fs.readFile(uri);
        scannedBytes += bytes.byteLength;
        scannedFiles++;
        // Skip likely binary files instead of decoding arbitrary bytes as source text.
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
      const note = files.length >= 2500 || scannedBytes >= maxTotalBytes
        ? ` Search was bounded to ${scannedFiles} readable files / ${Math.round(scannedBytes / (1024 * 1024))} MB.`
        : '';
      return `No matches found.${note}`;
    }

    const notes: string[] = [];
    if (results.length >= limit) notes.push(`Result limit: ${limit}.`);
    if (files.length >= 2500) notes.push('File scan capped at 2,500 files.');
    if (scannedBytes >= maxTotalBytes) notes.push('Read budget capped at 20 MB.');
    if (skippedLargeFiles) notes.push(`${skippedLargeFiles} large files skipped.`);
    return notes.length ? `${results.join('\n')}\n\n[${notes.join(' ')}]` : results.join('\n');
  }

  private async proposeFileEdit(relativePath: string, content: string, summary: string): Promise<string> {
    if (typeof content !== 'string') throw new Error('File content must be a string.');
    if (this.isSensitivePath(relativePath)) throw new Error('Editing environment files, private keys, and secret files is blocked.');
    const uri = this.safeUri(relativePath);
    await this.assertPathInsideWorkspace(uri);
    if (content.length > 250_000) throw new Error('Proposed file content is larger than 250 KB. Split the change into smaller files.');
    let oldContent = '';
    let exists = false;
    try {
      const current = await vscode.workspace.fs.readFile(uri);
      if (current.byteLength > 200_000) throw new Error('Refusing to replace a file larger than 200 KB.');
      if (current.includes(0)) throw new Error('Refusing to replace a binary file.');
      oldContent = Buffer.from(current).toString('utf8');
      exists = true;
    } catch (error: any) {
      if (error?.code !== 'FileNotFound' && error?.name !== 'FileNotFound' && !String(error?.message || '').includes('FileNotFound')) throw error;
    }
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const approved = await this.askApproval({
      id,
      kind: 'file',
      title: exists ? `Edit ${relativePath}` : `Create ${relativePath}`,
      summary: summary || 'File change proposed by Nemotron',
      path: relativePath,
      oldPreview: oldContent,
      newPreview: content
    });
    if (!approved) return `User rejected the proposed change to ${relativePath}. Do not retry the same change; explain or propose a different approach.`;
    await this.assertPathInsideWorkspace(uri);
    await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(uri.fsPath)));
    await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'));
    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(document, { preview: false, preserveFocus: true });
    return `Successfully ${exists ? 'updated' : 'created'} ${relativePath}.`;
  }

  private async runCommand(command: string, reason: string): Promise<string> {
    if (typeof command !== 'string' || !command.trim()) throw new Error('Command is empty.');
    if (command.length > 1200) throw new Error('Command is too long.');
    if (/(^|[;&|]\s*)(rm\b|mv\b|cp\b|del\b|erase\b|rmdir\b|mkdir\b|touch\b|tee\b|chmod\b|chown\b|shutdown\b|reboot\b|format\s+[a-z]:|git\s+(reset|checkout|clean|restore|rm|apply)\b|npm\s+(install|ci|uninstall)\b|pnpm\s+(add|install|remove|i)\b|yarn\s+(add|install|remove)\b|patch\b|printenv\b|env\b)(\s|$)/i.test(command) || /(^|\s)(>>?|\|\s*tee)(\s|$)/.test(command) || /\b(sed\s+-i|perl\s+-i|python\s+-c|node\s+-e|bash\s+-c|powershell\s+.*-command)\b/i.test(command) || /\b(cat|type|more|less|Get-Content)\s+[^\n]*(\.env|id_rsa|id_ed25519|\.pem|\.key|secret)/i.test(command)) throw new Error('This command appears to modify files, dependencies, or system state and is blocked. Use an approved file proposal for source changes; run checks/builds/tests only.');
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const approved = await this.askApproval({ id, kind: 'command', title: 'Run terminal command', summary: reason || 'Command proposed by Nemotron', command });
    if (!approved) return 'User rejected the terminal command. Do not retry it; continue without running it or explain the limitation.';
    const cwd = this.workspaceRoot().fsPath;
    try {
      const result = await execAsync(command, { cwd, timeout: 120_000, maxBuffer: 1024 * 1024, windowsHide: true, shell: process.platform === 'win32' ? 'cmd.exe' : '/bin/bash' });
      const output = `${result.stdout || ''}${result.stderr ? `\n[stderr]\n${result.stderr}` : ''}`.trim();
      return `Command completed successfully.\n${output.slice(0, 9000) || '(no output)'}`;
    } catch (error: any) {
      const output = `${error?.stdout || ''}${error?.stderr ? `\n[stderr]\n${error.stderr}` : ''}`.trim();
      return `Command failed (exit ${error?.code ?? 'unknown'}).\n${output.slice(0, 9000) || error?.message || 'No output.'}`;
    }
  }

  private askApproval(payload: any): Promise<boolean> {
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.pending.delete(payload.id);
        resolve(false);
        this.post({ type: 'approvalExpired', id: payload.id });
      }, 5 * 60_000);
      this.pending.set(payload.id, { resolve, timeout });
      this.post({ type: 'approval', ...payload });
    });
  }

  private resolveApproval(id: string, approved: boolean): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    clearTimeout(pending.timeout);
    this.pending.delete(id);
    pending.resolve(approved);
    this.post({ type: 'approvalResolved', id, approved });
  }

  private getHtml(webview: vscode.Webview): string {
    const nonce = randomBytes(18).toString('base64');
    const csp = `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';`;
    return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><meta http-equiv="Content-Security-Policy" content="${csp}"><title>Nemotron Agent</title>
<style>
:root{color-scheme:light dark;--bg:var(--vscode-sideBar-background);--fg:var(--vscode-foreground);--muted:var(--vscode-descriptionForeground);--border:var(--vscode-panel-border);--card:var(--vscode-editorWidget-background);--accent:var(--vscode-button-background);--accentFg:var(--vscode-button-foreground);--input:var(--vscode-input-background)}*{box-sizing:border-box}body{margin:0;padding:0;background:var(--bg);color:var(--fg);font:13px var(--vscode-font-family);height:100vh;display:flex;flex-direction:column}.top{height:44px;display:flex;align-items:center;justify-content:space-between;padding:0 12px;border-bottom:1px solid var(--border);flex-shrink:0}.brand{font-weight:650;letter-spacing:.1px}.sub{font-size:11px;color:var(--muted)}button{font:inherit;cursor:pointer;border:1px solid var(--border);background:transparent;color:var(--fg);border-radius:6px;padding:6px 9px}button:hover{background:var(--vscode-toolbar-hoverBackground)}button.primary{background:var(--accent);color:var(--accentFg);border-color:transparent}button:disabled{opacity:.5;cursor:not-allowed}.feed{flex:1;overflow:auto;padding:12px;display:flex;flex-direction:column;gap:12px}.welcome{margin:auto 0;text-align:center;color:var(--muted);padding:16px 6px}.welcome h2{font-size:16px;color:var(--fg);margin-bottom:6px}.welcome p{line-height:1.5}.suggestions{display:flex;flex-wrap:wrap;gap:6px;justify-content:center;margin-top:12px}.suggestions button{font-size:11px}.message{max-width:100%;line-height:1.55;overflow-wrap:anywhere}.message.user{background:var(--vscode-textBlockQuote-background);border:1px solid var(--border);padding:9px 10px;border-radius:9px;align-self:flex-end;max-width:94%;white-space:pre-wrap}.message.assistant{white-space:normal}.message.assistant .content{white-space:pre-wrap}.message .label{font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.6px;margin-bottom:4px}.message pre{white-space:pre-wrap;overflow:auto;background:var(--vscode-textCodeBlock-background);padding:9px;border-radius:6px}.reasoning{font-size:11px;color:var(--muted);border-left:2px solid var(--border);padding:5px 8px;margin:4px 0;white-space:pre-wrap}.tool{border:1px solid var(--border);border-radius:7px;padding:8px;font-size:11px}.tool .name{font-weight:650}.tool .result{color:var(--muted);white-space:pre-wrap;margin-top:4px;max-height:100px;overflow:auto}.approval{border:1px solid var(--vscode-editorWarning-foreground);border-radius:8px;padding:10px;background:var(--card);display:flex;flex-direction:column;gap:8px}.approval h4{margin:0;font-size:13px}.approval .desc{color:var(--muted)}.preview{display:grid;grid-template-columns:1fr 1fr;gap:6px}.preview pre{margin:0;max-height:180px;font-size:10px;white-space:pre-wrap;overflow:auto;padding:7px;background:var(--vscode-textCodeBlock-background);border-radius:5px}.approval .actions{display:flex;gap:7px;justify-content:flex-end}.approval .danger{border-color:var(--vscode-errorForeground);color:var(--vscode-errorForeground)}.composer{border-top:1px solid var(--border);padding:9px;display:flex;flex-direction:column;gap:7px;flex-shrink:0}.textareaWrap{border:1px solid var(--vscode-input-border,var(--border));background:var(--input);border-radius:8px;padding:7px}.textareaWrap:focus-within{border-color:var(--vscode-focusBorder)}textarea{width:100%;resize:vertical;min-height:66px;max-height:180px;background:transparent;border:0;outline:0;color:var(--fg);font:inherit}.composerFoot{display:flex;align-items:center;justify-content:space-between}.status{font-size:10px;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.actions{display:flex;gap:6px}.key{font-size:11px;color:var(--muted)}.send{min-width:62px}.hidden{display:none!important}a{color:var(--vscode-textLink-foreground)}
</style></head><body>
<div class="top"><div><div class="brand">Nemotron Agent</div><div class="sub">Workspace coding assistant</div></div><div style="display:flex;gap:5px"><button id="keyBtn" title="Set NVIDIA API key">Key</button><button id="newBtn" title="New chat">＋</button></div></div>
<div class="feed" id="feed"><div class="welcome" id="welcome"><h2>What are we building?</h2><p>Ask me to understand your codebase, fix bugs, implement features, or run checks. I’ll ask before editing files or running commands.</p><div class="suggestions"><button data-prompt="Explore this codebase and explain its architecture.">Explore codebase</button><button data-prompt="Find likely bugs and suggest fixes. Do not change files yet.">Find bugs</button><button data-prompt="Review this project and identify the most important improvements.">Review project</button></div></div></div>
<div class="composer"><div class="textareaWrap"><textarea id="prompt" placeholder="Ask Nemotron to work on your code… (Enter to send, Shift+Enter for newline)"></textarea></div><div class="composerFoot"><div class="status" id="status">Connect your NVIDIA API key to begin</div><div class="actions"><button id="stopBtn" class="hidden">Stop</button><button id="sendBtn" class="primary send">Send ↑</button></div></div></div>
<script nonce="${nonce}">
const vscode=acquireVsCodeApi();const feed=document.getElementById('feed');const input=document.getElementById('prompt');const sendBtn=document.getElementById('sendBtn');const stopBtn=document.getElementById('stopBtn');const statusEl=document.getElementById('status');let currentAssistant=null;let busy=false;const approvals=new Map();
function el(tag,cls,text){const n=document.createElement(tag);if(cls)n.className=cls;if(text!==undefined)n.textContent=text;return n}
function scroll(){feed.scrollTop=feed.scrollHeight}
function addUser(text){document.getElementById('welcome')?.remove();feed.append(el('div','message user',text));scroll()}
function startAssistant(){document.getElementById('welcome')?.remove();const wrap=el('div','message assistant');wrap.append(el('div','label','Nemotron'));const content=el('div','content');wrap.append(content);feed.append(wrap);currentAssistant=content;scroll()}
function appendText(target,text){if(!target)return;target.append(document.createTextNode(text));scroll()}
function addReasoning(text){if(!currentAssistant)return;let r=currentAssistant.querySelector('.reasoning');if(!r){r=el('div','reasoning');currentAssistant.prepend(r)}r.append(document.createTextNode(text));scroll()}
function toolStart(name,args){const box=el('div','tool');box.dataset.tool=name;box.append(el('div','name','⚙ '+name));box.append(el('div','result',JSON.stringify(args)));(currentAssistant||feed).append(box);scroll()}
function toolDone(name,result){const boxes=[...(currentAssistant||feed).querySelectorAll('.tool')].reverse();const box=boxes.find(b=>b.dataset.tool===name&&!b.querySelector('.done'));if(box){const r=box.querySelector('.result');r.textContent=result;const d=el('span','done',' · done');box.querySelector('.name').append(d)}scroll()}
function approvalCard(m){const card=el('div','approval');card.dataset.approval=m.id;card.append(el('h4',null,m.title));card.append(el('div','desc',m.summary||''));if(m.kind==='file'){card.append(el('div','desc',m.path));const grid=el('div','preview');grid.append(el('pre',null,'CURRENT\\n'+(m.oldPreview||'(new file)')));grid.append(el('pre',null,'PROPOSED\\n'+(m.newPreview||'')));card.append(grid);}else{card.append(el('pre',null,m.command||''))}const actions=el('div','actions');const reject=el('button','danger','Reject');const approve=el('button','primary','Approve');reject.onclick=()=>vscode.postMessage({type:'reject',id:m.id});approve.onclick=()=>{approve.disabled=true;reject.disabled=true;approve.textContent='Approved';vscode.postMessage({type:'approve',id:m.id})};actions.append(reject,approve);card.append(actions);feed.append(card);approvals.set(m.id,card);scroll()}
function setBusy(v){busy=v;sendBtn.disabled=v;stopBtn.classList.toggle('hidden',!v);statusEl.textContent=v?'Agent is working…':statusEl.textContent}
function send(){const text=input.value.trim();if(!text||busy)return;addUser(text);input.value='';startAssistant();vscode.postMessage({type:'send',text})}
sendBtn.onclick=send;stopBtn.onclick=()=>vscode.postMessage({type:'stop'});document.getElementById('newBtn').onclick=()=>vscode.postMessage({type:'newChat'});document.getElementById('keyBtn').onclick=()=>vscode.postMessage({type:'setKey'});input.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();send()}});document.querySelectorAll('[data-prompt]').forEach(b=>b.onclick=()=>{input.value=b.dataset.prompt;input.focus()});
window.addEventListener('message',event=>{const m=event.data;switch(m.type){case'ready':break;case'status':statusEl.textContent=m.text;break;case'userMessage':break;case'assistantStart':break;case'delta':appendText(currentAssistant,m.text);break;case'reasoningDelta':addReasoning(m.text);break;case'reasoning':addReasoning(m.text);break;case'toolStart':toolStart(m.name,m.args);break;case'toolDone':toolDone(m.name,m.result);break;case'approval':approvalCard(m);statusEl.textContent='Waiting for your approval…';break;case'approvalResolved':{const c=approvals.get(m.id);if(c){c.querySelector('.actions').textContent=m.approved?'Approved':'Rejected';c.style.opacity='.65'}break}case'approvalExpired':{const c=approvals.get(m.id);if(c){c.querySelector('.actions').textContent='Approval expired';c.style.opacity='.65'}break}case'assistantDone':currentAssistant=null;statusEl.textContent='Ready';break;case'error':{appendText(currentAssistant,'\\n\\nError: '+m.text);currentAssistant=null;statusEl.textContent='Request failed';break}case'busy':setBusy(m.value);if(!m.value&&statusEl.textContent==='Agent is working…')statusEl.textContent='Ready';break;case'reset':feed.innerHTML='';const w=el('div','welcome');w.id='welcome';w.innerHTML='<h2>New conversation</h2><p>Ask me to understand your codebase, fix bugs, or implement a feature.</p>';feed.append(w);currentAssistant=null;statusEl.textContent='New chat';break}});vscode.postMessage({type:'ready'});
</script></body></html>`;
  }
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const provider = new NemotronAgentView(context);
  context.subscriptions.push(vscode.window.registerWebviewViewProvider('nemotronAgent.chatView', provider, { webviewOptions: { retainContextWhenHidden: true } }));
  context.subscriptions.push(vscode.commands.registerCommand('nemotronAgent.setApiKey', async () => {
    const value = await vscode.window.showInputBox({ title: 'NVIDIA API Key', prompt: 'Paste your NVIDIA NIM API key. It will be stored in VS Code Secret Storage.', password: true, ignoreFocusOut: true });
    if (value?.trim()) {
      await context.secrets.store(API_KEY_SECRET, value.trim());
      void vscode.window.showInformationMessage('NVIDIA API key saved securely.');
    }
  }));
  context.subscriptions.push(vscode.commands.registerCommand('nemotronAgent.clearApiKey', async () => {
    await context.secrets.delete(API_KEY_SECRET);
    void vscode.window.showInformationMessage('NVIDIA API key removed.');
  }));
  context.subscriptions.push(vscode.commands.registerCommand('nemotronAgent.newChat', () => {
    provider.resetConversation();
    void vscode.commands.executeCommand('workbench.view.extension.nemotronAgent');
  }));
  context.subscriptions.push(vscode.commands.registerCommand('nemotronAgent.focus', () => vscode.commands.executeCommand('workbench.view.extension.nemotronAgent')));
}

export function deactivate(): void {}
