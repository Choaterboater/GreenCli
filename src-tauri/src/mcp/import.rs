// Finds MCP servers set up in Casper, Claude Code, ~/.mcp.json, Claude
// Desktop and VS Code,
// so they can be copied into GreenCLI's own list. A port of Casper
// src/mcp/import.ts, with GreenCLI's rules on top:
//
// - Only Rust reads these files, and only the server lists are kept
//   (~/.claude.json also holds history and account data). The files are read,
//   never written.
// - GreenCLI fills in no ${NAME}, so a server that needs one to start is
//   skipped, and an env or header value that is just ${NAME} comes in empty
//   and is listed under "needs".
// - Messages and the preview name files, servers and variables, never a value.
// - Imported servers come in off (not started at launch) with writes off.
//   The first Connect turns on Connect at start.
// - Two servers are the same when the name matches, or the program and its
//   env or headers all match: two tenants of one program are two servers.

use super::client::{same_setup, McpServerDef, McpTransport, McpWrites};
use super::presets::{is_greencli_mcp_file, match_preset, pins, plan_pins, preset_label, PinView};
use serde::Serialize;
use serde_json::{Map, Value};
use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

const CLAUDE_MAX_BYTES: u64 = 32 * 1024 * 1024;
const OTHER_MAX_BYTES: u64 = 4 * 1024 * 1024;
const MAX_SERVERS_PER_FILE: usize = 64;
/// The name GreenCLI's export gives greencli-mcp. Keep in step with
/// mcpExport.ts GREENCLI_SERVER_NAME.
pub const GREENCLI_SERVER_NAME: &str = "greencli";
pub const STALE: &str = "The list changed. Open Import again.";

/// Where a file keeps its servers.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Shape {
    /// {"mcpServers": {...}}: Casper, Claude Code, ~/.mcp.json, Claude Desktop.
    McpServers,
    /// VS Code mcp.json: {"servers": {...}}, comments allowed.
    VsCodeMcp,
    /// VS Code settings.json: {"mcp": {"servers": {...}}}, comments allowed.
    VsCodeSettings,
}

pub struct SourceFile {
    /// Where the server came from, for the dialog: "Casper", "Claude Code"...
    pub label: &'static str,
    /// The file, for problems: "~/.claude.json", "VS Code mcp.json"...
    pub file_label: &'static str,
    pub path: PathBuf,
    pub shape: Shape,
    pub max_bytes: u64,
}

