//! Files for the side panel: the local disk, or a server over SFTP.
//!
//! Remote access reuses the SSH connection of the tab (see
//! `ssh::Connections`), so browsing never asks for credentials again.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, UNIX_EPOCH};

use anyhow::{Context as _, anyhow, bail};
use russh_sftp::client::SftpSession;
use russh_sftp::protocol::{FileType, StatusCode};
use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_opener::OpenerExt;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use crate::session::CmdResult;
use crate::ssh::Connections;

/// Where the panel is looking.
#[derive(Deserialize, Clone, Copy, Debug)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum FsTarget {
    Local,
    Ssh { session_id: u32 },
}

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum EntryKind {
    Dir,
    File,
    /// A link to a folder: opens like one.
    DirLink,
    Link,
    Other,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    name: String,
    kind: EntryKind,
    size: u64,
    /// Seconds since the Unix epoch.
    modified: Option<u64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Listing {
    path: String,
    entries: Vec<Entry>,
}

/// Errors as a person would want to read them.
fn message(e: anyhow::Error) -> String {
    for cause in e.chain() {
        if let Some(russh_sftp::client::error::Error::Status(status)) =
            cause.downcast_ref::<russh_sftp::client::error::Error>()
        {
            let what = match status.status_code {
                StatusCode::NoSuchFile => "No such file or folder",
                StatusCode::PermissionDenied => "Permission denied",
                StatusCode::Failure if !status.error_message.is_empty() => {
                    return format!("{e}: {}", status.error_message);
                }
                _ => break,
            };
            return format!("{e}: {what}");
        }
        if let Some(io) = cause.downcast_ref::<std::io::Error>() {
            let what = match io.kind() {
                std::io::ErrorKind::NotFound => "No such file or folder",
                std::io::ErrorKind::PermissionDenied => "Permission denied",
                std::io::ErrorKind::AlreadyExists => "Already exists",
                _ => break,
            };
            return format!("{e}: {what}");
        }
    }
    crate::ssh::describe(&e)
}

async fn sftp(app: &AppHandle, session_id: u32) -> anyhow::Result<Arc<SftpSession>> {
    app.state::<Connections>().sftp(session_id).await
}

/// Joins remote paths, which always use forward slashes.
fn remote_join(dir: &str, name: &str) -> String {
    if dir.ends_with('/') {
        format!("{dir}{name}")
    } else {
        format!("{dir}/{name}")
    }
}

fn remote_name(path: &str) -> &str {
    path.trim_end_matches('/')
        .rsplit('/')
        .next()
        .unwrap_or(path)
}

/// `canonicalize` on Windows returns `\\?\C:\…`; nobody wants to read that.
fn display_path(path: &Path) -> String {
    let text = path.to_string_lossy();
    match text.strip_prefix(r"\\?\") {
        Some(rest) if !rest.starts_with("UNC\\") => rest.to_owned(),
        _ => text.into_owned(),
    }
}

fn unix_secs(time: std::io::Result<std::time::SystemTime>) -> Option<u64> {
    time.ok()?
        .duration_since(UNIX_EPOCH)
        .ok()
        .map(|d| d.as_secs())
}

/// Folders first, then names in a case-insensitive, number-aware order.
fn sort_entries(entries: &mut [Entry]) {
    fn natural_key(name: &str) -> Vec<(u8, u64, String)> {
        let mut key = Vec::new();
        let mut chars = name.chars().peekable();
        while let Some(&c) = chars.peek() {
            if c.is_ascii_digit() {
                let mut digits = String::new();
                while let Some(&d) = chars.peek().filter(|d| d.is_ascii_digit()) {
                    digits.push(d);
                    chars.next();
                }
                key.push((0, digits.parse().unwrap_or(u64::MAX), String::new()));
            } else {
                let mut text = String::new();
                while let Some(&t) = chars.peek().filter(|t| !t.is_ascii_digit()) {
                    text.extend(t.to_lowercase());
                    chars.next();
                }
                key.push((1, 0, text));
            }
        }
        key
    }
    let is_dir = |e: &Entry| matches!(e.kind, EntryKind::Dir | EntryKind::DirLink);
    entries.sort_by(|a, b| {
        is_dir(b)
            .cmp(&is_dir(a))
            .then_with(|| natural_key(&a.name).cmp(&natural_key(&b.name)))
    });
}

// ---------- Listing ----------

#[tauri::command]
pub async fn fs_home(app: AppHandle, target: FsTarget) -> CmdResult<String> {
    match target {
        FsTarget::Local => dirs::home_dir()
            .map(|p| display_path(&p))
            .ok_or_else(|| "No home folder.".into()),
        FsTarget::Ssh { session_id } => async {
            sftp(&app, session_id)
                .await?
                .canonicalize(".")
                .await
                .context("Couldn't find the home folder")
        }
        .await
        .map_err(message),
    }
}

#[tauri::command]
pub async fn fs_list(app: AppHandle, target: FsTarget, path: String) -> CmdResult<Listing> {
    let result = match target {
        FsTarget::Local => tauri::async_runtime::spawn_blocking(move || list_local(&path))
            .await
            .map_err(|e| anyhow!("{e}"))
            .and_then(|r| r),
        FsTarget::Ssh { session_id } => list_remote(&app, session_id, &path).await,
    };
    result.map_err(message)
}

fn list_local(path: &str) -> anyhow::Result<Listing> {
    let dir = std::fs::canonicalize(path).with_context(|| format!("Couldn't open {path}"))?;
    let mut entries = Vec::new();
    for item in std::fs::read_dir(&dir).with_context(|| format!("Couldn't open {path}"))? {
        let Ok(item) = item else { continue };
        let Ok(meta) = item.metadata() else { continue };
        let file_type = meta.file_type();
        let kind = if file_type.is_symlink() {
            match std::fs::metadata(item.path()) {
                Ok(target) if target.is_dir() => EntryKind::DirLink,
                _ => EntryKind::Link,
            }
        } else if file_type.is_dir() {
            EntryKind::Dir
        } else if file_type.is_file() {
            EntryKind::File
        } else {
            EntryKind::Other
        };
        entries.push(Entry {
            name: item.file_name().to_string_lossy().into_owned(),
            kind,
            size: if kind == EntryKind::File {
                meta.len()
            } else {
                0
            },
            modified: unix_secs(meta.modified()),
        });
    }
    sort_entries(&mut entries);
    Ok(Listing {
        path: display_path(&dir),
        entries,
    })
}

async fn list_remote(app: &AppHandle, session_id: u32, path: &str) -> anyhow::Result<Listing> {
    let sftp = sftp(app, session_id).await?;
    let dir = sftp
        .canonicalize(path)
        .await
        .with_context(|| format!("Couldn't open {path}"))?;
    let mut entries = Vec::new();
    for item in sftp
        .read_dir(dir.as_str())
        .await
        .with_context(|| format!("Couldn't open {dir}"))?
    {
        let name = item.file_name();
        if name == "." || name == ".." {
            continue;
        }
        let meta = item.metadata();
        let kind = match item.file_type() {
            FileType::Dir => EntryKind::Dir,
            FileType::File => EntryKind::File,
            FileType::Symlink => match sftp.metadata(remote_join(&dir, &name)).await {
                Ok(target) if target.is_dir() => EntryKind::DirLink,
                _ => EntryKind::Link,
            },
            FileType::Other => EntryKind::Other,
        };
        entries.push(Entry {
            name,
            kind,
            size: if kind == EntryKind::File {
                meta.len()
            } else {
                0
            },
            modified: meta.mtime.map(u64::from),
        });
    }
    sort_entries(&mut entries);
    Ok(Listing { path: dir, entries })
}

// ---------- Changes ----------

#[tauri::command]
pub async fn fs_mkdir(app: AppHandle, target: FsTarget, path: String) -> CmdResult<()> {
    let result = match target {
        FsTarget::Local => {
            std::fs::create_dir(&path).with_context(|| format!("Couldn't create {path}"))
        }
        FsTarget::Ssh { session_id } => {
            async {
                sftp(&app, session_id)
                    .await?
                    .create_dir(path.as_str())
                    .await
                    .with_context(|| format!("Couldn't create {path}"))
            }
            .await
        }
    };
    result.map_err(message)
}

#[tauri::command]
pub async fn fs_rename(
    app: AppHandle,
    target: FsTarget,
    from: String,
    to: String,
) -> CmdResult<()> {
    let result = match target {
        FsTarget::Local => {
            if Path::new(&to).exists() {
                Err(anyhow!("Couldn't rename: {to} already exists"))
            } else {
                std::fs::rename(&from, &to).context("Couldn't rename")
            }
        }
        FsTarget::Ssh { session_id } => {
            async {
                let sftp = sftp(&app, session_id).await?;
                if sftp.try_exists(to.as_str()).await.unwrap_or(false) {
                    bail!("Couldn't rename: {to} already exists");
                }
                sftp.rename(from.as_str(), to.as_str())
                    .await
                    .context("Couldn't rename")
            }
            .await
        }
    };
    result.map_err(message)
}

/// Local items go to the Trash, where they can be recovered. SFTP has no
/// trash, so remote items are deleted for good (the UI asks first).
#[tauri::command]
pub async fn fs_remove(app: AppHandle, target: FsTarget, paths: Vec<String>) -> CmdResult<()> {
    let result = match target {
        FsTarget::Local => tauri::async_runtime::spawn_blocking(move || {
            trash::delete_all(&paths).context("Couldn't move to the Trash")
        })
        .await
        .map_err(|e| anyhow!("{e}"))
        .and_then(|r| r),
        FsTarget::Ssh { session_id } => {
            async {
                let sftp = sftp(&app, session_id).await?;
                for path in &paths {
                    remove_remote(&sftp, path).await?;
                }
                Ok(())
            }
            .await
        }
    };
    result.map_err(message)
}

async fn remove_remote(sftp: &SftpSession, path: &str) -> anyhow::Result<()> {
    let meta = sftp
        .symlink_metadata(path)
        .await
        .with_context(|| format!("Couldn't delete {path}"))?;
    if meta.is_dir() {
        // Depth first; a folder must be empty before it can go.
        let mut stack = vec![(path.to_owned(), false)];
        while let Some((dir, visited)) = stack.pop() {
            if visited {
                sftp.remove_dir(dir.as_str())
                    .await
                    .with_context(|| format!("Couldn't delete {dir}"))?;
                continue;
            }
            stack.push((dir.clone(), true));
            for item in sftp
                .read_dir(dir.as_str())
                .await
                .with_context(|| format!("Couldn't open {dir}"))?
            {
                let name = item.file_name();
                if name == "." || name == ".." {
                    continue;
                }
                let child = remote_join(&dir, &name);
                if item.file_type() == FileType::Dir {
                    stack.push((child, false));
                } else {
                    sftp.remove_file(child.as_str())
                        .await
                        .with_context(|| format!("Couldn't delete {child}"))?;
                }
            }
        }
        Ok(())
    } else {
        sftp.remove_file(path)
            .await
            .with_context(|| format!("Couldn't delete {path}"))
    }
}

/// Which of these names already exist in a folder; asked before uploading.
#[tauri::command]
pub async fn fs_existing(
    app: AppHandle,
    target: FsTarget,
    dir: String,
    names: Vec<String>,
) -> CmdResult<Vec<String>> {
    let result: anyhow::Result<Vec<String>> = match target {
        FsTarget::Local => Ok(names
            .into_iter()
            .filter(|n| Path::new(&dir).join(n).exists())
            .collect()),
        FsTarget::Ssh { session_id } => {
            async {
                let sftp = sftp(&app, session_id).await?;
                let mut existing = Vec::new();
                for name in names {
                    if sftp
                        .try_exists(remote_join(&dir, &name))
                        .await
                        .unwrap_or(false)
                    {
                        existing.push(name);
                    }
                }
                Ok(existing)
            }
            .await
        }
    };
    result.map_err(message)
}

// ---------- Opening ----------

#[tauri::command]
pub async fn fs_open_local(app: AppHandle, path: String) -> CmdResult<()> {
    app.opener()
        .open_path(path, None::<&str>)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn fs_reveal_local(app: AppHandle, path: String) -> CmdResult<()> {
    app.opener()
        .reveal_item_in_dir(path)
        .map_err(|e| e.to_string())
}

/// Downloads a remote file to a temporary folder and opens it with the
/// default app. Edits stay local: nothing is uploaded back.
#[tauri::command]
pub async fn fs_open_remote(app: AppHandle, session_id: u32, path: String) -> CmdResult<()> {
    async {
        let sftp = sftp(&app, session_id).await?;
        let dir = std::env::temp_dir()
            .join(format!("chappe-{}", std::process::id()))
            .join(session_id.to_string());
        tokio::fs::create_dir_all(&dir).await?;
        let local = dir.join(remote_name(&path));
        let mut remote = sftp
            .open(path.as_str())
            .await
            .with_context(|| format!("Couldn't open {path}"))?;
        let mut file = tokio::fs::File::create(&local).await?;
        tokio::io::copy(&mut remote, &mut file)
            .await
            .context("Couldn't download the file")?;
        file.flush().await?;
        app.opener()
            .open_path(local.to_string_lossy(), None::<&str>)?;
        Ok(())
    }
    .await
    .map_err(message)
}

#[tauri::command]
pub async fn fs_downloads_dir() -> CmdResult<String> {
    dirs::download_dir()
        .or_else(dirs::home_dir)
        .map(|p| display_path(&p))
        .ok_or_else(|| "No downloads folder.".into())
}

// ---------- Editing ----------

/// Larger files open in their default app instead.
const MAX_EDIT_SIZE: u64 = 5 * 1024 * 1024;
/// Returned instead of saving when the file changed since it was read.
const CONFLICT: &str = "CONFLICT";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextFile {
    content: String,
    /// The file started with a UTF-8 byte order mark; it is kept on save.
    bom: bool,
    modified: Option<u64>,
    size: u64,
}

/// The file as last seen: modification time (to the second) and size.
/// Either changing means someone else wrote it.
#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Stamp {
    modified: Option<u64>,
    size: u64,
}

fn decode_text(bytes: Vec<u8>) -> anyhow::Result<(String, bool)> {
    // A NUL byte early on means a binary file.
    if bytes.iter().take(8192).any(|b| *b == 0) {
        bail!("This looks like a binary file. Use “Open with default app” instead");
    }
    let (bytes, bom) = match bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]) {
        Some(rest) => (rest.to_vec(), true),
        None => (bytes, false),
    };
    let text = String::from_utf8(bytes).map_err(|_| {
        anyhow!(
            "This file isn't UTF-8 text, the only encoding the editor handles for now. \
             Use “Open with default app” instead"
        )
    })?;
    Ok((text, bom))
}

