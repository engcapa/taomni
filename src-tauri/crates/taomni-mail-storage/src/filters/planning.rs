use super::matching::filter_matches;
use super::model::FilterMessage;
use super::model::MailFilter;
use super::model::MailFilterActionKind;
use super::model::MailFilterField;
use super::model::MailFilterOp;
use regex::RegexBuilder;
use std::collections::HashSet;

/// What the matching filters want done to one message.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct MessagePlan {
    pub matched: Vec<String>,
    pub mark_read: bool,
    pub mark_unread: bool,
    pub star: bool,
    pub tags: Vec<String>,
    pub copies: Vec<String>,
    pub forwards: Vec<String>,
    /// Final location; moves and deletes end filtering for the message.
    pub move_to: Option<String>,
    pub delete: bool,
}

impl MessagePlan {
    pub fn is_empty(&self) -> bool {
        self.matched.is_empty()
    }
}

/// Run `filters` in order against one message (Thunderbird semantics: every
/// matching filter applies; "Stop", move and delete end the chain).
pub fn plan_message(filters: &[&MailFilter], message: &FilterMessage) -> MessagePlan {
    let mut plan = MessagePlan::default();
    'filters: for filter in filters {
        if !filter.enabled || !filter_matches(filter, message) {
            continue;
        }
        plan.matched.push(filter.name.clone());
        for action in &filter.actions {
            let value = action
                .value
                .as_deref()
                .map(str::trim)
                .filter(|v| !v.is_empty());
            match action.kind {
                MailFilterActionKind::MarkRead => {
                    plan.mark_read = true;
                    plan.mark_unread = false;
                }
                MailFilterActionKind::MarkUnread => {
                    plan.mark_unread = true;
                    plan.mark_read = false;
                }
                MailFilterActionKind::Star => plan.star = true,
                MailFilterActionKind::AddTag => {
                    if let Some(tag) = value.filter(|t| !plan.tags.iter().any(|x| x == t)) {
                        plan.tags.push(tag.to_string());
                    }
                }
                MailFilterActionKind::CopyTo => {
                    if let Some(folder) = value.filter(|f| *f != message.header.folder) {
                        plan.copies.push(folder.to_string());
                    }
                }
                MailFilterActionKind::Forward => {
                    if let Some(address) = value {
                        plan.forwards.push(address.to_string());
                    }
                }
                MailFilterActionKind::MoveTo => {
                    if let Some(folder) = value.filter(|f| *f != message.header.folder) {
                        plan.move_to = Some(folder.to_string());
                        break 'filters;
                    }
                }
                MailFilterActionKind::Delete => {
                    plan.delete = true;
                    break 'filters;
                }
                MailFilterActionKind::Stop => break 'filters,
            }
        }
    }
    plan
}

pub(super) fn validate_filter(filter: &MailFilter) -> Result<(), String> {
    let label = if filter.name.trim().is_empty() {
        "a filter"
    } else {
        filter.name.trim()
    };
    if filter.name.trim().is_empty() {
        return Err("every filter needs a name".into());
    }
    if filter.conditions.is_empty() {
        return Err(format!("{label}: add at least one condition"));
    }
    if filter.actions.is_empty() {
        return Err(format!("{label}: add at least one action"));
    }
    for condition in &filter.conditions {
        let numeric = matches!(
            condition.field,
            MailFilterField::SizeKb | MailFilterField::AgeDays
        );
        if numeric && condition.value.trim().parse::<f64>().is_err() {
            return Err(format!("{label}: \"{}\" is not a number", condition.value));
        }
        if condition.op == MailFilterOp::Matches {
            RegexBuilder::new(&condition.value)
                .size_limit(1 << 20)
                .build()
                .map_err(|e| format!("{label}: invalid regular expression: {e}"))?;
        }
        let flag_field = matches!(condition.field, MailFilterField::HasAttachment);
        if !numeric && !flag_field && condition.value.trim().is_empty() {
            return Err(format!("{label}: a condition has no value"));
        }
    }
    for action in &filter.actions {
        let needs_value = matches!(
            action.kind,
            MailFilterActionKind::MoveTo
                | MailFilterActionKind::CopyTo
                | MailFilterActionKind::AddTag
                | MailFilterActionKind::Forward
        );
        let value = action.value.as_deref().unwrap_or("").trim();
        if needs_value && value.is_empty() {
            return Err(format!("{label}: an action needs a folder, tag or address"));
        }
        if action.kind == MailFilterActionKind::Forward && !value.contains('@') {
            return Err(format!("{label}: forward needs an email address"));
        }
    }
    Ok(())
}

pub fn prepare_filters(mut filters: Vec<MailFilter>) -> Result<Vec<MailFilter>, String> {
    let mut seen = HashSet::new();
    let stamp = crate::now_ts();
    for (index, filter) in filters.iter_mut().enumerate() {
        filter.name = filter.name.trim().to_string();
        validate_filter(filter)?;
        if filter.id.trim().is_empty() || !seen.insert(filter.id.clone()) {
            filter.id = format!("filter-{stamp}-{index}");
            seen.insert(filter.id.clone());
        }
    }
    Ok(filters)
}
