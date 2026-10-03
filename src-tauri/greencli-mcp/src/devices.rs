//! list_devices: the saved sessions, safe fields only.
//!
//! `sessions.json` is read into structs that only have the fields served
//! here, so login ids, notes, startup commands, key paths, jump hosts,
//! local commands and the user name are never even parsed.

use crate::files::{read_capped, ReadError, ReadFile};
use crate::page::{self, clip, make_cursor, read_cursor, take_items, PAGE_BUDGET};
use crate::tools::ToolFail;
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashSet;
use std::path::Path;

const MAX_FILE: u64 = 16 * 1024 * 1024;
const MAX_TAGS: usize = 16;
const TOOL: &str = "list_devices";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Device {
    #[serde(default)]
    id: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    protocol: String,
    #[serde(default)]
    host: Option<String>,
    #[serde(default)]
    port: Option<u16>,
    #[serde(default)]
    device_type: String,
    #[serde(default)]
    device_profile_id: Option<String>,
    #[serde(default)]
    tags: Vec<String>,
}

#[derive(Deserialize)]
struct Folder {
    #[serde(default)]
    name: String,
    #[serde(default)]
    items: Vec<Device>,
}

#[derive(Deserialize)]
struct Sessions {
    #[serde(default)]
    folders: Vec<Folder>,
    #[serde(default)]
    sessions: Vec<Device>,
}

fn read_sessions(data_dir: &Path) -> Result<Sessions, ToolFail> {
    let bytes = match read_capped(&data_dir.join("sessions.json"), MAX_FILE) {
        Ok(ReadFile::Missing) => {
            return Ok(Sessions {
                folders: Vec::new(),
                sessions: Vec::new(),
            })
        }
        Ok(ReadFile::Bytes(b)) => b,
        Err(ReadError::TooBig) => {
            return Err(ToolFail::Error(
                "GreenCLI's saved sessions file is too big to read.".into(),
            ))
        }
        Err(ReadError::NotPlain) => {
            return Err(ToolFail::Error(
                "GreenCLI's saved sessions file couldn't be read.".into(),
            ))
        }
    };
    serde_json::from_slice(&bytes)
        .map_err(|_| ToolFail::Error("GreenCLI's saved sessions file couldn't be read.".into()))
}

/// The key the config archive files this device under: the same rule as the
/// app's getDeviceId (name, else host, else id).
fn archive_key(d: &Device) -> String {
    if !d.name.is_empty() {
        d.name.clone()
    } else if let Some(host) = d.host.as_deref().filter(|h| !h.is_empty()) {
        host.to_string()
    } else {
        d.id.clone()
    }
}

/// The archiveKey of every saved device (list_archive_devices uses it to say
/// which archive names are still a saved device's).
pub(crate) fn saved_archive_keys(data_dir: &Path) -> Result<HashSet<String>, ToolFail> {
    let data = read_sessions(data_dir)?;
    Ok(data
        .folders
        .iter()
        .flat_map(|f| &f.items)
        .chain(&data.sessions)
        .map(archive_key)
        .collect())
}

fn device_json(d: &Device, folder: Option<&str>) -> Value {
    let tags: Vec<String> = d.tags.iter().take(MAX_TAGS).map(|t| clip(t, 64)).collect();
    json!({
        "id": clip(&d.id, 128),
        "name": clip(&d.name, 128),
        "folder": folder.map(|f| clip(f, 128)),
        "protocol": clip(&d.protocol, 16),
        "host": d.host.as_deref().map(|h| clip(h, 255)),
        "port": d.port,
        "deviceType": clip(&d.device_type, 64),
        "deviceProfileId": d.device_profile_id.as_deref().map(|p| clip(p, 128)),
        "tags": tags,
        "archiveKey": clip(&archive_key(d), 255),
    })
}

pub fn list_devices(data_dir: &Path, cursor: Option<&str>) -> Result<Value, ToolFail> {
    let start = match cursor {
        None => 0,
        Some(c) => read_cursor(TOOL, c)
            .filter(|c| c.key.is_null())
            .map(|c| c.offset)
            .ok_or_else(|| ToolFail::Error(page::BAD_CURSOR.into()))?,
    };
    let data = read_sessions(data_dir)?;
    let mut all: Vec<Value> = Vec::new();
    for folder in &data.folders {
        for d in &folder.items {
            all.push(device_json(d, Some(&folder.name)));
        }
    }
    for d in &data.sessions {
        all.push(device_json(d, None));
    }
    if start > all.len() {
        return Err(ToolFail::Error(page::BAD_CURSOR.into()));
    }
    let (devices, next) = take_items(&all, start, PAGE_BUDGET);
    Ok(json!({
        "total": all.len(),
        "devices": devices,
        "nextCursor": next.map(|n| make_cursor(TOOL, &Value::Null, n)),
    }))
}
