# Taomni ACP Refactor Plan

Date: 2026-06-27

## Executive Summary

Taomni's current Claude Code and Codex integrations solve the same class of
problem that Agent Client Protocol (ACP) targets: a client application needs to
host multiple local coding agents, manage sessions, stream agent output, render
tool activity, apply permissions, and inject client-owned tools.

The recommended direction is to introduce ACP as the unified local-agent session
protocol while keeping Taomni's existing MCP tool bridge as the domain tool
surface for terminal, SSH, database, Redis, and UI control operations.

ACP should not replace the existing cloud LLM router. OpenAI-compatible,
Anthropic API, Ollama, and similar providers should continue to use the current
LLM routing layer. ACP should initially apply only to local coding-agent
providers such as Codex and Claude adapters.

## Current State

Current frontend flow:

```text
ChatDrawer -> chat_stream -> provider branch
```

Current local agent backend flow:

```text
chat_stream
  -> claude-code branch
      -> claude CLI stream-json protocol
      -> Taomni MCP HTTP tools

  -> codex branch
      -> codex app-server --stdio private protocol
      -> Taomni MCP HTTP tools
```

Key observations:

- Claude Code is integrated through `claude --print --output-format stream-json
  --input-format stream-json`.
- Codex is integrated through `codex app-server --stdio` with methods such as
  `initialize`, `thread/start`, and `turn/start`.
- Both integrations already use Taomni's loopback MCP HTTP bridge for tools.
- The MCP bridge currently lives under `cc_bridge::mcp_http`, but Codex already
  reuses it, so the module name no longer matches its ownership.
- Tool activity, permission cards, session binding, terminal cwd, database
  connection binding, and capture echo are already implemented in Taomni and
  should be preserved.

## Target Architecture

Target flow:

```text
ChatDrawer
  -> chat_stream
  -> local-agent router
  -> ACP client
  -> ACP agent adapter
  -> concrete agent
```

Tool flow remains:

```text
ACP agent
  -> Taomni MCP HTTP server
  -> terminal / database / Redis / control tools
```

The intended architecture boundaries are:

- ACP: local coding-agent session protocol.
- MCP: Taomni-owned domain tools and permission-controlled side effects.
- LLM router: cloud and normal chat model providers.

## Non-Goals

- Do not migrate normal cloud LLM providers to ACP.
- Do not remove the existing Claude Code or Codex bridges in the first
  implementation.
- Do not replace the Taomni MCP tool bridge with ACP client capabilities.
- Do not expose broad ACP filesystem or terminal capabilities until the security
  model is reviewed.
- Do not make ACP the only path until parity and rollback have been verified.

## Phase 0: Scope and Compatibility

1. Treat ACP as an additive provider path.
2. Keep `claude-code` and `codex` legacy providers working.
3. Add new ACP-backed providers first, for example:
   - `codex-acp`
   - `claude-acp`
4. Keep Taomni MCP HTTP tools as the shared tool surface.
5. Keep ordinary cloud LLM providers on the existing router.
6. Define rollback as switching the thread provider back to legacy
   `claude-code` or `codex`.

Deliverable:

- Architecture decision documented in this file.
- Provider naming and rollout strategy agreed.

## Phase 1: Introduce a Local Agent Event Model

Create a shared event model before adding ACP so existing and new bridges can be
mapped consistently.

Suggested files:

```text
src-tauri/src/agent/local/mod.rs
src-tauri/src/agent/local/types.rs
src-tauri/src/agent/local/run.rs
```

Suggested types:

```rust
pub enum LocalAgentEvent {
    AssistantDelta { content: String },
    AssistantMessage { content: String },
    ToolStarted { id: String, name: String, input: serde_json::Value },
    ToolCompleted { id: String, output: String },
    Usage { input_tokens: Option<u64>, output_tokens: Option<u64>, total_tokens: Option<u64>, duration_ms: Option<u64> },
    Error { message: String },
    Done,
}
```

Also define:

- `LocalAgentUsage`
- `LocalAgentSession`
- `LocalAgentTurnOptions`
- `LocalAgentProviderConfig`
- `LocalAgentRunHandle`

Migration behavior:

- Map `CcEvent` to `LocalAgentEvent`.
- Map `CodexEvent` to `LocalAgentEvent`.
- Keep frontend `StreamEventOut` unchanged initially.

