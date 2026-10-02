// The AI panel's CLI providers: Local CLI (any locally installed agent CLI)
// and Casper. Both run without a shell through cli_run::run_cli_process, so
// Stop, the timeout and quitting GreenCLI stop them.
//
// Casper gets more care than a generic CLI (see casper.rs for the pure
// parts): only known options, a working folder of its own, no start while
// its sandbox is off or a local port leads into the network, and a version
// check. No Tauri here: main.rs gathers the app's folders, forwards and MCP
// servers into a CliContext.

use super::casper::{
    self, CasperVersion, FolderRules, ProfileError, ProfileSource, RunEnd, SandboxScan, UrlHost,
};
use super::cli_run::{run_cli_process, RunOpts};
use super::floor_char_boundary;
use crate::error::AppError;
use crate::private_fs;
use std::borrow::Cow;
use std::collections::HashSet;
use std::net::IpAddr;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

/// What a CLI run needs from the app.
pub struct CliContext {
    /// GreenCLI's data folder (keys, sessions, MCP servers, logs).
    pub app_dir: PathBuf,
    /// GreenCLI's cache folder; Casper's per-question folders live under it.
    pub cache_dir: Option<PathBuf>,
    /// Casper only: the folder the user picked; None or blank = a fresh folder per question.
    pub work_folder: Option<String>,
    /// The Casper provider asked for this run (refuses any program but Casper).
    pub as_casper: bool,
    /// Open local/dynamic port forwards (kind, local port), and web MCP
    /// servers that may run on this computer (names, see local_mcp_servers).
    pub bridges: (Vec<(String, u16)>, Vec<String>),
    /// More folders Casper may not work in (the session-log folder, if set).
    pub extra_protected: Vec<PathBuf>,
    /// Tripped by Stop.
    pub cancel: Option<Arc<AtomicBool>>,
}

/// The result of Settings → Check Casper.
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CasperCheck {
    pub ok: bool,
    pub version: Option<String>,
    pub work_folder: String,
    pub message: String,
    pub folder_ok: bool,
    pub folder_message: Option<String>,
    pub warnings: Vec<String>,
}

/// How long a generic Local CLI may run.
const CLI_TIMEOUT: Duration = Duration::from_secs(180);
/// Leftover question folders older than this are removed.
const STALE_RUN: Duration = Duration::from_secs(60 * 60);
/// Windows and macOS compare folder names without case.
const CASE_INSENSITIVE: bool = cfg!(any(windows, target_os = "macos"));

fn api(msg: impl Into<String>) -> AppError {
    AppError::ApiError(msg.into())
}

// ─── Command line ───

/// Tokenize a configured CLI command into program + argv WITHOUT a shell, so
/// metacharacters (`&`, `|`, `;`, backticks, …) in the string are passed
/// literally to the program instead of being interpreted. Supports single and
/// double quotes. With `backslash_escapes` (unix), a backslash outside single
/// quotes escapes the next character; on Windows a backslash is a path
/// separator and is kept as typed (quotes handle spaces).
fn split_command_with(cmd: &str, backslash_escapes: bool) -> Result<Vec<String>, String> {
    let mut out: Vec<String> = Vec::new();
    let mut cur = String::new();
    let mut in_single = false;
    let mut in_double = false;
    let mut escaped = false;
    let mut has_token = false;
    for c in cmd.chars() {
        if escaped {
            cur.push(c);
            escaped = false;
            continue;
        }
        match c {
            '\\' if backslash_escapes && !in_single => escaped = true,
            '\'' if !in_double => {
                in_single = !in_single;
                has_token = true;
            }
            '"' if !in_single => {
                in_double = !in_double;
                has_token = true;
            }
            c if c.is_whitespace() && !in_single && !in_double => {
                if has_token {
                    out.push(std::mem::take(&mut cur));
                    has_token = false;
                }
            }
            c => {
                cur.push(c);
                has_token = true;
            }
        }
    }
    if escaped {
        cur.push('\\');
    }
    if in_single || in_double {
        return Err("CLI command has an unterminated quote".into());
    }
    if has_token {
        out.push(cur);
    }
    if out.is_empty() {
        return Err("Empty CLI command".into());
    }
    Ok(out)
}

fn split_command(cmd: &str) -> Result<Vec<String>, AppError> {
    split_command_with(cmd, !cfg!(windows)).map_err(AppError::ApiError)
}

/// Same refusal as MCP stdio server spawning (mcp::client::validate_stdio_command):
/// a shell interpreter named AS the CLI would re-introduce shell interpretation
/// of its args (`sh -c …`), defeating the no-shell spawn. `env` is an exec
/// wrapper that would do the same for whatever it starts.
fn refuse_program(argv0: &str) -> Result<(), AppError> {
    let file_name = argv0
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(argv0)
        .to_ascii_lowercase();
    const REFUSED: [&str; 12] = [
        "sh",
        "bash",
        "zsh",
        "fish",
        "cmd",
        "cmd.exe",
        "powershell",
        "powershell.exe",
        "pwsh",
        "pwsh.exe",
        "env",
        "env.exe",
    ];
    if REFUSED.contains(&file_name.as_str()) {
        return Err(api(format!(
            "Refusing to launch shell interpreter '{}' as an AI CLI (its args would be \
             shell-interpreted). Configure the CLI binary directly (e.g. `claude`, `kimi`, \
             an absolute path) instead.",
            argv0
        )));
    }
    Ok(())
}

