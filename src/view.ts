import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import {
  API_KEY_SECRET,
  getNemotronAgentConfig,
} from './config';
import { AgentLoop } from './agent';
import { ToolRegistry, AskApproval } from './tools';
import { ChatStore } from './storage';

export class NemotronAgentView implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private agent?: AgentLoop;
  private tools?: ToolRegistry;
  private store?: ChatStore;
  private pending = new Map<string, { resolve: (approved: boolean) => void; timeout: NodeJS.Timeout }>;
  private currentChatId: string | null = null;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.store = new ChatStore(context);
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true };

    const askApproval: AskApproval = (payload) => this.askApproval(payload);

    this.tools = new ToolRegistry(this.context, askApproval, (progress) => this.post({ type: 'editProgress', ...progress }));
    this.agent = new AgentLoop(this.context, this.tools, (message) => this.post(message));

    // Attach the message listener before setting HTML so the initial `ready`
    // message cannot race the extension-host listener during webview startup.
    view.webview.onDidReceiveMessage(async (message) => {
      try {
        await this.handleMessage(message);
      } catch (error) {
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

  private async handleMessage(message: any): Promise<void> {
    switch (message?.type) {
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
            expertise: vscode.workspace.getConfiguration('nemotronAgent').get<string[]>('expertise', []),
          },
          chats,
        });
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
            this.post({ type: 'keyState', hasKey: !!configuredKey, text: configuredKey ? 'NVIDIA API key is configured.' : 'NVIDIA API key is not configured.' });
            return;
          }
          const config = getNemotronAgentConfig();
          await this.agent?.handleUserMessage(message.text, apiKey, config);
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
        if (this.store) this.store.deleteChat(id);
        if (this.currentChatId === id) {
          this.currentChatId = null;
          this.agent?.resetConversation();
        }
        const config = getNemotronAgentConfig();
        const apiKey = await this.context.secrets.get(API_KEY_SECRET);
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
            expertise: vscode.workspace.getConfiguration('nemotronAgent').get<string[]>('expertise', []),
          },
          chats: this.store ? this.store.listChats() : [],
        });
        break;
      }
      case 'setPerson': {
        const { persona, tone, expertise } = message;
        const cfg = vscode.workspace.getConfiguration('nemotronAgent');
        if (typeof persona === 'string') await cfg.update('persona', persona, true);
        if (typeof tone === 'string') await cfg.update('tone', tone, true);
        if (Array.isArray(expertise)) await cfg.update('expertise', expertise, true);
        const config = getNemotronAgentConfig();
        this.post({ type: 'configUpdated', config: { persona: config.persona, memoryEnabled: config.memoryEnabled, tone: vscode.workspace.getConfiguration('nemotronAgent').get<string>('tone', ''), expertise: vscode.workspace.getConfiguration('nemotronAgent').get<string[]>('expertise', []) } });
        break;
      }
      case 'saveSettings': {
        const cfg = vscode.workspace.getConfiguration('nemotronAgent');
        if (typeof message.model === 'string') await cfg.update('model', message.model, true);
        if (typeof message.baseUrl === 'string') await cfg.update('baseUrl', message.baseUrl, true);
        if (typeof message.maxTokens === 'number') await cfg.update('maxTokens', message.maxTokens, true);
        if (typeof message.maxToolRounds === 'number') await cfg.update('maxToolRounds', message.maxToolRounds, true);
        if (typeof message.autoSaveChats === 'boolean') await cfg.update('autoSaveChats', message.autoSaveChats, true);
        const config = getNemotronAgentConfig();
        this.post({ type: 'configUpdated', config: { model: config.model, baseUrl: config.baseUrl, maxTokens: config.maxTokens, maxToolRounds: config.maxToolRounds, autoSaveChats: config.autoSaveChats } });
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

  private getHtml(): string {
    const nonce = randomBytes(18).toString('base64');
    const csp = `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';`;
    // String.raw is required: this HTML contains an embedded JavaScript program with regex
    // escapes; a normal template literal would consume backslashes and break the webview.
    return String.raw`<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><meta http-equiv="Content-Security-Policy" content="${csp}"><title>Nemotron Agent</title>
<style>
:root{color-scheme:light dark;--bg:var(--vscode-sideBar-background);--fg:var(--vscode-foreground);--muted:var(--vscode-descriptionForeground);--border:var(--vscode-panel-border);--card:var(--vscode-editorWidget-background);--accent:var(--vscode-button-background);--accentFg:var(--vscode-button-foreground);--input:var(--vscode-input-background);--sidebar:var(--vscode-sideBar-background);--hover:var(--vscode-list-hoverBackground);--active:var(--vscode-list-activeSelectionBackground);--activeFg:var(--vscode-list-activeSelectionForeground);--warning:var(--vscode-editorWarning-foreground);--error:var(--vscode-errorForeground)}*{box-sizing:border-box}body{margin:0;padding:0;background:var(--bg);color:var(--fg);font:13px var(--vscode-font-family);height:100vh;display:flex;flex-direction:column}button{font:inherit;cursor:pointer;border:1px solid var(--border);background:transparent;color:var(--fg);border-radius:6px;padding:6px 10px}button:hover{background:var(--hover)}button.primary{background:var(--accent);color:var(--accentFg);border-color:transparent}button:disabled{opacity:.5;cursor:not-allowed}button.icon{width:32px;height:32px;padding:0;display:inline-flex;align-items:center;justify-content:center;border-radius:8px}button.icon:hover{background:var(--hover)}button.toggle{background:var(--input);border-color:var(--border)}button.toggle.on{background:var(--accent);color:var(--accentFg);border-color:transparent}hr{ border:none;border-top:1px solid var(--border);margin:6px 0}

/* Layout shell */
.shell{display:flex;height:100vh;overflow:hidden}aside.sidebar{width:260px;background:var(--sidebar);border-right:1px solid var(--border);display:flex;flex-direction:column;flex-shrink:0}main.panel{flex:1;display:flex;flex-direction:column;min-width:0}

/* Header */
.top{height:44px;display:flex;align-items:center;justify-content:space-between;padding:0 12px;border-bottom:1px solid var(--border);flex-shrink:0} .top .brand{font-weight:650;letter-spacing:.1px} .top .sub{font-size:11px;color:var(--muted)} .top .controls{display:flex;gap:5px} input.search{width:100%;background:var(--input);border:1px solid var(--border);color:var(--fg);border-radius:6px;padding:6px 10px;font:inherit;margin-top:4px}

/* Chat list */
.list{flex:1;overflow:auto;padding:8px 4px;display:flex;flex-direction:column;gap:4px} .list h3{font-size:11px;color:var(--muted);margin:8px 10px 4px;text-transform:uppercase;letter-spacing:.6px} .chatItem{display:flex;align-items:center;justify-content:space-between;padding:8px 10px;border-radius:8px;cursor:pointer;border:1px solid transparent;background:transparent} .chatItem:hover{background:var(--hover)} .chatItem.active{background:var(--active);color:var(--activeFg);border-color:var(--border)} .chatItem .meta{flex:1;overflow:hidden} .chatItem .title{font-size:12.5px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis} .chatItem .sub{font-size:10px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis} .chatItem .actions{opacity:0;display:flex;gap:4px} .chatItem:hover .actions,.chatItem.active .actions{opacity:1} .chatItem .actions button{padding:4px 6px;font-size:11px} .empty{padding:16px;text-align:center;color:var(--muted);font-size:12px}

/* Feed */
.feed{flex:1;overflow:auto;padding:12px;display:flex;flex-direction:column;gap:12px;min-height:0} .welcome{margin:auto 0;text-align:center;color:var(--muted);padding:16px 6px} .welcome h2{font-size:16px;color:var(--fg);margin-bottom:6px} .welcome p{line-height:1.5} .suggestions{display:flex;flex-wrap:wrap;gap:6px;justify-content:center;margin-top:12px} .suggestions button{font-size:11px} .message{max-width:100%;line-height:1.55;overflow-wrap:anywhere} .message.user{background:var(--vscode-textBlockQuote-background);border:1px solid var(--border);padding:9px 10px;border-radius:9px;align-self:flex-end;max-width:94%;white-space:pre-wrap} .message.assistant{white-space:normal} .message.assistant .content{white-space:pre-wrap} .message .label{font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.6px;margin-bottom:4px} .message pre{white-space:pre-wrap;overflow:auto;background:var(--vscode-textCodeBlock-background);padding:9px;border-radius:6px} .expandable .args{color:var(--muted);white-space:nowrap;font-size:10px;margin:4px 0;display:inline} .expandable summary{color:var(--muted);cursor:pointer;padding:5px 8px;font-size:11px;list-style:none;background:transparent;border-bottom:1px solid var(--border);user-select:none} .expandable summary:hover{background:var(--vscode-toolbar-hoverBackground)} .expandable[open] summary{border-bottom:1px solid transparent;border-radius:6px 6px 0 0;margin-bottom:-1px} .expandable[open] pre{white-space:pre-wrap;background:var(--vscode-textCodeBlock-background);padding:8px;margin:0;font-size:10px;overflow:auto;border-top:1px solid var(--border)} .expandable .result{color:var(--muted);white-space:pre-wrap;margin-top:4px;font-size:10px;max-height:240px;overflow:auto} .expandable .done{color:var(--vscode-descriptionForeground);margin-left:6px;font-size:10px} .approval{border:1px solid var(--warning);border-radius:8px;padding:10px;background:var(--card);display:flex;flex-direction:column;gap:8px} .approval h4{margin:0;font-size:13px} .approval .desc{color:var(--muted)} .preview{display:grid;grid-template-columns:1fr 1fr;gap:6px} .preview pre{margin:0;max-height:180px;font-size:10px;white-space:pre-wrap;overflow:auto;padding:7px;background:var(--vscode-textCodeBlock-background);border-radius:5px} .approval .actions{display:flex;gap:7px;justify-content:flex-end} .approval .danger{border-color:var(--error);color:var(--error)} .composer{border-top:1px solid var(--border);padding:9px;display:flex;flex-direction:column;gap:7px;flex-shrink:0} .textareaWrap{border:1px solid var(--vscode-input-border,var(--border));background:var(--input);border-radius:8px;padding:7px} .textareaWrap:focus-within{border-color:var(--vscode-focusBorder)} textarea{width:100%;resize:vertical;min-height:66px;max-height:180px;background:transparent;border:0;outline:0;color:var(--fg);font:inherit} .composerFoot{display:flex;align-items:center;justify-content:space-between} .status{font-size:10px;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap} .actions{display:flex;gap:6px} .key{font-size:11px;color:var(--muted)} .send{min-width:62px} .hidden{display:none!important} a{color:var(--vscode-textLink-foreground)} .fatalError{margin:8px;padding:10px;border:1px solid var(--vscode-errorForeground);border-radius:7px;background:var(--vscode-inputValidation-errorBackground);color:var(--vscode-errorForeground);font-size:12px;white-space:pre-wrap;overflow-wrap:anywhere}

/* Memory & reasoning chips */
.chip{font-size:10px;padding:2px 8px;border-radius:10px;border:1px solid var(--border);background:var(--input);color:var(--muted)} .chip.on{background:var(--accent);color:var(--accentFg);border-color:transparent}

/* Markdown */
.message.assistant h1,.message.assistant h2,.message.assistant h3{font-size:13px;margin:8px 0 4px;color:var(--fg)} .message.assistant h1{font-size:15px} .message.assistant p{margin:6px 0;line-height:1.6} .message.assistant a{color:var(--vscode-textLink-foreground);text-decoration:underline} .message.assistant code{background:var(--vscode-textCodeBlock-background);padding:1px 4px;border-radius:3px;font-family:var(--vscode-editor-font-family);font-size:11px} .message.assistant pre{white-space:pre-wrap;overflow:auto;background:var(--vscode-textCodeBlock-background);padding:9px;border-radius:6px;margin:6px 0} .message.assistant pre code{padding:0;background:transparent} .message.assistant ul,.message.assistant ol{margin:6px 0 6px 20px;padding:0} .message.assistant blockquote{border-left:3px solid var(--border);margin:8px 0;padding:4px 12px;color:var(--muted)} .message.assistant table{border-collapse:collapse;margin:8px 0} .message.assistant th,.message.assistant td{border:1px solid var(--border);padding:4px 8px;text-align:left} .message.assistant hr{border:none;border-top:1px solid var(--border);margin:12px 0}

/* Settings page */
.settings{padding:16px;display:flex;flex-direction:column;gap:14px;overflow-y:auto} .settings h2{font-size:15px;margin:0 0 6px;color:var(--fg)} .settings .section{border:1px solid var(--border);border-radius:8px;padding:12px;background:var(--card)} .settings .section h3{font-size:12px;color:var(--muted);margin:0 0 8px;text-transform:uppercase;letter-spacing:.6px} .settings .row{display:flex;align-items:center;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--border)} .settings .row:last-child{border-bottom:none} .settings .label{flex:1} .settings .label b{color:var(--fg)} .settings .desc{font-size:11px;color:var(--muted);display:block;margin-top:2px} .settings .toggle{width:44px;height:24px;background:var(--input);border:1px solid var(--border);border-radius:12px;cursor:pointer;position:relative;appearance:none;outline:none} .settings .toggle:checked{background:var(--accent);border-color:transparent} .settings .toggle:checked::after{left:20px;background:var(--accentFg)} .settings .toggle::after{content:'';position:absolute;top:2px;left:2px;width:18px;height:18px;background:var(--fg);border-radius:50%;transition:transform .2s} input.text{width:100%;background:var(--input);border:1px solid var(--border);color:var(--fg);border-radius:6px;padding:6px 10px;font:inherit} .badge{font-size:10px;padding:1px 6px;border-radius:8px;background:var(--input);color:var(--muted);border:1px solid var(--border)}

/* Focused, single-screen navigation */
.shell{display:flex;width:100%;height:100vh;overflow:hidden}main.panel{width:100%;height:100%;min-width:0;display:flex;flex-direction:column}.top{gap:10px}.top .brandBlock{flex:1;min-width:0}.top .controls{margin-left:auto}.chatListView{flex:1;overflow:auto;padding:22px 16px}.chatListInner{width:100%;max-width:720px;margin:0 auto}.chatListHead{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:6px 0 18px}.chatListHead h2{font-size:18px;margin:0 0 4px}.chatListHead p{color:var(--muted);margin:0;font-size:12px}.chatListView input.search{margin:0 0 10px}.chatListView .list{padding:4px 0}.chatListView .chatItem{padding:12px;border:1px solid var(--border);margin-bottom:6px;background:var(--card)}.chatListView .chatItem .actions{opacity:1}.chatAppView{flex:1;min-height:0;display:flex;flex-direction:column}.settings{width:100%;max-width:760px;margin:0 auto;flex:1;min-height:0}.keySettings{display:flex;gap:12px;align-items:center;justify-content:space-between}.keyActions{display:flex;gap:6px;flex-shrink:0}.keyActions .danger{color:var(--error);border-color:var(--error)}.status.working:before{content:'';display:inline-block;width:10px;height:10px;border:2px solid var(--border);border-top-color:var(--accent);border-radius:50%;margin-right:7px;vertical-align:-2px;animation:spin .8s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}.edit-progress{border:1px solid var(--border);border-radius:8px;background:var(--card);padding:9px 10px;display:flex;flex-direction:column;gap:7px}.edit-progress .line{display:flex;align-items:center;gap:8px;color:var(--muted);font-size:11px}.edit-progress .spinner{width:12px;height:12px;border:2px solid var(--border);border-top-color:var(--accent);border-radius:50%;animation:spin .8s linear infinite;flex-shrink:0}.edit-progress.done .spinner{animation:none;border:0;width:14px;height:14px}.progressTrack{height:3px;border-radius:4px;background:var(--border);overflow:hidden}.progressTrack span{display:block;height:100%;width:0;background:var(--accent);transition:width .18s ease}.edit-progress.done .progressTrack span{width:100%;background:var(--vscode-testing-iconPassed)}.preview{align-items:stretch}.previewCol{min-width:0}.previewLabel{font-size:10px;color:var(--muted);margin:0 0 4px}.preview pre{max-height:240px}.approval .desc.path{font-family:var(--vscode-editor-font-family);font-size:11px}.chatItem .actions button{opacity:.8}.chatItem .actions button:hover{opacity:1}.chatItem .sub{margin-top:3px}.feed{scroll-behavior:smooth}.composer{background:var(--bg)}
@media(max-width:420px){.chatListView{padding:16px 10px}.chatListHead{align-items:flex-start;flex-direction:column}.chatListHead button{width:100%}.keySettings{align-items:flex-start;flex-direction:column}.keyActions{width:100%}.keyActions button{flex:1}.preview{grid-template-columns:1fr}.top{padding:0 8px}}
</style></head><body>
<div class="shell">
<main class="panel">
  <div id="fatalError" class="fatalError hidden" role="alert"></div>
  <div class="top">
    <button id="backToList" class="icon hidden" title="Back to chats">←</button>
    <div class="brandBlock"><div class="brand">Nemotron Agent</div><div class="sub">Workspace coding assistant</div></div>
    <div class="controls"><button id="settingsBtn" class="icon" title="Settings">⚙</button><button id="newBtn" class="icon primary" title="New chat">＋</button></div>
  </div>

  <section id="chatListView" class="chatListView">
    <div class="chatListInner">
      <div class="chatListHead"><div><h2>Your chats</h2><p>Continue a previous task or start something new.</p></div><button id="listNewBtn" class="primary">＋ New chat</button></div>
      <input id="chatSearch" class="search" placeholder="Search chats…" autocomplete="off">
      <div class="list"><div id="chatList"><div class="empty">No saved chats yet.</div></div></div>
    </div>
  </section>

  <section id="chatAppView" class="chatAppView hidden">
    <div id="settingsView" class="settings hidden">
      <h2>Settings</h2>
      <div class="section"><h3>API key</h3>
        <div class="keySettings"><div><b id="keyStatus">NVIDIA API key is not configured.</b><span class="desc">Stored securely in VS Code Secret Storage.</span></div><div class="keyActions"><button id="keyBtn" class="primary">Set / Update key</button><button id="clearKeyBtn" class="danger">Remove</button></div></div>
      </div>
      <div class="section"><h3>Model</h3>
        <div class="row"><div class="label"><b>Model ID</b><span class="desc">NVIDIA NIM model to use.</span></div><input id="settingModel" class="text"></div>
        <div class="row"><div class="label"><b>Base URL</b><span class="desc">OpenAI-compatible API endpoint.</span></div><input id="settingBaseUrl" class="text"></div>
        <div class="row"><div class="label"><b>Max output tokens</b><span class="desc">Tokens per model turn (1024–65536).</span></div><input id="settingMaxTokens" class="text" style="width:120px"></div>
        <div class="row"><div class="label"><b>Max tool rounds</b><span class="desc">Max consecutive tool-calling rounds per request.</span></div><input id="settingMaxToolRounds" class="text" style="width:120px"></div>
      </div>
      <div class="section"><h3>Behavior</h3>
        <div class="row"><div class="label"><b>Reasoning / Thinking</b><span class="desc">Enable Nemotron thinking mode.</span></div><input id="settingReasoning" class="toggle"></div>
        <div class="row"><div class="label"><b>Memory</b><span class="desc">Remember facts across chats in this workspace.</span></div><input id="settingMemory" class="toggle"></div>
        <div class="row"><div class="label"><b>Auto-save chats</b><span class="desc">Save conversation history to this workspace.</span></div><input id="settingAutoSave" class="toggle"></div>
      </div>
      <div class="section"><h3>Personalization</h3>
        <div class="row"><div class="label"><b>Persona</b><span class="desc">How Nemotron should behave (e.g. helpful coding assistant).</span></div><input id="settingPersona" class="text"></div>
        <div class="row"><div class="label"><b>Tone</b><span class="desc">Preferred tone (e.g. concise, detailed).</span></div><input id="settingTone" class="text"></div>
        <div class="row"><div class="label"><b>Expertise</b><span class="desc">Comma-separated areas (e.g. TypeScript, React, Python).</span></div><input id="settingExpertise" class="text"></div>
      </div>
    </div>

    <div class="feed" id="feed"><div class="welcome" id="welcome"><h2>What are we building?</h2><p>Ask me to understand your codebase, fix bugs, implement features, or run checks. I’ll ask before editing files or running commands.</p><div class="suggestions"><button data-prompt="Explore this codebase and explain its architecture.">Explore codebase</button><button data-prompt="Find likely bugs and suggest fixes. Do not change files yet.">Find bugs</button><button data-prompt="Review this project and identify the most important improvements.">Review project</button></div></div></div>
    <div class="composer">
      <div class="textareaWrap"><textarea id="prompt" placeholder="Ask Nemotron to work on your code… (Enter to send, Shift+Enter for newline)"></textarea></div>
      <div class="composerFoot">
        <div class="status" id="status">Connect your NVIDIA API key to begin</div>
        <div class="actions" id="composerActions">
          <button id="thinkBtn" class="toggle" title="Think on/off">Think</button>
          <button id="stopBtn" class="hidden">Stop</button>
          <button id="sendBtn" class="primary send">Send ↑</button>
        </div>
      </div>
    </div>
  </section>
</main>
</div>
<script nonce="${nonce}">
// Keep this bootstrap separate from the main app script: it can report a syntax
// error in that script before the app's own error handlers have had a chance to run.
window.addEventListener('error',event=>{
  const banner=document.getElementById('fatalError');
  if(banner){banner.textContent='Nemotron Agent could not start: '+(event.message||'Webview script error');banner.classList.remove('hidden');}
});
window.addEventListener('unhandledrejection',event=>{
  const banner=document.getElementById('fatalError');
  if(banner){const reason=event.reason?.message||event.reason||'Asynchronous UI error';banner.textContent='Nemotron Agent UI error: '+String(reason);banner.classList.remove('hidden');}
});
</script>
<script nonce="${nonce}">
const vscode=acquireVsCodeApi();
const fatalError=document.getElementById('fatalError');
function reportClientError(message){
  const text=String(message||'Unknown webview error');
  if(fatalError){fatalError.textContent='Nemotron Agent UI error: '+text;fatalError.classList.remove('hidden');}
  const status=document.getElementById('status');
  if(status){status.textContent='UI error — see details above';status.classList.remove('working');}
  try{vscode.postMessage({type:'clientError',text});}catch{}
}
window.addEventListener('error',event=>reportClientError(event.message||'A script failed to load'));
window.addEventListener('unhandledrejection',event=>reportClientError(event.reason?.message||event.reason||'An asynchronous operation failed'));
const feed=document.getElementById('feed');
const input=document.getElementById('prompt');
const sendBtn=document.getElementById('sendBtn');
const stopBtn=document.getElementById('stopBtn');
const statusEl=document.getElementById('status');
const chatListEl=document.getElementById('chatList');
const chatListView=document.getElementById('chatListView');
const chatAppView=document.getElementById('chatAppView');
const settingsView=document.getElementById('settingsView');
const backToList=document.getElementById('backToList');
const keyStatus=document.getElementById('keyStatus');
let currentAssistant=null;
let currentRaw='';
let busy=false;
let currentChatId=null;
let chats=[];
let currentScreen='list';
const approvals=new Map();
const editProgressCards=new Map();
let config={reasoning:true,persona:'',memoryEnabled:false,autoSaveChats:true};
function el(tag,cls,text){const n=document.createElement(tag);if(cls)n.className=cls;if(text!==undefined)n.textContent=text;return n}
function scroll(){feed.scrollTop=feed.scrollHeight}
function setStatus(text,working){statusEl.textContent=text||'';statusEl.classList.toggle('working',!!working)}
function showView(name){currentScreen=name;chatListView.classList.toggle('hidden',name!=='list');chatAppView.classList.toggle('hidden',name==='list');settingsView.classList.toggle('hidden',name!=='settings');feed.classList.toggle('hidden',name==='settings');document.querySelector('.composer').classList.toggle('hidden',name==='settings');backToList.classList.toggle('hidden',name==='list');if(name==='chat'){setTimeout(()=>input.focus(),30)}}
function addUser(text){document.getElementById('welcome')?.remove();feed.append(el('div','message user',text));scroll()}
function startAssistant(){document.getElementById('welcome')?.remove();const wrap=el('div','message assistant');wrap.append(el('div','label','Nemotron'));const content=el('div','content');wrap.append(content);feed.append(wrap);currentAssistant=content;currentRaw='';scroll()}
function escapeHtml(value){return String(value).replace(/[&<>\"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',"'":'&#39;'}[ch]))}
function renderInlineMarkdown(value){
  let text=escapeHtml(value);
  const code=[];
  text=text.replace(/\x60([^\x60]+)\x60/g,(_,part)=>{const token='\uE000'+code.length+'\uE001';code.push('<code>'+part+'</code>');return token});
  text=text.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,(_,label,url)=>'<a href="'+url+'" target="_blank" rel="noopener noreferrer">'+label+'</a>');
  text=text.replace(/\*\*([^*]+)\*\*/g,'<strong>$1</strong>').replace(/~~([^~]+)~~/g,'<del>$1</del>').replace(/\*([^*]+)\*/g,'<em>$1</em>');
  return text.replace(/\uE000(\d+)\uE001/g,(_,index)=>code[Number(index)]||'');
}
function renderMarkdown(source){
  const lines=String(source||'').replace(/\r\n/g,'\n').split('\n');
  const html=[];let paragraph=[];let listType='';let listItems=[];let codeLines=null;
  const flushParagraph=()=>{if(paragraph.length){html.push('<p>'+paragraph.map(renderInlineMarkdown).join('<br>')+'</p>');paragraph=[]}};
  const flushList=()=>{if(listItems.length){html.push('<'+listType+'>'+listItems.map(item=>'<li>'+renderInlineMarkdown(item)+'</li>').join('')+'</'+listType+'>');listItems=[];listType=''}};
  for(const line of lines){
    if(codeLines){if(/^\s*\x60{3}/.test(line)){html.push('<pre><code>'+escapeHtml(codeLines.join('\n'))+'</code></pre>');codeLines=null}else codeLines.push(line);continue}
    if(/^\s*\x60{3}/.test(line)){flushParagraph();flushList();codeLines=[];continue}
    const heading=line.match(/^(#{1,4})\s+(.+)$/);const bullet=line.match(/^\s*[-*+]\s+(.+)$/);const ordered=line.match(/^\s*\d+[.)]\s+(.+)$/);
    if(heading){flushParagraph();flushList();const level=heading[1].length;html.push('<h'+level+'>'+renderInlineMarkdown(heading[2])+'</h'+level+'>');continue}
    if(bullet||ordered){flushParagraph();const nextType=bullet?'ul':'ol';if(listType&&listType!==nextType)flushList();listType=nextType;listItems.push((bullet||ordered)[1]);continue}
    if(/^\s*>/.test(line)){flushParagraph();flushList();html.push('<blockquote>'+renderInlineMarkdown(line.replace(/^\s*>\s?/,''))+'</blockquote>');continue}
    if(!line.trim()){flushParagraph();flushList();continue}
    flushList();paragraph.push(line);
  }
  if(codeLines)html.push('<pre><code>'+escapeHtml(codeLines.join('\n'))+'</code></pre>');
  flushParagraph();flushList();return html.join('');
}
function appendText(target,text){if(!target)return;currentRaw+=text;target.innerHTML=renderMarkdown(currentRaw);scroll()}
function addReasoning(text){if(!currentAssistant)return;let box=currentAssistant.querySelector('.expandable.reasoning');if(!box){box=el('details','expandable reasoning');box.append(el('summary',null,'Reasoning / Thinking'),el('pre',null,''));currentAssistant.prepend(box);}box.querySelector('pre').textContent+=text;scroll()}
function toolStart(name,args){const target=currentAssistant||feed;const box=el('details','expandable tool');box.dataset.tool=name;const summary=el('summary',null,'⚙ '+name);let detail='';if(name==='propose_file_edit'){const count=Array.isArray(args?.edits)?args.edits.length:(typeof args?.createContent==='string'?1:0);detail=String(args?.path||'')+' · '+count+' focused change'+(count===1?'':'s')}else if(name==='run_terminal_command'){detail=String(args?.command||'').slice(0,220)}else{detail=JSON.stringify(args||{}).slice(0,220)}summary.append(el('span','args',' '+detail));box.append(summary,el('pre','result',''));target.append(box);scroll()}
function toolDone(name,result){const target=currentAssistant||feed;const boxes=[...target.querySelectorAll('.expandable.tool')].reverse();const box=boxes.find(b=>b.dataset.tool===name&&!b.querySelector('.result.done'));if(box){const r=box.querySelector('.result');r.textContent=result;r.classList.add('done');const d=el('span','done',' · done');box.querySelector('summary').append(d)}scroll()}
function approvalCard(m){const card=el('div','approval');card.dataset.approval=m.id;card.append(el('h4',null,m.title));card.append(el('div','desc',m.summary||''));if(m.kind==='file'){card.append(el('div','desc path',m.path||''));if(m.patchCount)card.append(el('div','desc',m.patchCount+' targeted change'+(m.patchCount===1?'':'s')+' · all other file content stays untouched'));const grid=el('div','preview');const left=el('div','previewCol');left.append(el('div','previewLabel','REMOVE / REPLACE'));left.append(el('pre',null,m.oldPreview||'(new file)'));const right=el('div','previewCol');right.append(el('div','previewLabel','ADD / REPLACE WITH'));right.append(el('pre',null,m.newPreview||''));grid.append(left,right);card.append(grid)}else{card.append(el('pre',null,m.command||''))}const actions=el('div','actions');const reject=el('button','danger','Reject');const approve=el('button','primary','Approve patch');reject.onclick=()=>vscode.postMessage({type:'reject',id:m.id});approve.onclick=()=>{approve.disabled=true;reject.disabled=true;approve.textContent='Approved';vscode.postMessage({type:'approve',id:m.id})};actions.append(reject,approve);card.append(actions);feed.append(card);approvals.set(m.id,card);scroll()}
function updateEditProgress(m){let card=editProgressCards.get(m.id);if(!card){card=el('div','edit-progress');card.dataset.progress=m.id;const line=el('div','line');line.append(el('span','spinner',''),el('span','progressText','Preparing edit…'));const track=el('div','progressTrack');track.append(el('span'));card.append(line,track);const approval=approvals.get(m.id);if(approval&&approval.parentNode===feed)approval.after(card);else feed.append(card);editProgressCards.set(m.id,card)}const text=card.querySelector('.progressText');if(text)text.textContent=m.message||'Working…';const bar=card.querySelector('.progressTrack span');if(bar){const pct=m.stage==='completed'?100:m.total?Math.max(4,Math.round((m.current/m.total)*82)):4;bar.style.width=pct+'%'}if(m.stage==='completed'){card.classList.add('done');card.querySelector('.spinner').textContent='✓';setStatus(m.message||'File saved and verified',false)}else if(m.stage==='failed'){card.classList.add('done');card.querySelector('.spinner').textContent='!';setStatus('Edit needs attention',false)}else{setStatus(m.message||'Applying approved changes…',true)}scroll()}
function setBusy(v){busy=v;sendBtn.disabled=v;stopBtn.classList.toggle('hidden',!v);if(v)setStatus('Nemotron is working…',true);else if(statusEl.classList.contains('working'))setStatus('Ready',false)}
function renderChats(){chatListEl.innerHTML='';const query=(document.getElementById('chatSearch').value||'').trim().toLowerCase();const shown=chats.filter(c=>!query||String(c.title||'').toLowerCase().includes(query)||String(c.preview||'').toLowerCase().includes(query));if(!shown.length){chatListEl.append(el('div','empty',query?'No chats match your search.':'No saved chats yet. Start a new chat to begin.'));return}shown.forEach(c=>{const item=el('div','chatItem');if(c.id===currentChatId)item.classList.add('active');const meta=el('div','meta');meta.append(el('div','title',c.title));meta.append(el('div','sub',new Date(c.updatedAt).toLocaleString()+' · '+c.messageCount+' messages'));item.append(meta);const actions=el('div','actions');const del=el('button','','🗑');del.title='Delete chat';del.setAttribute('aria-label','Delete chat');del.onclick=(e)=>{e.stopPropagation();if(confirm('Delete this chat?'))vscode.postMessage({type:'deleteChat',id:c.id})};actions.append(del);item.append(actions);item.onclick=()=>{currentChatId=c.id;vscode.postMessage({type:'loadChat',id:c.id})};chatListEl.append(item)})}
function startNewChat(){currentChatId=null;showView('chat');vscode.postMessage({type:'newChat'});renderChats()}
function send(){const text=input.value.trim();if(!text||busy)return;if(currentScreen!=='chat')showView('chat');addUser(text);input.value='';startAssistant();setBusy(true);vscode.postMessage({type:'send',text})}
sendBtn.onclick=send;stopBtn.onclick=()=>vscode.postMessage({type:'stop'});document.getElementById('newBtn').onclick=startNewChat;document.getElementById('listNewBtn').onclick=startNewChat;document.getElementById('settingsBtn').onclick=()=>showView('settings');backToList.onclick=()=>showView('list');document.getElementById('keyBtn').onclick=()=>vscode.postMessage({type:'setKey'});document.getElementById('clearKeyBtn').onclick=()=>{if(confirm('Remove the saved NVIDIA API key?'))vscode.postMessage({type:'clearKey'})};document.getElementById('chatSearch').addEventListener('input',renderChats);input.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();send()}});document.querySelectorAll('[data-prompt]').forEach(b=>b.onclick=()=>{input.value=b.dataset.prompt;input.focus()});
const thinkBtn=document.getElementById('thinkBtn');thinkBtn.onclick=()=>{const on=!thinkBtn.classList.contains('on');thinkBtn.classList.toggle('on',on);vscode.postMessage({type:'toggleReasoning',enabled:on})};
document.getElementById('settingMemory').onchange=e=>vscode.postMessage({type:'toggleMemory',enabled:e.target.checked});
document.getElementById('settingAutoSave').onchange=e=>vscode.postMessage({type:'saveSettings',autoSaveChats:e.target.checked});
const sModel=document.getElementById('settingModel');const sBase=document.getElementById('settingBaseUrl');const sMax=document.getElementById('settingMaxTokens');const sRounds=document.getElementById('settingMaxToolRounds');const sReasoning=document.getElementById('settingReasoning');const sMemory=document.getElementById('settingMemory');const sAuto=document.getElementById('settingAutoSave');const sPersona=document.getElementById('settingPersona');const sTone=document.getElementById('settingTone');const sExpertise=document.getElementById('settingExpertise');
function applyConfig(c){if(!c)return;config={...config,...c};sReasoning.checked=!!c.reasoning;sMemory.checked=!!c.memoryEnabled;thinkBtn.classList.toggle('on',!!c.reasoning);if(c.persona!==undefined)sPersona.value=c.persona;if(c.tone!==undefined)sTone.value=c.tone;if(c.expertise!==undefined)sExpertise.value=c.expertise.join(', ');if(c.model!==undefined)sModel.value=c.model;if(c.baseUrl!==undefined)sBase.value=c.baseUrl;if(c.maxTokens!==undefined)sMax.value=c.maxTokens;if(c.maxToolRounds!==undefined)sRounds.value=c.maxToolRounds;sAuto.checked=!!c.autoSaveChats}
function saveTextSettings(){vscode.postMessage({type:'saveSettings',model:sModel.value,baseUrl:sBase.value,maxTokens:Number(sMax.value)||0,maxToolRounds:Number(sRounds.value)||0,autoSaveChats:sAuto.checked});vscode.postMessage({type:'setPerson',persona:sPersona.value,tone:sTone.value,expertise:sExpertise.value.split(',').map(s=>s.trim()).filter(Boolean)})}
[sModel,sBase,sMax,sRounds,sPersona,sTone,sExpertise].forEach(node=>node.addEventListener('change',saveTextSettings));
window.addEventListener('message',event=>{const m=event.data;switch(m.type){case'ready':applyConfig(m.config);chats=m.chats||[];currentChatId=null;renderChats();keyStatus.textContent=m.hasKey?'NVIDIA API key is configured.':'NVIDIA API key is not configured.';setStatus(m.hasKey?'Ready · NVIDIA API key configured':'Add your NVIDIA API key in Settings',false);showView('list');break;case'status':setStatus(m.text,busy);break;case'userMessage':break;case'assistantStart':break;case'delta':appendText(currentAssistant,m.text);setStatus('Generating response…',true);break;case'reasoningDelta':addReasoning(m.text);setStatus('Thinking…',true);break;case'reasoning':addReasoning(m.text);break;case'toolStart':toolStart(m.name,m.args);setStatus('Using '+m.name+'…',true);break;case'toolDone':toolDone(m.name,m.result);break;case'approval':approvalCard(m);setStatus('Waiting for your approval…',false);break;case'approvalResolved':{const c=approvals.get(m.id);if(c){c.querySelector('.actions').textContent=m.approved?'Approved · preparing patch':'Rejected';c.style.opacity='.8'}break}case'approvalExpired':{const c=approvals.get(m.id);if(c){c.querySelector('.actions').textContent='Approval expired';c.style.opacity='.65'}setStatus('Approval expired',false);break}case'editProgress':updateEditProgress(m);break;case'keyState':keyStatus.textContent=m.text;setStatus(m.text,false);break;case'assistantDone':currentAssistant=null;currentRaw='';setStatus('Ready',false);setBusy(false);break;case'error':{appendText(currentAssistant,'\n\nError: '+m.text);currentAssistant=null;setStatus('Request failed',false);setBusy(false);break}case'busy':setBusy(m.value);break;case'chatCreated':currentChatId=m.id;showView('chat');renderChats();break;case'chatsUpdated':chats=m.chats||[];renderChats();break;case'chatLoaded':currentChatId=m.id;showView('chat');renderChats();document.getElementById('welcome')?.remove();feed.innerHTML='';(m.messages||[]).forEach(msg=>{if(msg.role==='user'){addUser(msg.content||'')}else if(msg.role==='assistant'){startAssistant();if(msg.content)appendText(currentAssistant,msg.content)}});setStatus('Ready',false);break;case'configUpdated':applyConfig(m.config);break;case'reset':showView('chat');feed.innerHTML='';const w=el('div','welcome');w.id='welcome';w.innerHTML='<h2>New conversation</h2><p>Ask me to understand your codebase, fix bugs, or implement a feature.</p>';feed.append(w);currentAssistant=null;currentRaw='';setStatus('New chat',false);break}});
showView('list');vscode.postMessage({type:'ready'});
</script></body></html>`;
  }
}