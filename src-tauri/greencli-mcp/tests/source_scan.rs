// The server must only read. This scans its source (and the src/bin shim
// that makes the binary) for anything that writes files, talks to the
// network, starts programs, uses unsafe code or names GreenCLI's secret
// files, and checks its dependency list stays small.

mod common;

use std::path::{Path, PathBuf};

fn rust_files(dir: &Path, out: &mut Vec<PathBuf>) {
    for entry in std::fs::read_dir(dir).unwrap() {
        let path = entry.unwrap().path();
        if path.is_dir() {
            rust_files(&path, out);
        } else if path.extension().is_some_and(|e| e == "rs") {
            out.push(path);
        }
    }
}

fn sources() -> Vec<(PathBuf, String)> {
    let root = common::manifest_dir();
    let mut files = Vec::new();
    rust_files(&root.join("src"), &mut files);
    files.push(root.join("../src/bin/greencli-mcp.rs"));
    files.sort();
    assert!(files.len() >= 5, "found only {files:?}");
    files
        .into_iter()
        .map(|p| {
            let text = std::fs::read_to_string(&p).unwrap();
            (p, text)
        })
        .collect()
}

/// Words that must not appear anywhere in the source, comments included.
const BANNED: &[&str] = &[
    // Writing or changing files.
    "fs::write",
    "File::create",
    "OpenOptions",
    "create_dir",
    "remove_",
    // (serde's rename_all is fine; a rename call is not)
    "rename(",
    "set_permissions",
    "hard_link",
    "symlink(",
    "copy(",
    ".with_extension(",
    // Network.
    "std::net",
    "TcpStream",
    "TcpListener",
    "UdpSocket",
    "http",
    "socket",
    // Starting programs.
    "process::Command",
    "process::Child",
    "process::Stdio",
    "process::{",
    "Command",
    "Child",
    "Stdio",
    ".spawn(",
    "tokio::process",
    // Other ways around the checks.
    "unsafe",
    "extern ",
    "#[link",
    "libc",
    "include!",
    "env::set_var",
    "env::var",
    // GreenCLI's secret files.
    "ai_keys",
    "mcp_creds",
    "vault",
    "secret_store",
];

#[test]
fn no_writes_network_or_programs() {
    for (path, text) in sources() {
        for word in BANNED {
            assert!(
                !text.contains(word),
                "{} contains the banned text {word:?}",
                path.display()
            );
        }
    }
}

/// `process::` only for `process::exit` (the shim), `fs::` only for reading,
/// and `File::` only for File::open.
#[test]
fn only_reading_calls() {
    let fs_allowed = [
        "File",
        "read",
        "symlink_metadata",
        "metadata",
        "read_to_string",
    ];
    for (path, text) in sources() {
        for (i, _) in text.match_indices("process::") {
            assert!(
                text[i..].starts_with("process::exit("),
                "{}: process:: other than exit",
                path.display()
            );
        }
        for (i, _) in text.match_indices("fs::") {
            let rest = &text[i + 4..];
            let name: String = rest
                .chars()
                .take_while(|c| c.is_ascii_alphanumeric() || *c == '_')
                .collect();
            assert!(
                fs_allowed.contains(&name.as_str()) || name.is_empty() && rest.starts_with('{'),
                "{}: fs::{name} is not a reading call",
                path.display()
            );
            if rest.starts_with('{') {
                let list: String = rest.chars().take_while(|c| *c != '}').collect();
                for item in list.trim_start_matches('{').split(',') {
                    let item = item.trim();
                    assert!(
                        fs_allowed.contains(&item) || item == "self",
                        "{}: fs::{{{item}}} is not a reading call",
                        path.display()
                    );
                }
            }
        }
        for (i, _) in text.match_indices("File::") {
            let before = text[..i].chars().next_back();
            if before.is_some_and(|c| c.is_ascii_alphanumeric() || c == '_') {
                continue; // another type's name, like ReadFile::
            }
            assert!(
                text[i..].starts_with("File::open("),
                "{}: File:: other than open",
                path.display()
            );
        }
        // `.write(` style calls only on the protocol writer, never on a file.
        assert!(!text.contains("File::options"), "{}", path.display());
    }
}

/// The only per-snapshot file the server may name is the hidden copy.
#[test]
fn only_hidden_copies_are_read() {
    let allowed = [
        "\"{}.hidden.json\"",
        "\"sessions.json\"",
        "\"intents.json\"",
        "\"index.json\"",
    ];
    for (path, text) in sources() {
        for (i, _) in text.match_indices(".json\"") {
            let start = text[..i].rfind('"').unwrap();
            let literal = &text[start..i + 6];
            assert!(
                allowed.contains(&literal),
                "{}: names the file {literal}",
                path.display()
            );
        }
        assert!(!text.contains("{ts}.json"), "{}", path.display());
        assert!(!text.contains(".corrupt"), "{}", path.display());
    }
}

#[test]
fn dependencies_stay_small() {
    let root = common::manifest_dir();
    let manifest = std::fs::read_to_string(root.join("Cargo.toml")).unwrap();
    assert!(!root.join("build.rs").exists(), "no build script");
    let allowed = ["serde", "serde_json", "dirs", "similar"];
    let mut in_deps = false;
    let mut seen = Vec::new();
    for line in manifest.lines() {
        let line = line.trim();
        if line.starts_with('[') {
            assert!(
                !line.contains("build-dependencies") && !line.starts_with("[target"),
                "unexpected table {line}"
            );
            in_deps = line == "[dependencies]";
            continue;
        }
        if in_deps && !line.is_empty() && !line.starts_with('#') {
            let name = line.split('=').next().unwrap().trim().to_string();
            assert!(
                allowed.contains(&name.as_str()),
                "dependency {name} is not allowed"
            );
            seen.push(name);
        }
    }
    assert!(seen.contains(&"serde_json".to_string()));
    assert!(!manifest.contains("build ="), "no build script");
}
