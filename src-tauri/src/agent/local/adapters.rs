use super::types::{LocalAgentEvent, LocalAgentSession, LocalAgentTurnOptions, LocalAgentUsage};
use crate::agent::cc_bridge::protocol::{CcEvent, CcUsage};
use crate::agent::codex_bridge::protocol::{CodexEvent, CodexUsage};

/// Convert a legacy Claude Code protocol event into the local-agent event
/// model. Unknown raw protocol records are intentionally dropped: raw CLI
/// messages may contain provider configuration and must not enter shared
/// diagnostics or chat persistence.
pub fn from_cc_event(event: &CcEvent) -> Option<LocalAgentEvent> {
    match event {
        CcEvent::SessionInit { session_id } => Some(LocalAgentEvent::SessionStarted {
            session_id: session_id.clone(),
        }),
        CcEvent::Partial { content } => Some(LocalAgentEvent::AssistantDelta {
            content: content.clone(),
        }),
        CcEvent::AssistantMessage { content } => Some(LocalAgentEvent::AssistantMessage {
            content: content.clone(),
        }),
        CcEvent::ToolUse { id, name, input } => Some(LocalAgentEvent::ToolStarted {
            id: id.clone(),
            name: name.clone(),
            input: input.clone(),
        }),
        CcEvent::ToolResult {
            tool_use_id,
            content,
        } => Some(LocalAgentEvent::ToolCompleted {
            id: tool_use_id.clone(),
            output: content.clone(),
        }),
        CcEvent::Done { usage } => Some(LocalAgentEvent::Done {
            usage: usage.as_ref().map(from_cc_usage),
        }),
        CcEvent::Error { message } => Some(LocalAgentEvent::Error {
            message: message.clone(),
        }),
        CcEvent::Unknown { .. } => None,
    }
}

/// Convert a legacy Codex app-server event into the local-agent event model.
/// See [`from_cc_event`] for why unknown raw records are not propagated.
pub fn from_codex_event(event: &CodexEvent) -> Option<LocalAgentEvent> {
    match event {
        CodexEvent::SessionInit { session_id } => Some(LocalAgentEvent::SessionStarted {
            session_id: session_id.clone(),
        }),
        CodexEvent::Partial { content } => Some(LocalAgentEvent::AssistantDelta {
            content: content.clone(),
        }),
        CodexEvent::AssistantMessage { content } => Some(LocalAgentEvent::AssistantMessage {
            content: content.clone(),
        }),
        CodexEvent::ToolUse { id, name, input } => Some(LocalAgentEvent::ToolStarted {
            id: id.clone(),
            name: name.clone(),
            input: input.clone(),
        }),
        CodexEvent::ToolResult {
            tool_use_id,
            content,
        } => Some(LocalAgentEvent::ToolCompleted {
            id: tool_use_id.clone(),
            output: content.clone(),
        }),
        CodexEvent::Done { usage } => Some(LocalAgentEvent::Done {
            usage: usage.as_ref().map(from_codex_usage),
        }),
        CodexEvent::Error { message } => Some(LocalAgentEvent::Error {
            message: message.clone(),
        }),
        CodexEvent::Unknown { .. } => None,
    }
}

fn from_cc_usage(usage: &CcUsage) -> LocalAgentUsage {
    LocalAgentUsage {
        input_tokens: usage.input_tokens,
        output_tokens: usage.output_tokens,
        total_tokens: match (usage.input_tokens, usage.output_tokens) {
            (Some(input), Some(output)) => input.checked_add(output),
            _ => None,
        },
        total_cost_usd: usage.total_cost_usd,
        duration_ms: usage.duration_ms,
        num_turns: usage.num_turns,
    }
}

