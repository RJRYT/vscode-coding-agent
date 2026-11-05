# Nemotron Coding Agent for VS Code

A VS Code workspace coding agent powered by NVIDIA Nemotron 3.5 Super VL 120B A12B. It can inspect your project, search code, prepare targeted patches, and run approved checks.

## 0.2.2 webview startup fix

- Fixed a critical startup bug in the embedded webview script. HTML is now built with `String.raw`, preserving regular-expression and string escapes in the inline JavaScript. Without this, the Markdown link matcher became an invalid regular expression at runtime, preventing **all** UI event handlers from registering and leaving the chat-history screen unresponsive.
- Added a separate startup error monitor that can display a visible banner even when the main webview script fails to parse.
- Verified the generated webview in Chromium: ready handshake, New Chat, Settings, API-key action, Back navigation, Send, and loading a saved chat all work without browser runtime errors. An intentionally broken main script also triggers the visible startup error banner.

## What is new in 0.2.0

- **Targeted edits instead of whole-file replacement.** Existing files are changed only through exact `oldText` → `newText` anchors. Every anchor must match exactly once. Missing, duplicated, overlapping, overly broad, or stale patches are rejected.
- **No implicit save of unsaved work.** The agent refuses to edit a dirty editor buffer. Save your own changes first.
- **Approval before changes.** The extension shows only the changed sections, asks for approval, then applies all edits as one undoable VS Code WorkspaceEdit transaction.
- **Staged edit progress.** After approval, the UI shows patch staging, application, saving, and disk verification so there is visible activity instead of a silent pause.
- **Post-save verification.** The extension checks the editor and saved file against the approved patch before reporting success.
- **Single-screen chat navigation.** Chat history is shown as a separate screen. Opening or creating a chat hides the list; the back arrow returns to chats. The NVIDIA API key controls are in Settings.
- NVIDIA streaming chat and reasoning, workspace browsing, text search, active editor context, and approved terminal checks remain available.

## Requirements

- VS Code 1.95 or newer.
- Node.js 20 or newer for building the extension.
- An NVIDIA API key with access to the configured NVIDIA NIM model.
- An opened, trusted local workspace folder.

## Run in development

1. Extract this project and open its folder in VS Code.
2. Install dependencies:

   ```bash
   npm install
   ```

3. Compile:

   ```bash
   npm run compile
   ```

4. Press `F5` to launch an Extension Development Host.
5. Open a project folder, then open **Nemotron Agent** from the Activity Bar.
6. Open Settings in the extension and set your NVIDIA API key. It is stored in VS Code Secret Storage.

## Package as a VSIX

```bash
npm install
npm run compile
npx vsce package
```

Install the generated VSIX through **Extensions → Install from VSIX...**.

## Safety behaviour for file edits

The model cannot replace an existing file with a generated full-file string. For an existing file it must provide a list of exact, unique text anchors. The extension validates all anchors against one source snapshot before showing an approval preview. It rejects:

- Anchors that do not exist or occur more than once.
- Overlapping edit ranges.
- Broad/whole-file replacements.
- A file that has unsaved editor changes.
- A file that changes while the approval dialog is open.
- Edits outside the trusted workspace or edits to detected secret files.

After approval, individual changes are staged in the UI. The actual file update is committed as **one atomic, undoable VS Code edit**, rather than writing partial file contents chunk by chunk. This is intentional: streaming incomplete source text directly to disk can leave a broken file if the extension or editor closes mid-write. The extension then saves and verifies the final file.

New files can still be created with `createContent`, but only when the target path does not already exist and after explicit approval.

## Other tool safety

- Workspace reads and search are read-only.
- Terminal commands require approval and run in the workspace root.
- A limited set of file-writing, dependency-install, secret-dump, and destructive command patterns is blocked.
- The extension does not expose arbitrary shell or direct delete-file tools.

Review every approved patch and command. Commands can still have effects beyond the workspace depending on the shell and installed tools.

## Settings

| Setting | Default | Purpose |
|---|---|---|
| `nemotronAgent.model` | `nvidia/nemotron-3.5-super-vl-120b-a12b` | NVIDIA model ID |
| `nemotronAgent.baseUrl` | `https://integrate.api.nvidia.com/v1` | OpenAI-compatible API base URL |
| `nemotronAgent.maxTokens` | `16384` | Maximum output tokens per model turn; reasoning tokens count toward this limit |
| `nemotronAgent.reasoning` | `true` | Enable Nemotron thinking |
| `nemotronAgent.maxToolRounds` | `8` | Maximum consecutive tool-call rounds per request |

## Current limitations

This is not full Codex parity. Patch application is exact-anchor based rather than an interactive Git diff editor. It refuses to make edits when the target editor has unsaved changes. The workspace search is bounded and may skip large files. It targets desktop VS Code; browser-based VS Code environments may not support the Node child-process command runner.


## 0.2.1 stability update

- Removed the runtime dependency on jsDelivr/remote Markdown scripts. The webview now renders basic Markdown locally, so its startup and button handlers do not depend on external network availability.
- Added a visible in-panel error banner and extension-host error notifications for webview/runtime failures.
- Registered the webview message listener before setting its HTML to avoid losing the initial ready handshake.
