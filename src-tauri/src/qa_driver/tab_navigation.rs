//! Recognize one complete forward/backward Tab stroke issued by the W3C client.
use serde_json::Value;

pub(super) fn reverse_tab(payload: &Value) -> Option<bool> {
    let [source] = payload.get("actions")?.as_array()?.as_slice() else {
        return None;
    };
    if source.get("type")?.as_str()? != "key" {
        return None;
    }
    let mut keys = Vec::new();
    for action in source.get("actions")?.as_array()? {
        let kind = action.get("type")?.as_str()?;
        if kind == "pause" {
            // The Python driver inserts 30 ms gaps between ordinary key events.
            if action.get("duration")?.as_u64()? != 30 {
                return None;
            }
        } else {
            keys.push((kind, action.get("value")?.as_str()?));
        }
    }
    const TAB: &str = "\u{e004}";
    const SHIFT: &str = "\u{e008}";
    match keys.as_slice() {
        [("keyDown", TAB), ("keyUp", TAB)] => Some(false),
        [
            ("keyDown", SHIFT),
            ("keyDown", TAB),
            ("keyUp", TAB),
            ("keyUp", SHIFT),
        ] => Some(true),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn input(keys: &[(&str, &str)]) -> Value {
        let actions: Vec<_> = keys
            .iter()
            .map(|(kind, value)| json!({"type":kind,"value":value}))
            .collect();
        json!({"actions":[{"type":"key","actions":actions}]})
    }

    #[test]
    fn recognizes_only_a_complete_tab_stroke() {
        let tab = "\u{e004}";
        let shift = "\u{e008}";
        assert_eq!(
            reverse_tab(&input(&[("keyDown", tab), ("keyUp", tab)])),
            Some(false)
        );
        assert_eq!(
            reverse_tab(&input(&[
                ("keyDown", shift),
                ("keyDown", tab),
                ("keyUp", tab),
                ("keyUp", shift)
            ])),
            Some(true)
        );
        assert_eq!(reverse_tab(&input(&[("keyDown", tab)])), None);
        assert_eq!(
            reverse_tab(&input(&[("keyDown", "a"), ("keyUp", "a")])),
            None
        );
        assert_eq!(reverse_tab(&json!({"actions":[]})), None);
    }
}
