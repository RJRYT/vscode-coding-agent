import type * as vscode from 'vscode';

export type LogLevel = 'info' | 'warn' | 'error';
export interface LogRecord {
  event: string;
  level?: LogLevel;
  details?: Record<string, string | number | boolean | null | undefined>;
}

/** Small structured logger backed by a dedicated VS Code Output Channel. */
export class AgentLogger implements vscode.Disposable {
  constructor(private readonly output: vscode.OutputChannel) {}

  write(record: LogRecord): void {
    const payload = {
      timestamp: new Date().toISOString(),
      level: record.level ?? 'info',
      event: record.event,
      ...(record.details ? { details: record.details } : {}),
    };
    const line = JSON.stringify(payload);
    if (payload.level === 'error') this.output.appendLine(`[ERROR] ${line}`);
    else if (payload.level === 'warn') this.output.appendLine(`[WARN] ${line}`);
    else this.output.appendLine(line);
  }

  dispose(): void { this.output.dispose(); }
}
