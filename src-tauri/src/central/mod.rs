// Aruba Central / "New Central" REST client using the OAuth2 client-credentials
// grant. The user supplies a regional base URL (e.g.
// https://us4.api.central.arubanetworks.com) plus a client id + secret; we
// exchange those for a bearer token (cached until expiry) and proxy requests.

use crate::error::AppError;
use serde_json::Value;
use std::time::{Duration, Instant};

pub struct CentralClient {
    client: reqwest::Client,
    base_url: String,
    client_id: String,
    client_secret: String,
    token: Option<String>,
    token_expiry: Option<Instant>,
}

impl CentralClient {
    pub fn new() -> Self {
        Self {
            client: reqwest::Client::builder()
                .timeout(Duration::from_secs(30))
                .build()
                .unwrap_or_default(),
            base_url: String::new(),
            client_id: String::new(),
            client_secret: String::new(),
            token: None,
            token_expiry: None,
        }
    }

    pub fn configure(&mut self, base_url: String, client_id: String, client_secret: String) {
        self.base_url = base_url.trim_end_matches('/').to_string();
        self.client_id = client_id;
        self.client_secret = client_secret;
        self.token = None;
        self.token_expiry = None;
    }

    pub fn is_configured(&self) -> bool {
        !self.base_url.is_empty() && !self.client_id.is_empty() && !self.client_secret.is_empty()
    }

    async fn ensure_token(&mut self) -> Result<String, AppError> {
        if let (Some(token), Some(exp)) = (&self.token, self.token_expiry) {
            if Instant::now() < exp {
                return Ok(token.clone());
            }
        }
        if !self.is_configured() {
            return Err(AppError::ApiError(
                "Aruba Central is not configured (set base URL + client id/secret in Settings)".into(),
            ));
        }
        let url = format!("{}/oauth2/token", self.base_url);
        let params = [
            ("grant_type", "client_credentials"),
            ("client_id", self.client_id.as_str()),
            ("client_secret", self.client_secret.as_str()),
        ];
        let resp = self
            .client
            .post(&url)
            .form(&params)
            .send()
            .await
            .map_err(AppError::from)?;
        let status = resp.status();
        let text = resp.text().await.map_err(AppError::from)?;
        if !status.is_success() {
            return Err(AppError::ApiError(format!(
                "Central token HTTP {}: {}",
                status.as_u16(),
                text
            )));
        }
        let json: Value = serde_json::from_str(&text)
            .map_err(|e| AppError::ApiError(format!("token parse: {}", e)))?;
        let token = json
            .get("access_token")
            .and_then(|v| v.as_str())
            .ok_or_else(|| AppError::ApiError("no access_token in token response".into()))?
            .to_string();
        let expires = json.get("expires_in").and_then(|v| v.as_u64()).unwrap_or(7200);
        self.token = Some(token.clone());
        self.token_expiry = Some(Instant::now() + Duration::from_secs(expires.saturating_sub(60)));
        Ok(token)
    }

    /// Perform a Central request (path relative to base URL, or absolute).
    /// Returns (status, body_text); does not error on 4xx/5xx.
    pub async fn request(
        &mut self,
        method: &str,
        path: &str,
        body: Option<&str>,
    ) -> Result<(u16, String), AppError> {
        let token = self.ensure_token().await?;
        let url = if path.starts_with("http") {
            path.to_string()
        } else {
            format!("{}{}", self.base_url, path)
        };
        let mut rb = match method.to_uppercase().as_str() {
            "GET" => self.client.get(&url),
            "POST" => self.client.post(&url),
            "PUT" => self.client.put(&url),
            "DELETE" => self.client.delete(&url),
            "PATCH" => self.client.patch(&url),
            other => return Err(AppError::ApiError(format!("Unsupported method: {}", other))),
        };
        rb = rb.bearer_auth(token);
        if let Some(b) = body {
            if !b.trim().is_empty() {
                rb = rb.header("Content-Type", "application/json").body(b.to_string());
            }
        }
        let resp = rb.send().await.map_err(AppError::from)?;
        let status = resp.status().as_u16();
        let text = resp.text().await.unwrap_or_default();
        Ok((status, text))
    }
}

impl Default for CentralClient {
    fn default() -> Self {
        Self::new()
    }
}
