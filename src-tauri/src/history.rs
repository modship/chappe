//! The commands a shell ran before its terminal was opened, read from the
//! shell's own history file. Nothing is written: the app keeps a session's
//! commands in memory only.
//!
//! Over SSH the file is read through a separate exec channel on the tab's
//! connection, so nothing shows up in the terminal.

use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::Serialize;
use tauri::State;

use crate::ssh::Connections;

/// Only the end of a history file is read.
const TAIL_BYTES: u64 = 1 << 20;
/// Commands returned at most, newest first.
const MAX_COMMANDS: usize = 1_000;
const REMOTE_TIMEOUT: Duration = Duration::from_secs(8);

/// Finds the login shell's history file and prints the shell's name, then
/// the end of the file. Run with `sh -c`, so it works whatever the login
/// shell is (fish included). Contains no single quote.
const REMOTE_SCRIPT: &str = r#"s=${SHELL##*/}
case $s in
  zsh) f=${HISTFILE:-${ZDOTDIR:-$HOME}/.zsh_history} ;;
  bash) f=${HISTFILE:-$HOME/.bash_history} ;;
  fish) f=${XDG_DATA_HOME:-$HOME/.local/share}/fish/fish_history ;;
  pwsh) f=$HOME/.local/share/powershell/PSReadLine/ConsoleHost_history.txt ;;
  *) f=${HISTFILE:-$HOME/.${s}_history} ;;
esac
echo "$s"
tail -c 1048576 "$f" 2>/dev/null"#;

#[derive(Debug, Clone, Copy, PartialEq)]
enum Format {
    Zsh,
    Bash,
    Fish,
    PowerShell,
    Plain,
}

impl Format {
    fn of_shell(name: &str) -> Format {
        match name.trim().trim_end_matches(".exe") {
            "zsh" => Format::Zsh,
            "bash" => Format::Bash,
            "fish" => Format::Fish,
            "pwsh" | "powershell" => Format::PowerShell,
            _ => Format::Plain,
        }
    }
}

/// zsh stores bytes >= 0x80 and its special tokens "metafied": 0x83, then
/// the byte xor 32.
fn unmetafy(bytes: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(bytes.len());
    let mut iter = bytes.iter();
    while let Some(&b) = iter.next() {
        if b == 0x83 {
            if let Some(&next) = iter.next() {
                out.push(next ^ 32);
            }
        } else {
            out.push(b);
        }
    }
    out
}

/// Joins lines that end with `marker` (a continuation) to the next one.
fn join_continued<'a>(lines: impl Iterator<Item = &'a str>, marker: char) -> Vec<String> {
    let mut commands = Vec::new();
    let mut current: Option<String> = None;
    for line in lines {
        let line = line.strip_suffix('\r').unwrap_or(line);
        let text = match current.take() {
            Some(mut previous) => {
                previous.push('\n');
                previous.push_str(line);
                previous
            }
            None => line.to_owned(),
        };
        match text.strip_suffix(marker) {
            Some(rest) => current = Some(rest.to_owned()),
            None => commands.push(text),
        }
    }
    commands.extend(current);
    commands
}

fn unescape_fish(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars();
    while let Some(c) = chars.next() {
        if c == '\\' {
            match chars.next() {
                Some('n') => out.push('\n'),
                Some(other) => out.push(other),
                None => out.push('\\'),
            }
        } else {
            out.push(c);
        }
    }
    out
}

/// Commands from a history file, oldest first. `partial` drops the first
/// line, cut by reading from the middle of the file.
fn parse(format: Format, bytes: &[u8], partial: bool) -> Vec<String> {
    let bytes = if format == Format::Zsh {
        unmetafy(bytes)
    } else {
        bytes.to_vec()
    };
    let text = String::from_utf8_lossy(&bytes);
    let mut lines: Vec<&str> = text.split('\n').collect();
    if partial && !lines.is_empty() {
        lines.remove(0);
    }
    let lines = lines.into_iter();
    match format {
        Format::Zsh => join_continued(lines, '\\')
            .into_iter()
            .map(|line| {
                // Extended history: ": <start>:<elapsed>;<command>"
                match line
                    .strip_prefix(": ")
                    .and_then(|rest| rest.split_once(';'))
                {
                    Some((times, command))
                        if times.chars().all(|c| c.is_ascii_digit() || c == ':') =>
                    {
                        command.to_owned()
                    }
                    _ => line,
                }
            })
            .collect(),
        // With HISTTIMEFORMAT, bash writes "#<time>" before each command.
        Format::Bash => lines
            .filter(|line| {
                !(line.len() > 1
                    && line.starts_with('#')
                    && line[1..].trim_end().chars().all(|c| c.is_ascii_digit()))
            })
            .map(|line| line.strip_suffix('\r').unwrap_or(line).to_owned())
            .collect(),
        Format::Fish => lines
            .filter_map(|line| line.strip_prefix("- cmd: "))
            .map(unescape_fish)
            .collect(),
        Format::PowerShell => join_continued(lines, '`'),
        Format::Plain => lines
            .map(|line| line.strip_suffix('\r').unwrap_or(line).to_owned())
            .collect(),
    }
}