fn too_big(size: u64) -> anyhow::Error {
    anyhow!(
        "This file is {:.1} MB, and the editor opens files up to {} MB. Use “Open with default app” instead",
        size as f64 / 1_048_576.0,
        MAX_EDIT_SIZE / 1_048_576
    )
}

#[tauri::command]
pub async fn fs_read_text(app: AppHandle, target: FsTarget, path: String) -> CmdResult<TextFile> {
    async {
        let (bytes, stamp) = match target {
            FsTarget::Local => {
                let meta = tokio::fs::metadata(&path)
                    .await
                    .with_context(|| format!("Couldn't open {path}"))?;
                if meta.len() > MAX_EDIT_SIZE {
                    return Err(too_big(meta.len()));
                }
                let bytes = tokio::fs::read(&path)
                    .await
                    .with_context(|| format!("Couldn't read {path}"))?;
                let stamp = Stamp {
                    modified: unix_secs(meta.modified()),
                    size: meta.len(),
                };
                (bytes, stamp)
            }
            FsTarget::Ssh { session_id } => {
                let sftp = sftp(&app, session_id).await?;
                let meta = sftp
                    .metadata(path.as_str())
                    .await
                    .with_context(|| format!("Couldn't open {path}"))?;
                if meta.len() > MAX_EDIT_SIZE {
                    return Err(too_big(meta.len()));
                }
                let bytes = sftp
                    .read(path.as_str())
                    .await
                    .with_context(|| format!("Couldn't read {path}"))?;
                let stamp = Stamp {
                    modified: meta.mtime.map(u64::from),
                    size: meta.len(),
                };
                (bytes, stamp)
            }
        };
        let (content, bom) = decode_text(bytes)?;
        Ok(TextFile {
            content,
            bom,
            modified: stamp.modified,
            size: stamp.size,
        })
    }
    .await
    .map_err(message)
}

