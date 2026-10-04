// Casper as the AI behind the AI panel: the pure parts.
//
// Casper (the owner's AI coding agent) answers a question in one shot with
// `casper --json [options] -`: the question on stdin, JSON Lines on stdout,
// and an exit code that says how the run ended. This module decides what
// GreenCLI sends and how it reads the answer. It touches no Tauri and no
// tokio, so it moves to Tauri 2 unchanged:
//
// - which options a Casper command may hold, and the ones GreenCLI adds;
// - finding the program, and checking its version (0.2.21 or newer);
// - a fail-closed scan for `sandbox: off` in Casper's own config files;
// - which working folders are allowed;
// - refusing to start while a local port leads into the network, and
//   counting runs so none is opened while Casper answers;
// - reading the JSON Lines and turning a finished run into the reply.
//
// Casper facts used here are from Casper v0.2.21 (commit ad678b6):
// src/cli-args.ts (options), src/app/json-events.ts (events, receipt),
// src/task/result.ts (exit codes), src/config/load.ts and
// src/config/profile.ts (sandbox setting, profile choice).

use serde_json::Value;
use std::collections::HashSet;
use std::ffi::{OsStr, OsString};
use std::fmt;
use std::net::IpAddr;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

/// A Casper version, as `casper --version` prints it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct CasperVersion(pub u32, pub u32, pub u32);

impl fmt::Display for CasperVersion {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}.{}.{}", self.0, self.1, self.2)
    }
}

/// The oldest Casper GreenCLI starts. 0.2.17 to 0.2.20 brought the one-shot
/// refusals GreenCLI relies on (the shell, other machines, writes outside the
/// project), and 0.2.21 is the first release that has them all. Builds in
/// between report 0.2.15.
pub const MIN_VERSION: CasperVersion = CasperVersion(0, 2, 21);
/// `--max-turns` GreenCLI adds when the command doesn't set one.
pub const DEFAULT_MAX_TURNS: &str = "20";
/// How long one question may run.
pub const TIMEOUT: Duration = Duration::from_secs(600);
/// How long `casper --version` may run.
pub const VERSION_TIMEOUT: Duration = Duration::from_secs(15);
/// The folder under GreenCLI's cache folder that holds the per-question folders.
pub const WORK_ROOT_NAME: &str = "casper-work";

/// Shown when GreenCLI can't find Casper.
pub const NOT_INSTALLED: &str = "Casper isn't installed, or GreenCLI can't find it. Install Casper, then try again. If it's installed somewhere else, put its full path in Settings → AI & MCP → Casper command.";

// ─── Program names ───

/// The file name of a path, split on both `/` and `\` whatever the OS.
fn last_segment(argv0: &str) -> &str {
    argv0.rsplit(['/', '\\']).next().unwrap_or(argv0)
}

/// True for `casper` or `casper.exe`, bare or as a full path, in any case.
pub fn is_casper_program(argv0: &str) -> bool {
    let name = last_segment(argv0).to_ascii_lowercase();
    name.strip_suffix(".exe").unwrap_or(&name) == "casper"
}

const BATCH_SHIM: &str = "On Windows, GreenCLI starts Casper only as casper.exe, not a .cmd or .bat file. Put the full path to casper.exe in Settings → AI & MCP → Casper command.";

/// A `casper.cmd` / `casper.bat` would run through cmd.exe, which re-reads the
/// arguments as a shell would. Only the real program is started.
pub fn refuse_batch_shim(argv0: &str) -> Result<(), String> {
    let name = last_segment(argv0).to_ascii_lowercase();
    let stem = name
        .strip_suffix(".cmd")
        .or_else(|| name.strip_suffix(".bat"));
    if stem == Some("casper") {
        return Err(BATCH_SHIM.to_string());
    }
    Ok(())
}

/// The Casper provider only starts Casper itself, never a launcher such as
/// `bun …/cli.ts` or `env casper` that would run something else.
pub fn refuse_not_casper(argv0: &str) -> Result<(), String> {
    if is_casper_program(argv0) {
        return Ok(());
    }
    Err("The Casper command must start Casper itself: casper, or the full path to casper (casper.exe on Windows). To run Casper from a source checkout, link src/cli.ts to ~/.local/bin/casper, as Casper's README says.".to_string())
}

// ─── Options ───

const EFFORTS: [&str; 8] = [
    "auto", "off", "minimal", "low", "medium", "high", "xhigh", "max",
];

/// Splits `--x=v` at the first `=`; anything else comes back whole.
fn split_inline(tok: &str) -> (&str, Option<&str>) {
    if tok.starts_with("--") {
        if let Some(i) = tok.find('=') {
            return (&tok[..i], Some(&tok[i + 1..]));
        }
    }
    (tok, None)
}

fn is_turn_count(v: &str) -> bool {
    let b = v.as_bytes();
    !b.is_empty() && b.len() <= 4 && b[0] != b'0' && b.iter().all(u8::is_ascii_digit)
}

/// Turn the user's Casper command into the argv GreenCLI runs:
/// `[program, "--json", <kept options>, ("--no-verify"), ("--max-turns", "20"), "-"]`.
/// Options that would turn off the sandbox, change the folder, reuse a
/// conversation, connect Casper's own servers, or print help are refused, and
/// so is anything that isn't an option (the question goes on stdin). Reads no
/// environment and no files.
pub fn normalize_cli_argv(argv: &[String]) -> Result<Vec<String>, String> {
    let Some(program) = argv.first() else {
        return Err("Empty CLI command".to_string());
    };
    let mut kept: Vec<String> = Vec::new();
    let mut verify_seen = false;
    let mut turns_seen = false;
    let (mut verify, mut no_verify, mut require) = (false, false, false);
    let mut model_effort = false;
    let mut effort_seen = false;
    let mut i = 1;
    while i < argv.len() {
        let tok = argv[i].as_str();
        i += 1;
        let (name, inline) = split_inline(tok);
        match name {
            "--no-sandbox" => {
                return Err("GreenCLI won't turn off Casper's sandbox. Remove --no-sandbox from the Casper command in Settings → AI & MCP.".to_string());
            }
            "--cd" => {
                return Err(
                    "Pick Casper's working folder in Settings → AI & MCP instead of using --cd."
                        .to_string(),
                );
            }
            "--continue" | "--resume" => {
                return Err(format!("GreenCLI starts a new Casper conversation for each question. Remove {name} from the Casper command."));
            }
            "--mcp" | "--lsp" => {
                return Err(format!("GreenCLI doesn't connect Casper's servers from the AI panel. Remove {name} from the Casper command."));
            }
            "--help" | "-h" | "--version" | "-v" | "--licenses" => {
                return Err(format!("Remove {name} from the Casper command. GreenCLI needs Casper to answer, not print help or its version."));
            }
            "--" if inline.is_none() => {
                return Err(
                    "Remove \"--\" from the Casper command. Your question is sent separately."
                        .to_string(),
                );
            }
            _ => {}
        }
        let takes_value = matches!(name, "--model" | "--effort" | "--max-turns");
        if inline.is_some() && !takes_value {
            return Err(unknown_option(tok));
        }
        match name {
            "-" | "-p" | "--print" | "--quiet" | "-q" | "--json" => {}
            "--verify" | "--no-verify" | "--require-verification" => {
                verify_seen = true;
                verify |= name == "--verify";
                no_verify |= name == "--no-verify";
                require |= name == "--require-verification";
                kept.push(name.to_string());
            }
            "--verbose" => kept.push(name.to_string()),
            "--model" | "--effort" | "--max-turns" => {
                let value = match inline {
                    Some(v) => v,
                    None => match argv.get(i) {
                        Some(v) if !v.starts_with('-') => {
                            i += 1;
                            v.as_str()
                        }
                        _ => "",
                    },
                };
                if value.is_empty() || value.starts_with('-') {
                    return Err(format!("{name} needs a value."));
                }
                match name {
                    "--model" => {
                        if value.chars().any(char::is_whitespace) {
                            return Err("--model can't hold spaces.".to_string());
                        }
                        model_effort |= value.contains(':');
                    }
                    "--effort" => {
                        if !EFFORTS.contains(&value) {
                            return Err("--effort must be one of auto, off, minimal, low, medium, high, xhigh, max.".to_string());
                        }
                        effort_seen = true;
                    }
                    _ => {
                        if !is_turn_count(value) {
                            return Err(
                                "--max-turns needs a whole number from 1 to 9999.".to_string()
                            );
                        }
                        turns_seen = true;
                    }
                }
                kept.push(name.to_string());
                kept.push(value.to_string());
            }
            _ if name.starts_with('-') => return Err(unknown_option(tok)),
            _ => {
                return Err(format!("The Casper command can only hold options. Remove \"{tok}\": your question is sent separately."));
            }
        }
    }
    if verify && no_verify {
        return Err("Use --verify or --no-verify, not both.".to_string());
    }
    if require && no_verify {
        return Err("--require-verification can't be used with --no-verify.".to_string());
    }
    if model_effort && effort_seen {
        return Err("Give the effort in --model or in --effort, not both.".to_string());
    }
    let mut out = vec![program.clone(), "--json".to_string()];
    out.extend(kept);
    if !verify_seen {
        out.push("--no-verify".to_string());
    }
    if !turns_seen {
        out.push("--max-turns".to_string());
        out.push(DEFAULT_MAX_TURNS.to_string());
    }
    out.push("-".to_string());
    Ok(out)
}

fn unknown_option(tok: &str) -> String {
    format!("GreenCLI doesn't know the Casper option {tok}. Remove it from the Casper command in Settings → AI & MCP.")
}

// ─── Finding the program ───

/// PATH for a CLI started from a GUI app (unix): the current PATH first, then
/// ~/.local/bin, ~/.cargo/bin, ~/.bun/bin, /usr/local/bin and /opt/homebrew/bin
/// when missing. GUI apps get a minimal PATH, and a Casper source checkout runs
/// through Bun (`#!/usr/bin/env -S bun …`).
#[cfg_attr(not(unix), allow(dead_code))]
pub fn augmented_path(current: &OsStr, home: Option<&Path>) -> OsString {
    let mut parts: Vec<PathBuf> = std::env::split_paths(current).collect();
    let mut extra: Vec<PathBuf> = Vec::new();
    if let Some(home) = home {
        for sub in [".local/bin", ".cargo/bin", ".bun/bin"] {
            extra.push(home.join(sub));
        }
    }
    extra.push(PathBuf::from("/usr/local/bin"));
    extra.push(PathBuf::from("/opt/homebrew/bin"));
    for p in extra {
        if !parts.contains(&p) {
            parts.push(p);
        }
    }
    std::env::join_paths(parts).unwrap_or_else(|_| current.to_os_string())
}

/// Where Casper's Windows installer puts casper.exe.
pub fn windows_fallback_program(local_app_data: Option<&OsStr>) -> Option<PathBuf> {
    let base = local_app_data.filter(|v| !v.is_empty())?;
    Some(
        Path::new(base)
            .join("Programs")
            .join("casper")
            .join("casper.exe"),
    )
}

/// Resolve the program to an absolute file before the working folder changes.
/// A path is used as given (it must be absolute); a bare name is looked up in
/// the absolute PATH entries only. `Ok(None)` means not found.
pub fn resolve_program(
    argv0: &str,
    path: &OsStr,
    windows: bool,
    local_app_data: Option<&OsStr>,
    exists: &dyn Fn(&Path) -> bool,
) -> Result<Option<PathBuf>, String> {
    if argv0.contains('/') || argv0.contains('\\') {
        let p = Path::new(argv0);
        if !p.is_absolute() {
            return Err("Use the full path to Casper (for example /Users/you/.local/bin/casper), not a relative one.".to_string());
        }
        return Ok(exists(p).then(|| p.to_path_buf()));
    }
    let lower = argv0.to_ascii_lowercase();
    let name = if windows && !lower.ends_with(".exe") {
        format!("{argv0}.exe")
    } else {
        argv0.to_string()
    };
    let stem = lower.strip_suffix(".exe").unwrap_or(&lower).to_string();
    let mut shim_seen = false;
    for dir in std::env::split_paths(path) {
        if !dir.is_absolute() {
            continue;
        }
        let candidate = dir.join(&name);
        if exists(&candidate) {
            return Ok(Some(candidate));
        }
        if windows {
            shim_seen |= ["cmd", "bat"]
                .iter()
                .any(|ext| exists(&dir.join(format!("{stem}.{ext}"))));
        }
    }
    if windows {
        if shim_seen {
            return Err(BATCH_SHIM.to_string());
        }
        if let Some(p) = windows_fallback_program(local_app_data).filter(|p| exists(p)) {
            return Ok(Some(p));
        }
    }
    Ok(None)
}

// ─── Version ───

