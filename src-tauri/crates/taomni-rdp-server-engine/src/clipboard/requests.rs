use super::host_content::HostContent;
use ironrdp::cliprdr::pdu::ClipboardFormatId;
use std::collections::VecDeque;

/// A format pulled from the client.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Fetch {
    Text,
    Html,
    Image,
    FileList,
}

/// Formats of one remote copy still to be pulled, and what arrived so far.
#[derive(Default)]
pub(super) struct Incoming {
    pub(super) queue: VecDeque<(Fetch, ClipboardFormatId)>,
    pub(super) pending: Option<Fetch>,
    pub(super) content: HostContent,
}

/// Format data responses carry no format id; they answer requests in order.
/// A new client format list supersedes the fetch in progress, yet answers to
/// requests already sent still arrive. They must not be taken for the new
/// copy: a client announcing twice in a row (its clipboard at Monitor Ready,
/// then a copy) would otherwise get its text stored as HTML or its file
/// list dropped. One request is outstanding at a time, so the file-list
/// correlation inside ironrdp-cliprdr stays aligned as well.
#[derive(Debug, Default)]
pub(super) struct RequestGate {
    pub(super) in_flight: usize,
    pub(super) stale: usize,
}

impl RequestGate {
    pub(super) fn sent(&mut self) {
        self.in_flight += 1;
    }

    /// The client clipboard changed: everything still unanswered is stale.
    pub(super) fn supersede(&mut self) {
        self.stale = self.in_flight;
    }

    /// A response arrived; `false` when it answers a superseded request.
    pub(super) fn answered(&mut self) -> bool {
        self.in_flight = self.in_flight.saturating_sub(1);
        if self.stale > 0 {
            self.stale -= 1;
            return false;
        }
        true
    }

    pub(super) fn idle(&self) -> bool {
        self.in_flight == 0
    }
}