async fn local_stamp(path: &str) -> Option<Stamp> {
    let meta = tokio::fs::metadata(path).await.ok()?;
    Some(Stamp {
        modified: unix_secs(meta.modified()),
        size: meta.len(),
    })
}

async fn remote_stamp(sftp: &SftpSession, path: &str) -> Option<Stamp> {
    let meta = sftp.metadata(path).await.ok()?;
    Some(Stamp {
        modified: meta.mtime.map(u64::from),
        size: meta.len(),
    })
}

/// Saves a file. With `expected`, refuses (with "CONFLICT") when the file
/// changed since it was read, so the UI can ask before overwriting. A file
/// deleted meanwhile is simply written again.
#[tauri::command]
pub async fn fs_write_text(
    app: AppHandle,
    target: FsTarget,
    path: String,
    content: String,
    bom: bool,
    expected: Option<Stamp>,
) -> CmdResult<Stamp> {
    let mut bytes = Vec::with_capacity(content.len() + 3);
    if bom {
        bytes.extend_from_slice(&[0xEF, 0xBB, 0xBF]);
    }
    bytes.extend_from_slice(content.as_bytes());

    let result: anyhow::Result<Stamp> = async {
        match target {
            FsTarget::Local => {
                if let Some(expected) = expected
                    && local_stamp(&path)
                        .await
                        .is_some_and(|current| current != expected)
                {
                    bail!(CONFLICT);
                }
                // Writing in place keeps the file's permissions, owner and links.
                tokio::fs::write(&path, &bytes)
                    .await
                    .with_context(|| format!("Couldn't save {path}"))?;
                Ok(local_stamp(&path).await.unwrap_or(Stamp {
                    modified: None,
                    size: bytes.len() as u64,
                }))
            }
            FsTarget::Ssh { session_id } => {
                let sftp = sftp(&app, session_id).await?;
                if let Some(expected) = expected
                    && remote_stamp(&sftp, &path)
                        .await
                        .is_some_and(|current| current != expected)
                {
                    bail!(CONFLICT);
                }
                // `create` truncates; SftpSession::write would leave the old tail
                // of a file that got shorter.
                let mut file = sftp
                    .create(path.as_str())
                    .await
                    .with_context(|| format!("Couldn't save {path}"))?;
                file.write_all(&bytes)
                    .await
                    .with_context(|| format!("Couldn't save {path}"))?;
                file.shutdown()
                    .await
                    .with_context(|| format!("Couldn't save {path}"))?;
                Ok(remote_stamp(&sftp, &path).await.unwrap_or(Stamp {
                    modified: None,
                    size: bytes.len() as u64,
                }))
            }
        }
    }
    .await;
    result.map_err(|e| {
        if e.to_string() == CONFLICT {
            CONFLICT.to_owned()
        } else {
            message(e)
        }
    })
}