Deliverable:

- Shared local-agent event types.
- Unit tests for Claude and Codex event mapping.
- No behavior change in the UI.

## Phase 2: Add ACP Bridge Module

Suggested files:

```text
src-tauri/src/agent/acp_bridge/mod.rs
src-tauri/src/agent/acp_bridge/config.rs
src-tauri/src/agent/acp_bridge/process.rs
src-tauri/src/agent/acp_bridge/protocol.rs
src-tauri/src/agent/acp_bridge/commands.rs
```

Responsibilities of `process.rs`:

1. Spawn an ACP agent subprocess.
2. Use stdio as the first transport.
3. Send newline-delimited JSON-RPC requests.
4. Maintain a pending request map keyed by JSON-RPC id.
5. Route notifications such as `session/update`.
6. Maintain stderr rolling buffer.
7. Support request timeout and turn idle timeout.
8. Support cancellation.
9. Kill child process and clean temp files on stop/drop.
10. Revoke MCP tokens on stop/drop.

Initial ACP methods to support:

- `initialize`
- `session/new`
- `session/load` or adapter-supported resume path
- `session/prompt`
- `session/cancel`
- notifications from the agent, especially `session/update`

Initial client capabilities:

- Prompt turns.
- Session updates.
- Permission requests if supported by the adapter.
- MCP server injection.

Capabilities to avoid in the first version:

- General ACP filesystem access.
- General ACP terminal access.
- Broad client-side command execution outside existing Taomni MCP tools.

Deliverable:

- ACP subprocess runner.
- Fake ACP agent integration test.
- ACP notification to `LocalAgentEvent` mapper.

## Phase 3: ACP Configuration Model

Add ACP config to `AiConfig`.

Suggested Rust model:

```rust
pub struct AcpBridgeConfig {
    pub enabled: bool,
    pub default_agent_id: Option<String>,
    pub agents: Vec<AcpAgentProfile>,
}

pub struct AcpAgentProfile {
    pub id: String,
    pub title: String,
    pub enabled: bool,
    pub command: String,
    pub args: Vec<String>,
    pub env: std::collections::HashMap<String, String>,
    pub default_model: Option<String>,
    pub working_dir: Option<String>,
    pub mcp_enabled: bool,
}
```

Configuration principles:

- Support manual command and args first.
- Add convenience detection for known adapters later.
- Store secrets in the vault if env profiles include sensitive values.
- Reuse the existing settings profile pattern where possible.
- Let per-thread model override continue to work if the ACP adapter supports
  model selection.

Suggested built-in profile examples:

```text
codex-acp
claude-agent-acp
```

Deliverable:

- Config schema and defaults.
- Settings read/write support.
- Basic validate/test command for an ACP profile.

## Phase 4: Extract Shared MCP Bridge Ownership

The existing MCP HTTP bridge is shared by Claude Code and Codex but lives under
`cc_bridge`. ACP would increase that mismatch.

Preferred target structure:

```text
src-tauri/src/agent/mcp_bridge/mod.rs
src-tauri/src/agent/mcp_bridge/http.rs
src-tauri/src/agent/mcp_bridge/flavor.rs
src-tauri/src/agent/mcp_bridge/permissions.rs
src-tauri/src/agent/mcp_bridge/sql.rs
src-tauri/src/agent/mcp_bridge/redis.rs
src-tauri/src/agent/mcp_bridge/control.rs
```

Low-risk migration order:

1. Add `agent::mcp_bridge` module that re-exports existing
   `cc_bridge::mcp_http` types and functions.
2. Update new ACP code to depend on `agent::mcp_bridge`.
3. Gradually move files after ACP proof of concept is stable.
4. Update existing Codex and Claude bridges to use the shared module.

Do not perform a large file move in the same PR as the initial ACP protocol
implementation unless necessary.

Deliverable:

- Stable shared import path for MCP provisioning.
- ACP no longer imports `cc_bridge::mcp_http` directly.

## Phase 5: Inject Taomni MCP Servers into ACP Sessions

Reuse the existing provisioning model:

- Pick `Flavor` from the bound session type:
  - shell/local/SSH -> `taomni`
  - SQL database -> `taomni_sql`
  - Redis -> `taomni_redis`
