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
//   - local-cli  (shell out to a locally installed CLI such as `claude`)

use crate::error::AppError;
use serde::Deserialize;
use serde_json::Value;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

/// Restrict a file to owner-only read/write (0600) on Unix; no-op elsewhere.
fn restrict_perms(path: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));
    }
    #[cfg(not(unix))]
    let _ = path;
}

/// Simple on-disk key store kept in the app data dir (outside the webview, so
/// not reachable from JS/localStorage). Not as strong as the password vault,
/// but it avoids the vault's master-password unlock friction for AI keys.
pub struct AiKeyStore {
    path: PathBuf,
    /// Serializes the read-modify-write in `set` so concurrent saves don't clobber.
    lock: Mutex<()>,
}

impl AiKeyStore {
    pub fn new(app_dir: PathBuf) -> Self {
        Self {
            path: app_dir.join("ai_keys.json"),
            lock: Mutex::new(()),
        }
    }

    fn load(&self) -> HashMap<String, String> {
        fs::read(&self.path)
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default()
    }

    fn save(&self, m: &HashMap<String, String>) -> Result<(), AppError> {
        fs::write(&self.path, serde_json::to_vec(m)?).map_err(AppError::from)?;
        // Raw provider API keys — keep the file owner-only.
        restrict_perms(&self.path);
        Ok(())
    }

    pub fn set(&self, provider: &str, key: &str) -> Result<(), AppError> {
        let _g = self.lock.lock().unwrap_or_else(|e| e.into_inner());
        let mut m = self.load();
        if key.is_empty() {
            m.remove(provider);
        } else {
            m.insert(provider.to_string(), key.to_string());
        }
        self.save(&m)
    }

    pub fn get(&self, provider: &str) -> Option<String> {
        self.load().get(provider).cloned()
    }

    pub fn has(&self, provider: &str) -> bool {
        self.load()
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
            "No API key set for '{}'. Open Settings → AI Assistant and add your key (or switch to Ollama / Local CLI).",
            req.provider
        )));
    }

    let rb = match req.provider.as_str() {
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
            let base = req
                .base_url
                .clone()
                .unwrap_or_else(|| "http://localhost:11434".to_string());
            client.post(format!(
                "{}/v1/chat/completions",
                base.trim_end_matches('/')
            ))
        }
        other => {
            return Err(AppError::ApiError(format!(
                "Unknown AI provider: {}",
                other
            )))
        }
    };

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
    use tauri::Manager;

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
    let mut resp = rb
        .json(&req.body)
        .send()
        .await
        .map_err(|e| AppError::ApiError(format!("Could not reach '{}': {}", req.provider, e)))?;

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
            let _ = app.emit_all(
                "ai_chunk",
                serde_json::json!({ "streamId": stream_id, "data": data }),
            );
            return true;
        }
        false
    };

    while let Some(bytes) = resp.chunk().await.map_err(|e| AppError::ApiError(e.to_string()))? {
        if cancel.load(Ordering::Relaxed) {
            break;
        }
        buf.extend_from_slice(&bytes);
        while let Some(pos) = buf.iter().position(|&b| b == b'\n') {
            let line_bytes: Vec<u8> = buf.drain(..=pos).collect();
            emitted_any |= emit_line(&line_bytes, &mut saw_done);
        }
    }
    // Flush a final `data:` line that arrived without a trailing newline (some
    // servers/proxies omit it when the connection closes right after the last event).
    if !cancel.load(Ordering::Relaxed) && !buf.is_empty() {
        emitted_any |= emit_line(&buf, &mut saw_done);
    }

    if cancel.load(Ordering::Relaxed) {
        // Cancelled: still emit done so the frontend tears down its listeners.
        let _ = app.emit_all("ai_done", serde_json::json!({ "streamId": stream_id }));
        return Ok(());
    }
    if !emitted_any && !saw_done {
        // 200 OK but nothing streamable (captive portal/proxy HTML, a non-stream JSON
        // body, or a provider that ignored stream:true) — surface it instead of a
        // silent blank reply.
        let _ = app.emit_all(
            "ai_error",
            serde_json::json!({
                "streamId": stream_id,
                "error": "Provider returned a 200 response with no streamable content. Check the model name and endpoint URL."
            }),
        );
        return Ok(());
    }
    let _ = app.emit_all("ai_done", serde_json::json!({ "streamId": stream_id }));
    Ok(())
}

/// Largest byte index `<= i` that lands on a UTF-8 char boundary of `s`
/// (stable-Rust stand-in for `str::floor_char_boundary`). Slicing a String at
/// an arbitrary byte offset panics mid-character, so all truncation cuts go
/// through this.
fn floor_char_boundary(s: &str, i: usize) -> usize {
    if i >= s.len() {
        return s.len();
    }
    let mut i = i;
    while i > 0 && !s.is_char_boundary(i) {
        i -= 1;
    }
    i
}