// ---------- Transfers ----------

#[derive(Default)]
pub struct Transfers {
    next_id: AtomicU32,
    cancels: Mutex<HashMap<u32, Arc<AtomicBool>>>,
}

#[derive(Serialize, Clone)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum TransferEvent {
    Started {
        total_bytes: u64,
        total_files: u32,
    },
    Progress {
        done_bytes: u64,
        done_files: u32,
        current: String,
    },
    Finished,
    Failed {
        message: String,
    },
    Cancelled,
}

/// One file to copy, and the folders to create first.
struct Plan {
    dirs: Vec<String>,
    files: Vec<(String, String, u64)>,
}

impl Plan {
    fn total(&self) -> u64 {
        self.files.iter().map(|f| f.2).sum()
    }
}

#[tauri::command]
pub async fn transfer_cancel(state: State<'_, Transfers>, id: u32) -> CmdResult<()> {
    if let Some(flag) = state.cancels.lock().map_err(|e| e.to_string())?.get(&id) {
        flag.store(true, Ordering::Relaxed);
    }
    Ok(())
}

fn start_transfer(
    app: &AppHandle,
    events: Channel<TransferEvent>,
    work: impl FnOnce(
        Arc<AtomicBool>,
        Channel<TransferEvent>,
    ) -> tokio::task::JoinHandle<anyhow::Result<()>>,
) -> u32 {
    let transfers = app.state::<Transfers>();
    let id = transfers.next_id.fetch_add(1, Ordering::Relaxed) + 1;
    let cancel = Arc::new(AtomicBool::new(false));
    if let Ok(mut cancels) = transfers.cancels.lock() {
        cancels.insert(id, cancel.clone());
    }
    let handle = work(cancel.clone(), events.clone());
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let outcome = handle.await.map_err(|e| anyhow!("{e}")).and_then(|r| r);
        let event = match outcome {
            Ok(()) => TransferEvent::Finished,
            Err(_) if cancel.load(Ordering::Relaxed) => TransferEvent::Cancelled,
            Err(e) => TransferEvent::Failed {
                message: message(e),
            },
        };
        let _ = events.send(event);
        if let Ok(mut cancels) = app.state::<Transfers>().cancels.lock() {
            cancels.remove(&id);
        }
    });
    id
}

