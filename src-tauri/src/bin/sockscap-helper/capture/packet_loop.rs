use super::address::parse_cidrs;
use super::classification::classify_flow;
use super::classification::udp_should_drop;
use super::flow_table::FlowAction;
use super::flow_table::FlowKey;
use super::flow_table::FlowTable;
use super::flow_table::FlowVerdict;
use super::maintenance::AppIndex;
use super::maintenance::IndexSlot;
use super::maintenance::read_index;
use super::packet::TCP_FIN;
use super::packet::TCP_RST;
use super::packet::TcpMeta;
use super::packet::is_syn_open;
use super::packet::parse_ip_tcp;
use super::packet::parse_ip_udp;
use super::packet::reflect_from_proxy;
use super::packet::reflect_towards_proxy;
use super::pid_map::FlowInfo;
use super::pid_map::FlowMap;
use super::plan::PLAN_SYNC_INTERVAL;
use super::plan::PlanSlot;
use super::plan::read_plan;
use super::process_scope::process_path;
use crate::proc_info::SharedTree;
use crate::windivert::ADDR_LEN;
use crate::windivert::LAYER_FLOW;
use crate::windivert::LAYER_SOCKET;
use crate::windivert::WinDivertApi;
use crate::windivert::addr_event;
use crate::windivert::addr_for_reflect_inbound;
use crate::windivert::addr_is_outbound;
use crate::windivert::addr_layer;
use crate::windivert::flow_endpoints_ip;
use crate::windivert::flow_process_id;
use std::net::IpAddr;
use std::net::Ipv6Addr;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::AtomicU16;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;
use std::time::Duration;
use std::time::Instant;
use winapi::um::winnt::HANDLE;

pub(super) fn flow_loop(
    api: Arc<WinDivertApi>,
    handle: HANDLE,
    flows: Arc<Mutex<FlowMap>>,
    redirects: Arc<Mutex<FlowTable>>,
    stop: Arc<AtomicBool>,
) {
    let mut packet = vec![0u8; 1];
    let mut addr = vec![0u8; ADDR_LEN];
    while !stop.load(Ordering::SeqCst) {
        match api.recv(handle, &mut packet, &mut addr) {
            Ok(_) => {
                let layer = addr_layer(&addr);
                // Accept FLOW (2) or SOCKET (3) events.
                if layer != LAYER_FLOW as u8 && layer != LAYER_SOCKET as u8 {
                    continue;
                }
                let event = addr_event(&addr);
                // FLOW: 0=established, 1=deleted
                // SOCKET: 0=bind, 1=connect, 2=listen, 3=accept, 4=close...
                let is_delete = event == 1 && layer == LAYER_FLOW as u8
                    || event == 4 && layer == LAYER_SOCKET as u8;
                let pid = flow_process_id(&addr);
                let Some((local, local_port, remote, remote_port, proto)) =
                    flow_endpoints_ip(&addr)
                else {
                    continue;
                };
                // SOCKET layer may report proto 0; still track by ports.
                if proto != 0 && proto != 6 {
                    continue;
                }
                let key = (local, local_port);
                if is_delete {
                    if let Ok(mut m) = flows.lock() {
                        m.remove(&key);
                    }
                    // The socket is gone, so its capture decision is too. This
                    // is the authoritative eviction signal — far more precise
                    // than any timeout, and it is what keeps a recycled
                    // ephemeral port from inheriting a stale destination.
                    if let Ok(mut t) = redirects.lock() {
                        t.remove(&key);
                    }
                    continue;
                }
                // SOCKET connect = 1; FLOW established = 0; also accept SOCKET bind/connect/accept
                if layer == LAYER_SOCKET as u8 && event > 3 {
                    continue;
                }
                if layer == LAYER_FLOW as u8 && !addr_is_outbound(&addr) {
                    continue;
                }
                let path = process_path(pid).unwrap_or_default();
                let now = Instant::now();
                if let Ok(mut m) = flows.lock() {
                    m.insert(
                        key,
                        FlowInfo {
                            pid,
                            path,
                            remote,
                            remote_port,
                            expires_at: now,
                        },
                        now,
                    );
                    m.sweep_if_due(now);
                }
            }
            Err(_) => {
                if stop.load(Ordering::SeqCst) {
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(5));
            }
        }
    }
}

