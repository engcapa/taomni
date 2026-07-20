//! Bounded `Medium::Ip` staging device for the controlled smoltcp provider.
//!
//! Capture identity deliberately does not cross this boundary. The provider
//! driver retains identity and correspondence outside the byte-only device,
//! while `Bytes` lets it cheaply keep an owned reference until ingress has
//! been accepted. Every ordinary staging rejection returns the owned payload.

use std::collections::VecDeque;
use std::error::Error;
use std::fmt;

use bytes::Bytes;
use smoltcp::phy::{ChecksumCapabilities, Device, DeviceCapabilities, Medium, RxToken, TxToken};
use smoltcp::time::Instant;

pub const MIN_CONTROLLED_IP_MTU: usize = 1_280;
pub const MAX_CONTROLLED_IP_PACKET_BYTES: usize = u16::MAX as usize;
pub const MAX_CONTROLLED_STAGING_PACKETS: usize = 4_096;
pub const MAX_CONTROLLED_STAGING_BYTES: usize = 256 * 1024 * 1024;

/// Independent packet and byte ceilings for one staging direction.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StagingBudget {
    pub max_packets: usize,
    pub max_bytes: usize,
}

impl StagingBudget {
    pub const fn new(max_packets: usize, max_bytes: usize) -> Self {
        Self {
            max_packets,
            max_bytes,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StagingDirection {
    Ingress,
    Egress,
}

impl fmt::Display for StagingDirection {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Ingress => formatter.write_str("ingress"),
            Self::Egress => formatter.write_str("egress"),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ControlledIpDeviceConfigError {
    InvalidMtu {
        mtu: usize,
        max_packet_bytes: usize,
    },
    InvalidPacketLimit {
        max_packet_bytes: usize,
    },
    InvalidStagingBudget {
        direction: StagingDirection,
        max_packets: usize,
        max_bytes: usize,
        max_packet_bytes: usize,
    },
    StagingBudgetOverflow {
        direction: StagingDirection,
    },
    CapabilityMismatch {
        reason: &'static str,
    },
}

impl fmt::Display for ControlledIpDeviceConfigError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidMtu {
                mtu,
                max_packet_bytes,
            } => write!(
                formatter,
                "CONTROLLED_IP_DEVICE_MTU_INVALID: MTU {mtu} must be at least {MIN_CONTROLLED_IP_MTU} and no larger than packet limit {max_packet_bytes}"
            ),
            Self::InvalidPacketLimit { max_packet_bytes } => write!(
                formatter,
                "CONTROLLED_IP_DEVICE_PACKET_LIMIT_INVALID: packet limit {max_packet_bytes} is outside the non-jumbo IP range"
            ),
            Self::InvalidStagingBudget {
                direction,
                max_packets,
                max_bytes,
                max_packet_bytes,
            } => write!(
                formatter,
                "CONTROLLED_IP_DEVICE_STAGING_BUDGET_INVALID: {direction} staging packets={max_packets}, bytes={max_bytes} cannot reserve one maximum packet of {max_packet_bytes} bytes"
            ),
            Self::StagingBudgetOverflow { direction } => write!(
                formatter,
                "CONTROLLED_IP_DEVICE_STAGING_BUDGET_OVERFLOW: {direction} packet and byte budget arithmetic overflowed"
            ),
            Self::CapabilityMismatch { reason } => write!(
                formatter,
                "CONTROLLED_IP_DEVICE_CAPABILITY_INVALID: {reason}"
            ),
        }
    }
}

impl Error for ControlledIpDeviceConfigError {}

/// Sticky fail-closed condition caused by a provider/device invariant breach.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ControlledIpDeviceFault {
    TxLengthExceedsMtu {
        requested: usize,
        mtu: usize,
    },
    TxLengthExceedsPacketLimit {
        requested: usize,
        max_packet_bytes: usize,
    },
    BudgetInvariant {
        direction: StagingDirection,
        operation: &'static str,
    },
}

impl fmt::Display for ControlledIpDeviceFault {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::TxLengthExceedsMtu { requested, mtu } => write!(
                formatter,
                "CONTROLLED_IP_DEVICE_TX_MTU_EXCEEDED: requested {requested} bytes exceeds MTU {mtu}"
            ),
            Self::TxLengthExceedsPacketLimit {
                requested,
                max_packet_bytes,
            } => write!(
                formatter,
                "CONTROLLED_IP_DEVICE_TX_PACKET_LIMIT_EXCEEDED: requested {requested} bytes exceeds packet limit {max_packet_bytes}"
            ),
            Self::BudgetInvariant {
                direction,
                operation,
            } => write!(
                formatter,
                "CONTROLLED_IP_DEVICE_BUDGET_INVARIANT: {direction} budget failed during {operation}"
            ),
        }
    }
}

