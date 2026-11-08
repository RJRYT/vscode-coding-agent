import { MAX_PATCH_TEXT_CHARS, MAX_PATCH_TOTAL_CHARS, MAX_CREATE_CONTENT_CHARS, MAX_COMMAND_LENGTH } from './limits';

export type ToolName =
  | 'list_workspace_files' | 'read_file' | 'get_active_editor_context' | 'search_workspace'
  | 'propose_file_edit' | 'create_folder' | 'delete_file' | 'delete_folder'
  | 'git_manager' | 'run_terminal_command';

export interface ValidatedEdit { oldText: string; newText: string }
export type ToolArguments = Record<string, unknown>;

const OLD_KEYS = ['oldText','oldtext','old_text','originalText','original_text','original','search','find','old_content','old_code','before','old'];
const NEW_KEYS = ['newText','newtext','new_text','replacement','replacementText','replacement_text','replacement_content','replacementContent','updatedText','updated_text','newContent','new_content','replaceWith','replace_with','replace','afterText','after_text','after','insertText','insert_text','insert','value','text','content','body','replacementValue','new_value','new'];
const PATH_KEYS = ['path','filePath','file_path','targetPath','target_path','file'];
const SUMMARY_KEYS = ['summary','description','reason','message'];
const GIT_ACTIONS = ['status','diff','diff_staged','log','branch_list','remote_list','tag_list','show','stash_list','blame','stage','unstage','commit','push','pull','fetch','branch_create','branch_switch','branch_delete','branch_rename','merge','merge_abort','stash','stash_pop','stash_apply','stash_drop','tag_create','tag_delete','remote_add','remote_remove','remote_set_url','remote_prune','tag_push','push_tags','rebase','rebase_abort','cherry_pick','revert','reset_soft','reset_mixed','reset_hard','clean_preview','clean','worktree_list','worktree_add','worktree_remove','init'] as const;

function isRecord(value: unknown): value is ToolArguments { return !!value && typeof value === 'object' && !Array.isArray(value); }
function record(value: unknown): ToolArguments { if (!isRecord(value)) throw new Error('Tool arguments must be a JSON object.'); return value; }
function firstString(args: ToolArguments, keys: string[], max = 20_000, required = false): string | undefined {
  for (const key of keys) if (typeof args[key] === 'string') {
    const value = args[key] as string;
    if (value.length > max) throw new Error(`Argument ${key} exceeds the ${max}-character limit.`);
    if (value.trim() || value === '') return value;
  }
  if (required) throw new Error(`Missing or invalid required argument: ${keys[0]}.`);
  return undefined;
}
function optionalLimit(args: ToolArguments, key: string, max: number): number | undefined {
  const value = args[key]; if (value === undefined || value === null) return undefined;
  if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > max) throw new Error(`Argument ${key} must be an integer between 1 and ${max}.`);
  return Number(value);
}
function optionalOffset(args: ToolArguments, key: string): number | undefined {
  const value = args[key]; if (value === undefined || value === null) return undefined;
  if (!Number.isInteger(value) || Number(value) < 0 || Number(value) > 100_000) throw new Error(`Argument ${key} must be an integer between 0 and 100000.`);
  return Number(value);
}
function assertKeys(args: ToolArguments, allowed: string[]): void {
  // Compatible OpenAI gateways sometimes attach generic metadata or pagination
  // fields to tools that do not consume them. Ignore only these harmless keys;
  // all operation-specific unknown arguments remain errors.
  const harmlessProtocolExtras = new Set(['description','summary','reason','limit','offset','oldText','newText']);
  const unexpected = Object.keys(args).filter((key) => !allowed.includes(key) && !harmlessProtocolExtras.has(key));
  if (unexpected.length) throw new Error(`Unexpected tool argument(s): ${unexpected.join(', ')}.`);
}
function nestedString(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (isRecord(value)) for (const key of ['text','content','value','code']) if (typeof value[key] === 'string') return value[key] as string;
  return undefined;
}
function normalizeEdit(item: ToolArguments, index: number, inherited?: string): ValidatedEdit {
  let oldText: string | undefined; let newText: string | undefined;
  for (const key of OLD_KEYS) { const v = nestedString(item[key]); if (v !== undefined) { oldText = v; break; } }
  for (const key of NEW_KEYS) { const v = nestedString(item[key]); if (v !== undefined) { newText = v; break; } }
  if (newText === undefined) newText = inherited;
  if (oldText === undefined || oldText.length === 0) throw new Error(`Edit ${index + 1} is missing its original text anchor. Use oldText. Received keys: ${Object.keys(item).join(', ') || '(none)'}.`);
  if (newText === undefined) throw new Error(`Edit ${index + 1} is missing replacement text. Supply newText (an empty string means intentional deletion). The extension will not guess replacement code. Received edit keys: ${Object.keys(item).join(', ') || '(none)'}.`);
  return { oldText, newText };
}

