import * as vscode from 'vscode';
export { MAX_COMMAND_LENGTH, MAX_CREATE_CONTENT_CHARS, MAX_PATCH_TEXT_CHARS } from './limits';

export const API_KEY_SECRET = 'nemotronAgent.nvidiaApiKey';
export const MODEL_DEFAULT = 'nvidia/nemotron-3.5-super-vl-120b-a12b';
export const BASE_URL_DEFAULT = 'https://integrate.api.nvidia.com/v1';
export const MAX_TOKENS_DEFAULT = 16384;
export const REASONING_DEFAULT = true;
export const MAX_TOOL_ROUNDS_DEFAULT = 100;

export const EXCLUDES =
  '**/{node_modules,.git,dist,build,out,.next,coverage,vendor}/**,**/.env*,**/*.{pem,key,p12,pfx}';

export const MAX_FILE_READ_BYTES = 50 * 1024 * 1024;
export const MAX_FILE_EDIT_BYTES = 50 * 1024 * 1024;
export const MAX_FILE_REPLACE_BYTES = 50 * 1024 * 1024;
export const MAX_SEARCH_FILE_BYTES = 512 * 1024;
export const MAX_SEARCH_TOTAL_BYTES = 20 * 1024 * 1024;
export const MAX_SEARCH_FILES = 2500;
export const MAX_SEARCH_RESULT_LIMIT = 60;
export const COMMAND_TIMEOUT_MS = 0; // No automatic timeout; the user can stop the active request.
export const COMMAND_MAX_BUFFER = 10 * 1024 * 1024;
export const APPROVAL_TIMEOUT_MS = 5 * 60_000;

export const MAX_CHATS = 50;
export const MAX_MEMORY_FACTS = 100;
export const DEFAULT_PERSONA = 'helpful coding assistant';

export interface NemotronAgentConfig {
  model: string;
  baseUrl: string;
  maxTokens: number;
  reasoning: boolean;
  maxToolRounds: number;
  persona: string;
  tone: string;
  expertise: string[];
  responseLanguage: string;
  codeStyle: string;
  memoryEnabled: boolean;
  autoSaveChats: boolean;
}

export interface PersonalizationConfig {
  persona: string;
  tone: string;
  expertise: string[];
  responseLanguage: string;
  codeStyle: string;
  memoryEnabled: boolean;
}

export function getNemotronAgentConfig(): NemotronAgentConfig {
  const config = vscode.workspace.getConfiguration('nemotronAgent');
  return {
    model: config.get<string>('model', MODEL_DEFAULT),
    baseUrl: config.get<string>('baseUrl', BASE_URL_DEFAULT).replace(/\/$/, ''),
    maxTokens: config.get<number>('maxTokens', MAX_TOKENS_DEFAULT),
    reasoning: config.get<boolean>('reasoning', REASONING_DEFAULT),
    maxToolRounds: config.get<number>('maxToolRounds', MAX_TOOL_ROUNDS_DEFAULT),
    persona: config.get<string>('persona', DEFAULT_PERSONA),
    tone: config.get<string>('tone', ''),
    expertise: config.get<string[]>('expertise', []),
    responseLanguage: config.get<string>('responseLanguage', 'auto'),
    codeStyle: config.get<string>('codeStyle', 'follow project conventions'),
    memoryEnabled: config.get<boolean>('memoryEnabled', true),
    autoSaveChats: config.get<boolean>('autoSaveChats', true),
  };
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | null;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
  name?: string;
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface ModelResponse {
  content: string;
  reasoning: string;
  toolCalls: ToolCall[];
}

export interface ApprovalPayload {
  id: string;
  kind: 'file' | 'command';
  title: string;
  summary: string;
  path?: string;
  oldPreview?: string;
  newPreview?: string;
  diff?: string;
  command?: string;
  patchCount?: number;
}

export interface ChatMemory {
  facts: string[];
  updatedAt: number;
}

export interface ChatSummary {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  preview: string;
}

export interface ChatData {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: ChatMessage[];
  memory?: ChatMemory;
}