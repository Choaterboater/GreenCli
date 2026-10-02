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
use crate::secret_store::{self, SecretStore, AI_KEY_PREFIX};
use serde::Deserialize;
use serde_json::Value;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use zeroize::Zeroizing;

/// AI provider keys, kept outside the webview in the system password store
/// (or, with none, the 1.9 `ai_keys.json`; see secret_store.rs) under the
/// account `ai-key:<provider>`. Cheap to clone. Every call may block on the
/// store, so async code goes through `key_for`.
#[derive(Clone)]
pub struct AiKeyStore {
    store: Arc<SecretStore>,
}

impl AiKeyStore {
    pub fn new(store: Arc<SecretStore>) -> Self {
        Self { store }
    }

    fn account(provider: &str) -> String {
        format!("{}{}", AI_KEY_PREFIX, provider)
    }

    /// Save a key; an empty key deletes it.
    pub fn set(&self, provider: &str, key: &str) -> Result<(), String> {
        self.store.set(&Self::account(provider), key)
    }

    pub fn get(&self, provider: &str) -> Result<Option<Zeroizing<String>>, String> {
        self.store.get(&Self::account(provider))
    }

    pub fn has(&self, provider: &str) -> Result<bool, String> {
        self.store.has(&Self::account(provider))
    }

    /// The trimmed key for a provider that needs one, read off the async
    /// runtime; empty for the rest (Ollama never needs the store).
    pub async fn key_for(&self, provider: &str) -> Result<Zeroizing<String>, AppError> {
        if !provider_needs_key(provider) {
            return Ok(Zeroizing::new(String::new()));
        }
        let keys = self.clone();
        let p = provider.to_string();
        let key = secret_store::blocking(move || keys.get(&p))
            .await
            .map_err(AppError::ApiError)?;
        // A stray newline from a copy-paste must not slip into the header.
        Ok(Zeroizing::new(
            key.map(|k| k.trim().to_string()).unwrap_or_default(),
        ))
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
    // Trimmed once and used for BOTH the guard and the auth header.
    let key = store.key_for(&req.provider).await?;

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
    let key = store.key_for(&req.provider).await?;
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

#[cfg(test)]
mod key_store_tests {
    use super::*;
    use crate::secret_store::mem::MemBackend;

    fn keys() -> (Arc<MemBackend>, AiKeyStore) {
        let mem = MemBackend::new();
        let store = Arc::new(SecretStore::os_for_tests(mem.clone()));
        (mem, AiKeyStore::new(store))
    }

    #[tokio::test]
    async fn keys_are_saved_under_the_provider_account_and_trimmed_for_use() {
        let (mem, keys) = keys();
        keys.set("anthropic", "sk-ant-api03-abc\n").unwrap();
        assert_eq!(mem.raw("ai-key:anthropic").unwrap(), b"sk-ant-api03-abc\n");
        assert!(keys.has("anthropic").unwrap());
        assert!(!keys.has("moonshot").unwrap());
        assert_eq!(keys.key_for("anthropic").await.unwrap().as_str(), "sk-ant-api03-abc");
        keys.set("anthropic", "").unwrap();
        assert!(mem.raw("ai-key:anthropic").is_none());
        assert!(!keys.has("anthropic").unwrap());
    }

    #[tokio::test]
    async fn ollama_never_asks_the_store_and_a_locked_store_is_an_error() {
        let (mem, keys) = keys();
        mem.fail_all.store(true, Ordering::Relaxed);
        assert!(keys.key_for("ollama").await.unwrap().is_empty());
        let err = keys.key_for("openrouter").await.unwrap_err().to_string();
        assert!(err.contains(secret_store::UNAVAILABLE), "{err}");
    }
}
