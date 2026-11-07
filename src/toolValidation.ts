import { MAX_PATCH_TEXT_CHARS, MAX_PATCH_TOTAL_CHARS, MAX_CREATE_CONTENT_CHARS, MAX_COMMAND_LENGTH } from './limits';

export type ToolName =
  | 'list_workspace_files'
  | 'read_file'
  | 'get_active_editor_context'
  | 'search_workspace'
  | 'propose_file_edit'
  | 'run_terminal_command';

export interface ValidatedEdit { oldText: string; newText: string }

/**
 * Model providers occasionally emit equivalent edit fields with different
 * casing/names. Normalize those variants at the boundary, but never guess an
 * omitted replacement (which could accidentally delete code).
 */
function normalizeEditFields(item: ToolArguments, index: number, inheritedReplacement?: string, parentKeys: string[] = []): ValidatedEdit {
  const oldKeys = ['oldText', 'oldtext', 'old_text', 'originalText', 'original_text', 'original', 'search', 'find', 'old_content', 'old_code', 'before', 'old'];
  const newKeys = ['newText', 'newtext', 'new_text', 'replacement', 'replacementText', 'replacement_text', 'replacement_content', 'replacementContent', 'updatedText', 'updated_text', 'newContent', 'new_content', 'replaceWith', 'replace_with', 'replace', 'afterText', 'after_text', 'after', 'insertText', 'insert_text', 'insert', 'value', 'text', 'content', 'body', 'replacementValue', 'new_value', 'new'];
  const pickString = (keys: string[]): string | undefined => {
    for (const key of keys) {
      if (typeof item[key] === 'string') return item[key] as string;
      if (isRecord(item[key])) {
        const nested = item[key] as ToolArguments;
        for (const nestedKey of ['text', 'content', 'value', 'code']) {
          if (typeof nested[nestedKey] === 'string') return nested[nestedKey] as string;
        }
      }
    }
    return undefined;
  };
  const oldText = pickString(oldKeys);
  const newText = pickString(newKeys) ?? inheritedReplacement;
  if (oldText === undefined || oldText.length === 0) {
    throw new Error(`Edit ${index + 1} is missing its original text anchor. Use oldText. Received keys: ${Object.keys(item).join(', ') || '(none)'}.`);
  }
  if (newText === undefined) {
    throw new Error(`Edit ${index + 1} is missing replacement text. Supply a string newText on this edit (or a top-level newText when there is exactly one edit). Received edit keys: ${Object.keys(item).join(', ') || '(none)'}; parent keys: ${parentKeys.join(', ') || '(none)'}. If this is a deletion, explicitly send newText: \"\". The extension will not guess replacement code.`);
  }
  return { oldText, newText };
}
export type ValidatedToolCall =
  | { name: 'list_workspace_files'; args: { glob?: string; limit?: number; offset?: number } }
  | { name: 'read_file'; args: { path: string; limit?: number; offset?: number } }
  | { name: 'get_active_editor_context'; args: Record<string, never> }
  | { name: 'search_workspace'; args: { query: string; glob?: string; limit?: number; offset?: number } }
  | { name: 'propose_file_edit'; args: { path: string; summary: string; edits: ValidatedEdit[] } | { path: string; summary: string; createContent: string } }
  | { name: 'run_terminal_command'; args: { command: string; reason: string } };

export type ToolArguments = Record<string, unknown>;

const KNOWN_TOOLS = new Set<ToolName>([
  'list_workspace_files', 'read_file', 'get_active_editor_context',
  'search_workspace', 'propose_file_edit', 'run_terminal_command',
]);