/// `casper 0.2.21 (/path/to/casper)` → 0.2.21. Only the first line counts.
pub fn parse_version(stdout: &str) -> Option<CasperVersion> {
    let line = stdout.lines().next()?.trim();
    let rest = line.strip_prefix("casper ")?;
    let word = rest.split_whitespace().next()?;
    let lead: String = word
        .chars()
        .take_while(|c| c.is_ascii_digit() || *c == '.')
        .collect();
    let parts: Vec<&str> = lead.trim_end_matches('.').split('.').collect();
    if parts.len() != 3 {
        return None;
    }
    let n = |s: &str| s.parse::<u32>().ok();
    Some(CasperVersion(n(parts[0])?, n(parts[1])?, n(parts[2])?))
}

/// Why this Casper can't be used, or None when its version is fine.
pub fn version_problem(
    found: Option<CasperVersion>,
    program: &str,
    exit: Option<i32>,
    stderr_hint: &str,
) -> Option<String> {
    match found {
        None if !stderr_hint.trim().is_empty() => {
            let code = exit.map_or_else(|| "none".to_string(), |c| c.to_string());
            Some(format!(
                "GreenCLI ran \"{program} --version\" but couldn't read a Casper version (exit {code}). It said: {}. If you run Casper from a source checkout, check that Bun is installed.",
                stderr_hint.trim()
            ))
        }
        None => Some(format!(
            "GreenCLI ran \"{program} --version\" but couldn't read a Casper version. Check that the Casper command in Settings → AI & MCP starts Casper."
        )),
        Some(v) if v < MIN_VERSION => Some(format!(
            "This Casper says it is version {v}. GreenCLI needs Casper {MIN_VERSION} or newer. Install the latest Casper (or pull the latest source), then try again."
        )),
        Some(_) => None,
    }
}

/// Resolved program paths that passed the version check this session.
pub fn version_cache() -> &'static Mutex<HashSet<PathBuf>> {
    static CACHE: OnceLock<Mutex<HashSet<PathBuf>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashSet::new()))
}

// ─── Sandbox setting (fail closed) ───

/// What a Casper config file says about the sandbox.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SandboxScan {
    On,
    Off,
    Unsure,
}

/// The line without a `#` comment (a `#` at the start or after a space,
/// outside quotes), trimmed at the end.
fn strip_comment(line: &str) -> &str {
    let (mut single, mut double) = (false, false);
    let mut prev_space = true;
    for (i, c) in line.char_indices() {
        match c {
            '\'' if !double => single = !single,
            '"' if !single => double = !double,
            '#' if !single && !double && prev_space => return line[..i].trim_end(),
            _ => {}
        }
        prev_space = c.is_whitespace();
    }
    line.trim_end()
}

/// Strip one pair of matching quotes.
fn unquote(v: &str) -> &str {
    let v = v.trim();
    let b = v.as_bytes();
    if b.len() >= 2 && (b[0] == b'"' || b[0] == b'\'') && b[b.len() - 1] == b[0] {
        &v[1..v.len() - 1]
    } else {
        v
    }
}

/// YAML features this scan doesn't follow: anchors, aliases, merge keys, tags.
fn has_yaml_magic(s: &str) -> bool {
    if s.contains("<<") {
        return true;
    }
    let (mut single, mut double) = (false, false);
    let mut prev: Option<char> = None;
    for c in s.chars() {
        match c {
            '\'' if !double => single = !single,
            '"' if !single => double = !double,
            '&' | '*' | '!'
                if !single
                    && !double
                    && prev.is_none_or(|p| {
                        p.is_whitespace() || matches!(p, '[' | '{' | ',' | ':')
                    }) =>
            {
                return true;
            }
            _ => {}
        }
        prev = Some(c);
    }
    false
}

/// The text to scan: without a leading byte order mark, which YAML drops
/// (Windows editors often save one). None when the text holds anything the
/// line scan can't follow: a mark anywhere else, or a lone `\r` line break.
fn scan_text(yaml: &str) -> Option<&str> {
    let text = yaml.strip_prefix('\u{feff}').unwrap_or(yaml);
    let lone_cr = text
        .char_indices()
        .any(|(i, c)| c == '\r' && text.as_bytes().get(i + 1) != Some(&b'\n'));
    (!text.contains('\u{feff}') && !lone_cr).then_some(text)
}

/// A key the scan reads as written: ASCII letters, digits, `_` and `-`.
/// Anything else (escapes in a quoted key, `{`, `?`, `<<`) is left to the
/// caller to treat as unknown, never as some other key.
fn is_plain_key(key: &str) -> bool {
    !key.is_empty()
        && key
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-'))
}

/// `---` or `...` with nothing after it (comments already removed).
fn is_bare_marker(line: &str) -> bool {
    line == "---" || line == "..."
}

/// A YAML list item line (`- x` or a bare `-`), indent already removed.
fn is_list_item(content: &str) -> bool {
    content == "-" || content.starts_with("- ")
}

/// A top-level `key: value` line, as (unquoted key, value). None for other lines.
fn top_level_pair(line: &str) -> Option<(&str, &str)> {
    if line.starts_with(char::is_whitespace) {
        return None;
    }
    let bytes = line.as_bytes();
    let mut i = 0;
    let (mut single, mut double) = (false, false);
    while i < bytes.len() {
        match bytes[i] {
            b'\'' if !double => single = !single,
            b'"' if !single => double = !double,
            b':' if !single && !double => {
                let next = bytes.get(i + 1);
                if next.is_none() || next.is_some_and(|b| b.is_ascii_whitespace()) {
                    return Some((unquote(line[..i].trim_end()), line[i + 1..].trim()));
                }
            }
            _ => {}
        }
        i += 1;
    }
    None
}

fn is_true(v: &str) -> bool {
    v.eq_ignore_ascii_case("true") || v == "on"
}

fn is_false(v: &str) -> bool {
    v.eq_ignore_ascii_case("false") || v == "off"
}

/// `{ allowedDomains: [x], enabled: true }`: On unless `enabled` is there and
/// isn't plainly true.
fn scan_flow_mapping(v: &str) -> SandboxScan {
    let Some(inner) = v.strip_prefix('{').and_then(|s| s.strip_suffix('}')) else {
        return SandboxScan::Unsure;
    };
    if inner.contains('{') || has_yaml_magic(inner) {
        return SandboxScan::Unsure;
    }
    for part in inner.split(',') {
        let Some((key, value)) = part.split_once(':') else {
            continue;
        };
        if unquote(key) == "enabled" {
            if unquote(value) != "true" {
                return SandboxScan::Unsure;
            }
        } else if key.contains("enabled") && !key.contains('[') {
            return SandboxScan::Unsure;
        }
    }
    SandboxScan::On
}

/// Does this Casper config file turn the sandbox off? A line scan of the
/// top-level `sandbox:` key that answers Unsure for anything it can't follow,
/// so GreenCLI fails closed. No `sandbox:` key means On.
pub fn scan_sandbox_setting(yaml: &str) -> SandboxScan {
    let Some(yaml) = scan_text(yaml) else {
        return SandboxScan::Unsure;
    };
    let mut seen_content = false;
    let mut in_block = false;
    // Indent of the sandbox mapping's own keys, set by its first line.
    let mut block_indent: Option<usize> = None;
    // The last of the mapping's own keys had no value on its line (a list
    // may follow at the same indent, as in `allowedDomains:` then `- a.com`).
    let mut open_key = false;
    let mut found = false;
    let mut result = SandboxScan::On;
    for raw in yaml.lines() {
        let line = strip_comment(raw);
        let content = line.trim_start();
        if content.is_empty() {
            continue;
        }
        if line.starts_with("---") || line.starts_with("...") {
            // Only a bare marker at the start: `--- {sandbox: off}` holds a document.
            if seen_content || !is_bare_marker(line) {
                return SandboxScan::Unsure;
            }
            continue;
        }
        seen_content = true;
        let indent = line.len() - content.len();
        if indent == 0 {
            if in_block && block_indent.is_none() && line.starts_with('-') {
                // `sandbox:` followed by a list at the same indent.
                return SandboxScan::Unsure;
            }
            in_block = false;
            if line.starts_with(['{', '[', '?']) || line.starts_with("<<") {
                if line.contains("sandbox") || line.starts_with("<<") {
                    return SandboxScan::Unsure;
                }
                continue;
            }
            let Some((key, value)) = top_level_pair(line) else {
                if line.contains("sandbox") {
                    return SandboxScan::Unsure;
                }
                continue;
            };
            if !is_plain_key(key) {
                // `"sand\x62ox": off` is the sandbox key to YAML.
                return SandboxScan::Unsure;
            }
            if key != "sandbox" {
                continue;
            }
            if found || has_yaml_magic(value) {
                return SandboxScan::Unsure;
            }
            found = true;
            let v = unquote(value);
            if value.is_empty() {
                in_block = true;
                block_indent = None;
                open_key = false;
            } else if is_true(v) {
                result = SandboxScan::On;
            } else if is_false(v) {
                return SandboxScan::Off;
            } else if value.starts_with('{') {
                result = scan_flow_mapping(value);
                if result == SandboxScan::Unsure {
                    return result;
                }
            } else {
                return SandboxScan::Unsure;
            }
        } else if in_block {
            if has_yaml_magic(content) {
                return SandboxScan::Unsure;
            }
            let own = *block_indent.get_or_insert(indent);
            if indent < own {
                return SandboxScan::Unsure;
            }
            if indent > own {
                // A value of one of the mapping's keys (a list item, say).
                continue;
            }
            if is_list_item(content) && open_key {
                // The list of the key above, written at the same indent.
                continue;
            }
            // One of the mapping's own lines: it must be a plain `key: value`
            // (`sandbox:` then an indented plain `off` is the scalar "off",
            // and `{enabled: false}` is a flow mapping).
            let Some((key, value)) = top_level_pair(content) else {
                return SandboxScan::Unsure;
            };
            if !is_plain_key(key) {
                return SandboxScan::Unsure;
            }
            open_key = value.is_empty();
            if key == "enabled" {
                let v = unquote(value);
                if is_false(v) {
                    return SandboxScan::Off;
                }
                if v != "true" {
                    return SandboxScan::Unsure;
                }
            }
        }
    }
    result
}

/// Where a `profile:` setting GreenCLI couldn't read is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProfileSource {
    /// The working folder's `.casper/project.yaml`.
    Project,
    /// `~/.casper/config.yaml`.
    Global,
}

/// Why GreenCLI can't tell which profile Casper will load.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProfileError {
    /// A name that breaks Casper's profile rule.
    BadName(String),
    /// A file with a top-level line the scan can't read plainly.
    Unclear(ProfileSource),
}

/// The `profile:` setting of a config file: Ok(None) when there is none.
/// Err when any top-level line can't be read plainly (a byte order mark
/// out of place, a quoted key with escapes, a flow mapping, an anchor, a
/// value on the next line), so the caller never falls back to `default`
/// while Casper reads some other name.
fn profile_setting(yaml: &str) -> Result<Option<String>, ()> {
    let yaml = scan_text(yaml).ok_or(())?;
    let mut seen_content = false;
    let mut found: Option<String> = None;
    for raw in yaml.lines() {
        let line = strip_comment(raw);
        if line.trim_start().is_empty() || line.starts_with(char::is_whitespace) {
            continue;
        }
        if line.starts_with("---") || line.starts_with("...") {
            if seen_content || !is_bare_marker(line) {
                return Err(());
            }
            continue;
        }
        seen_content = true;
        let (key, value) = top_level_pair(line).ok_or(())?;
        if !is_plain_key(key) {
            return Err(());
        }
        if key != "profile" {
            continue;
        }
        let empty = value.is_empty() || matches!(value, "~" | "null" | "Null" | "NULL");
        if found.is_some() || empty || has_yaml_magic(value) || value.starts_with(['|', '>']) {
            return Err(());
        }
        found = Some(unquote(value).to_string());
    }
    Ok(found)
}

/// Casper's profile-name rule (src/config/profile.ts).
fn is_valid_profile_name(name: &str) -> bool {
    let b = name.as_bytes();
    !b.is_empty()
        && b.len() <= 64
        && b[0].is_ascii_alphanumeric()
        && b.iter()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'_' | b'.' | b'-'))
}

