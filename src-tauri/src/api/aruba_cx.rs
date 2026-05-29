// Aruba CX REST API v10.09+ client
// Base: https://{switch-ip}/rest/v10.09/
// Auth: Cookie-based login

use reqwest;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::error::AppError;

/// Aruba CX REST API client
pub struct ArubaCxClient {
    client: reqwest::Client,
    base_url: String,
    cookie: Option<String>,
}

/// Interface information
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Interface {
    pub id: String,
    pub name: String,
    #[serde(rename = "type")]
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
    pub vlan_trunk: Option<Vec<u32>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vlan_tag: Option<u32>,
}

/// VLAN information
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Vlan {
    pub id: u32,
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

/// LLDP neighbor information
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LldpNeighbor {
    pub interface: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub chassis_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub port_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub system_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub system_description: Option<String>,
}

impl ArubaCxClient {
    /// Create a new Aruba CX API client
    pub fn new(host: String) -> Self {
        let client = reqwest::Client::builder()
            .danger_accept_invalid_certs(true)
            .cookie_store(true)
            .timeout(std::time::Duration::from_secs(30))
            .build()
            .unwrap_or_default();

        Self {
            client,
            base_url: format!("https://{}/rest/v10.09", host),
            cookie: None,
        }
    }

    /// Login to the switch using cookie-based authentication
    pub async fn login(&mut self, username: &str, password: &str) -> Result<(), AppError> {
        let url = format!("{}/login", self.base_url);
        let params = [
            ("username", username),
            ("password", password),
        ];

        let response = self
            .client
            .post(&url)
            .form(&params)
            .send()
            .await
            .map_err(|e| AppError::ApiError(format!("Login request failed: {}", e)))?;

        if response.status().is_success() {
            // Extract cookie from response
            if let Some(cookie_hdr) = response.headers().get("set-cookie") {
                if let Ok(cookie_str) = cookie_hdr.to_str() {
                    self.cookie = Some(cookie_str.to_string());
                }
            }
            Ok(())
        } else {
            Err(AppError::AuthError(format!(
                "Login failed: HTTP {}",
                response.status()
            )))
        }
    }

    /// Get all interfaces
    pub async fn get_interfaces(&self) -> Result<Vec<Interface>, AppError> {
        let url = format!("{}/system/interfaces", self.base_url);
        let response = self
            .authenticated_request(|req| req.get(&url))
            .await?;

        let data: Value = response.json().await.map_err(|e| {
            AppError::ApiError(format!("Failed to parse interfaces: {}", e))
        })?;

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

    /// Get all VLANs
    pub async fn get_vlans(&self) -> Result<Vec<Vlan>, AppError> {
        let url = format!("{}/system/vlans", self.base_url);
        let response = self
            .authenticated_request(|req| req.get(&url))
            .await?;

        let data: Value = response.json().await.map_err(|e| {
            AppError::ApiError(format!("Failed to parse VLANs: {}", e))
        })?;

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

    /// Get system information
    pub async fn get_system(&self) -> Result<SystemInfo, AppError> {
        let url = format!("{}/system", self.base_url);
        let response = self
            .authenticated_request(|req| req.get(&url))
            .await?;

        let data: Value = response.json().await.map_err(|e| {
            AppError::ApiError(format!("Failed to parse system info: {}", e))
        })?;

        let system_info = SystemInfo {
            hostname: data["hostname"].as_str().unwrap_or("").to_string(),
            product_name: data["product_name"].as_str().map(String::from),
            firmware_version: data["firmware_version"].as_str().map(String::from),
            serial_number: data["serial_number"].as_str().map(String::from),
            mac_address: data["mac_address"].as_str().map(String::from),
            uptime: data["uptime"].as_u64(),
        };

        Ok(system_info)
    }

    /// Get LLDP neighbors
    pub async fn get_lldp_neighbors(&self) -> Result<Vec<LldpNeighbor>, AppError> {
        let url = format!("{}/system/interfaces/{{interface}}/lldp_neighbors", self.base_url);
        let interfaces = self.get_interfaces().await?;
        let mut neighbors = Vec::new();

        for iface in interfaces {
            let iface_url = url.replace("{interface}", &iface.id);
            match self
                .authenticated_request(|req| req.get(&iface_url))
                .await
            {
                Ok(response) => {
                    if let Ok(data) = response.json::<Value>().await {
                        if let Some(nbr_map) = data.as_object() {
                            for (_, val) in nbr_map {
                                if let Ok(mut nbr) =
                                    serde_json::from_value::<LldpNeighbor>(val.clone())
                                {
                                    nbr.interface = iface.id.clone();
                                    neighbors.push(nbr);
                                }
                            }
                        }
                    }
                }
                Err(_) => continue,
            }
        }

        Ok(neighbors)
    }

    /// Execute a CLI command via the API
    pub async fn execute_cli(&self, command: &str) -> Result<String, AppError> {
        let url = format!("{}/cli", self.base_url);
        let body = json!({"command": command});

        let response = self
            .authenticated_request(|req| req.post(&url).json(&body))
            .await?;

        let text = response.text().await.map_err(|e| {
            AppError::ApiError(format!("Failed to read CLI response: {}", e))
        })?;

        Ok(text)
    }

    /// Logout and clear session
    pub async fn logout(&self) -> Result<(), AppError> {
        let url = format!("{}/logout", self.base_url);
        let _ = self
            .client
            .post(&url)
            .send()
            .await
            .map_err(|e| AppError::ApiError(format!("Logout failed: {}", e)))?;
        Ok(())
    }

    // ─── Internal helpers ───

    async fn authenticated_request<F>(&self, build: F) -> Result<reqwest::Response, AppError>
    where
        F: FnOnce(reqwest::Client) -> reqwest::RequestBuilder,
    {
        let mut builder = build(self.client.clone());
        if let Some(ref cookie) = self.cookie {
            builder = builder.header("Cookie", cookie);
        }

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