/// Where desktop apps keep their settings on this system: Application
/// Support on macOS, %APPDATA% on Windows, ~/.config elsewhere.
fn app_config_dir(home: &Path) -> PathBuf {
    if cfg!(target_os = "macos") {
        home.join("Library").join("Application Support")
    } else if cfg!(windows) {
        std::env::var_os("APPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join("AppData").join("Roaming"))
    } else {
        home.join(".config")
    }
}

/// VS Code's user folders (stable, then Insiders) on this system.
fn vscode_user_dirs(home: &Path) -> Vec<(PathBuf, bool)> {
    let editions = [("Code", false), ("Code - Insiders", true)];
    let base = app_config_dir(home);
    editions
        .iter()
        .map(|(dir, insiders)| (base.join(dir).join("User"), *insiders))
        .collect()
}

/// Every file GreenCLI looks in, lowest precedence first: VS Code, Claude
/// Desktop, ~/.mcp.json, ~/.claude.json, then ~/.casper/mcp.json. A later file wins
/// when two use the same name. Fixed paths only: nothing comes from the
/// webview.
pub fn default_sources(home: &Path) -> Vec<SourceFile> {
    let mut sources = Vec::new();
    for (dir, insiders) in vscode_user_dirs(home) {
        let (label, settings, mcp) = if insiders {
            (
                "VS Code Insiders",
                "VS Code Insiders settings.json",
                "VS Code Insiders mcp.json",
            )
        } else {
            ("VS Code", "VS Code settings.json", "VS Code mcp.json")
        };
        sources.push(SourceFile {
            label,
            file_label: settings,
            path: dir.join("settings.json"),
            shape: Shape::VsCodeSettings,
            max_bytes: OTHER_MAX_BYTES,
        });
        sources.push(SourceFile {
            label,
            file_label: mcp,
            path: dir.join("mcp.json"),
            shape: Shape::VsCodeMcp,
            max_bytes: OTHER_MAX_BYTES,
        });
    }
    sources.push(SourceFile {
        label: "Claude Desktop",
        file_label: "claude_desktop_config.json",
        path: app_config_dir(home)
            .join("Claude")
            .join("claude_desktop_config.json"),
        shape: Shape::McpServers,
        max_bytes: OTHER_MAX_BYTES,
    });
    sources.push(SourceFile {
        label: "~/.mcp.json",
        file_label: "~/.mcp.json",
        path: home.join(".mcp.json"),
        shape: Shape::McpServers,
        max_bytes: OTHER_MAX_BYTES,
    });
    sources.push(SourceFile {
        label: "Claude Code",
        file_label: "~/.claude.json",
        path: home.join(".claude.json"),
        shape: Shape::McpServers,
        max_bytes: CLAUDE_MAX_BYTES,
    });
    sources.push(SourceFile {
        label: "Casper",
        file_label: "~/.casper/mcp.json",
        path: home.join(".casper").join("mcp.json"),
        shape: Shape::McpServers,
        max_bytes: OTHER_MAX_BYTES,
    });
    sources
}

// ─── Reading ───

enum ReadOutcome {
    Missing,
    TooBig,
    Unreadable,
    Text(String),
}

fn read_capped(path: &Path, max_bytes: u64) -> ReadOutcome {
    let meta = match std::fs::metadata(path) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return ReadOutcome::Missing,
        Err(_) => return ReadOutcome::Unreadable,
    };
    if !meta.is_file() {
        return ReadOutcome::Unreadable;
    }
    if meta.len() > max_bytes {
        return ReadOutcome::TooBig;
    }
    let Ok(file) = std::fs::File::open(path) else {
        return ReadOutcome::Unreadable;
    };
    let mut bytes = Vec::new();
    if file.take(max_bytes + 1).read_to_end(&mut bytes).is_err() {
        return ReadOutcome::Unreadable;
    }
    if bytes.len() as u64 > max_bytes {
        return ReadOutcome::TooBig;
    }
    match String::from_utf8(bytes) {
        // Notepad and some Windows editors start the file with a BOM.
        Ok(text) => ReadOutcome::Text(match text.strip_prefix('\u{feff}') {
            Some(rest) => rest.to_string(),
            None => text,
        }),
        Err(_) => ReadOutcome::Unreadable,
    }
}

/// JSON with comments (// and /* */) and trailing commas, as VS Code allows,
/// turned into plain JSON. Text inside strings is never touched.
pub fn strip_jsonc(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if c == '"' {
            out.push(c);
            i += 1;
            while i < chars.len() {
                let s = chars[i];
                out.push(s);
                i += 1;
                if s == '\\' {
                    if let Some(&next) = chars.get(i) {
                        out.push(next);
                        i += 1;
                    }
                } else if s == '"' {
                    break;
                }
            }
            continue;
        }
        if c == '/' && chars.get(i + 1) == Some(&'/') {
            while i < chars.len() && chars[i] != '\n' {
                i += 1;
            }
            continue;
        }
        if c == '/' && chars.get(i + 1) == Some(&'*') {
            i += 2;
            while i < chars.len() && !(chars[i] == '*' && chars.get(i + 1) == Some(&'/')) {
                i += 1;
            }
            i += 2;
            continue;
        }
        out.push(c);
        i += 1;
    }
    // Trailing commas: a comma followed only by white space before } or ].
    let chars: Vec<char> = out.chars().collect();
    let mut clean = String::with_capacity(out.len());
    let mut in_string = false;
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if in_string {
            clean.push(c);
            if c == '\\' {
                if let Some(&next) = chars.get(i + 1) {
                    clean.push(next);
                    i += 1;
                }
            } else if c == '"' {
                in_string = false;
            }
        } else if c == '"' {
            in_string = true;
            clean.push(c);
        } else if c == ',' {
            let next = chars[i + 1..].iter().find(|c| !c.is_whitespace());
            if !matches!(next, Some('}') | Some(']')) {
                clean.push(c);
            }
        } else {
            clean.push(c);
        }
        i += 1;
    }
    clean
}

// ─── Variables ───

