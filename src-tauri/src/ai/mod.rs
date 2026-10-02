// Pluggable AI provider backend.
//
// All network egress for the AI assistant goes through here (in Rust) rather
// than the webview, so provider API keys never live in the renderer/localStorage
// and we don't need the `anthropic-dangerous-direct-browser-access` header.
//
// Supported providers:
//   - anthropic  (Claude Messages API)
//   - openrouter (OpenAI-compatible aggregator)
//   - moonshot   (Kimi / Moonshot, OpenAI-compatible)
//   - ollama     (local, OpenAI-compatible)
//   - local-cli  (spawn a locally installed CLI such as `claude` directly — no shell)
//   - casper     (the Casper CLI, run with its sandbox on in a folder of its own)
//
// The CLI providers live in cli.rs (dispatch), cli_run.rs (spawn, Stop,
// timeout, quit) and casper.rs (Casper's pure rules).

pub mod cancel;
pub mod casper;
mod cli;
mod cli_run;

pub use cli::{
    casper_check, cli_passthrough, is_casper_command, local_mcp_servers, CasperCheck, CliContext,
};
pub use cli_run::stop_all_cli_runs;
#[cfg(all(test, unix))]
pub(crate) use cli_run::CLI_RUNS_TEST_LOCK;

use crate::error::AppError;
use serde::Deserialize;
use serde_json::Value;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

/// Restrict a file to owner-only read/write: 0600 on Unix; an owner-only DACL
/// (via icacls — std has no ACL API) on Windows. Best-effort on failure: the
/// caller's temp-file + rename pattern still applies.
fn restrict_perms(path: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));
    }
    #[cfg(windows)]
    {
        // Strip inheritance and grant full control to the current user only, so
        // provider keys aren't readable by other local accounts (fs::write gives
        // the file the parent directory's ACL, which may be broad).
        if let Ok(user) = std::env::var("USERNAME") {
            let _ = std::process::Command::new("icacls")
                .arg(path)
                .args(["/inheritance:r", "/grant:r", &format!("{}:F", user)])
                .output();
        }
    }
    #[cfg(not(any(unix, windows)))]
    let _ = path;
}

/// Write a secrets file owner-only AND atomically. The content goes to a 0600
/// sibling temp file — created with mode 0600 directly on Unix rather than
/// fs::write (umask 0644) then chmod, which would briefly leave raw provider API
/// keys readable to other local users — then renamed over the target. Rename is
/// atomic on the same filesystem, so a concurrent reader never observes a
/// torn/empty file and a crash mid-write leaves the previous good key file intact
/// (mirrors intent::IntentStore::save_locked; 0600 handling mirrors
/// mcp::client::write_secret_file).
fn write_key_file(path: &Path, content: &[u8]) -> Result<(), AppError> {
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let tmp = path.with_extension("json.tmp");
    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        let mut f = fs::OpenOptions::new()
            .create(true)
            .truncate(true)
            .write(true)
            .mode(0o600)
            .open(&tmp)
            .map_err(AppError::from)?;
        f.write_all(content).map_err(AppError::from)?;
    }
    #[cfg(not(unix))]
    {
        fs::write(&tmp, content).map_err(AppError::from)?;
        // Lock the temp file down BEFORE the rename so the secret never sits on
        // disk with the parent directory's (potentially broad) ACL.
        restrict_perms(&tmp);
    }
    fs::rename(&tmp, path).map_err(AppError::from)?;
    restrict_perms(path); // belt-and-suspenders: also fixes perms if the target pre-existed
    Ok(())
}

/// Simple on-disk key store kept in the app data dir (outside the webview, so
/// not reachable from JS/localStorage). Not as strong as the password vault,
/// but it avoids the vault's master-password unlock friction for AI keys.
pub struct AiKeyStore {
    path: PathBuf,
    /// Serializes reads and the read-modify-write in `set`, so concurrent saves
    /// don't clobber and a read never races an in-flight save.
    lock: Mutex<()>,
}

