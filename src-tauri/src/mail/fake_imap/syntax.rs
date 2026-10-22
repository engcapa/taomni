pub(super) fn quote(value: &str) -> String {
    format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\""))
}

pub(super) fn unquote(value: &str) -> String {
    let value = value.trim();
    if value.len() >= 2 && value.starts_with('"') && value.ends_with('"') {
        value[1..value.len() - 1]
            .replace("\\\"", "\"")
            .replace("\\\\", "\\")
    } else {
        value.to_string()
    }
}

/// Split an argument string into the first (possibly quoted) token and rest.
pub(super) fn split_first_arg(input: &str) -> (String, &str) {
    let input = input.trim_start();
    if let Some(rest) = input.strip_prefix('"') {
        let mut escaped = false;
        for (index, ch) in rest.char_indices() {
            if escaped {
                escaped = false;
            } else if ch == '\\' {
                escaped = true;
            } else if ch == '"' {
                return (unquote(&input[..index + 2]), &rest[index + 1..]);
            }
        }
        (unquote(input), "")
    } else {
        match input.find(' ') {
            Some(index) => (input[..index].to_string(), &input[index + 1..]),
            None => (input.to_string(), ""),
        }
    }
}

pub(super) fn parse_uid_set(set: &str, max: u32) -> Vec<(u32, u32)> {
    set.split(',')
        .filter_map(|part| {
            let bound = |value: &str| -> Option<u32> {
                if value == "*" {
                    Some(max)
                } else {
                    value.parse().ok()
                }
            };
            let (a, b) = match part.split_once(':') {
                Some((a, b)) => (bound(a)?, bound(b)?),
                None => {
                    let value = bound(part)?;
                    (value, value)
                }
            };
            Some((a.min(b), a.max(b)))
        })
        .collect()
}

pub(super) fn in_set(uid: u32, ranges: &[(u32, u32)]) -> bool {
    ranges.iter().any(|(a, b)| uid >= *a && uid <= *b)
}

pub(super) fn format_internal_date(ts: i64) -> String {
    let dt = chrono::DateTime::from_timestamp(ts, 0).unwrap();
    dt.format("%d-%b-%Y %H:%M:%S +0000").to_string()
}