function optionalGlob(args: ToolArguments): string | undefined {
  const explicit = firstString(args, ['glob'], 500);
  if (explicit !== undefined) return explicit;
  const folder = firstString(args, ['path'], 500);
  if (folder === undefined) return undefined;
  const normalized = folder.replace(/[\/]+$/, '');
  return /[*?{}\[\]]/.test(normalized) ? normalized : `${normalized}/**/*`;
}

function validateRelativePath(value: unknown, label = 'path'): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Missing or invalid required argument: ${label}.`);
  if (value.length > 1024) throw new Error(`Argument ${label} exceeds the 1024-character limit.`);
  return value;
}

export type ValidatedToolCall =
 | { name:'list_workspace_files'; args:{glob?:string;limit?:number;offset?:number} }
 | { name:'read_file'; args:{path:string;limit?:number;offset?:number} }
 | { name:'get_active_editor_context'; args:{path?:string} }
 | { name:'search_workspace'; args:{query:string;glob?:string;limit?:number;offset?:number} }
 | { name:'propose_file_edit'; args:{path:string;summary:string;edits?:ValidatedEdit[];createContent?:string} }
 | { name:'create_folder'|'delete_file'|'delete_folder'; args:{path:string;summary:string} }
 | { name:'git_manager'; args:{action:typeof GIT_ACTIONS[number];path?:string;paths?:string[];branch?:string;newBranch?:string;message?:string;remote?:string;url?:string;ref?:string;all?:boolean;force?:boolean;limit?:number} }
 | { name:'run_terminal_command'; args:{command:string;reason:string;path?:string} };

const KNOWN_TOOLS = new Set<ToolName>(['list_workspace_files','read_file','get_active_editor_context','search_workspace','propose_file_edit','create_folder','delete_file','delete_folder','git_manager','run_terminal_command']);

export function parseToolArguments(raw: string): ToolArguments {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
    for (let depth = 0; depth < 3; depth++) {
      if (typeof parsed === 'string') { parsed = JSON.parse(parsed); continue; }
      if (isRecord(parsed)) {
        const nested = parsed.arguments ?? parsed.input ?? parsed.parameters;
        if (typeof nested === 'string') { parsed = JSON.parse(nested); continue; }
        if (isRecord(nested)) { parsed = nested; continue; }
      }
      break;
    }
  } catch (error: unknown) { throw new Error(`Malformed tool-call JSON: ${error instanceof Error ? error.message : String(error)}`); }
  return record(parsed);
}

export function validateToolArguments(name: string, value: unknown): ValidatedToolCall {
  if (!KNOWN_TOOLS.has(name as ToolName)) throw new Error(`Unsupported tool name: ${name || '(empty)'}.`);
  const args = record(value);
  switch (name as ToolName) {
    case 'list_workspace_files': {
      assertKeys(args,['glob','path','limit','offset']);
      return {name:'list_workspace_files',args:{glob:optionalGlob(args),limit:optionalLimit(args,'limit',150),offset:optionalOffset(args,'offset')}};
    }
    case 'read_file': {
      assertKeys(args,['path','filePath','file_path','limit','offset']);
      return {name:'read_file',args:{path:validateRelativePath(firstString(args,PATH_KEYS,1024,true)),limit:optionalLimit(args,'limit',2000),offset:optionalOffset(args,'offset')}};
    }
    case 'get_active_editor_context': {
      assertKeys(args,['path','limit','offset']);
      const path = firstString(args,['path'],1024);
      return {name:'get_active_editor_context',args:{path}};
    }
    case 'search_workspace': {
      assertKeys(args,['query','glob','path','limit','offset']);
      return {name:'search_workspace',args:{query:firstString(args,['query'],2000,true)!,glob:optionalGlob(args),limit:optionalLimit(args,'limit',60),offset:optionalOffset(args,'offset')}};
    }
    case 'propose_file_edit': {
      const allowed = [...PATH_KEYS,...SUMMARY_KEYS,'edits','createContent','limit','offset',...OLD_KEYS,...NEW_KEYS];
      assertKeys(args,allowed);
      const filePath = validateRelativePath(firstString(args,PATH_KEYS,1024,true));
      const summary = firstString(args,SUMMARY_KEYS,2000) || 'File change proposed by Nemotron';
      let rawEdits: unknown = args.edits;
      let rawContent: unknown = args.createContent;
      if (typeof rawEdits === 'string') {
        try { rawEdits = JSON.parse(rawEdits); } catch { throw new Error('edits must be a JSON array or edit object.'); }
      }
      if (isRecord(rawEdits)) rawEdits = [rawEdits];
      if (rawContent === null) rawContent = undefined;
      if (Array.isArray(rawEdits) && rawEdits.length === 0 && typeof rawContent !== 'string') rawEdits = undefined;
      // Normalize the frequent single-edit shape: {path, oldText, newText}.
      if ((rawEdits === undefined || (Array.isArray(rawEdits) && rawEdits.length === 0)) && OLD_KEYS.some(k => typeof args[k] === 'string')) {
        rawEdits = [Object.fromEntries([...OLD_KEYS,...NEW_KEYS].filter(k => args[k] !== undefined).map(k => [k,args[k]]))];
      }
      // Some providers call new-file content `content`, `text`, or `newContent`.
      if (rawContent === undefined && rawEdits === undefined && !OLD_KEYS.some(k => typeof args[k] === 'string')) {
        rawContent = firstString(args,['newContent','new_content','content','body','text'],MAX_CREATE_CONTENT_CHARS);
      }
      // Some providers include an empty createContent beside edits; treat it as absent.
      if (rawContent === '' && Array.isArray(rawEdits) && rawEdits.length > 0) rawContent = undefined;
      const editArray = Array.isArray(rawEdits) ? rawEdits : undefined;
      const hasEdits = !!editArray && editArray.length > 0;
      const hasCreate = typeof rawContent === 'string';
      if (!hasEdits && !hasCreate) throw new Error('No file operation supplied. For an existing file send edits: [{ oldText, newText }]; for a new file send createContent.');
      if (hasEdits) {
        if (!editArray || editArray.length > 20) throw new Error('edits must contain no more than 20 entries.');
        const inherited = editArray.length === 1 ? firstString(args,NEW_KEYS,MAX_PATCH_TEXT_CHARS) : undefined;
        const edits: ValidatedEdit[] = editArray.map((item: unknown,index: number) => {
          if (!isRecord(item)) throw new Error(`Edit ${index+1} must be an object.`);
          assertKeys(item,[...OLD_KEYS,...NEW_KEYS]);
          const edit = normalizeEdit(item,index,inherited);
          if (edit.oldText.length > MAX_PATCH_TEXT_CHARS || edit.newText.length > MAX_PATCH_TEXT_CHARS) throw new Error(`Edit ${index+1} exceeds the per-field character limit.`);
          return edit;
        });
        const total = edits.reduce((n: number,e: ValidatedEdit)=>n+e.oldText.length+e.newText.length,0);
        if (total > MAX_PATCH_TOTAL_CHARS) throw new Error(`Combined edit payload exceeds ${MAX_PATCH_TOTAL_CHARS.toLocaleString()} characters.`);
        if (hasCreate && (rawContent as string).length > MAX_CREATE_CONTENT_CHARS) throw new Error(`createContent exceeds ${MAX_CREATE_CONTENT_CHARS.toLocaleString()} characters.`);
        return {name:'propose_file_edit',args:{path:filePath,summary,edits,...(hasCreate?{createContent:rawContent as string}:{})}};
      }
      if ((rawContent as string).length > MAX_CREATE_CONTENT_CHARS) throw new Error(`createContent exceeds ${MAX_CREATE_CONTENT_CHARS.toLocaleString()} characters.`);
      return {name:'propose_file_edit',args:{path:filePath,summary,createContent:rawContent as string}};
    }
    case 'create_folder': case 'delete_file': case 'delete_folder': {
      const toolName = name as 'create_folder' | 'delete_file' | 'delete_folder';
      assertKeys(args,[...PATH_KEYS,...SUMMARY_KEYS,'limit','offset']);
      optionalLimit(args,'limit',2000); optionalOffset(args,'offset');
      return {name:toolName,args:{path:validateRelativePath(firstString(args,PATH_KEYS,1024,true)),summary:firstString(args,SUMMARY_KEYS,2000)||`${toolName.replace('_',' ')} requested by Nemotron`}};
    }
    case 'git_manager': {
      assertKeys(args,['action','path','paths','branch','newBranch','message','remote','url','ref','all','force','limit','offset','description','summary']);
      const action = firstString(args,['action'],64,true) as typeof GIT_ACTIONS[number];
      if (!(GIT_ACTIONS as readonly string[]).includes(action)) throw new Error(`Unsupported git action: ${action}.`);
      const paths = args.paths;
      if (paths !== undefined && (!Array.isArray(paths) || paths.some(p=>typeof p!=='string'||!p.trim()) || paths.length>100)) throw new Error('paths must be an array of up to 100 non-empty workspace-relative paths.');
      for (const key of ['all','force'] as const) if (args[key] !== undefined && typeof args[key] !== 'boolean') throw new Error(`${key} must be a boolean.`);
      const out: Extract<ValidatedToolCall,{name:'git_manager'}>['args'] = {action};
      for (const key of ['path','branch','newBranch','message','remote','url','ref'] as const) {
        const v=firstString(args,[key],key==='message'?5000:2000); if(v!==undefined) out[key]=v;
      }
      if (paths) out.paths=paths as string[];
      if (typeof args.all==='boolean') out.all=args.all;
      if (typeof args.force==='boolean') out.force=args.force;
      const limit=optionalLimit(args,'limit',100); if(limit!==undefined) out.limit=limit; optionalOffset(args,'offset');
      return {name:'git_manager',args:out};
    }
    case 'run_terminal_command': {
      assertKeys(args,['command','reason','description','path','limit','offset']);
      const command=firstString(args,['command'],MAX_COMMAND_LENGTH,true)!;
      const reason=firstString(args,['reason','description'],2000)||'Run command proposed by Nemotron';
      const path = firstString(args,['path'],1024);
      return {name:'run_terminal_command',args:{command,reason,path}};
    }
  }
}
