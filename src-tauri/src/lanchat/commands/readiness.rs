use crate::state::AppState;
use tauri::State;

pub(super) async fn ensure_ready(state: &State<'_, AppState>) -> Result<(), String> {
    state.lanchat.ensure_unlocked(&state.vault).await
}
