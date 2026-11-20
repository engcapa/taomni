//! Shared line protocol for the VNC Windows key helper.

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct SpecialKey {
    /// DOM `KeyboardEvent.code` of the key: MetaLeft, MetaRight, Tab,
    /// Escape or PrintScreen.
    pub code: &'static str,
    pub down: bool,
}

const SPECIAL_KEY_CODES: [&str; 5] = ["MetaLeft", "MetaRight", "PrintScreen", "Tab", "Escape"];

/// Which intercepted key a virtual-key press is, given the modifier state.
/// Win and PrtScn always pass through; Tab only with Alt (Alt+Tab), Esc with
/// Alt or Ctrl (Alt+Esc, Ctrl+Esc).
pub fn classify(vk: u32, alt_down: bool, ctrl_down: bool) -> Option<&'static str> {
    const VK_TAB: u32 = 0x09;
    const VK_ESCAPE: u32 = 0x1B;
    const VK_SNAPSHOT: u32 = 0x2C;
    const VK_LWIN: u32 = 0x5B;
    const VK_RWIN: u32 = 0x5C;
    match vk {
        VK_LWIN => Some("MetaLeft"),
        VK_RWIN => Some("MetaRight"),
        VK_SNAPSHOT => Some("PrintScreen"),
        VK_TAB if alt_down => Some("Tab"),
        VK_ESCAPE if alt_down || ctrl_down => Some("Escape"),
        _ => None,
    }
}

/// One line of the helper's stdout protocol.
#[derive(Debug, PartialEq, Eq)]
pub enum HelperLine {
    /// `k <0|1> <code>`: a swallowed key.
    Key(SpecialKey),
    /// `n <calls>`: hook procedure calls so far (diagnostics).
    Calls(u64),
}

pub fn format_key(key: &SpecialKey) -> String {
    format!("k {} {}\n", u8::from(key.down), key.code)
}

pub fn parse_helper_line(line: &str) -> Option<HelperLine> {
    let mut parts = line.split_whitespace();
    match (parts.next()?, parts.next()?, parts.next()) {
        ("k", down, Some(code)) => {
            let code = SPECIAL_KEY_CODES
                .iter()
                .copied()
                .find(|known| *known == code)?;
            let down = match down {
                "1" => true,
                "0" => false,
                _ => return None,
            };
            Some(HelperLine::Key(SpecialKey { code, down }))
        }
        ("n", calls, None) => calls.parse().ok().map(HelperLine::Calls),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::{HelperLine, SpecialKey, classify, format_key, parse_helper_line};

    #[test]
    fn only_system_shortcuts_are_intercepted() {
        assert_eq!(classify(0x5B, false, false), Some("MetaLeft"));
        assert_eq!(classify(0x5C, false, false), Some("MetaRight"));
        assert_eq!(classify(0x2C, false, false), Some("PrintScreen"));
        assert_eq!(classify(0x09, true, false), Some("Tab"));
        assert_eq!(classify(0x09, false, false), None);
        assert_eq!(classify(0x1B, true, false), Some("Escape"));
        assert_eq!(classify(0x1B, false, true), Some("Escape"));
        assert_eq!(classify(0x1B, false, false), None);
        assert_eq!(classify(0x41, true, true), None);
    }

    #[test]
    fn helper_lines_round_trip_and_reject_unknown_keys() {
        let key = SpecialKey {
            code: "PrintScreen",
            down: true,
        };
        assert_eq!(
            parse_helper_line(format_key(&key).trim_end()),
            Some(HelperLine::Key(key))
        );
        assert_eq!(
            parse_helper_line("k 0 Escape"),
            Some(HelperLine::Key(SpecialKey {
                code: "Escape",
                down: false
            }))
        );
        assert_eq!(parse_helper_line("n 42"), Some(HelperLine::Calls(42)));
        assert_eq!(parse_helper_line("k 1 KeyA"), None);
        assert_eq!(parse_helper_line("k 2 Tab"), None);
        assert_eq!(parse_helper_line("n"), None);
        assert_eq!(parse_helper_line("garbage"), None);
    }
}