- Always add `taomni_control`.
- Mint a per-thread bearer token.
- Scope token to thread id, bound terminal tab id, bound saved session id, and
  trust level.
- Revoke token when the ACP process stops or the thread is recycled.

ACP session creation should pass MCP server configuration to the adapter if the
adapter supports MCP configuration in `session/new`. If an adapter expects MCP
configuration through environment variables or command args, add adapter-specific
profile options without leaking them into the generic event model.

Deliverable:

- ACP session starts with Taomni MCP tools available.
- SQL and Redis bound chats load only the matching domain tool surface.
- Control tools remain available through `taomni_control`.

## Phase 6: Connect ACP to `chat_stream`

Add a new route before the legacy local-agent branches:

```rust
if is_acp_provider(&thread.provider_id) {
    return stream_with_acp_agent(req, app, state, thread, history).await;
}
```

`stream_with_acp_agent` should:

1. Persist the user message.
2. Emit `assistant_start`.
3. Resolve bound saved session id.
4. Resolve live terminal cwd.
5. Resolve live database or Redis connection id.
6. Build session identity developer context.
7. Provision Taomni MCP token and URLs.
8. Start or reuse ACP process for the thread.
9. Initialize and create/resume ACP session if needed.
10. Send `session/prompt`.
11. Map ACP updates to `StreamEventOut`.
12. Persist final assistant message.
13. Save ACP session id.
14. Clean up run handle on completion or cancellation.

Session persistence:

- Add a new DB field such as `agent_session_id`.
- Avoid reusing `cc_session_id` for ACP if possible.
- Keep migration compatibility with old records.

Deliverable:

- Hidden ACP provider can complete a basic chat turn.
- Streaming tokens render in Chat Drawer.
- Tool activity renders through existing `CcToolActivity` UI initially.

## Phase 7: Provider Rollout

Recommended sequence:

1. Add hidden dev provider `codex-acp-dev`.
2. Validate with a fake ACP agent.
3. Validate with the real Codex ACP adapter.
4. Add visible provider `codex-acp`.
5. Add hidden provider `claude-acp-dev`.
6. Validate with the real Claude ACP adapter.
7. Add visible provider `claude-acp`.
8. Switch default local-agent preference to ACP providers only after parity is
   confirmed.
9. Mark legacy `codex` and `claude-code` providers as legacy in settings.
10. Remove legacy bridges only after at least one stable release with rollback.

Deliverable:

- Users can choose ACP-backed providers without losing legacy fallback.

## Phase 8: Permission, Terminal, and Filesystem Policy

Permission:

- Keep Taomni MCP permission pipeline as authoritative for Taomni side effects.
- Map ACP permission requests to existing ActionCard UI when needed.
- Avoid duplicate prompts where an MCP tool already enforces permission.

Terminal:

- First version should not expose ACP terminal capability broadly.
- Agents should use Taomni MCP terminal tools for bound terminal operations.
- Revisit ACP terminal support later if it offers clear UX or compatibility
  benefits.

Filesystem:

- First version should not expose broad ACP filesystem access.
- If needed later, restrict to explicit workspace roots and reuse existing deny
  patterns for sensitive directories.

Cancel:

- Map `chat_stop_stream` to ACP `session/cancel`.
- Also stop any in-flight Taomni capture or MCP tool call if applicable.

Deliverable:

- Clear, testable security policy for ACP capabilities.

## Phase 9: Settings UI

Add an ACP section to AI settings.

Suggested controls:

- Enable ACP agents.
- Default ACP agent.
- Add/edit/remove agent profile.
- Command path.
- Args.
- Environment variables or vault-backed profile.
- Model override if supported.
- Test connection.
- Show detected protocol version and agent capabilities.

Provider selection:

- Chat Drawer provider list should include visible enabled ACP profiles.
- Per-thread model control should be shown only if supported by the selected
  profile or allowed as opaque adapter config.

Deliverable:

- ACP provider can be configured without editing files manually.
- Settings search can find ACP, Codex ACP, and Claude ACP entries.

## Phase 10: Testing Plan

Rust unit tests:

- JSON-RPC request id allocation.
- Pending request response routing.
- Error response handling.
- Notification routing.
- stdout close behavior.
- stderr buffer truncation.
- timeout handling.
- ACP event mapping.
- MCP server injection.
- token revocation on stop/drop.

Rust integration tests:

