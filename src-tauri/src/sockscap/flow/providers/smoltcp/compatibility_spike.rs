//! Executable P0 compatibility probes for the pinned vanilla smoltcp release.
//!
//! This deliberately is not a packet-stack driver. It keeps a fixed, tiny
//! in-memory packet/socket budget and locks down only the upstream semantics
//! that a later Taomni-owned production driver will rely on.

use std::collections::BTreeMap;

use smoltcp::iface::{
    Config, Interface, PollIngressSingleResult, PollResult, SocketHandle, SocketSet,
};
use smoltcp::phy::{ChecksumCapabilities, Device, Medium};
use smoltcp::socket::{tcp, udp};
use smoltcp::time::Instant;
use smoltcp::wire::{
    HardwareAddress, IpAddress, IpEndpoint, IpListenEndpoint, IpProtocol, IpRepr, Ipv4Address,
    Ipv4Packet, Ipv6Address, Ipv6Packet, TcpControl, TcpPacket, TcpRepr, TcpSeqNumber, UdpPacket,
    UdpRepr,
};

use super::device::{ControlledIpDevice, StageIngressErrorKind, StagingBudget};

const SPIKE_MTU: usize = 1_500;
const SPIKE_PACKET_LIMIT: usize = 2_048;
const SPIKE_PACKET_SLOTS: usize = 16;
const TCP_PORT: u16 = 8_443;
const UDP_PORT: u16 = 5_300;

struct CompatibilityHarness {
    interface: Interface,
    device: ControlledIpDevice,
    sockets: SocketSet<'static>,
    now_millis: i64,
}

impl CompatibilityHarness {
    fn new() -> Self {
        let staging =
            StagingBudget::new(SPIKE_PACKET_SLOTS, SPIKE_PACKET_SLOTS * SPIKE_PACKET_LIMIT);
        let mut device = ControlledIpDevice::new(SPIKE_MTU, SPIKE_PACKET_LIMIT, staging, staging)
            .expect("fixed compatibility device configuration");
        assert_eq!(Device::capabilities(&device).medium, Medium::Ip);
        let mut config = Config::new(HardwareAddress::Ip);
        config.random_seed = 0x5441_4f4d_4e49;
        let mut interface = Interface::new(config, &mut device, Instant::ZERO);

        // Medium::Ip still asks the socket egress scheduler for a route. The
        // routes affect only how a remote is considered reachable; reply
        // source addresses below are always supplied explicitly by the exact
        // TCP listener or by UdpMetadata::local_address.
        interface
            .routes_mut()
            .add_default_ipv4_route(Ipv4Address::new(192, 0, 2, 1))
            .expect("one IPv4 route fits the fixed route table");
        interface
            .routes_mut()
            .add_default_ipv6_route(Ipv6Address::new(0x2001, 0xdb8, 0xffff, 0, 0, 0, 0, 1))
            .expect("one IPv6 route fits the fixed route table");

        Self {
            interface,
            device,
            sockets: SocketSet::new(Vec::new()),
            now_millis: 1,
        }
    }

    fn enable_any_ip(&mut self, arbitrary_destinations: &[IpAddress]) {
        assert!(
            self.interface.ip_addrs().is_empty(),
            "the probe must not make arbitrary destinations local by configuration"
        );
        for destination in arbitrary_destinations {
            assert!(!self.interface.has_ip_addr(*destination));
        }

        self.interface.set_any_ip(true);
        assert!(self.interface.any_ip());
        for destination in arbitrary_destinations {
            assert!(self.interface.has_ip_addr(*destination));
        }
    }

    fn inject_one(&mut self, packet: Vec<u8>) {
        assert!(packet.len() <= SPIKE_MTU);
        self.device
            .stage_ingress(packet)
            .expect("valid packet fits fixed ingress staging");
        let result = self.interface.poll_ingress_single(
            Instant::from_millis(self.now_millis),
            &mut self.device,
            &mut self.sockets,
        );
        self.now_millis += 1;
        assert!(matches!(
            result,
            PollIngressSingleResult::PacketProcessed | PollIngressSingleResult::SocketStateChanged
        ));
        assert_eq!(self.device.staged_ingress_packets(), 0);
    }

