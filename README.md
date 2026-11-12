# Nemotron Coding Agent for VS Code

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![VS Code](https://img.shields.io/badge/VS%20Code-1.95%2B-blue)](https://code.visualstudio.com/)
[![Version](https://img.shields.io/badge/version-0.2.28-blue)](https://github.com/RJRYT/vscode-coding-agent/releases/tag/v0.2.28)

A workspace-aware coding assistant for VS Code, powered by NVIDIA Nemotron through an OpenAI-compatible API. Ask questions about your project, search and inspect workspace files, and propose code changes from the editor. Proposed file edits include a diff for review, and Git mutations require approval by default.

---

## Features

- **Streaming model chat** with optional reasoning and configurable model/API endpoint.
- **Workspace tools** to list and search files, read file contents, and inspect the active editor.
- **Optional editor context** for the active file, selected code, and VS Code diagnostics.
- **Reviewable edits** based on exact text anchors, with an inline diff preview before changes are applied. Edits use the live editor buffer, preserve unsaved changes, and are saved and verified after approval.
- **File and folder management** for creating and deleting workspace resources. Deletions use the operating-system trash when supported.
- **Git manager** for repository status, diffs, history, branches, commits, remotes, stashes, tags, worktrees, and other common operations. Mutations require approval by default.
- **Terminal commands** with an approval prompt by default. Commands run in the workspace with the current user's permissions.
- **Chat history** saved in VS Code workspace state and available when you return to a conversation.
- **Personalization** for persona, tone, expertise, response language, and code style.
- **Auto mode** to skip per-operation approval prompts when explicitly enabled.

---

## Setup

### Requirements

- VS Code **1.95 or newer**.
- An NVIDIA API key with access to the selected model and API endpoint.
- A trusted workspace folder for editing files, running commands, and Git write operations.
- Node.js **20 or newer** only if building the extension from source.

### Install from the VS Code Marketplace

Search for **Nemotron Coding Agent** (publisher: `rjryt`) in the VS Code Extensions view, or open:

[Nemotron Coding Agent on the Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=rjryt.nemotron-coding-agent)

### Install from a VSIX

Download the latest `.vsix` from [GitHub Releases](https://github.com/RJRYT/vscode-coding-agent/releases), then:

1. Open the Extensions view in VS Code.
2. Select **... → Install from VSIX...**.
3. Choose the downloaded extension package.

---

## Usage

### Quick start

1. Open a project folder in VS Code. Trust it if you want to enable file edits, terminal commands, and Git mutations.
2. Open **Nemotron Agent** from the Activity Bar.
3. Run **Nemotron Agent: Set NVIDIA API Key** and enter your key. It is stored using VS Code Secret Storage.
4. Start a new chat. Use the context controls to include editor or diagnostic information when it is relevant.

The extension sends your prompts and any context or tool results needed for a request to the configured model endpoint. Avoid including information you do not want sent to that provider.

### Commands

| Command                     | Title                                |
| --------------------------- | ------------------------------------ |
| `nemotronAgent.setApiKey`   | Nemotron Agent: Set NVIDIA API Key   |
| `nemotronAgent.clearApiKey` | Nemotron Agent: Clear NVIDIA API Key |
| `nemotronAgent.newChat`     | Nemotron Agent: New Chat             |
| `nemotronAgent.focus`       | Nemotron Agent: Focus Chat           |

### Configuration

All settings live under **Settings → Extensions → Nemotron Agent**.

| Setting                          | Default                                  | Purpose                                                                                         |
| -------------------------------- | ---------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `nemotronAgent.model`            | `nvidia/nemotron-3.5-super-vl-120b-a12b` | Model ID sent to the configured API.                                                            |
| `nemotronAgent.baseUrl`          | `https://integrate.api.nvidia.com/v1`    | OpenAI-compatible API base URL.                                                                 |
| `nemotronAgent.maxTokens`        | `16384`                                  | Maximum output tokens per model turn, including reasoning tokens.                               |
| `nemotronAgent.reasoning`        | `true`                                   | Enable model reasoning when supported by the selected endpoint.                                 |
| `nemotronAgent.maxToolRounds`    | `100`                                    | Maximum consecutive tool-calling rounds per request.                                            |
| `nemotronAgent.persona`          | `helpful coding assistant`               | Persona that guides the assistant.                                                              |
| `nemotronAgent.tone`             | `""`                                     | Preferred response tone, such as `concise` or `detailed`.                                       |
| `nemotronAgent.expertise`        | `[]`                                     | Areas of expertise used for personalization.                                                    |
| `nemotronAgent.responseLanguage` | `auto`                                   | Response language: `auto`, `English`, `Malayalam`, or `Hindi`.                                  |
| `nemotronAgent.codeStyle`        | `follow project conventions`             | Coding preference: project conventions, focused changes, TypeScript-first, or JavaScript-first. |
| `nemotronAgent.memoryEnabled`    | `true`                                   | Include memory guidance in the prompt; it does not inject a separate cross-chat fact store.     |
| `nemotronAgent.autoSaveChats`    | `true`                                   | Save conversation history in VS Code workspace state.                                           |
| `nemotronAgent.autoMode`         | `false`                                  | Skip per-operation approval prompts for supported tools.                                        |

### Safety and permissions

- **File edits:** Existing files are edited using exact text anchors. The extension validates anchors against a single source snapshot, rejects missing, ambiguous, overlapping, or stale edits, and displays a diff before applying changes. Approved edits are applied as one undoable VS Code workspace edit, saved, and verified.
- **Workspace boundaries:** File tools use workspace-relative paths and reject paths that resolve outside the opened workspace. Editing, terminal execution, and Git write operations require a trusted workspace.
- **Sensitive paths:** Workspace file/context tools exclude detected secret files. This is not a sandbox for shell commands: a command can access anything available to your operating-system account.
- **Terminal commands:** The exact command is shown for approval by default. Normal shell syntax, including pipes, chaining, redirection, subshells, and multiline commands, is supported. Commands run in the workspace using your current OS user permissions; review them before allowing execution.
- **Git operations:** Mutating actions require approval by default. Destructive operations such as hard reset and clean require explicit force flags.
- **Auto mode:** When enabled, supported file, terminal, and Git operations skip per-operation approval prompts. It does not bypass workspace trust or path validation. Enable it only if you are comfortable granting the assistant this level of access.
- **Remembered command approval:** **Allow** remembers the exact command for the current workspace, **Allow once** authorizes only the current operation, and **Cancel** stops it.

---

## Development

To build and test from source:

```sh
npm install
npm run compile
npm run lint
npm test
```

Use **F5** in VS Code to launch an Extension Development Host. Additional scripts include `npm run watch`, `npm run format`, `npm run format:check`, and `npm run package`.

---

## Contributing

Bug reports and contributions are welcome. Please open an issue to report a problem or discuss a proposed change, and include relevant reproduction steps where possible.

[Open an issue](https://github.com/RJRYT/vscode-coding-agent/issues) · [Browse the source](https://github.com/RJRYT/vscode-coding-agent)

## License

Distributed under the MIT License. See [LICENSE](LICENSE).

## Changelog

Release highlights are listed below, with the newest changes first. For the complete history, see the [Git commit log](https://github.com/RJRYT/vscode-coding-agent/commits/main).

### Unreleased

- Refactored tests and supporting code for clearer, more consistent coverage.

### 0.2.28

- Improved source-anchor token normalization and recovery when only whitespace differs.
- Improved diagnostics for stale edit anchors and reduced successful-edit completion feedback in Auto mode.

### 0.2.27

- Fixed the Auto mode composer toggle and synchronized its state with Settings.
- Improved accessibility and feedback for the toggle.

### 0.2.26

- Synchronized Auto mode, Thinking, Memory, and Auto-save controls between the composer and Settings.
- Updated only settings returned by partial configuration responses.

### 0.2.25

- Added the configurable Auto mode for operations that otherwise require approval.
- Strengthened edit argument validation.

### 0.2.24

- Added file and folder lifecycle tools and improved their validation.
- Added build scripts to clean generated output and copy extension resources.

### 0.2.23

- Aligned the extension runtime entry point and improved tool argument compatibility and validation.

### 0.2.22

- Improved pagination argument handling and recovery of escaped edit anchors.

### 0.2.21

- Updated TypeScript configuration and expanded coverage for tool argument edge cases.

### 0.2.20

- Improved edit reliability for open, unsaved files and normalized CRLF/LF differences.
- Accepted common replacement-field aliases while rejecting missing replacement text.

### 0.2.18

- Raised file and patch payload limits and expanded runtime validation.

### 0.2.17

- Increased file read/edit, terminal command, and output limits.
- Enabled normal shell composition, including command chaining, pipes, redirection, and multiline scripts.

### 0.2.16

- Improved patch handling and expanded tool validation tests.

### 0.2.15

- Improved chat persistence, including saving tool calls and results with conversations.
- Added a visible assistant loading state and inline approval diffs.
- Added personalization controls for persona, tone, expertise, response language, and code style.

### 0.2.6

- Added workspace context management and improved the system prompt.
- Fixed webview startup behavior and added startup error reporting.

### 0.1.10

- Added persona and memory settings and persistent chat storage.

### Earlier releases

- **0.1.7** — Updated the extension icon for improved scaling.
- **0.1.6** — Added the extension icon.
- **0.1.0** — Initial project structure and extension setup.