/// The profile Casper will load: `CASPER_PROFILE`, then `profile:` in the
/// project's `.casper/project.yaml`, then in `~/.casper/config.yaml`, then
/// `default`. Like Casper, any name that breaks the profile rule is an error,
/// even one a higher choice would win over. So is a file GreenCLI can't read
/// plainly: it never guesses `default`.
pub fn selected_profile(
    env: Option<&str>,
    project_yaml: Option<&str>,
    global_yaml: Option<&str>,
) -> Result<String, ProfileError> {
    let read = |yaml: Option<&str>, source| match yaml {
        None => Ok(None),
        Some(y) => profile_setting(y).map_err(|()| ProfileError::Unclear(source)),
    };
    let candidates = [
        env.map(str::to_string),
        read(project_yaml, ProfileSource::Project)?,
        read(global_yaml, ProfileSource::Global)?,
    ];
    let mut chosen: Option<String> = None;
    for name in candidates.into_iter().flatten() {
        if !is_valid_profile_name(&name) {
            return Err(ProfileError::BadName(name));
        }
        chosen.get_or_insert(name);
    }
    Ok(chosen.unwrap_or_else(|| "default".to_string()))
}

/// The message for a config file that turns the sandbox off, or that GreenCLI can't read.
pub fn sandbox_message(scan: SandboxScan, file: &Path) -> Option<String> {
    let file = file.display();
    match scan {
        SandboxScan::On => None,
        SandboxScan::Off => Some(format!("Casper's sandbox is turned off in {file}. GreenCLI only uses Casper with its sandbox on. Remove \"sandbox: off\" from that file, then try again.")),
        SandboxScan::Unsure => Some(format!("GreenCLI couldn't tell whether Casper's sandbox is on from {file}. Write that file in a plainer way: plain key names (no quotes, anchors or tags), and \"enabled: true\" under sandbox if you set it. Your sandbox lists can stay. Then try again.")),
    }
}

// ─── Working folder ───

/// What a picked working folder is checked against.
pub struct FolderRules<'a> {
    pub home: Option<&'a Path>,
    pub protected: &'a [PathBuf],
    /// Folders whose files other programs run (run_folders).
    pub run: &'a [PathBuf],
    pub case_insensitive: bool,
}

/// Folders whose files other programs run later, outside Casper's sandbox: a
/// file Casper writes there (a `git` on PATH, a Claude Code hook, a login
/// item) would run unsandboxed. The folders on `path_var`, the tool and
/// autostart folders in the home folder, and the system folders.
pub fn run_folders(home: Option<&Path>, path_var: &OsStr) -> Vec<PathBuf> {
    let mut list: Vec<PathBuf> = std::env::split_paths(path_var)
        .filter(|p| p.is_absolute() && p.parent().is_some())
        .collect();
    if let Some(home) = home {
        for sub in [
            ".claude",
            ".cursor",
            ".vscode",
            ".codeium",
            ".config",
            ".local/bin",
            ".local/share/applications",
            "Library/LaunchAgents",
        ] {
            list.push(home.join(sub));
        }
    }
    if cfg!(windows) {
        for var in [
            "SystemRoot",
            "ProgramFiles",
            "ProgramFiles(x86)",
            "ProgramData",
        ] {
            if let Some(v) = std::env::var_os(var).filter(|v| !v.is_empty()) {
                list.push(PathBuf::from(v));
            }
        }
        if let Some(app_data) = std::env::var_os("APPDATA").filter(|v| !v.is_empty()) {
            list.push(
                PathBuf::from(app_data).join(r"Microsoft\Windows\Start Menu\Programs\Startup"),
            );
        }
    } else {
        for dir in [
            "/usr",
            "/etc",
            "/opt",
            "/bin",
            "/sbin",
            "/lib",
            "/var",
            "/Library",
            "/System",
            "/Applications",
        ] {
            list.push(PathBuf::from(dir));
        }
    }
    list
}

fn parts(p: &Path, case_insensitive: bool) -> Vec<String> {
    p.components()
        .map(|c| {
            let s = c.as_os_str().to_string_lossy();
            if case_insensitive {
                s.to_lowercase()
            } else {
                s.into_owned()
            }
        })
        .collect()
}

/// `inner` is `outer` or inside it, by path component.
fn within(inner: &Path, outer: &Path, case_insensitive: bool) -> bool {
    let (a, b) = (
        parts(inner, case_insensitive),
        parts(outer, case_insensitive),
    );
    a.len() >= b.len() && a[..b.len()] == b[..]
}

/// Check a folder the user picked for Casper. The caller passes canonical
/// paths with any Windows `\\?\` prefix already stripped (`plain_path`).
pub fn check_chosen_folder(chosen: &Path, rules: &FolderRules, is_dir: bool) -> Result<(), String> {
    if !chosen.is_absolute() {
        return Err(
            "Casper's working folder must be a full path. Pick it again in Settings → AI & MCP."
                .to_string(),
        );
    }
    if !is_dir {
        return Err(format!("Casper's working folder {} isn't there any more. Pick another in Settings → AI & MCP, or leave it on a fresh folder for each question.", chosen.display()));
    }
    let Some(home) = rules.home else {
        return Err("Casper's working folder can't be checked because GreenCLI can't find your home folder. Leave it on a fresh folder for each question.".to_string());
    };
    let ci = rules.case_insensitive;
    if within(home, chosen, ci) {
        return Err("Casper can't work in your home folder, or in a folder that holds it. Pick a project folder, or leave it on a fresh folder for each question.".to_string());
    }
    if rules
        .protected
        .iter()
        .any(|p| within(chosen, p, ci) || within(p, chosen, ci))
    {
        return Err("Casper can't work in a folder that holds GreenCLI's or Casper's own files. Pick a project folder, or leave it on a fresh folder for each question.".to_string());
    }
    let other_apps = chosen.components().any(|c| match c {
        std::path::Component::Normal(name) => crate::export_file::REFUSED_FOLDERS
            .contains(&name.to_string_lossy().to_lowercase().as_str()),
        _ => false,
    });
    if other_apps
        || rules
            .run
            .iter()
            .any(|p| within(chosen, p, ci) || within(p, chosen, ci))
    {
        return Err("Casper can't work in a folder whose files other programs run. Pick a project folder, or leave it on a fresh folder for each question.".to_string());
    }
    Ok(())
}

/// Drop Windows' verbatim prefix: `\\?\C:\x` → `C:\x`, `\\?\UNC\s\x` → `\\s\x`.
/// Other paths come back unchanged.
pub fn plain_path(p: &Path) -> PathBuf {
    let Some(s) = p.to_str() else {
        return p.to_path_buf();
    };
    if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
        PathBuf::from(format!(r"\\{rest}"))
    } else if let Some(rest) = s.strip_prefix(r"\\?\") {
        PathBuf::from(rest)
    } else {
        p.to_path_buf()
    }
}

/// The folder that holds the per-question folders.
pub fn work_root(cache_dir: &Path) -> PathBuf {
    cache_dir.join(WORK_ROOT_NAME)
}

/// One question's folder name.
pub fn run_folder_name(r: u64) -> String {
    format!("run-{r:016x}")
}

/// `.casper/project.yaml` for a question's folder: the shell sandbox may not
/// read GreenCLI's data folders. A second layer only: Casper's own file tools
/// don't follow project denies.
pub fn project_yaml(deny_read: &[PathBuf]) -> String {
    let mut out =
        String::from("# Written by GreenCLI for one question. It is deleted afterwards.\n");
    if deny_read.is_empty() {
        return out;
    }
    out.push_str("sandbox:\n  denyRead:\n");
    for p in deny_read {
        let quoted = serde_json::to_string(&p.to_string_lossy()).unwrap_or_default();
        out.push_str(&format!("    - {quoted}\n"));
    }
    out
}

/// `GIT_CEILING_DIRECTORIES` for a working folder: its parent, so git never
/// finds a repository above the folder. Fails closed.
///
/// Git splits the value on ":" (";" on Windows) and reads no quotes, so a
/// parent path holding that character would turn into entries git ignores.
/// std's join_paths can't be used to catch that: on Windows it quotes a path
/// with ";" instead of failing.
pub fn git_ceiling(work_dir: &Path) -> Result<OsString, String> {
    let sep = if cfg!(windows) { ';' } else { ':' };
    let parent = work_dir
        .parent()
        .filter(|p| p.is_absolute())
        .map(plain_path)
        .unwrap_or_default();
    check_ceiling(&parent.to_string_lossy(), sep, cfg!(windows))?;
    Ok(parent.into_os_string())
}

/// The checks behind git_ceiling, on the parent folder's path as text (with
/// Windows' verbatim prefix already dropped), git's list separator `sep`, and
/// `windows` for Windows path rules. Pure, so both platforms' rules are tested
/// everywhere. The parent must be absolute (Windows: `C:\` or `\\server\share`;
/// elsewhere: `/`) and must not hold `sep`.
pub fn check_ceiling(parent: &str, sep: char, windows: bool) -> Result<(), String> {
    let absolute = if windows {
        let b = parent.as_bytes();
        (b.len() >= 3 && b[0].is_ascii_alphabetic() && b[1] == b':' && matches!(b[2], b'\\' | b'/'))
            || parent.starts_with(r"\\")
            || parent.starts_with("//")
    } else {
        parent.starts_with('/')
    };
    if !absolute {
        return Err(
            "Casper's working folder can't be used because it isn't a full path. Pick another folder."
                .to_string(),
        );
    }
    if parent.contains(sep) {
        return Err(format!(
            "Casper's working folder can't be used because its path holds a \"{sep}\". Pick another folder."
        ));
    }
    Ok(())
}

/// Instruction files Casper would follow when it works in `folder`:
/// `.casper/rules.md`, `AGENTS.md` and `CLAUDE.md` in the folder, and
/// `AGENTS.md` / `CLAUDE.md` in each folder above it, up to (not including) `stop_at`.
pub fn instruction_files_above(
    folder: &Path,
    stop_at: Option<&Path>,
    exists: &dyn Fn(&Path) -> bool,
) -> Vec<PathBuf> {
    let mut found = Vec::new();
    for name in [".casper/rules.md", "AGENTS.md", "CLAUDE.md"] {
        let p = folder.join(name);
        if exists(&p) {
            found.push(p);
        }
    }
    for dir in folder.ancestors().skip(1) {
        if stop_at == Some(dir) {
            break;
        }
        for name in ["AGENTS.md", "CLAUDE.md"] {
            let p = dir.join(name);
            if exists(&p) {
                found.push(p);
            }
        }
    }
    found
}

// ─── Local bridges ───

/// Where an MCP server's URL leads, for the local-bridge check.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UrlHost {
    /// This computer (a loopback or unspecified address, `localhost`), or a
    /// URL GreenCLI can't read (fail closed).
    Local,
    /// An address that is local only if it is one of this computer's own.
    Ip(IpAddr),
    /// A host name to look up, with the URL's port.
    Name(String, u16),
}

/// A loopback or unspecified address, also written as IPv4 inside IPv6
/// (`::ffff:127.0.0.1`). Casper's sandbox lets commands reach these.
pub fn is_local_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => v4.is_loopback() || v4.is_unspecified(),
        IpAddr::V6(v6) => {
            v6.is_loopback()
                || v6.is_unspecified()
                || v6
                    .to_ipv4()
                    .is_some_and(|v4| v4.is_loopback() || v4.is_unspecified())
        }
    }
}

/// Read an MCP server URL the way its HTTP client does (WHATWG rules:
/// `127.1`, `2130706433` and `0x7f000001` are all 127.0.0.1).
pub fn url_host(url: &str) -> UrlHost {
    let Ok(parsed) = reqwest::Url::parse(url.trim()) else {
        return UrlHost::Local;
    };
    let port = parsed.port_or_known_default().unwrap_or(0);
    let Some(host) = parsed.host_str() else {
        return UrlHost::Local;
    };
    let bare = host
        .strip_prefix('[')
        .and_then(|h| h.strip_suffix(']'))
        .unwrap_or(host);
    if let Ok(ip) = bare.parse::<IpAddr>() {
        return if is_local_ip(ip) {
            UrlHost::Local
        } else {
            UrlHost::Ip(ip)
        };
    }
    let name = host.trim_end_matches('.').to_ascii_lowercase();
    if name.is_empty() || name == "localhost" || name.ends_with(".localhost") {
        return UrlHost::Local;
    }
    UrlHost::Name(name, port)
}

/// Casper's sandboxed commands may reach this computer's local ports. A port
/// forward (to a device network) or a web MCP server on this computer makes
/// that a way out, so GreenCLI won't start Casper while one is open or set up.
/// A web MCP server counts whether or not GreenCLI is connected to it: GreenCLI
/// doesn't start it, so disconnecting doesn't stop it.
pub fn bridge_problem(forwards: &[(String, u16)], loopback_mcp: &[String]) -> Option<String> {
    if let Some((_, port)) = forwards.first() {
        return Some(format!("Casper's commands can reach this computer's local ports, and GreenCLI has a port forward open on port {port} (Tunnels). Close it, or ask with another AI provider."));
    }
    loopback_mcp.first().map(|name| format!("Casper's commands can reach this computer's local ports, and the web MCP server \"{name}\" may run on this computer. Disconnecting it isn't enough, because it keeps running. Remove it in MCP Servers, or ask with another AI provider."))
}

