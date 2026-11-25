//! Connection-based persistence. The caller owns connection locking and snapshots.
mod accounts;
mod mutations;
mod preferences;
mod schema;

pub use crate::{
    codes::code_for,
    models::{MfaAccount, MfaAccountInput, MfaAccountPatch, MfaCode, MfaPrefs, ValidAccount},
    validation::{SORT_MODES, validate_input},
};
pub use accounts::*;
pub use mutations::*;
pub use preferences::*;
pub use schema::{SCHEMA_VERSION, init_db, open_db};
