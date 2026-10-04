"""Match renderer routes without confusing a query-routed child with main."""
from urllib.parse import parse_qs, urlsplit


def matches_window_route(url: str, route: str) -> bool:
    parsed = urlsplit(url)
    if route:
        if route.startswith(("#", "?")) and "=" in route:
            expected = parse_qs(route[1:], keep_blank_values=True)
            actual = parse_qs(parsed.fragment or parsed.query, keep_blank_values=True)
            return bool(expected) and all(
                key in actual and any(value.startswith(prefix) for value in actual[key] for prefix in prefixes)
                for key, prefixes in expected.items()
            )
        return route in url
    query = parse_qs(parsed.query)
    return not parsed.fragment and not any(
        key in query for key in ("sftp", "git", "rdp", "vnc", "terminal", "database", "lan-chat", "notes", "servers", "detached", "kind")
    )