/// Newest first, each command once, without blank lines or lines kept out
/// of history by a leading space.
fn newest_unique(commands: Vec<String>) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for command in commands.into_iter().rev() {
        if command.trim().is_empty() || command.starts_with(' ') {
            continue;
        }
        let command = command.trim_end().to_owned();
        if seen.insert(command.clone()) {
            out.push(command);
            if out.len() == MAX_COMMANDS {
                break;
            }
        }
    }
    out
}

/// The end of a file, and whether it was cut.
fn read_tail(path: &Path) -> std::io::Result<(Vec<u8>, bool)> {
    let mut file = File::open(path)?;
    let len = file.metadata()?.len();
    let partial = len > TAIL_BYTES;
    if partial {
        file.seek(SeekFrom::Start(len - TAIL_BYTES))?;
    }
    let mut bytes = Vec::new();
    file.take(TAIL_BYTES).read_to_end(&mut bytes)?;
    Ok((bytes, partial))
}

/// Remote output: the shell's name, then the file's end.
fn parse_remote(output: &[u8]) -> Vec<String> {
    let Some(newline) = output.iter().position(|&b| b == b'\n') else {
        return Vec::new();
    };
    let shell = String::from_utf8_lossy(&output[..newline]);
    let body = &output[newline + 1..];
    let partial = body.len() as u64 >= TAIL_BYTES;
    newest_unique(parse(Format::of_shell(&shell), body, partial))
}

#[cfg(unix)]
fn local_file(_profile: &str, shell: &str) -> Option<(PathBuf, Format)> {
    let home = dirs::home_dir()?;
    let env = |name: &str| std::env::var_os(name).map(PathBuf::from);
    let format = Format::of_shell(shell);
    let path = match shell {
        "zsh" => {
            env("HISTFILE").unwrap_or_else(|| env("ZDOTDIR").unwrap_or(home).join(".zsh_history"))
        }
        "bash" => env("HISTFILE").unwrap_or_else(|| home.join(".bash_history")),
        "fish" => env("XDG_DATA_HOME")
            .unwrap_or_else(|| home.join(".local/share"))
            .join("fish/fish_history"),
        "pwsh" => home.join(".local/share/powershell/PSReadLine/ConsoleHost_history.txt"),
        other => home.join(format!(".{other}_history")),
    };
    Some((path, format))
}

/// PowerShell's history is shared by Windows PowerShell and PowerShell 7;
/// Command Prompt keeps none.
#[cfg(windows)]
fn local_file(profile: &str, _shell: &str) -> Option<(PathBuf, Format)> {
    match profile {
        "cmd" => None,
        _ => Some((
            dirs::data_dir()?
                .join(r"Microsoft\Windows\PowerShell\PSReadLine\ConsoleHost_history.txt"),
            Format::PowerShell,
        )),
    }
}

fn local_history(profile: &str, shell: &str) -> Vec<String> {
    #[cfg(windows)]
    if let Some(distro) = profile.strip_prefix("wsl:") {
        return crate::local::wsl_output(distro, REMOTE_SCRIPT)
            .map(|output| parse_remote(&output))
            .unwrap_or_default();
    }
    let Some((path, format)) = local_file(profile, shell) else {
        return Vec::new();
    };
    match read_tail(&path) {
        Ok((bytes, partial)) => newest_unique(parse(format, &bytes, partial)),
        Err(_) => Vec::new(),
    }
}

/// Some of the earlier commands, newest first.
#[derive(Debug, PartialEq, Serialize)]
pub struct Page {
    commands: Vec<String>,
    /// Older ones are left.
    more: bool,
}

