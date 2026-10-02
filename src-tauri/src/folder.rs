//! Folder view in the Config Editor: list a folder the user picked, read-only.
//! Heavy or generated folders (.git, node_modules, target …) are skipped,
//! symlinks are never followed (no loops, nothing outside the folder), and the
//! walk stops at a fixed size so a home folder can't freeze the app.

use serde::Serialize;
use std::fs;
use std::io::Read;
use std::path::Path;

/// Folders never walked into: version control, packages and build output.
const SKIP_DIRS: &[&str] = &[
    ".git",
    ".hg",
    ".svn",
    "node_modules",
    "target",
    ".venv",
    "venv",
    "__pycache__",
    ".terraform",
    ".tox",
    ".mypy_cache",
    ".pytest_cache",
    ".idea",
    ".DS_Store",
];
pub const MAX_ENTRIES: usize = 5000;
pub const MAX_DEPTH: usize = 12;
/// The biggest file the folder view opens (folderTree.ts MAX_OPEN_BYTES).
pub const MAX_OPEN_BYTES: u64 = 5 * 1024 * 1024;

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FolderEntry {
    /// Path from the folder, with `/` between parts on every system.
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderListing {
    pub root: String,
    pub entries: Vec<FolderEntry>,
    /// The walk stopped at MAX_ENTRIES or MAX_DEPTH.
    pub truncated: bool,
}

pub fn list_folder(root: &Path) -> Result<FolderListing, String> {
    let meta = fs::metadata(root).map_err(|e| format!("Can't open {}: {}", root.display(), e))?;
    if !meta.is_dir() {
        return Err(format!("{} is not a folder", root.display()));
    }
    let mut entries = Vec::new();
    let mut truncated = false;
    walk(root, "", 0, &mut entries, &mut truncated);
    Ok(FolderListing {
        root: root.display().to_string(),
        entries,
        truncated,
    })
}

fn walk(dir: &Path, prefix: &str, depth: usize, out: &mut Vec<FolderEntry>, truncated: &mut bool) {
    if depth > MAX_DEPTH {
        *truncated = true;
        return;
    }
    let Ok(read) = fs::read_dir(dir) else {
        return; // unreadable folder: listed, but empty
    };
    // Stop reading once this folder alone would fill what is left, so a
    // folder with a million files isn't read and stat'ed in full.
    let budget = MAX_ENTRIES.saturating_sub(out.len());
    let mut children: Vec<(String, bool, u64)> = read
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().into_owned();
            // symlink_metadata: a link is never followed.
            let meta = entry.path().symlink_metadata().ok()?;
            // Only folders and plain files: no links, pipes, sockets or devices
            // (opening /dev/zero or a FIFO never ends).
            if !(meta.is_dir() || meta.is_file()) {
                return None;
            }
            if meta.is_dir() && SKIP_DIRS.contains(&name.as_str()) {
                return None;
            }
            Some((
                name,
                meta.is_dir(),
                if meta.is_dir() { 0 } else { meta.len() },
            ))
        })
        .take(budget + 1)
        .collect();
    // Folders first, then by name (case-insensitive), like a file manager.
    children.sort_by(|a, b| {
        b.1.cmp(&a.1)
            .then_with(|| a.0.to_lowercase().cmp(&b.0.to_lowercase()))
    });
    for (name, is_dir, size) in children {
        if out.len() >= MAX_ENTRIES {
            *truncated = true;
            return;
        }
        let path = if prefix.is_empty() {
            name.clone()
        } else {
            format!("{prefix}/{name}")
        };
        out.push(FolderEntry {
            path: path.clone(),
            is_dir,
            size,
        });
        if is_dir {
            walk(&dir.join(&name), &path, depth + 1, out, truncated);
        }
    }
}

