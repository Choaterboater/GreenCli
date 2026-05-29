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

/// Perform one provider request and return the parsed JSON response.
pub async fn chat_request(store: &AiKeyStore, req: AiChatRequest) -> Result<Value, AppError> {
    let client = reqwest::Client::new();
    let key = store.get(&req.provider).unwrap_or_default();

    let rb = match req.provider.as_str() {
        "anthropic" => client
            .post("https://api.anthropic.com/v1/messages")
            .header("anthropic-version", "2023-06-01")
            .header("x-api-key", key),
        "openrouter" => client
            .post("https://openrouter.ai/api/v1/chat/completions")
            .header("HTTP-Referer", "https://arubaterminalpro.app")
            .header("X-Title", "Aruba Terminal Pro")
            .bearer_auth(key),
        "moonshot" => client
            .post("https://api.moonshot.ai/v1/chat/completions")
            .bearer_auth(key),
        "ollama" => {
            let base = req
                .base_url
                .clone()
                .unwrap_or_else(|| "http://localhost:11434".to_string());
            client.post(format!("{}/v1/chat/completions", base.trim_end_matches('/')))
        }
        other => {
            return Err(AppError::ApiError(format!(
                "Unknown AI provider: {}",
                other
            )))
        }
    };

    let resp = rb
        .json(&req.body)
        .send()
        .await
        .map_err(AppError::from)?;
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

/// Local CLI passthrough: run `command` (whitespace-split into program + args)
/// with the prompt supplied on stdin, and return captured stdout (+stderr).
/// Useful for driving an installed agent CLI as the assistant backend.
pub async fn cli_passthrough(command: &str, prompt: &str) -> Result<String, AppError> {
    let mut parts = command.split_whitespace();
    let program = parts
        .next()
        .ok_or_else(|| AppError::ApiError("Empty CLI command".into()))?;
    let args: Vec<&str> = parts.collect();

    use tokio::io::AsyncWriteExt;
    use tokio::process::Command;

    let mut child = Command::new(program)
        .args(&args)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| AppError::ApiError(format!("Failed to launch '{}': {}", program, e)))?;

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
    Ok(out)
}
