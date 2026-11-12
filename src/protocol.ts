import type { ApprovalPayload } from './config';
import type { ApprovalDecision } from './tools';

/** Runtime-validated message envelope received from the untrusted webview. */
export interface WebviewMessage extends Record<string, unknown> {
  type: string;
  id?: unknown;
  text?: unknown;
  chatId?: unknown;
  contextOptions?: unknown;
  title?: unknown;
  enabled?: unknown;
  model?: unknown;
  baseUrl?: unknown;
  maxTokens?: unknown;
  maxToolRounds?: unknown;
  autoSaveChats?: unknown;
  persona?: unknown;
  tone?: unknown;
  expertise?: unknown;
  responseLanguage?: unknown;
  codeStyle?: unknown;
}

export interface PendingApproval {
  resolve: (decision: ApprovalDecision) => void;
  timeout: NodeJS.Timeout;
  payload: ApprovalPayload;
  signal?: AbortSignal;
  onAbort?: () => void;
}

export function isWebviewMessage(value: unknown): value is WebviewMessage {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    typeof (value as Record<string, unknown>).type === 'string'
  );
}