/// Reports progress at most every 100 ms.
struct Reporter {
    events: Channel<TransferEvent>,
    done_bytes: u64,
    done_files: u32,
    last: Instant,
}

impl Reporter {
    fn new(events: Channel<TransferEvent>, plan: &Plan) -> Self {
        let _ = events.send(TransferEvent::Started {
            total_bytes: plan.total(),
            total_files: plan.files.len() as u32,
        });
        Self {
            events,
            done_bytes: 0,
            done_files: 0,
            last: Instant::now(),
        }
    }

    fn add(&mut self, bytes: u64, current: &str) {
        self.done_bytes += bytes;
        if self.last.elapsed() >= Duration::from_millis(100) {
            self.last = Instant::now();
            self.send(current);
        }
    }

    fn file_done(&mut self, current: &str) {
        self.done_files += 1;
        self.send(current);
    }

    fn send(&self, current: &str) {
        let _ = self.events.send(TransferEvent::Progress {
            done_bytes: self.done_bytes,
            done_files: self.done_files,
            current: current.to_owned(),
        });
    }
}

async fn copy<R, W>(
    mut from: R,
    mut to: W,
    name: &str,
    cancel: &AtomicBool,
    report: &mut Reporter,
) -> anyhow::Result<()>
where
    R: tokio::io::AsyncRead + Unpin,
    W: tokio::io::AsyncWrite + Unpin,
{
    let mut buf = vec![0u8; 256 * 1024];
    loop {
        if cancel.load(Ordering::Relaxed) {
            bail!("Cancelled");
        }
        let n = from.read(&mut buf).await?;
        if n == 0 {
            break;
        }
        to.write_all(&buf[..n]).await?;
        report.add(n as u64, name);
    }
    to.shutdown().await?;
    Ok(())
}

