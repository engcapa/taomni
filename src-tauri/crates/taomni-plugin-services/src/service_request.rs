use std::collections::HashSet;

use taomni_plugin_api::{RequestId, services::CoreServiceError};

use crate::BorrowedOperation;

#[derive(Default)]
pub(crate) struct RequestLedger {
    seen: HashSet<RequestId>,
    active: usize,
}

/// A completion retains its outer admission/lease until it is written or
/// discarded. Seen IDs remain remembered until the operation ends, so retries
/// cannot replay a key creation or grant consumption after a response is lost.
pub struct ReverseRequestPermit {
    operation: BorrowedOperation,
    id: RequestId,
}

impl ReverseRequestPermit {
    pub fn operation(&self) -> &BorrowedOperation {
        &self.operation
    }
    pub fn request_id(&self) -> &RequestId {
        &self.id
    }
    pub fn check_current(&self) -> Result<(), CoreServiceError> {
        self.operation.check_current()
    }

    /// The descriptor writer and the actual network task independently retain
    /// the same operation. Neither can release the other's OS lease early.
    pub fn retain_operation(&self) -> BorrowedOperation {
        BorrowedOperation(self.operation.0.clone())
    }
}

impl Drop for ReverseRequestPermit {
    fn drop(&mut self) {
        self.operation
            .0
            .service_requests
            .lock()
            .expect("service request ledger poisoned")
            .active -= 1;
    }
}

impl BorrowedOperation {
    pub fn begin_service_request(
        &self,
        id: RequestId,
    ) -> Result<ReverseRequestPermit, CoreServiceError> {
        self.check_current()?;
        let mut ledger = self
            .0
            .service_requests
            .lock()
            .expect("service request ledger poisoned");
        if ledger.seen.contains(&id) {
            return Err(CoreServiceError::DuplicateRequest);
        }
        if ledger.active >= 8 || ledger.seen.len() >= 256 {
            return Err(CoreServiceError::CoreServiceBusy);
        }
        ledger.seen.insert(id.clone());
        ledger.active += 1;
        Ok(ReverseRequestPermit {
            operation: BorrowedOperation(self.0.clone()),
            id,
        })
    }
}
