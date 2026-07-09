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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub device_profile_id: Option<String>,
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
        // Write-then-rename so a crash/power loss mid-write can't truncate the
        // whole saved-session store (rename is atomic on the same filesystem).
        let tmp = self.store_path.with_extension("json.tmp");
        fs::write(&tmp, json).map_err(AppError::from)?;
        fs::rename(&tmp, &self.store_path).map_err(AppError::from)?;
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
            folder.items.retain(|s| s.id != session.id);
        }
        data.sessions.retain(|s| s.id != session.id);

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
        // Legacy loose sessions (pre-folder data) live in data.sessions — they
        // must be movable into folders too.
        if moved.is_none() {
            if let Some(pos) = data.sessions.iter().position(|s| s.id == session_id) {
                moved = Some(data.sessions.remove(pos));
            }
        }
        if let Some(mut session) = moved {
            if let Some(target) = data.folders.iter_mut().find(|f| f.id == folder_id) {
                session.folder_id = Some(folder_id.to_string());
                target.items.push(session);
            } else if let Some(first) = data.folders.first_mut() {
                // Target folder vanished — land in the first folder and record
                // THAT id, not the nonexistent target's.
                session.folder_id = Some(first.id.clone());
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

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir() -> PathBuf {
        let mut p = std::env::temp_dir();
        p.push(format!("atp-store-test-{}", rand::random::<u64>()));
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    fn mock_session(id: &str, name: &str) -> StoredSession {
        StoredSession {
            id: id.to_string(),
            name: name.to_string(),
            protocol: "ssh".to_string(),
            host: Some("127.0.0.1".to_string()),
            port: Some(22),
            username: Some("admin".to_string()),
            auth_type: Some("password".to_string()),
            device_type: "generic".to_string(),
            device_profile_id: None,
            folder_id: None,
            tags: vec![],
            notes: None,
            serial_port: None,
            baud_rate: None,
            data_bits: None,
            parity: None,
            stop_bits: None,
            startup_commands: None,
            keep_alive_interval: None,
            auto_reconnect: None,
            command: None,
            args: None,
            cwd: None,
            jump_host: None,
            jump_port: None,
            jump_username: None,
        }
    }

    #[test]
    fn test_store_initialization() {
        let dir = temp_dir();
        let mut store = SessionStore::new(dir.clone()).unwrap();
        let data = store.load().unwrap();
        assert_eq!(data.folders.len(), 1);
        assert_eq!(data.folders[0].id, "default");
        assert_eq!(data.folders[0].items.len(), 0);
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn test_add_and_remove_session() {
        let dir = temp_dir();
        let mut store = SessionStore::new(dir.clone()).unwrap();
        let s = mock_session("s1", "router1");
        store.add_session("default", s).unwrap();
        
        let data = store.load().unwrap();
        assert_eq!(data.folders[0].items.len(), 1);
        assert_eq!(data.folders[0].items[0].id, "s1");

        store.remove_session("s1").unwrap();
        let data = store.load().unwrap();
        assert_eq!(data.folders[0].items.len(), 0);

        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn test_move_session() {
        let dir = temp_dir();
        let mut store = SessionStore::new(dir.clone()).unwrap();
        
        let f2 = SessionFolder {
            id: "f2".to_string(),
            name: "Folder 2".to_string(),
            items: vec![],
            expanded: true,
        };
        store.add_folder(f2).unwrap();
        
        let s = mock_session("s1", "router1");
        store.add_session("default", s).unwrap();

        // Move
        store.move_session("s1", "f2").unwrap();

        let data = store.load().unwrap();
        let f1 = data.folders.iter().find(|f| f.id == "default").unwrap();
        let f2 = data.folders.iter().find(|f| f.id == "f2").unwrap();
        assert_eq!(f1.items.len(), 0);
        assert_eq!(f2.items.len(), 1);
        assert_eq!(f2.items[0].id, "s1");

        std::fs::remove_dir_all(dir).ok();
    }
}