/// Cap the prompt at 64 KiB. When over, keep the HEAD *and* the TAIL: the
/// prompt ends with the user's question, so dropping the tail would silently
/// discard it. Cuts land on UTF-8 char boundaries.
fn cap_prompt(prompt: &str) -> Cow<'_, str> {
    const MAX_PROMPT_BYTES: usize = 64 * 1024;
    const HEAD_BYTES: usize = 8 * 1024; // the tail gets the remaining ~56 KiB
    if prompt.len() <= MAX_PROMPT_BYTES {
        return Cow::Borrowed(prompt);
    }
    let head_end = floor_char_boundary(prompt, HEAD_BYTES);
    let tail_start = floor_char_boundary(prompt, prompt.len() - (MAX_PROMPT_BYTES - HEAD_BYTES));
    Cow::Owned(format!(
        "{}\n…[input truncated]…\n{}",
        &prompt[..head_end],
        &prompt[tail_start..]
    ))
}

// ─── Dispatch ───

/// Casper (asked for by the Casper provider, or typed as the Local CLI
/// command, even as a `.cmd` shim that is then refused) runs through `run_casper`.
fn routes_to_casper(argv0: &str, as_casper: bool) -> bool {
    as_casper || casper::is_casper_program(argv0) || casper::refuse_batch_shim(argv0).is_err()
}

/// Whether `cli_passthrough` will run this command as Casper.
pub fn is_casper_command(command: &str, as_casper: bool) -> bool {
    as_casper
        || split_command(command.trim())
            .ok()
            .and_then(|argv| argv.into_iter().next())
            .is_some_and(|argv0| routes_to_casper(&argv0, false))
}

/// How long looking up an MCP server's host name may take.
const LOOKUP_TIMEOUT: Duration = Duration::from_secs(3);

/// An address of this computer: binding a socket to it works. A server
/// listening on all addresses answers on 127.0.0.1 too, however it is named.
fn is_own_address(ip: IpAddr) -> bool {
    casper::is_local_ip(ip) || std::net::UdpSocket::bind((ip, 0)).is_ok()
}

/// Whether `host` (lowercase, from url_host) names this computer by its own
/// host name `own`: the full name, its first part, or the first part with
/// ".local" (macOS Bonjour names). No lookup.
pub fn is_own_host_name(host: &str, own: &str) -> bool {
    let own = own.trim().trim_end_matches('.').to_ascii_lowercase();
    if own.is_empty() {
        return false;
    }
    let short = own.split('.').next().unwrap_or(&own);
    host == own || host == short || host.strip_suffix(".local") == Some(short)
}

/// Whether a saved web MCP server's URL is literally this computer, with no
/// name lookup: localhost, *.localhost, a loopback or unspecified address in
/// any spelling, one of this computer's own addresses, or its own host name.
/// Used for saved servers GreenCLI isn't connected to, so a saved server that
/// only resolves on a VPN doesn't block Casper (or wait on a lookup).
pub fn mcp_url_is_literally_local(url: &str) -> bool {
    match casper::url_host(url) {
        UrlHost::Local => true,
        UrlHost::Ip(ip) => is_own_address(ip),
        UrlHost::Name(host, _) => {
            is_own_host_name(&host, &gethostname::gethostname().to_string_lossy())
        }
    }
}

/// The web MCP servers that may lead to this computer, by name (sorted, each
/// once). `servers` holds (name, url, connected). A connected server's address
/// is looked up (mcp_url_is_local, all at once, each with the lookup timeout);
/// a saved one that isn't connected is only checked as written
/// (mcp_url_is_literally_local).
pub async fn local_mcp_servers(servers: Vec<(String, String, bool)>) -> Vec<String> {
    let checks = servers
        .into_iter()
        .map(|(name, url, connected)| async move {
            let local = if connected {
                mcp_url_is_local(&url).await
            } else {
                mcp_url_is_literally_local(&url)
            };
            local.then_some(name)
        });
    let mut names: Vec<String> = futures::future::join_all(checks)
        .await
        .into_iter()
        .flatten()
        .collect();
    names.sort();
    names.dedup();
    names
}

/// Whether an MCP server URL may lead to this computer: loopback names and
/// addresses, this computer's own addresses, and host names that resolve to
/// any of those. Fails closed: a name that doesn't resolve in time counts.
pub async fn mcp_url_is_local(url: &str) -> bool {
    match casper::url_host(url) {
        UrlHost::Local => true,
        UrlHost::Ip(ip) => is_own_address(ip),
        UrlHost::Name(host, port) => {
            let lookup = tokio::time::timeout(
                LOOKUP_TIMEOUT,
                tokio::net::lookup_host((host.as_str(), port)),
            )
            .await;
            match lookup {
                Ok(Ok(addrs)) => {
                    let mut any = false;
                    for addr in addrs {
                        any = true;
                        if is_own_address(addr.ip()) {
                            return true;
                        }
                    }
                    !any
                }
                _ => true,
            }
        }
    }
}

