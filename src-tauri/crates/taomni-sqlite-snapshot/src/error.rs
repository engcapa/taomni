use std::{fmt, io};

#[derive(Debug)]
pub enum SnapshotError {
    Cancelled,
    TimedOut,
    InvalidOptions,
    UnsafePath,
    SourceIsDestination,
    IntegrityCheckFailed,
    Io(io::Error),
    Sqlite(rusqlite::Error),
}

impl fmt::Display for SnapshotError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Cancelled => f.write_str("BACKUP_CANCELLED"),
            Self::TimedOut => f.write_str("SQLite snapshot timed out"),
            Self::InvalidOptions => f.write_str("invalid SQLite snapshot options"),
            Self::UnsafePath => f.write_str("unsafe SQLite snapshot path"),
            Self::SourceIsDestination => f.write_str("snapshot destination is the source database"),
            Self::IntegrityCheckFailed => f.write_str("SQLite snapshot integrity check failed"),
            Self::Io(error) => write!(f, "SQLite snapshot I/O: {error}"),
            Self::Sqlite(error) => write!(f, "SQLite snapshot: {error}"),
        }
    }
}

impl std::error::Error for SnapshotError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Io(error) => Some(error),
            Self::Sqlite(error) => Some(error),
            _ => None,
        }
    }
}

impl From<io::Error> for SnapshotError {
    fn from(value: io::Error) -> Self {
        Self::Io(value)
    }
}
impl From<rusqlite::Error> for SnapshotError {
    fn from(value: rusqlite::Error) -> Self {
        Self::Sqlite(value)
    }
}
