//! Calendar invitation data shared by the desktop and the signed Mail host.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MailInviteTime {
    /// Epoch seconds when the value is UTC (`Z`) or a date.
    pub epoch: Option<i64>,
    /// `YYYY-MM-DD` or `YYYY-MM-DDTHH:MM` as written (sender's wall clock).
    pub local: String,
    pub tzid: Option<String>,
    pub all_day: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MailInviteAttendee {
    pub email: String,
    pub name: Option<String>,
    /// NEEDS-ACTION | ACCEPTED | TENTATIVE | DECLINED | DELEGATED
    pub partstat: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MailInvite {
    /// REQUEST | CANCEL | REPLY | PUBLISH ...
    pub method: String,
    pub uid: String,
    pub sequence: u32,
    pub summary: String,
    pub location: Option<String>,
    pub description: Option<String>,
    pub start: Option<MailInviteTime>,
    pub end: Option<MailInviteTime>,
    pub organizer: Option<MailInviteAttendee>,
    pub attendees: Vec<MailInviteAttendee>,
    /// VEVENT STATUS (CONFIRMED / TENTATIVE / CANCELLED).
    pub status: Option<String>,
    /// The original calendar text, for "Export .ics".
    pub ics: String,
}
