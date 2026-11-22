use super::{
    FolderRoundOutcome, FolderRoundRequest, FolderStepOutcome, HeaderPageOutcome,
    HeaderPageRequest, HeaderStepRequest,
};
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BodySyncRequest {
    pub task: BodySyncTask,
    pub recent_limit: u32,
    pub max_bytes: u32,
    pub save_original: bool,
}

#[derive(Serialize, Deserialize)]
#[serde(
    tag = "kind",
    content = "request",
    rename_all = "camelCase",
    deny_unknown_fields
)]
pub enum BodySyncTask {
    Page(HeaderPageRequest),
    Step(HeaderStepRequest),
    Round(FolderRoundRequest),
}

impl BodySyncTask {
    pub fn mailbox(&self) -> (&str, &str) {
        match self {
            Self::Page(request) => (&request.account_id, &request.folder),
            Self::Step(request) => (&request.account_id, &request.folder),
            Self::Round(request) => (&request.folder.account_id, &request.folder.name),
        }
    }
}

#[derive(Serialize, Deserialize)]
#[serde(
    tag = "kind",
    content = "outcome",
    rename_all = "camelCase",
    deny_unknown_fields
)]
pub enum BodySyncOutcome {
    Page(HeaderPageOutcome),
    Step(FolderStepOutcome),
    Round(FolderRoundOutcome),
}