/// Shown when a port forward is opened while Casper answers.
pub const BUSY_FORWARD: &str = "Casper is answering a question in the AI panel, and its commands can reach this computer's local ports. Open the port forward when it's done, or press Stop first.";
/// Shown when a web MCP server is connected while Casper answers.
pub const BUSY_MCP: &str = "Casper is answering a question in the AI panel, and its commands can reach this computer's local ports. Connect this MCP server when it's done, or press Stop first.";

/// Counts the Casper questions in progress. While one runs, GreenCLI opens
/// no port forward and connects no web MCP server: Casper checked for those
/// only when it started. The count drops when the guard does.
pub struct CasperRunGuard(Arc<AtomicUsize>);

impl CasperRunGuard {
    /// Start counting a run. Take the guard before looking for bridges, so a
    /// forward opened in between is either seen or refused.
    pub fn start(count: &Arc<AtomicUsize>) -> Self {
        count.fetch_add(1, Ordering::SeqCst);
        CasperRunGuard(count.clone())
    }
}

impl Drop for CasperRunGuard {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

/// True while a Casper question runs. Check it under the same lock the
/// bridge scan reads (the forwards map, the MCP manager).
pub fn casper_busy(count: &AtomicUsize) -> bool {
    count.load(Ordering::SeqCst) > 0
}

// ─── Output ───

/// The parts of Casper's `receipt` event GreenCLI shows.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct CasperReceipt {
    pub outcome: String,
    pub verdict: Option<String>,
    pub turn_limit: Option<u64>,
    /// Commands to other machines Casper didn't run (sum of remoteNotRun[].commands).
    pub remote_not_run: u64,
    /// Hosts Casper changed something on.
    pub remote_changes: Vec<String>,
    pub secret_in_command: bool,
    /// Set when the sandbox didn't hold because it was turned off.
    pub sandbox_off_reason: Option<String>,
    /// Files changed (with changedDuringChecks); None when Casper couldn't compare.
    pub changed: Option<Vec<String>>,
    /// Model tokens the run used (receipt `usage.tokens`); None when Casper couldn't tell.
    pub usage_tokens: Option<u64>,
    /// Casper's cost estimate in dollars (receipt `usage.estimatedCost`), never an invoice.
    pub usage_cost: Option<f64>,
}

/// What GreenCLI read from Casper's stdout.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct CasperOutput {
    pub answer: Option<String>,
    pub errors: Vec<String>,
    pub receipt: Option<CasperReceipt>,
    /// A line had a `v` other than 1.
    pub newer_format: bool,
    /// At least one line was JSON.
    pub any_json: bool,
}

fn str_field(v: &Value, key: &str) -> Option<String> {
    v.get(key).and_then(Value::as_str).map(str::to_string)
}

fn str_list(v: Option<&Value>) -> Vec<String> {
    v.and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

fn parse_receipt(v: &Value) -> CasperReceipt {
    let remote_not_run = v
        .get("remoteNotRun")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|r| r.get("commands").and_then(Value::as_u64))
                .sum()
        })
        .unwrap_or(0);
    let remote_changes = v
        .get("remoteChanges")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter(|r| {
                    r.get("changes")
                        .and_then(Value::as_array)
                        .is_some_and(|c| !c.is_empty())
                })
                .filter_map(|r| str_field(r, "host"))
                .collect()
        })
        .unwrap_or_default();
    let sandbox_off_reason = v.get("sandbox").and_then(|s| {
        if s.get("held").and_then(Value::as_bool) != Some(false) {
            return None;
        }
        let reason = str_field(s, "reason")?;
        (reason == "--no-sandbox" || reason.starts_with("sandbox: off")).then_some(reason)
    });
    let changed = match v.get("changed") {
        Some(Value::Array(_)) => {
            let mut all = str_list(v.get("changed"));
            for p in str_list(v.get("changedDuringChecks")) {
                if !all.contains(&p) {
                    all.push(p);
                }
            }
            Some(all)
        }
        _ => None,
    };
    let usage = v.get("usage");
    let usage_tokens = usage.and_then(|u| u.get("tokens")).and_then(Value::as_u64);
    let usage_cost = usage
        .and_then(|u| u.get("estimatedCost"))
        .and_then(Value::as_f64)
        .filter(|c| c.is_finite() && *c >= 0.0);
    CasperReceipt {
        outcome: str_field(v, "outcome").unwrap_or_default(),
        verdict: str_field(v, "verdict").filter(|s| !s.trim().is_empty()),
        turn_limit: v.get("turnLimit").and_then(Value::as_u64),
        remote_not_run,
        remote_changes,
        secret_in_command: v.get("secretInCommand").and_then(Value::as_bool) == Some(true),
        sandbox_off_reason,
        changed,
        usage_tokens,
        usage_cost,
    }
}

/// Read Casper's JSON Lines. Lines that aren't JSON (a cut first line, a
/// stray print) are skipped. The last non-blank `assistant_message` is the
/// answer; streamed deltas are the fallback when a run was cut short.
pub fn parse_json_lines(stdout: &str) -> CasperOutput {
    let mut out = CasperOutput::default();
    let mut deltas = String::new();
    for line in stdout.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if !v.is_object() {
            continue;
        }
        out.any_json = true;
        if v.get("v").and_then(Value::as_u64) != Some(1) {
            out.newer_format = true;
            continue;
        }
        match v.get("type").and_then(Value::as_str) {
            Some("assistant_message") => {
                if let Some(text) = str_field(&v, "text").filter(|t| !t.trim().is_empty()) {
                    out.answer = Some(text);
                    deltas.clear();
                }
            }
            Some("assistant_delta") => {
                if let Some(text) = v.get("text").and_then(Value::as_str) {
                    deltas.push_str(text);
                }
            }
            Some("error") => {
                if let Some(m) = str_field(&v, "message").filter(|m| !m.trim().is_empty()) {
                    out.errors.push(m);
                }
            }
            Some("receipt") => out.receipt = Some(parse_receipt(&v)),
            _ => {}
        }
    }
    if out.answer.is_none() && !deltas.trim().is_empty() {
        out.answer = Some(deltas);
    }
    out
}

// ─── The reply ───

/// How a run ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RunEnd {
    Exited(Option<i32>),
    Cancelled,
    TimedOut,
}

/// The last non-empty stderr line, at most 300 bytes.
pub fn stderr_hint(stderr: &str) -> String {
    let line = stderr
        .lines()
        .map(str::trim)
        .rfind(|l| !l.is_empty())
        .unwrap_or("");
    line[..super::floor_char_boundary(line, 300)].to_string()
}

const NOT_SET_UP: [&str; 6] = [
    "/login",
    "/model",
    "sign in",
    "no casper model selected",
    "credentials missing",
    "credential state needs local refresh",
];

fn clean_verdict(v: &str) -> &str {
    let v = v.trim();
    ["• ", "✗ ", "✓ "]
        .iter()
        .find_map(|p| v.strip_prefix(p))
        .unwrap_or(v)
        .trim()
}

fn italic(note: &str) -> String {
    format!("*{}*", note.trim())
}

/// 4210 -> "4,210".
fn with_commas(n: u64) -> String {
    let digits = n.to_string();
    let mut out = String::new();
    for (i, c) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i).is_multiple_of(3) {
            out.push(',');
        }
        out.push(c);
    }
    out
}

/// "Casper used 4,210 tokens (about $0.02)." The cost is Casper's estimate,
/// so it always says "about"; it is left out when Casper gives none.
fn usage_note(tokens: Option<u64>, cost: Option<f64>) -> Option<String> {
    let cost = cost.map(|c| {
        if c == 0.0 {
            "about $0".to_string()
        } else if c < 0.01 {
            "under $0.01".to_string()
        } else {
            format!("about ${c:.2}")
        }
    });
    match (tokens, cost) {
        (Some(t), cost) => {
            let word = if t == 1 { "token" } else { "tokens" };
            let cost = cost.map(|c| format!(" ({c})")).unwrap_or_default();
            Some(format!("Casper used {} {word}{cost}.", with_commas(t)))
        }
        (None, Some(c)) => Some(format!("Casper used {c}.")),
        (None, None) => None,
    }
}

fn notes(code: i32, receipt: Option<&CasperReceipt>, picked: Option<&Path>) -> Vec<String> {
    let mut out = Vec::new();
    let Some(r) = receipt else {
        return out;
    };
    if code == 2 {
        if let Some(n) = r.turn_limit {
            out.push(format!("Casper reached its turn limit ({n}) before it finished. Add --max-turns to the Casper command to change it."));
        } else if r.remote_not_run > 0 {
            let n = r.remote_not_run;
            let what = if n == 1 { "command" } else { "commands" };
            out.push(format!(
                "Casper didn't run {n} {what} on other machines. Nothing was changed there."
            ));
        } else if let Some(v) = r.verdict.as_deref() {
            out.push(format!(
                "Casper stopped before it finished: {}",
                clean_verdict(v)
            ));
        }
    }
    if !r.remote_changes.is_empty() {
        out.push(format!(
            "Casper changed things on {}.",
            r.remote_changes.join(", ")
        ));
    }
    if r.secret_in_command {
        out.push("A secret showed up in a command Casper ran. Change that secret.".to_string());
    }
    if let Some(reason) = &r.sandbox_off_reason {
        out.push(format!(
            "Casper's sandbox was off ({reason}), so its commands ran without it."
        ));
    }
    if let Some(folder) = picked {
        match &r.changed {
            Some(files) if !files.is_empty() => {
                let name = folder
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_else(|| folder.display().to_string());
                let shown = files.iter().take(8).cloned().collect::<Vec<_>>().join(", ");
                let more = if files.len() > 8 {
                    format!(" and {} more", files.len() - 8)
                } else {
                    String::new()
                };
                out.push(format!(
                    "Casper changed these files in {name}: {shown}{more}."
                ));
            }
            Some(_) => {}
            None => out.push(
                "Casper may have changed files in its working folder, but it couldn't tell which."
                    .to_string(),
            ),
        }
    }
    out
}

/// The answer plus GreenCLI's notes; what it cost always comes last.
fn with_notes(answer: &str, mut notes: Vec<String>, receipt: Option<&CasperReceipt>) -> String {
    if let Some(n) = receipt.and_then(|r| usage_note(r.usage_tokens, r.usage_cost)) {
        notes.push(n);
    }
    let answer = answer.trim();
    if notes.is_empty() {
        return answer.to_string();
    }
    let notes: Vec<String> = notes.iter().map(String::as_str).map(italic).collect();
    format!("{answer}\n\n---\n{}", notes.join("\n\n"))
}

