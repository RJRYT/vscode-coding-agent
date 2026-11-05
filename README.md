# Nemotron Coding Agent for VS Code

A VS Code sidebar coding agent powered by NVIDIA Nemotron 3.5 Super VL 120B A12B. It can inspect your workspace, search code, propose file changes, and run approved checks/commands.

## Features

- NVIDIA NIM streaming chat with Nemotron reasoning support.
- Workspace file listing, stable-API text search, file reading, and active-editor/selection context.
- Agent tool-calling loop (up to the configured tool-round limit).
- File creation/updates are previewed and require your approval.
- Terminal commands require your approval and run from the workspace root.
- NVIDIA API key is stored using VS Code Secret Storage, not in webview JavaScript or settings.
- Configurable model endpoint, output-token budget, reasoning mode, and tool-call limit.

## Requirements

- VS Code 1.95 or newer.
- Node.js 20 or newer for building the extension.
- An NVIDIA API key with access to the configured NVIDIA NIM model.
- An opened local workspace folder (the agent does not operate without a workspace).

## Run the extension in development

1. Extract this project and open the `nemotron-vscode-agent` folder in VS Code.
2. Open a terminal in that folder and install dependencies:

   ```bash
   npm install
   ```

3. Compile the TypeScript:

   ```bash
   npm run compile
   ```

4. Press `F5` in VS Code to launch an Extension Development Host.
5. Open a project folder in the new VS Code window.
6. Open **Nemotron Agent** from the Activity Bar.
7. Click **Key** or run **Nemotron Agent: Set NVIDIA API Key**, then paste your NVIDIA API key.
8. Ask the agent to inspect, explain, debug, or modify your project.

## Package as a VSIX

Install dependencies first, then run:

```bash
npm run compile
npx vsce package
```

This creates `nemotron-coding-agent-0.1.1.vsix`. In VS Code, use **Extensions: Install from VSIX...** to install it.

## Settings

| Setting | Default | Purpose |
|---|---|---|
| `nemotronAgent.model` | `nvidia/nemotron-3.5-super-vl-120b-a12b` | NVIDIA model ID |
| `nemotronAgent.baseUrl` | `https://integrate.api.nvidia.com/v1` | OpenAI-compatible API base URL |
| `nemotronAgent.maxTokens` | `16384` | Maximum output tokens per model turn; reasoning tokens count toward this limit |
| `nemotronAgent.reasoning` | `true` | Enable Nemotron thinking |
| `nemotronAgent.maxToolRounds` | `8` | Maximum agent tool-call rounds per user request |

## Safety model

- Reading workspace files and searching workspace text are read-only.
- File edits and terminal commands are disabled until the VS Code workspace is trusted.
- `propose_file_edit` displays current/proposed content and pauses until you approve or reject.
- `run_terminal_command` displays the command and pauses until you approve or reject. Approved commands execute with the workspace root as the working directory and a 120-second timeout.
- A small set of file-writing, dependency-install, secret-dump, and destructive command patterns is blocked. Approval is still required for every terminal command.
- The extension intentionally does not expose an arbitrary shell tool or a direct delete-file tool.

Review every proposed change and command before approving it. Commands can still have effects beyond the workspace depending on the shell and installed tools. Stop cancels model requests and pending approvals, but an already-approved shell process may continue until it exits or reaches its timeout.

## Current limitations

This is a functional first version, not a one-to-one clone of Codex. It currently uses full-file replacement proposals rather than structured patch hunks, has no built-in Git diff/revert UI, and does not persist conversation history across VS Code restarts. It targets desktop VS Code; browser-based VS Code environments do not support its Node child-process command runner.

## API details

The extension calls NVIDIA's OpenAI-compatible Chat Completions endpoint directly from the VS Code extension host. The model ID, endpoint, recommended sampling values, streaming and reasoning fields are configured in `src/extension.ts`.


### Search implementation note

Workspace text search uses the stable `workspace.findFiles` and `workspace.fs.readFile` APIs, with per-file and total scan limits. It does not depend on proposed VS Code APIs.
