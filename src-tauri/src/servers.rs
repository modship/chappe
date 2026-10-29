//! The server book: servers saved in Chappe plus the hosts declared in
//! `~/.ssh/config`, and passwords kept in the OS credential store.

use std::collections::HashSet;
use std::fs;
use std::io::BufReader;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use ssh2_config::{ParseRule, SshConfig};
use tauri::State;

use crate::session::{CmdResult, err};

const KEYCHAIN_SERVICE: &str = "Chappe";
/// Ids of hosts read from `~/.ssh/config` start with this.
pub const CONFIG_PREFIX: &str = "config:";

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub enum AuthMethod {
    /// SSH agent, then key files, then password: what `ssh` does.
    #[default]
    Auto,
    /// One specific key file.
    Key,
    /// Password only. Skips the agent, which avoids "too many
    /// authentication failures" on servers with many keys loaded.
    Password,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Server {
    #[serde(default)]
    pub id: String,
    pub name: String,
    pub host: String,
    #[serde(default = "default_port")]
    pub port: u16,
    #[serde(default)]
    pub user: Option<String>,
    #[serde(default)]
    pub auth: AuthMethod,
    #[serde(default)]
    pub key_path: Option<String>,
    /// Jump host: a server id, or an OpenSSH `ProxyJump` value.
    #[serde(default)]
    pub jump: Option<String>,
}

fn default_port() -> u16 {
    22
}

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Source {
    Saved,
    SshConfig,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ServerEntry {
    #[serde(flatten)]
    pub server: Server,
    pub source: Source,
    pub has_password: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerList {
    servers: Vec<ServerEntry>,
    config_error: Option<String>,
}

#[derive(Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct StoreFile {
    #[serde(default)]
    version: u32,
    #[serde(default)]
    servers: Vec<Server>,
    /// Servers with a password in the credential store. Kept here so that
    /// listing servers never has to touch the store, which on macOS can
    /// raise a Keychain access dialog.
    #[serde(default)]
    remembered_passwords: Vec<String>,
}

pub struct ServerStore {
    path: PathBuf,
    lock: Mutex<()>,
}

impl ServerStore {
    pub fn new(dir: PathBuf) -> Self {
        Self {
            path: dir.join("servers.json"),
            lock: Mutex::new(()),
        }
    }

    fn read(&self) -> anyhow::Result<StoreFile> {
        match fs::read(&self.path) {
            Ok(bytes) => Ok(serde_json::from_slice(&bytes)?),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(StoreFile::default()),
            Err(e) => Err(e.into()),
        }
    }

    /// Atomic write: a crash halfway never leaves a truncated file.
    fn write(&self, file: &StoreFile) -> anyhow::Result<()> {
        if let Some(dir) = self.path.parent() {
            fs::create_dir_all(dir)?;
        }
        let tmp = self.path.with_extension("json.tmp");
        fs::write(&tmp, serde_json::to_vec_pretty(file)?)?;
        fs::rename(&tmp, &self.path)?;
        Ok(())
    }

    fn update<T>(&self, f: impl FnOnce(&mut StoreFile) -> T) -> anyhow::Result<T> {
        let _guard = self.lock.lock().map_err(|e| anyhow::anyhow!("{e}"))?;
        let mut file = self.read()?;
        let out = f(&mut file);
        file.version = 1;
        self.write(&file)?;
        Ok(out)
    }

    pub fn has_password(&self, id: &str) -> bool {
        self.read()
            .is_ok_and(|f| f.remembered_passwords.iter().any(|r| r == id))
    }

    pub fn set_has_password(&self, id: &str, value: bool) -> anyhow::Result<()> {
        self.update(|f| {
            f.remembered_passwords.retain(|r| r != id);
            if value {
                f.remembered_passwords.push(id.to_owned());
            }
        })
    }

    /// Every known server: saved ones first, then `~/.ssh/config` hosts.
    pub fn all(&self) -> (Vec<ServerEntry>, Option<String>) {
        let file = self.read().unwrap_or_default();
        let remembered: HashSet<&str> = file
            .remembered_passwords
            .iter()
            .map(String::as_str)
            .collect();
        let entry = |server: Server, source| ServerEntry {
            has_password: remembered.contains(server.id.as_str()),
            server,
            source,
        };
        let mut list: Vec<ServerEntry> = file
            .servers
            .iter()
            .cloned()
            .map(|s| entry(s, Source::Saved))
            .collect();
        let (imported, error) = match ssh_config_servers() {
            Ok(servers) => (servers, None),
            Err(e) => (Vec::new(), Some(e)),
        };
        list.extend(imported.into_iter().map(|s| entry(s, Source::SshConfig)));
        (list, error)
    }

    pub fn find(&self, id: &str) -> Option<ServerEntry> {
        self.all().0.into_iter().find(|e| e.server.id == id)
    }
}

pub fn ssh_dir() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".ssh"))
}

pub fn expand_tilde(path: &str) -> PathBuf {
    match (path.strip_prefix("~/"), dirs::home_dir()) {
        (Some(rest), Some(home)) => home.join(rest),
        _ => PathBuf::from(path),
    }
}

