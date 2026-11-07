import * as vscode from 'vscode';
import * as path from 'node:path';
import { readFileSync } from 'node:fs';
import type { ChatMessage, NemotronAgentConfig } from './config';
import type { ToolRegistry, ToolResult } from './tools';
import { ModelClient } from './model';
import { ChatStore } from './storage';
import { ChatManager } from './chatManager';
import { ToolDispatcher } from './toolDispatcher';
import { ContextCollector } from './contextCollector';
import { parseToolArguments } from './toolValidation';
import { renderPromptTemplate } from './promptTemplate';
import type { ContextOptions, WorkspaceContext } from './context';

export class AgentLoop {
  private history: ChatMessage[] = [];
  private busy = false;
  private abortController?: AbortController;
  private currentChatId: string | null = null;
  private readonly chats: ChatManager;
  private readonly tools: ToolRegistry;
  private readonly dispatcher: ToolDispatcher;
  private readonly contextCollector = new ContextCollector();

  constructor(
    context: vscode.ExtensionContext,
    tools: ToolRegistry,
    private readonly post: (message: unknown) => void
  ) {
    this.chats = new ChatManager(new ChatStore(context));
    this.tools = tools;
    this.dispatcher = new ToolDispatcher(tools);
  }

  get isBusy(): boolean {
    return this.busy;
  }

  get currentChat(): string | null {
    return this.currentChatId;
  }

  get currentMessages(): ChatMessage[] {
    return [...this.history];
  }

  resetConversation(): void {
    this.stopRequest();
    this.history = [];
    this.currentChatId = null;
    this.post({ type: 'reset' });
  }

  stopRequest(): void {
    if (!this.abortController) {
      this.busy = false;
      this.post({ type: 'busy', value: false });
      return;
    }
    this.post({ type: 'status', text: 'Stopping request…' });
    this.abortController.abort();
    // Keep the loop busy until its finally block completes so a new request
    // cannot overlap with still-unwinding tool or model operations.
  }

