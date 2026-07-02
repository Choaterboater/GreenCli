// Aruba Central REST client.
//
// Two auth modes:
//   - Token mode: the user pastes a (user-bound) access token; used as-is,
//     never refreshed. This is the only mode that works against CLASSIC Aruba
//     Central API gateways (the apigw-*.central.arubanetworks.com regions in
//     the frontend's CENTRAL_REGIONS list) — classic gateways only support
//     authorization_code/refresh_token at {base_url}/oauth2/token, NOT
//     client_credentials.
//   - Creds mode (client id + secret): minted via the OAuth2 client-credentials
//     grant against the HPE GreenLake SSO endpoint
//     (https://sso.common.cloud.hpe.com/as/token.oauth2), which is where "new
//     Central" / GLP API-client credentials live. As a long shot we also fall
//     back to the legacy {base_url}/oauth2/token for any tenant that might
//     accept client_credentials there. Tokens are cached until shortly before
//     `expires_in` and re-minted on expiry.

use crate::error::AppError;
use serde_json::Value;
use std::time::{Duration, Instant};

/// HPE GreenLake SSO token endpoint — the home of client-credentials tokens
/// for new Central / GLP API clients.
const GLP_SSO_TOKEN_URL: &str = "https://sso.common.cloud.hpe.com/as/token.oauth2";

/// Trim an HTTP error body for inclusion in an error message (avoids dumping
/// whole HTML pages), backing off to a char boundary.
fn body_snippet(text: &str) -> String {
    let t = text.trim();
    if t.len() <= 300 {
        return t.to_string();
    }
    let mut cut = 300;
    while cut > 0 && !t.is_char_boundary(cut) {
        cut -= 1;
    }
    format!("{}…", &t[..cut])
}

/// POST a client-credentials grant to `url`; returns (access_token, expires_in).
/// Errors are strings (not AppError) so the caller can combine both attempts
/// into one actionable message.
async fn token_request(
    client: &reqwest::Client,
    url: &str,
    client_id: &str,
    client_secret: &str,
) -> Result<(String, u64), String> {
    let params = [
        ("grant_type", "client_credentials"),
        ("client_id", client_id),
        ("client_secret", client_secret),
    ];
    let resp = client
        .post(url)
        .form(&params)
        .send()
        .await
        .map_err(|e| format!("{}: {}", url, e))?;
    let status = resp.status();
    let text = resp.text().await.map_err(|e| format!("{}: {}", url, e))?;
    if !status.is_success() {
        return Err(format!(
            "{}: HTTP {}: {}",
            url,
            status.as_u16(),
            body_snippet(&text)
        ));
    }
    let json: Value =
        serde_json::from_str(&text).map_err(|e| format!("{}: token parse: {}", url, e))?;
    let token = json
        .get("access_token")
        .and_then(|v| v.as_str())
        .ok_or_else(|| format!("{}: no access_token in token response", url))?
        .to_string();
    let expires = json
        .get("expires_in")
        .and_then(|v| v.as_u64())
        .unwrap_or(7200);
    Ok((token, expires))
}

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
                .expect("Failed to build reqwest client — TLS stack unavailable"),
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

    /// Configure with a pasted access token (SSO accounts that can't use the
    /// client-credentials grant). No client id/secret → the token is used as-is
    /// and never refreshed (re-paste when it expires).
    pub fn configure_token(&mut self, base_url: String, token: String) {
        self.base_url = base_url.trim_end_matches('/').to_string();
        self.client_id = String::new();
        self.client_secret = String::new();
        self.token = Some(token);
        self.token_expiry = None;
    }

    pub fn clear(&mut self) {
        self.base_url.clear();
        self.client_id.clear();
        self.client_secret.clear();
        self.token = None;
        self.token_expiry = None;
    }

    pub fn is_configured(&self) -> bool {
        !self.base_url.is_empty()
            && (self.token.is_some() || (!self.client_id.is_empty() && !self.client_secret.is_empty()))
    }

    async fn ensure_token(&mut self) -> Result<String, AppError> {
        // Pasted token (no client-credentials to refresh with): use as-is.
        if self.client_id.is_empty() {
            if let Some(token) = &self.token {
                return Ok(token.clone());
            }
        }
        if let (Some(token), Some(exp)) = (&self.token, self.token_expiry) {
            if Instant::now() < exp {
                return Ok(token.clone());
            }
        }
        if !self.is_configured() {
            return Err(AppError::ApiError(
                "Aruba Central is not configured (set base URL + client id/secret in Settings)"
                    .into(),
            ));
        }
        // Client-credentials tokens are minted by the HPE GreenLake SSO (new
        // Central / GLP API clients) — classic Central API gateways do not
        // support this grant at {base_url}/oauth2/token. Try GreenLake SSO
        // FIRST, then fall back to the legacy endpoint for any tenant where it
        // might still work.
        let sso_err = match token_request(
            &self.client,
            GLP_SSO_TOKEN_URL,
            &self.client_id,
            &self.client_secret,
        )
        .await
        {
            Ok((token, expires)) => return Ok(self.cache_token(token, expires)),
            Err(e) => e,
        };

        let legacy_url = format!("{}/oauth2/token", self.base_url);
        let legacy_err = match token_request(
            &self.client,
            &legacy_url,
            &self.client_id,
            &self.client_secret,
        )
        .await
        {
            Ok((token, expires)) => return Ok(self.cache_token(token, expires)),
            Err(e) => e,
        };

        Err(AppError::ApiError(format!(
            "Could not obtain a token with client credentials. Classic Central (apigw-*) \
             requires a user-bound access token — paste one in Token mode; client \
             credentials work with new Central (GLP API clients). \
             [GreenLake SSO: {}] [Legacy gateway: {}]",
            sso_err, legacy_err
        )))
    }

    /// Cache a freshly minted token, expiring 60s before the server-side
    /// `expires_in` so we never send a token that dies mid-request.
    fn cache_token(&mut self, token: String, expires_in: u64) -> String {
        self.token = Some(token.clone());
        self.token_expiry =
            Some(Instant::now() + Duration::from_secs(expires_in.saturating_sub(60)));
        token
    }

    /// Perform a Central request (path relative to base URL, or absolute).
    /// Returns (status, body_text); does not error on 4xx/5xx.
    pub async fn request(
        &mut self,
        method: &str,
        path: &str,
        body: Option<&str>,
    ) -> Result<(u16, String), AppError> {
        let url = if path.starts_with("http") {
            path.to_string()
        } else {
            format!("{}{}", self.base_url, path)
        };
        let mut retried = false;
        loop {
            let token = self.ensure_token().await?;
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
                    rb = rb
                        .header("Content-Type", "application/json")
                        .body(b.to_string());
                }
            }
            let resp = rb.send().await.map_err(AppError::from)?;
            let status = resp.status().as_u16();
            // In creds mode a 401 means the cached token died server-side (the
            // local expiry check uses Instant, which freezes during system
            // sleep, and tokens can be revoked) — re-mint once and retry.
            if status == 401 && !retried && !self.client_id.is_empty() {
                retried = true;
                self.token = None;
                self.token_expiry = None;
                continue;
            }
            let text = resp.text().await.unwrap_or_default();
            return Ok((status, text));
        }
    }
}

impl Default for CentralClient {
    fn default() -> Self {
        Self::new()
    }
}
