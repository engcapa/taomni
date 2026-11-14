use crate::chat::redact::redact;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ContextRound {
    pub user: String,
    pub assistant: String,
}

pub fn is_usable_reply(text: &str, refused: bool) -> bool {
    !refused && !text.trim().is_empty() && !text.trim_start().starts_with("[template]")
}

pub fn get_context_rounds(history: &[(String, String)]) -> Vec<ContextRound> {
    history
        .iter()
        .filter_map(|(user, assistant)| {
            is_usable_reply(assistant, false).then(|| ContextRound {
                user: redact(user).0,
                assistant: redact(assistant).0,
            })
        })
        .collect()
}

pub fn to_request_messages(
    history: &[(String, String)],
    question: &str,
    binding: &[String],
    max_chars: usize,
) -> Vec<(String, String)> {
    let mut messages = get_context_rounds(history)
        .into_iter()
        .map(|round| ("user".into(), round.user))
        .collect::<Vec<_>>();
    messages.extend(
        get_context_rounds(history)
            .into_iter()
            .map(|round| ("assistant".into(), round.assistant)),
    );
    if !binding.is_empty() {
        let context = binding
            .iter()
            .map(|item| redact(item).0)
            .collect::<Vec<_>>()
            .join("\n");
        messages.push(("user_context".into(), context));
    }
    messages.push(("user".into(), redact(question).0));
    trim_messages(messages, max_chars)
}

pub fn can_continue_reply(text: &str, stop_reason: Option<&str>) -> bool {
    matches!(stop_reason, Some("max_tokens")) && is_usable_reply(text, false)
}

pub fn trim_messages(
    mut messages: Vec<(String, String)>,
    max_chars: usize,
) -> Vec<(String, String)> {
    if max_chars == 0 {
        return vec![];
    }
    while messages.iter().map(|(_, text)| text.len()).sum::<usize>() > max_chars
        && messages.len() > 1
    {
        messages.remove(0);
    }
    messages
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_only_completed_non_empty_rounds() {
        let rounds = get_context_rounds(&[("a".into(), "b".into()), ("c".into(), "".into())]);
        assert_eq!(
            rounds,
            vec![ContextRound {
                user: "a".into(),
                assistant: "b".into()
            }]
        );
    }

    #[test]
    fn redacts_binding_before_injection() {
        let messages = to_request_messages(&[], "show", &["password=secret".into()], 1000);
        assert!(messages[0].1.contains("[REDACTED]"));
        assert!(!messages[0].1.contains("secret"));
    }

    #[test]
    fn continuation_requires_max_tokens() {
        assert!(can_continue_reply("partial", Some("max_tokens")));
        assert!(!can_continue_reply("partial", Some("end_turn")));
    }
}
