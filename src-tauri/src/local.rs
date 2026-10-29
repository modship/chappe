//! Local shells in a pseudo-terminal.
//!
//! On macOS and Linux there is one profile: the user's login shell. On
//! Windows there is no login shell, so the profiles are PowerShell 7 (if
//! installed), Windows PowerShell, Command Prompt and each WSL distribution.

use std::io::{ErrorKind, Read, Write};
use std::thread;
use std::time::Duration;

use portable_pty::{ChildKiller, CommandBuilder, MasterPty, PtySize, native_pty_system};
use serde::Serialize;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Manager, State};

use crate::output::spawn_pump;
use crate::session::{Backend, CmdResult, SessionManager, TerminalEvent, err};

/// How long to wait for trailing output after the shell has exited.
const DRAIN_TIMEOUT: Duration = Duration::from_millis(500);

struct LocalBackend {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
    pid: Option<u32>,
}

impl Backend for LocalBackend {
    fn write(&mut self, data: &[u8]) -> anyhow::Result<()> {
        self.writer.write_all(data)?;
        self.writer.flush()?;
        Ok(())
    }

    fn resize(&mut self, cols: u16, rows: u16) -> anyhow::Result<()> {
        self.master.resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })?;
        Ok(())
    }

    fn close(&mut self) {
        let _ = self.killer.kill();
    }

    fn cwd(&self) -> Option<String> {
        process_cwd(self.pid?)
    }
}

#[cfg(target_os = "linux")]
fn process_cwd(pid: u32) -> Option<String> {
    std::fs::read_link(format!("/proc/{pid}/cwd"))
        .ok()
        .map(|p| p.to_string_lossy().into_owned())
}

/// macOS has no /proc; lsof is always installed and reads it for us.
#[cfg(target_os = "macos")]
fn process_cwd(pid: u32) -> Option<String> {
    let output = std::process::Command::new("/usr/sbin/lsof")
        .args(["-a", "-p", &pid.to_string(), "-d", "cwd", "-Fn"])
        .output()
        .ok()?;
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .find_map(|line| line.strip_prefix('n'))
        .map(str::to_owned)
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn process_cwd(_pid: u32) -> Option<String> {
    None
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalInfo {
    id: u32,
    shell: String,
}

/// A kind of local terminal the user can open.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct LocalProfile {
    id: String,
    name: String,
    /// Shown next to the name, e.g. "WSL".
    detail: Option<String>,
}

/// The id that always means "the default profile".
const DEFAULT_PROFILE: &str = "default";

/// Environment shared by every local shell.
fn terminal_env(cmd: &mut CommandBuilder) {
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.env("TERM_PROGRAM", "Chappe");
    cmd.env("TERM_PROGRAM_VERSION", env!("CARGO_PKG_VERSION"));

    // Apps launched from the Finder get no locale, which leaves zsh in the C
    // locale and breaks every non-ASCII glyph. Derive one from the system.
    if !has_locale() {
        cmd.env("LANG", system_lang());
    }
}

fn has_locale() -> bool {
    ["LC_ALL", "LC_CTYPE", "LANG"]
        .iter()
        .any(|k| std::env::var_os(k).is_some_and(|v| !v.is_empty()))
}

/// The system locale as a POSIX name, e.g. `fr-FR` becomes `fr_FR.UTF-8`.
pub fn system_lang() -> String {
    sys_locale::get_locale()
        .map(|l| l.replace('-', "_"))
        .filter(|l| l.len() == 5 && l.as_bytes()[2] == b'_')
        .map(|l| format!("{l}.UTF-8"))
        .unwrap_or_else(|| "en_US.UTF-8".into())
}

// ---------- Profiles: macOS and Linux ----------

#[cfg(unix)]
fn profiles() -> Vec<LocalProfile> {
    let shell = CommandBuilder::new_default_prog().get_shell();
    let name = shell.rsplit('/').next().unwrap_or(&shell).to_owned();
    vec![LocalProfile {
        id: DEFAULT_PROFILE.into(),
        name,
        detail: None,
    }]
}

/// The user's login shell, started the way Terminal.app does it.
/// Returns the command and the name to show for it.
#[cfg(unix)]
fn profile_command(_id: &str) -> Result<(CommandBuilder, String), String> {
    let cmd = CommandBuilder::new_default_prog();
    let shell = cmd.get_shell();
    let name = shell.rsplit('/').next().unwrap_or(&shell).to_owned();
    Ok((cmd, name))
}

// ---------- Profiles: Windows ----------

#[cfg(windows)]
pub use windows::wsl_output;

#[cfg(windows)]
mod windows {
    use std::os::windows::process::CommandExt;
    use std::path::PathBuf;
    use std::process::{Command, Stdio};
    use std::sync::mpsc;
    use std::time::Duration;

    /// Keeps console programs from flashing a window when started from a GUI app.
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    fn system_root() -> PathBuf {
        std::env::var_os("SystemRoot")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(r"C:\Windows"))
    }

    fn find_in_path(exe: &str) -> Option<PathBuf> {
        std::env::split_paths(&std::env::var_os("PATH")?)
            .map(|dir| dir.join(exe))
            .find(|path| path.is_file())
    }

    /// PowerShell 7 is installed side by side with Windows PowerShell.
    pub fn pwsh() -> Option<PathBuf> {
        find_in_path("pwsh.exe").or_else(|| {
            let program_files = std::env::var_os("ProgramFiles")?;
            let path = PathBuf::from(program_files).join(r"PowerShell\7\pwsh.exe");
            path.is_file().then_some(path)
        })
    }

    pub fn windows_powershell() -> PathBuf {
        system_root().join(r"System32\WindowsPowerShell\v1.0\powershell.exe")
    }

    pub fn cmd() -> PathBuf {
        std::env::var_os("COMSPEC")
            .map(PathBuf::from)
            .unwrap_or_else(|| system_root().join(r"System32\cmd.exe"))
    }

    pub fn wsl() -> PathBuf {
        system_root().join(r"System32\wsl.exe")
    }

    /// Runs a POSIX shell script in a WSL distribution and returns its
    /// output, or None if it fails or takes too long.
    pub fn wsl_output(distro: &str, script: &str) -> Option<Vec<u8>> {
        let wsl = wsl();
        if !wsl.is_file() {
            return None;
        }
        let (tx, rx) = mpsc::channel();
        let args = [
            "-d".to_owned(),
            distro.to_owned(),
            "-e".to_owned(),
            "sh".to_owned(),
            "-c".to_owned(),
            script.to_owned(),
        ];
        std::thread::spawn(move || {
            let output = Command::new(wsl)
                .args(args)
                .stdin(Stdio::null())
                .stderr(Stdio::null())
                .creation_flags(CREATE_NO_WINDOW)
                .output();
            let _ = tx.send(output);
        });
        match rx.recv_timeout(Duration::from_secs(8)) {
            Ok(Ok(output)) => Some(output.stdout),
            _ => None,
        }
    }

    /// Installed WSL distributions, or none if WSL is missing or slow to answer.
    pub fn wsl_distros() -> Vec<String> {
        let wsl = wsl();
        if !wsl.is_file() {
            return Vec::new();
        }
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            let output = Command::new(wsl)
                .args(["--list", "--quiet"])
                // Newer WSL prints UTF-8 with this; older versions ignore it.
                .env("WSL_UTF8", "1")
                .stdin(Stdio::null())
                .stderr(Stdio::null())
                .creation_flags(CREATE_NO_WINDOW)
                .output();
            let _ = tx.send(output);
        });
        // A broken WSL install can hang; the app must not wait on it.
        match rx.recv_timeout(Duration::from_secs(3)) {
            Ok(Ok(output)) if output.status.success() => super::parse_distros(&output.stdout),
            _ => Vec::new(),
        }
    }
}

