//! Terminal sessions, local or remote, behind one API.
//!
//! The frontend only knows session ids. Output arrives on a binary channel
//! (see `output.rs`); everything else (status lines, questions for the user,
//! the end of the session) arrives as `TerminalEvent`s on a second channel.

use std::collections::HashMap;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU32, Ordering};

use serde::{Deserialize, Serialize};
use tauri::State;
use tauri::ipc::Channel;
use tokio::sync::oneshot;

pub type CmdResult<T> = Result<T, String>;

pub fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

/// What a running session must support.
pub trait Backend: Send {
    fn write(&mut self, data: &[u8]) -> anyhow::Result<()>;
    fn resize(&mut self, cols: u16, rows: u16) -> anyhow::Result<()>;
    fn close(&mut self);
    /// The shell's current folder, when the system can tell.
    fn cwd(&self) -> Option<String> {
        None
    }
}

#[derive(Serialize, Clone, Debug)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum TerminalEvent {
    /// Progress worth showing in the terminal, e.g. "Connecting to…".
    Status { message: String },
    /// The remote shell is up.
    Connected,
    /// The session needs an answer from the user before it can go on.
    Prompt { prompt_id: u32, prompt: Prompt },
    /// The session is over. `error` is set when it never got going or broke.
    Exit {
        code: Option<u32>,
        signal: Option<String>,
        error: Option<String>,
    },
}

#[derive(Serialize, Clone, Debug)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Prompt {
    /// First connection to a host whose key is not in known_hosts.
    HostKey {
        host: String,
        port: u16,
        algorithm: String,
        fingerprint: String,
    },
    Password {
        user: String,
        host: String,
        /// Set when the password can be kept in the OS credential store.
        can_remember: bool,
        /// Set when a previous attempt was refused.
        retry: bool,
    },
    Passphrase {
        key_path: String,
        retry: bool,
    },
    KeyboardInteractive {
        user: String,
        host: String,
        name: String,
        instructions: String,
        fields: Vec<PromptField>,
    },
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PromptField {
    pub label: String,
    pub echo: bool,
}

#[derive(Deserialize, Debug)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum PromptReply {
    HostKey { accept: bool },
    Secret { value: String, remember: bool },
    Answers { values: Vec<String> },
}

#[derive(Default)]
pub struct SessionManager {
    next_id: AtomicU32,
    next_prompt: AtomicU32,
    sessions: Mutex<HashMap<u32, Box<dyn Backend>>>,
    prompts: Mutex<HashMap<u32, oneshot::Sender<PromptReply>>>,
}

impl SessionManager {
    pub fn next_id(&self) -> u32 {
        self.next_id.fetch_add(1, Ordering::Relaxed) + 1
    }

    pub fn insert(&self, id: u32, backend: Box<dyn Backend>) {
        if let Ok(mut sessions) = self.sessions.lock() {
            sessions.insert(id, backend);
        }
    }

    pub fn remove(&self, id: u32) -> Option<Box<dyn Backend>> {
        self.sessions.lock().ok()?.remove(&id)
    }

    /// Asks the user something and waits for the answer. `None` means the
    /// question was dismissed or the tab went away.
    pub async fn ask(
        &self,
        events: &Channel<TerminalEvent>,
        prompt: Prompt,
    ) -> Option<PromptReply> {
        let prompt_id = self.next_prompt.fetch_add(1, Ordering::Relaxed) + 1;
        let (tx, rx) = oneshot::channel();
        self.prompts.lock().ok()?.insert(prompt_id, tx);
        if events
            .send(TerminalEvent::Prompt { prompt_id, prompt })
            .is_err()
        {
            self.prompts.lock().ok()?.remove(&prompt_id);
            return None;
        }
        rx.await.ok()
    }
}

#[tauri::command]
pub async fn terminal_write(
    state: State<'_, SessionManager>,
    id: u32,
    data: String,
    binary: Option<bool>,
) -> CmdResult<()> {
    let mut sessions = state.sessions.lock().map_err(err)?;
    let Some(session) = sessions.get_mut(&id) else {
        return Ok(());
    };
    // Legacy mouse reports carry one byte per char and are not UTF-8.
    if binary.unwrap_or(false) {
        let bytes: Vec<u8> = data.chars().map(|c| c as u32 as u8).collect();
        session.write(&bytes).map_err(err)
    } else {
        session.write(data.as_bytes()).map_err(err)
    }
}

#[tauri::command]
pub async fn terminal_resize(
    state: State<'_, SessionManager>,
    id: u32,
    cols: u16,
    rows: u16,
) -> CmdResult<()> {
    let mut sessions = state.sessions.lock().map_err(err)?;
    if let Some(session) = sessions.get_mut(&id) {
        session.resize(cols, rows).map_err(err)?;
    }
    Ok(())
}

#[tauri::command]
pub async fn terminal_close(state: State<'_, SessionManager>, id: u32) -> CmdResult<()> {
    if let Some(mut session) = state.remove(id) {
        session.close();
    }
    Ok(())
}

#[tauri::command]
pub async fn terminal_prompt_reply(
    state: State<'_, SessionManager>,
    prompt_id: u32,
    reply: Option<PromptReply>,
) -> CmdResult<()> {
    let sender = state.prompts.lock().map_err(err)?.remove(&prompt_id);
    if let (Some(sender), Some(reply)) = (sender, reply) {
        let _ = sender.send(reply);
    }
    // Dropping the sender without a reply tells the session it was dismissed.
    Ok(())
}

/// The current folder of a local shell, read from the system. Remote shells
/// report theirs through OSC 7, handled by the frontend.
#[tauri::command]
pub async fn terminal_cwd(state: State<'_, SessionManager>, id: u32) -> CmdResult<Option<String>> {
    let sessions = state.sessions.lock().map_err(err)?;
    Ok(sessions.get(&id).and_then(|s| s.cwd()))
}
