import type { ToolRegistry, ToolResult } from './tools';
import { validateToolArguments } from './toolValidation';

/** Owns tool name/argument validation and dispatch, keeping AgentLoop focused on orchestration. */
export class ToolDispatcher {
  constructor(private readonly registry: ToolRegistry) {}

  async dispatch(name: string, rawArgs: unknown, signal: AbortSignal): Promise<ToolResult> {
    const call = validateToolArguments(name, rawArgs);
    switch (call.name) {
      case 'list_workspace_files':
        return this.registry.listFiles(call.args.glob, call.args.limit);
      case 'read_file':
        return this.registry.readFile(call.args.path);
      case 'get_active_editor_context':
        return this.registry.getActiveEditorContext();
      case 'search_workspace':
        return this.registry.searchWorkspace(call.args.query, call.args.glob, call.args.limit);
      case 'propose_file_edit':
        return 'edits' in call.args
          ? this.registry.proposeFileEdit(call.args.path, call.args.edits, undefined, call.args.summary, signal)
          : this.registry.proposeFileEdit(call.args.path, undefined, call.args.createContent, call.args.summary, signal);
      case 'run_terminal_command':
        return this.registry.runCommand(call.args.command, call.args.reason, signal);
    }
  }
}
