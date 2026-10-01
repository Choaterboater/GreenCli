// Owner-only files for GreenCLI's data stores.
//
// Several stores hold secrets in plain JSON: saved sessions (startup commands
// often carry enable passwords), the MCP server list (env vars and headers can
// hold tokens), intents, and the config archive (raw running-configs). They
// used plain fs::write, so on Unix they came out 0644 under the usual umask,
// readable by every local account. These helpers write them 0600 (folders
// 0700) and keep the write-then-rename pattern the stores already used.
//
// Windows: the files live under %APPDATA%, which already carries a per-user
// ACL, so a plain write is used. Spawning icacls here (as ai::write_key_file
// does for API keys) would block the UI thread for the sync archive commands
// and flash a console window on every capture.

use crate::error::AppError;
use std::fs;
use std::path::{Path, PathBuf};

/// `sessions.json` → `sessions.json.tmp`: the name the stores already used, so a
/// temp file left behind by an older version is reused and fixed.
fn tmp_path(path: &Path) -> PathBuf {
    let mut name = path.file_name().unwrap_or_default().to_os_string();
    name.push(".tmp");
    path.with_file_name(name)
}

/// Write `bytes` to `path`, readable by this user only. Not atomic.
pub fn write_private(path: &Path, bytes: &[u8]) -> Result<(), AppError> {
    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
        let mut f = fs::OpenOptions::new()
            .create(true)
            .truncate(true)
            .write(true)
            .mode(0o600)
            .open(path)?;
        // `mode` only applies when the file is created. Tighten a file that
        // already existed (written 0644 by an older version) before the secret
        // goes into it; truncate already emptied it.
        f.set_permissions(fs::Permissions::from_mode(0o600))?;
        f.write_all(bytes)?;
    }
    #[cfg(not(unix))]
    fs::write(path, bytes)?;
    Ok(())
}

/// Write `bytes` to `path` owner-only AND atomically: into a sibling temp file,
/// then renamed over the target. Rename is atomic on the same filesystem, so a
/// reader never sees a torn file and a crash mid-write keeps the previous one.
/// The parent folder is created if missing (not made private: see `private_dir`).
pub fn write_private_atomic(path: &Path, bytes: &[u8]) -> Result<(), AppError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let tmp = tmp_path(path);
    write_private(&tmp, bytes)?;
    fs::rename(&tmp, path)?;
    Ok(())
}

