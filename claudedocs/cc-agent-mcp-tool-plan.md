# Claude Bridge MCP Tool Analysis and Improvement Plan

Date: 2026-06-23

## Background

Claude Bridge exposes in-app MCP tools to Claude Code through the HTTP MCP server in `src-tauri/src/agent/cc_bridge/mcp_http.rs`.

The bridge currently has two distinct layers:

- Backend MCP tool declaration, permission scope, and event dispatch.
- Frontend execution through `src/components/agent/CcAgentBridge.tsx`.

The backend already declares more tools than the frontend actually executes. In the current frontend bridge, only these tools are implemented:

- `run_in_terminal`
- `read_terminal_tail`

Other tools dispatched through `agent-cc-tool` currently return an unsupported-tool response from the UI layer.

## Current Tool Support

### Terminal-Bound Tools

These tools are correctly tied to a concrete terminal tab or remote shell context:

- `run_in_terminal`
- `read_terminal_tail`
- `run_captured`
- `read_capture`

They depend on a specific terminal session and should remain scoped to the active linked terminal.

### Global UI Tools

These tools are not logically bound to a specific terminal:

- `switch_tab`
- `open_session_editor`

The backend already treats them as global-ish tools because their handlers do not call `enforce_session_scope`.

However, the frontend bridge does not yet execute them. They are currently declared and dispatched, but not operational from Claude Code.

### Global Write Tool

`save_as_runbook` is also not naturally terminal-bound.

The current Claude Bridge schema uses:

- `name`
- `commands`

The older native agent tool schema uses:

- `session_id`
- `last_n_commands`
- `name`

This means there is schema drift between the Claude Bridge MCP tool and the legacy native agent tool. There is also no clearly wired frontend persistence path for this tool yet.

### SFTP Tool

`sftp_upload` is currently the most ambiguous tool.

It is declared in the Claude Bridge MCP server, but its current scope and session-id model do not match the actual SFTP architecture.

## SFTP Architecture Findings

SFTP support itself already exists in the application:

- Backend file browser commands live in `src-tauri/src/filebrowser/mod.rs`.
- Frontend SFTP API helpers live in `src/lib/sftp.ts`.
- Transfer orchestration lives in `src/lib/sftpController.ts`.
- SFTP state is maintained in `src/stores/sftpStore.ts`.

The important distinction is that an SFTP session id is not the same thing as a terminal tab id.

Examples:

- SSH terminal tab id: `ssh-<saved-session-id>-<timestamp>`
- Attached SFTP id for that terminal: `attached-<terminal-tab-id>`
- Standalone SFTP tab id: `sftp-<saved-session-id>-<timestamp>`

The backend file browser keeps SFTP connections in `state.sftp_sessions`, keyed by the SFTP session id provided by the frontend.

This means `sftp_upload` must target an SFTP resource, not just a terminal tab.

## Current `sftp_upload` Problem

In `mcp_http.rs`, `sftp_upload` currently:

- Requires `session_id`.
- Calls `fill_session_id`.
- Calls `enforce_session_scope`.
- Dispatches `agent-cc-tool`.

For a terminal-bound Claude Code thread, the allowed session id is the terminal tab id.

That creates two failure modes:

1. If `session_id` is omitted, the bridge fills it with the terminal tab id, such as `ssh-...`. The SFTP backend expects an SFTP session id, so the upload cannot resolve the active SFTP connection.
2. If Claude explicitly passes `attached-<terminal-tab-id>`, that may be the correct SFTP resource id, but `enforce_session_scope` rejects it because the allowed id is only the raw terminal tab id.

Therefore, `sftp_upload` is currently exposed in the MCP layer but is not executable end to end.

## Tool Scope Model

The bridge should explicitly classify tools by resource scope.

| Scope | Tools | Notes |
| --- | --- | --- |
| `terminal` | `run_in_terminal`, `read_terminal_tail`, `run_captured`, `read_capture` | Requires a concrete terminal tab or remote shell context. |
| `global_ui` | `switch_tab`, `open_session_editor` | Operates on the application UI, not a terminal. |
| `global_write` | `save_as_runbook` | Writes user assets; should require confirmation but not terminal binding. |
| `sftp_resource` | `sftp_upload` | Targets an SFTP connection or saved SFTP-capable session. |
| `readonly_global` | `list_sessions`, `search_history` | Read-only discovery tools. |

This avoids overloading `session_id` to mean terminal tab id, saved session id, and SFTP connection id at the same time.

## Per-Tool Improvement Plan

### `switch_tab`

Desired behavior:

- Match an already-open app tab by id, title, host, or saved session id.
- Activate that tab if found.
- If no open tab matches but a saved session matches, optionally open/connect that session.

Required changes:

- Add frontend handling for `switch_tab` in `CcAgentBridge.tsx`.
- Expose a stable app-level command for switching/opening tabs instead of depending on terminal-only registry APIs.
- Keep this tool global. Do not require a linked terminal.

### `open_session_editor`

Desired behavior:

- Open the session editor from Claude Code.
- Pre-fill available fields such as `name`, `host`, and `username`.
- Optionally support a protocol/type field in the future.

Required changes:

- Add frontend handling for `open_session_editor` in `CcAgentBridge.tsx`.
- Move or expose MainLayout session-editor open logic as an app-level command.
- Extend SessionEditor state to accept prefill values, not only initial protocol.
- Keep this tool global. Do not require a linked terminal.

### `sftp_upload`

Desired behavior:

- Upload a local file or directory to a remote path through a valid SFTP connection.
- Reuse an attached SFTP connection when a Claude Code thread is bound to an SSH terminal.
- Support standalone SFTP tabs.
- Support saved SFTP-capable sessions after explicit user confirmation and credential resolution.

Required changes:

- Treat `sftp_upload` as `sftp_resource`, not `terminal`.
- Introduce a resolver that maps tool input to an actual SFTP frontend/backend session id:
  - linked SSH terminal tab -> `attached-<terminal-tab-id>`
  - standalone SFTP tab -> its SFTP tab/session id
  - saved session id -> attach/open an SFTP session if credentials are available
- Resolve the saved SessionConfig id separately for safety checks.
- Do not run per-session AI write-disable checks against transient ids like `attached-...`.
- Add frontend execution in `CcAgentBridge.tsx`.
- Use the existing transfer store/controller path so upload progress appears in the transfer UI.
- Return a structured result containing at least `transfer_id`, source path, remote path, and final status.

Prompt/tool availability should also be adjusted:

- Advertise `sftp_upload` for SSH and SFTP contexts.
- Do not advertise it for Telnet or Serial sessions unless an SFTP resource is explicitly available.

### `save_as_runbook`

Desired behavior:

- Save a named list of commands as a reusable runbook or command collection.
- Do not require a terminal binding.
- Require user confirmation because it writes user data.

Required changes:

- Decide the storage target:
  - global runbook library, or
  - per-session command set, or
  - terminal profile common commands.
- Align the Claude Bridge schema with the actual storage model.
- Add frontend execution and persistence.
- Consider optional metadata such as source thread id, source terminal id, or saved session id, but do not make these required for global runbooks.

## Backend Changes

Recommended backend changes in `src-tauri/src/agent/cc_bridge/mcp_http.rs`:

1. Add explicit tool scope metadata instead of inferring scope from the presence of `session_id`.
2. Keep `switch_tab` and `open_session_editor` out of terminal session enforcement.
3. Keep `save_as_runbook` out of terminal session enforcement but under write confirmation.
4. Replace `sftp_upload` terminal scope enforcement with SFTP resource resolution.
5. Preserve safety checks by resolving transient UI ids back to saved session ids where applicable.
6. Update session-card guidance so SFTP upload is only suggested for valid SFTP-capable contexts.

## Frontend Changes

Recommended frontend changes:

1. Extend `CcAgentBridge.tsx` beyond terminal-only tool execution.
2. Add an app-level command bridge for:
   - switching tabs
   - opening session editor
   - opening saved sessions
   - invoking SFTP transfer flows
   - saving runbooks
3. Avoid direct coupling between Claude Bridge and MainLayout internals by moving common app actions into a shared store or command module.
4. Ensure SFTP upload uses the existing transfer store/controller path, not a bare `sftpUpload` call, so progress and completion are visible to the user.
5. Return structured tool results to Claude Code instead of only plain text.

## Suggested Implementation Phases

### Phase 1: Make Global UI Tools Work

- Implement frontend handling for `switch_tab`.
- Implement frontend handling for `open_session_editor`.
- Keep both tools globally available.
- Add simple success/failure results.

### Phase 2: Fix SFTP Resource Semantics

- Add a resolver for terminal tab id, SFTP tab id, and saved session id.
- Support `attached-<terminal-tab-id>` for SSH terminal-bound chats.
- Update backend scope checks so `sftp_upload` can target the resolved SFTP resource.
- Wire frontend execution through transfer store/controller.

### Phase 3: Clarify Runbook Persistence

- Decide the runbook storage model.
- Align legacy native agent schema and Claude Bridge schema.
- Implement frontend persistence for `save_as_runbook`.
- Keep confirmation required.

### Phase 4: Prompt and Permission Cleanup

- Update session-card instructions so each tool is advertised only in valid contexts.
- Add tests or smoke checks for:
  - terminal-bound command execution
  - global tab switching
  - opening session editor
  - SSH-attached SFTP upload
  - standalone SFTP upload
  - disabled AI write permissions

## Final Recommendation

The bridge should stop treating every side-effect tool as terminal-bound.

`switch_tab`, `open_session_editor`, and `save_as_runbook` should be global tools with appropriate confirmation rules.

`sftp_upload` should be modeled as an SFTP resource tool. It may be derived from a bound SSH terminal, but it should not use the terminal tab id as the upload target directly.

This separation will make the Claude Bridge tool model match the application architecture and avoid fragile session-id overloading.