/// Local CLI passthrough: run `command` (whitespace-split into program + args)
/// with the prompt supplied on stdin, and return captured stdout (+stderr).
/// Useful for driving an installed agent CLI as the assistant backend.
pub async fn cli_passthrough(command: &str, prompt: &str) -> Result<String, AppError> {
    if command.trim().is_empty() {
        return Err(AppError::ApiError("Empty CLI command".into()));
    }

    use tokio::io::AsyncWriteExt;
    use tokio::process::Command;

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

    // Cap prompt to prevent flooding CLIs with huge stdin. The prompt is piped
    // on stdin (not argv), so the cap can be generous: 64 KiB. When over the
    // cap, keep the HEAD *and* the TAIL — the frontend builds the prompt as
    // "<device info>\n<paste>\n<question>", so the user's actual question is at
    // the END; dropping the tail would silently discard it. Cuts are walked
    // back to UTF-8 char boundaries so we never slice inside a multi-byte char.
    const MAX_PROMPT_BYTES: usize = 64 * 1024;
    const HEAD_BYTES: usize = 8 * 1024; // tail gets the remaining ~56 KiB
    let truncated;
    let prompt = if prompt.len() > MAX_PROMPT_BYTES {
        let head_end = floor_char_boundary(prompt, HEAD_BYTES);
        let tail_start =
            floor_char_boundary(prompt, prompt.len() - (MAX_PROMPT_BYTES - HEAD_BYTES));
        truncated = format!(
            "{}\n…[input truncated]…\n{}",
            &prompt[..head_end],
            &prompt[tail_start..]
        );
        truncated.as_str()
    } else {
        prompt
    };

    // Run through a LOGIN shell so the CLI inherits the user's full PATH
    // (GUI apps get a minimal PATH and can't find brew/npm-installed CLIs).
    let mut builder = if cfg!(windows) {
        let mut c = Command::new("cmd");
        c.arg("/C").arg(&command);
        c
    } else {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string());
        let mut c = Command::new(shell);
        c.arg("-lc").arg(&command);
        // Ensure user-local bin dirs are on PATH (GUI apps get minimal PATH).
        if let Ok(home) = std::env::var("HOME") {
            let extra = [
                format!("{home}/.local/bin"),
                format!("{home}/.cargo/bin"),
                "/usr/local/bin".to_string(),
                "/opt/homebrew/bin".to_string(),
            ];
            let current = std::env::var("PATH").unwrap_or_default();
            let mut parts: Vec<&str> = current.split(':').collect();
            for p in &extra {
                if !parts.contains(&p.as_str()) {
                    parts.push(p.as_str());
                }
            }
            c.env("PATH", parts.join(":"));
        }
        c
    };

    let mut child = builder
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        // If this future is dropped (command cancelled / app teardown) or the
        // timeout below fires, the spawned shell must not be left orphaned.
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| AppError::ApiError(format!("Failed to launch '{}': {}", command, e)))?;

    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(prompt.as_bytes()).await;
        let _ = stdin.write_all(b"\n").await;
        drop(stdin);
    }

    // Drain stdout/stderr on separate tasks so the child can never block on a
    // full pipe while we wait on it, and so a timeout can abandon the reads.
    let mut stdout_pipe = child.stdout.take();
    let mut stderr_pipe = child.stderr.take();
    let stdout_task = tokio::spawn(async move {
        use tokio::io::AsyncReadExt;
        let mut buf = Vec::new();
        if let Some(s) = stdout_pipe.as_mut() {
            let _ = s.read_to_end(&mut buf).await;
        }
        buf
    });
    let stderr_task = tokio::spawn(async move {
        use tokio::io::AsyncReadExt;
        let mut buf = Vec::new();
        if let Some(s) = stderr_pipe.as_mut() {
            let _ = s.read_to_end(&mut buf).await;
        }
        buf
    });

    // A CLI stuck on an OAuth/login prompt, interactive mode, or a blocking
    // shell profile would otherwise hang the AI chat forever — and every retry
    // would leak another shell. Bound the wait and kill on expiry.
    //
    // NOTE: start_kill() signals only the shell we spawned, not its whole
    // process group (libc is not a dependency, so killpg isn't available).
    // In practice shells exec a simple `-c` command, so the child usually IS
    // the CLI; a grandchild that survives is the accepted limitation here.
    const CLI_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(180);
    let status = match tokio::time::timeout(CLI_TIMEOUT, child.wait()).await {
        Ok(res) => res.map_err(|e| AppError::ApiError(format!("CLI error: {}", e)))?,
        Err(_) => {
            let _ = child.start_kill();
            let _ = child.wait().await; // reap; SIGKILL, so this returns promptly
            stdout_task.abort();
            stderr_task.abort();
            return Err(AppError::ApiError(format!(
                "Local CLI timed out after 180s — is it waiting for input/login? \
                 Run `{}` once in a terminal to complete any login/setup, or switch \
                 providers in Settings → AI Assistant.",
                command
            )));
        }
    };

    let stdout_buf = stdout_task.await.unwrap_or_default();
    let stderr_buf = stderr_task.await.unwrap_or_default();

    let mut out = String::from_utf8_lossy(&stdout_buf).to_string();
    if !status.success() {
        let err = String::from_utf8_lossy(&stderr_buf);
        if out.trim().is_empty() {
            out = err.to_string();
        } else {
            out.push_str(&format!("\n[stderr] {}", err));
        }
    }
    // Strip CLI session-resume noise (e.g. kimi's "To resume this session: ...")
    let lines: Vec<&str> = out.lines().collect();
    let cleaned: Vec<&str> = lines
        .into_iter()
        .filter(|l| !l.starts_with("To resume this session"))
        .collect();
    Ok(cleaned.join("\n").trim().to_string())
}
