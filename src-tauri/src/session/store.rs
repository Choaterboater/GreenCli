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
    /// Path to a private-key FILE (e.g. an ssh_config-imported IdentityFile).
    /// Only the path is persisted — key contents are read at connect time, so
    /// sessions.json never holds key material.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key_path: Option<String>,
    /// Shared login (credential profile) id for this host. Unset = use the
    /// folder's default login; "none" = this host keeps its own per-host
    /// password. Only the id is stored — the password lives in the vault.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub login_profile_id: Option<String>,
    /// Shared login id for the jump host, or "none" for a per-jump-host
    /// password saved in the vault. Unset = key / ssh-agent only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub jump_login_profile_id: Option<String>,
}

/// A folder containing sessions
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionFolder {
    pub id: String,
    pub name: String,
    pub items: Vec<StoredSession>,
    pub expanded: bool,
    /// Default shared login for every host in this folder that doesn't pick
    /// its own. Serde default so sessions.json files from before logins load.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub login_profile_id: Option<String>,
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
                    login_profile_id: None,
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
        // Owner-only: startup commands often carry enable passwords.
        crate::private_fs::write_private_atomic(&self.store_path, json.as_bytes())?;
        self.cache = Some(data.clone());
        Ok(())
    }

    pub fn add_folder(&mut self, folder: SessionFolder) -> Result<(), AppError> {
        let mut data = self.load()?;
        data.folders.push(folder);
        self.save(&data)
    }

    /// Create an empty folder and return its id. Ids come from the clock, and
    /// a host import creates several folders back to back — a taken id gets a
    /// `-2`, `-3` … suffix instead of two folders sharing one id.
    pub fn create_folder(&mut self, name: String, now_millis: u128) -> Result<String, AppError> {
        let data = self.load()?;
        let base = format!("folder-{}", now_millis);
        let mut id = base.clone();
        let mut n = 2;
        while data.folders.iter().any(|f| f.id == id) {
            id = format!("{}-{}", base, n);
            n += 1;
        }
        self.add_folder(SessionFolder {
            id: id.clone(),
            name,
            items: vec![],
            expanded: true,
            login_profile_id: None,
        })?;
        Ok(id)
    }

    /// Save a session into `folder_id`, replacing any stored entry with the same
    /// id (this is how the sidebar's "Edit…" updates a host).
    pub fn add_session(&mut self, folder_id: &str, session: StoredSession) -> Result<(), AppError> {
        let mut data = self.load()?;
        // An update keeps its place in the folder — re-appending moved every
        // edited host to the bottom of its folder on the next launch.
        let position = data
            .folders
            .iter()
            .find(|f| f.id == folder_id)
            .and_then(|f| f.items.iter().position(|s| s.id == session.id));
        for folder in &mut data.folders {
            folder.items.retain(|s| s.id != session.id);
        }
        data.sessions.retain(|s| s.id != session.id);

        for folder in &mut data.folders {
            if folder.id == folder_id {
                let at = position.unwrap_or(folder.items.len()).min(folder.items.len());
                folder.items.insert(at, session);
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

    /// Update a folder's name, expanded state and/or default login. For the
    /// login, `None` leaves it alone and `Some("")` clears it.
    pub fn update_folder(
        &mut self,
        id: &str,
        name: Option<&str>,
        expanded: Option<bool>,
        login_profile_id: Option<&str>,
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
                if let Some(login) = login_profile_id {
                    folder.login_profile_id = Some(login.to_string()).filter(|l| !l.is_empty());
                }
            }
        }
        self.save(&data)
    }

    /// Forget a deleted shared login everywhere it was assigned (folder
    /// defaults, host overrides, jump hosts) in one write, so those hosts fall
    /// back to their folder / per-host password instead of pointing at nothing.
    /// Returns how many references were cleared.
    pub fn clear_login_profile(&mut self, profile_id: &str) -> Result<usize, AppError> {
        fn clear(slot: &mut Option<String>, profile_id: &str) -> usize {
            if slot.as_deref() == Some(profile_id) {
                *slot = None;
                1
            } else {
                0
            }
        }
        let mut data = self.load()?;
        let mut cleared = 0;
        for folder in &mut data.folders {
            cleared += clear(&mut folder.login_profile_id, profile_id);
            for s in &mut folder.items {
                cleared += clear(&mut s.login_profile_id, profile_id);
                cleared += clear(&mut s.jump_login_profile_id, profile_id);
            }
        }
        for s in &mut data.sessions {
            cleared += clear(&mut s.login_profile_id, profile_id);
            cleared += clear(&mut s.jump_login_profile_id, profile_id);
        }
        if cleared > 0 {
            self.save(&data)?;
        }
        Ok(cleared)
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
            key_path: None,
            login_profile_id: None,
            jump_login_profile_id: None,
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
    fn test_resave_updates_in_place() {
        let dir = temp_dir();
        let mut store = SessionStore::new(dir.clone()).unwrap();
        for (id, name) in [("s1", "a"), ("s2", "b"), ("s3", "c")] {
            store.add_session("default", mock_session(id, name)).unwrap();
        }

        let mut edited = mock_session("s1", "a");
        edited.host = Some("10.0.0.9".to_string());
        store.add_session("default", edited).unwrap();

        let data = store.load().unwrap();
        let ids: Vec<&str> = data.folders[0].items.iter().map(|s| s.id.as_str()).collect();
        assert_eq!(ids, ["s1", "s2", "s3"]);
        assert_eq!(data.folders[0].items[0].host.as_deref(), Some("10.0.0.9"));

        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn test_create_folder_ids_stay_unique_within_one_millisecond() {
        let dir = temp_dir();
        let mut store = SessionStore::new(dir.clone()).unwrap();
        let a = store.create_folder("Site A".to_string(), 1000).unwrap();
        let b = store.create_folder("Site B".to_string(), 1000).unwrap();
        let c = store.create_folder("Site C".to_string(), 1000).unwrap();
        assert_eq!(
            [a.as_str(), b.as_str(), c.as_str()],
            ["folder-1000", "folder-1000-2", "folder-1000-3"]
        );

        let data = store.load().unwrap();
        let names: Vec<&str> = data.folders.iter().map(|f| f.name.as_str()).collect();
        assert_eq!(names, ["Sessions", "Site A", "Site B", "Site C"]);
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn sessions_json_from_before_logins_still_loads() {
        let dir = temp_dir();
        // A pre-logins file: no loginProfileId / jumpLoginProfileId anywhere.
        std::fs::write(
            dir.join("sessions.json"),
            r#"{"version":"1.0","folders":[{"id":"default","name":"Sessions","expanded":true,
               "items":[{"id":"s1","name":"core","protocol":"ssh","host":"10.0.0.1","port":22,
               "username":"admin","authType":"password","deviceType":"aruba-cx",
               "folderId":"default","tags":[],"notes":null,"serialPort":null,"baudRate":null,
               "jumpHost":"bastion","jumpUsername":"ops"}]}]}"#,
        )
        .unwrap();
        let mut store = SessionStore::new(dir.clone()).unwrap();
        let data = store.load().unwrap();
        assert_eq!(data.folders[0].login_profile_id, None);
        let host = &data.folders[0].items[0];
        assert_eq!(host.jump_host.as_deref(), Some("bastion"));
        assert_eq!(host.login_profile_id, None);
        assert_eq!(host.jump_login_profile_id, None);
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn login_ids_persist_and_unset_ones_stay_out_of_the_file() {
        let dir = temp_dir();
        let mut store = SessionStore::new(dir.clone()).unwrap();
        let mut host = mock_session("s1", "core");
        host.login_profile_id = Some("login-tacacs".to_string());
        host.jump_login_profile_id = Some("none".to_string());
        store.add_session("default", host).unwrap();
        store
            .add_session("default", mock_session("s2", "edge"))
            .unwrap();

        // A fresh store reads the file, not the cache.
        let data = SessionStore::new(dir.clone()).unwrap().load().unwrap();
        let items = &data.folders[0].items;
        assert_eq!(items[0].login_profile_id.as_deref(), Some("login-tacacs"));
        assert_eq!(items[0].jump_login_profile_id.as_deref(), Some("none"));
        assert_eq!(items[1].login_profile_id, None);

        // Unset ids are omitted, so files stay readable by older builds.
        let raw = std::fs::read_to_string(dir.join("sessions.json")).unwrap();
        assert_eq!(raw.matches("\"loginProfileId\"").count(), 1);
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn update_folder_sets_and_clears_the_default_login() {
        let dir = temp_dir();
        let mut store = SessionStore::new(dir.clone()).unwrap();
        store
            .update_folder("default", None, None, Some("login-tacacs"))
            .unwrap();
        assert_eq!(
            store.load().unwrap().folders[0].login_profile_id.as_deref(),
            Some("login-tacacs")
        );

        // Renaming / collapsing without a login leaves it alone...
        store
            .update_folder("default", Some("Core"), Some(false), None)
            .unwrap();
        let folder = &store.load().unwrap().folders[0];
        assert_eq!(folder.name, "Core");
        assert_eq!(folder.login_profile_id.as_deref(), Some("login-tacacs"));

        // ...and an empty id clears it.
        store
            .update_folder("default", None, None, Some(""))
            .unwrap();
        assert_eq!(store.load().unwrap().folders[0].login_profile_id, None);
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn clear_login_profile_forgets_every_reference_to_it() {
        let dir = temp_dir();
        let mut store = SessionStore::new(dir.clone()).unwrap();
        store
            .update_folder("default", None, None, Some("login-a"))
            .unwrap();
        let mut uses_a = mock_session("s1", "core");
        uses_a.login_profile_id = Some("login-a".to_string());
        uses_a.jump_login_profile_id = Some("login-a".to_string());
        let mut uses_b = mock_session("s2", "edge");
        uses_b.login_profile_id = Some("login-b".to_string());
        let mut per_host = mock_session("s3", "lab");
        per_host.login_profile_id = Some("none".to_string());
        for s in [uses_a, uses_b, per_host] {
            store.add_session("default", s).unwrap();
        }

        assert_eq!(store.clear_login_profile("login-a").unwrap(), 3);
        let data = SessionStore::new(dir.clone()).unwrap().load().unwrap();
        let folder = &data.folders[0];
        assert_eq!(folder.login_profile_id, None);
        assert_eq!(folder.items[0].login_profile_id, None);
        assert_eq!(folder.items[0].jump_login_profile_id, None);
        // Other logins and explicit per-host choices are untouched.
        assert_eq!(folder.items[1].login_profile_id.as_deref(), Some("login-b"));
        assert_eq!(folder.items[2].login_profile_id.as_deref(), Some("none"));

        // Nothing left to clear: no rewrite, zero reported.
        assert_eq!(store.clear_login_profile("login-a").unwrap(), 0);
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
            login_profile_id: None,
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