impl Error for ControlledIpDeviceFault {}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StageIngressErrorKind {
    EmptyPayload,
    PayloadExceedsMtu { actual: usize, mtu: usize },
    PayloadExceedsPacketLimit { actual: usize, limit: usize },
    PacketBudgetExhausted { limit: usize },
    ByteBudgetExhausted { actual: usize, limit: usize },
    TerminalFaulted { fault: ControlledIpDeviceFault },
}

/// Ingress staging rejection that always retains the submitted payload.
pub struct StageIngressError {
    kind: StageIngressErrorKind,
    payload: Bytes,
}

impl StageIngressError {
    pub fn kind(&self) -> &StageIngressErrorKind {
        &self.kind
    }

    pub fn payload(&self) -> &Bytes {
        &self.payload
    }

    pub fn into_payload(self) -> Bytes {
        self.payload
    }

    pub fn into_parts(self) -> (StageIngressErrorKind, Bytes) {
        (self.kind, self.payload)
    }
}

impl fmt::Debug for StageIngressError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("StageIngressError")
            .field("kind", &self.kind)
            .field("payload_len", &self.payload.len())
            .field("payload", &"redacted")
            .finish()
    }
}

impl fmt::Display for StageIngressError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match &self.kind {
            StageIngressErrorKind::EmptyPayload => formatter
                .write_str("CONTROLLED_IP_DEVICE_INGRESS_EMPTY: ingress packet must not be empty"),
            StageIngressErrorKind::PayloadExceedsMtu { actual, mtu } => write!(
                formatter,
                "CONTROLLED_IP_DEVICE_INGRESS_MTU_EXCEEDED: packet {actual} bytes exceeds MTU {mtu}"
            ),
            StageIngressErrorKind::PayloadExceedsPacketLimit { actual, limit } => write!(
                formatter,
                "CONTROLLED_IP_DEVICE_INGRESS_PACKET_LIMIT_EXCEEDED: packet {actual} bytes exceeds packet limit {limit}"
            ),
            StageIngressErrorKind::PacketBudgetExhausted { limit } => write!(
                formatter,
                "CONTROLLED_IP_DEVICE_INGRESS_PACKET_BUDGET_EXHAUSTED: packet staging limit {limit} is full"
            ),
            StageIngressErrorKind::ByteBudgetExhausted { actual, limit } => write!(
                formatter,
                "CONTROLLED_IP_DEVICE_INGRESS_BYTE_BUDGET_EXHAUSTED: staging would use {actual} bytes beyond limit {limit}"
            ),
            StageIngressErrorKind::TerminalFaulted { fault } => write!(
                formatter,
                "CONTROLLED_IP_DEVICE_TERMINAL_FAULT: ingress refused after {fault}"
            ),
        }
    }
}

impl Error for StageIngressError {}

struct PacketStaging {
    packets: VecDeque<Bytes>,
    used_bytes: usize,
    budget: StagingBudget,
}

impl PacketStaging {
    fn new(budget: StagingBudget) -> Self {
        Self {
            packets: VecDeque::new(),
            used_bytes: 0,
            budget,
        }
    }

    fn pop_front(
        &mut self,
        direction: StagingDirection,
    ) -> Result<Option<Bytes>, ControlledIpDeviceFault> {
        let Some(payload) = self.packets.pop_front() else {
            return Ok(None);
        };
        let Some(remaining) = self.used_bytes.checked_sub(payload.len()) else {
            self.packets.push_front(payload);
            return Err(ControlledIpDeviceFault::BudgetInvariant {
                direction,
                operation: "release staged packet bytes",
            });
        };
        self.used_bytes = remaining;
        Ok(Some(payload))
    }
}

struct TxStaging {
    committed: PacketStaging,
    reserved_packets: usize,
    reserved_bytes: usize,
}

impl TxStaging {
    fn new(budget: StagingBudget) -> Self {
        Self {
            committed: PacketStaging::new(budget),
            reserved_packets: 0,
            reserved_bytes: 0,
        }
    }

