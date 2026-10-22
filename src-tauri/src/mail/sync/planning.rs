use std::collections::HashSet;

// ---------------------------------------------------------------------------
// Planning (pure)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(in crate::mail) struct FillPlan {
    /// UIDs to fetch now, ascending (the newest `limit` missing ones).
    pub fetch: Vec<u32>,
    /// Cached UIDs in range that the server no longer has.
    pub vanished: Vec<u32>,
    /// Missing UIDs left for later steps.
    pub remaining: usize,
    pub server_max: Option<u32>,
}

/// Plan filling `[lo, hi]` (hi = None means open-ended) from the server UID
/// set: fetch what is missing (newest first), report what vanished.
pub(in crate::mail) fn plan_fill_range(
    server: &[u32],
    cached: &[u32],
    lo: u32,
    hi: Option<u32>,
    limit: usize,
) -> FillPlan {
    let in_range = |uid: &u32| *uid >= lo && hi.is_none_or(|hi| *uid <= hi);
    let server: Vec<u32> = server.iter().copied().filter(in_range).collect();
    let server_set: HashSet<u32> = server.iter().copied().collect();
    let cached_set: HashSet<u32> = cached.iter().copied().filter(in_range).collect();
    let mut missing: Vec<u32> = server
        .iter()
        .copied()
        .filter(|uid| !cached_set.contains(uid))
        .collect();
    missing.sort_unstable();
    missing.dedup();
    let take = limit.max(1).min(missing.len());
    let mut fetch = missing[missing.len() - take..].to_vec();
    fetch.sort_unstable();
    let mut vanished: Vec<u32> = cached_set
        .iter()
        .copied()
        .filter(|uid| !server_set.contains(uid))
        .collect();
    vanished.sort_unstable();
    FillPlan {
        remaining: missing.len() - take,
        fetch,
        vanished,
        server_max: server.iter().copied().max(),
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(in crate::mail) struct BackfillPlan {
    pub fetch: Vec<u32>,
    pub new_low: Option<u32>,
    pub complete: bool,
}

/// Plan the next older block below the span. `older` are server UIDs below
/// `low` found by a search whose window reached UID 1 iff `reached_start`.
pub(in crate::mail) fn plan_backfill(
    older: &[u32],
    cached: &[u32],
    reached_start: bool,
    limit: usize,
) -> BackfillPlan {
    let mut older = older.to_vec();
    older.sort_unstable();
    older.dedup();
    let take = limit.max(1).min(older.len());
    let block = &older[older.len() - take..];
    let cached_set: HashSet<u32> = cached.iter().copied().collect();
    BackfillPlan {
        fetch: block
            .iter()
            .copied()
            .filter(|uid| !cached_set.contains(uid))
            .collect(),
        new_low: block.first().copied(),
        complete: reached_start && older.len() <= take,
    }
}

/// Lower bound of the newest `window` cached UIDs (quiet reconcile range).
pub(in crate::mail) fn recent_window_start(cached: &[u32], low: u32, window: usize) -> u32 {
    if cached.len() > window {
        cached[cached.len() - window].max(low)
    } else {
        low
    }
}