    fn poll_one_egress_round(&mut self) -> PollResult {
        let result = self.interface.poll_egress(
            Instant::from_millis(self.now_millis),
            &mut self.device,
            &mut self.sockets,
        );
        self.now_millis += 1;
        result
    }
}

#[derive(Debug, PartialEq, Eq)]
struct ParsedIpPacket {
    source: IpAddress,
    destination: IpAddress,
    next_header: IpProtocol,
    payload: Vec<u8>,
}

fn parse_ip_packet(packet: &[u8]) -> ParsedIpPacket {
    match packet.first().map(|byte| byte >> 4) {
        Some(4) => {
            let packet = Ipv4Packet::new_checked(packet).expect("valid emitted IPv4 packet");
            ParsedIpPacket {
                source: packet.src_addr().into(),
                destination: packet.dst_addr().into(),
                next_header: packet.next_header(),
                payload: packet.payload().to_vec(),
            }
        }
        Some(6) => {
            let packet = Ipv6Packet::new_checked(packet).expect("valid emitted IPv6 packet");
            ParsedIpPacket {
                source: packet.src_addr().into(),
                destination: packet.dst_addr().into(),
                next_header: packet.next_header(),
                payload: packet.payload().to_vec(),
            }
        }
        version => panic!("unexpected emitted IP version {version:?}"),
    }
}

fn emit_tcp_syn(
    source: IpAddress,
    destination: IpAddress,
    source_port: u16,
    destination_port: u16,
) -> Vec<u8> {
    let tcp = TcpRepr {
        src_port: source_port,
        dst_port: destination_port,
        control: TcpControl::Syn,
        seq_number: TcpSeqNumber(10_000),
        ack_number: None,
        window_len: 16_384,
        window_scale: None,
        max_seg_size: Some(1_400),
        sack_permitted: false,
        sack_ranges: [None, None, None],
        timestamp: None,
        payload: &[],
    };
    let ip = IpRepr::new(source, destination, IpProtocol::Tcp, tcp.buffer_len(), 64);
    let mut packet = vec![0; ip.buffer_len()];
    let header_len = ip.header_len();
    ip.emit(&mut packet, &ChecksumCapabilities::default());
    tcp.emit(
        &mut TcpPacket::new_unchecked(&mut packet[header_len..]),
        &source,
        &destination,
        &ChecksumCapabilities::default(),
    );
    packet
}

fn emit_udp_datagram(
    source: IpAddress,
    destination: IpAddress,
    source_port: u16,
    destination_port: u16,
    payload: &[u8],
) -> Vec<u8> {
    let udp = UdpRepr {
        src_port: source_port,
        dst_port: destination_port,
    };
    let ip = IpRepr::new(
        source,
        destination,
        IpProtocol::Udp,
        udp.header_len() + payload.len(),
        64,
    );
    let mut packet = vec![0; ip.buffer_len()];
    let header_len = ip.header_len();
    ip.emit(&mut packet, &ChecksumCapabilities::default());
    udp.emit(
        &mut UdpPacket::new_unchecked(&mut packet[header_len..]),
        &source,
        &destination,
        payload.len(),
        |buffer| buffer.copy_from_slice(payload),
        &ChecksumCapabilities::default(),
    );
    packet
}

fn add_exact_tcp_listener(
    harness: &mut CompatibilityHarness,
    destination: IpAddress,
) -> SocketHandle {
    let socket = tcp::Socket::new(
        tcp::SocketBuffer::new(vec![0; 4_096]),
        tcp::SocketBuffer::new(vec![0; 4_096]),
    );
    let handle = harness.sockets.add(socket);
    let endpoint = IpListenEndpoint {
        addr: Some(destination),
        port: TCP_PORT,
    };
    let socket = harness.sockets.get_mut::<tcp::Socket>(handle);
    socket
        .listen(endpoint)
        .expect("exact destination listener is valid");
    assert_eq!(socket.state(), tcp::State::Listen);
    assert_eq!(socket.listen_endpoint(), endpoint);
    handle
}

