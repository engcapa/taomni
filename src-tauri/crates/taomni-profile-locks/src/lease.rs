use std::fs::{File, TryLockError};

use crate::{LeaseError, LeaseKind, PluginSlug, ProfileRoot, WaitControl};

struct FileLease(File);

impl FileLease {
    fn acquire(
        file: File,
        shared: bool,
        kind: LeaseKind,
        wait: Option<&WaitControl<'_>>,
    ) -> Result<Self, LeaseError> {
        loop {
            if let Some(wait) = wait {
                wait.check()?;
            }
            let result = if shared {
                file.try_lock_shared()
            } else {
                file.try_lock()
            };
            match result {
                Ok(()) => return Ok(Self(file)),
                Err(TryLockError::WouldBlock) => match wait {
                    Some(wait) => wait.retry()?,
                    None => return Err(LeaseError::Busy(kind)),
                },
                Err(TryLockError::Error(error)) => return Err(error.into()),
            }
        }
    }
}

impl Drop for FileLease {
    fn drop(&mut self) {
        let _ = self.0.unlock();
    }
}

macro_rules! lease {
    ($name:ident, $kind:ident, $open:ident, $shared:expr) => {
        pub struct $name {
            _lease: FileLease,
        }

        impl $name {
            pub fn try_acquire(root: &ProfileRoot) -> Result<Self, LeaseError> {
                Ok(Self {
                    _lease: FileLease::acquire(root.$open()?, $shared, LeaseKind::$kind, None)?,
                })
            }
            pub fn acquire(root: &ProfileRoot, wait: &WaitControl<'_>) -> Result<Self, LeaseError> {
                Ok(Self {
                    _lease: FileLease::acquire(
                        root.$open()?,
                        $shared,
                        LeaseKind::$kind,
                        Some(wait),
                    )?,
                })
            }
        }
        impl std::fmt::Debug for $name {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str(stringify!($name))
            }
        }
    };
}

lease!(ProfileUseLease, ProfileUse, open_profile, true);
lease!(ProfileRestoreLease, ProfileRestore, open_profile, false);
lease!(ProfileStateLease, ProfileState, open_state, false);

// Old desktop/headless binaries know the mode lock, but not the newer profile
// lock. An upgrade must hold this exclusive lease AND ProfileRestoreLease.
lease!(LegacyDesktopLease, LegacyUpgrade, open_legacy_upgrade, true);
lease!(
    LegacyUpgradeLease,
    LegacyUpgrade,
    open_legacy_upgrade,
    false
);

/// Held by the actual writer host, not solely by its parent core process.
pub struct PluginDataLease {
    _lease: FileLease,
}

impl PluginDataLease {
    pub fn try_acquire(root: &ProfileRoot, slug: &PluginSlug) -> Result<Self, LeaseError> {
        Self::open(root, slug, None)
    }

    pub fn acquire(
        root: &ProfileRoot,
        slug: &PluginSlug,
        wait: &WaitControl<'_>,
    ) -> Result<Self, LeaseError> {
        Self::open(root, slug, Some(wait))
    }

    fn open(
        root: &ProfileRoot,
        slug: &PluginSlug,
        wait: Option<&WaitControl<'_>>,
    ) -> Result<Self, LeaseError> {
        Ok(Self {
            _lease: FileLease::acquire(
                root.open_plugin(slug)?,
                false,
                LeaseKind::PluginData,
                wait,
            )?,
        })
    }
}

impl std::fmt::Debug for PluginDataLease {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("PluginDataLease")
    }
}

/// Shared for a complete data-key operation, exclusive for rekey/snapshot.
/// An admitted reverse RPC borrows its outer permit; do not acquire recursively.
pub struct VaultOperationLease {
    _lease: FileLease,
    exclusive: bool,
}

impl VaultOperationLease {
    pub fn try_read(root: &ProfileRoot) -> Result<Self, LeaseError> {
        Self::open(root, false, None)
    }
    pub fn try_write(root: &ProfileRoot) -> Result<Self, LeaseError> {
        Self::open(root, true, None)
    }
    pub fn read(root: &ProfileRoot, wait: &WaitControl<'_>) -> Result<Self, LeaseError> {
        Self::open(root, false, Some(wait))
    }
    pub fn write(root: &ProfileRoot, wait: &WaitControl<'_>) -> Result<Self, LeaseError> {
        Self::open(root, true, Some(wait))
    }
    pub fn is_exclusive(&self) -> bool {
        self.exclusive
    }

    fn open(
        root: &ProfileRoot,
        exclusive: bool,
        wait: Option<&WaitControl<'_>>,
    ) -> Result<Self, LeaseError> {
        let kind = if exclusive {
            LeaseKind::VaultWrite
        } else {
            LeaseKind::VaultRead
        };
        Ok(Self {
            _lease: FileLease::acquire(root.open_vault()?, !exclusive, kind, wait)?,
            exclusive,
        })
    }
}

impl std::fmt::Debug for VaultOperationLease {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("VaultOperationLease")
            .field("exclusive", &self.exclusive)
            .finish()
    }
}
