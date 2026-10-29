//! SSH sessions with russh.
//!
//! A session runs as one tokio task: it connects (through jump hosts if
//! any), authenticates, opens a shell, then shuttles bytes until either side
//! closes. Questions for the user (unknown host key, password, passphrase)
//! go to the frontend as prompts and the task waits for the answer.

mod known_hosts;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::{Context as _, anyhow, bail};
use russh::client::{self, Handle, KeyboardInteractiveAuthResponse};
use russh::keys::agent::AgentIdentity;
use russh::keys::agent::client::AgentClient;
use russh::keys::{
    HashAlg, PrivateKeyWithHashAlg, PublicKey, PublicKeyOrCertificate, load_secret_key,
};
use russh::{ChannelMsg, Disconnect, MethodKind, MethodSet};
use russh_sftp::client::SftpSession;
use serde::Serialize;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Manager, State};
use tokio::net::TcpStream;
use tokio::sync::mpsc;

use crate::local::system_lang;
use crate::output::{OutputSender, spawn_pump};
use crate::servers::{
    AuthMethod, CONFIG_PREFIX, Server, ServerStore, expand_tilde, keychain_get, keychain_set,
    ssh_dir,
};
use crate::session::{
    Backend, CmdResult, Prompt, PromptField, PromptReply, SessionManager, TerminalEvent, err,
};
use known_hosts::HostKeyStatus;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
/// Agent keys tried before moving on. Servers usually allow six attempts
/// in total (`MaxAuthTries`), and passwords need some of them.
const MAX_AGENT_KEYS: usize = 5;
const MAX_SECRET_ATTEMPTS: usize = 3;
const MAX_JUMP_DEPTH: usize = 5;

// ---------- Targets ----------

/// Everything needed to reach one host.
#[derive(Clone, Debug)]
struct Target {
    label: String,
    host: String,
    port: u16,
    user: String,
    auth: AuthMethod,
    key_files: Vec<PathBuf>,
    /// Credential store id, for servers from the book.
    secret_id: Option<String>,
    has_password: bool,
    jump: Option<Box<Target>>,
}

impl Target {
    fn address(&self) -> String {
        if self.port == 22 {
            format!("{}@{}", self.user, self.host)
        } else {
            format!("{}@{}:{}", self.user, self.host, self.port)
        }
    }
}

fn local_user() -> String {
    std::env::var("USER")
        .or_else(|_| std::env::var("USERNAME"))
        .unwrap_or_else(|_| "root".into())
}

fn target_from(server: &Server, has_password: bool) -> Target {
    Target {
        label: server.name.clone(),
        host: server.host.clone(),
        port: server.port,
        user: server.user.clone().unwrap_or_else(local_user),
        auth: server.auth,
        key_files: server.key_path.iter().map(|k| expand_tilde(k)).collect(),
        secret_id: Some(server.id.clone()),
        has_password,
        jump: None,
    }
}

