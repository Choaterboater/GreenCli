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
use std::path::PathBuf;

/// Simple on-disk key store kept in the app data dir (outside the webview, so
/// not reachable from JS/localStorage). Not as strong as the password vault,
/// but it avoids the vault's master-password unlock friction for AI keys.
pub struct AiKeyStore {
    path: PathBuf,
}

impl AiKeyStore {
    pub fn new(app_dir: PathBuf) -> Self {
        Self {
            path: app_dir.join("ai_keys.json"),
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
        Ok(())
    }

    pub fn set(&self, provider: &str, key: &str) -> Result<(), AppError> {
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
            .header("X-Title", "HPE Network Terminal")
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
            .header("X-Title", "HPE Network Terminal")
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
) -> Result<(), AppError> {
    use tauri::Manager;

    let overall = if req.provider == "ollama" { 600 } else { 300 };
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(overall))
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

    let mut buf = String::new();
    while let Some(bytes) = resp.chunk().await.map_err(|e| AppError::ApiError(e.to_string()))? {
        buf.push_str(&String::from_utf8_lossy(&bytes));
        while let Some(idx) = buf.find('\n') {
            let line: String = buf.drain(..=idx).collect();
            let line = line.trim_end();
            if let Some(data) = line.strip_prefix("data:") {
                let data = data.trim();
                if data.is_empty() || data == "[DONE]" {
                    continue;
                }
                let _ = app.emit_all(
                    "ai_chunk",
                    serde_json::json!({ "streamId": stream_id, "data": data }),
                );
            }
        }
    }
    let _ = app.emit_all("ai_done", serde_json::json!({ "streamId": stream_id }));
    Ok(())
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

    // Cap prompt to prevent flooding CLIs with huge stdin.
    // Walk back from byte 4000 to the nearest UTF-8 char boundary so we never
    // slice inside a multi-byte character (which would panic at runtime).
    let truncated;
    let prompt = if prompt.len() > 4000 {
        let mut cut = 4000;
        while cut > 0 && !prompt.is_char_boundary(cut) {
            cut -= 1;
        }
        truncated = &prompt[..cut];
        truncated
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
        .spawn()
        .map_err(|e| AppError::ApiError(format!("Failed to launch '{}': {}", command, e)))?;

    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(prompt.as_bytes()).await;
        let _ = stdin.write_all(b"\n").await;
        drop(stdin);
    }

    let output = child
        .wait_with_output()
        .await
        .map_err(|e| AppError::ApiError(format!("CLI error: {}", e)))?;

    let mut out = String::from_utf8_lossy(&output.stdout).to_string();
    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr);
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
