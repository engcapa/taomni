use super::planning::{plan_backfill, plan_fill_range, recent_window_start};
#[cfg(feature = "imap-runtime")]
use super::protocol::parse_examine_response;
use crate::imap_folders::quote_imap_string;

#[test]
fn fill_plan_fetches_newest_missing_first_and_reports_vanished() {
    let server: Vec<u32> = (1..=10).chain(20..=25).collect();
    let cached = vec![1, 2, 3, 9, 10, 11, 25];
    let plan = plan_fill_range(&server, &cached, 1, None, 4);
    assert_eq!(plan.fetch, vec![21, 22, 23, 24]);
    assert_eq!(plan.remaining, 1 + 5); // 20 and 4..=8
    assert_eq!(plan.vanished, vec![11]);
    assert_eq!(plan.server_max, Some(25));
}

#[test]
fn fill_plan_clamps_open_range_and_star_semantics() {
    // `UID 51:*` on a server whose max UID is 50 returns 50.
    let plan = plan_fill_range(&[50], &[], 51, None, 10);
    assert!(plan.fetch.is_empty());
    assert_eq!(plan.server_max, None);
    let plan = plan_fill_range(&[1, 5, 9], &[1, 5, 9, 12], 5, Some(9), 10);
    assert!(plan.fetch.is_empty());
    assert!(plan.vanished.is_empty(), "12 is outside the range");
}

/// Simulates repeated catch-up steps after a long absence (R1): all new
/// UIDs end up cached regardless of the batch size.
#[test]
fn repeated_catchup_converges_without_gaps() {
    let mut cached: Vec<u32> = (1..=100).collect();
    let high = 100u32;
    let server: Vec<u32> = (1..=100).chain(101..=320).collect();
    let mut steps = 0;
    loop {
        let plan = plan_fill_range(&server, &cached, high + 1, None, 50);
        cached.extend(&plan.fetch);
        cached.sort_unstable();
        steps += 1;
        if plan.remaining == 0 {
            break;
        }
        // An interrupted step (nothing written) is recomputed next time.
        if steps == 2 {
            let again = plan_fill_range(&server, &cached, high + 1, None, 50);
            assert_eq!(again.remaining + again.fetch.len(), plan.remaining);
        }
    }
    assert_eq!(cached, server);
    assert_eq!(steps, 5);
}

#[test]
fn backfill_walks_down_and_completes() {
    let server: Vec<u32> = (1..=130).collect();
    let mut cached: Vec<u32> = (101..=130).collect();
    let mut low = 101u32;
    let mut complete = false;
    let mut rounds = 0;
    while !complete {
        let older: Vec<u32> = server.iter().copied().filter(|uid| *uid < low).collect();
        let plan = plan_backfill(&older, &cached, true, 40);
        cached.extend(&plan.fetch);
        low = plan.new_low.unwrap_or(low);
        complete = plan.complete;
        rounds += 1;
    }
    cached.sort_unstable();
    assert_eq!(cached, server);
    assert_eq!(low, 1);
    assert_eq!(rounds, 3);
    // An empty search below the span completes immediately.
    let plan = plan_backfill(&[], &cached, true, 40);
    assert!(plan.complete && plan.fetch.is_empty() && plan.new_low.is_none());
    // A window that did not reach UID 1 cannot complete.
    assert!(!plan_backfill(&[5, 6], &[], false, 40).complete);
}

#[test]
fn recent_window_start_uses_newest_cached_uids() {
    let cached: Vec<u32> = (1..=10).collect();
    assert_eq!(recent_window_start(&cached, 1, 3), 8);
    assert_eq!(recent_window_start(&cached, 1, 30), 1);
    assert_eq!(recent_window_start(&cached, 9, 3), 9);
}

#[cfg(feature = "imap-runtime")]
#[test]
fn parses_condstore_examine_response() {
    let raw = "* FLAGS (\\Answered \\Flagged \\Seen $Junk)\r\n\
                   * OK [PERMANENTFLAGS ()] Read-only\r\n\
                   * 172 EXISTS\r\n\
                   * 0 RECENT\r\n\
                   * OK [UIDVALIDITY 3857529045] UIDs valid\r\n\
                   * OK [UIDNEXT 4392] Predicted next UID\r\n\
                   * OK [HIGHESTMODSEQ 715194045007] Highest\r\n\
                   A5 OK [READ-ONLY] EXAMINE completed\r\n";
    let parsed = parse_examine_response(raw);
    assert_eq!(parsed.exists, 172);
    assert_eq!(parsed.uid_validity, Some(3_857_529_045));
    assert_eq!(parsed.uid_next, Some(4392));
    assert_eq!(parsed.highest_modseq, Some(715_194_045_007));
    assert_eq!(
        parsed.flags,
        vec!["\\Answered", "\\Flagged", "\\Seen", "$Junk"]
    );
}

#[test]
fn quotes_mailbox_names() {
    assert_eq!(quote_imap_string("INBOX"), "\"INBOX\"");
    assert_eq!(quote_imap_string("a\"b\\c"), "\"a\\\"b\\\\c\"");
    assert_eq!(quote_imap_string("x\r\ny"), "\"xy\"");
}