impl AiKeyStore {
    pub fn new(app_dir: PathBuf) -> Self {
        Self {
            path: app_dir.join("ai_keys.json"),
            lock: Mutex::new(()),
        }
    }

    /// Read the key map from disk. Caller must hold `lock` — `set`'s
    /// read-modify-write already does, and the `get`/`has` wrappers take it
    /// themselves (`lock` is non-reentrant, so this must not take it again).
    fn load_locked(&self) -> HashMap<String, String> {
        fs::read(&self.path)
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default()
    }

    fn save(&self, m: &HashMap<String, String>) -> Result<(), AppError> {
        // Raw provider API keys — write owner-only from the start.
        write_key_file(&self.path, &serde_json::to_vec(m)?)
    }

    pub fn set(&self, provider: &str, key: &str) -> Result<(), AppError> {
        let _g = self.lock.lock().unwrap_or_else(|e| e.into_inner());
        let mut m = self.load_locked();
        if key.is_empty() {
            m.remove(provider);
        } else {
            m.insert(provider.to_string(), key.to_string());
        }
        self.save(&m)
    }

    pub fn get(&self, provider: &str) -> Option<String> {
        let _g = self.lock.lock().unwrap_or_else(|e| e.into_inner());
        self.load_locked().get(provider).cloned()
    }

    pub fn has(&self, provider: &str) -> bool {
        let _g = self.lock.lock().unwrap_or_else(|e| e.into_inner());
        self.load_locked()
            .get(provider)
            .map(|k| !k.is_empty())
            .unwrap_or(false)
    }
}

#[derive(Deserialize)]
pub struct AiChatRequest {
    pub provider: String,
    #[serde(default)]
    pub base_url: Option<String>,
    /// Full provider-specific request body (messages/tools/model/etc.), minus auth.
    pub body: Value,
}

/// Providers that authenticate with an API key (must have one stored).
fn provider_needs_key(provider: &str) -> bool {
    matches!(provider, "anthropic" | "openrouter" | "moonshot")
}

/// Perform one provider request and return the parsed JSON response.
pub async fn chat_request(store: &AiKeyStore, req: AiChatRequest) -> Result<Value, AppError> {
    // Short connect timeout everywhere (unreachable host fails fast), but a long
    // overall read timeout for local generations — Ollama on CPU / large models
    // can legitimately take minutes, and aborting that mislabels it "unreachable".
    let overall = if req.provider == "ollama" {
        std::time::Duration::from_secs(600)
    } else {
        std::time::Duration::from_secs(120)
    };
    let client = reqwest::Client::builder()
        .timeout(overall)
        .connect_timeout(std::time::Duration::from_secs(12))
        .build()
        .map_err(AppError::from)?;
    // Trim once and use the trimmed key for BOTH the guard and the auth header
    // (a stray trailing newline from a copy-paste must not slip into the header).
    let key = store.get(&req.provider).unwrap_or_default().trim().to_string();

    // Fail with an actionable message rather than sending an empty auth header
    // (which providers answer with an opaque 401).
    if provider_needs_key(&req.provider) && key.is_empty() {
        return Err(AppError::ApiError(format!(
            "No API key set for '{}'. Open Settings → AI Assistant and add your key (or switch to Ollama, Local CLI or Casper).",
            req.provider
        )));
    }

    // Single source of truth for provider URL + auth (shared with chat_stream).
    let rb = build_request(&client, &req.provider, &key, &req.base_url)?;

    let resp = rb.json(&req.body).send().await.map_err(|e| {
        let hint = if req.provider == "ollama" {
            " — is Ollama running? Start it with `ollama serve` and check the URL in Settings."
        } else {
            ""
        };
        AppError::ApiError(format!("Could not reach '{}': {}{}", req.provider, e, hint))
    })?;
    let status = resp.status();
    let text = resp.text().await.map_err(AppError::from)?;
    let json: Value = serde_json::from_str(&text).unwrap_or_else(|_| Value::String(text.clone()));

    if !status.is_success() {
        let msg = json
            .get("error")
            .and_then(|e| e.get("message"))
            .and_then(|m| m.as_str())
            .map(|s| s.to_string())
            .unwrap_or_else(|| format!("HTTP {}: {}", status.as_u16(), text));
        return Err(AppError::ApiError(msg));
    }

    Ok(json)
}

