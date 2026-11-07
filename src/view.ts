import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import * as path from 'node:path';
import { readFileSync } from 'node:fs';
import { API_KEY_SECRET, getNemotronAgentConfig } from './config';
import { AgentLoop } from './agent';
import { ToolRegistry } from './tools';
import type { AskApproval } from './tools';
import { ChatStore } from './storage';
import type { ApprovalPayload } from './config';
import { isWebviewMessage } from './protocol';
import type { PendingApproval, WebviewMessage } from './protocol';
import { AgentLogger } from './logger';
import {
  collectWorkspaceContext,
  normalizeContextOptions,
  contextSources,
} from './context';
import type { ContextOptions } from './context';

export class NemotronAgentView implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private agent?: AgentLoop;
  private tools?: ToolRegistry;
  private store?: ChatStore;
  private pending = new Map<string, PendingApproval>();
  private currentChatId: string | null = null;
  private readonly logger = new AgentLogger(vscode.window.createOutputChannel('Nemotron Agent'));

  constructor(private readonly context: vscode.ExtensionContext) {
    this.store = new ChatStore(context);
    context.subscriptions.push(this.logger);
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true };

    const askApproval: AskApproval = (payload, signal) => this.askApproval(payload, signal);

    this.tools = new ToolRegistry(askApproval, (progress) =>
      this.post({ type: 'editProgress', ...progress }), this.logger
    );
    this.agent = new AgentLoop(this.context, this.tools, (message) => this.post(message));

    // Attach the message listener before setting HTML so the initial `ready`
    // message cannot race the extension-host listener during webview startup.
    view.webview.onDidReceiveMessage(async (message: unknown) => {
      try {
        await this.handleMessage(message);
      } catch (error: unknown) {
        const detail = error instanceof Error ? error.message : String(error);
        this.post({ type: 'error', text: `Extension error: ${detail}` });
        void vscode.window.showErrorMessage(`Nemotron Agent: ${detail}`);
      }
    });

    view.webview.html = this.getHtml();
  }

  private post(message: unknown): void {
    void this.view?.webview.postMessage(message);
  }

  resetConversation(): void {
    this.agent?.resetConversation();
    this.currentChatId = null;
  }

  private async handleMessage(rawMessage: unknown): Promise<void> {
    if (!isWebviewMessage(rawMessage)) return;
    const message: WebviewMessage = rawMessage;
    switch (message.type) {
      case 'clientError': {
        const detail = String(message.text || 'Unknown webview error');
        void vscode.window.showErrorMessage(`Nemotron Agent UI error: ${detail}`);
        break;
      }
      case 'ready': {
        const apiKey = await this.context.secrets.get(API_KEY_SECRET);
        const config = getNemotronAgentConfig();
        const chats = this.store ? this.store.listChats() : [];
        this.post({
          type: 'ready',
          hasKey: !!apiKey,
          config: {
            reasoning: config.reasoning,
            persona: config.persona,
            memoryEnabled: config.memoryEnabled,
            autoSaveChats: config.autoSaveChats,
            model: config.model,
            baseUrl: config.baseUrl,
            maxTokens: config.maxTokens,
            maxToolRounds: config.maxToolRounds,
            tone: vscode.workspace.getConfiguration('nemotronAgent').get<string>('tone', ''),
            expertise: config.expertise,
            responseLanguage: config.responseLanguage,
            codeStyle: config.codeStyle,
          },
          chats,
          contextSources: contextSources.all().map(({ id, label }) => ({ id, label })),
        });
        const restoreId = typeof message.chatId === 'string' ? message.chatId : '';
        if (restoreId && this.agent?.currentChat === restoreId) {
          this.post({ type: 'chatLoaded', id: restoreId, messages: this.agent?.currentMessages ?? [], busy: this.agent?.isBusy === true, waitingForApproval: this.pending.size > 0 });
        } else if (restoreId && this.store?.getChat(restoreId)) {
          await this.agent?.loadChat(restoreId);
        }
        if (!restoreId && this.agent?.isBusy) {
          this.post({ type: 'chatLoaded', id: null, messages: this.agent?.currentMessages ?? [], busy: true, waitingForApproval: this.pending.size > 0 });
        }
        for (const pending of this.pending.values()) {
          this.post({ type: 'approval', ...pending.payload });
        }
        break;
      }
      case 'previewContext': {
        const options = normalizeContextOptions(message.contextOptions);
        try {
          const snapshot = await collectWorkspaceContext(options);
          const details = [
            ...(snapshot.activeEditor ? [snapshot.activeEditor.split('\\n')[0]] : []),
            ...(snapshot.selectedCode
              ? [snapshot.selectedCode.split('\\n')[0] + ' · selected range']
              : []),
            ...snapshot.included.filter((item) => item.startsWith('Problems')),
            ...snapshot.unavailable,
          ];
          this.post({
            type: 'contextPreview',
            included: snapshot.included,
            unavailable: snapshot.unavailable,
            details,
          });
        } catch (error: unknown) {
          this.post({
            type: 'contextPreview',
            included: [],
            unavailable: [
              `Context preview unavailable: ${error instanceof Error ? error.message : String(error)}`,
            ],
            details: [],
          });
        }
        break;
      }
      case 'send': {
        if (typeof message.text === 'string') {
          const apiKey = await this.context.secrets.get(API_KEY_SECRET);
          if (!apiKey) {
            this.post({ type: 'status', text: 'NVIDIA API key required' });
            this.post({
              type: 'error',
              text: 'NVIDIA API key is not configured. Open Settings to add it, then send your request again.',
            });
            await vscode.commands.executeCommand('nemotronAgent.setApiKey');
            const configuredKey = await this.context.secrets.get(API_KEY_SECRET);
            this.post({
              type: 'keyState',
              hasKey: !!configuredKey,
              text: configuredKey
                ? 'NVIDIA API key is configured.'
                : 'NVIDIA API key is not configured.',
            });
            return;
          }
          const config = getNemotronAgentConfig();
          const contextOptions: ContextOptions = normalizeContextOptions(message.contextOptions);
          await this.agent?.handleUserMessage(
            message.text,
            apiKey,
            config,
            contextOptions
          );
          this.currentChatId = this.agent?.currentChat ?? null;
          this.post({ type: 'chatsUpdated', chats: this.store ? this.store.listChats() : [] });
        }
        break;
      }
      case 'approve': {
        this.resolveApproval(String(message.id), true);
        break;
      }
      case 'reject': {
        this.resolveApproval(String(message.id), false);
        break;
      }
      case 'newChat': {
        await this.agent?.createNewChat();
        this.currentChatId = null;
        this.post({ type: 'reset' });
        break;
      }
      case 'stop': {
        this.agent?.stopRequest();
        break;
      }
      case 'setKey': {
        await vscode.commands.executeCommand('nemotronAgent.setApiKey');
        const apiKey = await this.context.secrets.get(API_KEY_SECRET);
        this.post({
          type: 'keyState',
          hasKey: !!apiKey,
          text: apiKey ? 'NVIDIA API key is configured.' : 'API key not configured.',
        });
        break;
      }
      case 'clearKey': {
        await vscode.commands.executeCommand('nemotronAgent.clearApiKey');
        this.post({ type: 'keyState', hasKey: false, text: 'NVIDIA API key removed.' });
        break;
      }
      case 'loadChat': {
        const id = String(message.id);
        const ok = await this.agent?.loadChat(id);
        if (ok) {
          this.currentChatId = id;
        }
        break;
      }
      case 'deleteChat': {
        const id = String(message.id);
        const wasActive = this.currentChatId === id;
        if (this.store) this.store.deleteChat(id);
        if (wasActive) {
          this.currentChatId = null;
          this.agent?.resetConversation();
          this.post({ type: 'reset' });
        }
        this.post({ type: 'chatsUpdated', chats: this.store ? this.store.listChats() : [] });
        break;
      }
      case 'setPerson': {
        const { persona, tone, expertise, responseLanguage, codeStyle } = message;
        const cfg = vscode.workspace.getConfiguration('nemotronAgent');
        if (typeof persona === 'string') await cfg.update('persona', persona, true);
        if (typeof tone === 'string') await cfg.update('tone', tone, true);
        if (Array.isArray(expertise)) {
          const safeExpertise = expertise.filter((item): item is string => typeof item === 'string').slice(0, 20);
          await cfg.update('expertise', safeExpertise, true);
        }
        if (typeof responseLanguage === 'string') await cfg.update('responseLanguage', responseLanguage, true);
        if (typeof codeStyle === 'string') await cfg.update('codeStyle', codeStyle, true);
        const config = getNemotronAgentConfig();
        this.post({
          type: 'configUpdated',
          config: {
            persona: config.persona,
            memoryEnabled: config.memoryEnabled,
            tone: vscode.workspace.getConfiguration('nemotronAgent').get<string>('tone', ''),
            expertise: config.expertise,
            responseLanguage: config.responseLanguage,
            codeStyle: config.codeStyle,
          },
        });
        break;
      }
      case 'saveSettings': {
        const cfg = vscode.workspace.getConfiguration('nemotronAgent');
        if (typeof message.model === 'string') await cfg.update('model', message.model, true);
        if (typeof message.baseUrl === 'string') await cfg.update('baseUrl', message.baseUrl, true);
        if (typeof message.maxTokens === 'number')
          await cfg.update('maxTokens', message.maxTokens, true);
        if (typeof message.maxToolRounds === 'number')
          await cfg.update('maxToolRounds', message.maxToolRounds, true);
        if (typeof message.autoSaveChats === 'boolean')
          await cfg.update('autoSaveChats', message.autoSaveChats, true);
        const config = getNemotronAgentConfig();
        this.post({
          type: 'configUpdated',
          config: {
            model: config.model,
            baseUrl: config.baseUrl,
            maxTokens: config.maxTokens,
            maxToolRounds: config.maxToolRounds,
            autoSaveChats: config.autoSaveChats,
          },
        });
        break;
      }
      case 'renameChat': {
        const id = String(message.id);
        const title = String(message.title || '').trim();
        if (!title || !this.store) break;
        const chat = this.store.getChat(id);
        if (!chat) break;
        chat.title = title;
        chat.updatedAt = Date.now();
        this.store.saveChat(chat);
        this.post({ type: 'chatsUpdated', chats: this.store.listChats() });
        break;
      }
      case 'toggleMemory': {
        const cfg = vscode.workspace.getConfiguration('nemotronAgent');
        await cfg.update('memoryEnabled', !!message.enabled, true);
        break;
      }
      case 'toggleReasoning': {
        const cfg = vscode.workspace.getConfiguration('nemotronAgent');
        await cfg.update('reasoning', !!message.enabled, true);
        const config = getNemotronAgentConfig();
        this.post({ type: 'configUpdated', config: { reasoning: config.reasoning } });
        break;
      }
    }
  }

  private askApproval(payload: ApprovalPayload, signal?: AbortSignal): Promise<boolean> {
    return new Promise((resolve) => {
      if (signal?.aborted) { resolve(false); return; }
      const timeout = setTimeout(() => {
        const pending = this.pending.get(payload.id);
        if (pending?.onAbort && pending.signal) pending.signal.removeEventListener('abort', pending.onAbort);
        this.pending.delete(payload.id);
        resolve(false);
        this.post({ type: 'approvalExpired', id: payload.id });
      }, 5 * 60_000);
      const onAbort = () => {
        clearTimeout(timeout);
        this.pending.delete(payload.id);
        this.post({ type: 'approvalCancelled', id: payload.id });
        resolve(false);
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.pending.set(payload.id, { resolve, timeout, payload, signal, onAbort });
      this.post({ type: 'approval', ...payload });
    });
  }

  private resolveApproval(id: string, approved: boolean): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    clearTimeout(pending.timeout);
    if (pending.onAbort && pending.signal) pending.signal.removeEventListener('abort', pending.onAbort);
    this.pending.delete(id);
    pending.resolve(approved);
    this.post({ type: 'approvalResolved', id, approved });
  }

  private getHtml(): string {
    const nonce = randomBytes(18).toString('base64');
    const csp = `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';`;
    // String.raw is required: this HTML contains an embedded JavaScript program with regex
    // escapes; a normal template literal would consume backslashes and break the webview.
    return readFileSync(path.join(__dirname, 'resources', 'webview.html'), 'utf8')
      .replace('{{CSP}}', csp)
      .replaceAll('{{NONCE}}', nonce);
  }
}