fn is_var_name(s: &str) -> bool {
    let mut chars = s.chars();
    matches!(chars.next(), Some(c) if c.is_ascii_alphabetic() || c == '_')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Field {
    /// command, args, cwd, url: the server can't start without a real value.
    Program,
    /// env and header values: a bare ${NAME} comes in empty, to fill in with Edit.
    Value,
}

/// VS Code and Claude variables into plain text. Err is the skip reason. A
/// value that is only ${NAME} in an env or header field gives Ok("") and
/// adds NAME to `needs`.
fn translate(
    value: &str,
    field: Field,
    home: &str,
    needs: &mut Vec<String>,
) -> Result<String, String> {
    let mut out = String::new();
    let mut refs: Vec<String> = Vec::new();
    let mut rest = value;
    while let Some(start) = rest.find("${") {
        let after = &rest[start + 2..];
        let Some(end) = after.find('}') else { break };
        out.push_str(&rest[..start]);
        let inner = &after[..end];
        rest = &after[end + 1..];
        if inner == "userHome" {
            out.push_str(home);
            continue;
        }
        if inner == "workspaceFolder" {
            return Err("it uses ${workspaceFolder}; GreenCLI can't tell which folder".into());
        }
        if inner.starts_with("input:") {
            return Err("it asks VS Code for a value when it starts".into());
        }
        let inner = match inner.strip_prefix("env:") {
            Some(name) if is_var_name(name) => name,
            _ => inner,
        };
        if inner == "PROJECT_ROOT" {
            return Err("it uses ${PROJECT_ROOT}, a Casper project folder".into());
        }
        if let Some((name, default)) = inner.split_once(":-") {
            if is_var_name(name) {
                out.push_str(default);
                continue;
            }
        }
        if is_var_name(inner) {
            refs.push(inner.to_string());
            continue;
        }
        return Err("it uses a ${...} value GreenCLI can't fill in".into());
    }
    out.push_str(rest);
    let Some(first) = refs.first() else {
        return Ok(out);
    };
    match field {
        Field::Program => Err(format!(
            "it uses ${{{first}}}, which GreenCLI can't fill in"
        )),
        Field::Value if refs.len() == 1 && out.trim().is_empty() => {
            if !needs.contains(first) {
                needs.push(first.clone());
            }
            Ok(String::new())
        }
        Field::Value => Err(format!(
            "it uses ${{{first}}} inside a longer value, which GreenCLI can't fill in"
        )),
    }
}

// ─── Entries ───

struct Entry {
    def: McpServerDef,
    needs: Vec<String>,
    notes: Vec<String>,
}

fn string_map(
    value: Option<&Value>,
    what: &str,
    home: &str,
    needs: &mut Vec<String>,
) -> Result<HashMap<String, String>, String> {
    let Some(value) = value else {
        return Ok(HashMap::new());
    };
    let not_a_map = || format!("its {what} is not a list of names and text values");
    let map = value.as_object().ok_or_else(not_a_map)?;
    let mut out = HashMap::new();
    for (key, item) in map {
        let text = item.as_str().ok_or_else(not_a_map)?;
        out.insert(key.clone(), translate(text, Field::Value, home, needs)?);
    }
    Ok(out)
}

fn expand_tilde(path: &str, home: &str) -> String {
    if path == "~" {
        return home.to_string();
    }
    match path.strip_prefix("~/") {
        Some(rest) => format!("{}/{}", home.trim_end_matches('/'), rest),
        None => path.to_string(),
    }
}

/// One entry in GreenCLI's shape. Unknown keys are dropped.
fn translate_entry(name: &str, value: &Value, home: &str) -> Result<Entry, String> {
    let obj = value.as_object().ok_or("the entry is not an object")?;
    let text = |key: &str| obj.get(key).and_then(Value::as_str);
    if text("type") == Some("sse") || text("transport") == Some("sse") {
        return Err("SSE servers are not supported".into());
    }
    if obj.contains_key("envFile") {
        return Err("envFile is not supported".into());
    }
    let transport = match text("type") {
        Some("http") | Some("streamableHttp") | Some("streamable-http") => McpTransport::Http,
        Some("stdio") => McpTransport::Stdio,
        None if obj.contains_key("url") && !obj.contains_key("command") => McpTransport::Http,
        None => McpTransport::Stdio,
        Some(_) => return Err("its type is not stdio or http".into()),
    };
    let mut needs = Vec::new();
    let mut notes = Vec::new();
    let mut def = McpServerDef {
        name: name.to_string(),
        transport,
        command: String::new(),
        args: Vec::new(),
        env: HashMap::new(),
        cwd: None,
        url: None,
        credentials_env_var: None,
        headers: HashMap::new(),
        enabled: false,
        writes: Some(McpWrites::Off),
        show_opt_in: false,
        wait_for_connect: false,
    };
    match transport {
        McpTransport::Stdio => {
            let command = text("command")
                .filter(|c| !c.trim().is_empty())
                .ok_or("it has no command")?;
            def.command = translate(command, Field::Program, home, &mut needs)?;
            if let Some(args) = obj.get("args") {
                let list = args.as_array().ok_or("its args are not a list of text")?;
                for arg in list {
                    let arg = arg.as_str().ok_or("its args are not a list of text")?;
                    def.args
                        .push(translate(arg, Field::Program, home, &mut needs)?);
                }
            }
            if let Some(cwd) = obj.get("cwd") {
                let cwd = cwd.as_str().ok_or("its folder is not text")?;
                let cwd = translate(cwd, Field::Program, home, &mut needs)?;
                def.cwd = Some(expand_tilde(&cwd, home)).filter(|c| !c.trim().is_empty());
            }
            def.env = string_map(obj.get("env"), "env", home, &mut needs)?;
        }
        McpTransport::Http => {
            let url = text("url").ok_or("it has no web address")?;
            let url = translate(url, Field::Program, home, &mut needs)?;
            let lower = url.trim().to_ascii_lowercase();
            if !lower.starts_with("http://") && !lower.starts_with("https://") {
                return Err("its web address does not start with http:// or https://".into());
            }
            def.url = Some(url.trim().to_string());
            def.headers = string_map(obj.get("headers"), "headers", home, &mut needs)?;
        }
    }
    if obj.get("disabled") == Some(&Value::Bool(true)) {
        notes.push("it was turned off there".to_string());
    }
    Ok(Entry { def, needs, notes })
}

fn valid_name(name: &str) -> bool {
    (1..=64).contains(&name.len())
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-'))
}

/// GreenCLI's own server: importing it would make GreenCLI start itself.
fn is_greencli_own(def: &McpServerDef) -> bool {
    def.name == GREENCLI_SERVER_NAME
        || (def.transport == McpTransport::Stdio
            && def
                .command
                .rsplit(['/', '\\'])
                .next()
                .is_some_and(is_greencli_mcp_file))
}

// ─── Pins on a round trip ───

fn env_pin_at(def: &McpServerDef, key: &str, value: &str) -> bool {
    def.env
        .iter()
        .any(|(k, v)| k.eq_ignore_ascii_case(key) && v == value)
}

/// Where `-e KEY=VALUE` (or `--env`) sits in a container's args.
fn container_pin_at(def: &McpServerDef, key: &str, value: &str) -> Option<usize> {
    let pair = format!("{key}={value}");
    def.args.windows(2).position(|w| {
        matches!(w[0].as_str(), "-e" | "--env") && w[1].eq_ignore_ascii_case(&pair) && {
            // The key's case may differ; the value must match exactly.
            w[1].ends_with(&format!("={value}"))
        }
    })
}

/// GreenCLI's export writes a server's read-only settings into the file while
/// its writes are off. Brought back in, they would keep the server read-only
/// after writes go on, so the whole set is taken out (connect adds it back
/// while writes are off). Part of a set is something the person set: it stays,
/// with a note. Settings that are how GreenCLI recognises the server stay too.
fn strip_baked_pins(def: &mut McpServerDef) -> Option<String> {
    if def.transport != McpTransport::Stdio {
        return None;
    }
    let found = match_preset(def, None)?;
    let set = pins(found.id)?;
    if set.env.is_empty() && set.append_args.is_empty() {
        return None;
    }
    let env_here = |def: &McpServerDef, k: &str, v: &str| {
        env_pin_at(def, k, v) || container_pin_at(def, k, v).is_some()
    };
    let present: Vec<String> = set
        .env
        .iter()
        .filter(|(k, v)| env_here(def, k, v))
        .map(|(k, v)| format!("{k}={v}"))
        .chain(
            set.append_args
                .iter()
                .filter(|a| def.args.iter().any(|x| x == *a))
                .map(|a| a.to_string()),
        )
        .collect();
    if present.is_empty() {
        return None;
    }
    let kept_note = || {
        format!(
            "it keeps read-only settings set there ({}), so it stays read-only even with writes on; remove them with Edit to allow writes",
            present.join(", ")
        )
    };
    if present.len() < set.env.len() + set.append_args.len() {
        return Some(kept_note());
    }
    let mut stripped = def.clone();
    for (key, value) in set.env {
        stripped
            .env
            .retain(|k, v| !(k.eq_ignore_ascii_case(key) && v == value));
        while let Some(i) = container_pin_at(&stripped, key, value) {
            stripped.args.drain(i..i + 2);
        }
    }
    stripped
        .args
        .retain(|a| !set.append_args.contains(&a.as_str()));
    if match_preset(&stripped, None).map(|m| m.id) != Some(found.id) {
        return Some(kept_note());
    }
    *def = stripped;
    Some(
        "read-only settings from an earlier GreenCLI export were taken out; GreenCLI adds them back while writes are off"
            .to_string(),
    )
}

// ─── Scan ───

#[derive(Clone, Debug)]
pub struct Candidate {
    pub def: McpServerDef,
    /// SourceFile.label.
    pub source: String,
    /// ${NAME}s left empty, to fill in with Edit.
    pub needs: Vec<String>,
    /// Short phrases for the dialog ("it was turned off there").
    pub notes: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
pub struct Skipped {
    pub name: String,
    pub source: String,
    pub reason: String,
}

#[derive(Default)]
pub struct Scan {
    /// Highest precedence first.
    pub candidates: Vec<Candidate>,
    pub skipped: Vec<Skipped>,
    /// File-level problems (too big, not JSON...).
    pub problems: Vec<String>,
}

/// The server map of one document, or None (with a problem when it's the wrong shape).
fn server_map<'a>(
    doc: &'a Value,
    source: &SourceFile,
    problems: &mut Vec<String>,
) -> Option<&'a Map<String, Value>> {
    let list = match source.shape {
        Shape::McpServers => doc.get("mcpServers"),
        Shape::VsCodeMcp => doc.get("servers"),
        Shape::VsCodeSettings => doc.get("mcp").and_then(|m| m.get("servers")),
    }?;
    match list.as_object() {
        Some(map) => Some(map),
        None => {
            problems.push(format!(
                "Skipped {}: its server list is not an object.",
                source.file_label
            ));
            None
        }
    }
}

