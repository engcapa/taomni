//! Human-readable cloud folders with an immutable identity suffix.
use crate::backup::model::validate_id;

pub fn parse(name: &str) -> Option<(&str, &str)> {
    if validate_id(name).is_ok() {
        return Some((name, name)); // Original UUID-only layout.
    }
    let (label, id) = name.strip_suffix(']')?.rsplit_once(" [")?;
    if label.trim().is_empty() || validate_id(id).is_err() {
        return None;
    }
    Some((id, label))
}

pub fn title(label: &str, id: &str) -> Result<String, String> {
    validate_id(id)?;
    let mut clean = String::new();
    for c in label.trim().chars() {
        if clean.len() + c.len_utf8() > 120 {
            break;
        }
        clean.push(if c.is_control() || matches!(c, '/' | '\\' | '[' | ']') {
            '_'
        } else {
            c
        });
    }
    let label = if clean.trim().is_empty() {
        "Taomni"
    } else {
        clean.trim()
    };
    Ok(format!("{label} [{id}]"))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rename_keeps_full_identity_and_accepts_legacy_layout() {
        let id = "762905aa-5169-4f71-9027-c2b1c7a60315";
        assert_eq!(parse(id), Some((id, id)));
        for label in ["办公电脑", "Office laptop", "NAS/Team [shared]"] {
            let name = title(label, id).unwrap();
            assert_eq!(parse(&name).unwrap().0, id);
            assert!(!parse(&name).unwrap().1.contains('/'));
        }
        assert!(parse("Office [not-a-device-id]").is_none());
        assert!(parse(&format!(" [{id}]")).is_none());
        assert!(title("Office", "bad").is_err());
        assert!(title(&"机".repeat(200), id).unwrap().len() < 180);
    }
}
