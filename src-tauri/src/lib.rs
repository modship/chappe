mod files;
mod history;
mod local;
mod menu;
mod output;
mod servers;
mod session;
mod settings;
mod ssh;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(session::SessionManager::default())
        .manage(ssh::Connections::default())
        .manage(files::Transfers::default())
        .setup(|app| {
            let config_dir = app.path().app_config_dir()?;
            app.manage(settings::SettingsStore::new(config_dir.clone()));
            app.manage(servers::ServerStore::new(config_dir));
            menu::install(app)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            local::local_spawn,
            local::local_profiles,
            ssh::ssh_connect,
            session::terminal_write,
            session::terminal_resize,
            session::terminal_close,
            session::terminal_prompt_reply,
            session::terminal_cwd,
            files::fs_home,
            files::fs_list,
            files::fs_mkdir,
            files::fs_rename,
            files::fs_remove,
            files::fs_existing,
            files::fs_open_local,
            files::fs_reveal_local,
            files::fs_open_remote,
            files::fs_downloads_dir,
            files::fs_read_text,
            files::fs_write_text,
            files::transfer_download,
            files::transfer_upload,
            files::transfer_cancel,
            history::history_import_local,
            history::history_import_ssh,
            settings::settings_load,
            settings::settings_save,
            servers::servers_list,
            servers::server_save,
            servers::server_delete,
            servers::server_forget_password,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Chappe");
}