/// Reads every source (lowest precedence first) and compares with the
/// servers GreenCLI already has. Pure apart from reading the files.
pub fn scan(sources: &[SourceFile], home: &Path, existing: &[McpServerDef]) -> Scan {
    let home_text = home.to_string_lossy().to_string();
    let mut out = Scan::default();
    // (place in the scan, candidate), in file order.
    let mut found: Vec<(usize, Candidate)> = Vec::new();
    for source in sources {
        let text = match read_capped(&source.path, source.max_bytes) {
            ReadOutcome::Missing => continue,
            ReadOutcome::TooBig => {
                out.problems.push(format!(
                    "Skipped {}: it is larger than {} MB.",
                    source.file_label,
                    (source.max_bytes / 1024 / 1024).max(1)
                ));
                continue;
            }
            ReadOutcome::Unreadable => {
                out.problems
                    .push(format!("Can't read {}.", source.file_label));
                continue;
            }
            ReadOutcome::Text(text) => text,
        };
        let parsed = match source.shape {
            Shape::McpServers => serde_json::from_str::<Value>(&text),
            Shape::VsCodeMcp | Shape::VsCodeSettings => {
                serde_json::from_str::<Value>(&strip_jsonc(&text))
            }
        };
        let Ok(doc) = parsed else {
            out.problems.push(format!(
                "Can't read {}: it is not valid JSON (it may be in use).",
                source.file_label
            ));
            continue;
        };
        let Some(map) = server_map(&doc, source, &mut out.problems) else {
            continue;
        };
        let mut count = 0;
        for (name, value) in map {
            let skip = |reason: String| Skipped {
                name: name.chars().take(64).collect(),
                source: source.label.to_string(),
                reason,
            };
            if !valid_name(name) {
                out.skipped.push(skip(
                    "a name can only use letters, numbers, dot, dash and underscore".into(),
                ));
                continue;
            }
            if count >= MAX_SERVERS_PER_FILE {
                out.problems.push(format!(
                    "Skipped the rest of {}: more than {} servers.",
                    source.file_label, MAX_SERVERS_PER_FILE
                ));
                break;
            }
            count += 1;
            match translate_entry(name, value, &home_text) {
                Err(reason) => out.skipped.push(skip(reason)),
                Ok(entry) if is_greencli_own(&entry.def) => out
                    .skipped
                    .push(skip("this is GreenCLI's own server".into())),
                Ok(mut entry) => {
                    if let Some(note) = strip_baked_pins(&mut entry.def) {
                        entry.notes.push(note);
                    }
                    found.push((
                        found.len(),
                        Candidate {
                            def: entry.def,
                            source: source.label.to_string(),
                            needs: entry.needs,
                            notes: entry.notes,
                        },
                    ));
                }
            }
        }
    }
    log::info!(
        "MCP import: {} servers found, {} skipped",
        found.len(),
        out.skipped.len()
    );

    // First the files among themselves: the higher file wins a name or a
    // program. Then the winners against what GreenCLI already has, so a
    // lower file's copy never slips in when the winner is already there.
    let skip_of = |c: &Candidate, reason: String| Skipped {
        name: c.def.name.clone(),
        source: c.source.clone(),
        reason,
    };
    // Highest file first; `seq` keeps each server's place in its file.
    found.reverse();
    let mut winners: Vec<(usize, Candidate)> = Vec::new();
    for (seq, c) in found.into_iter() {
        let winners_defs = || winners.iter().map(|(_, k)| k);
        if let Some(winner) = winners_defs().find(|k| k.def.name == c.def.name) {
            let reason = format!("also in {}; using that one", winner.source);
            out.skipped.push(skip_of(&c, reason));
        } else if let Some(winner) = winners_defs().find(|k| same_setup(&k.def, &c.def)) {
            let reason = format!("same server as {} from {}", winner.def.name, winner.source);
            out.skipped.push(skip_of(&c, reason));
        } else {
            winners.push((seq, c));
        }
    }
    let mut kept: Vec<(usize, Candidate)> = Vec::new();
    for (seq, c) in winners {
        if existing.iter().any(|e| e.name == c.def.name) {
            let reason = "a server with this name is already in GreenCLI".to_string();
            out.skipped.push(skip_of(&c, reason));
        } else if let Some(same) = existing.iter().find(|e| same_setup(e, &c.def)) {
            let reason = format!("already in GreenCLI as {}", same.name);
            out.skipped.push(skip_of(&c, reason));
        } else {
            kept.push((seq, c));
        }
    }
    // In file order within each source, highest source first.
    let order: Vec<&str> = sources.iter().rev().map(|s| s.label).collect();
    kept.sort_by_key(|(seq, c)| (order.iter().position(|l| *l == c.source), *seq));
    out.candidates = kept.into_iter().map(|(_, c)| c).collect();
    out
}