/// Run an AI CLI one-shot with the prompt on stdin and return its answer.
/// Casper (asked for by the Casper provider, or typed as the Local CLI
/// command) goes through `run_casper`; any other CLI keeps its old handling.
pub async fn cli_passthrough(
    command: &str,
    prompt: &str,
    ctx: CliContext,
) -> Result<String, AppError> {
    if command.trim().is_empty() {
        return Err(api("Empty CLI command"));
    }
    let argv = split_command(command.trim())?;
    refuse_program(&argv[0])?;
    // Before the kimi/claude rewrites below: `--model moonshot/kimi-k2` must
    // never get kimi's --quiet.
    if routes_to_casper(&argv[0], ctx.as_casper) {
        return run_casper(argv, prompt, ctx)
            .await
            .map_err(AppError::ApiError);
    }

    // Normalize the command: kimi needs --quiet for non-interactive piped stdin.
    let command = {
        let cmd = command.trim();
        if cmd.contains("kimi") && !cmd.contains("--quiet") && !cmd.contains("--print") {
            format!("{} --quiet", cmd)
        } else {
            cmd.to_string()
        }
    };

    // claude CLI: keep one-shot `-p` runs fast and cheap. Without an explicit
    // --model it inherits the user's Claude Code default (often Opus — slow and
    // pricey for a chat sidekick), and at startup it connects to every MCP
    // server in the user's Claude config (which can be dozens of tools and many
    // seconds) — pure overhead here, since GreenCli pipes a prompt and reads
    // text back. Both injections defer to anything the user set explicitly in
    // the command string.
    let command = {
        let is_claude = command
            .split_whitespace()
            .next()
            .map(|p| p == "claude" || p.ends_with("/claude"))
            .unwrap_or(false);
        if is_claude {
            let mut c = command;
            if !c.contains("--model") {
                c.push_str(" --model haiku");
            }
            if !c.contains("--mcp-config") && !c.contains("--strict-mcp-config") {
                c.push_str(" --strict-mcp-config");
            }
            c
        } else {
            command
        }
    };

    let argv = split_command(&command)?;
    refuse_program(&argv[0])?;
    let prompt = cap_prompt(prompt);
    let run = run_cli_process(
        &argv,
        prompt.as_bytes().to_vec(),
        RunOpts {
            cwd: None,
            env: Vec::new(),
            timeout: CLI_TIMEOUT,
            cancel: ctx.cancel.clone(),
        },
    )
    .await
    .map_err(|e| api(format!("Failed to launch '{}': {}", command, e)))?;

    let code = match run.end {
        RunEnd::Exited(code) => code,
        RunEnd::Cancelled => return Err(api("Stopped.")),
        // A CLI stuck on an OAuth/login prompt, interactive mode, or a blocking
        // shell profile would otherwise hang the AI chat forever.
        RunEnd::TimedOut => {
            return Err(api(format!(
                "Local CLI timed out after 180s — is it waiting for input/login? \
                 Run `{}` once in a terminal to complete any login/setup, or switch \
                 providers in Settings → AI Assistant.",
                command
            )))
        }
    };
    let mut out = String::from_utf8_lossy(&run.stdout).to_string();
    if code != Some(0) {
        let err = String::from_utf8_lossy(&run.stderr);
        if out.trim().is_empty() {
            out = err.to_string();
        } else {
            out.push_str(&format!("\n[stderr] {}", err));
        }
    }
    // Strip CLI session-resume noise (e.g. kimi's "To resume this session: ...")
    let cleaned: Vec<&str> = out
        .lines()
        .filter(|l| !l.starts_with("To resume this session"))
        .collect();
    Ok(cleaned.join("\n").trim().to_string())
}

// ─── Casper ───

/// $HOME (USERPROFILE on Windows), as Casper reads it.
fn home_dir() -> Option<PathBuf> {
    let var = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
    std::env::var_os(var)
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
}

fn canonical(p: &Path) -> Option<PathBuf> {
    std::fs::canonicalize(p)
        .ok()
        .map(|c| casper::plain_path(&c))
}

fn picked_folder(ctx: &CliContext) -> Option<&str> {
    ctx.work_folder
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
}

/// Folders Casper may not work in, as given and canonical.
fn protected_folders(ctx: &CliContext, home: Option<&Path>) -> Vec<PathBuf> {
    let mut list: Vec<PathBuf> = vec![ctx.app_dir.clone()];
    list.extend(ctx.cache_dir.clone());
    list.extend(home.map(|h| h.join(".casper")));
    list.extend(ctx.extra_protected.iter().cloned());
    let canon: Vec<PathBuf> = list
        .iter()
        .map(PathBuf::as_path)
        .filter_map(canonical)
        .collect();
    list.extend(canon);
    list
}

/// Check the picked folder; returns it canonical.
fn check_picked(chosen: &str, ctx: &CliContext) -> Result<PathBuf, String> {
    let home = home_dir();
    let home_canon = home.as_deref().and_then(canonical);
    let raw = PathBuf::from(chosen);
    let (path, is_dir) = if raw.is_absolute() {
        match canonical(&raw) {
            Some(p) => {
                let d = p.is_dir();
                (p, d)
            }
            None => (raw, false),
        }
    } else {
        (raw, false)
    };
    let protected = protected_folders(ctx, home.as_deref());
    // The PATH a Casper run and the user's tools see.
    let path_var = super::casper::augmented_path(
        &std::env::var_os("PATH").unwrap_or_default(),
        home.as_deref(),
    );
    let mut run = super::casper::run_folders(home.as_deref(), &path_var);
    let canon: Vec<PathBuf> = run.iter().filter_map(|p| canonical(p)).collect();
    run.extend(canon);
    let rules = FolderRules {
        home: home_canon.as_deref(),
        protected: &protected,
        run: &run,
        case_insensitive: CASE_INSENSITIVE,
    };
    casper::check_chosen_folder(&path, &rules, is_dir)?;
    Ok(path)
}

