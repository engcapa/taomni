use serde_json::json;
use std::collections::HashMap;
use std::net::IpAddr;
use std::time::Duration;
use std::time::Instant;

/// Identifies a connection by its **client-side** `(ip, port)`.
///
/// A tuple, not a `"ip:port"` string: the old string keys cost one heap
/// allocation per packet to build and forced port-only lookups to be an O(n)
/// `ends_with(":port")` scan of the whole table while holding its lock.
pub(super) type FlowKey = (IpAddr, u16);

#[derive(Debug, Clone)]
pub(super) struct RedirectMapping {
    /// Client local address (original TCP source).
    pub(super) orig_src: IpAddr,
    pub(super) orig_sport: u16,
    /// Original remote destination.
    pub(super) orig_dst: IpAddr,
    pub(super) orig_port: u16,
    pub(super) pid: u32,
    pub(super) path: String,
}

/// What was decided for a connection the first time we saw it.
#[derive(Debug, Clone)]
pub(super) enum FlowVerdict {
    /// Reflect toward the relay; carries what the relay needs to recover the
    /// original destination.
    Redirect(RedirectMapping),
    /// Pass through untouched (bypassed process/endpoint, out of scope, ...).
    Bypass,
}

/// Cheap answer for the packet hot path — no allocation, no clone.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum FlowAction {
    Redirect,
    Bypass,
}

#[derive(Debug, Clone)]
pub(super) struct FlowEntry {
    /// Destination this verdict was reached for. A packet whose destination
    /// differs is, by definition, a different connection.
    pub(super) dst: IpAddr,
    pub(super) dport: u16,
    pub(super) verdict: FlowVerdict,
    pub(super) expires_at: Instant,
}

/// Idle lifetime of a decision. Only a backstop: FLOW delete events and
/// FIN/RST close entries far sooner. Long enough that a genuinely idle but
/// live connection (SSH, websocket) is not dropped before the peer speaks
/// again — losing the entry mid-connection would leave the relay's reply
/// packets untranslated.
pub(super) const FLOW_IDLE_TTL: Duration = Duration::from_secs(30 * 60);
/// Grace after FIN/RST so the remainder of the close handshake still
/// translates, while a closed connection still releases its slot promptly.
pub(super) const FLOW_CLOSE_GRACE: Duration = Duration::from_secs(10);
/// Hard ceiling. Larger than the ~16k Windows ephemeral port range, so live
/// traffic cannot legitimately reach it; the soonest-to-expire go first.
pub(super) const MAX_FLOW_ENTRIES: usize = 32_768;
/// Amortised sweep cadence for expired entries.
pub(super) const FLOW_SWEEP_INTERVAL: Duration = Duration::from_secs(15);

/// Per-connection decisions, keyed by the client's `(ip, port)`.
///
/// Capture *and* bypass verdicts live here together on purpose: they must share
/// one invalidation rule. The previous design cached only redirects and tested
/// mere key presence, so once Windows recycled an ephemeral port — there are
/// only ~16k, so on a busy host this is a matter of hours — the new connection
/// silently inherited the previous connection's destination. That is what made
/// long-running sessions degrade and eventually wedge. Validating the
/// destination on every lookup removes the whole class of bug, and it must hold
/// for the bypass cache too, or caching bypass decisions would simply reintroduce
/// it on the other side.
#[derive(Default)]
pub(super) struct FlowTable {
    pub(super) entries: HashMap<FlowKey, FlowEntry>,
    /// `(orig_dst, client_port)` → client key. Both the relay (as its accepted
    /// peer address) and the proxy→client packets see the reflected connection
    /// under this address.
    pub(super) peer_index: HashMap<FlowKey, FlowKey>,
    /// `client_port` → client key, for `lookup_orig` without a source IP.
    /// Replaces the old O(n) suffix scan.
    pub(super) sport_index: HashMap<u16, FlowKey>,
    pub(super) last_sweep: Option<Instant>,
}

impl FlowTable {
    /// Decision for this packet's connection, or `None` when it must be
    /// classified afresh.
    ///
    /// A cached entry whose destination does not match the packet belongs to a
    /// previous connection that happened to use the same local port; it is
    /// dropped rather than reused.
    pub(super) fn lookup(
        &mut self,
        key: FlowKey,
        dst: IpAddr,
        dport: u16,
        now: Instant,
    ) -> Option<FlowAction> {
        match self.entries.get(&key) {
            Some(e) if e.dst == dst && e.dport == dport => {}
            Some(_) => {
                self.remove(&key);
                return None;
            }
            None => return None,
        }
        let e = self.entries.get_mut(&key)?;
        e.expires_at = now + FLOW_IDLE_TTL;
        Some(match e.verdict {
            FlowVerdict::Redirect(_) => FlowAction::Redirect,
            FlowVerdict::Bypass => FlowAction::Bypass,
        })
    }