// ─── Preview ───

fn is_secret_name(name: &str) -> bool {
    let lower = name.trim_start_matches('-').to_ascii_lowercase();
    if [
        "token",
        "secret",
        "passw",
        "apikey",
        "api_key",
        "api-key",
        "credential",
        "bearer",
        "cookie",
    ]
    .iter()
    .any(|w| lower.contains(w))
    {
        return true;
    }
    lower.split(['-', '_', '.']).any(|part| {
        matches!(
            part,
            "key"
                | "pass"
                | "pwd"
                | "pw"
                | "auth"
                | "creds"
                | "session"
                | "jwt"
                | "pat"
                | "private"
                | "community"
        )
    })
}

/// A token-looking value: 20 or more characters with no path separators and
/// upper case, lower case and digits mixed in, or a long hex string.
fn token_shaped(value: &str) -> bool {
    if value.len() < 20 || value.contains(['/', '\\', ' ']) {
        return false;
    }
    let hex = value.len() >= 32 && value.chars().all(|c| c.is_ascii_hexdigit() || c == '-');
    let mixed = value.chars().any(|c| c.is_ascii_uppercase())
        && value.chars().any(|c| c.is_ascii_lowercase())
        && value.chars().any(|c| c.is_ascii_digit());
    hex || mixed
}

