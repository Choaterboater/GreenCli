// Aruba CX REST API v10.09+ client
// Base: https://{switch-ip}/rest/v10.09/
// Auth: Cookie-based login

use reqwest;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::error::AppError;

/// Aruba CX REST API client.
///
/// The session cookie is managed automatically by reqwest's `cookie_store`
/// (the same client instance is reused for the life of the API session), so we
/// never capture or re-send the `Set-Cookie` header by hand — doing so used to
/// duplicate the cookie and ship its raw attributes as a malformed value.
pub struct ArubaCxClient {
    client: reqwest::Client,
    base_url: String,
}

/// Interface information.
///
/// AOS-CX `depth=2` returns interface objects keyed by name, WITHOUT a top-level
/// `id`, and represents `vlan_tag`/`vlan_trunks` as maps (vlan-id -> URI). So id
/// and name are `#[serde(default)]` (filled from the map key) and the vlan
/// fields are permissive `Value`s — otherwise every interface fails to parse and
/// is silently dropped.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Interface {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default, rename = "type")]
    pub interface_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub admin_state: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub link_state: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vlan_mode: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vlan_trunk: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vlan_tag: Option<Value>,
}

/// VLAN information
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Vlan {
    #[serde(default)]
    pub id: u32,
    #[serde(default)]
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
}

/// System information
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SystemInfo {
    pub hostname: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub product_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub firmware_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub serial_number: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mac_address: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub uptime: Option<u64>,
}

impl ArubaCxClient {
    /// Create a new Aruba CX API client. `accept_invalid_certs` allows
    /// self-signed switch certificates (common in the field); pass `false` to
    /// enforce TLS validation.
    pub fn new(host: String, accept_invalid_certs: bool, base_url: Option<String>) -> Self {
        let client = reqwest::Client::builder()
            .danger_accept_invalid_certs(accept_invalid_certs)
            .cookie_store(true)
            .timeout(std::time::Duration::from_secs(30))
            .build()
            .expect("Failed to build reqwest client — TLS stack unavailable");

        // Honour the UI Base URL when provided (a different REST version or a
        // non-standard port); strip a trailing slash so `{base}/login` joins cleanly.
        let base_url = base_url
            .map(|u| u.trim().trim_end_matches('/').to_string())
            .filter(|u| !u.is_empty())
            .unwrap_or_else(|| format!("https://{}/rest/v10.09", host));

        Self { client, base_url }
    }

    /// Login to the switch using cookie-based authentication. The resulting
    /// session cookie is retained by the client's cookie store automatically.
    pub async fn login(&mut self, username: &str, password: &str) -> Result<(), AppError> {
        let url = format!("{}/login", self.base_url);
        let params = [("username", username), ("password", password)];

        let response = self
            .client
            .post(&url)
            .form(&params)
            .send()
            .await
            .map_err(|e| AppError::ApiError(format!("Login request failed: {}", e)))?;

        if response.status().is_success() {
            Ok(())
        } else {
            Err(AppError::AuthError(format!(
                "Login failed: HTTP {}",
                response.status()
            )))
        }
    }

    /// Get all interfaces.
    ///
    /// CX REST is OVSDB-backed: without `depth`, a collection GET returns a map
    /// of name -> URI string (not objects), which deserialises to nothing. We
    /// request `depth=2` so each entry is a full object with its attributes.
    pub async fn get_interfaces(&self) -> Result<Vec<Interface>, AppError> {
        let url = format!("{}/system/interfaces?depth=2", self.base_url);
        let response = self.authenticated_request(|req| req.get(&url)).await?;

        let data: Value = response
            .json()
            .await
            .map_err(|e| AppError::ApiError(format!("Failed to parse interfaces: {}", e)))?;

        let mut interfaces = Vec::new();
        if let Some(if_map) = data.as_object() {
            for (name, val) in if_map {
                let mut iface: Interface = match serde_json::from_value(val.clone()) {
                    Ok(i) => i,
                    Err(_) => continue,
                };
                iface.id = name.clone();
                if iface.name.is_empty() {
                    iface.name = name.clone();
                }
                interfaces.push(iface);
            }
        }
        Ok(interfaces)
    }