    fn try_reserve(&mut self, max_packet_bytes: usize) -> Result<bool, ControlledIpDeviceFault> {
        let operation = "reserve TX token";
        let occupied_packets = self
            .committed
            .packets
            .len()
            .checked_add(self.reserved_packets)
            .ok_or(ControlledIpDeviceFault::BudgetInvariant {
                direction: StagingDirection::Egress,
                operation,
            })?;
        if occupied_packets >= self.committed.budget.max_packets {
            return Ok(false);
        }

        let occupied_bytes = self
            .committed
            .used_bytes
            .checked_add(self.reserved_bytes)
            .ok_or(ControlledIpDeviceFault::BudgetInvariant {
                direction: StagingDirection::Egress,
                operation,
            })?;
        let reserved_total = occupied_bytes.checked_add(max_packet_bytes).ok_or(
            ControlledIpDeviceFault::BudgetInvariant {
                direction: StagingDirection::Egress,
                operation,
            },
        )?;
        if reserved_total > self.committed.budget.max_bytes {
            return Ok(false);
        }

        let reserved_packets = self.reserved_packets.checked_add(1).ok_or(
            ControlledIpDeviceFault::BudgetInvariant {
                direction: StagingDirection::Egress,
                operation,
            },
        )?;
        let reserved_bytes = self.reserved_bytes.checked_add(max_packet_bytes).ok_or(
            ControlledIpDeviceFault::BudgetInvariant {
                direction: StagingDirection::Egress,
                operation,
            },
        )?;
        self.reserved_packets = reserved_packets;
        self.reserved_bytes = reserved_bytes;
        Ok(true)
    }

    fn release_reservation(
        &mut self,
        max_packet_bytes: usize,
    ) -> Result<(), ControlledIpDeviceFault> {
        let operation = "release TX token reservation";
        let reserved_packets = self.reserved_packets.checked_sub(1).ok_or(
            ControlledIpDeviceFault::BudgetInvariant {
                direction: StagingDirection::Egress,
                operation,
            },
        )?;
        let reserved_bytes = self.reserved_bytes.checked_sub(max_packet_bytes).ok_or(
            ControlledIpDeviceFault::BudgetInvariant {
                direction: StagingDirection::Egress,
                operation,
            },
        )?;
        self.reserved_packets = reserved_packets;
        self.reserved_bytes = reserved_bytes;
        Ok(())
    }

    fn validate_commit(
        &self,
        payload_len: usize,
        max_packet_bytes: usize,
    ) -> Result<(), ControlledIpDeviceFault> {
        let operation = "validate TX commit";
        if self.reserved_packets == 0 || self.reserved_bytes < max_packet_bytes {
            return Err(ControlledIpDeviceFault::BudgetInvariant {
                direction: StagingDirection::Egress,
                operation,
            });
        }
        let packet_count = self.committed.packets.len().checked_add(1).ok_or(
            ControlledIpDeviceFault::BudgetInvariant {
                direction: StagingDirection::Egress,
                operation,
            },
        )?;
        let byte_count = self.committed.used_bytes.checked_add(payload_len).ok_or(
            ControlledIpDeviceFault::BudgetInvariant {
                direction: StagingDirection::Egress,
                operation,
            },
        )?;
        if packet_count > self.committed.budget.max_packets
            || byte_count > self.committed.budget.max_bytes
        {
            return Err(ControlledIpDeviceFault::BudgetInvariant {
                direction: StagingDirection::Egress,
                operation,
            });
        }
        Ok(())
    }

    fn commit(
        &mut self,
        payload: Bytes,
        max_packet_bytes: usize,
    ) -> Result<(), ControlledIpDeviceFault> {
        self.validate_commit(payload.len(), max_packet_bytes)?;
        let used_bytes = self.committed.used_bytes.checked_add(payload.len()).ok_or(
            ControlledIpDeviceFault::BudgetInvariant {
                direction: StagingDirection::Egress,
                operation: "commit TX packet bytes",
            },
        )?;
        let reserved_packets = self.reserved_packets.checked_sub(1).ok_or(
            ControlledIpDeviceFault::BudgetInvariant {
                direction: StagingDirection::Egress,
                operation: "commit TX packet reservation",
            },
        )?;
        let reserved_bytes = self.reserved_bytes.checked_sub(max_packet_bytes).ok_or(
            ControlledIpDeviceFault::BudgetInvariant {
                direction: StagingDirection::Egress,
                operation: "commit TX byte reservation",
            },
        )?;

        self.committed.packets.push_back(payload);
        self.committed.used_bytes = used_bytes;
        self.reserved_packets = reserved_packets;
        self.reserved_bytes = reserved_bytes;
        Ok(())
    }
}