  async loadChat(id: string): Promise<boolean> {
    const chat = this.chats.load(id);
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

  async handleUserMessage(
    text: string,
    apiKey: string,
    config: NemotronAgentConfig,
    contextOptions?: ContextOptions
  ): Promise<void> {
    const prompt = text.trim();
    if (!prompt || this.busy) return;
    if (!vscode.workspace.workspaceFolders?.length) {
      this.post({ type: 'status', text: 'No workspace is open' });
      this.post({
        type: 'error',
        text: 'Open a project folder in VS Code before using the coding agent.',
      });
      return;
    }

    // Ensure we have a chat to persist into.
    if (!this.currentChatId && config.autoSaveChats) {
      const chat = this.chats.create(prompt);
      this.currentChatId = chat.id;
      this.chats.save(chat);
      this.post({ type: 'chatCreated', id: this.currentChatId, title: chat.title });
    }

    this.busy = true;
    const controller = new AbortController();
    this.abortController = controller;
    this.history.push({ role: 'user', content: prompt });
    if (config.autoSaveChats && this.currentChatId) this.persistCurrentChat();
    this.post({ type: 'userMessage', text: prompt });
    this.post({ type: 'assistantStart' });
    this.post({ type: 'busy', value: true });
    this.post({ type: 'status', text: 'Thinking…' });

    try {
      const workspaceContext = await this.contextCollector.capture(contextOptions);
      await this.runAgentLoop(apiKey, config, controller.signal, workspaceContext);
    } catch (error: unknown) {
      const err = error instanceof Error ? error.message : String(error);
      const aborted =
        controller.signal.aborted || (error instanceof Error && error.name === 'AbortError');
      if (!aborted) {
        this.post({ type: 'error', text: err });
      } else {
        this.post({ type: 'status', text: 'Stopped.' });
        this.post({ type: 'assistantStopped' });
      }
    } finally {
      if (config.autoSaveChats && this.currentChatId) {
        this.persistCurrentChat();
      }
      this.busy = false;
      this.abortController = undefined;
      this.post({ type: 'busy', value: false });
    }
  }


  private persistCurrentChat(): void {
    if (!this.currentChatId) return;
    const existing = this.chats.load(this.currentChatId);
    if (!existing) return;
    this.chats.save(this.chats.snapshot(existing, this.history));
  }

  private async runAgentLoop(
    apiKey: string,
    config: NemotronAgentConfig,
    signal: AbortSignal,
    workspaceContext?: WorkspaceContext
  ): Promise<void> {
    const model = new ModelClient({
      baseUrl: config.baseUrl,
      apiKey,
      model: config.model,
      maxTokens: config.maxTokens,
      reasoning: config.reasoning,
      onDelta: (text) => this.post({ type: 'delta', text }),
      onReasoningDelta: (text) => this.post({ type: 'reasoningDelta', text }),
    });

    const system = this.systemPrompt(config);
    const contextBlock = workspaceContext ? this.contextCollector.format(workspaceContext) : '';
    const seenCalls = new Map<string, string>();
    // The hard budget counts completed operations, not malformed arguments or
    // patch-anchor mismatches. A separate consecutive-failure guard prevents
    // endless model retries without penalizing successful work.
    let successfulToolCalls = 0;
    let consecutiveToolFailures = 0;
    let consecutiveFileEditFailures = 0;
    const HARD_TOOL_CALL_LIMIT = 24;
    const MAX_CONSECUTIVE_TOOL_FAILURES = 8;
    const MAX_FAILED_FILE_EDIT_ATTEMPTS = 8;
    const fileReadEpoch = new Map<string, number>();
    let hardLimitReached = false;
    let failureStreakReached = false;

    let appliedFileEdit = false;
    let productiveToolRounds = 0;
    const MAX_EXTRA_RECOVERY_TURNS = MAX_FAILED_FILE_EDIT_ATTEMPTS + MAX_CONSECUTIVE_TOOL_FAILURES;
    for (let round = 0; round < config.maxToolRounds + MAX_EXTRA_RECOVERY_TURNS + 1; round++) {
      if (signal.aborted) throw new Error('The operation was aborted.');
      const successfulCallsAtRoundStart = successfulToolCalls;
      const requestHistory = [...this.history];
      if (contextBlock) {
        const lastUser = requestHistory.map((message, index) => ({ message, index }))
          .reverse().find(({ message }) => message.role === 'user');
        if (lastUser) requestHistory[lastUser.index] = {
          ...lastUser.message,
          content: `${lastUser.message.content || ''}\n\n${contextBlock}`,
        };
      }
      const messages: ChatMessage[] = [{ role: 'system', content: system }, ...requestHistory];
      this.post({
        type: 'status',
        text: appliedFileEdit
          ? 'File saved · Nemotron is reviewing the changes…'
          : round === 0
            ? 'Nemotron is thinking…'
            : 'Working with workspace tools…',
      });
      if (round > 0) this.post({ type: 'assistantResume' });
      appliedFileEdit = false;
      const response = await model.request(signal, messages, this.tools.toolDefinitions());

      const assistantMessage: ChatMessage = {
        role: 'assistant',
        content: response.content || null,
        ...(response.toolCalls.length ? { tool_calls: response.toolCalls } : {}),
      };
      this.history.push(assistantMessage);
      this.persistCurrentChat();

      if (!response.toolCalls.length) {
        if (!response.content?.trim()) {
          this.post({
            type: 'delta',
            text: 'I could not produce a visible answer. Please try again.',
          });
        }
        this.post({ type: 'assistantDone' });
        return;
      }

      if (productiveToolRounds >= config.maxToolRounds) {
        for (const toolCall of response.toolCalls) {
          this.history.push({ role: 'tool', tool_call_id: toolCall.id, content: `Tool-round limit reached (${config.maxToolRounds}); this tool was not executed.` });
        }
        const notice = `I reached the configured tool-round limit (${config.maxToolRounds}). Ask me to continue.`;
        this.history.push({ role: 'assistant', content: notice });
        this.persistCurrentChat();
        this.post({ type: 'delta', text: `\n\n${notice}` });
        this.post({ type: 'assistantDone' });
        return;
      }

      for (const toolCall of response.toolCalls) {
        if (signal.aborted) throw new Error('The operation was aborted.');
        if (failureStreakReached) {
          const result = `Not executed: stopped after ${MAX_CONSECUTIVE_TOOL_FAILURES} consecutive tool failures or ${MAX_FAILED_FILE_EDIT_ATTEMPTS} failed file-edit attempts. Correct the latest reported issue before requesting another operation.`;
          this.history.push({ role: 'tool', tool_call_id: toolCall.id, content: result });
          this.persistCurrentChat();
          this.post({ type: 'toolDone', id: toolCall.id, name: toolCall.function?.name || 'unknown', status: 'failed', result });
          continue;
        }
        if (successfulToolCalls >= HARD_TOOL_CALL_LIMIT) {
          hardLimitReached = true;
          const result = `Successful-operation limit reached (${HARD_TOOL_CALL_LIMIT}). No further tools were executed. Ask the user to continue in a new request.`;
          this.history.push({ role: 'tool', tool_call_id: toolCall.id, content: result });
          this.persistCurrentChat();
          this.post({ type: 'toolDone', id: toolCall.id, name: toolCall.function?.name || 'unknown', result });
          continue;
        }
        const name = toolCall.function.name || '';
        let args: unknown;
        try {
          if (typeof toolCall.function?.arguments !== 'string') throw new Error('Tool arguments must be a JSON string.');
          args = parseToolArguments(toolCall.function.arguments);
        } catch (error: unknown) {
          const result = `Invalid tool arguments: ${error instanceof Error ? error.message : String(error)}. The operation was not executed.`;
          this.history.push({ role: 'tool', tool_call_id: toolCall.id, content: result });
          this.persistCurrentChat();
          this.post({ type: 'toolDone', id: toolCall.id, name: name || 'unknown', status: 'invalid', result });
          consecutiveToolFailures++;
          if (name === 'propose_file_edit') consecutiveFileEditFailures++;
          if (consecutiveToolFailures >= MAX_CONSECUTIVE_TOOL_FAILURES ||
              consecutiveFileEditFailures >= MAX_FAILED_FILE_EDIT_ATTEMPTS) failureStreakReached = true;
          continue;
        }
        const editPath = name === 'propose_file_edit' && args && typeof args === 'object' &&
          typeof (args as Record<string, unknown>).path === 'string'
          ? ((args as Record<string, unknown>).path as string).replace(/\\/g, '/')
          : '';
        // A fresh read of the target file changes the evidence state for an edit.
        // The same patch may then be retried against that new snapshot.
        const snapshotEpoch = editPath ? (fileReadEpoch.get(editPath) ?? 0) : 0;
        const signature = `${name}:${stableSerialize(args)}${editPath ? `:snapshot=${snapshotEpoch}` : ''}`;
        const previous = seenCalls.get(signature);
        if (previous !== undefined) {
          const result = `Duplicate tool call blocked. This exact operation was already attempted in this request. Previous outcome: ${previous}`;
          this.history.push({ role: 'tool', tool_call_id: toolCall.id, content: result });
          this.persistCurrentChat();
          this.post({ type: 'toolDone', id: toolCall.id, name, status: 'invalid', result: result.slice(0, 1200) });
          consecutiveToolFailures++;
          if (name === 'propose_file_edit') consecutiveFileEditFailures++;
          if (consecutiveToolFailures >= MAX_CONSECUTIVE_TOOL_FAILURES ||
              consecutiveFileEditFailures >= MAX_FAILED_FILE_EDIT_ATTEMPTS) failureStreakReached = true;
          continue;
        }
        this.post({ type: 'toolStart', id: toolCall.id, name, args });
        let result: string;
        let resultStatus: ToolResult['status'] = 'failed';
        try {
          const toolResult: ToolResult = await this.dispatcher.dispatch(name, args, signal);
          if (signal.aborted) throw new Error('Request cancelled; no subsequent tools will be executed.');
          result = toolResult.content;
          resultStatus = toolResult.status ?? (toolResult.isError ? 'failed' : 'success');
          seenCalls.set(signature, result.slice(0, 1000));
          if (name === 'propose_file_edit' && !toolResult.isError && /successfully (applied|created)/i.test(result)) {
            appliedFileEdit = true;
            seenCalls.clear(); // Workspace state changed; future calls must be reevaluated.
            this.post({ type: 'status', text: 'Changes saved · checking the updated code…' });
          }
          else if (name === 'run_terminal_command' && result.startsWith('Command execution result: SUCCESS')) {
            seenCalls.clear(); // An approved command may have changed generated or workspace state.
          }
        } catch (error: unknown) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          result = `Tool error: ${errorMessage}`;
          resultStatus = signal.aborted ? 'cancelled'
            : /Unsupported tool name|arguments must|argument .* (invalid|exceeds)|Missing or invalid|required argument|Provide exactly one/i.test(errorMessage) ? 'invalid'
            : /changed while approval|stale|became dirty|changed on disk/i.test(errorMessage) ? 'stale'
            : /not supported|unsupported/i.test(errorMessage) ? 'unsupported'
            : 'failed';
          seenCalls.set(signature, result.slice(0, 1000));
        }
        if (resultStatus === 'success') {
          successfulToolCalls++;
          consecutiveToolFailures = 0;
          if (name === 'read_file') {
            const readPath = args && typeof args === 'object' && typeof (args as Record<string, unknown>).path === 'string'
              ? ((args as Record<string, unknown>).path as string).replace(/\\/g, '/')
              : '';
            if (readPath) fileReadEpoch.set(readPath, (fileReadEpoch.get(readPath) ?? 0) + 1);
          }
          if (name === 'propose_file_edit') consecutiveFileEditFailures = 0;
        } else {
          consecutiveToolFailures++;
          if (name === 'propose_file_edit') consecutiveFileEditFailures++;
          if (consecutiveToolFailures >= MAX_CONSECUTIVE_TOOL_FAILURES ||
              consecutiveFileEditFailures >= MAX_FAILED_FILE_EDIT_ATTEMPTS) failureStreakReached = true;
        }
        this.history.push({ role: 'tool', tool_call_id: toolCall.id, content: result });
        this.persistCurrentChat();
        this.post({ type: 'toolDone', id: toolCall.id, name, status: resultStatus, result: result.slice(0, 1200) });
      }
      if (successfulToolCalls > successfulCallsAtRoundStart) {
        productiveToolRounds++;
      }
      if (hardLimitReached || failureStreakReached) {
        const notice = hardLimitReached
          ? `I stopped tool execution after ${HARD_TOOL_CALL_LIMIT} successful operations. Failed validation and patch attempts do not consume this budget. The conversation is preserved; ask me to continue.`
          : `I stopped after ${MAX_CONSECUTIVE_TOOL_FAILURES} consecutive tool failures or ${MAX_FAILED_FILE_EDIT_ATTEMPTS} failed file-edit attempts to prevent repeated retries. The conversation is preserved. Review the latest tool error, then ask me to continue.`;

        this.history.push({ role: 'assistant', content: notice });
        this.persistCurrentChat();
        this.post({ type: 'delta', text: `\n\n${notice}` });
        this.post({ type: 'assistantDone' });
        return;
      }
    }
    const notice = 'I stopped because the maximum recovery-turn budget was reached. The conversation and completed tool results are preserved; ask me to continue.';
    this.history.push({ role: 'assistant', content: notice });
    this.persistCurrentChat();
    this.post({ type: 'delta', text: `\n\n${notice}` });
    this.post({ type: 'assistantDone' });
  }

  private systemPrompt(config: NemotronAgentConfig): string {
    const folders = vscode.workspace.workspaceFolders ?? [];
    const rootNames = folders.map((f) => f.name).filter(Boolean).join(', ') || 'No workspace folder name available';
    const personaLine = config.persona?.trim() ? config.persona.trim() : 'helpful coding assistant';
    const memoryLine = config.memoryEnabled
      ? 'Memory setting is enabled. Use only memory facts actually present in conversation history; no separate memory facts are injected by this extension.'
      : 'Memory is disabled. Do not infer or retain personal facts beyond the current conversation.';
    const template = readFileSync(path.join(__dirname, 'resources', 'system-prompt.md'), 'utf8');
    return renderPromptTemplate(template, {
      WORKSPACE_NAME: rootNames,
      PERSONA: personaLine,
      TONE: config.tone?.trim() || 'balanced and natural',
      EXPERTISE: config.expertise?.length ? config.expertise.join(', ') : 'general software development',
      LANGUAGE: config.responseLanguage === 'auto' ? 'match the user’s language' : config.responseLanguage,
      CODE_STYLE: config.codeStyle || 'follow project conventions',
      MEMORY: memoryLine,
    });
  }


}

function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableSerialize(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? String(value);
}