fn file_list(files: &[PathBuf]) -> String {
    files
        .iter()
        .map(|f| f.display().to_string())
        .collect::<Vec<_>>()
        .join(", ")
}

fn exists(p: &Path) -> bool {
    p.exists()
}

/// Question folders in use in this process; the stale sweep never removes them.
fn active_runs() -> &'static Mutex<HashSet<PathBuf>> {
    static ACTIVE: OnceLock<Mutex<HashSet<PathBuf>>> = OnceLock::new();
    ACTIVE.get_or_init(|| Mutex::new(HashSet::new()))
}

/// One question's folder: deleted when dropped, however the run ends.
struct RunFolder(PathBuf);

impl RunFolder {
    fn new(dir: PathBuf) -> Self {
        if let Ok(mut set) = active_runs().lock() {
            set.insert(dir.clone());
        }
        RunFolder(dir)
    }
}

impl Drop for RunFolder {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
        if let Ok(mut set) = active_runs().lock() {
            set.remove(&self.0);
        }
    }
}

/// Remove question folders an earlier run left behind (a crash, a kill):
/// `run-…` folders older than `stale_after` that no run in this process holds.
fn sweep_stale_runs(root: &Path, stale_after: Duration) {
    let Ok(entries) = std::fs::read_dir(root) else {
        return;
    };
    let active = active_runs().lock().map(|s| s.clone()).unwrap_or_default();
    for entry in entries.flatten() {
        let path = entry.path();
        if !entry.file_name().to_string_lossy().starts_with("run-") || active.contains(&path) {
            continue;
        }
        let Ok(meta) = std::fs::symlink_metadata(&path) else {
            continue;
        };
        let old = meta
            .modified()
            .ok()
            .and_then(|m| m.elapsed().ok())
            .is_some_and(|age| age > stale_after);
        if meta.is_dir() && old {
            let _ = std::fs::remove_dir_all(&path);
        }
    }
}

/// Where a Casper question runs.
struct WorkPlace {
    dir: PathBuf,
    /// The user picked it (else it is GreenCLI's fresh folder).
    picked: bool,
    /// Deletes GreenCLI's fresh folder when dropped.
    _cleanup: Option<RunFolder>,
}

fn io_msg(e: impl std::fmt::Display) -> String {
    format!("GreenCLI couldn't make Casper's working folder: {e}")
}

const NO_CACHE_DIR: &str =
    "GreenCLI can't find its cache folder, so it can't give Casper a working folder.";

/// The folder that holds the fresh per-question folders, created and checked.
fn ready_work_root(ctx: &CliContext) -> Result<PathBuf, String> {
    let cache = ctx.cache_dir.as_deref().ok_or(NO_CACHE_DIR)?;
    let root = casper::work_root(cache);
    private_fs::private_dir(&root).map_err(io_msg)?;
    let found = casper::instruction_files_above(&root, home_dir().as_deref(), &exists);
    if !found.is_empty() {
        return Err(format!(
            "GreenCLI's Casper folder {} has instruction files above it ({}). Remove them, then try again.",
            root.display(),
            file_list(&found)
        ));
    }
    Ok(root)
}

fn prepare_work_place(ctx: &CliContext) -> Result<WorkPlace, String> {
    if let Some(chosen) = picked_folder(ctx) {
        let dir = check_picked(chosen, ctx)?;
        return Ok(WorkPlace {
            dir,
            picked: true,
            _cleanup: None,
        });
    }
    let root = ready_work_root(ctx)?;
    sweep_stale_runs(&root, STALE_RUN);
    let dir = root.join(casper::run_folder_name(rand::random()));
    let cleanup = RunFolder::new(dir.clone());
    private_fs::private_dir(&dir).map_err(io_msg)?;
    let dot = dir.join(".casper");
    private_fs::private_dir(&dot).map_err(io_msg)?;
    let mut deny = vec![ctx.app_dir.clone()];
    deny.extend(ctx.extra_protected.iter().cloned());
    private_fs::write_private(
        &dot.join("project.yaml"),
        casper::project_yaml(&deny).as_bytes(),
    )
    .map_err(io_msg)?;
    Ok(WorkPlace {
        dir,
        picked: false,
        _cleanup: Some(cleanup),
    })
}

