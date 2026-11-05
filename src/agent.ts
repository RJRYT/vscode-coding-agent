import * as vscode from 'vscode';
import {
  ChatMessage,
  NemotronAgentConfig,
  ChatData,
} from './config';
import { ToolRegistry, ToolResult } from './tools';
import { ModelClient } from './model';
import { ChatStore } from './storage';

export class AgentLoop {
  private history: ChatMessage[] = [];
  private busy = false;
  private abortController?: AbortController;
  private currentChatId: string | null = null;
  private readonly store: ChatStore;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly tools: ToolRegistry,
    private readonly post: (message: unknown) => void,
  ) {
    this.store = new ChatStore(context);
  }

  get isBusy(): boolean {
    return this.busy;
  }

  get currentChat(): string | null {
    return this.currentChatId;
  }

  resetConversation(): void {
    this.stopRequest();
    this.history = [];
    this.currentChatId = null;
    this.post({ type: 'reset' });
  }

  stopRequest(): void {
    this.abortController?.abort();
    this.abortController = undefined;
    this.busy = false;
    this.post({ type: 'busy', value: false });
  }

  async loadChat(id: string): Promise<boolean> {
    const chat = this.store.getChat(id);
    if (!chat) return false;
    this.stopRequest();
    this.currentChatId = id;
    this.history = [...(chat.messages ?? [])];
    this.post({ type: 'reset' });
    this.post({ type: 'chatLoaded', id: chat.id, title: chat.title, messages: this.history });
    return true;
  }

  async createNewChat(): Promise<void> {
    this.stopRequest();
    this.history = [];
    this.currentChatId = null;
    this.post({ type: 'reset' });
  }

  async handleUserMessage(text: string, apiKey: string, config: NemotronAgentConfig): Promise<void> {
    const prompt = text.trim();
    if (!prompt || this.busy) return;
    if (!vscode.workspace.workspaceFolders?.length) {
      this.post({ type: 'status', text: 'No workspace is open' });
      this.post({ type: 'error', text: 'Open a project folder in VS Code before using the coding agent.' });
      return;
    }

    // Ensure we have a chat to persist into.
    if (!this.currentChatId && config.autoSaveChats) {
      this.currentChatId = this.store.generateId();
      const chat: ChatData = {
        id: this.currentChatId,
        title: this.store.generateTitle(prompt),
        createdAt: Date.now(),
        updatedAt: Date.now(),
        messages: [],
      };
      this.store.saveChat(chat);
      this.post({ type: 'chatCreated', id: this.currentChatId, title: chat.title });
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
      await this.runAgentLoop(apiKey, config, controller.signal);
    } catch (error) {
      const err = error instanceof Error ? error.message : String(error);
      const aborted = controller.signal.aborted || (error instanceof Error && error.name === 'AbortError');
      if (!aborted) {
        this.post({ type: 'error', text: err });
      } else {
        this.post({ type: 'status', text: 'Stopped.' });
      }
    } finally {
      if (config.autoSaveChats && this.currentChatId) {
        await this.persistCurrentChat(config);
      }
      this.busy = false;
      this.abortController = undefined;
      this.post({ type: 'busy', value: false });
    }
  }

  private async persistCurrentChat(config: NemotronAgentConfig): Promise<void> {
    if (!this.currentChatId) return;
    const existing = this.store.getChat(this.currentChatId);
    if (!existing) return;
    existing.messages = [...this.history];
    existing.updatedAt = Date.now();
    // Refresh title if it's still generic and we have user messages.
    if (existing.title === 'New chat') {
      const firstUser = this.history.find((m) => m.role === 'user')?.content;
      if (firstUser) existing.title = this.store.generateTitle(firstUser);
    }
    this.store.saveChat(existing);
  }

  private async runAgentLoop(apiKey: string, config: NemotronAgentConfig, signal: AbortSignal): Promise<void> {
    const model = new ModelClient({
      baseUrl: config.baseUrl,
      apiKey,
      model: config.model,
      maxTokens: config.maxTokens,
      reasoning: config.reasoning,
      persona: config.persona,
      memoryEnabled: config.memoryEnabled,
      onDelta: (text) => this.post({ type: 'delta', text }),
      onReasoningDelta: (text) => this.post({ type: 'reasoningDelta', text }),
    });

    const system = this.systemPrompt(config);

    for (let round = 0; round <= config.maxToolRounds; round++) {
      if (signal.aborted) throw new Error('The operation was aborted.');
      const messages: ChatMessage[] = [
        { role: 'system', content: system },
        ...this.history,
      ];
      this.post({ type: 'status', text: round === 0 ? 'Nemotron is thinking…' : 'Working with workspace tools…' });
      const response = await model.request(signal, messages, this.tools.toolDefinitions());

      const assistantMessage: ChatMessage = {
        role: 'assistant',
        content: response.content || null,
        ...(response.toolCalls.length ? { tool_calls: response.toolCalls } : {}),
      };
      this.history.push(assistantMessage);

      if (!response.toolCalls.length) {
        if (!response.content?.trim()) {
          this.post({ type: 'delta', text: 'I could not produce a visible answer. Please try again.' });
        }
        this.post({ type: 'assistantDone' });
        return;
      }

      if (round === config.maxToolRounds) {
        this.history.push({ role: 'assistant', content: `I reached the configured tool-call limit (${config.maxToolRounds}). Ask me to continue.` });
        this.post({ type: 'delta', text: `\n\nI reached the configured tool-call limit (${config.maxToolRounds}). Ask me to continue.` });
        this.post({ type: 'assistantDone' });
        return;
      }

      for (const toolCall of response.toolCalls) {
        if (signal.aborted) throw new Error('The operation was aborted.');
        const name = toolCall.function?.name;
        let args: unknown;
        try {
          args = JSON.parse(toolCall.function?.arguments || '{}');
        } catch {
          args = {};
        }
        this.post({ type: 'toolStart', name, args });
        let result: string;
        try {
          const toolResult: ToolResult = await this.executeTool(name, args);
          result = toolResult.content;
        } catch (error) {
          result = `Tool error: ${error instanceof Error ? error.message : String(error)}`;
        }
        this.history.push({ role: 'tool', tool_call_id: toolCall.id, content: result });
        this.post({ type: 'toolDone', name, result: result.slice(0, 1200) });
      }
    }
  }

  private systemPrompt(config: NemotronAgentConfig): string {
    const folders = vscode.workspace.workspaceFolders ?? [];
    const rootNames = folders.map((f) => f.name).join(', ');
    const personaLine = config.persona ? `Your persona: ${config.persona}.` : '';
    const memoryLine = config.memoryEnabled
      ? 'Use relevant facts from the chat memory below to personalize your answers.'
      : '';
    return `You are Nemotron Agent, a careful senior software engineer working inside Visual Studio Code. You are an autonomous coding assistant similar to Codex, but you must use the provided workspace tools for repository facts and changes.

WORKSPACE: ${rootNames}

${personaLine}
${memoryLine}

RULES:
- Inspect relevant files before proposing changes. Search before guessing.
- Make focused, complete changes that fit the existing architecture, naming, formatting, and dependencies.
- Never claim a change was made unless propose_file_edit completed successfully.
- Use propose_file_edit for every file creation or modification. It requires explicit user approval. Never attempt to modify files through terminal commands, scripts, or other indirect means.
- Use run_terminal_command only for necessary checks, builds, tests, lint, or type-check commands. It requires user approval. Never use terminal commands to install packages or edit, delete, overwrite, or move source files.
- Do not run destructive commands, install global packages, access secrets, or operate outside the opened workspace. If a task appears to need a destructive action, explain and ask first rather than issuing it.
- Read only the files needed for the task. Avoid dependency folders, generated output, secrets, and environment files.
- Prefer minimal diffs. Preserve unrelated user changes.
- After edits, run relevant tests/build/lint when appropriate and summarize exact files changed and checks performed.
- If requirements are unclear, ask one concise question; otherwise make a reasonable, clearly stated assumption.
- Be direct. Do not dump entire files into chat unless needed.`;
  }

  private async executeTool(name: string, args: unknown): Promise<ToolResult> {
    const toolArgs = args as Record<string, unknown>;
    switch (name) {
      case 'list_workspace_files':
        return this.tools.listFiles(toolArgs.glob as string | undefined, toolArgs.limit as number | undefined);
      case 'read_file':
        return this.tools.readFile(toolArgs.path as string);
      case 'get_active_editor_context':
        return this.tools.getActiveEditorContext();
      case 'search_workspace':
        return this.tools.searchWorkspace(toolArgs.query as string, toolArgs.glob as string | undefined, toolArgs.limit as number | undefined);
      case 'propose_file_edit':
        return this.tools.proposeFileEdit(toolArgs.path as string, toolArgs.content as string, toolArgs.summary as string);
      case 'run_terminal_command':
        return this.tools.runCommand(toolArgs.command as string, toolArgs.reason as string);
      default:
        return { content: `Unknown tool: ${name}`, isError: true };
    }
  }
}