/// Byte-only, bounded IP device consumed by smoltcp's synchronous poll loop.
pub struct ControlledIpDevice {
    mtu: usize,
    max_packet_bytes: usize,
    rx: PacketStaging,
    tx: TxStaging,
    terminal_fault: Option<ControlledIpDeviceFault>,
}

impl ControlledIpDevice {
    pub fn new(
        mtu: usize,
        max_packet_bytes: usize,
        rx_budget: StagingBudget,
        tx_budget: StagingBudget,
    ) -> Result<Self, ControlledIpDeviceConfigError> {
        if max_packet_bytes < MIN_CONTROLLED_IP_MTU
            || max_packet_bytes > MAX_CONTROLLED_IP_PACKET_BYTES
        {
            return Err(ControlledIpDeviceConfigError::InvalidPacketLimit { max_packet_bytes });
        }
        if mtu < MIN_CONTROLLED_IP_MTU || mtu > max_packet_bytes {
            return Err(ControlledIpDeviceConfigError::InvalidMtu {
                mtu,
                max_packet_bytes,
            });
        }
        validate_staging_budget(StagingDirection::Ingress, rx_budget, max_packet_bytes)?;
        validate_staging_budget(StagingDirection::Egress, tx_budget, max_packet_bytes)?;

        let device = Self {
            mtu,
            max_packet_bytes,
            rx: PacketStaging::new(rx_budget),
            tx: TxStaging::new(tx_budget),
            terminal_fault: None,
        };
        device.validate_capabilities()?;
        Ok(device)
    }

    /// Stage one owned IP packet. `Vec<u8>` and `Bytes` both enter through
    /// `Into<Bytes>`; every rejection returns the resulting owned `Bytes`.
    pub fn stage_ingress<P>(&mut self, payload: P) -> Result<(), StageIngressError>
    where
        P: Into<Bytes>,
    {
        let payload = payload.into();
        if let Some(fault) = self.terminal_fault.clone() {
            return Err(StageIngressError {
                kind: StageIngressErrorKind::TerminalFaulted { fault },
                payload,
            });
        }
        if payload.is_empty() {
            return Err(StageIngressError {
                kind: StageIngressErrorKind::EmptyPayload,
                payload,
            });
        }
        if payload.len() > self.max_packet_bytes {
            return Err(StageIngressError {
                kind: StageIngressErrorKind::PayloadExceedsPacketLimit {
                    actual: payload.len(),
                    limit: self.max_packet_bytes,
                },
                payload,
            });
        }
        if payload.len() > self.mtu {
            return Err(StageIngressError {
                kind: StageIngressErrorKind::PayloadExceedsMtu {
                    actual: payload.len(),
                    mtu: self.mtu,
                },
                payload,
            });
        }
        if self.rx.packets.len() >= self.rx.budget.max_packets {
            return Err(StageIngressError {
                kind: StageIngressErrorKind::PacketBudgetExhausted {
                    limit: self.rx.budget.max_packets,
                },
                payload,
            });
        }
        let Some(staged_bytes) = self.rx.used_bytes.checked_add(payload.len()) else {
            let fault = ControlledIpDeviceFault::BudgetInvariant {
                direction: StagingDirection::Ingress,
                operation: "stage ingress packet bytes",
            };
            record_terminal_fault(&mut self.terminal_fault, fault.clone());
            return Err(StageIngressError {
                kind: StageIngressErrorKind::TerminalFaulted { fault },
                payload,
            });
        };
        if staged_bytes > self.rx.budget.max_bytes {
            return Err(StageIngressError {
                kind: StageIngressErrorKind::ByteBudgetExhausted {
                    actual: staged_bytes,
                    limit: self.rx.budget.max_bytes,
                },
                payload,
            });
        }

        self.rx.packets.push_back(payload);
        self.rx.used_bytes = staged_bytes;
        Ok(())
    }

    /// Take one provider-produced packet and release its exact byte charge.
    pub fn take_egress(&mut self) -> Option<Bytes> {
        match self.tx.committed.pop_front(StagingDirection::Egress) {
            Ok(payload) => payload,
            Err(fault) => {
                record_terminal_fault(&mut self.terminal_fault, fault);
                None
            }
        }
    }

    pub fn terminal_fault(&self) -> Option<&ControlledIpDeviceFault> {
        self.terminal_fault.as_ref()
    }

