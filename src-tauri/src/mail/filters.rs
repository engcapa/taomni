//! Message filters (TASK-13, DEC-11): Thunderbird-style rules with several
//! conditions (all / any) and several actions, run on new INBOX mail while
//! the tab is open and manually on any folder.
//!
//! Rules live per account in `mail_filters`. `mail_filter_marks` remembers
//! the highest UID already offered to the incoming filters per folder, so a
//! message is filtered once and old mail is never re-filtered. Actions reuse
//! the regular mail commands (which keep the cache in step); a failing
//! action leaves the message where it is and is reported (AC-42).

mod model;

mod matching;

mod planning;

mod cache;

mod imap_search;

mod actions;

mod execution;

mod commands;

#[cfg(test)]
mod tests;

pub use model::{
    MailFilter, MailFilterAction, MailFilterActionKind, MailFilterCondition, MailFilterField,
    MailFilterOp, MailFilterRunResult,
};

pub(super) use model::FilterMessage;

pub(super) use matching::{condition_matches, filter_matches};

pub(super) use planning::{MessagePlan, plan_message, validate_filter};

pub(super) use cache::{
    ensure_filter_mark, filter_mark, load_filters, migrate_filter_tables, set_filter_mark,
    store_filters,
};

pub use execution::mail_apply_filters;

pub(crate) use execution::{__cmd__mail_apply_filters, __tauri_command_name_mail_apply_filters};

pub use commands::{
    mail_export_filters, mail_import_filters, mail_list_filters, mail_save_filters,
};

pub(super) use commands::parse_filter_file;

pub(crate) use commands::{
    __cmd__mail_export_filters, __cmd__mail_import_filters, __cmd__mail_list_filters,
    __cmd__mail_save_filters, __tauri_command_name_mail_export_filters,
    __tauri_command_name_mail_import_filters, __tauri_command_name_mail_list_filters,
    __tauri_command_name_mail_save_filters,
};