/// Resolves a server id, or a jump specification as found in `ProxyJump`:
/// a comma-separated list of `[user@]host[:port]` or `~/.ssh/config` aliases.
fn resolve(store: &ServerStore, spec: &str, depth: usize) -> anyhow::Result<Target> {
    if depth > MAX_JUMP_DEPTH {
        bail!("The jump host chain is too long, or loops back on itself.");
    }

    if let Some(entry) = store.find(spec) {
        let mut target = target_from(&entry.server, entry.has_password);
        if let Some(jump) = entry.server.jump.as_deref() {
            target.jump = Some(Box::new(resolve(store, jump, depth + 1)?));
        }
        return Ok(target);
    }

    // "a,b" means: reach a, from a reach b, from b reach the target.
    let hops: Vec<&str> = spec
        .split(',')
        .map(str::trim)
        .filter(|h| !h.is_empty())
        .collect();
    if hops.len() > 1 {
        let mut chain: Option<Target> = None;
        for hop in hops {
            let mut target = resolve(store, hop, depth + 1)?;
            if let Some(previous) = chain.take() {
                target.jump = Some(Box::new(previous));
            }
            chain = Some(target);
        }
        return chain.ok_or_else(|| anyhow!("Empty jump host."));
    }

    let alias = format!("{CONFIG_PREFIX}{spec}");
    if store.find(&alias).is_some() {
        return resolve(store, &alias, depth);
    }

    // A bare [user@]host[:port].
    let (user, rest) = match spec.rsplit_once('@') {
        Some((u, r)) => (Some(u.to_owned()), r),
        None => (None, spec),
    };
    let (host, port) = match rest.rsplit_once(':') {
        Some((h, p)) if !h.contains(':') => (h, p.parse().context("Invalid port in jump host")?),
        _ => (rest, 22),
    };
    let host = host
        .trim_start_matches('[')
        .trim_end_matches(']')
        .to_owned();
    if host.is_empty() {
        bail!("Unknown server.");
    }
    Ok(Target {
        label: host.clone(),
        host,
        port,
        user: user.unwrap_or_else(local_user),
        auth: AuthMethod::Auto,
        key_files: Vec::new(),
        secret_id: None,
        has_password: false,
        jump: None,
    })
}

// ---------- Session plumbing ----------

enum Command {
    Data(Vec<u8>),
    Resize(u16, u16),
    Close,
}

struct SshBackend {
    id: u32,
    app: AppHandle,
    commands: mpsc::UnboundedSender<Command>,
    size: Arc<Mutex<(u16, u16)>>,
    task: tokio::task::AbortHandle,
}

impl Backend for SshBackend {
    fn write(&mut self, data: &[u8]) -> anyhow::Result<()> {
        // Typed before the shell is up: queued and sent once it is.
        let _ = self.commands.send(Command::Data(data.to_vec()));
        Ok(())
    }

    fn resize(&mut self, cols: u16, rows: u16) -> anyhow::Result<()> {
        if let Ok(mut size) = self.size.lock() {
            *size = (cols, rows);
        }
        let _ = self.commands.send(Command::Resize(cols, rows));
        Ok(())
    }

    fn close(&mut self) {
        let _ = self.commands.send(Command::Close);
        // A session stuck connecting or waiting on a prompt never reads its
        // commands; don't let it linger.
        let task = self.task.clone();
        let (app, id) = (self.app.clone(), self.id);
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(Duration::from_secs(2)).await;
            task.abort();
            // An aborted task never gets to release its connection.
            app.state::<Connections>().remove(id).await;
        });
    }
}

struct Ctx {
    app: AppHandle,
    events: Channel<TerminalEvent>,
}

impl Ctx {
    fn status(&self, message: impl Into<String>) {
        let _ = self.events.send(TerminalEvent::Status {
            message: message.into(),
        });
    }

    async fn ask(&self, prompt: Prompt) -> Option<PromptReply> {
        self.app
            .state::<SessionManager>()
            .ask(&self.events, prompt)
            .await
    }