- Fake ACP agent initializes successfully.
- Fake ACP agent streams assistant deltas.
- Fake ACP agent emits tool activity.
- Fake ACP agent requests permission.
- Cancellation reaches the fake agent.
- Process crash surfaces a useful error.
- Session id is persisted and reused.

Frontend tests:

- ACP provider appears when enabled.
- Chat Drawer streams ACP token events.
- Tool cards render ACP-mapped tool events.
- Stop button cancels an ACP turn.
- Settings panel validates ACP profile fields.

QA UI cases:

- `TC-AI-ACP-001`: configure and test ACP provider.
- `TC-AI-ACP-002`: terminal-bound ACP chat streams a response.
- `TC-AI-ACP-003`: database-bound ACP chat exposes SQL MCP tools.
- `TC-AI-ACP-004`: permission card approve and deny flow.
- `TC-AI-ACP-005`: cancellation stops an in-flight ACP turn.

Deliverable:

- Fake-agent test suite runs without requiring real Codex or Claude accounts.
- Real-adapter smoke tests can be marked ignored or environment-gated.

## Phase 11: Cleanup and Deprecation

After ACP-backed providers are stable:

1. Move shared MCP bridge out of `cc_bridge`.
2. Update old bridge imports to the shared module.
3. Mark old `codex_bridge::process` and `cc_bridge::process` as legacy.
4. Remove duplicated event mapping and tool activity code.
5. Remove legacy provider paths only after a documented rollback window.

Potential deletion candidates after migration:

- `src-tauri/src/agent/codex_bridge/process.rs`
- large parts of `src-tauri/src/agent/codex_bridge/protocol.rs`
- large parts of `src-tauri/src/agent/cc_bridge/process.rs`
- Claude-specific CLI stream-json parsing paths
- Codex app-server private protocol parsing paths

Keep:

- MCP bridge.
- safety pipeline.
- capture execution.
- session card rendering.
- terminal/db/redis/control tools.

## Key Risks

Adapter maturity:

- ACP adapters may not expose all capabilities currently used through direct
  Codex app-server or Claude CLI integration.

Configuration mismatch:

- Model selection, sandbox policy, approval policy, MCP configuration, and
  resume semantics may differ per adapter.

Permission duplication:

- ACP permission prompts, agent-native approval settings, and Taomni MCP
  permission prompts can overlap. The Taomni MCP pipeline should remain
  authoritative for Taomni side effects.

Session identity:

- Existing `cc_session_id` is provider-specific. ACP needs a neutral persisted
  session id to avoid confusing future providers.

Module ownership:

- The current `cc_bridge::mcp_http` naming is already inaccurate. ACP should not
  expand that dependency surface.

## Recommended First PR

The first implementation PR should be intentionally small:

1. Add `agent/local` event types.
2. Add `agent/acp_bridge/protocol.rs` with JSON-RPC request/response structs.
3. Add `agent/acp_bridge/process.rs` with fake-agent integration test support.
4. Add no visible UI.
5. Add no real Codex or Claude adapter dependency.

Success criteria:

- A fake ACP agent can initialize, create a session, receive a prompt, stream a
  response, and complete.
- The bridge maps fake ACP updates to `LocalAgentEvent`.
- The process cleanup path is tested.

## Recommended Second PR

1. Add hidden `codex-acp-dev` provider.
2. Inject Taomni MCP server config.
3. Connect ACP path to `chat_stream`.
4. Render streaming output in Chat Drawer.
5. Persist assistant message.
6. Keep legacy `codex` untouched.

Success criteria:

- A developer can manually configure a Codex ACP adapter command and complete a
  basic chat turn.
- Legacy Codex still works.

## Recommended Third PR

1. Add settings UI for ACP profiles.
2. Add provider list integration.
3. Add detect/test action.
4. Add frontend tests.
5. Add QA testcase for provider setup and basic chat.

Success criteria:

- ACP can be configured from the app UI.
- The feature is testable without manually editing config files.

## Final Desired State

Long term, Taomni local coding agents should be integrated through one protocol
path:

```text
Local coding agents -> ACP
Taomni tools -> MCP
Cloud chat models -> existing LLM router
```

This reduces maintenance cost, keeps Taomni's domain tools under Taomni's safety
pipeline, and makes future local agents cheaper to support.
