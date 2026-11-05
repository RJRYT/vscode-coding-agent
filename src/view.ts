import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { API_KEY_SECRET, getNemotronAgentConfig } from './config';
import { AgentLoop } from './agent';
import { ToolRegistry, AskApproval } from './tools';

export class NemotronAgentView implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private agent?: AgentLoop;
  private tools?: ToolRegistry;
  private pending = new Map<
    string,
    { resolve: (approved: boolean) => void; timeout: NodeJS.Timeout }
  >();

  constructor(private readonly context: vscode.ExtensionContext) {}

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
  }

  private async handleMessage(message: any): Promise<void> {
    switch (message?.type) {
      case 'ready': {
        const apiKey = await this.context.secrets.get(API_KEY_SECRET);
        this.post({
          type: 'status',
          text: apiKey ? 'Ready · NVIDIA key configured' : 'Add your NVIDIA API key to start',
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
        this.resetConversation();
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
:root{color-scheme:light dark;--bg:var(--vscode-sideBar-background);--fg:var(--vscode-foreground);--muted:var(--vscode-descriptionForeground);--border:var(--vscode-panel-border);--card:var(--vscode-editorWidget-background);--accent:var(--vscode-button-background);--accentFg:var(--vscode-button-foreground);--input:var(--vscode-input-background)}*{box-sizing:border-box}body{margin:0;padding:0;background:var(--bg);color:var(--fg);font:13px var(--vscode-font-family);height:100vh;display:flex;flex-direction:column}.top{height:44px;display:flex;align-items:center;justify-content:space-between;padding:0 12px;border-bottom:1px solid var(--border);flex-shrink:0}.brand{font-weight:650;letter-spacing:.1px}.sub{font-size:11px;color:var(--muted)}button{font:inherit;cursor:pointer;border:1px solid var(--border);background:transparent;color:var(--fg);border-radius:6px;padding:6px 9px}button:hover{background:var(--vscode-toolbar-hoverBackground)}button.primary{background:var(--accent);color:var(--accentFg);border-color:transparent}button:disabled{opacity:.5;cursor:not-allowed}.feed{flex:1;overflow:auto;padding:12px;display:flex;flex-direction:column;gap:12px}.welcome{margin:auto 0;text-align:center;color:var(--muted);padding:16px 6px}.welcome h2{font-size:16px;color:var(--fg);margin-bottom:6px}.welcome p{line-height:1.5}.suggestions{display:flex;flex-wrap:wrap;gap:6px;justify-content:center;margin-top:12px}.suggestions button{font-size:11px}.message{max-width:100%;line-height:1.55;overflow-wrap:anywhere}.message.user{background:var(--vscode-textBlockQuote-background);border:1px solid var(--border);padding:9px 10px;border-radius:9px;align-self:flex-end;max-width:94%;white-space:pre-wrap}.message.assistant{white-space:normal}.message.assistant .content{white-space:pre-wrap}.message .label{font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.6px;margin-bottom:4px}.message pre{white-space:pre-wrap;overflow:auto;background:var(--vscode-textCodeBlock-background);padding:9px;border-radius:6px}.expandable .args{color:var(--muted);white-space:nowrap;font-size:10px;margin:4px 0;display:inline}.expandable summary{color:var(--muted);cursor:pointer;padding:5px 8px;font-size:11px;list-style:none;background:transparent;border-bottom:1px solid var(--border);user-select:none}.expandable summary:hover{background:var(--vscode-toolbar-hoverBackground)}.expandable[open] summary{border-bottom:1px solid transparent;border-radius:6px 6px 0 0;margin-bottom:-1px}.expandable pre{white-space:pre-wrap;background:var(--vscode-textCodeBlock-background);padding:8px;margin:0;font-size:10px;overflow:auto;border-top:1px solid var(--border)}.expandable .args{color:var(--muted);white-space:pre-wrap;font-size:10px;margin:4px 0;display:block}.expandable .result{color:var(--muted);white-space:pre-wrap;margin-top:4px;font-size:10px;max-height:240px;overflow:auto}.expandable .done{color:var(--vscode-descriptionForeground);margin-left:6px;font-size:10px}.approval{border:1px solid var(--vscode-editorWarning-foreground);border-radius:8px;padding:10px;background:var(--card);display:flex;flex-direction:column;gap:8px}.approval h4{margin:0;font-size:13px}.approval .desc{color:var(--muted)}.preview{display:grid;grid-template-columns:1fr 1fr;gap:6px}.preview pre{margin:0;max-height:180px;font-size:10px;white-space:pre-wrap;overflow:auto;padding:7px;background:var(--vscode-textCodeBlock-background);border-radius:5px}.approval .actions{display:flex;gap:7px;justify-content:flex-end}.approval .danger{border-color:var(--vscode-errorForeground);color:var(--vscode-errorForeground)}.composer{border-top:1px solid var(--border);padding:9px;display:flex;flex-direction:column;gap:7px;flex-shrink:0}.textareaWrap{border:1px solid var(--vscode-input-border,var(--border));background:var(--input);border-radius:8px;padding:7px}.textareaWrap:focus-within{border-color:var(--vscode-focusBorder)}textarea{width:100%;resize:vertical;min-height:66px;max-height:180px;background:transparent;border:0;outline:0;color:var(--fg);font:inherit}.composerFoot{display:flex;align-items:center;justify-content:space-between}.status{font-size:10px;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.actions{display:flex;gap:6px}.key{font-size:11px;color:var(--muted)}.send{min-width:62px}.hidden{display:none!important}a{color:var(--vscode-textLink-foreground)}
.message.assistant h1,.message.assistant h2,.message.assistant h3{font-size:13px;margin:8px 0 4px;color:var(--fg)}.message.assistant h1{font-size:15px}.message.assistant p{margin:6px 0;line-height:1.6}.message.assistant a{color:var(--vscode-textLink-foreground);text-decoration:underline}.message.assistant code{background:var(--vscode-textCodeBlock-background);padding:1px 4px;border-radius:3px;font-family:var(--vscode-editor-font-family);font-size:11px}.message.assistant pre{white-space:pre-wrap;overflow:auto;background:var(--vscode-textCodeBlock-background);padding:9px;border-radius:6px;margin:6px 0}.message.assistant pre code{padding:0;background:transparent}.message.assistant ul,.message.assistant ol{margin:6px 0 6px 20px;padding:0}.message.assistant blockquote{border-left:3px solid var(--border);margin:8px 0;padding:4px 12px;color:var(--muted)}.message.assistant table{border-collapse:collapse;margin:8px 0}.message.assistant th,.message.assistant td{border:1px solid var(--border);padding:4px 8px;text-align:left}.message.assistant hr{border:none;border-top:1px solid var(--border);margin:12px 0}
</style></head><body>
<div class="top"><div><div class="brand">Nemotron Agent</div><div class="sub">Workspace coding assistant</div></div><div style="display:flex;gap:5px"><button id="keyBtn" title="Set NVIDIA API key">Key</button><button id="newBtn" title="New chat">＋</button></div></div>
<div class="feed" id="feed"><div class="welcome" id="welcome"><h2>What are we building?</h2><p>Ask me to understand your codebase, fix bugs, implement features, or run checks. I’ll ask before editing files or running commands.</p><div class="suggestions"><button data-prompt="Explore this codebase and explain its architecture.">Explore codebase</button><button data-prompt="Find likely bugs and suggest fixes. Do not change files yet.">Find bugs</button><button data-prompt="Review this project and identify the most important improvements.">Review project</button></div></div></div>
<div class="composer"><div class="textareaWrap"><textarea id="prompt" placeholder="Ask Nemotron to work on your code… (Enter to send, Shift+Enter for newline)"></textarea></div><div class="composerFoot"><div class="status" id="status">Connect your NVIDIA API key to begin</div><div class="actions"><button id="stopBtn" class="hidden">Stop</button><button id="sendBtn" class="primary send">Send ↑</button></div></div></div>
<script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
<script nonce="${nonce}">
const vscode=acquireVsCodeApi();const feed=document.getElementById('feed');const input=document.getElementById('prompt');const sendBtn=document.getElementById('sendBtn');const stopBtn=document.getElementById('stopBtn');const statusEl=document.getElementById('status');let currentAssistant=null;let currentRaw='';let busy=false;const approvals=new Map();
function el(tag,cls,text){const n=document.createElement(tag);if(cls)n.className=cls;if(text!==undefined)n.textContent=text;return n}
function scroll(){feed.scrollTop=feed.scrollHeight}
function addUser(text){document.getElementById('welcome')?.remove();feed.append(el('div','message user',text));scroll()}
function startAssistant(){document.getElementById('welcome')?.remove();const wrap=el('div','message assistant');wrap.append(el('div','label','Nemotron'));const content=el('div','content');wrap.append(content);feed.append(wrap);currentAssistant=content;currentRaw='';scroll()}
function appendText(target,text){if(!target)return;currentRaw+=text;target.innerHTML=marked.parse(currentRaw||'');scroll()}
function addReasoning(text){if(!currentAssistant)return;let box=currentAssistant.querySelector('.expandable.reasoning');if(!box){box=el('details','expandable reasoning');box.append(el('summary',null,'Reasoning / Thinking'),el('pre',null,''));currentAssistant.prepend(box);}box.querySelector('pre').textContent+=text;scroll()}
function toolStart(name,args){const target=currentAssistant||feed;const box=el('details','expandable tool');box.dataset.tool=name;const summary=el('summary',null,'⚙ '+name);summary.append(el('span','args',' '+JSON.stringify(args)));box.append(summary,el('pre','result',''));target.append(box);scroll()}function toolDone(name,result){const target=currentAssistant||feed;const boxes=[...target.querySelectorAll('.expandable.tool')].reverse();const box=boxes.find(b=>b.dataset.tool===name&&!b.querySelector('.result.done'));if(box){const r=box.querySelector('.result');r.textContent=result;r.classList.add('done');const d=el('span','done',' · done');box.querySelector('summary').append(d)}scroll()}
function approvalCard(m){const card=el('div','approval');card.dataset.approval=m.id;card.append(el('h4',null,m.title));card.append(el('div','desc',m.summary||''));if(m.kind==='file'){card.append(el('div','desc',m.path));const grid=el('div','preview');grid.append(el('pre',null,'CURRENT\\n'+(m.oldPreview||'(new file)')));grid.append(el('pre',null,'PROPOSED\\n'+(m.newPreview||'')));card.append(grid);}else{card.append(el('pre',null,m.command||''))}const actions=el('div','actions');const reject=el('button','danger','Reject');const approve=el('button','primary','Approve');reject.onclick=()=>vscode.postMessage({type:'reject',id:m.id});approve.onclick=()=>{approve.disabled=true;reject.disabled=true;approve.textContent='Approved';vscode.postMessage({type:'approve',id:m.id})};actions.append(reject,approve);card.append(actions);feed.append(card);approvals.set(m.id,card);scroll()}
function setBusy(v){busy=v;sendBtn.disabled=v;stopBtn.classList.toggle('hidden',!v);statusEl.textContent=v?'Agent is working…':statusEl.textContent}
function send(){const text=input.value.trim();if(!text||busy)return;addUser(text);input.value='';startAssistant();vscode.postMessage({type:'send',text})}
sendBtn.onclick=send;stopBtn.onclick=()=>vscode.postMessage({type:'stop'});document.getElementById('newBtn').onclick=()=>vscode.postMessage({type:'newChat'});document.getElementById('keyBtn').onclick=()=>vscode.postMessage({type:'setKey'});input.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();send()}});document.querySelectorAll('[data-prompt]').forEach(b=>b.onclick=()=>{input.value=b.dataset.prompt;input.focus()});
window.addEventListener('message',event=>{const m=event.data;switch(m.type){case'ready':break;case'status':statusEl.textContent=m.text;break;case'userMessage':break;case'assistantStart':break;case'delta':appendText(currentAssistant,m.text);break;case'reasoningDelta':addReasoning(m.text);break;case'reasoning':addReasoning(m.text);break;case'toolStart':toolStart(m.name,m.args);break;case'toolDone':toolDone(m.name,m.result);break;case'approval':approvalCard(m);statusEl.textContent='Waiting for your approval…';break;case'approvalResolved':{const c=approvals.get(m.id);if(c){c.querySelector('.actions').textContent=m.approved?'Approved':'Rejected';c.style.opacity='.65'}break}case'approvalExpired':{const c=approvals.get(m.id);if(c){c.querySelector('.actions').textContent='Approval expired';c.style.opacity='.65'}break}case'assistantDone':currentAssistant=null;currentRaw='';statusEl.textContent='Ready';break;case'error':{appendText(currentAssistant,'\\n\\nError: '+m.text);currentAssistant=null;statusEl.textContent='Request failed';break}case'busy':setBusy(m.value);if(!m.value&&statusEl.textContent==='Agent is working…')statusEl.textContent='Ready';break;case'reset':feed.innerHTML='';const w=el('div','welcome');w.id='welcome';w.innerHTML='<h2>New conversation</h2><p>Ask me to understand your codebase, fix bugs, or implement a feature.</p>';feed.append(w);currentAssistant=null;currentRaw='';statusEl.textContent='New chat';break}});vscode.postMessage({type:'ready'});
</script></body></html>`;
  }
}