    /// Get all VLANs (see `get_interfaces` for why `depth` is required).
    pub async fn get_vlans(&self) -> Result<Vec<Vlan>, AppError> {
        let url = format!("{}/system/vlans?depth=2", self.base_url);
        let response = self.authenticated_request(|req| req.get(&url)).await?;

        let data: Value = response
            .json()
            .await
            .map_err(|e| AppError::ApiError(format!("Failed to parse VLANs: {}", e)))?;

        let mut vlans = Vec::new();
        if let Some(vlan_map) = data.as_object() {
            for (id_str, val) in vlan_map {
                if let Ok(id) = id_str.parse::<u32>() {
                    let mut vlan: Vlan = match serde_json::from_value(val.clone()) {
                        Ok(v) => v,
                        Err(_) => continue,
                    };
                    vlan.id = id;
                    vlans.push(vlan);
                }
            }
        }
        Ok(vlans)
    }

    /// Get system information. `depth=1` returns the scalar attributes of the
    /// `/system` row. Field names follow the CX schema (`platform_name`,
    /// `software_version`, `system_mac`) — not the Cisco-style names used
    /// previously, which never matched anything.
    pub async fn get_system(&self) -> Result<SystemInfo, AppError> {
        let url = format!("{}/system?depth=1", self.base_url);
        let response = self.authenticated_request(|req| req.get(&url)).await?;

        let data: Value = response
            .json()
            .await
            .map_err(|e| AppError::ApiError(format!("Failed to parse system info: {}", e)))?;

        // `software_info` may carry the version when `software_version` is absent.
        let firmware = data["software_version"]
            .as_str()
            .or_else(|| data["software_info"]["software_version"].as_str())
            .map(String::from);

        let system_info = SystemInfo {
            hostname: data["hostname"].as_str().unwrap_or("").to_string(),
            product_name: data["platform_name"].as_str().map(String::from),
            firmware_version: firmware,
            serial_number: data["serial_number"]
                .as_str()
                .or_else(|| data["product_info"]["serial_number"].as_str())
                .map(String::from),
            mac_address: data["system_mac"].as_str().map(String::from),
            // CX exposes boot_time (epoch seconds); derive an actual uptime.
            uptime: data["boot_time"].as_u64().map(|boot| {
                let now = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_secs())
                    .unwrap_or(boot);
                now.saturating_sub(boot)
            }),
        };

        Ok(system_info)
    }

    /// Execute a CLI command via the API
    pub async fn execute_cli(&self, command: &str) -> Result<String, AppError> {
        let url = format!("{}/cli", self.base_url);
        let body = json!({"command": command});

        let response = self
            .authenticated_request(|req| req.post(&url).json(&body))
            .await?;

        let text = response
            .text()
            .await
            .map_err(|e| AppError::ApiError(format!("Failed to read CLI response: {}", e)))?;

        Ok(text)
    }

    /// Generic authenticated request for the API Explorer (Postman-style).
    /// `path` is relative to the base URL (e.g. "/system/interfaces") or an
    /// absolute URL. Returns (status, body_text) and does NOT treat 4xx/5xx as
    /// an error so the caller can display the response.
    pub async fn request(
        &self,
        method: &str,
        path: &str,
        body: Option<&str>,
    ) -> Result<(u16, String), AppError> {
        let url = if path.starts_with("http") {
            path.to_string()
        } else {
            format!("{}{}", self.base_url, path)
        };

        let mut builder = match method.to_uppercase().as_str() {
            "GET" => self.client.get(&url),
            "POST" => self.client.post(&url),
            "PUT" => self.client.put(&url),
            "DELETE" => self.client.delete(&url),
            "PATCH" => self.client.patch(&url),
            other => return Err(AppError::ApiError(format!("Unsupported method: {}", other))),
        };

        if let Some(b) = body {
            if !b.trim().is_empty() {
                builder = builder
                    .header("Content-Type", "application/json")
                    .body(b.to_string());
            }
        }

        let response = builder
            .send()
            .await
            .map_err(|e| AppError::ApiError(format!("Request failed: {}", e)))?;
        let status = response.status().as_u16();
        let text = response.text().await.unwrap_or_default();
        Ok((status, text))
    }

    // ─── Internal helpers ───

    async fn authenticated_request<F>(&self, build: F) -> Result<reqwest::Response, AppError>
    where
        F: FnOnce(reqwest::Client) -> reqwest::RequestBuilder,
    {
        let builder = build(self.client.clone());

        let response = builder
            .send()
            .await
            .map_err(|e| AppError::ApiError(format!("Request failed: {}", e)))?;

        if response.status().is_success() {
            Ok(response)
        } else {
            Err(AppError::ApiError(format!(
                "HTTP error: {} - {}",
                response.status(),
                response.text().await.unwrap_or_default()
            )))
        }
    }
}
