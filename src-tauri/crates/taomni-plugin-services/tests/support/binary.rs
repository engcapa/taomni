use std::{
    collections::BTreeSet,
    net::SocketAddrV4,
    time::{Duration, Instant},
};

use taomni_plugin_api::{
    BinaryRef,
    services::{HostInstanceId, OperationId, ProfileGeneration, VaultEpoch},
};
use taomni_plugin_services::{
    AuthorizedHost, OperationAdmission, OperationKind, OperationPermit, ReverseRequestPermit,
    VerifiedHostGrants,
};
use taomni_plugin_stream::{
    BinaryOffer, TransferLimits, TransferPool, TransferPoolLimits, TransferUsage,
};
use taomni_profile_locks::{LeaseError, PluginSlug, ProfileRoot, VaultOperationLease};

const ID: &str = "a1234567-1234-1234-1234-123456789abc";

pub struct Fixture {
    _directory: tempfile::TempDir,
    pub root: ProfileRoot,
    pub admission: OperationAdmission,
    pub host: AuthorizedHost,
    pub pool: TransferPool,
}

impl Fixture {
    pub fn new() -> Self {
        let directory = tempfile::tempdir().unwrap();
        let root = ProfileRoot::prepare(directory.path()).unwrap();
        let admission = OperationAdmission::new(
            ProfileGeneration::parse(ID).unwrap(),
            VaultEpoch::new(1).unwrap(),
            false,
        );
        // Authentication/manifest checks have their own real-host gate. This
        // fixture exercises the production admission/lease/network boundary.
        let host = VerifiedHostGrants::from_verified_manifest(
            PluginSlug::parse("mfa").unwrap(),
            BTreeSet::new(),
            BTreeSet::new(),
        )
        .unwrap()
        .bind_authenticated_transport(HostInstanceId::parse(ID).unwrap());
        Self {
            _directory: directory,
            root,
            admission,
            host,
            pool: TransferPool::new(TransferPoolLimits {
                max_transfers: 2,
                max_bytes: 1024 * 1024,
            })
            .unwrap(),
        }
    }

    pub fn admit(&self, duration: Duration) -> OperationPermit {
        self.admission
            .admit_until(
                &self.host,
                OperationId::parse(ID).unwrap(),
                OperationKind::ReadData,
                VaultOperationLease::try_read(&self.root).unwrap(),
                Instant::now() + duration,
            )
            .unwrap()
    }

    pub fn request(&self, outer: &OperationPermit, suffix: &str) -> ReverseRequestPermit {
        self.admission
            .borrow_operation(&self.host, outer.context())
            .unwrap()
            .begin_service_request(format!("host/{ID}/{suffix}").into())
            .unwrap()
    }

    pub async fn offer(
        &self,
        outer: &OperationPermit,
        suffix: &str,
        bytes: Vec<u8>,
    ) -> BinaryOffer {
        let reservation = self.pool.reserve(bytes.capacity()).unwrap();
        taomni_plugin_services::offer_binary_for_request(
            self.request(outer, suffix),
            reservation,
            bytes,
            "application/octet-stream",
            limits(),
        )
        .await
        .unwrap()
    }

    pub fn assert_writer_blocked(&self) {
        assert!(matches!(
            VaultOperationLease::try_write(&self.root),
            Err(LeaseError::Busy(_))
        ));
    }

    pub fn assert_drained(&self) {
        assert_eq!(self.pool.usage(), TransferUsage::default());
        assert_eq!(self.admission.in_flight_count(), 0);
        assert!(VaultOperationLease::try_write(&self.root).is_ok());
    }
}

pub fn limits() -> TransferLimits {
    TransferLimits {
        timeout: Duration::from_secs(5),
        ..Default::default()
    }
}

pub fn address(descriptor: &BinaryRef) -> SocketAddrV4 {
    descriptor
        .stream_url
        .strip_prefix("ws://")
        .unwrap()
        .split('/')
        .next()
        .unwrap()
        .parse()
        .unwrap()
}

pub fn assert_port_released(endpoint: SocketAddrV4) {
    drop(
        std::net::TcpListener::bind(endpoint)
            .expect("completed transfer must release its kernel listener"),
    );
}
