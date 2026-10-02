//! MCP export: write the `.mcp.json` file to the place the user picked.
//!
//! The path comes from a save dialog, so the check is done here on the real
//! path, not only on the text in the frontend (src/utils/mcpExport.ts
//! refusedExportPath; keep the two lists in step):
//! - the folder is resolved first, so a folder link into `~/.claude` is seen;
//! - a file that is a link is refused, so a `.mcp.json` link in a cloned
//!   project can't make us overwrite the file it points at;
//! - other apps' own settings files are refused;
//! - the file is written owner-only into a new temp file next to it, then
//!   renamed over the target. Rename replaces the name itself and never
//!   follows a link, so a link put there after the check can't redirect it.
//!
//! Pure std, no Tauri: the command in main.rs only calls `write_export`.

use std::fs;
use std::io::{self, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

pub const REFUSED: &str = "GreenCLI does not write other apps' own settings files. \
Pick another place, for example .mcp.json in a project folder.";
pub const LINKED: &str = "That file is a link to another file, so GreenCLI did not write it. \
Pick another place, or remove the link first.";
pub const NOT_A_FILE: &str = "That name is used by a folder, so GreenCLI did not write it. \
Pick another name.";

const REFUSED_FILES: &[&str] = &[
    ".claude.json",
    "claude_desktop_config.json",
    "settings.json",
    "settings.local.json",
    "mcp_config.json",
    "mcp_servers.json",
    "mcp_creds.json",
];

/// Other apps' own folders. Casper's working folder check refuses them too
/// (ai::casper::check_chosen_folder), so the two lists stay one.
pub(crate) const REFUSED_FOLDERS: &[&str] = &[
    ".claude",
    ".casper",
    ".vscode",
    ".cursor",
    ".codeium",
    "mcp_creds",
    "com.choatelabs.greencli",
];

/// Why this (already resolved) path is refused, or `None` when it is fine.
/// Names are compared without case, as macOS and Windows do.
pub fn refused_reason(path: &Path) -> Option<&'static str> {
    let parts: Vec<String> = path
        .components()
        .filter_map(|c| match c {
            Component::Normal(s) => Some(s.to_string_lossy().to_lowercase()),
            _ => None,
        })
        .collect();
    let Some((base, folders)) = parts.split_last() else {
        return Some(REFUSED);
    };
    let n = folders.len();
    // VS Code's own user file: .../Code/User/mcp.json (and Code - Insiders).
    let vscode_user = base == "mcp.json"
        && n >= 2
        && (folders[n - 2] == "code" || folders[n - 2] == "code - insiders")
        && folders[n - 1] == "user";
    let refused = REFUSED_FILES.contains(&base.as_str())
        || folders
            .iter()
            .any(|f| REFUSED_FOLDERS.contains(&f.as_str()))
        || vscode_user;
    refused.then_some(REFUSED)
}

/// Write `bytes` to `path` as described at the top of this file.
/// Errors are plain sentences for the user.
pub fn write_export(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let name = path
        .file_name()
        .ok_or_else(|| "Pick a file name to save to.".to_string())?;
    let parent = match path.parent() {
        Some(p) if !p.as_os_str().is_empty() => p,
        _ => Path::new("."),
    };
    let folder = fs::canonicalize(parent)
        .map_err(|e| format!("Failed to open the folder {}: {e}", parent.display()))?;
    let target = folder.join(name);
    if let Some(reason) = refused_reason(&target) {
        return Err(reason.to_string());
    }
    match fs::symlink_metadata(&target) {
        Ok(meta) if meta.file_type().is_symlink() => return Err(LINKED.to_string()),
        Ok(meta) if !meta.is_file() => return Err(NOT_A_FILE.to_string()),
        _ => {}
    }
    let tmp = temp_path(&folder, &name.to_string_lossy());
    let written = write_new_private(&tmp, bytes).and_then(|()| fs::rename(&tmp, &target));
    if written.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    written.map_err(|e| format!("Failed to write {}: {e}", path.display()))
}

