//! Read-only readiness policy for the native Windows Save automation.
use std::time::Duration;

use serde_json::Value;

pub(super) fn filename_ready(state: &Value, expected: Option<&str>) -> bool {
    state["ownProcess"] == true
        && state["dialogReady"] == true
        && state["focusClass"] == "Edit"
        && state["focusControlId"] == 1001
        && state["focusInDialog"] == true
        && state["saveButton"]["ready"] == true
        && state["fileName"]
            .as_str()
            .is_some_and(|value| match expected {
                Some(expected) => value == expected,
                None => value.starts_with("Taomni-pin"),
            })
}

/// A single focus notification can precede Shell's final field allocation.
/// Require the same handles, contents and button bounds over a quiet interval.
#[derive(Default)]
pub(super) struct StableObservation {
    previous: Option<Value>,
    since: Duration,
}

impl StableObservation {
    pub(super) fn observe(&mut self, state: &Value, ready: bool, at: Duration) -> bool {
        if !ready {
            self.previous = None;
            return false;
        }
        if self.previous.as_ref() != Some(state) {
            self.previous = Some(state.clone());
            self.since = at;
        }
        at.saturating_sub(self.since) >= Duration::from_millis(500)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn field(value: &str) -> Value {
        json!({"ownProcess":true,"dialogReady":true,"focusClass":"Edit",
            "focusControlId":1001,"focusInDialog":true,"fileName":value,
            "saveButton":{"ready":true,"window":42,"center":[800,600]}})
    }

    #[test]
    fn save_requires_the_complete_destination_in_the_owned_filename_field() {
        let path = r"D:\a\_temp\taomni-qa-artifacts\unique-pin-ui-saved.png";
        assert!(filename_ready(&field(path), Some(path)));
        assert!(!filename_ready(&field(&path[..35]), Some(path)));
        assert!(filename_ready(&field("Taomni-pin"), None));
        for (key, invalid) in [
            ("ownProcess", json!(false)),
            ("dialogReady", json!(false)),
            ("focusInDialog", json!(false)),
            ("focusControlId", json!(1002)),
            ("saveButton", json!({"ready":false})),
        ] {
            let mut state = field(path);
            state[key] = invalid;
            assert!(!filename_ready(&state, Some(path)), "{key}");
        }
    }

    #[test]
    fn readiness_resets_when_the_shell_replaces_a_field_or_steals_focus() {
        let mut stable = StableObservation::default();
        let state = field("Taomni-pin");
        let ms = Duration::from_millis;
        assert!(!stable.observe(&state, true, ms(0)));
        assert!(!stable.observe(&state, true, ms(499)));
        assert!(stable.observe(&state, true, ms(500)));
        let mut replaced = state.clone();
        replaced["focusWindow"] = json!(99);
        assert!(!stable.observe(&replaced, true, ms(600)));
        assert!(!stable.observe(&replaced, false, ms(1100)));
        assert!(!stable.observe(&replaced, true, ms(1200)));
        assert!(stable.observe(&replaced, true, ms(1700)));
    }
}