/// A name that doesn't exist yet in `dir`: "report.pdf", then "report (1).pdf"…
fn free_local_name(dir: &Path, name: &str) -> PathBuf {
    let candidate = dir.join(name);
    if !candidate.exists() {
        return candidate;
    }
    let (stem, ext) = match name.rsplit_once('.') {
        Some((stem, ext)) if !stem.is_empty() => (stem, format!(".{ext}")),
        _ => (name, String::new()),
    };
    (1..)
        .map(|n| dir.join(format!("{stem} ({n}){ext}")))
        .find(|p| !p.exists())
        .unwrap_or(candidate)
}

/// Downloads files and folders into `local_dir`. Existing names are kept:
/// the new copy gets a " (1)" suffix, like a browser does.
#[tauri::command]
pub async fn transfer_download(
    app: AppHandle,
    session_id: u32,
    remote_paths: Vec<String>,
    local_dir: String,
    on_event: Channel<TransferEvent>,
) -> CmdResult<u32> {
    let task_app = app.clone();
    Ok(start_transfer(&app, on_event, move |cancel, events| {
        tokio::spawn(async move {
            let sftp = sftp(&task_app, session_id).await?;
            let local_dir = PathBuf::from(local_dir);
            let mut plan = Plan {
                dirs: Vec::new(),
                files: Vec::new(),
            };
            for remote in &remote_paths {
                let local = free_local_name(&local_dir, remote_name(remote));
                plan_download(&sftp, remote, &local, &mut plan).await?;
            }
            let mut report = Reporter::new(events, &plan);
            for dir in &plan.dirs {
                tokio::fs::create_dir_all(dir)
                    .await
                    .with_context(|| format!("Couldn't create {dir}"))?;
            }
            for (remote, local, _) in &plan.files {
                let name = remote_name(remote);
                let from = sftp
                    .open(remote.as_str())
                    .await
                    .with_context(|| format!("Couldn't open {remote}"))?;
                let to = tokio::fs::File::create(local)
                    .await
                    .with_context(|| format!("Couldn't write {local}"))?;
                copy(from, to, name, &cancel, &mut report)
                    .await
                    .with_context(|| format!("Couldn't download {name}"))?;
                report.file_done(name);
            }
            Ok(())
        })
    }))
}