    fn store(&self) -> State<'_, ServerStore> {
        self.app.state::<ServerStore>()
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshInfo {
    id: u32,
    label: String,
    address: String,
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn ssh_connect(
    app: AppHandle,
    state: State<'_, SessionManager>,
    store: State<'_, ServerStore>,
    server_id: String,
    cols: u16,
    rows: u16,
    on_data: Channel<InvokeResponseBody>,
    on_event: Channel<TerminalEvent>,
) -> CmdResult<SshInfo> {
    let target = resolve(&store, &server_id, 0).map_err(err)?;
    let info = SshInfo {
        id: state.next_id(),
        label: target.label.clone(),
        address: target.address(),
    };
    let id = info.id;

    let (commands, command_rx) = mpsc::unbounded_channel();
    let size = Arc::new(Mutex::new((cols, rows)));
    let pump = spawn_pump(format!("ssh-{id}-out"), on_data).map_err(err)?;

    let ctx = Ctx {
        app: app.clone(),
        events: on_event,
    };
    let task_size = size.clone();
    let task = tokio::spawn(async move {
        let outcome = run_shell(&ctx, id, &target, command_rx, task_size, pump.sender).await;
        ctx.app.state::<Connections>().remove(id).await;
        // Let the last bytes reach the screen before announcing the end.
        let _ = tokio::time::timeout(Duration::from_millis(500), pump.drained).await;
        let event = match outcome {
            Ok((code, signal)) => TerminalEvent::Exit {
                code,
                signal,
                error: None,
            },
            Err(e) => TerminalEvent::Exit {
                code: None,
                signal: None,
                error: Some(describe(&e)),
            },
        };
        let _ = ctx.events.send(event);
        ctx.app.state::<SessionManager>().remove(id);
    });

    state.insert(
        id,
        Box::new(SshBackend {
            id,
            app: app.clone(),
            commands,
            size,
            task: task.abort_handle(),
        }),
    );
    Ok(info)
}

/// One readable sentence for an error chain, without OS error numbers.
pub fn describe(e: &anyhow::Error) -> String {
    let mut message = e.to_string();
    for cause in e.chain().skip(1) {
        let cause = cause.to_string();
        if !message.contains(&cause) {
            message = format!("{message}: {cause}");
        }
    }
    while let Some(start) = message.find(" (os error ") {
        let end = message[start..]
            .find(')')
            .map_or(message.len(), |i| start + i + 1);
        message.replace_range(start..end, "");
    }
    message
}

/// A path as the user would write it, with `~` for the home directory.
fn tilde(path: &Path) -> String {
    match dirs::home_dir().and_then(|home| path.strip_prefix(home).ok().map(Path::to_path_buf)) {
        Some(rest) => format!("~/{}", rest.display()),
        None => path.display().to_string(),
    }
}

async fn run_shell(
    ctx: &Ctx,
    id: u32,
    target: &Target,
    mut commands: mpsc::UnboundedReceiver<Command>,
    size: Arc<Mutex<(u16, u16)>>,
    output: OutputSender,
) -> anyhow::Result<(Option<u32>, Option<String>)> {
    let (handle, _jumps) = Box::pin(open(ctx, target, 0)).await?;
    let handle = Arc::new(handle);
    // The file panel opens its SFTP channel on this same connection.
    ctx.app
        .state::<Connections>()
        .insert(id, handle.clone())
        .await;

    let mut channel = handle
        .channel_open_session()
        .await
        .context("Couldn't open a session")?;
    let (cols, rows) = size.lock().map(|s| *s).unwrap_or((80, 24));
    channel
        .request_pty(false, "xterm-256color", cols.into(), rows.into(), 0, 0, &[])
        .await
        .context("The server refused a terminal")?;
    // Most servers only accept these if configured to (AcceptEnv); harmless otherwise.
    let _ = channel.set_env(false, "LANG", system_lang()).await;
    let _ = channel.set_env(false, "COLORTERM", "truecolor").await;
    channel
        .request_shell(true)
        .await
        .context("The server refused a shell")?;
    let _ = ctx.events.send(TerminalEvent::Connected);

    let (mut code, mut signal) = (None, None);
    let mut closed_by_us = false;
    loop {
        tokio::select! {
            command = commands.recv() => match command {
                Some(Command::Data(data)) => channel.data_bytes(data).await?,
                Some(Command::Resize(cols, rows)) => {
                    channel.window_change(cols.into(), rows.into(), 0, 0).await?
                }
                Some(Command::Close) | None => {
                    closed_by_us = true;
                    let _ = channel.close().await;
                    break;
                }
            },
            message = channel.wait() => match message {
                Some(ChannelMsg::Data { data }) | Some(ChannelMsg::ExtendedData { data, .. }) => {
                    let _ = output.send(data.to_vec());
                }
                Some(ChannelMsg::ExitStatus { exit_status }) => code = Some(exit_status),
                Some(ChannelMsg::ExitSignal { signal_name, .. }) => {
                    signal = Some(format!("{signal_name:?}"))
                }
                Some(ChannelMsg::Close) | None => break,
                _ => {}
            },
        }
    }
    let _ = handle.disconnect(Disconnect::ByApplication, "", "en").await;

    if code.is_none() && signal.is_none() && !closed_by_us {
        bail!("The connection to {} was lost.", target.host);
    }
    Ok((code, signal))
}

// ---------- Connecting ----------

struct Client {
    app: AppHandle,
    events: Channel<TerminalEvent>,
    host: String,
    port: u16,
}

impl client::Handler for Client {
    type Error = anyhow::Error;

    async fn check_server_key(
        &mut self,
        server_key: &PublicKeyOrCertificate,
    ) -> Result<bool, Self::Error> {
        let key: PublicKey = match server_key {
            PublicKeyOrCertificate::PublicKey { key, .. } => key.clone(),
            PublicKeyOrCertificate::Certificate(cert) => PublicKey::from(cert.public_key().clone()),
        };
        match known_hosts::check(&self.host, self.port, &key) {
            HostKeyStatus::Trusted => Ok(true),
            HostKeyStatus::Revoked => bail!("The host key of {} has been revoked.", self.host),
            HostKeyStatus::Changed { path, line } => bail!(
                "The host key of {host} has changed. Someone could be intercepting the \
                 connection, or the server was reinstalled. If you know why it changed, \
                 remove the old key (line {line} of {path}) with: ssh-keygen -R {name}",
                host = self.host,
                path = tilde(&path),
                name = if self.port == 22 {
                    self.host.clone()
                } else {
                    format!("'[{}]:{}'", self.host, self.port)
                },
            ),
            HostKeyStatus::Unknown => {
                let prompt = Prompt::HostKey {
                    host: self.host.clone(),
                    port: self.port,
                    algorithm: key.algorithm().as_str().to_owned(),
                    fingerprint: key.fingerprint(HashAlg::Sha256).to_string(),
                };
                let manager = self.app.state::<SessionManager>();
                match manager.ask(&self.events, prompt).await {
                    Some(PromptReply::HostKey { accept: true }) => {
                        if let Err(e) = known_hosts::learn(&self.host, self.port, &key) {
                            let _ = self.events.send(TerminalEvent::Status {
                                message: format!("Couldn't save the host key to known_hosts: {e}"),
                            });
                        }
                        Ok(true)
                    }
                    _ => bail!("Connection cancelled: the host key was not trusted."),
                }
            }
        }
    }
}

type Session = Handle<Client>;

/// Live SSH connections by session id, and the SFTP session opened on each
/// one the first time the file panel needs it.
#[derive(Default)]
pub struct Connections {
    inner: tokio::sync::Mutex<HashMap<u32, Connection>>,
}

struct Connection {
    handle: Arc<Session>,
    sftp: Option<Arc<SftpSession>>,
}

impl Connections {
    async fn insert(&self, id: u32, handle: Arc<Session>) {
        self.inner
            .lock()
            .await
            .insert(id, Connection { handle, sftp: None });
    }

    async fn remove(&self, id: u32) {
        if let Some(Connection {
            sftp: Some(sftp), ..
        }) = self.inner.lock().await.remove(&id)
        {
            let _ = sftp.close().await;
        }
    }

    /// Runs a command on a tab's server, next to its shell, and returns
    /// its output (stdout only, at most `limit` bytes).
    pub async fn exec(&self, id: u32, command: &str, limit: usize) -> anyhow::Result<Vec<u8>> {
        let handle = self
            .inner
            .lock()
            .await
            .get(&id)
            .map(|c| c.handle.clone())
            .ok_or_else(|| anyhow!("This tab is not connected."))?;
        let mut channel = handle
            .channel_open_session()
            .await
            .context("Couldn't open a channel")?;
        channel.exec(true, command).await?;
        let mut output = Vec::new();
        while let Some(message) = channel.wait().await {
            match message {
                ChannelMsg::Data { data } => {
                    output.extend_from_slice(&data);
                    if output.len() >= limit {
                        output.truncate(limit);
                        break;
                    }
                }
                ChannelMsg::Eof | ChannelMsg::Close => break,
                _ => {}
            }
        }
        let _ = channel.close().await;
        Ok(output)
    }

    /// The SFTP session of a connected tab, opened on first use.
    pub async fn sftp(&self, id: u32) -> anyhow::Result<Arc<SftpSession>> {
        let mut inner = self.inner.lock().await;
        let connection = inner
            .get_mut(&id)
            .ok_or_else(|| anyhow!("This tab is not connected."))?;
        if let Some(sftp) = &connection.sftp {
            return Ok(sftp.clone());
        }
        let channel = connection
            .handle
            .channel_open_session()
            .await
            .context("Couldn't open a channel for file transfer")?;
        channel
            .request_subsystem(true, "sftp")
            .await
            .context("The server doesn't offer SFTP")?;
        let sftp = Arc::new(
            SftpSession::new(channel.into_stream())
                .await
                .context("Couldn't start SFTP")?,
        );
        connection.sftp = Some(sftp.clone());
        Ok(sftp)
    }
}

fn client_config() -> Arc<client::Config> {
    Arc::new(client::Config {
        inactivity_timeout: None,
        keepalive_interval: Some(Duration::from_secs(30)),
        keepalive_max: 3,
        nodelay: true,
        ..Default::default()
    })
}

/// Connects and authenticates, hopping through jump hosts first. Returns
/// the session plus the jump sessions, which must outlive it.
async fn open(ctx: &Ctx, target: &Target, depth: usize) -> anyhow::Result<(Session, Vec<Session>)> {
    let handler = Client {
        app: ctx.app.clone(),
        events: ctx.events.clone(),
        host: target.host.clone(),
        port: target.port,
    };

    let (mut session, jumps) = match &target.jump {
        Some(jump) => {
            ctx.status(format!("Connecting to jump host {}…", jump.label));
            let (jump_session, mut jumps) = Box::pin(open(ctx, jump, depth + 1)).await?;
            ctx.status(format!(
                "Opening a tunnel to {}:{}…",
                target.host, target.port
            ));
            let tunnel = jump_session
                .channel_open_direct_tcpip(target.host.clone(), target.port.into(), "127.0.0.1", 0)
                .await
                .with_context(|| {
                    format!(
                        "{} couldn't reach {}:{}",
                        jump.label, target.host, target.port
                    )
                })?;
            let session =
                client::connect_stream(client_config(), tunnel.into_stream(), handler).await?;
            jumps.push(jump_session);
            (session, jumps)
        }
        None => {
            if depth == 0 {
                ctx.status(format!("Connecting to {}…", target.address()));
            }
            let tcp = tokio::time::timeout(
                CONNECT_TIMEOUT,
                TcpStream::connect((target.host.as_str(), target.port)),
            )
            .await
            .map_err(|_| {
                anyhow!(
                    "{}:{} did not answer within {} seconds.",
                    target.host,
                    target.port,
                    CONNECT_TIMEOUT.as_secs()
                )
            })?
            .with_context(|| format!("Couldn't reach {}:{}", target.host, target.port))?;
            let _ = tcp.set_nodelay(true);
            (
                client::connect_stream(client_config(), tcp, handler).await?,
                Vec::new(),
            )
        }
    };

    authenticate(ctx, &mut session, target).await?;
    Ok((session, jumps))
}

// ---------- Authentication ----------

enum Outcome {
    Success,
    /// Not accepted; carries the methods the server still offers, if known.
    Failed(Option<MethodSet>),
}

impl From<client::AuthResult> for Outcome {
    fn from(result: client::AuthResult) -> Self {
        match result {
            client::AuthResult::Success => Outcome::Success,
            client::AuthResult::Failure {
                remaining_methods, ..
            } => Outcome::Failed(Some(remaining_methods)),
        }
    }
}

/// The order `ssh` uses: public keys, keyboard-interactive, password.
async fn authenticate(ctx: &Ctx, session: &mut Session, target: &Target) -> anyhow::Result<()> {
    let user = target.user.as_str();
    let mut methods = match session.authenticate_none(user).await? {
        client::AuthResult::Success => return Ok(()),
        client::AuthResult::Failure {
            remaining_methods, ..
        } => remaining_methods,
    };
    let update = |outcome: Outcome, methods: &mut MethodSet| match outcome {
        Outcome::Success => true,
        Outcome::Failed(Some(remaining)) => {
            *methods = remaining;
            false
        }
        Outcome::Failed(None) => false,
    };

    if target.auth != AuthMethod::Password && methods.contains(&MethodKind::PublicKey) {
        if target.auth == AuthMethod::Auto {
            let outcome = agent_auth(session, user).await;
            if update(outcome, &mut methods) {
                return Ok(());
            }
        }
        for path in key_candidates(target) {
            if !methods.contains(&MethodKind::PublicKey) {
                break;
            }
            let outcome = key_auth(ctx, session, user, &path).await?;
            if update(outcome, &mut methods) {
                return Ok(());
            }
        }
    }

    // A remembered password is read only when needed: on macOS reading the
    // Keychain can show a dialog.
    let mut secrets = Secrets {
        target,
        stored: None,
        tried_stored: false,
    };

    if methods.contains(&MethodKind::KeyboardInteractive) {
        let outcome = keyboard_auth(ctx, session, &mut secrets).await?;
        if update(outcome, &mut methods) {
            return Ok(());
        }
    }
    if methods.contains(&MethodKind::Password) {
        let outcome = password_auth(ctx, session, &mut secrets).await?;
        if update(outcome, &mut methods) {
            return Ok(());
        }
    }

    let offered: Vec<&str> = methods.iter().map(<&str>::from).collect();
    if offered.is_empty() {
        bail!("{} refused the authentication.", target.address());
    }
    bail!(
        "{} refused the authentication. The server accepts: {}.",
        target.address(),
        offered.join(", ")
    )
}

fn key_candidates(target: &Target) -> Vec<PathBuf> {
    if target.auth == AuthMethod::Key || !target.key_files.is_empty() {
        return target.key_files.clone();
    }
    let Some(dir) = ssh_dir() else {
        return Vec::new();
    };
    ["id_ed25519", "id_ecdsa", "id_rsa"]
        .iter()
        .map(|name| dir.join(name))
        .filter(|path| path.exists())
        .collect()
}

async fn rsa_hash(session: &Session, key: &PublicKey) -> Option<HashAlg> {
    if key.algorithm().is_rsa() {
        session
            .best_supported_rsa_hash()
            .await
            .ok()
            .flatten()
            .flatten()
    } else {
        None
    }
}

#[cfg(unix)]
async fn agent_auth(session: &mut Session, user: &str) -> Outcome {
    match AgentClient::connect_env().await {
        Ok(agent) => try_agent(session, user, agent).await,
        Err(_) => Outcome::Failed(None),
    }
}

#[cfg(windows)]
async fn agent_auth(session: &mut Session, user: &str) -> Outcome {
    if let Ok(agent) = AgentClient::connect_named_pipe(r"\\.\pipe\openssh-ssh-agent").await {
        return try_agent(session, user, agent).await;
    }
    match AgentClient::connect_pageant().await {
        Ok(agent) => try_agent(session, user, agent).await,
        Err(_) => Outcome::Failed(None),
    }
}

async fn try_agent<S>(session: &mut Session, user: &str, mut agent: AgentClient<S>) -> Outcome
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
{
    let Ok(identities) = agent.request_identities().await else {
        return Outcome::Failed(None);
    };
    let mut last = Outcome::Failed(None);
    for identity in identities.into_iter().take(MAX_AGENT_KEYS) {
        // Certificates need a different call; plain keys cover most setups.
        let AgentIdentity::PublicKey { key, .. } = identity else {
            continue;
        };
        let hash = rsa_hash(session, &key).await;
        match session
            .authenticate_publickey_with(user, key, hash, &mut agent)
            .await
        {
            Ok(client::AuthResult::Success) => return Outcome::Success,
            Ok(failure) => {
                last = failure.into();
                if let Outcome::Failed(Some(m)) = &last
                    && !m.contains(&MethodKind::PublicKey)
                {
                    break;
                }
            }
            Err(_) => continue,
        }
    }
    last
}

async fn key_auth(
    ctx: &Ctx,
    session: &mut Session,
    user: &str,
    path: &Path,
) -> anyhow::Result<Outcome> {
    let shown = tilde(path);
    let key = match load_secret_key(path, None) {
        Ok(key) => key,
        Err(russh::keys::Error::KeyIsEncrypted) => {
            let mut attempt = 0;
            loop {
                let prompt = Prompt::Passphrase {
                    key_path: shown.clone(),
                    retry: attempt > 0,
                };
                let Some(PromptReply::Secret { value, .. }) = ctx.ask(prompt).await else {
                    return Ok(Outcome::Failed(None));
                };
                match load_secret_key(path, Some(&value)) {
                    Ok(key) => break key,
                    Err(_) if attempt + 1 < MAX_SECRET_ATTEMPTS => attempt += 1,
                    Err(_) => {
                        ctx.status(format!("Wrong passphrase for {shown}, skipping this key."));
                        return Ok(Outcome::Failed(None));
                    }
                }
            }
        }
        Err(e) => {
            ctx.status(format!("Skipping {shown}: {e}"));
            return Ok(Outcome::Failed(None));
        }
    };
    let hash = rsa_hash(session, key.public_key()).await;
    let result = session
        .authenticate_publickey(user, PrivateKeyWithHashAlg::new(Arc::new(key), hash))
        .await?;
    Ok(result.into())
}

/// Hands out the password: the remembered one first, then asks the user.
struct Secrets<'a> {
    target: &'a Target,
    stored: Option<String>,
    tried_stored: bool,
}

struct Secret {
    value: String,
    remember: bool,
}

impl Secrets<'_> {
    async fn next(&mut self, ctx: &Ctx, retry: bool) -> Option<Secret> {
        if !self.tried_stored && self.target.has_password {
            self.tried_stored = true;
            if let Some(id) = &self.target.secret_id {
                self.stored = keychain_get(id);
            }
            if let Some(value) = self.stored.clone() {
                return Some(Secret {
                    value,
                    remember: false,
                });
            }
        }
        let prompt = Prompt::Password {
            user: self.target.user.clone(),
            host: self.target.host.clone(),
            can_remember: self.target.secret_id.is_some(),
            retry,
        };
        match ctx.ask(prompt).await {
            Some(PromptReply::Secret { value, remember }) => Some(Secret { value, remember }),
            _ => None,
        }
    }