    pub fn staged_ingress_packets(&self) -> usize {
        self.rx.packets.len()
    }

    pub fn staged_ingress_bytes(&self) -> usize {
        self.rx.used_bytes
    }

    pub fn staged_egress_packets(&self) -> usize {
        self.tx.committed.packets.len()
    }

    pub fn staged_egress_bytes(&self) -> usize {
        self.tx.committed.used_bytes
    }

    pub fn reserved_tx_packets(&self) -> usize {
        self.tx.reserved_packets
    }

    pub fn reserved_tx_bytes(&self) -> usize {
        self.tx.reserved_bytes
    }

    /// Verify the fixed `Medium::Ip`, MTU and software checksum contract.
    pub fn validate_capabilities(&self) -> Result<(), ControlledIpDeviceConfigError> {
        let capabilities = self.device_capabilities();
        if capabilities.medium != Medium::Ip {
            return Err(ControlledIpDeviceConfigError::CapabilityMismatch {
                reason: "controlled device medium must be IP",
            });
        }
        if capabilities.max_transmission_unit != self.mtu
            || capabilities.max_transmission_unit > self.max_packet_bytes
        {
            return Err(ControlledIpDeviceConfigError::CapabilityMismatch {
                reason: "controlled device MTU does not match its configured packet bounds",
            });
        }
        let checksum = &capabilities.checksum;
        if !checksum.ipv4.rx()
            || !checksum.ipv4.tx()
            || !checksum.tcp.rx()
            || !checksum.tcp.tx()
            || !checksum.udp.rx()
            || !checksum.udp.tx()
            || !checksum.icmpv4.rx()
            || !checksum.icmpv4.tx()
            || !checksum.icmpv6.rx()
            || !checksum.icmpv6.tx()
        {
            return Err(ControlledIpDeviceConfigError::CapabilityMismatch {
                reason: "controlled device requires software RX verification and TX checksum generation",
            });
        }
        Ok(())
    }

    fn device_capabilities(&self) -> DeviceCapabilities {
        let mut capabilities = DeviceCapabilities::default();
        capabilities.medium = Medium::Ip;
        capabilities.max_transmission_unit = self.mtu;
        capabilities.max_burst_size = Some(
            self.rx
                .budget
                .max_packets
                .min(self.tx.committed.budget.max_packets),
        );
        capabilities.checksum = ChecksumCapabilities::default();
        capabilities
    }

    fn reserve_tx_token(&mut self) -> bool {
        if self.terminal_fault.is_some() {
            return false;
        }
        match self.tx.try_reserve(self.max_packet_bytes) {
            Ok(reserved) => reserved,
            Err(fault) => {
                record_terminal_fault(&mut self.terminal_fault, fault);
                false
            }
        }
    }
}

impl fmt::Debug for ControlledIpDevice {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ControlledIpDevice")
            .field("medium", &"ip")
            .field("mtu", &self.mtu)
            .field("max_packet_bytes", &self.max_packet_bytes)
            .field("staged_ingress_packets", &self.rx.packets.len())
            .field("staged_ingress_bytes", &self.rx.used_bytes)
            .field("staged_egress_packets", &self.tx.committed.packets.len())
            .field("staged_egress_bytes", &self.tx.committed.used_bytes)
            .field("reserved_tx_packets", &self.tx.reserved_packets)
            .field("reserved_tx_bytes", &self.tx.reserved_bytes)
            .field("terminal_fault", &self.terminal_fault)
            .finish()
    }
}

impl Device for ControlledIpDevice {
    type RxToken<'a> = ControlledRxToken;
    type TxToken<'a>
        = ControlledTxToken<'a>
    where
        Self: 'a;

    fn receive(&mut self, _timestamp: Instant) -> Option<(Self::RxToken<'_>, Self::TxToken<'_>)> {
        if self.terminal_fault.is_some() || self.rx.packets.is_empty() {
            return None;
        }
        if !self.reserve_tx_token() {
            return None;
        }

        let payload = match self.rx.pop_front(StagingDirection::Ingress) {
            Ok(Some(payload)) => payload,
            Ok(None) => {
                let fault = ControlledIpDeviceFault::BudgetInvariant {
                    direction: StagingDirection::Ingress,
                    operation: "receive reserved a TX token without an ingress packet",
                };
                record_terminal_fault(&mut self.terminal_fault, fault);
                if let Err(release_fault) = self.tx.release_reservation(self.max_packet_bytes) {
                    record_terminal_fault(&mut self.terminal_fault, release_fault);
                }
                return None;
            }
            Err(fault) => {
                record_terminal_fault(&mut self.terminal_fault, fault);
                if let Err(release_fault) = self.tx.release_reservation(self.max_packet_bytes) {
                    record_terminal_fault(&mut self.terminal_fault, release_fault);
                }
                return None;
            }
        };

        let rx = ControlledRxToken { payload };
        let tx = ControlledTxToken {
            tx: &mut self.tx,
            terminal_fault: &mut self.terminal_fault,
            mtu: self.mtu,
            max_packet_bytes: self.max_packet_bytes,
            reservation_active: true,
        };
        Some((rx, tx))
    }