async fn plan_download(
    sftp: &SftpSession,
    remote: &str,
    local: &Path,
    plan: &mut Plan,
) -> anyhow::Result<()> {
    let meta = sftp
        .metadata(remote)
        .await
        .with_context(|| format!("Couldn't read {remote}"))?;
    if !meta.is_dir() {
        plan.files.push((
            remote.to_owned(),
            local.to_string_lossy().into_owned(),
            meta.len(),
        ));
        return Ok(());
    }
    let mut stack = vec![(remote.to_owned(), local.to_path_buf())];
    while let Some((dir, local_dir)) = stack.pop() {
        plan.dirs.push(local_dir.to_string_lossy().into_owned());
        for item in sftp
            .read_dir(dir.as_str())
            .await
            .with_context(|| format!("Couldn't open {dir}"))?
        {
            let name = item.file_name();
            if name == "." || name == ".." {
                continue;
            }
            let child = remote_join(&dir, &name);
            match item.file_type() {
                FileType::Dir => stack.push((child, local_dir.join(&name))),
                FileType::File => plan.files.push((
                    child,
                    local_dir.join(&name).to_string_lossy().into_owned(),
                    item.metadata().len(),
                )),
                // Links inside folders are skipped: following them can loop.
                _ => {}
            }
        }
    }
    Ok(())
}

/// Uploads files and folders into `remote_dir`, replacing what is there.
/// The UI checks for existing names first and asks.
#[tauri::command]
pub async fn transfer_upload(
    app: AppHandle,
    session_id: u32,
    local_paths: Vec<String>,
    remote_dir: String,
    on_event: Channel<TransferEvent>,
) -> CmdResult<u32> {
    let task_app = app.clone();
    Ok(start_transfer(&app, on_event, move |cancel, events| {
        tokio::spawn(async move {
            let sftp = sftp(&task_app, session_id).await?;
            let plan = tauri::async_runtime::spawn_blocking(move || {
                plan_upload(&local_paths, &remote_dir)
            })
            .await
            .map_err(|e| anyhow!("{e}"))??;
            let mut report = Reporter::new(events, &plan);
            for dir in &plan.dirs {
                // Already there is fine: uploads merge into existing folders.
                if !sftp.try_exists(dir.as_str()).await.unwrap_or(false) {
                    sftp.create_dir(dir.as_str())
                        .await
                        .with_context(|| format!("Couldn't create {dir}"))?;
                }
            }
            for (local, remote, _) in &plan.files {
                let name = remote_name(remote);
                let from = tokio::fs::File::open(local)
                    .await
                    .with_context(|| format!("Couldn't read {local}"))?;
                let to = sftp
                    .create(remote.as_str())
                    .await
                    .with_context(|| format!("Couldn't write {remote}"))?;
                copy(from, to, name, &cancel, &mut report)
                    .await
                    .with_context(|| format!("Couldn't upload {name}"))?;
                report.file_done(name);
            }
            Ok(())
        })
    }))
}