fn from_codex_usage(usage: &CodexUsage) -> LocalAgentUsage {
    LocalAgentUsage {
        input_tokens: usage.input_tokens,
        output_tokens: usage.output_tokens,
        total_tokens: usage.total_tokens,
        total_cost_usd: None,
        duration_ms: usage.duration_ms,
        num_turns: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn maps_all_claude_event_shapes_without_exposing_unknown_raw_payloads() {
        assert_eq!(
            from_cc_event(&CcEvent::SessionInit {
                session_id: "session-1".into(),
            }),
            Some(LocalAgentEvent::SessionStarted {
                session_id: "session-1".into(),
            }),
        );
        assert_eq!(
            from_cc_event(&CcEvent::Partial {
                content: "hello".into(),
            }),
            Some(LocalAgentEvent::AssistantDelta {
                content: "hello".into(),
            }),
        );
        assert_eq!(
            from_cc_event(&CcEvent::ToolUse {
                id: "call-1".into(),
                name: "run_in_terminal".into(),
                input: json!({ "command": "pwd" }),
            }),
            Some(LocalAgentEvent::ToolStarted {
                id: "call-1".into(),
                name: "run_in_terminal".into(),
                input: json!({ "command": "pwd" }),
            }),
        );
        assert_eq!(
            from_cc_event(&CcEvent::AssistantMessage {
                content: "complete answer".into(),
            }),
            Some(LocalAgentEvent::AssistantMessage {
                content: "complete answer".into(),
            }),
        );
        assert_eq!(
            from_cc_event(&CcEvent::ToolResult {
                tool_use_id: "call-1".into(),
                content: "command output".into(),
            }),
            Some(LocalAgentEvent::ToolCompleted {
                id: "call-1".into(),
                output: "command output".into(),
            }),
        );
        assert_eq!(
            from_cc_event(&CcEvent::Done { usage: None }),
            Some(LocalAgentEvent::Done { usage: None }),
        );
        assert_eq!(
            from_cc_event(&CcEvent::Error {
                message: "agent failed".into(),
            }),
            Some(LocalAgentEvent::Error {
                message: "agent failed".into(),
            }),
        );
        assert_eq!(
            from_cc_event(&CcEvent::Unknown {
                raw: "sensitive provider record".into(),
            }),
            None,
        );
    }

    #[test]
    fn does_not_overflow_claude_total_tokens() {
        assert_eq!(
            from_cc_event(&CcEvent::Done {
                usage: Some(CcUsage {
                    input_tokens: Some(u64::MAX),
                    output_tokens: Some(1),
                    total_cost_usd: None,
                    duration_ms: None,
                    num_turns: None,
                }),
            }),
            Some(LocalAgentEvent::Done {
                usage: Some(LocalAgentUsage {
                    input_tokens: Some(u64::MAX),
                    output_tokens: Some(1),
                    total_tokens: None,
                    total_cost_usd: None,
                    duration_ms: None,
                    num_turns: None,
                }),
            }),
        );
    }

    #[test]
    fn derives_claude_total_tokens_when_both_counts_are_available() {
        let event = from_cc_event(&CcEvent::Done {
            usage: Some(CcUsage {
                input_tokens: Some(12),
                output_tokens: Some(30),
                total_cost_usd: Some(0.42),
                duration_ms: Some(1500),
                num_turns: Some(2),
            }),
        });
        assert_eq!(
            event,
            Some(LocalAgentEvent::Done {
                usage: Some(LocalAgentUsage {
                    input_tokens: Some(12),
                    output_tokens: Some(30),
                    total_tokens: Some(42),
                    total_cost_usd: Some(0.42),
                    duration_ms: Some(1500),
                    num_turns: Some(2),
                }),
            }),
        );
    }

    #[test]
    fn maps_all_codex_event_shapes_and_usage() {
        assert_eq!(
            from_codex_event(&CodexEvent::SessionInit {
                session_id: "thread-1".into(),
            }),
            Some(LocalAgentEvent::SessionStarted {
                session_id: "thread-1".into(),
            }),
        );
        assert_eq!(
            from_codex_event(&CodexEvent::Partial {
                content: "streamed".into(),
            }),
            Some(LocalAgentEvent::AssistantDelta {
                content: "streamed".into(),
            }),
        );
        assert_eq!(
            from_codex_event(&CodexEvent::AssistantMessage {
                content: "complete answer".into(),
            }),
            Some(LocalAgentEvent::AssistantMessage {
                content: "complete answer".into(),
            }),
        );
        assert_eq!(
            from_codex_event(&CodexEvent::ToolUse {
                id: "call-2".into(),
                name: "shell".into(),
                input: json!({ "command": "pwd" }),
            }),
            Some(LocalAgentEvent::ToolStarted {
                id: "call-2".into(),
                name: "shell".into(),
                input: json!({ "command": "pwd" }),
            }),
        );
        assert_eq!(
            from_codex_event(&CodexEvent::ToolResult {
                tool_use_id: "call-2".into(),
                content: "ok".into(),
            }),
            Some(LocalAgentEvent::ToolCompleted {
                id: "call-2".into(),
                output: "ok".into(),
            }),
        );
        assert_eq!(
            from_codex_event(&CodexEvent::Done {
                usage: Some(CodexUsage {
                    input_tokens: Some(5),
                    output_tokens: Some(7),
                    total_tokens: Some(12),
                    duration_ms: Some(99),
                }),
            }),
            Some(LocalAgentEvent::Done {
                usage: Some(LocalAgentUsage {
                    input_tokens: Some(5),
                    output_tokens: Some(7),
                    total_tokens: Some(12),
                    total_cost_usd: None,
                    duration_ms: Some(99),
                    num_turns: None,
                }),
            }),
        );
        assert_eq!(
            from_codex_event(&CodexEvent::Done { usage: None }),
            Some(LocalAgentEvent::Done { usage: None }),
        );
        assert_eq!(
            from_codex_event(&CodexEvent::Error {
                message: "agent failed".into(),
            }),
            Some(LocalAgentEvent::Error {
                message: "agent failed".into(),
            }),
        );
        assert_eq!(
            from_codex_event(&CodexEvent::Unknown {
                raw: "sensitive provider record".into(),
            }),
            None,
        );
    }

    #[test]
    fn local_agent_session_and_turn_options_round_trip() {
        let session = LocalAgentSession {
            profile_id: "acp:grok-build".into(),
            session_id: "session-1".into(),
        };
        let turn = LocalAgentTurnOptions {
            model: Some("grok-build".into()),
            cwd: Some("/workspace".into()),
        };

        assert_eq!(
            serde_json::from_str::<LocalAgentSession>(&serde_json::to_string(&session).unwrap())
                .unwrap(),
            session
        );
        assert_eq!(
            serde_json::from_str::<LocalAgentTurnOptions>(&serde_json::to_string(&turn).unwrap())
                .unwrap(),
            turn
        );

        let event = LocalAgentEvent::ToolStarted {
            id: "call-3".into(),
            name: "shell".into(),
            input: json!({ "command": "pwd" }),
        };
        assert_eq!(
            serde_json::from_str::<LocalAgentEvent>(&serde_json::to_string(&event).unwrap())
                .unwrap(),
            event
        );
    }
}
