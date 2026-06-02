use crate::error::AppError;
use serde::{Deserialize, Serialize};
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data_bits: Option<u8>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parity: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stop_bits: Option<u8>,
    /// Commands run automatically on connect (newline-separated).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub startup_commands: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub keep_alive_interval: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auto_reconnect: Option<bool>,
    /// For protocol "local": PTY command + args + working dir.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub args: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    /// SSH jump host (ProxyJump) routing only; jump_password lives in the vault.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub jump_host: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub jump_port: Option<u16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub jump_username: Option<String>,
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
                folders: vec![SessionFolder {
                    id: "default".to_string(),
                    name: "Sessions".to_string(),
                    items: vec![],
                    expanded: true,
                }],
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

    /// Move a stored session into another folder (extract from wherever it is, then
    /// push into the target folder), updating its folder_id.
    pub fn move_session(&mut self, session_id: &str, folder_id: &str) -> Result<(), AppError> {
        let mut data = self.load()?;
        let mut moved: Option<StoredSession> = None;
        for folder in &mut data.folders {
            if let Some(pos) = folder.items.iter().position(|s| s.id == session_id) {
                moved = Some(folder.items.remove(pos));
                break;
            }
        }
        if let Some(mut session) = moved {
            session.folder_id = Some(folder_id.to_string());
            if let Some(target) = data.folders.iter_mut().find(|f| f.id == folder_id) {
                target.items.push(session);
            } else if let Some(first) = data.folders.first_mut() {
                first.items.push(session);
            }
        }
        self.save(&data)
    }

    /// Rename a stored session by id (searches every folder + the loose list).
    pub fn rename_session(&mut self, id: &str, name: &str) -> Result<(), AppError> {
        let mut data = self.load()?;
        for folder in &mut data.folders {
            for s in &mut folder.items {
                if s.id == id {
                    s.name = name.to_string();
                }
            }
        }
        for s in &mut data.sessions {
            if s.id == id {
                s.name = name.to_string();
            }
        }
        self.save(&data)
    }

    /// Replace the tags on a stored session.
    pub fn set_tags(&mut self, id: &str, tags: Vec<String>) -> Result<(), AppError> {
        let mut data = self.load()?;
        for folder in &mut data.folders {
            for s in &mut folder.items {
                if s.id == id {
                    s.tags = tags.clone();
                }
            }
        }
        for s in &mut data.sessions {
            if s.id == id {
                s.tags = tags.clone();
            }
        }
        self.save(&data)
    }

    /// Update a folder's name and/or expanded state.
    pub fn update_folder(
        &mut self,
        id: &str,
        name: Option<&str>,
        expanded: Option<bool>,
    ) -> Result<(), AppError> {
        let mut data = self.load()?;
        for folder in &mut data.folders {
            if folder.id == id {
                if let Some(n) = name {
                    folder.name = n.to_string();
                }
                if let Some(e) = expanded {
                    folder.expanded = e;
                }
            }
        }
        self.save(&data)
    }

    /// Remove a folder and everything in it.
    pub fn remove_folder(&mut self, id: &str) -> Result<(), AppError> {
        let mut data = self.load()?;
        data.folders.retain(|f| f.id != id);
        self.save(&data)
    }

    pub fn list_serial_ports() -> Vec<String> {
        match serialport::available_ports() {
            Ok(ports) => ports.into_iter().map(|p| p.port_name).collect(),
            Err(_) => vec![],
        }
    }
}
