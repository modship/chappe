//! App settings (theme, fonts), kept as a JSON file in the config folder.
//! The frontend owns their shape and defaults; this side only stores them.

use std::fs;
use std::path::PathBuf;

use serde_json::Value;
use tauri::State;

pub struct SettingsStore {
    path: PathBuf,
}

impl SettingsStore {
    pub fn new(config_dir: PathBuf) -> Self {
        Self {
            path: config_dir.join("settings.json"),
        }
    }

    fn load(&self) -> Option<Value> {
        let text = fs::read_to_string(&self.path).ok()?;
        serde_json::from_str(&text).ok()
    }

    fn save(&self, value: &Value) -> anyhow::Result<()> {
        if let Some(dir) = self.path.parent() {
            fs::create_dir_all(dir)?;
        }
        let tmp = self.path.with_extension("json.tmp");
        fs::write(&tmp, serde_json::to_vec_pretty(value)?)?;
        fs::rename(&tmp, &self.path)?;
        Ok(())
    }
}

/// The saved settings, or null when there are none (or they can't be read).
#[tauri::command]
pub fn settings_load(store: State<'_, SettingsStore>) -> Option<Value> {
    store.load()
}

#[tauri::command]
pub fn settings_save(store: State<'_, SettingsStore>, settings: Value) -> Result<(), String> {
    store
        .save(&settings)
        .map_err(|e| format!("Couldn't save the settings: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip_and_missing_file() {
        let dir = std::env::temp_dir().join(format!("chappe-settings-{}", uuid::Uuid::new_v4()));
        let store = SettingsStore::new(dir.clone());
        assert_eq!(store.load(), None);
        let value = serde_json::json!({ "theme": "nord", "fontSize": 14 });
        store.save(&value).unwrap();
        assert_eq!(store.load(), Some(value));
        fs::write(dir.join("settings.json"), "{ broken").unwrap();
        assert_eq!(store.load(), None);
        fs::remove_dir_all(dir).unwrap();
    }
}
