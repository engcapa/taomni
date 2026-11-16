//! Typed command decoding precedes any store write. The export payload accepts
//! a core-issued single-use grant; a master password is never a host input.
use super::{INITIALIZATION_REQUIRED, business_error, key_provider::SdkKeyProvider, store::Store};
use serde::{Deserialize, de::DeserializeOwned};
use serde_json::Value;
use taomni_mfa_engine::{
    crypto::DataKey,
    keys::{self, KeyProvider},
    models::*,
    operations, store,
};
use taomni_plugin_api::{
    ErrorCode, RpcError,
    services::{ExportGrantId, ResetGrantId},
};
use taomni_plugin_sdk::Operation;

pub(super) enum Command {
    List,
    Codes(Option<Vec<String>>),
    Inspect(Vec<MfaAccountInput>),
    Add(Vec<MfaAccountInput>, bool),
    Update(String, MfaAccountPatch),
    Delete(String),
    Reorder(Vec<String>),
    HotpNext(String),
    MarkUsed(String),
    Prefs(MfaPrefs),
    Export(String, ExportGrantId),
    Reset(ResetGrantId),
    Initialize,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Empty {}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Id {
    id: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Ids {
    ids: Vec<String>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Codes {
    #[serde(default)]
    ids: Option<Vec<String>>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Inputs {
    inputs: Vec<MfaAccountInput>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Add {
    inputs: Vec<MfaAccountInput>,
    skip_duplicates: bool,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Update {
    id: String,
    patch: MfaAccountPatch,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Prefs {
    prefs: MfaPrefs,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Export {
    id: String,
    grant: ExportGrantId,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Reset {
    grant: ResetGrantId,
}

fn decode<T: DeserializeOwned>(params: Option<Value>) -> Result<T, RpcError> {
    serde_json::from_value(params.unwrap_or_else(|| serde_json::json!({})))
        .map_err(|_| RpcError::from_code(ErrorCode::InvalidParams))
}

pub(super) fn parse(method: &str, params: Option<Value>) -> Result<Command, RpcError> {
    Ok(match method {
        "mfa_list" => {
            decode::<Empty>(params)?;
            Command::List
        }
        "mfa_codes" => Command::Codes(decode::<Codes>(params)?.ids),
        "mfa_inspect" => Command::Inspect(decode::<Inputs>(params)?.inputs),
        "mfa_add" => {
            let args: Add = decode(params)?;
            Command::Add(args.inputs, args.skip_duplicates)
        }
        "mfa_update" => {
            let args: Update = decode(params)?;
            Command::Update(args.id, args.patch)
        }
        "mfa_delete" => Command::Delete(decode::<Id>(params)?.id),
        "mfa_reorder" => Command::Reorder(decode::<Ids>(params)?.ids),
        "mfa_hotp_next" => Command::HotpNext(decode::<Id>(params)?.id),
        "mfa_mark_used" => Command::MarkUsed(decode::<Id>(params)?.id),
        "mfa_set_prefs" => Command::Prefs(decode::<Prefs>(params)?.prefs),
        "mfa_export_uri" => {
            let args: Export = decode(params)?;
            Command::Export(args.id, args.grant)
        }
        "mfa_reset_store" => Command::Reset(decode::<Reset>(params)?.grant),
        "mfa_initialize_empty" => {
            decode::<Empty>(params)?;
            Command::Initialize
        }
        _ => return Err(RpcError::from_code(ErrorCode::MethodNotFound)),
    })
}

pub(super) fn invoke(
    store: &Store,
    operation: &Operation,
    command: Command,
) -> Result<Value, RpcError> {
    if let Command::Export(_, grant) = &command {
        operation.validate_export_grant(grant.clone())?;
    }
    store.admitted(operation, |conn| {
        if let Command::Reset(grant) = &command {
            let provider = SdkKeyProvider::for_reset(operation, grant.clone());
            match provider.load() {
                Ok(_) => (),
                Err(error) if error == taomni_mfa_engine::ERR_KEY_MISMATCH => (),
                Err(error) => return Err(business_error(error)),
            }
            store::reset(conn).map_err(business_error)?;
            keys::rebind_after_reset(conn, &provider).map_err(business_error)?;
            return Ok(Value::Null);
        }
        let provider = SdkKeyProvider::new(operation);
        if matches!(command, Command::Initialize) {
            keys::ensure_key(conn, &provider).map_err(business_error)?;
            return Ok(Value::Null);
        }
        let key = keys::prepare_key(conn, &provider)
            .map_err(business_error)?
            .ok_or_else(|| business_error(INITIALIZATION_REQUIRED))?;
        operation.check_current()?;
        execute(conn, &key, command).map_err(business_error)
    })
}

fn execute(
    conn: &mut rusqlite::Connection,
    key: &DataKey,
    command: Command,
) -> Result<Value, String> {
    let result = match command {
        Command::List => serde_json::to_value(operations::list(conn)?),
        Command::Codes(ids) => serde_json::to_value(operations::codes(
            conn,
            key,
            ids.as_deref(),
            taomni_mfa_engine::now_ms(),
        )?),
        Command::Inspect(inputs) => serde_json::to_value(operations::inspect(conn, key, &inputs)?),
        Command::Add(inputs, skip) => {
            serde_json::to_value(operations::add(conn, key, &inputs, skip)?)
        }
        Command::Update(id, patch) => serde_json::to_value(operations::update(conn, &id, &patch)?),
        Command::Delete(id) => serde_json::to_value(operations::delete(conn, &id)?),
        Command::Reorder(ids) => serde_json::to_value(operations::reorder(conn, &ids)?),
        Command::HotpNext(id) => serde_json::to_value(operations::hotp_next(conn, key, &id)?),
        Command::MarkUsed(id) => serde_json::to_value(operations::mark_used(conn, &id)?),
        Command::Prefs(prefs) => serde_json::to_value(operations::set_prefs(conn, &prefs)?),
        Command::Export(id, _) => serde_json::to_value(operations::export_uri(conn, key, &id)?),
        Command::Reset(_) | Command::Initialize => {
            unreachable!("authorization handled before keyed dispatch")
        }
    };
    result.map_err(|_| "MFA_RESULT_ENCODING_FAILED".into())
}