    fn accepted(&self, ctx: &Ctx, secret: &Secret) {
        let Some(id) = &self.target.secret_id else {
            return;
        };
        if !secret.remember {
            return;
        }
        let saved =
            keychain_set(id, &secret.value).and_then(|_| ctx.store().set_has_password(id, true));
        if let Err(e) = saved {
            ctx.status(format!("Couldn't save the password: {e}"));
        }
    }
}

fn cancelled() -> anyhow::Error {
    anyhow!("Authentication cancelled.")
}

async fn password_auth(
    ctx: &Ctx,
    session: &mut Session,
    secrets: &mut Secrets<'_>,
) -> anyhow::Result<Outcome> {
    let mut outcome = Outcome::Failed(None);
    for attempt in 0..MAX_SECRET_ATTEMPTS {
        let secret = secrets.next(ctx, attempt > 0).await.ok_or_else(cancelled)?;
        let result = session
            .authenticate_password(secrets.target.user.as_str(), secret.value.as_str())
            .await?;
        if result.success() {
            secrets.accepted(ctx, &secret);
            return Ok(Outcome::Success);
        }
        outcome = result.into();
        if let Outcome::Failed(Some(m)) = &outcome
            && !m.contains(&MethodKind::Password)
        {
            break;
        }
    }
    Ok(outcome)
}