/// A config file's text; None when it doesn't exist. Any other read error
/// fails closed, and says why (a permission, a file that isn't UTF-8 text, a
/// folder in its place) instead of asking for plainer YAML.
fn read_config(file: &Path) -> Result<Option<String>, String> {
    match std::fs::read_to_string(file) {
        Ok(text) => Ok(Some(text)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(read_config_message(file, &e)),
    }
}

fn read_config_message(file: &Path, e: &std::io::Error) -> String {
    let why = if e.kind() == std::io::ErrorKind::InvalidData {
        "it isn't UTF-8 text".to_string()
    } else {
        e.to_string()
    };
    format!(
        "GreenCLI couldn't read {} ({why}), so it can't check Casper's sandbox setting. Fix the file, then try again.",
        file.display()
    )
}

fn scan_file(text: Option<&str>, file: &Path) -> Result<(), String> {
    let scan = text.map_or(SandboxScan::On, casper::scan_sandbox_setting);
    match casper::sandbox_message(scan, file) {
        Some(m) => Err(m),
        None => Ok(()),
    }
}

fn profile_message(e: ProfileError, project_file: Option<&Path>, global_file: &Path) -> String {
    match e {
        ProfileError::BadName(bad) => format!("GreenCLI couldn't tell which Casper profile is in use (\"{bad}\" isn't a profile name), so it can't check that profile's sandbox setting. Fix the profile name, then try again."),
        ProfileError::Unclear(source) => {
            let file = match source {
                ProfileSource::Project => project_file.unwrap_or(global_file),
                ProfileSource::Global => global_file,
            };
            format!("GreenCLI couldn't tell which Casper profile {} picks, so it can't check that profile's sandbox setting. Write that file in a plainer way (plain key names, and \"profile: name\" on one line), then try again.", file.display())
        }
    }
}

/// Refuse when Casper's own config turns the sandbox off, or can't be read:
/// `~/.casper/config.yaml` and the selected profile's `config.yaml`.
/// `picked` is the user's folder (its `.casper/project.yaml` can pick a profile).
fn check_sandbox(picked: Option<&Path>) -> Result<(), String> {
    let home = home_dir()
        .ok_or("GreenCLI can't find your home folder, so it can't check Casper's settings.")?;
    let casper_home = home.join(".casper");
    let global_file = casper_home.join("config.yaml");
    let global = read_config(&global_file)?;
    scan_file(global.as_deref(), &global_file)?;
    let project_file = picked.map(|dir| dir.join(".casper").join("project.yaml"));
    let project = match &project_file {
        Some(file) => read_config(file)?,
        None => None,
    };
    let env = match std::env::var_os("CASPER_PROFILE") {
        None => None,
        Some(v) => Some(v.into_string().map_err(|_| {
            "GreenCLI couldn't read the CASPER_PROFILE setting, so it can't check Casper's sandbox."
                .to_string()
        })?),
    };
    let profile = casper::selected_profile(env.as_deref(), project.as_deref(), global.as_deref())
        .map_err(|e| profile_message(e, project_file.as_deref(), &global_file))?;
    let profile_file = casper_home
        .join("profiles")
        .join(&profile)
        .join("config.yaml");
    let text = read_config(&profile_file)?;
    scan_file(text.as_deref(), &profile_file)
}

/// The Casper program as an absolute path, before any folder change.
fn resolve_casper(argv0: &str) -> Result<PathBuf, String> {
    let current = std::env::var_os("PATH").unwrap_or_default();
    #[cfg(unix)]
    let path = casper::augmented_path(&current, home_dir().as_deref());
    #[cfg(not(unix))]
    let path = current;
    let local_app_data = std::env::var_os("LOCALAPPDATA");
    casper::resolve_program(
        argv0,
        &path,
        cfg!(windows),
        local_app_data.as_deref(),
        &|p: &Path| p.is_file(),
    )?
    .ok_or_else(|| casper::NOT_INSTALLED.to_string())
}

fn spawn_error(e: std::io::Error) -> String {
    if e.kind() == std::io::ErrorKind::NotFound {
        casper::NOT_INSTALLED.to_string()
    } else {
        format!("Couldn't start Casper: {e}")
    }
}

fn path_arg(p: &Path) -> Result<String, String> {
    p.to_str().map(str::to_string).ok_or_else(|| {
        format!(
            "GreenCLI can't start Casper from {} (the path isn't plain text). Move Casper to another folder.",
            p.display()
        )
    })
}

/// `casper --version`: 0.2.21 or newer. A program that passed is remembered
/// for this session (unless `use_cache` is false, as in Check Casper).
async fn ensure_casper_version(
    resolved: &Path,
    argv0: &str,
    cancel: Option<Arc<AtomicBool>>,
    cwd: Option<&Path>,
    use_cache: bool,
) -> Result<Option<CasperVersion>, String> {
    let cached = || {
        casper::version_cache()
            .lock()
            .map(|c| c.contains(resolved))
            .unwrap_or(false)
    };
    if use_cache && cached() {
        return Ok(None);
    }
    let run = run_cli_process(
        &[path_arg(resolved)?, "--version".to_string()],
        Vec::new(),
        RunOpts {
            cwd,
            env: Vec::new(),
            timeout: casper::VERSION_TIMEOUT,
            cancel,
        },
    )
    .await
    .map_err(spawn_error)?;
    let code = match run.end {
        RunEnd::Cancelled => return Err("Stopped.".to_string()),
        RunEnd::TimedOut => {
            return Err(format!(
                "GreenCLI ran \"{argv0} --version\" but it didn't answer within 15 seconds. Check that the Casper command in Settings → AI & MCP starts Casper."
            ))
        }
        RunEnd::Exited(code) => code,
    };
    let found = casper::parse_version(&String::from_utf8_lossy(&run.stdout));
    let hint = casper::stderr_hint(&String::from_utf8_lossy(&run.stderr));
    if let Some(problem) = casper::version_problem(found, argv0, code, &hint) {
        return Err(problem);
    }
    if let Ok(mut c) = casper::version_cache().lock() {
        c.insert(resolved.to_path_buf());
    }
    Ok(found)
}

/// Casper's checks before it runs: the program, its options, local bridges.
fn casper_argv(argv: &[String], ctx: &CliContext) -> Result<Vec<String>, String> {
    casper::refuse_batch_shim(&argv[0])?;
    if ctx.as_casper {
        casper::refuse_not_casper(&argv[0])?;
    }
    casper::normalize_cli_argv(argv)
}

async fn run_casper(argv: Vec<String>, prompt: &str, ctx: CliContext) -> Result<String, String> {
    let argv0 = argv[0].clone();
    let mut argv = casper_argv(&argv, &ctx)?;
    if let Some(problem) = casper::bridge_problem(&ctx.bridges.0, &ctx.bridges.1) {
        return Err(problem);
    }
    // The fresh folder is deleted when `place` drops, on every return below.
    let place = prepare_work_place(&ctx)?;
    let ceiling = casper::git_ceiling(&place.dir)?;
    check_sandbox(place.picked.then_some(place.dir.as_path()))?;
    let resolved = resolve_casper(&argv0)?;
    let version_cwd = if place.picked {
        place.dir.clone()
    } else {
        place
            .dir
            .parent()
            .map_or_else(|| place.dir.clone(), Path::to_path_buf)
    };
    ensure_casper_version(
        &resolved,
        &argv0,
        ctx.cancel.clone(),
        Some(&version_cwd),
        true,
    )
    .await?;
    argv[0] = path_arg(&resolved)?;
    let prompt = cap_prompt(prompt);
    let run = run_cli_process(
        &argv,
        prompt.as_bytes().to_vec(),
        RunOpts {
            cwd: Some(&place.dir),
            env: vec![("GIT_CEILING_DIRECTORIES", ceiling)],
            timeout: casper::TIMEOUT,
            cancel: ctx.cancel.clone(),
        },
    )
    .await
    .map_err(spawn_error)?;
    let out = casper::parse_json_lines(&String::from_utf8_lossy(&run.stdout));
    let stderr = String::from_utf8_lossy(&run.stderr);
    casper::casper_reply(
        run.end,
        &out,
        &stderr,
        place.picked.then_some(place.dir.as_path()),
    )
}

/// Settings → Check Casper: the folder, the command, the sandbox setting, the
/// program and its version, without sending a question. The folder check
/// always runs. Sign-in and model show up only when a question is asked.
pub async fn casper_check(command: &str, ctx: CliContext) -> CasperCheck {
    let mut warnings: Vec<String> = Vec::new();
    // The folder, on its own.
    let (folder, folder_message) = match picked_folder(&ctx) {
        Some(chosen) => match check_picked(chosen, &ctx) {
            Ok(dir) => {
                let home = home_dir().as_deref().and_then(canonical);
                let files = casper::instruction_files_above(&dir, home.as_deref(), &exists);
                if !files.is_empty() {
                    warnings.push(format!(
                        "Casper will follow the instruction files it finds here: {}.",
                        file_list(&files)
                    ));
                }
                (Some(dir), None)
            }
            Err(m) => (None, Some(m)),
        },
        None => match ready_work_root(&ctx) {
            Ok(root) => (Some(root), None),
            Err(m) => (None, Some(m)),
        },
    };
    let folder_ok = folder_message.is_none();
    let picked = picked_folder(&ctx).is_some();
    let work_folder = match (&folder, picked_folder(&ctx)) {
        (Some(dir), _) => dir.display().to_string(),
        (None, Some(chosen)) => chosen.to_string(),
        (None, None) => ctx
            .cache_dir
            .as_deref()
            .map(|c| casper::work_root(c).display().to_string())
            .unwrap_or_default(),
    };

    let chain = async {
        if command.trim().is_empty() {
            return Err(
                "Put the Casper command in Settings → AI & MCP (usually just casper).".to_string(),
            );
        }
        let argv = split_command_with(command.trim(), !cfg!(windows))?;
        refuse_program(&argv[0]).map_err(|e| match e {
            AppError::ApiError(m) => m,
            other => other.to_string(),
        })?;
        let argv = casper_argv(&argv, &ctx)?;
        if let Some(problem) = casper::bridge_problem(&ctx.bridges.0, &ctx.bridges.1) {
            warnings.push(problem);
        }
        let picked_dir = folder.as_deref().filter(|_| picked);
        check_sandbox(picked_dir)?;
        let resolved = resolve_casper(&argv[0])?;
        ensure_casper_version(
            &resolved,
            &argv[0],
            ctx.cancel.clone(),
            folder.as_deref(),
            false,
        )
        .await
    }
    .await;

    let version = chain
        .as_ref()
        .ok()
        .copied()
        .flatten()
        .map(|v| v.to_string());
    if chain.is_err() {
        // Both problems at once: the message holds the command's.
        if let Some(m) = &folder_message {
            warnings.insert(0, m.clone());
        }
    }
    let message = match &chain {
        Err(m) => m.clone(),
        Ok(_) if !folder_ok => folder_message.clone().unwrap_or_default(),
        Ok(found) => {
            let v = found.map(|v| v.to_string()).unwrap_or_default();
            let place = if picked {
                work_folder.clone()
            } else {
                "a fresh, empty folder for each question".to_string()
            };
            format!("Found Casper {v}. It works in {place}. Sign-in and model are checked when you ask your first question.")
        }
    };
    CasperCheck {
        ok: chain.is_ok() && folder_ok,
        version,
        work_folder,
        message,
        folder_ok,
        folder_message,
        warnings,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ctx(as_casper: bool) -> CliContext {
        CliContext {
            app_dir: std::env::temp_dir().join("greencli-cli-test-app"),
            cache_dir: Some(std::env::temp_dir().join("greencli-cli-test-cache")),
            work_folder: None,
            as_casper,
            bridges: (Vec::new(), Vec::new()),
            extra_protected: Vec::new(),
            cancel: None,
        }
    }

    #[test]
    fn split_command_windows_mode_keeps_backslashes() {
        assert_eq!(
            split_command_with(r"C:\Users\x\casper.exe --verbose", false).unwrap(),
            vec![
                r"C:\Users\x\casper.exe".to_string(),
                "--verbose".to_string()
            ]
        );
        assert_eq!(
            split_command_with(r#""C:\Program Files\casper\casper.exe" --model a/b"#, false)
                .unwrap(),
            vec![
                r"C:\Program Files\casper\casper.exe".to_string(),
                "--model".to_string(),
                "a/b".to_string()
            ]
        );
    }

    #[test]
    fn split_command_unix_mode_unchanged() {
        assert_eq!(
            split_command_with(r"C:\Users\x\casper.exe", true).unwrap(),
            vec!["C:Usersxcasper.exe".to_string()]
        );
        assert_eq!(
            split_command_with(r#"claude --name "my assistant" a\ b 'c\d'"#, true).unwrap(),
            vec!["claude", "--name", "my assistant", "a b", r"c\d"]
                .into_iter()
                .map(String::from)
                .collect::<Vec<_>>()
        );
        assert!(split_command_with("claude \"open", true).is_err());
        assert!(split_command_with("   ", true).is_err());
    }

    #[test]
    fn refuse_program_covers_shells_and_env() {
        for p in [
            "sh",
            "/bin/bash",
            "env",
            "/usr/bin/env",
            r"C:\Windows\System32\cmd.exe",
        ] {
            assert!(refuse_program(p).is_err(), "{p}");
        }
        assert!(refuse_program("claude").is_ok());
    }

    #[test]
    fn cap_prompt_keeps_head_and_tail() {
        let small = "hello";
        assert_eq!(cap_prompt(small), "hello");
        let big = format!("{}QUESTION", "é".repeat(50_000));
        let capped = cap_prompt(&big);
        assert!(capped.len() < big.len());
        assert!(capped.ends_with("QUESTION"));
        assert!(capped.contains("[input truncated]"));
    }

    #[tokio::test]
    async fn cli_passthrough_refuses_no_sandbox_before_spawn() {
        let e = cli_passthrough("casper --no-sandbox", "hi", ctx(false))
            .await
            .unwrap_err()
            .to_string();
        assert!(e.contains("won't turn off Casper's sandbox"), "{e}");
        let e = cli_passthrough("/nowhere/casper --mcp x", "hi", ctx(true))
            .await
            .unwrap_err()
            .to_string();
        assert!(e.contains("doesn't connect Casper's servers"), "{e}");
    }

    #[tokio::test]
    async fn as_casper_refuses_other_program() {
        let e = cli_passthrough("bun x.ts", "hi", ctx(true))
            .await
            .unwrap_err()
            .to_string();
        assert!(e.contains("must start Casper itself"), "{e}");
        let e = cli_passthrough("env casper", "hi", ctx(true))
            .await
            .unwrap_err()
            .to_string();
        assert!(e.contains("Refusing to launch"), "{e}");
    }

    #[tokio::test]
    async fn bridges_refuse_before_any_folder() {
        let mut c = ctx(true);
        c.bridges = (vec![("local".into(), 8443)], Vec::new());
        let e = cli_passthrough("casper", "hi", c)
            .await
            .unwrap_err()
            .to_string();
        assert!(e.contains("port forward open on port 8443"), "{e}");
    }

    #[test]
    fn default_folder_is_made_and_removed() {
        let base =
            std::env::temp_dir().join(format!("greencli-cli-test-{}", rand::random::<u64>()));
        let mut c = ctx(true);
        c.app_dir = base.join("app");
        c.cache_dir = Some(base.join("cache"));
        let dir = {
            let place = prepare_work_place(&c).unwrap();
            assert!(!place.picked);
            let yaml = std::fs::read_to_string(place.dir.join(".casper/project.yaml")).unwrap();
            assert!(yaml.contains("denyRead"));
            assert!(yaml.contains(&*c.app_dir.to_string_lossy()));
            assert!(place
                .dir
                .starts_with(base.join("cache").join("casper-work")));
            place.dir.clone()
        };
        assert!(!dir.exists());
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn stale_runs_are_swept_but_active_ones_kept() {
        let root = std::env::temp_dir().join(format!("greencli-sweep-{}", rand::random::<u64>()));
        let left = root.join("run-0000000000000001");
        let held = root.join("run-0000000000000002");
        let other = root.join("other");
        for dir in [&left, &held, &other] {
            std::fs::create_dir_all(dir).unwrap();
        }
        let running = RunFolder::new(held.clone());
        // Fresh folders aren't stale yet.
        sweep_stale_runs(&root, STALE_RUN);
        assert!(left.exists() && held.exists() && other.exists());
        // Once old enough, a left-over run folder goes; a held one and a
        // folder that isn't a run folder stay.
        std::thread::sleep(Duration::from_millis(30));
        sweep_stale_runs(&root, Duration::from_millis(10));
        assert!(!left.exists(), "a stale run folder is removed");
        assert!(held.exists(), "a run in progress keeps its folder");
        assert!(other.exists(), "only run folders are swept");
        drop(running);
        assert!(!held.exists(), "a run's folder goes when it ends");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn check_shows_the_folder_problem_with_a_command_problem() {
        let mut c = ctx(true);
        c.work_folder = Some(
            std::env::temp_dir()
                .join(format!("greencli-gone-{}", rand::random::<u64>()))
                .to_string_lossy()
                .into_owned(),
        );
        let check = casper_check("  ", c).await;
        assert!(!check.ok);
        assert!(
            check.message.contains("Put the Casper command"),
            "{}",
            check.message
        );
        assert!(!check.folder_ok);
        assert!(
            check
                .warnings
                .iter()
                .any(|w| w.contains("isn't there any more")),
            "{:?}",
            check.warnings
        );
    }

    #[test]
    fn casper_commands_are_recognised() {
        for (cmd, as_casper) in [
            ("casper", false),
            ("casper --verbose", false),
            ("/usr/local/bin/casper --model x", false),
            ("casper.cmd", false),
            ("claude -p", true),
        ] {
            assert!(is_casper_command(cmd, as_casper), "{cmd}");
        }
        for cmd in ["claude -p", "kimi", "", "\"open"] {
            assert!(!is_casper_command(cmd, false), "{cmd}");
        }
    }

    #[tokio::test]
    async fn mcp_urls_on_this_computer() {
        for url in [
            "http://127.1:9000/mcp",
            "http://0x7f000001:9000/mcp",
            "http://[0:0:0:0:0:0:0:1]:9000/mcp",
            "http://localhost./",
            "not a url",
            // A name that never resolves counts as local (fail closed).
            "http://greencli-test.invalid/mcp",
        ] {
            assert!(mcp_url_is_local(url).await, "{url}");
        }
        // TEST-NET-1 is never this computer's address.
        assert!(!mcp_url_is_local("http://192.0.2.1:8000/mcp").await);
    }

    #[test]
    fn own_host_names() {
        assert!(is_own_host_name("mbp", "MBP.corp.example.com."));
        assert!(is_own_host_name(
            "mbp.corp.example.com",
            "MBP.corp.example.com"
        ));
        assert!(is_own_host_name("mbp.local", "mbp"));
        assert!(!is_own_host_name("mbp2", "mbp"));
        assert!(!is_own_host_name("mcp.corp.internal", "mbp"));
        assert!(!is_own_host_name("", ""));
        assert!(!is_own_host_name(".local", ""));
    }

    #[test]
    fn saved_servers_are_checked_as_written() {
        for url in [
            "http://127.1:9000/mcp",
            "http://[::]:80/",
            "http://app.localhost/",
            "not a url",
        ] {
            assert!(mcp_url_is_literally_local(url), "{url}");
        }
        let own = gethostname::gethostname()
            .to_string_lossy()
            .to_ascii_lowercase();
        if !own.is_empty() && reqwest::Url::parse(&format!("http://{own}/")).is_ok() {
            assert!(mcp_url_is_literally_local(&format!(
                "http://{own}:8000/mcp"
            )));
        }
        // No lookup: a name that never resolves is not local when only saved.
        assert!(!mcp_url_is_literally_local(
            "https://greencli-test.invalid/mcp"
        ));
        assert!(!mcp_url_is_literally_local("http://192.0.2.1:8000/mcp"));
    }

    #[tokio::test]
    async fn only_connected_servers_are_looked_up() {
        let servers = vec![
            // Saved, not connected, only resolves on a VPN: doesn't block Casper.
            (
                "vpn".to_string(),
                "https://greencli-test.invalid/mcp".to_string(),
                false,
            ),
            // Connected and its name doesn't resolve: counts (fail closed).
            (
                "live".to_string(),
                "https://greencli-test.invalid/mcp".to_string(),
                true,
            ),
            (
                "saved-local".to_string(),
                "http://localhost:8000/mcp".to_string(),
                false,
            ),
            (
                "remote".to_string(),
                "http://192.0.2.1:8000/mcp".to_string(),
                true,
            ),
            (
                "live".to_string(),
                "http://127.0.0.1:9/mcp".to_string(),
                true,
            ),
        ];
        assert_eq!(
            local_mcp_servers(servers).await,
            vec!["live".to_string(), "saved-local".to_string()]
        );
    }

    #[test]
    fn picked_folder_inside_app_dir_is_refused() {
        let base =
            std::env::temp_dir().join(format!("greencli-cli-test-{}", rand::random::<u64>()));
        let mut c = ctx(true);
        c.app_dir = base.join("app");
        std::fs::create_dir_all(c.app_dir.join("logs")).unwrap();
        let e = check_picked(&c.app_dir.join("logs").to_string_lossy(), &c).unwrap_err();
        assert!(e.contains("GreenCLI's or Casper's own files"), "{e}");
        let e = check_picked("relative/folder", &c).unwrap_err();
        assert!(e.contains("full path"), "{e}");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn read_config_says_why_it_failed() {
        let dir =
            std::env::temp_dir().join(format!("greencli-read-config-{}", rand::random::<u64>()));
        std::fs::create_dir_all(dir.join("folder.yaml")).unwrap();
        std::fs::write(dir.join("latin1.yaml"), [0x73u8, 0x61, 0xe9]).unwrap();
        assert_eq!(read_config(&dir.join("missing.yaml")).unwrap(), None);
        let folder = read_config(&dir.join("folder.yaml")).unwrap_err();
        assert!(folder.starts_with("GreenCLI couldn't read"), "{folder}");
        assert!(!folder.contains("plainer"), "{folder}");
        let latin = read_config(&dir.join("latin1.yaml")).unwrap_err();
        assert!(latin.contains("it isn't UTF-8 text"), "{latin}");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