    pub(super) fn insert(
        &mut self,
        key: FlowKey,
        dst: IpAddr,
        dport: u16,
        verdict: FlowVerdict,
        now: Instant,
    ) {
        self.remove(&key);
        if let FlowVerdict::Redirect(m) = &verdict {
            self.peer_index.insert((m.orig_dst, m.orig_sport), key);
            self.sport_index.insert(m.orig_sport, key);
        }
        self.entries.insert(
            key,
            FlowEntry {
                dst,
                dport,
                verdict,
                expires_at: now + FLOW_IDLE_TTL,
            },
        );
        if self.entries.len() > MAX_FLOW_ENTRIES {
            self.evict_overflow();
        }
    }

    pub(super) fn remove(&mut self, key: &FlowKey) {
        let Some(e) = self.entries.remove(key) else {
            return;
        };
        if let FlowVerdict::Redirect(m) = &e.verdict {
            let peer = (m.orig_dst, m.orig_sport);
            if self.peer_index.get(&peer) == Some(key) {
                self.peer_index.remove(&peer);
            }
            if self.sport_index.get(&m.orig_sport) == Some(key) {
                self.sport_index.remove(&m.orig_sport);
            }
        }
    }

    /// Original destination port for a proxy→client packet, plus the client key
    /// so the caller can note a close. Refreshes the entry: the relay side of a
    /// busy connection keeps it alive just as the client side does.
    pub(super) fn peer_lookup(&mut self, peer: FlowKey, now: Instant) -> Option<(FlowKey, u16)> {
        let key = *self.peer_index.get(&peer)?;
        let e = self.entries.get_mut(&key)?;
        let FlowVerdict::Redirect(m) = &e.verdict else {
            return None;
        };
        let port = m.orig_port;
        e.expires_at = now + FLOW_IDLE_TTL;
        Some((key, port))
    }

    /// Bring an entry's expiry forward after FIN/RST. Later traffic (half-close
    /// keeps one direction open) pushes it back out again via `lookup`.
    pub(super) fn mark_closing(&mut self, key: &FlowKey, now: Instant) {
        if let Some(e) = self.entries.get_mut(key) {
            let deadline = now + FLOW_CLOSE_GRACE;
            if deadline < e.expires_at {
                e.expires_at = deadline;
            }
        }
    }

    pub(super) fn mapping_by_peer(&self, peer: FlowKey) -> Option<RedirectMapping> {
        let key = self.peer_index.get(&peer)?;
        match &self.entries.get(key)?.verdict {
            FlowVerdict::Redirect(m) => Some(m.clone()),
            FlowVerdict::Bypass => None,
        }
    }

    pub(super) fn mapping_by_sport(&self, sport: u16) -> Option<RedirectMapping> {
        let key = self.sport_index.get(&sport)?;
        match &self.entries.get(key)?.verdict {
            FlowVerdict::Redirect(m) => Some(m.clone()),
            FlowVerdict::Bypass => None,
        }
    }

    pub(super) fn sweep_if_due(&mut self, now: Instant) {
        if let Some(last) = self.last_sweep {
            if now.duration_since(last) < FLOW_SWEEP_INTERVAL {
                return;
            }
        }
        self.last_sweep = Some(now);
        let expired: Vec<FlowKey> = self
            .entries
            .iter()
            .filter(|(_, e)| e.expires_at <= now)
            .map(|(k, _)| *k)
            .collect();
        for k in &expired {
            self.remove(k);
        }
    }

    /// Drop the soonest-to-expire eighth of the table. Reaching the cap means
    /// eviction signals are being missed, so free enough at once to avoid
    /// re-triggering on every subsequent insert.
    pub(super) fn evict_overflow(&mut self) {
        let target = self.entries.len().saturating_sub(MAX_FLOW_ENTRIES * 7 / 8);
        let mut by_deadline: Vec<(Instant, FlowKey)> = self
            .entries
            .iter()
            .map(|(k, e)| (e.expires_at, *k))
            .collect();
        by_deadline.sort_unstable_by_key(|(t, _)| *t);
        for (_, k) in by_deadline.into_iter().take(target) {
            self.remove(&k);
        }
        tracing::warn!(
            "sockscap-helper: flow table hit {MAX_FLOW_ENTRIES} entries; evicted {target} oldest"
        );
    }

    pub(super) fn len(&self) -> usize {
        self.entries.len()
    }
}

pub(super) fn mapping_json(m: &RedirectMapping) -> serde_json::Value {
    json!({
        "dstIp": m.orig_dst.to_string(),
        "dstPort": m.orig_port,
        "pid": m.pid,
        "path": m.path,
    })
}