/// scheme://host[:port] of a web address, or None.
fn url_origin(url: &str) -> Option<String> {
    let parsed = reqwest::Url::parse(url.trim()).ok()?;
    let host = parsed.host_str()?;
    Some(match parsed.port() {
        Some(port) => format!("{}://{}:{}", parsed.scheme(), host, port),
        None => format!("{}://{}", parsed.scheme(), host),
    })
}

fn mask_value(value: &str) -> String {
    if value.contains("://") {
        return url_origin(value).unwrap_or_else(|| "…".into());
    }
    let lower = value.to_ascii_lowercase();
    if token_shaped(value)
        || lower.contains("bearer ")
        || value.split_whitespace().any(token_shaped)
    {
        return "…".into();
    }
    value.to_string()
}

fn is_env_pair(arg: &str) -> bool {
    arg.split_once('=')
        .is_some_and(|(name, _)| is_var_name(name) && !name.is_empty())
}

fn is_flag(arg: &str) -> bool {
    arg.len() > 1 && arg.starts_with('-') && !arg[1..].starts_with(|c: char| c.is_ascii_digit())
}

fn is_env_flag(flag: &str) -> bool {
    matches!(flag, "-e" | "--env")
}

fn is_header_flag(flag: &str) -> bool {
    matches!(flag, "-H" | "--header" | "--headers")
}

