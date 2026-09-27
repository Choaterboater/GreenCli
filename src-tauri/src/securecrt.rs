// SecureCRT session import: read the .ini files under a SecureCRT "Sessions"
// folder so the frontend can turn them into saved hosts.
//
// SecureCRT keeps one .ini per session, nested in sub-folders that mirror the
// Session Manager tree. Parsing happens in the frontend (src/utils/importHosts.ts);
// this side only walks the tree safely and ships the text back.

use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};

/// Stop after this many session files — a Sessions folder is a few hundred to
/// a few thousand files; anything beyond that is the wrong folder.
const MAX_FILES: usize = 5000;
/// A session .ini is 10–40 KB; skip anything far larger rather than read it.
const MAX_FILE_BYTES: u64 = 1024 * 1024;
/// Nested folders deeper than this are almost certainly a symlink/junction loop.
const MAX_DEPTH: usize = 32;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionFile {
    /// Path relative to the Sessions folder, `/`-separated (`Lab/Core/sw1.ini`).
    pub path: String,
    /// The file's `S:` / `D:` lines — everything the importer reads.
    pub text: String,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionScan {
    pub files: Vec<SessionFile>,
    /// Files that could not be used (too large, unreadable), with the reason.
    pub skipped: Vec<String>,
    /// More than MAX_FILES sessions — the rest were not read.
    pub truncated: bool,
}

/// Where SecureCRT keeps its sessions by default on this OS, if that folder exists.
pub fn default_sessions_dir() -> Option<PathBuf> {
    let home = crate::ssh::ssh_config::home_dir();
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(appdata) = std::env::var("APPDATA") {
        candidates.push(
            PathBuf::from(appdata)
                .join("VanDyke")
                .join("Config")
                .join("Sessions"),
        );
    }
    if let Some(h) = home {
        candidates.push(
            h.join("Library")
                .join("Application Support")
                .join("VanDyke")
                .join("SecureCRT")
                .join("Config")
                .join("Sessions"),
        );
        candidates.push(
            h.join(".vandyke")
                .join("SecureCRT")
                .join("Config")
                .join("Sessions"),
        );
    }
    candidates.into_iter().find(|p| p.is_dir())
}

/// Decode a session file. SecureCRT writes UTF-8 with a BOM (older builds:
/// plain ANSI, some tools re-save as UTF-16), so handle all three instead of
/// letting a BOM glue itself onto the first key.
fn decode(bytes: &[u8]) -> String {
    if let Some(rest) = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]) {
        return String::from_utf8_lossy(rest).into_owned();
    }
    if let Some(rest) = bytes.strip_prefix(&[0xFF, 0xFE]) {
        let units: Vec<u16> = rest
            .chunks_exact(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect();
        return String::from_utf16_lossy(&units);
    }
    String::from_utf8_lossy(bytes).into_owned()
}

/// Keep only single-line string (`S:`) and number (`D:`) settings. The
/// multi-line `Z:`/`B:` blocks (key maps, colour tables, keyword lists, binary
/// blobs) never hold connection details and are the bulk of each file — with
/// thousands of sessions they would bloat the IPC reply for nothing.
fn keep_settings(text: &str) -> String {
    let mut out = String::new();
    for line in text.lines() {
        if line.starts_with("S:\"") || line.starts_with("D:\"") {
            out.push_str(line.trim_end());
            out.push('\n');
        }
    }
    out
}

fn is_session_file(name: &str, at_root: bool) -> bool {
    let lower = name.to_ascii_lowercase();
    // __FolderData__.ini holds folder settings; the root Default.ini is the
    // template new sessions start from — neither is a device.
    lower.ends_with(".ini") && lower != "__folderdata__.ini" && !(at_root && lower == "default.ini")
}

/// Read every session .ini under `root` (recursively, sorted by path).
///
/// Accepts the SecureCRT `Config` folder too: people often pick the folder
/// that holds `Sessions/` rather than `Sessions/` itself.
pub fn read_sessions_dir(root: &Path) -> Result<SessionScan, String> {
    read_sessions_dir_capped(root, MAX_FILES)
}

