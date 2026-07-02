// Minimal ~/.ssh/config parser — turns Host blocks into importable sessions.
//
// Supports the keywords network engineers actually use: HostName, User, Port,
// IdentityFile, ProxyJump. Wildcard/`Match`/default blocks (Host *, patterns
// with * or ?) are skipped — they're defaults, not concrete hosts.

use serde::Serialize;
use std::path::PathBuf;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedHost {
    /// The Host alias (what the user types `ssh <name>`).
    pub name: String,
    /// HostName (defaults to the alias when unset).
    pub host: String,
    pub port: u16,
    pub username: Option<String>,
    pub identity_file: Option<String>,
    /// ProxyJump target (`user@host:port` or `host`).
    pub jump_host: Option<String>,
}

#[derive(Default)]
struct Block {
    aliases: Vec<String>,
    hostname: Option<String>,
    user: Option<String>,
    port: Option<u16>,
    identity_file: Option<String>,
    proxy_jump: Option<String>,
}

fn is_wildcard(s: &str) -> bool {
    s.contains('*') || s.contains('?') || s == "*"
}

fn expand_tilde(p: &str) -> String {
    if let Some(rest) = p.strip_prefix("~/") {
        if let Some(home) = home_dir() {
            return home.join(rest).to_string_lossy().to_string();
        }
    }
    p.to_string()
}

pub fn home_dir() -> Option<PathBuf> {
    std::env::var("HOME")
        .ok()
        .or_else(|| std::env::var("USERPROFILE").ok())
        .map(PathBuf::from)
}

pub fn default_config_path() -> Option<PathBuf> {
    home_dir().map(|h| h.join(".ssh").join("config"))
}

fn finish(block: &Block, out: &mut Vec<ImportedHost>) {
    for alias in &block.aliases {
        if is_wildcard(alias) {
            continue;
        }
        out.push(ImportedHost {
            name: alias.clone(),
            host: block.hostname.clone().unwrap_or_else(|| alias.clone()),
            port: block.port.unwrap_or(22),
            username: block.user.clone(),
            identity_file: block.identity_file.clone().map(|p| expand_tilde(&p)),
            jump_host: block.proxy_jump.clone().filter(|j| j != "none"),
        });
    }
}

/// Parse ssh_config text into importable hosts.
pub fn parse(content: &str) -> Vec<ImportedHost> {
    let mut out = Vec::new();
    let mut block: Option<Block> = None;

    for raw in content.lines() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        // Keyword + value, separated by whitespace or '='. The split consumes
        // only the FIRST separator, so `Keyword = value` leaves a leading '='
        // on the value — strip it or hostnames become '= example.com' and
        // numeric fields (Port) silently fail to parse.
        let (kw, val) = match line.split_once(|c: char| c.is_whitespace() || c == '=') {
            Some((k, v)) => {
                let v = v.trim_start();
                let v = v.strip_prefix('=').unwrap_or(v);
                (k.trim().to_lowercase(), v.trim().trim_matches('"').to_string())
            }
            None => continue,
        };
        if val.is_empty() {
            continue;
        }

        match kw.as_str() {
            "host" => {
                if let Some(b) = block.take() {
                    finish(&b, &mut out);
                }
                let aliases = val.split_whitespace().map(|s| s.to_string()).collect();
                block = Some(Block {
                    aliases,
                    ..Default::default()
                });
            }
            "match" => {
                // Defaults/conditionals — flush current and ignore the match block.
                if let Some(b) = block.take() {
                    finish(&b, &mut out);
                }
            }
            _ => {
                if let Some(b) = block.as_mut() {
                    match kw.as_str() {
                        "hostname" => b.hostname = Some(val),
                        "user" => b.user = Some(val),
                        "port" => b.port = val.parse().ok(),
                        "identityfile" => b.identity_file = Some(val),
                        "proxyjump" => b.proxy_jump = Some(val),
                        _ => {}
                    }
                }
            }
        }
    }
    if let Some(b) = block.take() {
        finish(&b, &mut out);
    }
    out
}
