"""Match renderer routes without confusing a query-routed child with main."""
from urllib.parse import parse_qs, urlsplit


def matches_window_route(url: str, route: str) -> bool:
    if route:
        return route in url
    parsed = urlsplit(url)
    query = parse_qs(parsed.query)
    return not parsed.fragment and not any(
        key in query for key in ("sftp", "git", "rdp", "vnc", "terminal", "database", "lan-chat", "notes", "servers", "detached", "kind")
    )