    fn transmit(&mut self, _timestamp: Instant) -> Option<Self::TxToken<'_>> {
        if !self.reserve_tx_token() {
            return None;
        }
        Some(ControlledTxToken {
            tx: &mut self.tx,
            terminal_fault: &mut self.terminal_fault,
            mtu: self.mtu,
            max_packet_bytes: self.max_packet_bytes,
            reservation_active: true,
        })
    }

    fn capabilities(&self) -> DeviceCapabilities {
        self.device_capabilities()
    }
}

pub struct ControlledRxToken {
    payload: Bytes,
}

impl fmt::Debug for ControlledRxToken {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ControlledRxToken")
            .field("payload_len", &self.payload.len())
            .field("payload", &"redacted")
            .finish()
    }
}

impl RxToken for ControlledRxToken {
    fn consume<R, F>(self, f: F) -> R
    where
        F: FnOnce(&[u8]) -> R,
    {
        f(&self.payload)
    }
}

pub struct ControlledTxToken<'a> {
    tx: &'a mut TxStaging,
    terminal_fault: &'a mut Option<ControlledIpDeviceFault>,
    mtu: usize,
    max_packet_bytes: usize,
    reservation_active: bool,
}

impl fmt::Debug for ControlledTxToken<'_> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ControlledTxToken")
            .field("mtu", &self.mtu)
            .field("max_packet_bytes", &self.max_packet_bytes)
            .field("reservation_active", &self.reservation_active)
            .finish_non_exhaustive()
    }
}

impl ControlledTxToken<'_> {
    fn terminal_panic(&mut self, fault: ControlledIpDeviceFault) -> ! {
        record_terminal_fault(self.terminal_fault, fault);
        panic!("controlled IP device entered a terminal TX fault")
    }
}

impl TxToken for ControlledTxToken<'_> {
    fn consume<R, F>(mut self, len: usize, f: F) -> R
    where
        F: FnOnce(&mut [u8]) -> R,
    {
        if len > self.max_packet_bytes {
            let fault = ControlledIpDeviceFault::TxLengthExceedsPacketLimit {
                requested: len,
                max_packet_bytes: self.max_packet_bytes,
            };
            self.terminal_panic(fault);
        }
        if len > self.mtu {
            let fault = ControlledIpDeviceFault::TxLengthExceedsMtu {
                requested: len,
                mtu: self.mtu,
            };
            self.terminal_panic(fault);
        }
        if let Err(fault) = self.tx.validate_commit(len, self.max_packet_bytes) {
            self.terminal_panic(fault);
        }

        let mut payload = vec![0; len];
        let result = f(&mut payload);
        if let Err(fault) = self.tx.commit(Bytes::from(payload), self.max_packet_bytes) {
            self.terminal_panic(fault);
        }
        self.reservation_active = false;
        result
    }
}

impl Drop for ControlledTxToken<'_> {
    fn drop(&mut self) {
        if !self.reservation_active {
            return;
        }
        match self.tx.release_reservation(self.max_packet_bytes) {
            Ok(()) => self.reservation_active = false,
            Err(fault) => record_terminal_fault(self.terminal_fault, fault),
        }
    }
}

fn validate_staging_budget(
    direction: StagingDirection,
    budget: StagingBudget,
    max_packet_bytes: usize,
) -> Result<(), ControlledIpDeviceConfigError> {
    budget
        .max_packets
        .checked_mul(max_packet_bytes)
        .ok_or(ControlledIpDeviceConfigError::StagingBudgetOverflow { direction })?;
    if budget.max_packets == 0
        || budget.max_packets > MAX_CONTROLLED_STAGING_PACKETS
        || budget.max_bytes < max_packet_bytes
        || budget.max_bytes > MAX_CONTROLLED_STAGING_BYTES
    {
        return Err(ControlledIpDeviceConfigError::InvalidStagingBudget {
            direction,
            max_packets: budget.max_packets,
            max_bytes: budget.max_bytes,
            max_packet_bytes,
        });
    }
    Ok(())
}