/// A value safe to show after a flag: a number, a path, or a package-like
/// word ("stdio", "python3.11", "@scope/pkg"). Anything else could be a short
/// password ("-p hunter2"), so it is hidden.
fn safe_shape(value: &str) -> bool {
    if value.is_empty() || value.contains(char::is_whitespace) {
        return false;
    }
    let number = value
        .chars()
        .all(|c| c.is_ascii_digit() || matches!(c, '.' | ':'))
        && value.chars().any(|c| c.is_ascii_digit());
    let path = (value.starts_with(['/', '.', '~']) || value.contains(['/', '\\']))
        && !value.split(['/', '\\', ':']).any(token_shaped);
    let word_chars = value.chars().all(|c| {
        c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '-' | '_' | '.' | '@' | ':')
    });
    let has_digit = value.chars().any(|c| c.is_ascii_digit());
    let word = word_chars
        && value.starts_with(|c: char| c.is_ascii_lowercase() || c == '@')
        && (!has_digit || value.contains(['.', '@', ':']));
    number || path || word
}

/// A value after a flag (or in --flag=value): a web address shows its
/// origin, a safe shape shows, anything else is "…".
fn flag_value(value: &str) -> String {
    if value.contains("://") {
        return url_origin(value).unwrap_or_else(|| "…".into());
    }
    if safe_shape(value) {
        value.to_string()
    } else {
        "…".into()
    }
}

/// An env pair as KEY=…, or None.
fn masked_pair(arg: &str) -> Option<String> {
    is_env_pair(arg).then(|| format!("{}=…", arg.split_once('=').unwrap_or_default().0))
}

/// What a server runs, for the dialog: the program as written (and its folder) and its args,
/// or the web address's scheme and host. Values after a flag show only when
/// they are numbers, paths or package-like words; env pairs, headers and
/// token-looking parts become "…".
pub fn runs_line(def: &McpServerDef) -> String {
    if def.transport == McpTransport::Http {
        return def
            .url
            .as_deref()
            .and_then(url_origin)
            .unwrap_or_else(|| "a web address".into());
    }
    // A path shows as written, so an unexpected copy of a familiar program stands out.
    let mut words = vec![def.command.clone()];
    let mut previous: Option<&str> = None;
    for arg in &def.args {
        let after_flag = previous.filter(|p| is_flag(p) && !p.contains('='));
        let shown = if is_flag(arg) {
            match arg.split_once('=') {
                None => arg.clone(),
                Some((flag, value)) => {
                    let value = if is_secret_name(flag) || is_header_flag(flag) {
                        "…".to_string()
                    } else if let Some(pair) = masked_pair(value).filter(|_| is_env_flag(flag)) {
                        pair
                    } else {
                        flag_value(value)
                    };
                    format!("{flag}={value}")
                }
            }
        } else if let Some(pair) = masked_pair(arg) {
            pair
        } else if let Some(flag) = after_flag {
            if is_secret_name(flag) || is_header_flag(flag) {
                "…".to_string()
            } else {
                flag_value(arg)
            }
        } else if arg.contains(": ") {
            // A header written as one arg ("X-Key: value").
            "…".to_string()
        } else {
            mask_value(arg)
        };
        words.push(shown);
        previous = Some(arg.as_str());
    }
    if let Some(cwd) = def.cwd.as_deref().filter(|c| !c.is_empty()) {
        words.push(format!("(in {cwd})"));
    }
    let line = words.join(" ");
    if line.chars().count() > 300 {
        format!("{}…", line.chars().take(299).collect::<String>())
    } else {
        line
    }
}

