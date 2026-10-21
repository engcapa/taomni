use super::model::FilterMessage;
use super::model::MailFilter;
use super::model::MailFilterCondition;
use super::model::MailFilterField;
use super::model::MailFilterOp;
use regex::RegexBuilder;

pub(super) fn text_matches(op: MailFilterOp, haystack: &str, needle: &str) -> bool {
    let hay = haystack.to_lowercase();
    let needle_lower = needle.to_lowercase();
    match op {
        MailFilterOp::Contains => hay.contains(&needle_lower),
        MailFilterOp::NotContains => !hay.contains(&needle_lower),
        MailFilterOp::Is => hay.trim() == needle_lower.trim(),
        MailFilterOp::IsNot => hay.trim() != needle_lower.trim(),
        MailFilterOp::BeginsWith => hay.trim_start().starts_with(needle_lower.trim()),
        MailFilterOp::EndsWith => hay.trim_end().ends_with(needle_lower.trim()),
        MailFilterOp::Matches => RegexBuilder::new(needle)
            .case_insensitive(true)
            .size_limit(1 << 20)
            .build()
            .is_ok_and(|re| re.is_match(haystack)),
        MailFilterOp::GreaterThan | MailFilterOp::LessThan => false,
    }
}

pub(super) fn number_matches(op: MailFilterOp, actual: Option<f64>, value: &str) -> bool {
    let (Some(actual), Ok(limit)) = (actual, value.trim().parse::<f64>()) else {
        return false;
    };
    match op {
        MailFilterOp::GreaterThan => actual > limit,
        MailFilterOp::LessThan => actual < limit,
        MailFilterOp::Is => (actual - limit).abs() < f64::EPSILON,
        MailFilterOp::IsNot => (actual - limit).abs() >= f64::EPSILON,
        _ => false,
    }
}

pub(super) fn address_text(addresses: &[&super::super::MailAddress]) -> String {
    addresses
        .iter()
        .map(|a| {
            format!(
                "{} <{}>",
                a.name.as_deref().unwrap_or(""),
                a.address.as_deref().unwrap_or("")
            )
        })
        .collect::<Vec<_>>()
        .join(", ")
}

/// Address fields: `is`/`begins`/`ends` compare each address (or name) on
/// its own, so "is boss@example.com" works on a multi-recipient To.
pub(super) fn address_matches(
    op: MailFilterOp,
    addresses: &[&super::super::MailAddress],
    value: &str,
) -> bool {
    let each = |test: &dyn Fn(&str) -> bool| {
        addresses
            .iter()
            .any(|a| a.address.as_deref().is_some_and(test) || a.name.as_deref().is_some_and(test))
    };
    match op {
        MailFilterOp::Is | MailFilterOp::BeginsWith | MailFilterOp::EndsWith => {
            each(&|part| text_matches(op, part, value))
        }
        MailFilterOp::IsNot => !each(&|part| text_matches(MailFilterOp::Is, part, value)),
        _ => text_matches(op, &address_text(addresses), value),
    }
}

pub(in crate::mail) fn condition_matches(
    condition: &MailFilterCondition,
    message: &FilterMessage,
) -> bool {
    let header = message.header;
    let value = condition.value.as_str();
    match condition.field {
        MailFilterField::From => {
            let from: Vec<_> = header.from.iter().collect();
            address_matches(condition.op, &from, value)
        }
        MailFilterField::To => {
            address_matches(condition.op, &header.to.iter().collect::<Vec<_>>(), value)
        }
        MailFilterField::Cc => {
            address_matches(condition.op, &header.cc.iter().collect::<Vec<_>>(), value)
        }
        MailFilterField::ToOrCc => {
            let all: Vec<_> = header.to.iter().chain(header.cc.iter()).collect();
            address_matches(condition.op, &all, value)
        }
        MailFilterField::Subject => text_matches(condition.op, &header.subject, value),
        MailFilterField::Body => match message.body {
            Some(body) => text_matches(condition.op, body, value),
            None => {
                let found = message
                    .server_body
                    .is_some_and(|hits| hits.contains(&value.to_lowercase()));
                match condition.op {
                    MailFilterOp::Contains => found,
                    MailFilterOp::NotContains => !found,
                    // Other body operators need the text; uncached bodies never match.
                    _ => false,
                }
            }
        },
        MailFilterField::SizeKb => number_matches(
            condition.op,
            header.raw_size.map(|size| size as f64 / 1024.0),
            value,
        ),
        MailFilterField::AgeDays => number_matches(
            condition.op,
            header
                .date_ts
                .map(|ts| (message.now - ts) as f64 / 86_400.0),
            value,
        ),
        MailFilterField::Tag => {
            let has = header
                .flags
                .iter()
                .any(|flag| flag.eq_ignore_ascii_case(value.trim()));
            match condition.op {
                MailFilterOp::IsNot | MailFilterOp::NotContains => !has,
                _ => has,
            }
        }
        MailFilterField::HasAttachment => {
            let has = header.has_attachments || header.attachment_count > 0;
            let wanted = !matches!(value.trim(), "false" | "no" | "0");
            match condition.op {
                MailFilterOp::IsNot => has != wanted,
                _ => has == wanted,
            }
        }
    }
}

pub(in crate::mail) fn filter_matches(filter: &MailFilter, message: &FilterMessage) -> bool {
    if filter.conditions.is_empty() {
        return false;
    }
    if filter.match_any {
        filter
            .conditions
            .iter()
            .any(|c| condition_matches(c, message))
    } else {
        filter
            .conditions
            .iter()
            .all(|c| condition_matches(c, message))
    }
}
