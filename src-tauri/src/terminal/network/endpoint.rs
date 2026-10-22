/// Parse a `host:port` row from the local-port-forwarding table. Returns
/// `(host, port)` on success, or an error suitable for surfacing to the
/// user as the reason a single forward could not be started.
pub fn parse_endpoint(s: &str) -> Result<(String, u16), String> {
    let s = s.trim();
    if let Some(rest) = s.strip_prefix('[') {
        // [::1]:22 - IPv6 literal in brackets
        if let Some(idx) = rest.rfind(']') {
            let host = &rest[..idx];
            let after = &rest[idx + 1..];
            let port_str = after
                .strip_prefix(':')
                .ok_or_else(|| format!("missing port in '{}'", s))?;
            let port: u16 = port_str
                .parse()
                .map_err(|_| format!("invalid port in '{}'", s))?;
            return Ok((host.to_string(), port));
        }
        return Err(format!("unbalanced brackets in '{}'", s));
    }
    let (host, port_str) = s
        .rsplit_once(':')
        .ok_or_else(|| format!("expected host:port, got '{}'", s))?;
    if host.is_empty() {
        return Err(format!("empty host in '{}'", s));
    }
    let port: u16 = port_str
        .parse()
        .map_err(|_| format!("invalid port in '{}'", s))?;
    Ok((host.to_string(), port))
}