/// One server in the dialog. Never carries an env, header or arg value.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewItem {
    pub id: String,
    pub name: String,
    pub source: String,
    pub transport: &'static str,
    /// Product name when GreenCLI knows the server ("Central").
    pub preset: Option<String>,
    /// What connect adds while writes are off.
    pub pins: PinView,
    pub needs: Vec<String>,
    pub notes: Vec<String>,
    pub runs: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct ImportPreview {
    pub token: String,
    pub items: Vec<PreviewItem>,
    pub skipped: Vec<Skipped>,
    pub problems: Vec<String>,
}

fn preview_item(c: &Candidate) -> PreviewItem {
    let found = match_preset(&c.def, None);
    PreviewItem {
        id: c.def.name.clone(),
        name: c.def.name.clone(),
        source: c.source.clone(),
        transport: match c.def.transport {
            McpTransport::Stdio => "stdio",
            McpTransport::Http => "http",
        },
        preset: found.map(|m| preset_label(m.id).to_string()),
        pins: found.map_or(PinView::None, |m| {
            PinView::of(&plan_pins(&c.def, m.id), false)
        }),
        needs: c.needs.clone(),
        notes: c.notes.clone(),
        runs: runs_line(&c.def),
    }
}

pub fn preview(scan: &Scan, token: String) -> ImportPreview {
    ImportPreview {
        token,
        items: scan.candidates.iter().map(preview_item).collect(),
        skipped: scan.skipped.clone(),
        problems: scan.problems.clone(),
    }
}

// ─── The list the person saw ───

struct Pending {
    token: String,
    candidates: Vec<Candidate>,
}

/// How many scans stay usable: the one-time offer and the Import button can
/// each have a dialog open, and one must not make the other stale.
const KEPT_SCANS: usize = 4;

/// The last few scans, kept in Rust so an import saves exactly what the
/// dialog showed even if a file changes in between. Values never go to the
/// webview.
#[derive(Default)]
pub struct ImportBook {
    pending: Mutex<Vec<Pending>>,
}

impl ImportBook {
    /// Keep a scan (dropping the oldest past KEPT_SCANS) and return its preview.
    pub fn keep(&self, scan: Scan) -> ImportPreview {
        let token = format!("{:016x}", rand::random::<u64>());
        let shown = preview(&scan, token.clone());
        if let Ok(mut pending) = self.pending.lock() {
            pending.push(Pending {
                token,
                candidates: scan.candidates,
            });
            let extra = pending.len().saturating_sub(KEPT_SCANS);
            pending.drain(..extra);
        }
        shown
    }

    /// The servers with these ids from the kept scan, once. A stale token or
    /// an unknown id gives STALE and nothing.
    pub fn take(&self, token: &str, ids: &[String]) -> Result<Vec<McpServerDef>, String> {
        let mut pending = self.pending.lock().map_err(|_| STALE.to_string())?;
        let Some(at) = pending.iter().position(|p| p.token == token) else {
            return Err(STALE.into());
        };
        let mut defs = Vec::new();
        for id in ids {
            match pending[at].candidates.iter().find(|c| c.def.name == *id) {
                Some(c) => defs.push(c.def.clone()),
                None => return Err(STALE.into()),
            }
        }
        pending.remove(at);
        Ok(defs)
    }
}
