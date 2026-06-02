// On-prem (no-Central) REST clients for ArubaOS 8 controllers/conductors and
// AOS-S (AOS-Switch / ProVision) switches. Mirror the AOS-CX client so the AI
// assistant + API Explorer can pull structured data without Aruba Central.

use crate::error::AppError;
use serde_json::Value;

fn http(accept_invalid_certs: bool) -> reqwest::Client {
    reqwest::Client::builder()
        .danger_accept_invalid_certs(accept_invalid_certs)
        .cookie_store(true)
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .expect("Failed to build reqwest client — TLS stack unavailable")
}

/// Minimal percent-encoder for query values (show commands etc.).
fn enc(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (b as char).to_string()
            }
            b' ' => "%20".to_string(),
            _ => format!("%{:02X}", b),
        })
        .collect()
}

// ─── ArubaOS 8 (Mobility Controller / Conductor) ───
//
// API on :4343. Login -> UIDARUBA token; show commands via the JSON
// `showcommand` endpoint; config objects under /v1/configuration/object.
pub struct Aos8Client {
    client: reqwest::Client,
    base: String,
    uid: Option<String>,
}

impl Aos8Client {
    pub fn new(host: String, accept_invalid_certs: bool) -> Self {
        Self {
            client: http(accept_invalid_certs),
            base: format!("https://{}:4343", host),
            uid: None,
        }
    }

    pub async fn login(&mut self, username: &str, password: &str) -> Result<(), AppError> {
        let url = format!("{}/v1/api/login", self.base);
        let resp = self
            .client
            .post(&url)
            .form(&[("username", username), ("password", password)])
            .send()
            .await
            .map_err(|e| AppError::ApiError(format!("AOS-8 login request failed: {}", e)))?;
        // Check the HTTP status BEFORE parsing — a 401/403/503 often returns an HTML
        // error page, which would otherwise surface as a confusing "parse failed".
        let status = resp.status();
        let text = resp
            .text()
            .await
            .map_err(|e| AppError::ApiError(format!("AOS-8 login read failed: {}", e)))?;
        if !status.is_success() {
            let snippet: String = text.chars().take(200).collect();
            return Err(AppError::AuthError(format!(
                "AOS-8 login failed (HTTP {}): {}",
                status.as_u16(),
                snippet
            )));
        }
        let json: Value = serde_json::from_str(&text)
            .map_err(|e| AppError::ApiError(format!("AOS-8 login parse failed: {}", e)))?;
        match json
            .get("_global_result")
            .and_then(|g| g.get("UIDARUBA"))
            .and_then(|u| u.as_str())
        {
            Some(uid) => {
                self.uid = Some(uid.to_string());
                Ok(())
            }
            None => Err(AppError::AuthError(
                "AOS-8 login failed (no UIDARUBA returned)".into(),
            )),
        }
    }

    /// Run a `show` command, returning JSON (the controller renders it for us).
    pub async fn show(&self, command: &str) -> Result<(u16, String), AppError> {
        let uid = self
            .uid
            .as_ref()
            .ok_or_else(|| AppError::ApiError("AOS-8: not logged in".into()))?;
        let url = format!(
            "{}/v1/configuration/showcommand?command={}&UIDARUBA={}",
            self.base,
            enc(command),
            uid
        );
        let resp = self
            .client
            .get(&url)
            .send()
            .await
            .map_err(|e| AppError::ApiError(e.to_string()))?;
        Ok((resp.status().as_u16(), resp.text().await.unwrap_or_default()))
    }

    /// Generic request against the config API (UIDARUBA appended automatically).
    pub async fn request(
        &self,
        method: &str,
        path: &str,
        body: Option<&str>,
    ) -> Result<(u16, String), AppError> {
        let uid = self
            .uid
            .as_ref()
            .ok_or_else(|| AppError::ApiError("AOS-8: not logged in".into()))?;
        let target = if path.starts_with("http") {
            path.to_string()
        } else {
            format!("{}{}", self.base, path)
        };
        let sep = if target.contains('?') { '&' } else { '?' };
        let url = format!("{}{}UIDARUBA={}", target, sep, uid);
        let mut rb = match method.to_uppercase().as_str() {
            "GET" => self.client.get(&url),
            "POST" => self.client.post(&url),
            "PUT" => self.client.put(&url),
            "DELETE" => self.client.delete(&url),
            other => return Err(AppError::ApiError(format!("Unsupported method: {}", other))),
        };
        if let Some(b) = body {
            if !b.trim().is_empty() {
                rb = rb.header("Content-Type", "application/json").body(b.to_string());
            }
        }
        let resp = rb.send().await.map_err(|e| AppError::ApiError(e.to_string()))?;
        Ok((resp.status().as_u16(), resp.text().await.unwrap_or_default()))
    }
}