fn plan_upload(local_paths: &[String], remote_dir: &str) -> anyhow::Result<Plan> {
    let mut plan = Plan {
        dirs: Vec::new(),
        files: Vec::new(),
    };
    for local in local_paths {
        let path = PathBuf::from(local);
        let name = path
            .file_name()
            .ok_or_else(|| anyhow!("Can't upload {local}"))?
            .to_string_lossy()
            .into_owned();
        let remote = remote_join(remote_dir, &name);
        let meta = std::fs::metadata(&path).with_context(|| format!("Couldn't read {local}"))?;
        if !meta.is_dir() {
            plan.files.push((local.clone(), remote, meta.len()));
            continue;
        }
        let mut stack = vec![(path, remote)];
        while let Some((dir, remote_dir)) = stack.pop() {
            plan.dirs.push(remote_dir.clone());
            for item in std::fs::read_dir(&dir)
                .with_context(|| format!("Couldn't open {}", dir.display()))?
            {
                let item = item?;
                let name = item.file_name().to_string_lossy().into_owned();
                let file_type = item.file_type()?;
                let child_remote = remote_join(&remote_dir, &name);
                if file_type.is_dir() {
                    stack.push((item.path(), child_remote));
                } else if file_type.is_file() {
                    let size = item.metadata().map(|m| m.len()).unwrap_or(0);
                    plan.files.push((
                        item.path().to_string_lossy().into_owned(),
                        child_remote,
                        size,
                    ));
                }
            }
        }
    }
    Ok(plan)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(name: &str, kind: EntryKind) -> Entry {
        Entry {
            name: name.into(),
            kind,
            size: 0,
            modified: None,
        }
    }

    #[test]
    fn folders_first_then_natural_order() {
        let mut list = vec![
            entry("file10.txt", EntryKind::File),
            entry("b", EntryKind::Dir),
            entry("File2.txt", EntryKind::File),
            entry("A", EntryKind::DirLink),
        ];
        sort_entries(&mut list);
        let names: Vec<&str> = list.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, ["A", "b", "File2.txt", "file10.txt"]);
    }

    #[test]
    fn remote_paths() {
        assert_eq!(remote_join("/", "etc"), "/etc");
        assert_eq!(remote_join("/home/pi", "a b"), "/home/pi/a b");
        assert_eq!(remote_name("/var/log/"), "log");
        assert_eq!(remote_name("/var/log/syslog"), "syslog");
    }

    #[test]
    fn free_names() {
        let dir = std::env::temp_dir().join(format!("chappe-names-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("report.pdf"), b"x").unwrap();
        std::fs::write(dir.join("report (1).pdf"), b"x").unwrap();
        assert_eq!(
            free_local_name(&dir, "report.pdf"),
            dir.join("report (2).pdf")
        );
        assert_eq!(free_local_name(&dir, "notes"), dir.join("notes"));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn text_decoding() {
        assert_eq!(
            decode_text(b"hello\n".to_vec()).unwrap(),
            ("hello\n".into(), false)
        );
        assert_eq!(
            decode_text(b"\xEF\xBB\xBFbom".to_vec()).unwrap(),
            ("bom".into(), true)
        );
        assert!(decode_text(b"PK\x03\x04\x00\x00".to_vec()).is_err());
        assert!(decode_text(vec![0xC3, 0x28]).is_err());
        assert_eq!(decode_text("é ✓".as_bytes().to_vec()).unwrap().0, "é ✓");
    }

    #[test]
    fn windows_verbatim_prefix_is_hidden() {
        assert_eq!(display_path(Path::new(r"\\?\C:\Users\me")), r"C:\Users\me");
        assert_eq!(display_path(Path::new("/home/me")), "/home/me");
    }
}