/// Distribution names from `wsl --list --quiet`. Its output is UTF-16LE
/// (sometimes with a BOM) unless WSL_UTF8 is honoured, then UTF-8.
#[cfg_attr(not(windows), allow(dead_code))]
fn parse_distros(bytes: &[u8]) -> Vec<String> {
    let (body, bom) = match bytes {
        [0xFF, 0xFE, rest @ ..] => (rest, true),
        _ => (bytes, false),
    };
    let looks_utf16 = body.len() % 2 == 0 && body.iter().skip(1).step_by(2).all(|b| *b == 0);
    let text = if bom || (!body.is_empty() && looks_utf16) {
        let units: Vec<u16> = body
            .chunks_exact(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect();
        String::from_utf16_lossy(&units)
    } else {
        String::from_utf8_lossy(body).into_owned()
    };
    text.lines()
        .map(|line| line.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}' || c == '\0'))
        // Docker Desktop's internal distributions are not for interactive use.
        .filter(|name| !name.is_empty() && !name.starts_with("docker-desktop"))
        .map(str::to_owned)
        .collect()
}

#[cfg(windows)]
fn profiles() -> Vec<LocalProfile> {
    let profile = |id: &str, name: &str, detail: Option<&str>| LocalProfile {
        id: id.into(),
        name: name.into(),
        detail: detail.map(Into::into),
    };
    let mut list = Vec::new();
    if windows::pwsh().is_some() {
        list.push(profile("pwsh", "PowerShell", None));
    }
    list.push(profile("powershell", "Windows PowerShell", None));
    list.push(profile("cmd", "Command Prompt", None));
    for distro in windows::wsl_distros() {
        list.push(LocalProfile {
            id: format!("wsl:{distro}"),
            name: distro,
            detail: Some("WSL".into()),
        });
    }
    list
}

#[cfg(windows)]
fn profile_command(id: &str) -> Result<(CommandBuilder, String), String> {
    let (mut cmd, name) = match id {
        DEFAULT_PROFILE | "pwsh" | "powershell" => {
            let (path, name) = match windows::pwsh().filter(|_| id != "powershell") {
                Some(path) => (path, "PowerShell"),
                None => (windows::windows_powershell(), "Windows PowerShell"),
            };
            let mut cmd = CommandBuilder::new(path);
            cmd.arg("-NoLogo");
            (cmd, name.to_owned())
        }
        "cmd" => (
            CommandBuilder::new(windows::cmd()),
            "Command Prompt".to_owned(),
        ),
        other => {
            let distro = other
                .strip_prefix("wsl:")
                .ok_or_else(|| format!("Unknown terminal profile: {other}"))?;
            let mut cmd = CommandBuilder::new(windows::wsl());
            cmd.args(["-d", distro, "--cd", "~"]);
            (cmd, distro.to_owned())
        }
    };
    if let Some(home) = dirs::home_dir() {
        cmd.cwd(home);
    }
    Ok((cmd, name))
}

#[tauri::command]
pub async fn local_profiles() -> Vec<LocalProfile> {
    // Listing WSL distributions runs a program; keep it off the async runtime.
    tauri::async_runtime::spawn_blocking(profiles)
        .await
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::parse_distros;

    fn utf16(text: &str) -> Vec<u8> {
        text.encode_utf16().flat_map(u16::to_le_bytes).collect()
    }

    #[test]
    fn wsl_list_in_utf16() {
        let plain = utf16("Ubuntu\r\ndocker-desktop\r\nDebian\r\n");
        assert_eq!(parse_distros(&plain), ["Ubuntu", "Debian"]);
        let with_bom = utf16("\u{feff}Ubuntu-24.04\r\n");
        assert_eq!(parse_distros(&with_bom), ["Ubuntu-24.04"]);
    }

    #[test]
    fn wsl_list_in_utf8() {
        assert_eq!(
            parse_distros(b"Ubuntu-24.04\nkali-linux\n"),
            ["Ubuntu-24.04", "kali-linux"]
        );
        assert!(parse_distros(b"").is_empty());
    }
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn local_spawn(
    app: AppHandle,
    state: State<'_, SessionManager>,
    cols: u16,
    rows: u16,
    profile: Option<String>,
    cwd: Option<String>,
    on_data: Channel<InvokeResponseBody>,
    on_event: Channel<TerminalEvent>,
) -> CmdResult<LocalInfo> {
    let pair = native_pty_system()
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(err)?;

    let (mut cmd, shell) = profile_command(profile.as_deref().unwrap_or(DEFAULT_PROFILE))?;
    terminal_env(&mut cmd);
    if let Some(dir) = cwd.filter(|d| std::path::Path::new(d).is_dir()) {
        cmd.cwd(dir);
    }
    let mut child = pair.slave.spawn_command(cmd).map_err(err)?;
    // Our copy of the slave must go, or the reader never sees EOF.
    drop(pair.slave);

    let mut reader = pair.master.try_clone_reader().map_err(err)?;
    let writer = pair.master.take_writer().map_err(err)?;
    let killer = child.clone_killer();
    let pid = child.process_id();

    let id = state.next_id();
    state.insert(
        id,
        Box::new(LocalBackend {
            master: pair.master,
            writer,
            killer,
            pid,
        }),
    );

    let pump = spawn_pump(format!("local-{id}-out"), on_data).map_err(err)?;
    let output = pump.sender;
    thread::Builder::new()
        .name(format!("local-{id}-read"))
        .spawn(move || {
            let mut buf = vec![0u8; 64 * 1024];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        if output.send(buf[..n].to_vec()).is_err() {
                            break;
                        }
                    }
                    Err(e) if e.kind() == ErrorKind::Interrupted => continue,
                    Err(_) => break,
                }
            }
        })
        .map_err(err)?;

    let mut drained = pump.drained;
    thread::Builder::new()
        .name(format!("local-{id}-wait"))
        .spawn(move || {
            let status = child.wait();
            // Let the last bytes reach the screen before announcing the exit.
            // A background job can keep the PTY open, so don't wait forever.
            let deadline = std::time::Instant::now() + DRAIN_TIMEOUT;
            while drained.try_recv().is_err() && std::time::Instant::now() < deadline {
                thread::sleep(Duration::from_millis(10));
            }
            let event = match status {
                Ok(s) => TerminalEvent::Exit {
                    code: Some(s.exit_code()),
                    signal: s.signal().map(str::to_owned),
                    error: None,
                },
                Err(e) => TerminalEvent::Exit {
                    code: None,
                    signal: None,
                    error: Some(e.to_string()),
                },
            };
            let _ = on_event.send(event);
            app.state::<SessionManager>().remove(id);
        })
        .map_err(err)?;

    Ok(LocalInfo { id, shell })
}