// ─── Juniper Apstra (AOS intent-based DC fabric) ───
//
// Token auth: POST /api/aaa/login -> {token}; subsequent requests carry the
// `AuthToken` header. Re-logs-in once on 401 (tokens expire).
pub struct ApstraClient {
    client: reqwest::Client,
    base: String,
    username: String,
    password: String,
    token: Option<String>,
}

impl ApstraClient {
    pub fn new(host: String, username: String, password: String, accept_invalid_certs: bool) -> Self {
        // Accept a bare host or a full URL.
        let base = if host.starts_with("http") {
            host.trim_end_matches('/').to_string()
        } else {
            format!("https://{}", host)
        };
        Self {
            client: http(accept_invalid_certs),
            base,
            username,
            password,
            token: None,
        }
    }

    pub async fn login(&mut self) -> Result<(), AppError> {
        let url = format!("{}/api/aaa/login", self.base);
        let resp = self
            .client
            .post(&url)
            .json(&serde_json::json!({ "username": self.username, "password": self.password }))
            .send()
            .await
            .map_err(|e| AppError::ApiError(format!("Apstra login request failed: {}", e)))?;
        if !resp.status().is_success() {
            return Err(AppError::AuthError(format!(
                "Apstra login failed: HTTP {}",
                resp.status()
            )));
        }
        let json: Value = resp
            .json()
            .await
            .map_err(|e| AppError::ApiError(format!("Apstra login parse failed: {}", e)))?;
        match json.get("token").and_then(|t| t.as_str()) {
            Some(tok) => {
                self.token = Some(tok.to_string());
                Ok(())
            }
            None => Err(AppError::AuthError("Apstra login returned no token".into())),
        }
    }

    async fn send_once(
        &self,
        method: &str,
        path: &str,
        body: Option<&str>,
    ) -> Result<reqwest::Response, AppError> {
        // Apstra endpoint paths already include the `/api` prefix (e.g.
        // `/api/blueprints`). Don't add a second one — `/api/api/...` 404s.
        let url = if path.starts_with("http") {
            path.to_string()
        } else if path == "/api" || path.starts_with("/api/") {
            format!("{}{}", self.base, path)
        } else {
            format!("{}/api{}", self.base, path)
        };
        let mut rb = match method.to_uppercase().as_str() {
            "GET" => self.client.get(&url),
            "POST" => self.client.post(&url),
            "PUT" => self.client.put(&url),
            "PATCH" => self.client.patch(&url),
            "DELETE" => self.client.delete(&url),
            other => return Err(AppError::ApiError(format!("Unsupported method: {}", other))),
        };
        if let Some(tok) = &self.token {
            rb = rb.header("AuthToken", tok);
        }
        if let Some(b) = body {
            if !b.trim().is_empty() {
                rb = rb.header("Content-Type", "application/json").body(b.to_string());
            }
        }
        rb.send().await.map_err(|e| AppError::ApiError(e.to_string()))
    }

    pub async fn request(
        &mut self,
        method: &str,
        path: &str,
        body: Option<&str>,
    ) -> Result<(u16, String), AppError> {
        if self.token.is_none() {
            self.login().await?;
        }
        let resp = self.send_once(method, path, body).await?;
        // Token may have expired — re-login once and retry.
        let resp = if resp.status().as_u16() == 401 {
            self.login().await?;
            self.send_once(method, path, body).await?
        } else {
            resp
        };
        Ok((resp.status().as_u16(), resp.text().await.unwrap_or_default()))
    }
}

// ─── AOS-S (AOS-Switch / ProVision) ───
//
// Cookie-based login at /rest/v7/login-sessions; resources under /rest/v7.
pub struct AossClient {
    client: reqwest::Client,
    base: String,
}

impl AossClient {
    pub fn new(host: String, accept_invalid_certs: bool) -> Self {
        Self {
            client: http(accept_invalid_certs),
            base: format!("https://{}", host),
        }
    }

    pub async fn login(&self, username: &str, password: &str) -> Result<(), AppError> {
        let url = format!("{}/rest/v7/login-sessions", self.base);
        let resp = self
            .client
            .post(&url)
            .json(&serde_json::json!({ "userName": username, "password": password }))
            .send()
            .await
            .map_err(|e| AppError::ApiError(format!("AOS-S login request failed: {}", e)))?;
        if resp.status().is_success() {
            Ok(())
        } else {
            Err(AppError::AuthError(format!(
                "AOS-S login failed: HTTP {}",
                resp.status()
            )))
        }
    }

