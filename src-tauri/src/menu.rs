//! Native menu bar. Only macOS gets one: there it carries the Edit items
//! that make ⌘C / ⌘V work inside the webview. Elsewhere a terminal app has
//! no menu bar and shortcuts are handled by the frontend.

use tauri::App;

/// Menu ids forwarded to the frontend as a `menu` event.
#[cfg(target_os = "macos")]
const FORWARDED: &[&str] = &[
    "new-session",
    "save",
    "close-tab",
    "next-tab",
    "prev-tab",
    "select-all",
    "toggle-files",
    "toggle-history",
    "settings",
];

#[cfg(target_os = "macos")]
pub fn install(app: &mut App) -> tauri::Result<()> {
    use tauri::Emitter;
    use tauri::menu::{AboutMetadata, Menu, MenuItem, PredefinedMenuItem, Submenu};

    let h = app.handle();
    let sep = || PredefinedMenuItem::separator(h);

    let app_menu = Submenu::with_items(
        h,
        "Chappe",
        true,
        &[
            &PredefinedMenuItem::about(h, Some("About Chappe"), Some(AboutMetadata::default()))?,
            &sep()?,
            &MenuItem::with_id(h, "settings", "Settings…", true, Some("Cmd+,"))?,
            &sep()?,
            &PredefinedMenuItem::services(h, Some("Services"))?,
            &sep()?,
            &PredefinedMenuItem::hide(h, Some("Hide Chappe"))?,
            &PredefinedMenuItem::hide_others(h, Some("Hide Others"))?,
            &PredefinedMenuItem::show_all(h, Some("Show All"))?,
            &sep()?,
            &PredefinedMenuItem::quit(h, Some("Quit Chappe"))?,
        ],
    )?;

    let file = Submenu::with_items(
        h,
        "File",
        true,
        &[
            &MenuItem::with_id(h, "new-session", "New Session…", true, Some("Cmd+T"))?,
            &sep()?,
            &MenuItem::with_id(h, "save", "Save", true, Some("Cmd+S"))?,
            &MenuItem::with_id(h, "close-tab", "Close Tab", true, Some("Cmd+W"))?,
        ],
    )?;

    let edit = Submenu::with_items(
        h,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::copy(h, Some("Copy"))?,
            &PredefinedMenuItem::paste(h, Some("Paste"))?,
            &MenuItem::with_id(h, "select-all", "Select All", true, Some("Cmd+A"))?,
        ],
    )?;

    let view = Submenu::with_items(
        h,
        "View",
        true,
        &[
            &MenuItem::with_id(h, "toggle-files", "Show or Hide Files", true, Some("Cmd+B"))?,
            &MenuItem::with_id(
                h,
                "toggle-history",
                "Show or Hide History",
                true,
                Some("Cmd+Shift+H"),
            )?,
            &sep()?,
            &MenuItem::with_id(h, "next-tab", "Show Next Tab", true, Some("Cmd+Shift+]"))?,
            &MenuItem::with_id(
                h,
                "prev-tab",
                "Show Previous Tab",
                true,
                Some("Cmd+Shift+["),
            )?,
            &sep()?,
            &PredefinedMenuItem::fullscreen(h, Some("Enter Full Screen"))?,
        ],
    )?;

    let window = Submenu::with_items(
        h,
        "Window",
        true,
        &[
            &PredefinedMenuItem::minimize(h, Some("Minimize"))?,
            &PredefinedMenuItem::maximize(h, Some("Zoom"))?,
        ],
    )?;

    app.set_menu(Menu::with_items(
        h,
        &[&app_menu, &file, &edit, &view, &window],
    )?)?;
    app.on_menu_event(|app, event| {
        let id = event.id().as_ref();
        if FORWARDED.contains(&id) {
            let _ = app.emit("menu", id);
        }
    });
    Ok(())
}

#[cfg(not(target_os = "macos"))]
pub fn install(_app: &mut App) -> tauri::Result<()> {
    Ok(())
}
