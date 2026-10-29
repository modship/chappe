//! Host key verification against OpenSSH's `known_hosts`.
//!
//! russh ships a checker, but it gives up on the first line it can't parse.
//! Real files collect odd entries over the years (markers, key types we
//! don't support, wildcards), so this one skips what it doesn't understand.

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;

use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;
use hmac::{Hmac, Mac};
use russh::keys::PublicKey;
use sha1::Sha1;

use crate::servers::ssh_dir;

pub enum HostKeyStatus {
    Trusted,
    Unknown,
    /// A different key of the same type is on record: possibly an attack.
    Changed {
        path: PathBuf,
        line: usize,
    },
    Revoked,
}

fn files() -> Vec<PathBuf> {
    ssh_dir()
        .map(|d| vec![d.join("known_hosts"), d.join("known_hosts2")])
        .unwrap_or_default()
}

/// How OpenSSH names a host in known_hosts.
fn host_entry(host: &str, port: u16) -> String {
    if port == 22 {
        host.to_owned()
    } else {
        format!("[{host}]:{port}")
    }
}

/// Algorithm and base64 blob, the two fields that identify a key.
fn key_fields(key: &PublicKey) -> Option<(String, String)> {
    let line = key.to_openssh().ok()?;
    let mut parts = line.split_whitespace();
    Some((parts.next()?.to_owned(), parts.next()?.to_owned()))
}

pub fn check(host: &str, port: u16, key: &PublicKey) -> HostKeyStatus {
    let Some((algorithm, blob)) = key_fields(key) else {
        return HostKeyStatus::Unknown;
    };
    let name = host_entry(host, port);
    let mut changed = None;

    for path in files() {
        let Ok(text) = fs::read_to_string(&path) else {
            continue;
        };
        for (index, raw) in text.lines().enumerate() {
            let line = raw.trim();
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            let mut fields = line.split_whitespace();
            let mut first = fields.next().unwrap_or_default();
            let mut marker = None;
            if first.starts_with('@') {
                marker = Some(first);
                first = fields.next().unwrap_or_default();
            }
            let (Some(line_algorithm), Some(line_blob)) = (fields.next(), fields.next()) else {
                continue;
            };
            if !hosts_match(first, &name) {
                continue;
            }
            match marker {
                Some("@revoked") if line_blob == blob => return HostKeyStatus::Revoked,
                // Certificate authorities need certificate support; skip.
                Some(_) => continue,
                None => {}
            }
            if line_algorithm != algorithm {
                continue;
            }
            if line_blob == blob {
                return HostKeyStatus::Trusted;
            }
            changed.get_or_insert((path.clone(), index + 1));
        }
    }
    match changed {
        Some((path, line)) => HostKeyStatus::Changed { path, line },
        None => HostKeyStatus::Unknown,
    }
}

/// Records a host key the user accepted, like `ssh` does on "yes".
pub fn learn(host: &str, port: u16, key: &PublicKey) -> anyhow::Result<()> {
    let (algorithm, blob) = key_fields(key).ok_or_else(|| anyhow::anyhow!("unsupported key"))?;
    let path = ssh_dir()
        .ok_or_else(|| anyhow::anyhow!("no home directory"))?
        .join("known_hosts");
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    let needs_newline = fs::read(&path).is_ok_and(|b| !b.is_empty() && !b.ends_with(b"\n"));
    let mut file = OpenOptions::new().create(true).append(true).open(&path)?;
    if needs_newline {
        file.write_all(b"\n")?;
    }
    writeln!(file, "{} {algorithm} {blob}", host_entry(host, port))?;
    Ok(())
}

/// The host field: comma-separated patterns, `!negations`, `*` and `?`
/// wildcards, or a single hashed name (`|1|salt|hash`).
fn hosts_match(field: &str, name: &str) -> bool {
    if let Some(hashed) = field.strip_prefix("|1|") {
        return hashed_match(hashed, name);
    }
    let mut matched = false;
    for pattern in field.split(',') {
        if let Some(negated) = pattern.strip_prefix('!') {
            if wildcard(negated, name) {
                return false;
            }
        } else if wildcard(pattern, name) {
            matched = true;
        }
    }
    matched
}

fn hashed_match(hashed: &str, name: &str) -> bool {
    let mut parts = hashed.split('|');
    let (Some(salt), Some(hash)) = (parts.next(), parts.next()) else {
        return false;
    };
    let (Ok(salt), Ok(hash)) = (BASE64.decode(salt), BASE64.decode(hash)) else {
        return false;
    };
    let Ok(mut mac) = Hmac::<Sha1>::new_from_slice(&salt) else {
        return false;
    };
    mac.update(name.as_bytes());
    mac.verify_slice(&hash).is_ok()
}

fn wildcard(pattern: &str, text: &str) -> bool {
    fn go(p: &[u8], t: &[u8]) -> bool {
        match (p.first(), t.first()) {
            (None, None) => true,
            (Some(b'*'), _) => go(&p[1..], t) || (!t.is_empty() && go(p, &t[1..])),
            (Some(b'?'), Some(_)) => go(&p[1..], &t[1..]),
            (Some(a), Some(b)) if a.eq_ignore_ascii_case(b) => go(&p[1..], &t[1..]),
            _ => false,
        }
    }
    go(pattern.as_bytes(), text.as_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plain_and_wildcard_hosts() {
        assert!(hosts_match("example.com,10.0.0.1", "example.com"));
        assert!(hosts_match("*.example.com", "db.example.com"));
        assert!(!hosts_match(
            "*.example.com,!db.example.com",
            "db.example.com"
        ));
        assert!(hosts_match("[example.com]:2222", "[example.com]:2222"));
        assert!(!hosts_match("example.com", "[example.com]:2222"));
        assert!(hosts_match("host?", "host1"));
    }

    #[test]
    fn hashed_hosts() {
        // Produced by `ssh-keygen -H` for "example.com".
        let salt = BASE64.encode(b"0123456789abcdef0123");
        let mut mac = Hmac::<Sha1>::new_from_slice(b"0123456789abcdef0123").unwrap();
        mac.update(b"example.com");
        let hash = BASE64.encode(mac.finalize().into_bytes());
        let field = format!("|1|{salt}|{hash}");
        assert!(hosts_match(&field, "example.com"));
        assert!(!hosts_match(&field, "example.org"));
    }
}
