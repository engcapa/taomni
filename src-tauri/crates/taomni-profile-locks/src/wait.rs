use std::{
    fmt, io,
    time::{Duration, Instant},
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LeaseKind {
    ProfileUse,
    ProfileRestore,
    ProfileState,
    LegacyUpgrade,
    PluginData,
    VaultRead,
    VaultWrite,
}

#[derive(Debug)]
pub enum LeaseError {
    Io(io::Error),
    InvalidSlug,
    UnsafeLockPath,
    Busy(LeaseKind),
    Cancelled,
    TimedOut,
}

impl fmt::Display for LeaseError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io(error) => write!(f, "profile lease I/O: {error}"),
            Self::InvalidSlug => f.write_str("invalid plugin slug"),
            Self::UnsafeLockPath => f.write_str("unsafe profile lock path"),
            Self::Busy(kind) => write!(f, "profile lease is in use: {kind:?}"),
            Self::Cancelled => f.write_str("profile lease wait cancelled"),
            Self::TimedOut => f.write_str("profile lease wait timed out"),
        }
    }
}

impl std::error::Error for LeaseError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Io(error) => Some(error),
            _ => None,
        }
    }
}

impl From<io::Error> for LeaseError {
    fn from(value: io::Error) -> Self {
        Self::Io(value)
    }
}

/// Every wait is bounded and cooperative. The callback may adapt the core's
/// CancellationToken without making this crate depend on tokio or Tauri.
pub struct WaitControl<'a> {
    deadline: Instant,
    cancelled: &'a dyn Fn() -> bool,
}

impl<'a> WaitControl<'a> {
    pub fn new(deadline: Instant, cancelled: &'a dyn Fn() -> bool) -> Self {
        Self {
            deadline,
            cancelled,
        }
    }

    pub(crate) fn check(&self) -> Result<(), LeaseError> {
        if (self.cancelled)() {
            return Err(LeaseError::Cancelled);
        }
        if Instant::now() >= self.deadline {
            return Err(LeaseError::TimedOut);
        }
        Ok(())
    }

    pub(crate) fn retry(&self) -> Result<(), LeaseError> {
        self.check()?;
        std::thread::sleep(
            self.deadline
                .saturating_duration_since(Instant::now())
                .min(Duration::from_millis(10)),
        );
        self.check()
    }
}