    pub async fn request(
        &self,
        method: &str,
        path: &str,
        body: Option<&str>,
    ) -> Result<(u16, String), AppError> {
        let url = if path.starts_with("http") {
            path.to_string()
        } else {
            format!("{}/rest/v7{}", self.base, path)
        };
        let mut rb = match method.to_uppercase().as_str() {
            "GET" => self.client.get(&url),
            "POST" => self.client.post(&url),
            "PUT" => self.client.put(&url),
            "DELETE" => self.client.delete(&url),
            other => return Err(AppError::ApiError(format!("Unsupported method: {}", other))),
        };
        if let Some(b) = body {
            if !b.trim().is_empty() {
                rb = rb.header("Content-Type", "application/json").body(b.to_string());
            }
        }
        let resp = rb.send().await.map_err(|e| AppError::ApiError(e.to_string()))?;
        Ok((resp.status().as_u16(), resp.text().await.unwrap_or_default()))
    }
}

// ─── Juniper Mist Cloud ───
//
// Cloud REST API with token auth (`Authorization: Token <token>`). The base host
// is region-specific (api.mist.com, api.eu.mist.com, api.gc1.mist.com, …).
pub struct MistClient {
    client: reqwest::Client,
    base: String,
    token: String,
}

impl MistClient {
    pub fn new(base_url: String, token: String, accept_invalid_certs: bool) -> Self {
        let trimmed = base_url.trim().trim_end_matches('/');
        let base = if trimmed.starts_with("http") {
            trimmed.to_string()
        } else if trimmed.is_empty() {
            "https://api.mist.com".to_string()
        } else {
            format!("https://{}", trimmed)
        };
        Self {
            client: http(accept_invalid_certs),
            base,
            token,
        }
    }

    pub async fn request(
        &self,
        method: &str,
        path: &str,
        body: Option<&str>,
    ) -> Result<(u16, String), AppError> {
        let url = if path.starts_with("http") {
            path.to_string()
        } else {
            format!("{}{}", self.base, path)
        };
        let mut rb = match method.to_uppercase().as_str() {
            "GET" => self.client.get(&url),
            "POST" => self.client.post(&url),
            "PUT" => self.client.put(&url),
            "DELETE" => self.client.delete(&url),
            other => return Err(AppError::ApiError(format!("Unsupported method: {}", other))),
        };
        rb = rb.header("Authorization", format!("Token {}", self.token));
        if let Some(b) = body {
            if !b.trim().is_empty() {
                rb = rb.header("Content-Type", "application/json").body(b.to_string());
            }
        }
        let resp = rb.send().await.map_err(|e| AppError::ApiError(e.to_string()))?;
        Ok((resp.status().as_u16(), resp.text().await.unwrap_or_default()))
    }
}

// ─── Juniper Junos REST API (jsd) ───
//
// OPTIONAL on-box REST, only active after `set system services rest http`/`https`
// on the device. RPCs are reached at `/rpc/<rpc-name>`; HTTP Basic auth per
// request; `Accept: application/json` yields JSON. Default https port 3443.
pub struct JunosClient {
    client: reqwest::Client,
    base: String,
    user: String,
    pass: String,
}

impl JunosClient {
    pub fn new(
        host: String,
        port: u16,
        user: String,
        pass: String,
        accept_invalid_certs: bool,
    ) -> Self {
        Self {
            client: http(accept_invalid_certs),
            base: format!("https://{}:{}", host, port),
            user,
            pass,
        }
    }

    /// Validate credentials + that REST is enabled, by fetching software-information.
    pub async fn login(&self) -> Result<(), AppError> {
        let (status, body) = self.request("GET", "/rpc/get-software-information", None).await?;
        if (200..300).contains(&status) {
            Ok(())
        } else {
            Err(AppError::AuthError(format!(
                "Junos REST login failed (HTTP {}). Is `set system services rest` enabled on the device? {}",
                status,
                body.chars().take(120).collect::<String>()
            )))
        }
    }

    pub async fn request(
        &self,
        method: &str,
        path: &str,
        body: Option<&str>,
    ) -> Result<(u16, String), AppError> {
        let url = if path.starts_with("http") {
            path.to_string()
        } else {
            format!("{}{}", self.base, path)
        };
        let mut rb = match method.to_uppercase().as_str() {
            "GET" => self.client.get(&url),
            "POST" => self.client.post(&url),
            "PUT" => self.client.put(&url),
            "DELETE" => self.client.delete(&url),
            other => return Err(AppError::ApiError(format!("Unsupported method: {}", other))),
        };
        rb = rb
            .basic_auth(&self.user, Some(&self.pass))
            .header("Accept", "application/json");
        if let Some(b) = body {
            if !b.trim().is_empty() {
                // RPC parameters are XML.
                rb = rb.header("Content-Type", "application/xml").body(b.to_string());
            }
        }
        let resp = rb.send().await.map_err(|e| AppError::ApiError(e.to_string()))?;
        Ok((resp.status().as_u16(), resp.text().await.unwrap_or_default()))
    }
}