/// `.mcp.json` -> `.mcp.json.<pid>-<time>-<n>.tmp` in the same folder (same
/// filesystem, so the rename is atomic).
fn temp_path(folder: &Path, name: &str) -> PathBuf {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    let pid = std::process::id();
    folder.join(format!("{name}.{pid}-{nanos}-{n}.tmp"))
}

/// Create a NEW file (never an existing one, never through a link) readable
/// by this user only, and write `bytes` to it.
fn write_new_private(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path)?;
    file.write_all(bytes)?;
    file.sync_all()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir() -> PathBuf {
        static N: AtomicU64 = AtomicU64::new(0);
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let pid = std::process::id();
        let n = N.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("greencli-export-test-{pid}-{nanos}-{n}"));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn leftovers(dir: &Path) -> Vec<String> {
        fs::read_dir(dir)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n.ends_with(".tmp"))
            .collect()
    }

    #[test]
    fn refuses_other_apps_settings_files() {
        for p in [
            "/Users/me/.claude.json",
            "/x/claude_desktop_config.json",
            "/p/.claude/settings.json",
            "/p/.Claude/x.json",
            "/Users/me/.casper/mcp.json",
            "/p/.vscode/mcp.json",
            "/Users/me/.cursor/mcp.json",
            "/Users/me/.codeium/windsurf/mcp_config.json",
            "/Users/me/Library/Application Support/Code/User/mcp.json",
            "/Users/me/Library/Application Support/com.choatelabs.greencli/x.json",
            "/",
        ] {
            assert_eq!(refused_reason(Path::new(p)), Some(REFUSED), "{p}");
        }
    }

    #[test]
    fn allows_mcp_json_in_a_project_or_home_folder() {
        for p in [
            "/Users/me/.mcp.json",
            "/p/.mcp.json",
            "/p/mcp.json",
            "/p/code/mcp.json",
        ] {
            assert_eq!(refused_reason(Path::new(p)), None, "{p}");
        }
    }

    #[test]
    fn writes_a_new_file_and_replaces_an_old_one() {
        let dir = temp_dir();
        let path = dir.join(".mcp.json");
        write_export(&path, b"one").unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"one");
        write_export(&path, b"two").unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"two");
        assert!(leftovers(&dir).is_empty());
    }

    #[test]
    fn refuses_a_folder_with_that_name() {
        let dir = temp_dir();
        fs::create_dir_all(dir.join(".mcp.json")).unwrap();
        assert_eq!(
            write_export(&dir.join(".mcp.json"), b"x"),
            Err(NOT_A_FILE.to_string())
        );
    }

    #[test]
    fn says_when_the_folder_is_missing() {
        let dir = temp_dir();
        let err = write_export(&dir.join("nope").join(".mcp.json"), b"x").unwrap_err();
        assert!(err.starts_with("Failed to open the folder"), "{err}");
    }

    #[cfg(unix)]
    #[test]
    fn the_file_is_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let dir = temp_dir();
        let path = dir.join(".mcp.json");
        fs::write(&path, b"old").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
        write_export(&path, b"new").unwrap();
        let mode = fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
    }

    #[cfg(unix)]
    #[test]
    fn never_writes_through_a_file_link() {
        let dir = temp_dir();
        let outside = temp_dir().join("settings-target.json");
        fs::write(&outside, b"keep me").unwrap();
        let link = dir.join(".mcp.json");
        std::os::unix::fs::symlink(&outside, &link).unwrap();
        assert_eq!(write_export(&link, b"x"), Err(LINKED.to_string()));
        assert_eq!(fs::read(&outside).unwrap(), b"keep me");
        assert!(fs::symlink_metadata(&link)
            .unwrap()
            .file_type()
            .is_symlink());
    }

    #[cfg(unix)]
    #[test]
    fn sees_through_a_folder_link_into_a_refused_folder() {
        let home = temp_dir();
        let claude = home.join(".claude");
        fs::create_dir_all(&claude).unwrap();
        let project = temp_dir();
        let link = project.join("cfg");
        std::os::unix::fs::symlink(&claude, &link).unwrap();
        assert_eq!(
            write_export(&link.join("x.json"), b"x"),
            Err(REFUSED.to_string())
        );
        assert!(!claude.join("x.json").exists());
    }
}
