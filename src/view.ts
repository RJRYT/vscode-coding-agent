import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import {
  API_KEY_SECRET,
  getNemotronAgentConfig,
  NemotronAgentConfig,
  ChatSummary,
  ChatData,
  PersonalizationConfig,
  DEFAULT_PERSONA,
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
    view.webview.html = this.getHtml();

    const askApproval: AskApproval = (payload) => this.askApproval(payload);

    this.tools = new ToolRegistry(this.context, askApproval);
    this.agent = new AgentLoop(this.context, this.tools, (message) => this.post(message));

    view.webview.onDidReceiveMessage(async (message) => {
      await this.handleMessage(message);
    });
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
              text: 'NVIDIA API key is not configured. Click Key to add it, then send your request again.',
            });
            void vscode.commands.executeCommand('nemotronAgent.setApiKey');
            return;
          }
          const config = getNemotronAgentConfig();
          await this.agent?.handleUserMessage(message.text, apiKey, config);
          this.currentChatId = this.agent?.currentChat ?? null;
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
          type: 'status',
          text: apiKey ? 'Ready · NVIDIA key configured' : 'API key not configured',
        });
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
        this.post({
          type: 'ready',
          hasKey: !!this.context.secrets.get(API_KEY_SECRET),
          config: {
            reasoning: config.reasoning,
            persona: config.persona,
            memoryEnabled: config.memoryEnabled,
            autoSaveChats: config.autoSaveChats,
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
        this.post({ type: 'configUpdated', config: { persona: config.persona, memoryEnabled: config.memoryEnabled } });
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
    const csp = `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}' https://cdn.jsdelivr.net;`;
    return `<!DOCTYPE html>
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
.feed{flex:1;overflow:auto;padding:12px;display:flex;flex-direction:column;gap:12px;min-height:0} .welcome{margin:auto 0;text-align:center;color:var(--muted);padding:16px 6px} .welcome h2{font-size:16px;color:var(--fg);margin-bottom:6px} .welcome p{line-height:1.5} .suggestions{display:flex;flex-wrap:wrap;gap:6px;justify-content:center;margin-top:12px} .suggestions button{font-size:11px} .message{max-width:100%;line-height:1.55;overflow-wrap:anywhere} .message.user{background:var(--vscode-textBlockQuote-background);border:1px solid var(--border);padding:9px 10px;border-radius:9px;align-self:flex-end;max-width:94%;white-space:pre-wrap} .message.assistant{white-space:normal} .message.assistant .content{white-space:pre-wrap} .message .label{font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.6px;margin-bottom:4px} .message pre{white-space:pre-wrap;overflow:auto;background:var(--vscode-textCodeBlock-background);padding:9px;border-radius:6px} .expandable .args{color:var(--muted);white-space:nowrap;font-size:10px;margin:4px 0;display:inline} .expandable summary{color:var(--muted);cursor:pointer;padding:5px 8px;font-size:11px;list-style:none;background:transparent;border-bottom:1px solid var(--border);user-select:none} .expandable summary:hover{background:var(--vscode-toolbar-hoverBackground)} .expandable[open] summary{border-bottom:1px solid transparent;border-radius:6px 6px 0 0;margin-bottom:-1px} .expandable[open] pre{white-space:pre-wrap;background:var(--vscode-textCodeBlock-background);padding:8px;margin:0;font-size:10px;overflow:auto;border-top:1px solid var(--border)} .expandable .result{color:var(--muted);white-space:pre-wrap;margin-top:4px;font-size:10px;max-height:240px;overflow:auto} .expandable .done{color:var(--vscode-descriptionForeground);margin-left:6px;font-size:10px} .approval{border:1px solid var(--warning);border-radius:8px;padding:10px;background:var(--card);display:flex;flex-direction:column;gap:8px} .approval h4{margin:0;font-size:13px} .approval .desc{color:var(--muted)} .preview{display:grid;grid-template-columns:1fr 1fr;gap:6px} .preview pre{margin:0;max-height:180px;font-size:10px;white-space:pre-wrap;overflow:auto;padding:7px;background:var(--vscode-textCodeBlock-background);border-radius:5px} .approval .actions{display:flex;gap:7px;justify-content:flex-end} .approval .danger{border-color:var(--error);color:var(--error)} .composer{border-top:1px solid var(--border);padding:9px;display:flex;flex-direction:column;gap:7px;flex-shrink:0} .textareaWrap{border:1px solid var(--vscode-input-border,var(--border));background:var(--input);border-radius:8px;padding:7px} .textareaWrap:focus-within{border-color:var(--vscode-focusBorder)} textarea{width:100%;resize:vertical;min-height:66px;max-height:180px;background:transparent;border:0;outline:0;color:var(--fg);font:inherit} .composerFoot{display:flex;align-items:center;justify-content:space-between} .status{font-size:10px;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap} .actions{display:flex;gap:6px} .key{font-size:11px;color:var(--muted)} .send{min-width:62px} .hidden{display:none!important} a{color:var(--vscode-textLink-foreground)}

/* Memory & reasoning chips */
.chip{font-size:10px;padding:2px 8px;border-radius:10px;border:1px solid var(--border);background:var(--input);color:var(--muted)} .chip.on{background:var(--accent);color:var(--accentFg);border-color:transparent}

/* Markdown */
.message.assistant h1,.message.assistant h2,.message.assistant h3{font-size:13px;margin:8px 0 4px;color:var(--fg)} .message.assistant h1{font-size:15px} .message.assistant p{margin:6px 0;line-height:1.6} .message.assistant a{color:var(--vscode-textLink-foreground);text-decoration:underline} .message.assistant code{background:var(--vscode-textCodeBlock-background);padding:1px 4px;border-radius:3px;font-family:var(--vscode-editor-font-family);font-size:11px} .message.assistant pre{white-space:pre-wrap;overflow:auto;background:var(--vscode-textCodeBlock-background);padding:9px;border-radius:6px;margin:6px 0} .message.assistant pre code{padding:0;background:transparent} .message.assistant ul,.message.assistant ol{margin:6px 0 6px 20px;padding:0} .message.assistant blockquote{border-left:3px solid var(--border);margin:8px 0;padding:4px 12px;color:var(--muted)} .message.assistant table{border-collapse:collapse;margin:8px 0} .message.assistant th,.message.assistant td{border:1px solid var(--border);padding:4px 8px;text-align:left} .message.assistant hr{border:none;border-top:1px solid var(--border);margin:12px 0}

/* Settings page */
.settings{padding:16px;display:flex;flex-direction:column;gap:14px;overflow-y:auto} .settings h2{font-size:15px;margin:0 0 6px;color:var(--fg)} .settings .section{border:1px solid var(--border);border-radius:8px;padding:12px;background:var(--card)} .settings .section h3{font-size:12px;color:var(--muted);margin:0 0 8px;text-transform:uppercase;letter-spacing:.6px} .settings .row{display:flex;align-items:center;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--border)} .settings .row:last-child{border-bottom:none} .settings .label{flex:1} .settings .label b{color:var(--fg)} .settings .desc{font-size:11px;color:var(--muted);display:block;margin-top:2px} .settings .toggle{width:44px;height:24px;background:var(--input);border:1px solid var(--border);border-radius:12px;cursor:pointer;position:relative;appearance:none;outline:none} .settings .toggle:checked{background:var(--accent);border-color:transparent} .settings .toggle:checked::after{left:20px;background:var(--accentFg)} .settings .toggle::after{content:'';position:absolute;top:2px;left:2px;width:18px;height:18px;background:var(--fg);border-radius:50%;transition:transform .2s} input.text{width:100%;background:var(--input);border:1px solid var(--border);color:var(--fg);border-radius:6px;padding:6px 10px;font:inherit} .badge{font-size:10px;padding:1px 6px;border-radius:8px;background:var(--input);color:var(--muted);border:1px solid var(--border)}
</style></head><body>
<div class="shell">
<aside class="sidebar">
  <div class="top"><div><div class="brand">Nemotron Agent</div><div class="sub">Workspace coding assistant</div></div><div class="controls"><button id="keyBtn" class="icon" title="Set NVIDIA API key">🔑</button><button id="settingsBtn" class="icon" title="Settings">⚙</button><button id="newBtn" class="icon primary" title="New chat">＋</button></div></div>
  <input id="chatSearch" class="search" placeholder="Search chats…">
  <div class="list"><h3>Chats</h3><div id="chatList"><div class="empty">No saved chats yet.</div></div></div>
</aside>
<main class="panel">
  <div id="settingsView" class="settings hidden">
    <button id="backToChat" style="background:none;border:none;color:var(--vscode-textLink-foreground);cursor:pointer;font:inherit;padding:0;align-self:flex-start">← Back</button>
    <h2>Settings</h2>
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
      <div class="row"><div class="label"><b>Persona</b><span class="desc">How Nemotron should behave (e.g. "helpful coding assistant").</span></div><input id="settingPersona" class="text"></div>
      <div class="row"><div class="label"><b>Tone</b><span class="desc">Preferred tone (e.g. "concise", "detailed").</span></div><input id="settingTone" class="text"></div>
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
</main>
</div>
<script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
<script nonce="${nonce}">
const vscode=acquireVsCodeApi();const feed=document.getElementById('feed');const input=document.getElementById('prompt');const sendBtn=document.getElementById('sendBtn');const stopBtn=document.getElementById('stopBtn');const statusEl=document.getElementById('status');const chatListEl=document.getElementById('chatList');const settingsView=document.getElementById('settingsView');const backBtn=document.getElementById('backToChat');let currentAssistant=null;let currentRaw='';let busy=false;let currentChatId=null;let chats=[];const approvals=new Map();let config={reasoning:true,persona:'',memoryEnabled:false,autoSaveChats:true};
function el(tag,cls,text){const n=document.createElement(tag);if(cls)n.className=cls;if(text!==undefined)n.textContent=text;return n}
function scroll(){feed.scrollTop=feed.scrollHeight}
function showView(name){const feed=document.getElementById('feed');const composer=document.querySelector('.composer');if(name==='settings'){feed.classList.add('hidden');composer.classList.add('hidden');settingsView.classList.remove('hidden')}else{settingsView.classList.add('hidden');feed.classList.remove('hidden');composer.classList.remove('hidden')}}
function addUser(text){document.getElementById('welcome')?.remove();feed.append(el('div','message user',text));scroll()}
function startAssistant(){document.getElementById('welcome')?.remove();const wrap=el('div','message assistant');wrap.append(el('div','label','Nemotron'));const content=el('div','content');wrap.append(content);feed.append(wrap);currentAssistant=content;currentRaw='';scroll()}
function appendText(target,text){if(!target)return;currentRaw+=text;target.innerHTML=marked.parse(currentRaw||'');scroll()}
function addReasoning(text){if(!currentAssistant)return;let box=currentAssistant.querySelector('.expandable.reasoning');if(!box){box=el('details','expandable reasoning');box.append(el('summary',null,'Reasoning / Thinking'),el('pre',null,''));currentAssistant.prepend(box);}box.querySelector('pre').textContent+=text;scroll()}
function toolStart(name,args){const target=currentAssistant||feed;const box=el('details','expandable tool');box.dataset.tool=name;const summary=el('summary',null,'⚙ '+name);summary.append(el('span','args',' '+JSON.stringify(args)));box.append(summary,el('pre','result',''));target.append(box);scroll()}function toolDone(name,result){const target=currentAssistant||feed;const boxes=[...target.querySelectorAll('.expandable.tool')].reverse();const box=boxes.find(b=>b.dataset.tool===name&&!b.querySelector('.result.done'));if(box){const r=box.querySelector('.result');r.textContent=result;r.classList.add('done');const d=el('span','done',' · done');box.querySelector('summary').append(d)}scroll()}
function approvalCard(m){const card=el('div','approval');card.dataset.approval=m.id;card.append(el('h4',null,m.title));card.append(el('div','desc',m.summary||''));if(m.kind==='file'){card.append(el('div','desc',m.path));const grid=el('div','preview');grid.append(el('pre',null,'CURRENT\\n'+(m.oldPreview||'(new file)')));grid.append(el('pre',null,'PROPOSED\\n'+(m.newPreview||'')));card.append(grid);}else{card.append(el('pre',null,m.command||''))}const actions=el('div','actions');const reject=el('button','danger','Reject');const approve=el('button','primary','Approve');reject.onclick=()=>vscode.postMessage({type:'reject',id:m.id});approve.onclick=()=>{approve.disabled=true;reject.disabled=true;approve.textContent='Approved';vscode.postMessage({type:'approve',id:m.id})};actions.append(reject,approve);card.append(actions);feed.append(card);approvals.set(m.id,card);scroll()}
function setBusy(v){busy=v;sendBtn.disabled=v;stopBtn.classList.toggle('hidden',!v);statusEl.textContent=v?'Agent is working…':statusEl.textContent}
function renderChats(){chatListEl.innerHTML='';if(!chats.length){chatListEl.append(el('div','empty','No saved chats yet.'));return} chats.forEach(c=>{const item=el('div','chatItem');if(c.id===currentChatId)item.classList.add('active');const meta=el('div','meta');meta.append(el('div','title',c.title));meta.append(el('div','sub',new Date(c.updatedAt).toLocaleString()+ ' · '+c.messageCount+' messages'));item.append(meta);const actions=el('div','actions');const del=el('button','','🗑');del.title='Delete chat';del.onclick=(e)=>{e.stopPropagation();if(confirm('Delete this chat?')){vscode.postMessage({type:'deleteChat',id:c.id})}};actions.append(del);item.append(actions);item.onclick=()=>{document.querySelectorAll('.chatItem').forEach(x=>x.classList.remove('active'));item.classList.add('active');currentChatId=c.id;vscode.postMessage({type:'loadChat',id:c.id})};chatListEl.append(item)})}
function send(){const text=input.value.trim();if(!text||busy)return;addUser(text);input.value='';startAssistant();setBusy(true);vscode.postMessage({type:'send',text})}
sendBtn.onclick=send;stopBtn.onclick=()=>vscode.postMessage({type:'stop'});document.getElementById('newBtn').onclick=()=>{vscode.postMessage({type:'newChat'});currentChatId=null;renderChats()};document.getElementById('keyBtn').onclick=()=>vscode.postMessage({type:'setKey'});document.getElementById('settingsBtn').onclick=()=>showView('settings');backBtn.onclick=()=>showView('chat');input.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();send()}});document.querySelectorAll('[data-prompt]').forEach(b=>b.onclick=()=>{input.value=b.dataset.prompt;input.focus()});
// Think toggle
const thinkBtn=document.getElementById('thinkBtn');thinkBtn.onclick=()=>{const on=!thinkBtn.classList.contains('on');thinkBtn.classList.toggle('on',on);vscode.postMessage({type:'toggleReasoning',enabled:on})};
// Memory toggle wired from settings
document.getElementById('settingMemory').onchange=e=>vscode.postMessage({type:'toggleMemory',enabled:e.target.checked});
// Auto-save toggle
document.getElementById('settingAutoSave').onchange=e=>vscode.postMessage({type:'saveSettings',autoSaveChats:e.target.checked});
// Settings inputs
const sModel=document.getElementById('settingModel');const sBase=document.getElementById('settingBaseUrl');const sMax=document.getElementById('settingMaxTokens');const sRounds=document.getElementById('settingMaxToolRounds');const sReasoning=document.getElementById('settingReasoning');const sMemory=document.getElementById('settingMemory');const sAuto=document.getElementById('settingAutoSave');const sPersona=document.getElementById('settingPersona');const sTone=document.getElementById('settingTone');const sExpertise=document.getElementById('settingExpertise');
function applyConfig(c){config=c;sReasoning.checked=!!c.reasoning;sMemory.checked=!!c.memoryEnabled;thinkBtn.classList.toggle('on',!!c.reasoning);if(c.persona!==undefined)sPersona.value=c.persona;if(c.model!==undefined)sModel.value=c.model;if(c.baseUrl!==undefined)sBase.value=c.baseUrl;if(c.maxTokens!==undefined)sMax.value=c.maxTokens;if(c.maxToolRounds!==undefined)sRounds.value=c.maxToolRounds;sAuto.checked=!!c.autoSaveChats;}
function saveTextSettings(){vscode.postMessage({type:'saveSettings',model:sModel.value,baseUrl:sBase.value,maxTokens:Number(sMax.value)||0,maxToolRounds:Number(sRounds.value)||0,autoSaveChats:sAuto.checked});vscode.postMessage({type:'setPerson',persona:sPersona.value,tone:sTone.value,expertise:sExpertise.value.split(',').map(s=>s.trim()).filter(Boolean)})}
[sModel,sBase,sMax,sRounds,sPersona,sTone,sExpertise].forEach(el=>el.addEventListener('change',saveTextSettings));
window.addEventListener('message',event=>{const m=event.data;switch(m.type){case'ready':config=m.config||config;applyConfig(m.config);chats=m.chats||[];currentChatId=null;renderChats();statusEl.textContent=m.hasKey?'Ready · NVIDIA key configured':'Add your NVIDIA API key to begin';break;case'status':statusEl.textContent=m.text;break;case'userMessage':break;case'assistantStart':break;case'delta':appendText(currentAssistant,m.text);break;case'reasoningDelta':addReasoning(m.text);break;case'reasoning':addReasoning(m.text);break;case'toolStart':toolStart(m.name,m.args);break;case'toolDone':toolDone(m.name,m.result);break;case'approval':approvalCard(m);statusEl.textContent='Waiting for your approval…';break;case'approvalResolved':{const c=approvals.get(m.id);if(c){c.querySelector('.actions').textContent=m.approved?'Approved':'Rejected';c.style.opacity='.65'}break}case'approvalExpired':{const c=approvals.get(m.id);if(c){c.querySelector('.actions').textContent='Approval expired';c.style.opacity='.65'}break}case'assistantDone':currentAssistant=null;currentRaw='';statusEl.textContent='Ready';setBusy(false);break;case'error':{appendText(currentAssistant,'\\n\\nError: '+m.text);currentAssistant=null;statusEl.textContent='Request failed';setBusy(false);break}case'busy':setBusy(m.value);if(!m.value&&statusEl.textContent==='Agent is working…')statusEl.textContent='Ready';break;case'chatCreated':currentChatId=m.id;renderChats();break;case'chatLoaded':currentChatId=m.id;renderChats();document.getElementById('welcome')?.remove();feed.innerHTML='';(m.messages||[]).forEach(msg=>{if(msg.role==='user'){addUser(msg.content||'')}else if(msg.role==='assistant'){startAssistant();if(msg.content)appendText(currentAssistant,msg.content)}});statusEl.textContent='Ready';break;case'configUpdated':applyConfig(m.config);break;case'reset':feed.innerHTML='';const w=el('div','welcome');w.id='welcome';w.innerHTML='<h2>New conversation</h2><p>Ask me to understand your codebase, fix bugs, or implement a feature.</p>';feed.append(w);currentAssistant=null;currentRaw='';statusEl.textContent='New chat';break}});vscode.postMessage({type:'ready'});
</script></body></html>`;
  }
}