/// Create `dir` if needed and make it this user's only (0700 on Unix).
pub fn private_dir(dir: &Path) -> Result<(), AppError> {
    fs::create_dir_all(dir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(dir, fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

/// Startup sweep: files an older version wrote with the default umask become
/// owner-only. Best effort and Unix only; symlinks are never followed.
pub fn tighten_app_dir(app_dir: &Path) {
    #[cfg(unix)]
    {
        if !is_real_dir(app_dir) {
            return;
        }
        set_mode(app_dir, 0o700);
        for name in [
            "sessions.json",
            "sessions.json.tmp",
            "intents.json",
            "intents.json.tmp",
            "intents.json.corrupt",
            "mcp_servers.json",
            "mcp_servers.json.tmp",
        ] {
            let p = app_dir.join(name);
            if is_real_file(&p) {
                set_mode(&p, 0o600);
            }
        }
        let archive = app_dir.join("config_archive");
        if is_real_dir(&archive) {
            tighten_tree(&archive, 3);
        }
    }
    #[cfg(not(unix))]
    let _ = app_dir;
}

#[cfg(unix)]
fn set_mode(path: &Path, mode: u32) {
    use std::os::unix::fs::PermissionsExt;
    let _ = fs::set_permissions(path, fs::Permissions::from_mode(mode));
}

#[cfg(unix)]
fn is_real_dir(path: &Path) -> bool {
    fs::symlink_metadata(path)
        .map(|m| m.is_dir())
        .unwrap_or(false)
}

#[cfg(unix)]
fn is_real_file(path: &Path) -> bool {
    fs::symlink_metadata(path)
        .map(|m| m.is_file())
        .unwrap_or(false)
}

/// Folders 0700, files 0600, `depth` levels down (config_archive/<device>/<ts>.json).
#[cfg(unix)]
fn tighten_tree(dir: &Path, depth: u32) {
    set_mode(dir, 0o700);
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        if kind.is_dir() && depth > 0 {
            tighten_tree(&entry.path(), depth - 1);
        } else if kind.is_file() {
            set_mode(&entry.path(), 0o600);
        }
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    fn temp_dir() -> PathBuf {
        let mut p = std::env::temp_dir();
        p.push(format!(
            "greencli-private-fs-test-{}",
            rand::random::<u64>()
        ));
        fs::create_dir_all(&p).unwrap();
        p
    }

    fn mode(p: &Path) -> u32 {
        fs::metadata(p).unwrap().permissions().mode() & 0o777
    }

    #[test]
    fn atomic_write_is_owner_only_and_leaves_no_temp_file() {
        let dir = temp_dir();
        let path = dir.join("sessions.json");
        write_private_atomic(&path, b"{\"a\":1}").unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"{\"a\":1}");
        assert_eq!(mode(&path), 0o600);
        assert!(!dir.join("sessions.json.tmp").exists());
    }

    #[test]
    fn leftover_world_readable_temp_file_is_tightened_before_the_write() {
        let dir = temp_dir();
        let path = dir.join("mcp_servers.json");
        let tmp = dir.join("mcp_servers.json.tmp");
        fs::write(&tmp, b"old").unwrap();
        fs::set_permissions(&tmp, fs::Permissions::from_mode(0o644)).unwrap();
        write_private_atomic(&path, b"new").unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"new");
        assert_eq!(mode(&path), 0o600);
    }

    #[test]
    fn overwriting_a_world_readable_file_makes_it_owner_only() {
        let dir = temp_dir();
        let path = dir.join("intents.json.corrupt");
        fs::write(&path, b"x").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
        write_private(&path, b"y").unwrap();
        assert_eq!(mode(&path), 0o600);
    }

    #[test]
    fn startup_sweep_tightens_old_files_and_the_archive() {
        let dir = temp_dir();
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o755)).unwrap();
        let sessions = dir.join("sessions.json");
        fs::write(&sessions, b"{}").unwrap();
        fs::set_permissions(&sessions, fs::Permissions::from_mode(0o644)).unwrap();
        let device = dir.join("config_archive").join("sw1-abcd1234");
        fs::create_dir_all(&device).unwrap();
        let snap = device.join("1700000000000.json");
        fs::write(&snap, b"{}").unwrap();
        fs::set_permissions(&snap, fs::Permissions::from_mode(0o644)).unwrap();

        tighten_app_dir(&dir);

        assert_eq!(mode(&dir), 0o700);
        assert_eq!(mode(&sessions), 0o600);
        assert_eq!(mode(&dir.join("config_archive")), 0o700);
        assert_eq!(mode(&device), 0o700);
        assert_eq!(mode(&snap), 0o600);
    }

    #[test]
    fn startup_sweep_does_not_follow_symlinks() {
        let dir = temp_dir();
        let outside = temp_dir().join("outside.txt");
        fs::write(&outside, b"not ours").unwrap();
        fs::set_permissions(&outside, fs::Permissions::from_mode(0o644)).unwrap();
        std::os::unix::fs::symlink(&outside, dir.join("sessions.json")).unwrap();
        tighten_app_dir(&dir);
        assert_eq!(mode(&outside), 0o644);
    }

    #[test]
    fn private_dir_is_owner_only() {
        let dir = temp_dir().join("config_archive");
        private_dir(&dir).unwrap();
        assert_eq!(mode(&dir), 0o700);
    }
}
