//! Folder view in the Config Editor: list a folder the user picked, read-only.
//! Heavy or generated folders (.git, node_modules, target …) are skipped,
//! symlinks are never followed (no loops, nothing outside the folder), and the
//! walk stops at a fixed size so a home folder can't freeze the app.

use serde::Serialize;
use std::fs;
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
    let mut children: Vec<(String, bool, u64)> = read
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().into_owned();
            // symlink_metadata: a link is never followed.
            let meta = entry.path().symlink_metadata().ok()?;
            if meta.file_type().is_symlink() {
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
}