/// Reads a file the folder view opens: a plain file only (not a pipe or a
/// device), and at most `max` bytes however big it has grown since it was
/// listed. Decoded lossily, like read_file_text.
pub fn read_text_file(path: &Path, max: u64) -> Result<String, String> {
    let meta = fs::metadata(path).map_err(|e| format!("Can't open {}: {}", path.display(), e))?;
    if !meta.is_file() {
        return Err(format!("{} is not a plain file", path.display()));
    }
    let file = fs::File::open(path).map_err(|e| format!("Can't open {}: {}", path.display(), e))?;
    let mut bytes = Vec::new();
    file.take(max + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| format!("Can't read {}: {}", path.display(), e))?;
    if bytes.len() as u64 > max {
        return Err(format!(
            "{} is too big for the editor (over {} MB)",
            path.display(),
            max / (1024 * 1024)
        ));
    }
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

/// A file that isn't a plain file (a pipe, socket or device), for read_file_text.
pub fn not_a_plain_file(path: &Path) -> Option<String> {
    match fs::metadata(path) {
        Ok(meta) if !meta.is_file() => Some(format!("{} is not a plain file", path.display())),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn temp_dir(name: &str) -> PathBuf {
        let mut p = std::env::temp_dir();
        p.push(format!("greencli-folder-{}-{}", name, std::process::id()));
        let _ = fs::remove_dir_all(&p);
        fs::create_dir_all(&p).unwrap();
        p
    }

    #[test]
    fn lists_folders_first_and_skips_heavy_folders() {
        let dir = temp_dir("list");
        fs::create_dir_all(dir.join("playbooks/roles")).unwrap();
        fs::create_dir_all(dir.join(".git/objects")).unwrap();
        fs::create_dir_all(dir.join("node_modules/x")).unwrap();
        fs::write(dir.join("b.yml"), "a: 1").unwrap();
        fs::write(dir.join("A.cfg"), "vlan 20").unwrap();
        fs::write(dir.join("playbooks/site.yml"), "- hosts: all").unwrap();
        fs::write(dir.join(".env"), "TOKEN=x").unwrap();

        let listing = list_folder(&dir).unwrap();
        let paths: Vec<_> = listing
            .entries
            .iter()
            .map(|e| (e.path.as_str(), e.is_dir))
            .collect();
        assert_eq!(
            paths,
            vec![
                ("playbooks", true),
                ("playbooks/roles", true),
                ("playbooks/site.yml", false),
                (".env", false),
                ("A.cfg", false),
                ("b.yml", false),
            ]
        );
        assert!(!listing.truncated);
        assert_eq!(
            listing
                .entries
                .iter()
                .find(|e| e.path == "A.cfg")
                .unwrap()
                .size,
            7
        );
        fs::remove_dir_all(&dir).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn never_follows_a_symlink() {
        let dir = temp_dir("link");
        fs::create_dir_all(dir.join("real")).unwrap();
        std::os::unix::fs::symlink(&dir, dir.join("real/loop")).unwrap();
        let listing = list_folder(&dir).unwrap();
        assert_eq!(listing.entries.len(), 1);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_file_is_not_a_folder() {
        let dir = temp_dir("file");
        fs::write(dir.join("x.txt"), "x").unwrap();
        assert!(list_folder(&dir.join("x.txt"))
            .unwrap_err()
            .contains("not a folder"));
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn reads_plain_files_up_to_the_limit() {
        let dir = temp_dir("read");
        fs::write(dir.join("a.cfg"), "vlan 20").unwrap();
        assert_eq!(read_text_file(&dir.join("a.cfg"), 100).unwrap(), "vlan 20");
        assert!(read_text_file(&dir.join("a.cfg"), 3)
            .unwrap_err()
            .contains("too big"));
        assert!(read_text_file(&dir, 100)
            .unwrap_err()
            .contains("not a plain file"));
        assert!(not_a_plain_file(&dir).is_some());
        assert!(not_a_plain_file(&dir.join("a.cfg")).is_none());
        assert!(not_a_plain_file(&dir.join("missing")).is_none());
    }

    #[cfg(unix)]
    #[test]
    fn skips_pipes_and_devices() {
        let dir = temp_dir("fifo");
        fs::write(dir.join("ok.txt"), "x").unwrap();
        let made = std::process::Command::new("mkfifo")
            .arg(dir.join("pipe"))
            .status()
            .is_ok_and(|s| s.success());
        let listing = list_folder(&dir).unwrap();
        let names: Vec<_> = listing.entries.iter().map(|e| e.path.as_str()).collect();
        assert_eq!(names, vec!["ok.txt"]);
        if made {
            assert!(read_text_file(&dir.join("pipe"), 100).is_err());
        }
        assert!(read_text_file(Path::new("/dev/zero"), 100).is_err());
    }
}