fn record_terminal_fault(
    terminal_fault: &mut Option<ControlledIpDeviceFault>,
    fault: ControlledIpDeviceFault,
) {
    if terminal_fault.is_none() {
        *terminal_fault = Some(fault);
    }
}

#[cfg(test)]
mod tests {
    use std::panic::{AssertUnwindSafe, catch_unwind};

    use super::*;

    fn budget(max_packets: usize, max_bytes: usize) -> StagingBudget {
        StagingBudget::new(max_packets, max_bytes)
    }

    fn device() -> ControlledIpDevice {
        ControlledIpDevice::new(1_500, 2_048, budget(2, 4_096), budget(2, 4_096)).unwrap()
    }

    #[test]
    fn ingress_is_consumed_exactly_once_and_releases_its_budget() {
        let mut device = device();
        let payload = Bytes::from_static(b"one-ip-packet");
        device.stage_ingress(payload.clone()).unwrap();
        assert_eq!(device.staged_ingress_packets(), 1);
        assert_eq!(device.staged_ingress_bytes(), payload.len());

        let (rx, tx) = Device::receive(&mut device, Instant::from_millis(1)).unwrap();
        let observed = RxToken::consume(rx, Bytes::copy_from_slice);
        assert_eq!(observed, payload);
        drop(tx);
        assert_eq!(device.staged_ingress_packets(), 0);
        assert_eq!(device.staged_ingress_bytes(), 0);
        assert!(Device::receive(&mut device, Instant::from_millis(2)).is_none());
    }

    #[test]
    fn transmit_stages_payload_and_take_releases_exact_bytes() {
        let mut device = device();
        let tx = Device::transmit(&mut device, Instant::from_millis(1)).unwrap();
        TxToken::consume(tx, 4, |buffer| buffer.copy_from_slice(b"pong"));
        assert_eq!(device.staged_egress_packets(), 1);
        assert_eq!(device.staged_egress_bytes(), 4);
        assert_eq!(device.take_egress(), Some(Bytes::from_static(b"pong")));
        assert_eq!(device.staged_egress_packets(), 0);
        assert_eq!(device.staged_egress_bytes(), 0);
        assert!(device.take_egress().is_none());
    }

    #[test]
    fn transmit_token_requires_one_max_packet_of_capacity() {
        let mut device =
            ControlledIpDevice::new(1_500, 2_048, budget(1, 2_048), budget(1, 2_048)).unwrap();
        let tx = Device::transmit(&mut device, Instant::from_millis(1)).unwrap();
        TxToken::consume(tx, 1, |buffer| buffer[0] = 7);
        assert!(Device::transmit(&mut device, Instant::from_millis(2)).is_none());
        assert_eq!(device.take_egress(), Some(Bytes::from_static(&[7])));
        assert!(Device::transmit(&mut device, Instant::from_millis(3)).is_some());
    }

    #[test]
    fn oversize_tx_sets_sticky_terminal_fault_and_never_stages() {
        let mut device = device();
        let tx = Device::transmit(&mut device, Instant::from_millis(1)).unwrap();
        let panic = catch_unwind(AssertUnwindSafe(|| {
            TxToken::consume(tx, 1_501, |_| ());
        }));
        assert!(panic.is_err());
        assert_eq!(
            device.terminal_fault(),
            Some(&ControlledIpDeviceFault::TxLengthExceedsMtu {
                requested: 1_501,
                mtu: 1_500,
            })
        );
        assert_eq!(device.reserved_tx_packets(), 0);
        assert_eq!(device.reserved_tx_bytes(), 0);
        assert_eq!(device.staged_egress_packets(), 0);
        assert!(Device::transmit(&mut device, Instant::from_millis(2)).is_none());
    }

