# Nemotron Coding Agent for VS Code

A VS Code workspace coding agent powered by NVIDIA Nemotron 3.5 Super VL 120B A12B. It can inspect your project, search code, prepare targeted patches, and run approved checks.

## 0.2.20 file-edit reliability update

- `read_file` now prefers the live VS Code text-document buffer for files already open, including unsaved editor changes. The patch tool and reader therefore work from the same in-memory snapshot.
- Exact patch anchors now tolerate CRLF/LF-only differences. Replacement line endings are converted to the target file's dominant style; indentation and code content are never fuzzy-matched.
- Tool argument normalization accepts common provider aliases such as `new_text`, `replacement`, `replacementText`, `after`, and `content`, while keeping `newText` canonical.
- A missing replacement is still rejected rather than interpreted as an empty string, preventing accidental deletion. Explicit `newText: ""` remains a valid deletion.
- Unmatched-anchor errors now explain that the current snapshot may have changed and instruct the agent to reread the file before rebuilding the patch.

## 0.2.15 maintainability and extensibility update

- Added a visible assistant loading state and clearer transitions while thinking, running tools, waiting for approval, applying edits, stopping, and completing requests.
- Tool calls and their results are saved with the conversation and reconstructed when a chat is reopened. Chat persistence now uses an in-memory workspace cache and ordered writes to avoid dropping tool history during rapid updates.
- File and command approval actions are docked directly above the composer. File changes are shown inline in the conversation as red removed lines and green added lines.
- Pending approval cards are restored after a webview refresh while the extension host remains alive. Cancelling a request also clears its pending approval instead of leaving it stuck.
- Relaxed command validation for common development and inspection commands while retaining explicit approval and blocks for destructive operations, shell chaining, inline scripts, and secret-file access.
- Expanded exact-match editing limits to support larger focused changes. Dirty editor buffers can be patched against their live snapshot; the approval explains that existing unsaved changes will also be saved. Stale editor or disk changes still reject the patch.
- Added dropdown personalization for persona, tone, technical focus, response language, and code style. These preferences are now injected into the system prompt.

## 0.2.2 webview startup fix

- Fixed a critical startup bug in the embedded webview script. HTML is now built with `String.raw`, preserving regular-expression and string escapes in the inline JavaScript. Without this, the Markdown link matcher became an invalid regular expression at runtime, preventing **all** UI event handlers from registering and leaving the chat-history screen unresponsive.
- Added a separate startup error monitor that can display a visible banner even when the main webview script fails to parse.
- Verified the generated webview in Chromium: ready handshake, New Chat, Settings, API-key action, Back navigation, Send, and loading a saved chat all work without browser runtime errors. An intentionally broken main script also triggers the visible startup error banner.

## What is new in 0.2.0

- **Targeted edits instead of whole-file replacement.** Existing files are changed only through exact `oldText` → `newText` anchors. Every anchor must match exactly once. Missing, duplicated, overlapping, overly broad, or stale patches are rejected.
- **Dirty-buffer preservation.** The agent patches the live editor snapshot, preserving existing unsaved changes. The approval card warns that approving the patch also saves those existing changes.
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

The model cannot replace an existing file with a generated full-file string. For an existing file it must provide a list of exact, unique text anchors. The extension validates all anchors against one source snapshot before showing an inline diff and approval controls. It rejects:

- Anchors that do not exist or occur more than once.
- Overlapping edit ranges.
- Broad/whole-file replacements.
- A file whose editor version or on-disk contents change while approval is pending.
- A file that changes while the approval dialog is open.
- Edits outside the trusted workspace or edits to detected secret files.

After approval, individual changes are staged in the UI. The actual file update is committed as **one atomic, undoable VS Code edit**, rather than writing partial file contents chunk by chunk. This is intentional: streaming incomplete source text directly to disk can leave a broken file if the extension or editor closes mid-write. The extension then saves and verifies the final file.

New files can still be created with `createContent`, but only when the target path does not already exist and after explicit approval.

## Other tool safety