/// Hosts declared in `~/.ssh/config`, resolved the way `ssh` would.
/// Wildcard patterns (`Host *`) only provide defaults and are not listed.
fn ssh_config_servers() -> Result<Vec<Server>, String> {
    let Some(path) = ssh_dir().map(|d| d.join("config")) else {
        return Ok(Vec::new());
    };
    if !path.exists() {
        return Ok(Vec::new());
    }
    let config = read_ssh_config(&path).map_err(|e| format!("Couldn't read ~/.ssh/config: {e}"))?;

    let mut seen = HashSet::new();
    let mut servers = Vec::new();
    for host in config.get_hosts() {
        for clause in &host.pattern {
            let alias = clause.pattern.as_str();
            if clause.negated || alias.contains(['*', '?', '!']) || !seen.insert(alias.to_owned()) {
                continue;
            }
            let params = config.query(alias);
            let jump = params
                .proxy_jump
                .map(|hops| hops.join(","))
                .filter(|j| !j.is_empty() && !j.eq_ignore_ascii_case("none"));
            servers.push(Server {
                id: format!("{CONFIG_PREFIX}{alias}"),
                name: alias.to_owned(),
                host: params.host_name.unwrap_or_else(|| alias.to_owned()),
                port: params.port.unwrap_or(22),
                user: params.user,
                auth: AuthMethod::Auto,
                key_path: params
                    .identity_file
                    .and_then(|files| files.into_iter().next())
                    .map(|p| p.to_string_lossy().into_owned()),
                jump,
            });
        }
    }
    Ok(servers)
}

fn read_ssh_config(path: &Path) -> anyhow::Result<SshConfig> {
    let mut reader = BufReader::new(fs::File::open(path)?);
    let mut config = SshConfig::default();
    if let Some(home) = dirs::home_dir() {
        config = config.home_dir(home);
    }
    Ok(config.parse(
        &mut reader,
        ParseRule::ALLOW_UNKNOWN_FIELDS | ParseRule::ALLOW_UNSUPPORTED_FIELDS,
    )?)
}

// ---------- Credential store ----------

fn keychain_entry(id: &str) -> keyring::Result<keyring::Entry> {
    keyring::Entry::new(KEYCHAIN_SERVICE, &format!("server:{id}"))
}

pub fn keychain_get(id: &str) -> Option<String> {
    keychain_entry(id).ok()?.get_password().ok()
}

pub fn keychain_set(id: &str, password: &str) -> anyhow::Result<()> {
    keychain_entry(id)
        .and_then(|entry| entry.set_password(password))
        .map_err(|e| match e {
            keyring::Error::PlatformFailure(_) | keyring::Error::NoStorageAccess(_) => {
                anyhow::anyhow!("the system keyring isn't available")
            }
            other => other.into(),
        })
}

pub fn keychain_delete(id: &str) {
    if let Ok(entry) = keychain_entry(id) {
        let _ = entry.delete_credential();
    }
}

// ---------- Commands ----------

#[tauri::command]
pub async fn servers_list(store: State<'_, ServerStore>) -> CmdResult<ServerList> {
    let (servers, config_error) = store.all();
    Ok(ServerList {
        servers,
        config_error,
    })
}

#[tauri::command]
pub async fn server_save(
    store: State<'_, ServerStore>,
    mut server: Server,
    password: Option<String>,
) -> CmdResult<ServerEntry> {
    server.name = server.name.trim().to_owned();
    server.host = server.host.trim().to_owned();
    if server.host.is_empty() {
        return Err("Enter a host name or IP address.".into());
    }
    if server.port == 0 {
        return Err("Enter a port between 1 and 65535.".into());
    }
    if server.name.is_empty() {
        server.name = server.host.clone();
    }
    server.user = server
        .user
        .map(|u| u.trim().to_owned())
        .filter(|u| !u.is_empty());
    server.key_path = server
        .key_path
        .map(|k| k.trim().to_owned())
        .filter(|k| !k.is_empty());
    server.jump = server.jump.filter(|j| !j.is_empty() && *j != server.id);
    if server.auth == AuthMethod::Key && server.key_path.is_none() {
        return Err("Choose a key file, or switch authentication to Automatic.".into());
    }
    if server.id.is_empty() || server.id.starts_with(CONFIG_PREFIX) {
        server.id = format!("srv-{}", uuid::Uuid::new_v4().simple());
    }

    let saved = server.clone();
    store
        .update(|f| match f.servers.iter_mut().find(|s| s.id == saved.id) {
            Some(existing) => *existing = saved,
            None => f.servers.push(saved),
        })
        .map_err(err)?;

    if let Some(password) = password.filter(|p| !p.is_empty()) {
        keychain_set(&server.id, &password)
            .map_err(|e| format!("Couldn't save the password: {e}"))?;
        store.set_has_password(&server.id, true).map_err(err)?;
    }

    let has_password = store.has_password(&server.id);
    Ok(ServerEntry {
        server,
        source: Source::Saved,
        has_password,
    })
}

#[tauri::command]
pub async fn server_delete(store: State<'_, ServerStore>, id: String) -> CmdResult<()> {
    store
        .update(|f| {
            f.servers.retain(|s| s.id != id);
            // Jumps through the deleted server would point nowhere.
            for s in &mut f.servers {
                if s.jump.as_deref() == Some(id.as_str()) {
                    s.jump = None;
                }
            }
            f.remembered_passwords.retain(|r| *r != id);
        })
        .map_err(err)?;
    keychain_delete(&id);
    Ok(())
}

#[tauri::command]
pub async fn server_forget_password(store: State<'_, ServerStore>, id: String) -> CmdResult<()> {
    keychain_delete(&id);
    store.set_has_password(&id, false).map_err(err)
}
