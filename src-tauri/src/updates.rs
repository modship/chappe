//! Updates come from the updater plugin; this only tells the frontend
//! whether this build can verify them.

/// False until a public key is set in `plugins.updater.pubkey`: without
/// it no update can be verified, so the app doesn't offer any.
#[tauri::command]
pub fn updates_configured(app: tauri::AppHandle) -> bool {
    app.config()
        .plugins
        .0
        .get("updater")
        .and_then(|updater| updater.get("pubkey"))
        .and_then(|key| key.as_str())
        .is_some_and(|key| !key.trim().is_empty())
}