#[allow(clippy::too_many_arguments)]
pub(super) fn network_loop(
    api: Arc<WinDivertApi>,
    handle: HANDLE,
    flows: Arc<Mutex<FlowMap>>,
    redirects: Arc<Mutex<FlowTable>>,
    udp_verdicts: Arc<Mutex<FlowTable>>,
    plan_slot: PlanSlot,
    relay_port_live: Arc<AtomicU16>,
    seen: Arc<AtomicU64>,
    redirected: Arc<AtomicU64>,
    stop: Arc<AtomicBool>,
    tree: Arc<SharedTree>,
    index_slot: IndexSlot,
) {
    let mut packet = vec![0u8; 0xFFFF];
    let mut addr = vec![0u8; ADDR_LEN];
    let mut plan = read_plan(&plan_slot);
    let mut bypass_nets = parse_cidrs(&plan.bypass_cidrs);
    let relay_v4 = IpAddr::V4(plan.relay_ip);
    let relay_v6 = IpAddr::V6(Ipv6Addr::LOCALHOST);

    // App mode: inverted index, published by the maintenance thread.
    let mut app_index: Arc<AppIndex> = read_index(&index_slot);
    let mut index_synced = Instant::now();
    let mut plan_synced = Instant::now();
    let mut recv_errors: u32 = 0;

    while !stop.load(Ordering::SeqCst) {
        // Picking up a freshly published index is a lock plus an `Arc` clone;
        // building it is somebody else's problem now.
        if plan.mode_apps && index_synced.elapsed() >= Duration::from_millis(50) {
            app_index = read_index(&index_slot);
            index_synced = Instant::now();
        }
        if plan_synced.elapsed() >= PLAN_SYNC_INTERVAL {
            let latest = read_plan(&plan_slot);
            if !Arc::ptr_eq(&latest, &plan) {
                bypass_nets = parse_cidrs(&latest.bypass_cidrs);
                plan = latest;
            }
            plan_synced = Instant::now();
        }

        let len = match api.recv(handle, &mut packet, &mut addr) {
            Ok(n) => {
                recv_errors = 0;
                n
            }
            Err(e) => {
                if stop.load(Ordering::SeqCst) {
                    break;
                }
                // Back off. `continue` alone spins this thread at 100% CPU for
                // as long as the failure lasts — and a failure that lasts is
                // exactly the likely case (handle closed underneath us, driver
                // unloaded, device removed). The FLOW loop already sleeps here;
                // only the NETWORK loop was missing it.
                recv_errors = recv_errors.saturating_add(1);
                if recv_errors >= 3 {
                    std::thread::sleep(Duration::from_millis(5));
                }
                if recv_errors == 1 || recv_errors == 100 || recv_errors % 2000 == 0 {
                    tracing::warn!(
                        "sockscap-helper: NETWORK recv failed ({recv_errors} consecutive): {e}"
                    );
                }
                continue;
            }
        };
        seen.fetch_add(1, Ordering::Relaxed);
        let pkt = &mut packet[..len];
        let outbound = addr_is_outbound(&addr);

        let Some(tcp) = parse_ip_tcp(pkt) else {
            // QUIC blocking: drop in-scope outbound UDP 443 so the app marks
            // HTTP/3 broken and falls back to TCP — which capture attributes by
            // SNI and routes through the upstream. Non-443 UDP and out-of-scope
            // UDP 443 pass untouched. We never reflect UDP, only drop or pass.
            if plan.block_quic && outbound {
                if let Some(udp) = parse_ip_udp(pkt) {
                    if udp.dport == 443
                        && udp_should_drop(
                            &plan,
                            &bypass_nets,
                            &tree,
                            &udp_verdicts,
                            (udp.src, udp.sport),
                            udp.dst,
                            udp.dport,
                            &app_index,
                        )
                    {
                        // Not sending = dropping the datagram.
                        continue;
                    }
                }
            }
            let _ = api.send(handle, pkt, &addr);
            continue;
        };
        let TcpMeta {
            src,
            sport,
            dst,
            dport,
            flags,
        } = tcp;
        let now = Instant::now();
        let closing = flags & (TCP_FIN | TCP_RST) != 0;

        // ------------------------------------------------------------------
        // Streamdump PROXY→PORT: outbound from local relay/proxy.
        // Packet is C:relay → R:client_sport; reflect to R:orig_port → C:client_sport.
        // ------------------------------------------------------------------
        let relay_port = relay_port_live.load(Ordering::Relaxed);
        if outbound && sport == relay_port {
            let found = redirects.lock().ok().and_then(|mut t| {
                let hit = t.peer_lookup((dst, dport), now);
                if let (Some((key, _)), true) = (hit, closing) {
                    t.mark_closing(&key, now);
                }
                hit.map(|(_, port)| port)
            });
            if let Some(orig_port) = found {
                if reflect_from_proxy(pkt, orig_port) {
                    addr_for_reflect_inbound(&mut addr);
                    api.calc_checksums(pkt, &mut addr);
                }
            }
            // No mapping (control / unknown) — pass through unchanged.
            let _ = api.send(handle, pkt, &addr);
            continue;
        }

        // Never re-process traffic already destined to the relay port.
        if dport == relay_port {
            let _ = api.send(handle, pkt, &addr);
            continue;
        }

        if !outbound {
            let _ = api.send(handle, pkt, &addr);
            continue;
        }

        // ------------------------------------------------------------------
        // Outbound client → remote: streamdump PORT→PROXY reflection.
        // ------------------------------------------------------------------
        let key: FlowKey = (src, sport);

        // Cached decision for this connection. `lookup` only answers when the
        // destination still matches, so a recycled ephemeral port never
        // inherits the previous connection's verdict. A SYN-without-ACK is
        // stronger still: it *defines* the start of a new connection on this
        // 4-tuple, so any earlier decision is void even when the destination
        // happens to coincide. (Re-classifying a SYN retransmit is wasted work,
        // but only on a path that is already retransmitting.)
        let cached = if is_syn_open(flags) {
            if let Ok(mut t) = redirects.lock() {
                t.remove(&key);
            }
            None
        } else {
            redirects.lock().ok().and_then(|mut t| {
                let hit = t.lookup(key, dst, dport, now);
                if hit.is_some() && closing {
                    t.mark_closing(&key, now);
                }
                hit
            })
        };
        match cached {
            Some(FlowAction::Redirect) => {
                if reflect_towards_proxy(pkt, relay_port) {
                    addr_for_reflect_inbound(&mut addr);
                    api.calc_checksums(pkt, &mut addr);
                    if api.send(handle, pkt, &addr).is_ok() {
                        redirected.fetch_add(1, Ordering::Relaxed);
                    }
                } else {
                    let _ = api.send(handle, pkt, &addr);
                }
                continue;
            }
            // Negative cache: the expensive classification below already ran
            // for this connection and said "leave it alone". Without this,
            // every packet of every un-captured flow re-enumerated the process
            // table and the whole TCP table — which is why traffic that
            // SocksCap does *not* handle was the slowest of all.
            Some(FlowAction::Bypass) => {
                let _ = api.send(handle, pkt, &addr);
                continue;
            }
            None => {}
        }

        // ---- first packet of a connection: classify, then remember ---------
        // An index miss may just mean the socket opened since the last publish;
        // re-read the slot (cheap) before falling back to the slower per-flow
        // resolution.
        if plan.mode_apps && !app_index.ports.contains_key(&sport) {
            app_index = read_index(&index_slot);
            index_synced = Instant::now();
        }

        let verdict = classify_flow(
            &plan,
            &bypass_nets,
            &flows,
            &tree,
            key,
            dst,
            dport,
            &app_index,
        );

        if let Ok(mut t) = redirects.lock() {
            t.insert(key, dst, dport, verdict.clone(), now);
            if closing {
                t.mark_closing(&key, now);
            }
        }

        if matches!(verdict, FlowVerdict::Bypass) {
            let _ = api.send(handle, pkt, &addr);
            continue;
        }

        // Skip packets already reflecting (src looks like remote, rare).
        let _ = (relay_v4, relay_v6);

        if reflect_towards_proxy(pkt, relay_port) {
            addr_for_reflect_inbound(&mut addr);
            api.calc_checksums(pkt, &mut addr);
            if api.send(handle, pkt, &addr).is_ok() {
                redirected.fetch_add(1, Ordering::Relaxed);
            }
        } else {
            let _ = api.send(handle, pkt, &addr);
        }
    }
}
