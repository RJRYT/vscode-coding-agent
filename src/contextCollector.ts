import { collectWorkspaceContext, formatWorkspaceContext, normalizeContextOptions } from './context';
import type { ContextOptions, WorkspaceContext } from './context';

/** Adapter isolates context collection/formatting from the agent conversation loop. */
export class ContextCollector {
  normalize(options: unknown): ContextOptions { return normalizeContextOptions(options); }

  async capture(options: unknown): Promise<WorkspaceContext> {
    try { return await collectWorkspaceContext(this.normalize(options)); }
    catch (error: unknown) {
      return {
        capturedAt: new Date().toISOString(),
        included: [],
        unavailable: [`Workspace context collection failed: ${error instanceof Error ? error.message : String(error)}`],
      };
    }
  }

  format(snapshot: WorkspaceContext): string { return formatWorkspaceContext(snapshot); }
}
