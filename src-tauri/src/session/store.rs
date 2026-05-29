use crate::error::AppError;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;

/// A stored session configuration
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredSession {
    pub id: String,
    pub name: String,
    pub protocol: String, // "ssh" | "telnet" | "serial"
    pub host: Option<String>,
    pub port: Option<u16>,
    pub username: Option<String>,
    pub auth_type: Option<String>, // "password" | "key" | "agent"
    pub device_type: String,       // "aruba-cx" | "aruba-ap" | "aruba-controller" | "generic"
    pub folder_id: Option<String>,
    pub tags: Vec<String>,
    pub notes: Option<String>,
    pub serial_port: Option<String>,
    pub baud_rate: Option<u32>,
}

/// A folder containing sessions
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionFolder {
    pub id: String,
    pub name: String,
    pub items: Vec<StoredSession>,
    pub expanded: bool,
}

/// Persistent session storage
pub struct SessionStore {
    store_path: PathBuf,
    cache: Option<SessionData>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SessionData {
    pub version: String,
    pub folders: Vec<SessionFolder>,
    #[serde(default)]
    pub sessions: Vec<StoredSession>,
}

impl SessionStore {
    pub fn new(app_dir: PathBuf) -> Result<Self, AppError> {
        let store_path = app_dir.join("sessions.json");
        if let Some(parent) = store_path.parent() {
            fs::create_dir_all(parent).map_err(AppError::from)?;
        }
        Ok(Self {
            store_path,
            cache: None,
        })
    }

    pub fn load(&mut self) -> Result<SessionData, AppError> {
        if let Some(ref cache) = self.cache {
            return Ok(cache.clone());
        }

        if !self.store_path.exists() {
            let default = SessionData {
                version: "1.0".to_string(),
                folders: vec![
                    SessionFolder {
                        id: "default".to_string(),
                        name: "Default".to_string(),
                        items: vec![],
                        expanded: true,
                    }
                ],
                sessions: vec![],
            };
            self.cache = Some(default.clone());
            return Ok(default);
        }

        let content = fs::read_to_string(&self.store_path).map_err(AppError::from)?;
        let data: SessionData = serde_json::from_str(&content).map_err(AppError::from)?;
        self.cache = Some(data.clone());
        Ok(data)
    }

    pub fn save(&mut self, data: &SessionData) -> Result<(), AppError> {
        let json = serde_json::to_string_pretty(data).map_err(AppError::from)?;
        fs::write(&self.store_path, json).map_err(AppError::from)?;
        self.cache = Some(data.clone());
        Ok(())
    }

    pub fn add_folder(&mut self, folder: SessionFolder) -> Result<(), AppError> {
        let mut data = self.load()?;
        data.folders.push(folder);
        self.save(&data)
    }

    pub fn remove_folder(&mut self, folder_id: &str) -> Result<(), AppError> {
        let mut data = self.load()?;
        data.folders.retain(|f| f.id != folder_id);
        self.save(&data)
    }

    pub fn add_session(&mut self, folder_id: &str, session: StoredSession) -> Result<(), AppError> {
        let mut data = self.load()?;
        for folder in &mut data.folders {
            if folder.id == folder_id {
                folder.items.push(session);
                return self.save(&data);
            }
        }
        // If folder not found, add to default
        if let Some(first) = data.folders.first_mut() {
            first.items.push(session);
        }
        self.save(&data)
    }

    pub fn remove_session(&mut self, session_id: &str) -> Result<(), AppError> {
        let mut data = self.load()?;
        for folder in &mut data.folders {
            folder.items.retain(|s| s.id != session_id);
        }
        data.sessions.retain(|s| s.id != session_id);
        self.save(&data)
    }

    pub fn update_session(
        &mut self,
        session_id: &str,
        session: StoredSession,
    ) -> Result<(), AppError> {
        let mut data = self.load()?;
        for folder in &mut data.folders {
            for item in &mut folder.items {
                if item.id == session_id {
                    *item = session;
                    return self.save(&data);
                }
            }
        }
        for item in &mut data.sessions {
            if item.id == session_id {
                *item = session;
                return self.save(&data);
            }
        }
        Err(AppError::ConfigError(format!(
            "Session {} not found",
            session_id
        )))
    }

    pub fn list_serial_ports() -> Vec<String> {
        match serialport::available_ports() {
            Ok(ports) => ports.into_iter().map(|p| p.port_name).collect(),
            Err(_) => vec![],
        }
    }
}