/// Keyboard-interactive is how most servers ask for the password (PAM). A
/// single hidden "Password:" field is handled like a password, so it can be
/// remembered; anything else (2FA codes…) is shown as asked.
async fn keyboard_auth(
    ctx: &Ctx,
    session: &mut Session,
    secrets: &mut Secrets<'_>,
) -> anyhow::Result<Outcome> {
    let user = secrets.target.user.clone();
    let mut response = session
        .authenticate_keyboard_interactive_start(user.as_str(), None)
        .await?;
    let mut password_rounds = 0;
    let mut pending: Option<Secret> = None;

    loop {
        match response {
            KeyboardInteractiveAuthResponse::Success => {
                if let Some(secret) = &pending {
                    secrets.accepted(ctx, secret);
                }
                return Ok(Outcome::Success);
            }
            KeyboardInteractiveAuthResponse::Failure {
                remaining_methods, ..
            } => {
                return Ok(Outcome::Failed(Some(remaining_methods)));
            }
            KeyboardInteractiveAuthResponse::InfoRequest {
                name,
                instructions,
                prompts,
            } => {
                let answers = if prompts.is_empty() {
                    Vec::new()
                } else if prompts.len() == 1
                    && !prompts[0].echo
                    && prompts[0].prompt.to_lowercase().contains("password")
                {
                    if password_rounds >= MAX_SECRET_ATTEMPTS {
                        return Ok(Outcome::Failed(None));
                    }
                    let secret = secrets
                        .next(ctx, password_rounds > 0)
                        .await
                        .ok_or_else(cancelled)?;
                    password_rounds += 1;
                    let value = secret.value.clone();
                    pending = Some(secret);
                    vec![value]
                } else {
                    let prompt = Prompt::KeyboardInteractive {
                        user: user.clone(),
                        host: secrets.target.host.clone(),
                        name,
                        instructions,
                        fields: prompts
                            .iter()
                            .map(|p| PromptField {
                                label: p.prompt.trim().to_owned(),
                                echo: p.echo,
                            })
                            .collect(),
                    };
                    match ctx.ask(prompt).await {
                        Some(PromptReply::Answers { values }) if values.len() == prompts.len() => {
                            values
                        }
                        _ => return Err(cancelled()),
                    }
                };
                response = session
                    .authenticate_keyboard_interactive_respond(answers)
                    .await?;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn describe_joins_causes_once() {
        let e = anyhow!("refused").context("Couldn't reach host:22");
        assert_eq!(describe(&e), "Couldn't reach host:22: refused");
    }

    #[test]
    fn describe_drops_os_error_numbers() {
        let e = anyhow!("Connection refused (os error 111)").context("Couldn't reach host:22");
        assert_eq!(describe(&e), "Couldn't reach host:22: Connection refused");
    }

    #[test]
    fn jump_specs() {
        let dir = std::env::temp_dir().join(format!("chappe-test-{}", std::process::id()));
        let store = ServerStore::new(dir);
        let t = resolve(&store, "alice@bastion.example.com:2200", 0).unwrap();
        assert_eq!(
            (t.user.as_str(), t.host.as_str(), t.port),
            ("alice", "bastion.example.com", 2200)
        );
        let chain = resolve(&store, "first.example.com,second.example.com", 0).unwrap();
        assert_eq!(chain.host, "second.example.com");
        assert_eq!(chain.jump.unwrap().host, "first.example.com");
    }
}