/// Turn a finished run into the reply (Ok) or a plain error (Err).
/// `picked` is the folder the user picked, or None for GreenCLI's own folder.
pub fn casper_reply(
    end: RunEnd,
    out: &CasperOutput,
    stderr: &str,
    picked: Option<&Path>,
) -> Result<String, String> {
    let code = match end {
        RunEnd::Cancelled => return Err("Stopped.".to_string()),
        RunEnd::TimedOut => {
            return Err(
                "Casper didn't finish within 10 minutes, so GreenCLI stopped it.".to_string(),
            )
        }
        RunEnd::Exited(code) => code,
    };
    let hint = stderr_hint(stderr);
    let answer = out.answer.as_deref().filter(|a| !a.trim().is_empty());
    if answer.is_none() {
        if out.newer_format {
            return Err(
                "This Casper answers in a newer format than GreenCLI can read. Update GreenCLI."
                    .to_string(),
            );
        }
        let mut said: Vec<&str> = out.errors.iter().map(String::as_str).collect();
        if !out.any_json && !hint.is_empty() {
            said.push(&hint);
        }
        let not_set_up = said.into_iter().find(|e| {
            let lower = e.to_lowercase();
            NOT_SET_UP.iter().any(|p| lower.contains(p))
        });
        if let Some(e) = not_set_up {
            return Err(format!("Casper isn't ready to answer: it needs a sign-in or a model. Open a Casper tab (Quick Connect → Local → Casper), use /login and /model, then ask again.\n\nCasper said: {}", e.trim()));
        }
    }
    let verdict = out
        .receipt
        .as_ref()
        .and_then(|r| r.verdict.as_deref())
        .map(clean_verdict);
    let reason = if !out.any_json && !hint.is_empty() {
        hint.clone()
    } else if let Some(e) = out.errors.last() {
        e.trim().to_string()
    } else if let Some(v) = verdict {
        v.to_string()
    } else {
        "it stopped with an error".to_string()
    };
    let receipt = out.receipt.as_ref();
    match code {
        Some(0) => match answer {
            Some(a) => Ok(with_notes(a, notes(0, receipt, picked), receipt)),
            None => Err("Casper finished without an answer.".to_string()),
        },
        Some(1) => match (answer, receipt) {
            (Some(a), Some(r)) => {
                let mut n = notes(1, Some(r), picked);
                if let Some(v) = verdict {
                    n.push(format!("Casper says: {v}"));
                }
                Ok(with_notes(a, n, receipt))
            }
            _ => Err(format!("Casper couldn't answer: {reason}")),
        },
        Some(c @ (2 | 3)) => match answer {
            Some(a) => {
                let mut n = notes(c, receipt, picked);
                if c == 3 {
                    if let Some(v) = verdict {
                        n.push(format!("Casper didn't check this change: {v}"));
                    }
                }
                Ok(with_notes(a, n, receipt))
            }
            None => Err(format!("Casper stopped before it finished: {reason}")),
        },
        Some(64) => Err(format!("Casper didn't accept the options GreenCLI sent: {hint}. Check the Casper command in Settings → AI & MCP.")),
        Some(130 | 143) | None => Err("Casper was stopped before it answered.".to_string()),
        Some(n) => Err(format!("Casper failed (exit {n}): {reason}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn argv(s: &[&str]) -> Vec<String> {
        s.iter().map(|x| x.to_string()).collect()
    }

    fn norm(s: &[&str]) -> Result<Vec<String>, String> {
        normalize_cli_argv(&argv(s))
    }

    // ─── Options ───

    #[test]
    fn normalize_plain() {
        assert_eq!(
            norm(&["casper"]).unwrap(),
            argv(&["casper", "--json", "--no-verify", "--max-turns", "20", "-"])
        );
        assert_eq!(
            norm(&["casper", "--model", "a/b", "--verbose"]).unwrap(),
            argv(&[
                "casper",
                "--json",
                "--model",
                "a/b",
                "--verbose",
                "--no-verify",
                "--max-turns",
                "20",
                "-"
            ])
        );
    }

    #[test]
    fn dash_is_always_last_and_once() {
        for cmd in [
            vec!["casper", "-"],
            vec!["casper", "-", "--verbose"],
            vec!["casper", "-", "-", "--max-turns", "3"],
        ] {
            let out = norm(&cmd).unwrap();
            assert_eq!(out.last().unwrap(), "-");
            assert_eq!(out.iter().filter(|t| *t == "-").count(), 1);
        }
    }

    #[test]
    fn never_adds_quiet() {
        for cmd in [
            vec!["casper", "--quiet"],
            vec!["casper", "-q", "-p", "--print"],
            vec!["casper", "--model", "moonshot/kimi-k2"],
        ] {
            let out = norm(&cmd).unwrap();
            assert!(!out.iter().any(|t| t == "--quiet" || t == "-q" || t == "-p"));
        }
    }

    #[test]
    fn refuses_no_sandbox() {
        for cmd in [
            vec!["casper", "--no-sandbox"],
            vec!["casper", "--verbose", "--no-sandbox=1"],
        ] {
            assert!(norm(&cmd)
                .unwrap_err()
                .contains("won't turn off Casper's sandbox"));
        }
    }

    #[test]
    fn refuses_cd_continue_resume_info() {
        assert!(norm(&["casper", "--cd", "/x"])
            .unwrap_err()
            .contains("instead of using --cd"));
        assert!(norm(&["casper", "--cd=/x"])
            .unwrap_err()
            .contains("instead of using --cd"));
        for flag in ["--continue", "--resume"] {
            let e = norm(&["casper", flag]).unwrap_err();
            assert!(e.contains(&format!("Remove {flag} ")), "{e}");
        }
        assert!(norm(&["casper", "--resume=abc"])
            .unwrap_err()
            .contains("Remove --resume "));
        for flag in ["--help", "-h", "--version", "-v", "--licenses"] {
            let e = norm(&["casper", flag]).unwrap_err();
            assert!(e.starts_with(&format!("Remove {flag} ")), "{e}");
            assert!(e.contains("not print help"));
        }
    }

    #[test]
    fn refuses_mcp_and_lsp() {
        for cmd in [
            vec!["casper", "--mcp", "x"],
            vec!["casper", "--mcp=x"],
            vec!["casper", "--mcp"],
            vec!["casper", "--lsp", "rust"],
            vec!["casper", "--lsp=rust"],
        ] {
            let e = norm(&cmd).unwrap_err();
            assert!(e.contains("doesn't connect Casper's servers"), "{e}");
        }
    }

    #[test]
    fn refuses_words_and_double_dash() {
        let e = norm(&["casper", "explain", "this"]).unwrap_err();
        assert!(e.contains("Remove \"explain\""), "{e}");
        assert!(norm(&["casper", "--"])
            .unwrap_err()
            .contains("Remove \"--\""));
    }

    #[test]
    fn refuses_unknown_flag() {
        let e = norm(&["casper", "--frobnicate"]).unwrap_err();
        assert!(e.contains("option --frobnicate"), "{e}");
        assert!(norm(&["casper", "-x"]).unwrap_err().contains("option -x"));
        assert!(norm(&["casper", "--verbose=1"])
            .unwrap_err()
            .contains("option --verbose=1"));
    }

    #[test]
    fn value_forms() {
        let out = norm(&["casper", "--model=a/b", "--effort", "high", "--max-turns=5"]).unwrap();
        assert_eq!(
            out,
            argv(&[
                "casper",
                "--json",
                "--model",
                "a/b",
                "--effort",
                "high",
                "--max-turns",
                "5",
                "--no-verify",
                "-"
            ])
        );
        assert_eq!(
            norm(&["casper", "--model"]).unwrap_err(),
            "--model needs a value."
        );
        assert_eq!(
            norm(&["casper", "--model", "--verbose"]).unwrap_err(),
            "--model needs a value."
        );
        assert_eq!(
            norm(&["casper", "--model="]).unwrap_err(),
            "--model needs a value."
        );
        assert!(norm(&["casper", "--model", "a b"]).is_err());
        assert!(norm(&["casper", "--model", "a/b:high", "--effort", "low"]).is_err());
    }

    #[test]
    fn max_turns_validation() {
        for ok in ["1", "20", "9999"] {
            assert!(norm(&["casper", "--max-turns", ok]).is_ok(), "{ok}");
        }
        for bad in ["0", "10000", "07", "1.5", "x"] {
            assert_eq!(
                norm(&["casper", "--max-turns", bad]).unwrap_err(),
                "--max-turns needs a whole number from 1 to 9999.",
                "{bad}"
            );
        }
        assert_eq!(
            norm(&["casper", "--max-turns", "-5"]).unwrap_err(),
            "--max-turns needs a value."
        );
        let out = norm(&["casper", "--max-turns", "7"]).unwrap();
        assert_eq!(out.iter().filter(|t| *t == "--max-turns").count(), 1);
    }

    #[test]
    fn effort_validation() {
        for ok in EFFORTS {
            assert!(norm(&["casper", "--effort", ok]).is_ok());
        }
        assert_eq!(
            norm(&["casper", "--effort", "HIGH"]).unwrap_err(),
            "--effort must be one of auto, off, minimal, low, medium, high, xhigh, max."
        );
    }

    #[test]
    fn verify_family() {
        let out = norm(&["casper", "--verify"]).unwrap();
        assert!(out.contains(&"--verify".to_string()));
        assert!(!out.contains(&"--no-verify".to_string()));
        let out = norm(&["casper", "--require-verification"]).unwrap();
        assert!(!out.contains(&"--no-verify".to_string()));
        let out = norm(&["casper", "--no-verify"]).unwrap();
        assert_eq!(out.iter().filter(|t| *t == "--no-verify").count(), 1);
        assert_eq!(
            norm(&["casper", "--verify", "--no-verify"]).unwrap_err(),
            "Use --verify or --no-verify, not both."
        );
        assert_eq!(
            norm(&["casper", "--no-verify", "--require-verification"]).unwrap_err(),
            "--require-verification can't be used with --no-verify."
        );
    }

    #[test]
    fn json_not_duplicated() {
        let out = norm(&["casper", "--json", "--verbose", "--json"]).unwrap();
        assert_eq!(out.iter().filter(|t| *t == "--json").count(), 1);
        assert_eq!(out[1], "--json");
    }

    // ─── Program names ───

    #[test]
    fn is_casper_program_cases() {
        for yes in [
            "casper",
            "/Users/x/.local/bin/casper",
            r"C:\Users\x\AppData\Local\Programs\casper\casper.exe",
            "CASPER.EXE",
        ] {
            assert!(is_casper_program(yes), "{yes}");
        }
        for no in [
            "casperx",
            "my-casper",
            "bun",
            "env",
            "casper.cmd",
            "casper.exe.exe",
        ] {
            assert!(!is_casper_program(no), "{no}");
        }
    }

    #[test]
    fn batch_shim_refused() {
        for shim in ["casper.cmd", r"C:\x\CASPER.BAT", "/x/casper.bat"] {
            assert!(refuse_batch_shim(shim).unwrap_err().contains("casper.exe"));
        }
        for fine in ["casper", "casper.exe", "other.cmd"] {
            assert!(refuse_batch_shim(fine).is_ok());
        }
    }

    #[test]
    fn refuse_not_casper_for_bun_and_env() {
        assert!(refuse_not_casper("bun").is_err());
        assert!(refuse_not_casper("/usr/bin/env").is_err());
        assert!(refuse_not_casper("bunx").is_err());
        assert!(refuse_not_casper("casper").is_ok());
    }

    // ─── Finding the program ───

    fn joined(dirs: &[&str]) -> OsString {
        std::env::join_paths(dirs.iter().map(PathBuf::from)).unwrap()
    }

    #[test]
    fn resolve_program_cases() {
        let none = |_: &Path| false;
        let all = |_: &Path| true;
        assert!(resolve_program("./casper", &joined(&[]), false, None, &all).is_err());
        assert!(resolve_program("bin/casper", &joined(&[]), false, None, &all).is_err());
        let abs = std::env::temp_dir().join("nope").join("casper");
        let abs_s = abs.to_str().unwrap();
        assert_eq!(
            resolve_program(abs_s, &joined(&[]), false, None, &none).unwrap(),
            None
        );
        assert_eq!(
            resolve_program(abs_s, &joined(&[]), false, None, &all).unwrap(),
            Some(abs.clone())
        );

        // A relative PATH entry is skipped.
        let dir = std::env::temp_dir().join("bin");
        let path = std::env::join_paths([PathBuf::from("."), dir.clone()]).unwrap();
        let found = resolve_program("casper", &path, false, None, &all).unwrap();
        assert_eq!(found, Some(dir.join("casper")));

        // Windows: casper.exe, never a shim; the LOCALAPPDATA fallback.
        let exe_only = |p: &Path| p.extension().is_some_and(|e| e == "exe");
        let found = resolve_program("casper", &path, true, None, &exe_only).unwrap();
        assert_eq!(found, Some(dir.join("casper.exe")));
        let cmd_only = |p: &Path| p.extension().is_some_and(|e| e == "cmd");
        assert!(resolve_program("casper", &path, true, None, &cmd_only)
            .unwrap_err()
            .contains("casper.exe"));
        let local = std::env::temp_dir().join("Local");
        let fallback = windows_fallback_program(Some(local.as_os_str())).unwrap();
        let only_fallback = |p: &Path| p == fallback.as_path();
        assert_eq!(
            resolve_program(
                "casper",
                &path,
                true,
                Some(local.as_os_str()),
                &only_fallback
            )
            .unwrap(),
            Some(fallback.clone())
        );
        assert_eq!(
            resolve_program(
                "casper",
                &path,
                false,
                Some(local.as_os_str()),
                &only_fallback
            )
            .unwrap(),
            None
        );
        assert!(fallback.ends_with(Path::new("Programs").join("casper").join("casper.exe")));
    }

    #[test]
    fn augmented_path_adds_bun() {
        let home = std::env::temp_dir().join("home");
        let current = joined(&["/usr/bin", "/usr/local/bin"]);
        let out: Vec<PathBuf> =
            std::env::split_paths(&augmented_path(&current, Some(&home))).collect();
        assert_eq!(out[0], PathBuf::from("/usr/bin"));
        assert_eq!(out[1], PathBuf::from("/usr/local/bin"));
        assert!(out.contains(&home.join(".bun/bin")));
        assert!(out.contains(&home.join(".local/bin")));
        assert_eq!(
            out.iter()
                .filter(|p| p.as_path() == Path::new("/usr/local/bin"))
                .count(),
            1
        );
    }

    // ─── Version ───

    #[test]
    fn parse_version_cases() {
        assert_eq!(
            parse_version("casper 0.2.21 (/x/cli.ts)\n"),
            Some(CasperVersion(0, 2, 21))
        );
        assert_eq!(
            parse_version("casper 0.2.21-beta\n"),
            Some(CasperVersion(0, 2, 21))
        );
        assert_eq!(
            parse_version("  casper 1.0.0"),
            Some(CasperVersion(1, 0, 0))
        );
        assert_eq!(parse_version("claude 0.2.21"), None);
        assert_eq!(parse_version("casper 0.2"), None);
        assert_eq!(parse_version(""), None);
        assert_eq!(parse_version("\ncasper 0.2.21"), None);
        assert_eq!(CasperVersion(0, 2, 21).to_string(), "0.2.21");
    }

    #[test]
    fn version_problem_cases() {
        let old = version_problem(Some(CasperVersion(0, 2, 15)), "casper", Some(0), "").unwrap();
        assert!(
            old.contains("version 0.2.15") && old.contains("0.2.21 or newer"),
            "{old}"
        );
        assert_eq!(
            version_problem(Some(CasperVersion(0, 2, 21)), "casper", Some(0), ""),
            None
        );
        assert_eq!(
            version_problem(Some(CasperVersion(1, 0, 0)), "casper", Some(0), ""),
            None
        );
        let bun = version_problem(
            None,
            "casper",
            Some(127),
            "env: bun: No such file or directory",
        )
        .unwrap();
        assert!(
            bun.contains("exit 127") && bun.contains("env: bun"),
            "{bun}"
        );
        assert!(bun.contains("Bun is installed"));
        let silent = version_problem(None, "casper", None, "").unwrap();
        assert!(silent.contains("starts Casper"), "{silent}");
        let none = version_problem(None, "casper", None, "x").unwrap();
        assert!(none.contains("exit none"), "{none}");
    }

    // ─── Sandbox setting ───

    #[test]
    fn scan_sandbox_cases() {
        use SandboxScan::*;
        let cases: &[(&str, SandboxScan)] = &[
            ("sandbox: off\n", Off),
            ("sandbox: false\n", Off),
            ("sandbox: \"off\"\n", Off),
            ("sandbox: False # yes\n", Off),
            ("sandbox:\n  allowedDomains: [x]\n  enabled: false\n", Off),
            ("sandbox: on\n", On),
            ("sandbox: true\n", On),
            ("model: x\n", On),
            ("", On),
            ("sandbox:\n  allowedDomains: [x]\nother: 1\n", On),
            ("sandbox:\n  enabled: true\n", On),
            ("sandbox: {allowedDomains: [a.com]}\n", On),
            ("sandbox: {enabled: true}\n", On),
            ("# sandbox: off\nmodel: x\n", On),
            ("---\nsandbox: on\n", On),
            ("sandbox: {enabled: false}\n", Unsure),
            ("sandbox: { enabled: no }\n", Unsure),
            ("sandbox: maybe\n", Unsure),
            ("sandbox: |\n  off\n", Unsure),
            ("sandbox: *off\n", Unsure),
            ("sandbox:\n  <<: *base\n", Unsure),
            ("sandbox: &s\n  enabled: true\n", Unsure),
            ("sandbox:\n  enabled: maybe\n", Unsure),
            ("sandbox: on\nsandbox: off\n", Unsure),
            ("sandbox:\n  off\n", Unsure),
            ("sandbox:\n  - x\n", Unsure),
            (
                "sandbox:\n    allowedDomains:\n      - a.com\n    enabled: true\n",
                On,
            ),
            (
                "sandbox:\n    allowedDomains: [a]\n  enabled: false\n",
                Unsure,
            ),
            ("sandbox: on\nother: 1\nsandbox: on\n", Unsure),
            ("model: x\n---\nsandbox: off\n", Unsure),
            ("{sandbox: off}\n", Unsure),
            ("<<: *defaults\n", Unsure),
            ("sandbox: !!bool false\n", Unsure),
            ("sandbox:\n- off\n", Unsure),
            // A byte order mark at the start is dropped, as YAML does.
            ("\u{feff}sandbox: off\n", Off),
            ("\u{feff}sandbox:\n  enabled: false\n", Off),
            ("\u{feff}sandbox: on\n", On),
            ("model: x\n\u{feff}sandbox: off\n", Unsure),
            ("model: x\rsandbox: off\n", Unsure),
            ("sandbox: on\r\nmodel: x\r\n", On),
            // A flow mapping, or a quoted key, inside the sandbox block.
            ("sandbox:\n  {enabled: false}\n", Unsure),
            ("sandbox:\n  \"en\\x61bled\": false\n", Unsure),
            ("sandbox:\n  [x]\n", Unsure),
            ("sandbox:\n  |\n    off\n", Unsure),
            // Escaped or unusual top-level keys.
            ("\"sand\\x62ox\": off\n", Unsure),
            ("'sand''box': off\n", Unsure),
            ("\"sandbox\": off\n", Off),
            ("? sandbox\n: off\n", Unsure),
            ("--- {sandbox: off}\n", Unsure),
            ("--- # first\nsandbox: on\n", On),
            // A list at its key's indent (kubectl style) is fine.
            ("sandbox:\n  allowedDomains:\n  - github.com\n", On),
            (
                "sandbox:\n  allowedDomains:\n  - a.com\n  - b.com\n  enabled: false\n",
                Off,
            ),
            (
                "sandbox:\n  allowWrite:\n  - /tmp/x\n  enabled: true\nmodel: y\n",
                On,
            ),
            ("sandbox:\n  enabled: true\n  - x\n", Unsure),
        ];
        for (yaml, want) in cases {
            assert_eq!(scan_sandbox_setting(yaml), *want, "{yaml:?}");
        }
    }

    #[test]
    fn unsure_message_keeps_lists() {
        let m = sandbox_message(SandboxScan::Unsure, Path::new("/h/.casper/config.yaml")).unwrap();
        assert!(m.contains("Your sandbox lists can stay"), "{m}");
        assert!(!m.contains("remove"), "{m}");
    }

    #[test]
    fn selected_profile_order() {
        let project = "profile: proj\n";
        let global = "profile: glob # mine\nmodel: x\n";
        assert_eq!(
            selected_profile(Some("env"), Some(project), Some(global)).unwrap(),
            "env"
        );
        assert_eq!(
            selected_profile(None, Some(project), Some(global)).unwrap(),
            "proj"
        );
        assert_eq!(selected_profile(None, None, Some(global)).unwrap(), "glob");
        assert_eq!(
            selected_profile(None, Some("x: 1\n"), Some("")).unwrap(),
            "default"
        );
        assert!(selected_profile(Some("../etc"), None, None).is_err());
        assert!(selected_profile(Some(""), None, None).is_err());
        // Like Casper, a bad name anywhere is an error.
        assert!(selected_profile(Some("ok"), None, Some("profile: \"a/b\"\n")).is_err());
        assert_eq!(profile_setting("  profile: x\n"), Ok(None));
        assert_eq!(profile_setting("profile: 'x'\n"), Ok(Some("x".to_string())));
        assert_eq!(
            profile_setting("\u{feff}profile: lab\n"),
            Ok(Some("lab".to_string()))
        );
    }

    #[test]
    fn selected_profile_never_guesses_default() {
        use ProfileError::*;
        use ProfileSource::*;
        // A byte order mark is dropped, so the name is still read.
        assert_eq!(
            selected_profile(None, Some("\u{feff}profile: lab\n"), None).unwrap(),
            "lab"
        );
        assert_eq!(
            selected_profile(None, None, Some("\u{feff}profile: work\n")).unwrap(),
            "work"
        );
        // Lines GreenCLI can't read plainly are errors, not `default`.
        for project in [
            "\"pro\\x66ile\": lab\n",
            "{profile: lab}\n",
            "profile:\n  lab\n",
            "profile: lab\nprofile: other\n",
            "profile: *name\n",
            "--- {profile: lab}\n",
            "x: 1\n\u{feff}profile: lab\n",
            "? profile\n: lab\n",
        ] {
            assert_eq!(
                selected_profile(None, Some(project), None),
                Err(Unclear(Project)),
                "{project:?}"
            );
        }
        assert_eq!(
            selected_profile(Some("env"), None, Some("\"pro\\x66ile\": lab\n")),
            Err(Unclear(Global))
        );
        assert_eq!(
            selected_profile(None, Some("profile: \"la\\x62\"\n"), None),
            Err(BadName("la\\x62".to_string()))
        );
        // Plain files with other keys still fall back to `default`.
        assert_eq!(
            selected_profile(
                None,
                Some("commands:\n  test: npm test\n"),
                Some("model: x\n")
            )
            .unwrap(),
            "default"
        );
    }

    // ─── Working folder ───

    #[test]
    fn chosen_folder_rules() {
        let home = PathBuf::from("/Users/me");
        let app = PathBuf::from("/Users/me/Library/Application Support/com.greencli.app");
        let protected = vec![
            app.clone(),
            PathBuf::from("/Users/me/Library/Caches/com.greencli.app"),
            home.join(".casper"),
        ];
        let run = run_folders(
            Some(&home),
            OsStr::new("/usr/bin:/Users/me/.local/bin:relative"),
        );
        let rules = FolderRules {
            home: Some(&home),
            protected: &protected,
            run: &run,
            case_insensitive: false,
        };
        let check = |p: &str| check_chosen_folder(Path::new(p), &rules, true);
        assert!(check("/Users/me").unwrap_err().contains("home folder"));
        assert!(check("/Users").unwrap_err().contains("home folder"));
        assert!(check("/").unwrap_err().contains("home folder"));
        assert!(check("relative/x").unwrap_err().contains("full path"));
        assert!(check_chosen_folder(Path::new("/Users/me/p"), &rules, false)
            .unwrap_err()
            .contains("isn't there any more"));
        let no_home = FolderRules {
            home: None,
            protected: &protected,
            run: &run,
            case_insensitive: false,
        };
        assert!(
            check_chosen_folder(Path::new("/Users/me/p"), &no_home, true)
                .unwrap_err()
                .contains("can't find your home folder")
        );
        let own = "GreenCLI's or Casper's own files";
        assert!(check(app.to_str().unwrap()).unwrap_err().contains(own));
        assert!(check(&format!("{}/logs", app.display()))
            .unwrap_err()
            .contains(own));
        assert!(check("/Users/me/Library/Application Support")
            .unwrap_err()
            .contains(own));
        assert!(check("/Users/me/Library").unwrap_err().contains(own));
        assert!(check("/Users/me/.casper").unwrap_err().contains(own));
        assert!(check("/Users/me/code/net-lab").is_ok());
        assert!(check("/Users/me/.casperx").is_ok());
        let runs = "folder whose files other programs run";
        for p in [
            "/Users/me/.local/bin",
            "/Users/me/.local",
            "/Users/me/.claude",
            "/Users/me/.config/autostart",
            "/Users/me/Library/LaunchAgents",
            "/Users/me/code/x/.vscode",
            "/usr/local/bin",
            "/usr/local",
            "/etc",
            "/opt/tools",
        ] {
            assert!(check(p).unwrap_err().contains(runs), "{p}");
        }
        // A relative PATH entry is ignored.
        assert!(check("/Users/me/code/relative").is_ok());
        assert!(check("/Users/me")
            .unwrap_err()
            .contains("leave it on a fresh folder for each question"));

        let ci = FolderRules {
            home: Some(&home),
            protected: &protected,
            run: &run,
            case_insensitive: true,
        };
        assert!(check_chosen_folder(Path::new("/users/ME"), &ci, true).is_err());
        assert!(check_chosen_folder(Path::new("/USERS/me/.CASPER/x"), &ci, true).is_err());
        assert!(check_chosen_folder(Path::new("/users/ME"), &rules, true).is_ok());
    }

    #[test]
    fn plain_path_strips_verbatim() {
        assert_eq!(plain_path(Path::new(r"\\?\C:\x")), PathBuf::from(r"C:\x"));
        assert_eq!(
            plain_path(Path::new(r"\\?\UNC\s\x")),
            PathBuf::from(r"\\s\x")
        );
        assert_eq!(plain_path(Path::new("/a/b")), PathBuf::from("/a/b"));
    }

    #[test]
    fn git_ceiling_is_parent() {
        let dir = std::env::temp_dir().join("casper-work").join("run-1");
        let ceiling = git_ceiling(&dir).unwrap();
        assert_eq!(PathBuf::from(ceiling), dir.parent().unwrap());
    }

    #[test]
    fn git_ceiling_fails_closed() {
        let sep = if cfg!(windows) { ";" } else { ":" };
        let dir = std::env::temp_dir().join(format!("a{sep}b")).join("run-1");
        assert!(git_ceiling(&dir)
            .unwrap_err()
            .contains("Pick another folder"));
        assert!(git_ceiling(Path::new("run-1")).is_err());
        assert!(git_ceiling(Path::new("a/run-1")).is_err());
        // Only the platform's own list separator matters.
        let other = if cfg!(windows) { ":" } else { ";" };
        if !cfg!(windows) {
            let ok = std::env::temp_dir()
                .join(format!("a{other}b"))
                .join("run-1");
            assert_eq!(git_ceiling(&ok).unwrap(), ok.parent().unwrap().as_os_str());
        }
    }

    #[test]
    fn check_ceiling_follows_each_platform() {
        // macOS and Linux: ":" splits the list; the path must start at "/".
        assert!(check_ceiling("/Users/me/work", ':', false).is_ok());
        assert!(check_ceiling("/Users/me/a;b", ':', false).is_ok());
        assert!(check_ceiling("/Users/me/a:b", ':', false)
            .unwrap_err()
            .contains("holds a \":\""));
        for bad in ["", "work", "a/b", r"C:\work"] {
            assert!(check_ceiling(bad, ':', false)
                .unwrap_err()
                .contains("isn't a full path"));
        }
        // Windows: ";" splits the list; the path needs a drive or a server.
        for ok in [
            r"C:\Users\me\work",
            "c:/work",
            r"\\server\share\work",
            "//server/share",
        ] {
            assert!(check_ceiling(ok, ';', true).is_ok(), "{ok}");
        }
        assert!(check_ceiling(r"C:\Users\a;b", ';', true)
            .unwrap_err()
            .contains("holds a \";\""));
        for bad in ["", "work", r"\work", "/work", "C:work", r"C:", r"1:\work"] {
            assert!(check_ceiling(bad, ';', true).is_err(), "{bad}");
        }
    }

    #[test]
    fn instruction_files_above_cases() {
        let home = PathBuf::from("/Users/me");
        let folder = home.join("Library/Caches/app/casper-work");
        let present = [
            folder.join(".casper/rules.md"),
            home.join("Library/AGENTS.md"),
            home.join("CLAUDE.md"),
            PathBuf::from("/Users/AGENTS.md"),
        ];
        let exists = |p: &Path| present.iter().any(|x| x == p);
        let found = instruction_files_above(&folder, Some(&home), &exists);
        assert_eq!(
            found,
            vec![
                folder.join(".casper/rules.md"),
                home.join("Library/AGENTS.md")
            ]
        );
        let all = instruction_files_above(&folder, None, &exists);
        assert_eq!(all.len(), 4);
        assert!(instruction_files_above(&folder, Some(&home), &|_: &Path| false).is_empty());
    }

    #[test]
    fn project_yaml_shape() {
        let yaml = project_yaml(&[
            PathBuf::from("/Users/me/Library/Application Support/app"),
            PathBuf::from("/tmp/a \"b\"\\c"),
        ]);
        assert!(yaml.starts_with("# Written by GreenCLI"));
        assert!(yaml.contains("sandbox:\n  denyRead:\n"));
        assert!(yaml.contains("    - \"/Users/me/Library/Application Support/app\"\n"));
        assert!(yaml.contains(r#"    - "/tmp/a \"b\"\\c""#));
        assert_eq!(scan_sandbox_setting(&yaml), SandboxScan::On);
        assert_eq!(profile_setting(&yaml), Ok(None));
        assert!(!project_yaml(&[]).contains("sandbox"));
    }

    // ─── Bridges ───

    #[test]
    fn url_host_cases() {
        for local in [
            "http://127.0.0.1:8010/mcp",
            "https://localhost/mcp",
            "HTTP://LOCALHOST:9/x",
            "http://[::1]:8080/mcp",
            "http://127.1.2.3/",
            "http://user:pw@localhost:1/",
            "http://0.0.0.0:80",
            "http://app.localhost/",
            "http://localhost./",
            // Shorthand and other spellings the HTTP client reads as loopback.
            "http://127.1:8080/mcp",
            "http://2130706433/",
            "http://0x7f000001:9000/mcp",
            "http://0177.0.0.1/",
            "http://[0:0:0:0:0:0:0:1]:8080/",
            "http://[::ffff:7f00:1]/",
            "http://[::ffff:127.0.0.1]/",
            "http://[::]:80/",
            "http://0/",
            // Unreadable: fail closed.
            "",
            "127.0.0.1:80",
            "http://[::1/",
        ] {
            assert_eq!(url_host(local), UrlHost::Local, "{local}");
        }
        assert_eq!(
            url_host("http://10.0.0.1/mcp"),
            UrlHost::Ip("10.0.0.1".parse().unwrap())
        );
        assert_eq!(
            url_host("https://MCP.Example.com/"),
            UrlHost::Name("mcp.example.com".into(), 443)
        );
        assert_eq!(
            url_host("http://mbp.local:8000/mcp"),
            UrlHost::Name("mbp.local".into(), 8000)
        );
        assert_eq!(
            url_host("http://127.0.0.1.example.com/"),
            UrlHost::Name("127.0.0.1.example.com".into(), 80)
        );
        assert_eq!(
            url_host("http://localhost@evil.com/"),
            UrlHost::Name("evil.com".into(), 80)
        );
    }

    #[test]
    fn is_local_ip_cases() {
        for yes in [
            "127.0.0.1",
            "127.9.9.9",
            "0.0.0.0",
            "::1",
            "::",
            "::ffff:127.0.0.1",
            "::ffff:0.0.0.0",
        ] {
            assert!(is_local_ip(yes.parse().unwrap()), "{yes}");
        }
        for no in [
            "10.0.0.1",
            "192.168.1.5",
            "fe80::1",
            "::ffff:10.0.0.1",
            "2001:db8::1",
        ] {
            assert!(!is_local_ip(no.parse().unwrap()), "{no}");
        }
    }

    #[test]
    fn casper_run_guard_counts() {
        let count = Arc::new(AtomicUsize::new(0));
        assert!(!casper_busy(&count));
        let a = CasperRunGuard::start(&count);
        let b = CasperRunGuard::start(&count);
        assert!(casper_busy(&count));
        drop(a);
        assert!(casper_busy(&count));
        drop(b);
        assert!(!casper_busy(&count));
    }

    #[test]
    fn bridge_problem_messages() {
        assert_eq!(bridge_problem(&[], &[]), None);
        let f = bridge_problem(&[("local".into(), 8443)], &["x".into()]).unwrap();
        assert!(
            f.contains("port forward open on port 8443 (Tunnels)"),
            "{f}"
        );
        let m = bridge_problem(&[], &["central".into()]).unwrap();
        assert!(
            m.contains("web MCP server \"central\" may run on this computer"),
            "{m}"
        );
    }

    // ─── Parsing ───

    #[test]
    fn parse_last_message_wins() {
        let out = parse_json_lines(
            "{\"v\":1,\"type\":\"session_start\",\"cwd\":\"/x\"}\n\
             {\"v\":1,\"type\":\"assistant_message\",\"text\":\"first\"}\n\
             {\"v\":1,\"type\":\"assistant_message\",\"text\":\"  \"}\n\
             {\"v\":1,\"type\":\"assistant_message\",\"text\":\"second\"}\n",
        );
        assert_eq!(out.answer.as_deref(), Some("second"));
        assert!(out.any_json && !out.newer_format);
    }

    #[test]
    fn parse_delta_fallback() {
        let out = parse_json_lines(
            "{\"v\":1,\"type\":\"assistant_delta\",\"text\":\"Hel\"}\n\
             {\"v\":1,\"type\":\"assistant_delta\",\"text\":\"lo\"}\n",
        );
        assert_eq!(out.answer.as_deref(), Some("Hello"));
        let out = parse_json_lines(
            "{\"v\":1,\"type\":\"assistant_delta\",\"text\":\"x\"}\n\
             {\"v\":1,\"type\":\"assistant_message\",\"text\":\"full\"}\n",
        );
        assert_eq!(out.answer.as_deref(), Some("full"));
    }

    #[test]
    fn parse_skips_garbage_and_cut_first_line() {
        let out = parse_json_lines(
            "pe\":\"assistant_message\",\"text\":\"cut\"}\nnot json\n[1,2]\n\
             {\"v\":1,\"type\":\"error\",\"message\":\"boom\"}\n",
        );
        assert_eq!(out.answer, None);
        assert_eq!(out.errors, vec!["boom".to_string()]);
        assert!(out.any_json);
        let none = parse_json_lines("plain text\n");
        assert!(!none.any_json);
    }

    #[test]
    fn parse_newer_format() {
        let out = parse_json_lines("{\"v\":2,\"type\":\"assistant_message\",\"text\":\"x\"}\n");
        assert!(out.newer_format);
        assert_eq!(out.answer, None);
    }

    #[test]
    fn parse_receipt_fields() {
        let out = parse_json_lines(concat!(
            "{\"v\":1,\"type\":\"receipt\",\"outcome\":\"incomplete\",\"exitCode\":2,",
            "\"verdict\":\"• Incomplete\",\"turnLimit\":20,",
            "\"remoteNotRun\":[{\"host\":\"sw1\",\"commands\":2},{\"host\":\"sw2\",\"commands\":1}],",
            "\"remoteChanges\":[{\"host\":\"r1\",\"changes\":[\"vlan 10\"]},{\"host\":\"r2\",\"changes\":[]}],",
            "\"secretInCommand\":true,\"changed\":[\"a.txt\"],\"changedDuringChecks\":[\"b.txt\",\"a.txt\"],",
            "\"sandbox\":{\"held\":false,\"reason\":\"--no-sandbox\"}}\n"
        ));
        let r = out.receipt.unwrap();
        assert_eq!(r.outcome, "incomplete");
        assert_eq!(r.verdict.as_deref(), Some("• Incomplete"));
        assert_eq!(r.turn_limit, Some(20));
        assert_eq!(r.remote_not_run, 3);
        assert_eq!(r.remote_changes, vec!["r1".to_string()]);
        assert!(r.secret_in_command);
        assert_eq!(
            r.changed,
            Some(vec!["a.txt".to_string(), "b.txt".to_string()])
        );
        assert_eq!(r.sandbox_off_reason.as_deref(), Some("--no-sandbox"));

        let out = parse_json_lines(
            "{\"v\":1,\"type\":\"receipt\",\"outcome\":\"done\",\"changed\":null,\"changedDuringChecks\":[\"x\"],\"turnLimit\":null}\n",
        );
        let r = out.receipt.unwrap();
        assert_eq!(r.changed, None);
        assert_eq!(r.turn_limit, None);
        assert_eq!(r.verdict, None);
    }

    #[test]
    fn parse_sandbox_windows_reason_not_flagged() {
        let out = parse_json_lines(
            "{\"v\":1,\"type\":\"receipt\",\"outcome\":\"done\",\"changed\":[],\"sandbox\":{\"held\":false,\"reason\":\"Windows has no shell sandbox\"}}\n",
        );
        assert_eq!(out.receipt.unwrap().sandbox_off_reason, None);
        let out = parse_json_lines(
            "{\"v\":1,\"type\":\"receipt\",\"outcome\":\"done\",\"changed\":[],\"sandbox\":{\"held\":false,\"reason\":\"sandbox: off in ~/.casper/config.yaml\"}}\n",
        );
        assert!(out.receipt.unwrap().sandbox_off_reason.is_some());
    }

    // ─── Replies ───

    fn output(
        answer: Option<&str>,
        errors: &[&str],
        receipt: Option<CasperReceipt>,
    ) -> CasperOutput {
        CasperOutput {
            answer: answer.map(str::to_string),
            errors: errors.iter().map(|e| e.to_string()).collect(),
            receipt,
            newer_format: false,
            any_json: true,
        }
    }

    fn receipt(verdict: &str) -> CasperReceipt {
        CasperReceipt {
            outcome: "done".into(),
            verdict: Some(verdict.into()),
            changed: Some(vec![]),
            ..Default::default()
        }
    }

    #[test]
    fn reply_cancelled_and_timed_out() {
        let out = output(Some("x"), &[], None);
        assert_eq!(
            casper_reply(RunEnd::Cancelled, &out, "", None).unwrap_err(),
            "Stopped."
        );
        assert!(casper_reply(RunEnd::TimedOut, &out, "", None)
            .unwrap_err()
            .contains("10 minutes"));
    }

    #[test]
    fn reply_newer_format() {
        let mut out = output(None, &[], None);
        out.newer_format = true;
        assert!(casper_reply(RunEnd::Exited(Some(0)), &out, "", None)
            .unwrap_err()
            .contains("newer format"));
        out.answer = Some("fine".into());
        assert_eq!(
            casper_reply(RunEnd::Exited(Some(0)), &out, "", None).unwrap(),
            "fine"
        );
    }

    #[test]
    fn reply_not_set_up() {
        for said in [
            "No Casper model selected. Use /model to pick one.",
            "Credentials missing for anthropic. Use /login to sign in.",
            "Credential state needs local refresh. Open casper.",
            "Model a/b is unavailable. Use /model to pick another.",
        ] {
            let out = output(None, &[said], None);
            let e = casper_reply(RunEnd::Exited(Some(1)), &out, "", None).unwrap_err();
            assert!(e.starts_with("Casper isn't ready to answer"), "{e}");
            assert!(e.ends_with(&format!("Casper said: {said}")), "{e}");
        }
        // Without JSON, stderr says it.
        let mut out = output(None, &[], None);
        out.any_json = false;
        let e = casper_reply(
            RunEnd::Exited(Some(1)),
            &out,
            "x\nNo Casper model selected\n",
            None,
        )
        .unwrap_err();
        assert!(e.starts_with("Casper isn't ready"), "{e}");
    }

    #[test]
    fn reply_exit_0() {
        let out = output(Some("Answer."), &[], Some(receipt("✓ Done")));
        assert_eq!(
            casper_reply(RunEnd::Exited(Some(0)), &out, "", None).unwrap(),
            "Answer."
        );
        let out = output(None, &[], Some(receipt("✓ Done")));
        assert_eq!(
            casper_reply(RunEnd::Exited(Some(0)), &out, "", None).unwrap_err(),
            "Casper finished without an answer."
        );
    }

    #[test]
    fn reply_exit_1() {
        let out = output(
            Some("Partial."),
            &["boom"],
            Some(receipt("✗ Failed: a check")),
        );
        let ok = casper_reply(RunEnd::Exited(Some(1)), &out, "", None).unwrap();
        assert_eq!(ok, "Partial.\n\n---\n*Casper says: Failed: a check*");
        // The transcript goes to stderr with --json: the error event is the reason.
        let out = output(None, &["Provider said no"], Some(receipt("✗ Failed")));
        let e = casper_reply(
            RunEnd::Exited(Some(1)),
            &out,
            "│ casper › thinking about it\n",
            None,
        )
        .unwrap_err();
        assert_eq!(e, "Casper couldn't answer: Provider said no");
        let out = output(None, &[], Some(receipt("✗ Failed: x")));
        assert_eq!(
            casper_reply(RunEnd::Exited(Some(1)), &out, "", None).unwrap_err(),
            "Casper couldn't answer: Failed: x"
        );
        let out = output(None, &[], None);
        assert_eq!(
            casper_reply(RunEnd::Exited(Some(1)), &out, "", None).unwrap_err(),
            "Casper couldn't answer: it stopped with an error"
        );
    }

    #[test]
    fn reply_exit_2_notes_and_plurals() {
        let mut r = receipt("• Incomplete");
        r.turn_limit = Some(20);
        let out = output(Some("So far."), &[], Some(r.clone()));
        let ok = casper_reply(RunEnd::Exited(Some(2)), &out, "", None).unwrap();
        assert!(
            ok.contains("*Casper reached its turn limit (20) before it finished."),
            "{ok}"
        );

        r.turn_limit = None;
        r.remote_not_run = 1;
        let out = output(Some("So far."), &[], Some(r.clone()));
        let ok = casper_reply(RunEnd::Exited(Some(2)), &out, "", None).unwrap();
        assert!(
            ok.contains("didn't run 1 command on other machines"),
            "{ok}"
        );
        r.remote_not_run = 3;
        let out = output(Some("So far."), &[], Some(r.clone()));
        let ok = casper_reply(RunEnd::Exited(Some(2)), &out, "", None).unwrap();
        assert!(
            ok.contains("didn't run 3 commands on other machines"),
            "{ok}"
        );

        r.remote_not_run = 0;
        let out = output(Some("So far."), &[], Some(r));
        let ok = casper_reply(RunEnd::Exited(Some(2)), &out, "", None).unwrap();
        assert!(
            ok.ends_with("*Casper stopped before it finished: Incomplete*"),
            "{ok}"
        );

        let out = output(None, &[], Some(receipt("• Incomplete — checks")));
        assert_eq!(
            casper_reply(RunEnd::Exited(Some(2)), &out, "", None).unwrap_err(),
            "Casper stopped before it finished: Incomplete — checks"
        );
    }

    #[test]
    fn reply_exit_3() {
        let out = output(Some("Done."), &[], Some(receipt("• Not verified")));
        let ok = casper_reply(RunEnd::Exited(Some(3)), &out, "", None).unwrap();
        assert!(
            ok.ends_with("*Casper didn't check this change: Not verified*"),
            "{ok}"
        );
        let out = output(None, &[], Some(receipt("• Not verified")));
        assert!(casper_reply(RunEnd::Exited(Some(3)), &out, "", None)
            .unwrap_err()
            .starts_with("Casper stopped before it finished"));
    }

    #[test]
    fn reply_exit_64_uses_stderr() {
        let out = output(None, &[], None);
        let e = casper_reply(
            RunEnd::Exited(Some(64)),
            &out,
            "\nUnknown option --x. Run casper --help\n\n",
            None,
        )
        .unwrap_err();
        assert_eq!(e, "Casper didn't accept the options GreenCLI sent: Unknown option --x. Run casper --help. Check the Casper command in Settings → AI & MCP.");
    }

    #[test]
    fn reply_signals_and_other_codes() {
        let out = output(None, &["boom"], None);
        for code in [Some(130), Some(143), None] {
            assert_eq!(
                casper_reply(RunEnd::Exited(code), &out, "", None).unwrap_err(),
                "Casper was stopped before it answered."
            );
        }
        assert_eq!(
            casper_reply(RunEnd::Exited(Some(9)), &out, "", None).unwrap_err(),
            "Casper failed (exit 9): boom"
        );
        let mut plain = output(None, &[], None);
        plain.any_json = false;
        assert_eq!(
            casper_reply(
                RunEnd::Exited(Some(127)),
                &plain,
                "env: bun: No such file\n",
                None
            )
            .unwrap_err(),
            "Casper failed (exit 127): env: bun: No such file"
        );
    }

    #[test]
    fn reply_changed_notes() {
        let folder = Path::new("/Users/me/code/lab");
        let mut r = receipt("✓ Done");
        r.changed = Some((1..=10).map(|i| format!("f{i}.txt")).collect());
        let out = output(Some("Ok."), &[], Some(r.clone()));
        let ok = casper_reply(RunEnd::Exited(Some(0)), &out, "", Some(folder)).unwrap();
        assert!(ok.contains("*Casper changed these files in lab: f1.txt, f2.txt, f3.txt, f4.txt, f5.txt, f6.txt, f7.txt, f8.txt and 2 more.*"), "{ok}");
        // GreenCLI's own folder is deleted afterwards: no note.
        assert_eq!(
            casper_reply(RunEnd::Exited(Some(0)), &out, "", None).unwrap(),
            "Ok."
        );

        r.changed = None;
        let out = output(Some("Ok."), &[], Some(r.clone()));
        let ok = casper_reply(RunEnd::Exited(Some(0)), &out, "", Some(folder)).unwrap();
        assert!(
            ok.contains("may have changed files in its working folder"),
            "{ok}"
        );

        r.changed = Some(vec![]);
        let out = output(Some("Ok."), &[], Some(r));
        assert_eq!(
            casper_reply(RunEnd::Exited(Some(0)), &out, "", Some(folder)).unwrap(),
            "Ok."
        );
    }

    #[test]
    fn reply_remote_secret_and_sandbox_notes() {
        let mut r = receipt("✓ Done");
        r.remote_changes = vec!["sw1".into(), "sw2".into()];
        r.secret_in_command = true;
        r.sandbox_off_reason = Some("--no-sandbox".into());
        let out = output(Some("Ok."), &[], Some(r));
        let ok = casper_reply(RunEnd::Exited(Some(0)), &out, "", None).unwrap();
        assert_eq!(
            ok,
            "Ok.\n\n---\n*Casper changed things on sw1, sw2.*\n\n*A secret showed up in a command Casper ran. Change that secret.*\n\n*Casper's sandbox was off (--no-sandbox), so its commands ran without it.*"
        );
    }

    #[test]
    fn stderr_hint_is_last_line_and_capped() {
        assert_eq!(stderr_hint("a\nb\n\n"), "b");
        assert_eq!(stderr_hint(""), "");
        let long = "é".repeat(400);
        let hint = stderr_hint(&long);
        assert!(hint.len() <= 300 && hint.chars().all(|c| c == 'é'));
    }

    // ─── Usage ───

    #[test]
    fn parse_receipt_usage() {
        let line = |usage: &str| {
            parse_json_lines(&format!(
                "{{\"v\":1,\"type\":\"receipt\",\"outcome\":\"done\",\"changed\":[],{usage}}}\n"
            ))
            .receipt
            .unwrap()
        };
        let r = line("\"usage\":{\"turns\":3,\"tokens\":4210,\"estimatedCost\":0.0213}");
        assert_eq!(r.usage_tokens, Some(4210));
        assert_eq!(r.usage_cost, Some(0.0213));
        let r = line("\"usage\":{\"turns\":3,\"tokens\":null,\"estimatedCost\":null}");
        assert_eq!((r.usage_tokens, r.usage_cost), (None, None));
        let r = line("\"usage\":null");
        assert_eq!((r.usage_tokens, r.usage_cost), (None, None));
        let r = line("\"turnLimit\":null");
        assert_eq!((r.usage_tokens, r.usage_cost), (None, None));
        let r = line("\"usage\":{\"turns\":1,\"tokens\":900,\"estimatedCost\":-1}");
        assert_eq!((r.usage_tokens, r.usage_cost), (Some(900), None));
    }

    #[test]
    fn usage_note_formats() {
        assert_eq!(
            usage_note(Some(4210), Some(0.0213)).as_deref(),
            Some("Casper used 4,210 tokens (about $0.02).")
        );
        assert_eq!(
            usage_note(Some(1_234_567), Some(1.5)).as_deref(),
            Some("Casper used 1,234,567 tokens (about $1.50).")
        );
        assert_eq!(
            usage_note(Some(850), Some(0.0004)).as_deref(),
            Some("Casper used 850 tokens (under $0.01).")
        );
        assert_eq!(
            usage_note(Some(850), Some(0.0)).as_deref(),
            Some("Casper used 850 tokens (about $0).")
        );
        assert_eq!(
            usage_note(Some(1), None).as_deref(),
            Some("Casper used 1 token.")
        );
        assert_eq!(
            usage_note(None, Some(0.05)).as_deref(),
            Some("Casper used about $0.05.")
        );
        assert_eq!(usage_note(None, None), None);
    }

    #[test]
    fn reply_shows_usage_on_every_answer() {
        let recorded = concat!(
            "{\"v\":1,\"type\":\"session_start\"}\n",
            "{\"v\":1,\"type\":\"assistant_message\",\"text\":\"VLAN 10 is fine.\"}\n",
            "{\"v\":1,\"type\":\"receipt\",\"outcome\":\"done\",\"exitCode\":0,\"changed\":[],",
            "\"verdict\":\"✓ Done\",\"usage\":{\"turns\":2,\"tokens\":4210,\"estimatedCost\":0.0213}}\n"
        );
        let out = parse_json_lines(recorded);
        assert_eq!(
            casper_reply(RunEnd::Exited(Some(0)), &out, "", None).unwrap(),
            "VLAN 10 is fine.\n\n---\n*Casper used 4,210 tokens (about $0.02).*"
        );

        // No cost from Casper: tokens only.
        let out = parse_json_lines(&recorded.replace("0.0213", "null"));
        assert_eq!(
            casper_reply(RunEnd::Exited(Some(0)), &out, "", None).unwrap(),
            "VLAN 10 is fine.\n\n---\n*Casper used 4,210 tokens.*"
        );

        // No usage at all: the reply is unchanged.
        let out = parse_json_lines(&recorded.replace(
            "\"usage\":{\"turns\":2,\"tokens\":4210,\"estimatedCost\":0.0213}",
            "\"usage\":null",
        ));
        assert_eq!(
            casper_reply(RunEnd::Exited(Some(0)), &out, "", None).unwrap(),
            "VLAN 10 is fine."
        );

        // The usage note comes last, after the other notes, on exit 1, 2 and 3 too.
        for code in [1, 2, 3] {
            let mut r = receipt("• Incomplete");
            r.secret_in_command = true;
            r.usage_tokens = Some(12);
            r.usage_cost = Some(0.3);
            let out = output(Some("So far."), &[], Some(r));
            let ok = casper_reply(RunEnd::Exited(Some(code)), &out, "", None).unwrap();
            assert!(ok.contains("*A secret showed up"), "{ok}");
            assert!(
                ok.ends_with("*Casper used 12 tokens (about $0.30).*"),
                "{code}: {ok}"
            );
        }
    }
}