fn read_sessions_dir_capped(root: &Path, max_files: usize) -> Result<SessionScan, String> {
    if !root.is_dir() {
        return Err(format!("{} is not a folder", root.display()));
    }
    let sessions = root.join("Sessions");
    let root = if sessions.is_dir() && root.join("Global.ini").is_file() {
        sessions
    } else {
        root.to_path_buf()
    };

    let mut scan = SessionScan::default();
    // (directory, relative path parts, depth)
    let mut stack: Vec<(PathBuf, Vec<String>, usize)> = vec![(root, Vec::new(), 0)];
    let mut found: Vec<(String, PathBuf)> = Vec::new();

    while let Some((dir, rel, depth)) = stack.pop() {
        let entries = match fs::read_dir(&dir) {
            Ok(e) => e,
            Err(e) => {
                scan.skipped.push(format!("{}: {}", dir.display(), e));
                continue;
            }
        };
        for entry in entries.flatten() {
            // file_type() does not follow symlinks, so a linked folder can't
            // send the walk in circles.
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            let name = entry.file_name().to_string_lossy().into_owned();
            if kind.is_dir() {
                if depth + 1 < MAX_DEPTH {
                    let mut child = rel.clone();
                    child.push(name);
                    stack.push((entry.path(), child, depth + 1));
                }
            } else if kind.is_file() && is_session_file(&name, depth == 0) {
                let mut parts = rel.clone();
                parts.push(name);
                found.push((parts.join("/"), entry.path()));
            }
        }
    }

    found.sort_by(|a, b| a.0.to_lowercase().cmp(&b.0.to_lowercase()));
    if found.len() > max_files {
        found.truncate(max_files);
        scan.truncated = true;
    }

    for (rel, path) in found {
        match fs::metadata(&path) {
            Ok(m) if m.len() > MAX_FILE_BYTES => {
                scan.skipped.push(format!("{}: larger than 1 MB", rel));
                continue;
            }
            Err(e) => {
                scan.skipped.push(format!("{}: {}", rel, e));
                continue;
            }
            _ => {}
        }
        match fs::read(&path) {
            Ok(bytes) => scan.files.push(SessionFile {
                path: rel,
                text: keep_settings(&decode(&bytes)),
            }),
            Err(e) => scan.skipped.push(format!("{}: {}", rel, e)),
        }
    }
    Ok(scan)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir() -> PathBuf {
        let p = std::env::temp_dir().join(format!("greencli-securecrt-{}", rand::random::<u64>()));
        fs::create_dir_all(&p).unwrap();
        p
    }

    fn write(root: &Path, rel: &str, contents: &[u8]) {
        let p = root.join(rel);
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, contents).unwrap();
    }

    const SESSION: &str = "S:\"Protocol Name\"=SSH2\r\nS:\"Hostname\"=10.1.1.1\r\nD:\"[SSH2] Port\"=00000016\r\nZ:\"Keyword List\"=00000001\r\n core\r\nB:\"Normal Font v2\"=00000004\r\n 01 02 03 04\r\n";

    #[test]
    fn walks_nested_folders_and_skips_folder_data_and_default() {
        let root = temp_dir();
        write(&root, "sw1.ini", SESSION.as_bytes());
        write(&root, "Lab/Core/core1.ini", SESSION.as_bytes());
        write(&root, "Lab/__FolderData__.ini", b"S:\"Folder\"=x\n");
        write(&root, "Default.ini", SESSION.as_bytes());
        write(&root, "Lab/Default.ini", SESSION.as_bytes());
        write(&root, "Lab/notes.txt", b"not a session");

        let scan = read_sessions_dir(&root).unwrap();
        let paths: Vec<&str> = scan.files.iter().map(|f| f.path.as_str()).collect();
        // Only the root Default.ini is SecureCRT's template.
        assert_eq!(paths, ["Lab/Core/core1.ini", "Lab/Default.ini", "sw1.ini"]);
        assert!(!scan.truncated);
        assert!(scan.skipped.is_empty());
        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn keeps_only_single_line_settings() {
        let root = temp_dir();
        write(&root, "sw1.ini", SESSION.as_bytes());
        let scan = read_sessions_dir(&root).unwrap();
        assert_eq!(
            scan.files[0].text,
            "S:\"Protocol Name\"=SSH2\nS:\"Hostname\"=10.1.1.1\nD:\"[SSH2] Port\"=00000016\n"
        );
        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn strips_utf8_bom_and_decodes_utf16() {
        let root = temp_dir();
        let mut bom = vec![0xEF, 0xBB, 0xBF];
        bom.extend_from_slice(b"S:\"Hostname\"=a.example\n");
        write(&root, "a.ini", &bom);
        let mut utf16 = vec![0xFF, 0xFE];
        for u in "S:\"Hostname\"=b.example\r\n".encode_utf16() {
            utf16.extend_from_slice(&u.to_le_bytes());
        }
        write(&root, "b.ini", &utf16);

        let scan = read_sessions_dir(&root).unwrap();
        assert_eq!(scan.files[0].text, "S:\"Hostname\"=a.example\n");
        assert_eq!(scan.files[1].text, "S:\"Hostname\"=b.example\n");
        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn skips_oversized_files() {
        let root = temp_dir();
        write(&root, "big.ini", &vec![b'x'; (MAX_FILE_BYTES + 1) as usize]);
        write(&root, "ok.ini", SESSION.as_bytes());
        let scan = read_sessions_dir(&root).unwrap();
        assert_eq!(scan.files.len(), 1);
        assert_eq!(scan.skipped, ["big.ini: larger than 1 MB"]);
        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn stops_at_the_file_cap() {
        let root = temp_dir();
        for name in ["a.ini", "b.ini", "c.ini"] {
            write(&root, name, SESSION.as_bytes());
        }
        let scan = read_sessions_dir_capped(&root, 2).unwrap();
        assert_eq!(scan.files.len(), 2);
        assert!(scan.truncated);
        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn accepts_the_config_folder_above_sessions() {
        let root = temp_dir();
        write(&root, "Global.ini", b"S:\"Global\"=1\n");
        write(&root, "Sessions/Site A/sw1.ini", SESSION.as_bytes());
        let scan = read_sessions_dir(&root).unwrap();
        assert_eq!(scan.files.len(), 1);
        assert_eq!(scan.files[0].path, "Site A/sw1.ini");
        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn rejects_a_file_path() {
        let root = temp_dir();
        write(&root, "sw1.ini", SESSION.as_bytes());
        assert!(read_sessions_dir(&root.join("sw1.ini")).is_err());
        fs::remove_dir_all(root).ok();
    }
}