/// Build the provider RequestBuilder (URL + auth headers) for a chat request.
fn build_request(
    client: &reqwest::Client,
    provider: &str,
    key: &str,
    base_url: &Option<String>,
) -> Result<reqwest::RequestBuilder, AppError> {
    Ok(match provider {
        "anthropic" => client
            .post("https://api.anthropic.com/v1/messages")
            .header("anthropic-version", "2023-06-01")
            .header("x-api-key", key),
        "openrouter" => client
            .post("https://openrouter.ai/api/v1/chat/completions")
            .header("HTTP-Referer", "https://hpe.com")
            .header("X-Title", "GreenCLI")
            .bearer_auth(key),
        "moonshot" => client
            .post("https://api.moonshot.ai/v1/chat/completions")
            .bearer_auth(key),
        "ollama" => {
            let base = base_url
                .clone()
                .unwrap_or_else(|| "http://localhost:11434".to_string());
            client.post(format!("{}/v1/chat/completions", base.trim_end_matches('/')))
        }
        other => return Err(AppError::ApiError(format!("Unknown AI provider: {}", other))),
    })
}

/// Streaming chat: pumps the provider's SSE `data:` lines to the frontend as
/// `ai_chunk` events (the frontend parses the provider-specific deltas), then
/// `ai_done`. Provider-agnostic — Rust just forwards the raw SSE payloads.
pub async fn chat_stream(
    store: &AiKeyStore,
    req: AiChatRequest,
    app: &tauri::AppHandle,
    stream_id: &str,
    cancel: Arc<AtomicBool>,
) -> Result<(), AppError> {
    use tauri::Emitter;

    // Stop pressed before this run was registered: send nothing at all.
    if cancel.load(Ordering::Relaxed) {
        let _ = app.emit("ai_done", serde_json::json!({ "streamId": stream_id }));
        return Ok(());
    }

    // Use an IDLE (between-bytes) read timeout rather than an overall deadline:
    // a stream that keeps producing tokens must never be cut off mid-response,
    // but a genuinely stalled connection still fails. (reqwest 0.12 read_timeout.)
    let idle = if req.provider == "ollama" { 600 } else { 300 };
    let client = reqwest::Client::builder()
        .read_timeout(std::time::Duration::from_secs(idle))
        .connect_timeout(std::time::Duration::from_secs(12))
        .build()
        .map_err(AppError::from)?;
    let key = store.get(&req.provider).unwrap_or_default().trim().to_string();
    if provider_needs_key(&req.provider) && key.is_empty() {
        return Err(AppError::ApiError(format!(
            "No API key set for '{}'. Open Settings → AI Assistant and add your key.",
            req.provider
        )));
    }

    let rb = build_request(&client, &req.provider, &key, &req.base_url)?;
    // A Stop while waiting for the provider's first byte drops the request.
    let Some(sent) = cancel::until_cancelled(rb.json(&req.body).send(), &cancel).await else {
        let _ = app.emit("ai_done", serde_json::json!({ "streamId": stream_id }));
        return Ok(());
    };
    let mut resp =
        sent.map_err(|e| AppError::ApiError(format!("Could not reach '{}': {}", req.provider, e)))?;

    let status = resp.status();
    if !status.is_success() {
        let text = resp.text().await.unwrap_or_default();
        let json: Value = serde_json::from_str(&text).unwrap_or(Value::String(text.clone()));
        let msg = json
            .get("error")
            .and_then(|e| e.get("message"))
            .and_then(|m| m.as_str())
            .map(|s| s.to_string())
            .unwrap_or_else(|| format!("HTTP {}: {}", status.as_u16(), text));
        return Err(AppError::ApiError(msg));
    }

    // Buffer raw BYTES across chunks and only decode COMPLETE lines: reqwest's
    // .chunk() splits on arbitrary network frame boundaries, so a multi-byte UTF-8
    // char (emoji/CJK/box-drawing/smart-quote — common in CLI output and tool JSON)
    // can straddle two chunks. A '\n' byte (0x0A) never appears inside a multi-byte
    // sequence, so a full line is always valid UTF-8 and decodes losslessly.
    let mut buf: Vec<u8> = Vec::new();
    let mut emitted_any = false;
    let mut saw_done = false;

    // Emit a single `data:` line if present; returns true if a content chunk went out.
    let emit_line = |line_bytes: &[u8], saw_done: &mut bool| -> bool {
        let line = String::from_utf8_lossy(line_bytes);
        let line = line.trim_end();
        if let Some(data) = line.strip_prefix("data:") {
            let data = data.trim();
            if data.is_empty() {
                return false;
            }
            if data == "[DONE]" {
                *saw_done = true;
                return false;
            }
            let _ = app.emit(
                "ai_chunk",
                serde_json::json!({ "streamId": stream_id, "data": data }),
            );
            return true;
        }
        false
    };

    loop {
        if cancel.load(Ordering::Relaxed) {
            break;
        }
        // Short per-read deadline so a Stop pressed while the provider is between
        // SSE events (or a proxy stalls) is observed within ~250ms rather than up
        // to the multi-minute idle read_timeout. chunk()'s buffered body state
        // lives in `resp`, so dropping a pending read on timeout re-polls losslessly.
        let bytes = match tokio::time::timeout(
            std::time::Duration::from_millis(250),
            resp.chunk(),
        )
        .await
        {
            Ok(res) => match res.map_err(|e| AppError::ApiError(e.to_string()))? {
                Some(b) => b,
                None => break, // stream ended cleanly
            },
            Err(_) => continue, // 250ms idle — loop back and re-check cancel
        };
        buf.extend_from_slice(&bytes);
        while let Some(pos) = buf.iter().position(|&b| b == b'\n') {
            let line_bytes: Vec<u8> = buf.drain(..=pos).collect();
            emitted_any |= emit_line(&line_bytes, &mut saw_done);
        }
    }
    // Tear the socket down promptly on cancel rather than at function return
    // (the flush + ai_done below only need `buf`, never `resp`).
    drop(resp);
    // Flush a final `data:` line that arrived without a trailing newline (some
    // servers/proxies omit it when the connection closes right after the last event).
    if !cancel.load(Ordering::Relaxed) && !buf.is_empty() {
        emitted_any |= emit_line(&buf, &mut saw_done);
    }

    if cancel.load(Ordering::Relaxed) {
        // Cancelled: still emit done so the frontend tears down its listeners.
        let _ = app.emit("ai_done", serde_json::json!({ "streamId": stream_id }));
        return Ok(());
    }
    if !emitted_any && !saw_done {
        // 200 OK but nothing streamable (captive portal/proxy HTML, a non-stream JSON
        // body, or a provider that ignored stream:true) — surface it instead of a
        // silent blank reply.
        let _ = app.emit(
            "ai_error",
            serde_json::json!({
                "streamId": stream_id,
                "error": "Provider returned a 200 response with no streamable content. Check the model name and endpoint URL."
            }),
        );
        return Ok(());
    }
    let _ = app.emit("ai_done", serde_json::json!({ "streamId": stream_id }));
    Ok(())
}

/// Largest byte index `<= i` that lands on a UTF-8 char boundary of `s`
/// (stable-Rust stand-in for `str::floor_char_boundary`). Slicing a String at
/// an arbitrary byte offset panics mid-character, so all truncation cuts go
/// through this.
pub(crate) fn floor_char_boundary(s: &str, i: usize) -> usize {
    if i >= s.len() {
        return s.len();
    }
    let mut i = i;
    while i > 0 && !s.is_char_boundary(i) {
        i -= 1;
    }
    i
}