/// `limit` commands after the newest `offset`. The file is read again for
/// each page: it is small next to a terminal's output, and nothing is kept.
fn page(commands: Vec<String>, offset: usize, limit: usize) -> Page {
    let more = commands.len() > offset + limit;
    Page {
        commands: commands.into_iter().skip(offset).take(limit).collect(),
        more,
    }
}

/// Earlier commands of a local shell, newest first. `shell` is the name
/// returned when the terminal started ("zsh").
#[tauri::command]
pub async fn history_import_local(
    profile: String,
    shell: String,
    offset: usize,
    limit: usize,
) -> Page {
    let commands = tauri::async_runtime::spawn_blocking(move || local_history(&profile, &shell))
        .await
        .unwrap_or_default();
    page(commands, offset, limit)
}

/// Earlier commands on the server of an SSH tab, newest first.
#[tauri::command]
pub async fn history_import_ssh(
    connections: State<'_, Connections>,
    session_id: u32,
    offset: usize,
    limit: usize,
) -> Result<Page, String> {
    let command = format!("sh -c '{REMOTE_SCRIPT}'");
    let output = tokio::time::timeout(
        REMOTE_TIMEOUT,
        connections.exec(session_id, &command, TAIL_BYTES as usize + 4096),
    )
    .await
    .map_err(|_| "The server took too long to answer.".to_owned())?
    .map_err(|e| e.to_string())?;
    Ok(page(parse_remote(&output), offset, limit))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn zsh_plain_extended_multiline_and_metafied() {
        let mut bytes = b": 1700000000:0;ls -la\ncd /tmp\n: 1700000005:2;for f in *; do\\\necho $f\\\ndone\necho caf".to_vec();
        // "é" is 0xC3 0xA9; zsh writes 0xC3 as 0x83 0xE3.
        bytes.extend([0x83, 0xC3 ^ 32, 0xA9, b'\n']);
        let commands = parse(Format::Zsh, &bytes, false);
        assert_eq!(
            commands,
            [
                "ls -la",
                "cd /tmp",
                "for f in *; do\necho $f\ndone",
                "echo café",
                ""
            ]
        );
    }

    #[test]
    fn bash_skips_timestamps_and_a_cut_first_line() {
        let text = b"half a line\n#1700000000\ngit status\n#1700000001\nmake\n";
        assert_eq!(parse(Format::Bash, text, true), ["git status", "make", ""]);
    }

    #[test]
    fn fish_and_powershell() {
        let fish =
            b"- cmd: echo one\n  when: 1700000000\n- cmd: printf 'a\\\\nb'\\nls\n  when: 1\n";
        assert_eq!(
            parse(Format::Fish, fish, false),
            ["echo one", "printf 'a\\nb'\nls"]
        );
        let ps = b"Get-ChildItem\r\nWrite-Host `\r\n  hi\r\n";
        assert_eq!(
            parse(Format::PowerShell, ps, false),
            ["Get-ChildItem", "Write-Host \n  hi", ""]
        );
    }

    #[test]
    fn newest_first_once_and_no_hidden_ones() {
        let commands = ["ls", " secret", "make", "ls", "", "git push"]
            .map(String::from)
            .to_vec();
        assert_eq!(newest_unique(commands), ["git push", "ls", "make"]);
    }

    #[test]
    fn pages() {
        let commands: Vec<String> = (0..5).map(|i| i.to_string()).collect();
        assert_eq!(
            page(commands.clone(), 0, 2),
            Page {
                commands: vec!["0".into(), "1".into()],
                more: true
            }
        );
        assert_eq!(
            page(commands.clone(), 3, 2),
            Page {
                commands: vec!["3".into(), "4".into()],
                more: false
            }
        );
        assert_eq!(
            page(commands, 9, 2),
            Page {
                commands: vec![],
                more: false
            }
        );
    }

    #[test]
    fn remote_output_names_the_shell_first() {
        assert_eq!(
            parse_remote(b"zsh\n: 1700000000:0;uptime\nhtop\n"),
            ["htop", "uptime"]
        );
        assert_eq!(parse_remote(b"bash\n"), Vec::<String>::new());
        assert_eq!(parse_remote(b""), Vec::<String>::new());
    }

    #[test]
    fn the_remote_script_survives_single_quoting() {
        assert!(!REMOTE_SCRIPT.contains('\''));
    }
}