- Workspace reads and search are read-only.
- Terminal commands require approval and run in the workspace root.
- A limited set of file-writing, dependency-install, secret-dump, and destructive command patterns is blocked.
- The extension does not expose direct delete-file tools or allow shell command chaining. Approved development commands run as a single command.

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

This is not full Codex parity. Patch application is exact-anchor based and the approval diff is a preview, not a fully interactive Git diff editor. Pending approval UI can be restored after a webview refresh while the extension host remains alive; a full extension-host restart cancels in-flight operations. The workspace search is bounded and may skip large files. It targets desktop VS Code; browser-based VS Code environments may not support the Node child-process command runner.


## 0.2.1 stability update

- Removed the runtime dependency on jsDelivr/remote Markdown scripts. The webview now renders basic Markdown locally, so its startup and button handlers do not depend on external network availability.
- Added a visible in-panel error banner and extension-host error notifications for webview/runtime failures.
- Registered the webview message listener before setting its HTML to avoid losing the initial ready handshake.


## Architecture and maintainability updates

- `resources/webview.html` contains the webview markup, styles, and client script. The extension injects a per-view CSP and script nonce at runtime.
- `resources/system-prompt.md` contains the engineering system prompt. `AgentLoop` fills only explicit workspace/persona/preference/memory placeholders.
- `ChatManager` owns chat metadata and persistence coordination; `ToolDispatcher` validates and routes tool calls; `ContextCollector` adapts context capture and formatting.
- `toolValidation.ts` centralizes tool name, shape, required-field, and size validation without adding a schema dependency.
- `ContextSourceRegistry` allows extensions or future built-in modules to register additional opt-in context sources. Register a source with `contextSources.register({ id, label, maxChars, collect })`; dispose the returned `vscode.Disposable` to unregister it. Registered sources automatically appear in the composer context menu and are collected only when selected.
- `AgentLogger` writes structured JSON events to the **Nemotron Agent** Output Channel. Search skips and failed edits/commands include actionable metadata without logging file contents or secrets.
- `ChatStore.flush()` can be awaited by tests or shutdown-sensitive flows to wait for queued workspace-state writes.

No runtime dependency was added for validation or logging.

### Additional tests

New tests cover centralized tool validation and dispatch, chat metadata behavior, workspace-state persistence, model SSE parsing, and pluggable context sources. Run `npm test`, `npm run lint`, and `npm run compile` in an environment with the lockfile dependencies installed.


### 0.2.15 implementation notes

This release extracts the webview and engineering prompt into runtime resources, introduces typed webview and tool argument boundaries, separates chat persistence/context collection/tool dispatch into focused modules, adds structured output-channel diagnostics, and expands unit coverage for storage, model streaming, validation, and dispatch. Failed new-file writes are compensated only when the file still matches the agent-created payload; failed editor saves attempt a guarded in-memory rollback.


## v0.2.17 reliability changes

- Removed the separate hard cap on individual tool calls. The configurable model tool-round setting remains available (default 100, maximum 200).
- Terminal commands now support shell chaining, pipes, redirection, command substitution, multiline scripts, and normal project commands. Every command still requires explicit approval and a trusted VS Code workspace. Commands run with the current user's OS permissions and are not sandboxed.
- Increased file read, edit, and resulting-file limits to 50 MB; patch fields support up to 50 million characters with an aggregate patch payload budget.
- Exact full-file snapshot replacements are now allowed when `oldText` exactly matches the current file; the approval and stale-snapshot checks still apply.
- Increased terminal command length to 20,000 characters, no automatic command timeout (the user can stop the active request), and output buffer to 10 MB.


## v0.2.18 large file-edit payload fix

- Removed `maxLength` from the `oldText`, `newText`, and `createContent` tool JSON schema fields. Provider-side tool-schema validation no longer enforces the obsolete 5-million-character cap.
- Runtime validation now accepts up to 50 million characters per patch field and 50 million characters combined across one patch request.
- File read, edit, and resulting-file byte limits are aligned at 50 MB.
- `newText` validation now distinguishes a missing/non-string value from an oversized string and reports the actual received character count. Empty `newText` remains valid for deleting an exact matched anchor.
- Added regression coverage for a replacement larger than 5 million characters.