fn assert_exact_listener_accepts_pure_syn(
    source: IpAddress,
    destination: IpAddress,
    source_port: u16,
) {
    let mut harness = CompatibilityHarness::new();
    harness.enable_any_ip(&[destination]);

    // The exact destination listener exists before the first SYN is exposed
    // to vanilla smoltcp.
    let handle = add_exact_tcp_listener(&mut harness, destination);
    harness.inject_one(emit_tcp_syn(source, destination, source_port, TCP_PORT));

    let socket = harness.sockets.get::<tcp::Socket>(handle);
    assert_eq!(socket.state(), tcp::State::SynReceived);
    assert_eq!(
        socket.local_endpoint(),
        Some(IpEndpoint::new(destination, TCP_PORT))
    );
    assert_eq!(
        socket.remote_endpoint(),
        Some(IpEndpoint::new(source, source_port))
    );

    // Vanilla smoltcp transitions the socket during ingress, then emits its
    // SYN-ACK from the bounded socket-egress poll rather than through the RX
    // token's immediate-response path.
    assert!(matches!(
        harness.poll_one_egress_round(),
        PollResult::SocketStateChanged
    ));
    let response = harness
        .device
        .take_egress()
        .expect("pure SYN schedules one SYN-ACK");
    assert!(harness.device.take_egress().is_none());
    let response = parse_ip_packet(&response);
    assert_eq!(response.source, destination);
    assert_eq!(response.destination, source);
    assert_eq!(response.next_header, IpProtocol::Tcp);
    let tcp = TcpPacket::new_checked(response.payload).expect("valid emitted TCP segment");
    assert_eq!(tcp.src_port(), TCP_PORT);
    assert_eq!(tcp.dst_port(), source_port);
    assert!(tcp.syn());
    assert!(tcp.ack());
    assert!(!tcp.fin());
    assert!(!tcp.rst());
    assert_eq!(tcp.ack_number(), TcpSeqNumber(10_001));
}

#[test]
fn medium_ip_any_ip_exact_listener_preserves_arbitrary_ipv4_destination() {
    assert_exact_listener_accepts_pure_syn(
        Ipv4Address::new(198, 51, 100, 20).into(),
        Ipv4Address::new(203, 0, 113, 77).into(),
        41_001,
    );
}

#[test]
fn medium_ip_any_ip_exact_listener_preserves_arbitrary_ipv6_destination() {
    assert_exact_listener_accepts_pure_syn(
        Ipv6Address::new(0x2001, 0xdb8, 1, 0, 0, 0, 0, 20).into(),
        Ipv6Address::new(0x2001, 0xdb8, 2, 0, 0, 0, 0, 77).into(),
        41_002,
    );
}

#[derive(Clone, Copy)]
struct UdpProbe {
    source: IpAddress,
    destination: IpAddress,
    source_port: u16,
    payload: &'static [u8],
}

