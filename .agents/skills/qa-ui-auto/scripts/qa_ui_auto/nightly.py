"""Nightly coverage policy: platform gating and tier-B native sampling.

Pure helpers so a night's selection can be reproduced locally from the label,
the case catalog and the dependency map without a runner.
"""
from __future__ import annotations

import datetime as dt
import hashlib
import math

PLATFORMS = ("Linux", "Windows", "macOS")
WEEKDAYS = ("mon", "tue", "wed", "thu", "fri", "sat", "sun")
NOMINAL_UTC_HOUR = 19
NOMINAL_UTC_MINUTE = 17
DEFAULT_WINDOWS_NIGHTS = "fri,sat,sun"
DEFAULT_SAMPLE_PERCENT = 20
MAX_LABEL_SKEW = dt.timedelta(hours=36)


def night_label(now: dt.datetime | None = None) -> dt.date:
    """Return the Beijing 'evening' date of the most recent nominal trigger.

    The cron fires at 19:17 UTC, which is 03:17 Beijing on the next calendar
    day; the evening that run represents is the UTC date of the nominal
    trigger. GitHub may create the run hours later, so the nominal trigger is
    not the run's own ``created_at``.
    """
    now = now or dt.datetime.now(dt.timezone.utc)
    if now.tzinfo is None:
        now = now.replace(tzinfo=dt.timezone.utc)
    now = now.astimezone(dt.timezone.utc)
    nominal = now.replace(hour=NOMINAL_UTC_HOUR, minute=NOMINAL_UTC_MINUTE,
                          second=0, microsecond=0)
    if now < nominal:
        nominal -= dt.timedelta(days=1)
    return nominal.date()


def parse_nights(value: str) -> set[str]:
    nights = {part.strip().lower() for part in (value or "").split(",") if part.strip()}
    unknown = nights - set(WEEKDAYS)
    if unknown:
        raise ValueError(f"unknown nightly weekdays: {sorted(unknown)}")
    return nights


def windows_enabled(night: dt.date, nights: str = DEFAULT_WINDOWS_NIGHTS) -> bool:
    return WEEKDAYS[night.weekday()] in parse_nights(nights)


def platforms_for_night(all_platforms, night: dt.date, *, enabled: bool,
                        nights: str = DEFAULT_WINDOWS_NIGHTS) -> list[str]:
    if not enabled or windows_enabled(night, nights):
        return list(all_platforms)
    return [platform for platform in all_platforms if platform != "windows"]


def _rank(case_id: str) -> str:
    return hashlib.sha256(f"qa-ui-auto-nightly-v1:{case_id}".encode()).hexdigest()


def assigned_window(case_id: str, window_count: int) -> int:
    """Deterministic window assignment independent of the eligible set."""
    digest = hashlib.sha256(f"qa-ui-auto-nightly-v1:{case_id}".encode()).hexdigest()
    return int(digest[:16], 16) % window_count


def select(eligible_cases, dependencies, *, always_ids, percent: int, night: dt.date):
    """Tier-B native selection: always-set plus one rotation window.

    ``always_ids`` is the nightly always-set (crash suite and cases that cannot
    run on another platform). Shared cases are partitioned into
    ``ceil(100/percent)`` deterministic windows by case ID, so every shared
    case is executed exactly once per cycle regardless of which cases are
    eligible on a given platform.
    """
    if not 1 <= int(percent) <= 100:
        raise ValueError("native sample percent must be from 1 to 100")
    percent = int(percent)
    window_count = max(1, math.ceil(100 / percent))
    window_index = night.toordinal() % window_count
    eligible_ids = [case.id for case in eligible_cases]
    always = set(always_ids) & set(eligible_ids)
    shared = [case_id for case_id in eligible_ids if case_id not in always]
    if percent >= 100 or window_count == 1:
        sampled = list(shared)
    else:
        sampled = [case_id for case_id in shared
                   if assigned_window(case_id, window_count) == window_index]
    chosen = always | set(sampled)
    # Prerequisites stay in the same native invocation, exactly like the
    # planner's global dependency closure.
    closed = set(chosen)
    changed = True
    while changed:
        changed = False
        for case_id in tuple(closed):
            for previous in dependencies.get(case_id, []):
                if previous in eligible_ids and previous not in closed:
                    closed.add(previous)
                    changed = True
    selected = [case_id for case_id in eligible_ids if case_id in closed]
    deferred = [case_id for case_id in eligible_ids if case_id not in closed]
    reasons = {}
    for case_id in eligible_ids:
        if case_id in always:
            reasons[case_id] = "nightly: always"
        elif case_id in sampled:
            reasons[case_id] = f"nightly: sample window {window_index + 1}/{window_count}"
        elif case_id in closed:
            reasons[case_id] = "nightly: prerequisite of a selected case"
        else:
            reasons[case_id] = f"nightly: deferred to another window ({window_index + 1}/{window_count})"
    record = {
        "night": night.isoformat(),
        "weekday": WEEKDAYS[night.weekday()],
        "sample_percent": percent,
        "window": f"{window_index + 1}/{window_count}",
        "always": len(always),
        "sampled": len([case_id for case_id in sampled if case_id not in always]),
        "prerequisites": len(closed - always - set(sampled)),
        "selected": len(selected),
        "deferred": deferred,
    }
    return selected, reasons, record