    #[test]
    fn ingress_packet_and_byte_budgets_preserve_rejected_payloads() {
        let mut packet_limited =
            ControlledIpDevice::new(1_500, 1_500, budget(1, 3_000), budget(1, 1_500)).unwrap();
        packet_limited.stage_ingress(vec![1; 1_000]).unwrap();
        let rejected = Bytes::from(vec![2; 500]);
        let error = packet_limited.stage_ingress(rejected.clone()).unwrap_err();
        assert_eq!(
            error.kind(),
            &StageIngressErrorKind::PacketBudgetExhausted { limit: 1 }
        );
        assert_eq!(error.into_payload(), rejected);

        let mut byte_limited =
            ControlledIpDevice::new(1_500, 1_500, budget(2, 1_500), budget(1, 1_500)).unwrap();
        byte_limited.stage_ingress(vec![3; 1_000]).unwrap();
        let rejected = Bytes::from(vec![4; 501]);
        let error = byte_limited.stage_ingress(rejected.clone()).unwrap_err();
        assert_eq!(
            error.kind(),
            &StageIngressErrorKind::ByteBudgetExhausted {
                actual: 1_501,
                limit: 1_500,
            }
        );
        assert_eq!(error.into_payload(), rejected);
    }

    #[test]
    fn transmit_queue_enforces_packet_and_byte_budgets() {
        let mut device =
            ControlledIpDevice::new(1_500, 1_500, budget(1, 1_500), budget(2, 2_000)).unwrap();
        let tx = Device::transmit(&mut device, Instant::from_millis(1)).unwrap();
        TxToken::consume(tx, 501, |_| ());
        // One packet slot remains, but less than max_packet bytes remain. No
        // token may be issued without reserving the entire maximum packet.
        assert!(Device::transmit(&mut device, Instant::from_millis(2)).is_none());
        assert_eq!(device.staged_egress_packets(), 1);
        assert_eq!(device.staged_egress_bytes(), 501);
        assert!(device.take_egress().is_some());
        assert!(Device::transmit(&mut device, Instant::from_millis(3)).is_some());
    }

    #[test]
    fn dropping_tokens_releases_reservations_without_occupying_staging() {
        let mut device = device();
        let tx = Device::transmit(&mut device, Instant::from_millis(1)).unwrap();
        assert_eq!(tx.tx.reserved_packets, 1);
        assert_eq!(tx.tx.reserved_bytes, 2_048);
        drop(tx);
        assert_eq!(device.reserved_tx_packets(), 0);
        assert_eq!(device.reserved_tx_bytes(), 0);
        assert_eq!(device.staged_egress_packets(), 0);
        assert!(Device::transmit(&mut device, Instant::from_millis(2)).is_some());
    }

    #[test]
    fn reservation_inconsistency_sets_terminal_fault() {
        let mut device = device();
        let tx = Device::transmit(&mut device, Instant::from_millis(1)).unwrap();
        tx.tx.reserved_bytes = 0;
        let panic = catch_unwind(AssertUnwindSafe(|| {
            TxToken::consume(tx, 1, |_| ());
        }));
        assert!(panic.is_err());
        assert!(matches!(
            device.terminal_fault(),
            Some(ControlledIpDeviceFault::BudgetInvariant {
                direction: StagingDirection::Egress,
                ..
            })
        ));
    }

    #[test]
    fn capabilities_are_explicit_ip_mtu_and_software_checksums() {
        let device = device();
        let capabilities = Device::capabilities(&device);
        assert_eq!(capabilities.medium, Medium::Ip);
        assert_eq!(capabilities.max_transmission_unit, 1_500);
        assert_eq!(capabilities.max_burst_size, Some(2));
        assert!(capabilities.checksum.ipv4.rx());
        assert!(capabilities.checksum.ipv4.tx());
        assert!(capabilities.checksum.tcp.rx());
        assert!(capabilities.checksum.tcp.tx());
        assert!(capabilities.checksum.udp.rx());
        assert!(capabilities.checksum.udp.tx());
        assert!(device.validate_capabilities().is_ok());
    }

    #[test]
    fn device_is_send_and_debug_output_redacts_packet_bytes() {
        fn assert_send<T: Send>() {}
        assert_send::<ControlledIpDevice>();

        let mut device = device();
        device
            .stage_ingress(Bytes::from_static(b"payload-secret-marker"))
            .unwrap();
        let debug = format!("{device:?}");
        assert!(debug.contains("staged_ingress_packets"));
        assert!(!debug.contains("payload-secret-marker"));

        device.stage_ingress(Bytes::from_static(b"filler")).unwrap();
        let error = device
            .stage_ingress(Bytes::from_static(b"rejected-secret-marker"))
            .unwrap_err();
        let debug = format!("{error:?}");
        assert!(debug.contains("payload_len"));
        assert!(!debug.contains("rejected-secret-marker"));
    }
}