function isRecord(value: unknown): value is ToolArguments {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function record(value: unknown): ToolArguments {
  if (!isRecord(value)) throw new Error('Tool arguments must be a JSON object.');
  return value;
}

function assertKeys(args: ToolArguments, allowed: string[]): void {
  const unexpected = Object.keys(args).filter((key) => !allowed.includes(key));
  if (unexpected.length) throw new Error(`Unexpected tool argument(s): ${unexpected.join(', ')}.`);
}

function requiredString(args: ToolArguments, key: string, max = 20_000): string {
  const value = args[key];
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Missing or invalid required argument: ${key}.`);
  if (value.length > max) throw new Error(`Argument ${key} exceeds the ${max}-character limit.`);
  return value;
}

function optionalString(args: ToolArguments, key: string, max = 20_000): string | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new Error(`Argument ${key} must be a string.`);
  if (value.length > max) throw new Error(`Argument ${key} exceeds the ${max}-character limit.`);
  return value;
}

function optionalLimit(args: ToolArguments, key: string, max: number): number | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > max) {
    throw new Error(`Argument ${key} must be an integer between 1 and ${max}.`);
  }
  return Number(value);
}


function optionalOffset(args: ToolArguments, key: string): number | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (!Number.isInteger(value) || Number(value) < 0 || Number(value) > 100_000) {
    throw new Error(`Argument ${key} must be an integer between 0 and 100000.`);
  }
  return Number(value);
}

export function parseToolArguments(raw: string): ToolArguments {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
    // Some OpenAI-compatible gateways wrap the actual arguments in another
    // JSON string or an `arguments`/`input` envelope. Unwrap only recognized
    // protocol envelopes; never coerce arbitrary values into empty objects.
    for (let depth = 0; depth < 2; depth++) {
      if (typeof parsed === 'string') {
        parsed = JSON.parse(parsed);
        continue;
      }
      if (isRecord(parsed)) {
        const nested = parsed.arguments ?? parsed.input;
        if (typeof nested === 'string') {
          parsed = JSON.parse(nested);
          continue;
        }
      }
      break;
    }
  } catch (error: unknown) {
    throw new Error(`Malformed tool-call JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  return record(parsed);
}

export function validateToolArguments(name: string, value: unknown): ValidatedToolCall {
  if (!KNOWN_TOOLS.has(name as ToolName)) throw new Error(`Unsupported tool name: ${name || '(empty)'}.`);
  const args = record(value);
  switch (name as ToolName) {
    case 'list_workspace_files':
      assertKeys(args, ['glob', 'limit', 'offset']);
      return { name: 'list_workspace_files', args: { glob: optionalString(args, 'glob', 500), limit: optionalLimit(args, 'limit', 150), offset: optionalOffset(args, 'offset') } };
    case 'read_file':
      assertKeys(args, ['path', 'limit', 'offset']);
      return { name: 'read_file', args: { path: requiredString(args, 'path', 1024), limit: optionalLimit(args, 'limit', 2000), offset: optionalOffset(args, 'offset') } };
    case 'get_active_editor_context':
      assertKeys(args, []);
      return { name: 'get_active_editor_context', args: {} };
    case 'search_workspace':
      assertKeys(args, ['query', 'glob', 'limit', 'offset']);
      return { name: 'search_workspace', args: { query: requiredString(args, 'query', 2000), glob: optionalString(args, 'glob', 500), limit: optionalLimit(args, 'limit', 60), offset: optionalOffset(args, 'offset') } };
    case 'propose_file_edit': {
      assertKeys(args, ['path', 'summary', 'edits', 'createContent', 'newText', 'newtext', 'new_text', 'replacement', 'replacementText', 'replacement_text', 'replacement_content', 'replacementContent', 'updatedText', 'updated_text', 'newContent', 'new_content', 'replaceWith', 'replace_with', 'replace', 'afterText', 'after_text', 'after', 'insertText', 'insert_text', 'insert', 'value', 'text', 'content', 'body', 'replacementValue', 'new_value', 'new']);
      const filePath = requiredString(args, 'path', 1024);
      const summary = requiredString(args, 'summary', 2000);
      const rawEdits = args.edits;
      const rawContent = args.createContent;
      const hasEdits = Array.isArray(rawEdits);
      const hasCreate = typeof rawContent === 'string';
      if (hasEdits === hasCreate) throw new Error('Provide exactly one of edits (existing file) or createContent (new file).');
      if (hasEdits) {
        if (!rawEdits.length || rawEdits.length > 20) throw new Error('edits must contain between 1 and 20 entries.');
        let totalPatchChars = 0;
        const inheritedReplacement = rawEdits.length === 1
          ? ['newText', 'newtext', 'new_text', 'replacement', 'replacementText', 'replacement_text', 'replacement_content', 'replacementContent', 'updatedText', 'updated_text', 'newContent', 'new_content', 'replaceWith', 'replace_with', 'replace', 'afterText', 'after_text', 'after', 'insertText', 'insert_text', 'insert', 'value', 'text', 'content', 'body', 'replacementValue', 'new_value', 'new'].map((key) => args[key]).find((candidate): candidate is string => typeof candidate === 'string')
          : undefined;
        const edits: ValidatedEdit[] = rawEdits.map((item, index) => {
          if (!isRecord(item)) throw new Error(`Edit ${index + 1} must be an object.`);
          assertKeys(item, ['oldText', 'oldtext', 'old_text', 'originalText', 'original_text', 'original', 'search', 'find', 'old_content', 'old_code', 'before', 'old', 'newText', 'newtext', 'new_text', 'replacement', 'replacementText', 'replacement_text', 'replacement_content', 'replacementContent', 'updatedText', 'updated_text', 'newContent', 'new_content', 'replaceWith', 'replace_with', 'replace', 'afterText', 'after_text', 'after', 'insertText', 'insert_text', 'insert', 'value', 'text', 'content', 'body', 'replacementValue', 'new_value', 'new']);
          const normalized = normalizeEditFields(item, index, inheritedReplacement, Object.keys(args));
          const oldText = normalized.oldText;
          const newText = normalized.newText;
          if (oldText.length > MAX_PATCH_TEXT_CHARS) {
            throw new Error(`Edit ${index + 1} oldText is ${oldText.length.toLocaleString()} characters; the per-edit maximum is ${MAX_PATCH_TEXT_CHARS.toLocaleString()}.`);
          }
          if (newText.length > MAX_PATCH_TEXT_CHARS) {
            throw new Error(`Edit ${index + 1} newText is ${newText.length.toLocaleString()} characters; the per-edit maximum is ${MAX_PATCH_TEXT_CHARS.toLocaleString()}.`);
          }
          totalPatchChars += oldText.length + newText.length;
          if (totalPatchChars > MAX_PATCH_TOTAL_CHARS) {
            throw new Error(`The combined oldText/newText payload is ${totalPatchChars.toLocaleString()} characters; the request maximum is ${MAX_PATCH_TOTAL_CHARS.toLocaleString()}. Split the file changes into separate tool calls.`);
          }
          return { oldText, newText };
        });
        return { name: 'propose_file_edit', args: { path: filePath, summary, edits } };
      }
      if (typeof rawContent !== 'string') throw new Error('createContent is missing or is not a string.');
      if (rawContent.length > MAX_CREATE_CONTENT_CHARS) throw new Error(`createContent is ${rawContent.length.toLocaleString()} characters; the maximum is ${MAX_CREATE_CONTENT_CHARS.toLocaleString()}.`);
      return { name: 'propose_file_edit', args: { path: filePath, summary, createContent: rawContent } };
    }
    case 'run_terminal_command':
      assertKeys(args, ['command', 'reason']);
      return { name: 'run_terminal_command', args: { command: requiredString(args, 'command', MAX_COMMAND_LENGTH), reason: requiredString(args, 'reason', 2000) } };
  }
}