#[test]
fn wildcard_udp_socket_demuxes_full_metadata_and_replies_from_original_destination() {
    let probes = [
        UdpProbe {
            source: Ipv4Address::new(198, 51, 100, 10).into(),
            destination: Ipv4Address::new(203, 0, 113, 10).into(),
            source_port: 42_001,
            payload: b"v4-source-a-destination-a",
        },
        UdpProbe {
            source: Ipv4Address::new(198, 51, 100, 11).into(),
            destination: Ipv4Address::new(203, 0, 113, 10).into(),
            source_port: 42_002,
            payload: b"v4-source-b-destination-a",
        },
        UdpProbe {
            source: Ipv4Address::new(198, 51, 100, 10).into(),
            destination: Ipv4Address::new(203, 0, 113, 11).into(),
            source_port: 42_003,
            payload: b"v4-source-a-destination-b",
        },
        UdpProbe {
            source: Ipv6Address::new(0x2001, 0xdb8, 1, 0, 0, 0, 0, 10).into(),
            destination: Ipv6Address::new(0x2001, 0xdb8, 2, 0, 0, 0, 0, 20).into(),
            source_port: 42_004,
            payload: b"v6-source-c-destination-c",
        },
    ];
    let destinations = probes.map(|probe| probe.destination);
    let mut harness = CompatibilityHarness::new();
    harness.enable_any_ip(&destinations);

    let rx_metadata = vec![udp::PacketMetadata::EMPTY; probes.len()];
    let tx_metadata = vec![udp::PacketMetadata::EMPTY; probes.len()];
    let rx_payload_bytes = probes.iter().map(|probe| probe.payload.len()).sum();
    let tx_payload_bytes = rx_payload_bytes;
    let socket = udp::Socket::new(
        udp::PacketBuffer::new(rx_metadata, vec![0; rx_payload_bytes]),
        udp::PacketBuffer::new(tx_metadata, vec![0; tx_payload_bytes]),
    );
    let handle = harness.sockets.add(socket);
    let socket = harness.sockets.get_mut::<udp::Socket>(handle);
    socket.bind(UDP_PORT).expect("wildcard UDP bind");

    for probe in probes {
        harness.inject_one(emit_udp_datagram(
            probe.source,
            probe.destination,
            probe.source_port,
            UDP_PORT,
            probe.payload,
        ));
    }

    let mut received = Vec::with_capacity(probes.len());
    let socket = harness.sockets.get_mut::<udp::Socket>(handle);
    while socket.can_recv() {
        let (payload, metadata) = socket.recv().expect("queued UDP datagram");
        received.push((payload.to_vec(), metadata));
    }
    assert_eq!(received.len(), probes.len());
    for (index, probe) in probes.iter().enumerate() {
        let (payload, metadata) = &received[index];
        assert_eq!(payload, probe.payload);
        assert_eq!(
            metadata.endpoint,
            IpEndpoint::new(probe.source, probe.source_port)
        );
        assert_eq!(metadata.local_address, Some(probe.destination));
    }

    // Reusing the complete receive metadata is the controlled demux key: the
    // remote endpoint becomes the reply destination and local_address becomes
    // its exact source, even though the socket itself is wildcard-bound.
    let socket = harness.sockets.get_mut::<udp::Socket>(handle);
    for (payload, metadata) in &received {
        socket
            .send_slice(payload, *metadata)
            .expect("fixed reply buffers have one slot per probe");
    }

    for _ in &probes {
        assert!(matches!(
            harness.poll_one_egress_round(),
            PollResult::SocketStateChanged
        ));
    }
    assert_eq!(harness.device.staged_egress_packets(), probes.len());

    let mut replies_by_payload = BTreeMap::new();
    while let Some(packet) = harness.device.take_egress() {
        let packet = parse_ip_packet(&packet);
        assert_eq!(packet.next_header, IpProtocol::Udp);
        let udp = UdpPacket::new_checked(&packet.payload[..]).expect("valid emitted UDP datagram");
        assert_eq!(udp.src_port(), UDP_PORT);
        replies_by_payload.insert(
            udp.payload().to_vec(),
            (packet.source, packet.destination, udp.dst_port()),
        );
    }
    assert_eq!(replies_by_payload.len(), probes.len());
    for probe in probes {
        assert_eq!(
            replies_by_payload.get(probe.payload),
            Some(&(probe.destination, probe.source, probe.source_port))
        );
    }
}

#[test]
fn mtu_plus_one_is_rejected_by_our_ingress_precondition_before_smoltcp_poll() {
    let mut harness = CompatibilityHarness::new();
    let oversized = vec![0x5a; SPIKE_MTU + 1];
    let error = harness
        .device
        .stage_ingress(oversized.clone())
        .expect_err("our device boundary must reject MTU+1");
    assert_eq!(
        error.kind(),
        &StageIngressErrorKind::PayloadExceedsMtu {
            actual: SPIKE_MTU + 1,
            mtu: SPIKE_MTU,
        }
    );
    assert_eq!(error.into_payload(), oversized);
    assert_eq!(harness.device.staged_ingress_packets(), 0);
    assert_eq!(harness.device.staged_ingress_bytes(), 0);
    assert!(matches!(
        harness.interface.poll_ingress_single(
            Instant::from_millis(harness.now_millis),
            &mut harness.device,
            &mut harness.sockets,
        ),
        PollIngressSingleResult::None
    ));
}
