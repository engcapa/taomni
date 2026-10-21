use std::net::IpAddr;

pub(super) fn is_loopback_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v) => v.is_loopback(),
        IpAddr::V6(v) => v.is_loopback(),
    }
}

pub(super) fn parse_cidrs(list: &[String]) -> Vec<(IpAddr, u8)> {
    let mut out = Vec::new();
    for s in list {
        let s = s.trim();
        if let Some((a, p)) = s.split_once('/') {
            if let (Ok(ip), Ok(pref)) = (a.parse::<IpAddr>(), p.parse::<u8>()) {
                let max = match ip {
                    IpAddr::V4(_) => 32,
                    IpAddr::V6(_) => 128,
                };
                out.push((ip, pref.min(max)));
            }
        } else if let Ok(ip) = s.parse::<IpAddr>() {
            let pref = match ip {
                IpAddr::V4(_) => 32,
                IpAddr::V6(_) => 128,
            };
            out.push((ip, pref));
        }
    }
    out
}

pub(super) fn ip_in_cidr(ip: IpAddr, net: IpAddr, prefix: u8) -> bool {
    match (ip, net) {
        (IpAddr::V4(a), IpAddr::V4(n)) => {
            let shift = 32u32.saturating_sub(prefix as u32);
            let mask = if shift >= 32 { 0 } else { u32::MAX << shift };
            (u32::from(a) & mask) == (u32::from(n) & mask)
        }
        (IpAddr::V6(a), IpAddr::V6(n)) => {
            let shift = 128u32.saturating_sub(prefix as u32);
            let mask = if shift >= 128 {
                0u128
            } else {
                u128::MAX << shift
            };
            (u128::from(a) & mask) == (u128::from(n) & mask)
        }
        _ => false,
    }
}
