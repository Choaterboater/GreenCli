// The server must only read. This scans its source (and the src/bin shim
// that makes the binary) for anything that writes files, talks to the
// network, starts programs, uses unsafe code or names GreenCLI's secret
// files, and checks its dependency list stays small. One exception, checked
// exactly below: src/live.rs may connect to GreenCLI's own channel,
// <data dir>/mcp-live.sock (on Windows, the named pipe that file names), and
// nothing else.

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
            // A Windows checkout has CRLF line ends; the checks use \n.
            let text = std::fs::read_to_string(&p).unwrap().replace("\r\n", "\n");
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
            // src/live.rs opens GreenCLI's pipe on Windows; checked exactly in
            // only_live_rs_connects_and_only_to_greencli.
            if *word == "OpenOptions" && is_live_rs(&path) {
                continue;
            }
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
            let pipe_open = rest.starts_with("OpenOptions::new()")
                || text[..i].ends_with("windows::") && rest.starts_with("OpenOptionsExt;");
            if pipe_open && is_live_rs(&path) {
                continue; // GreenCLI's pipe, checked exactly below
            }
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
            // Test vectors read by unit tests at build time.
            if literal.starts_with("\"../testdata/") {
                continue;
            }
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

fn is_live_rs(path: &Path) -> bool {
    path.ends_with("src/live.rs")
}

/// The one exception to "never connects": src/live.rs may connect to
/// GreenCLI's own channel, `mcp-live.sock` in GreenCLI's data folder (on
/// Windows, the named pipe whose name that file holds), and nothing else.
/// Every BANNED word (TcpStream, std::net, http, "socket" …) stays banned
/// there too.
#[test]
fn only_live_rs_connects_and_only_to_greencli() {
    let live_name = |p: &Path| is_live_rs(p);
    let sources = sources();
    assert!(
        sources.iter().any(|(p, _)| live_name(p)),
        "src/live.rs is missing"
    );
    for (path, text) in &sources {
        let words = ["UnixStream", "unix::net", "UnixListener", "UnixDatagram"];
        if !live_name(path) {
            for word in words {
                assert!(
                    !text.contains(word),
                    "{}: {word} only in src/live.rs",
                    path.display()
                );
            }
            // Every use of the live module is built on macOS, Linux and
            // Windows only.
            let lines: Vec<&str> = text.lines().collect();
            for (i, line) in lines.iter().enumerate() {
                if line.contains("live::") || line.trim() == "mod live;" {
                    let before = lines[..i]
                        .iter()
                        .rev()
                        .find(|l| !l.trim().is_empty())
                        .map(|l| l.trim());
                    assert_eq!(
                        before,
                        Some("#[cfg(any(unix, windows))]"),
                        "{}:{}: the live module only under #[cfg(any(unix, windows))]",
                        path.display(),
                        i + 1
                    );
                }
            }
            continue;
        }
        assert!(!text.contains("UnixListener"), "live.rs never listens");
        assert!(!text.contains("UnixDatagram"), "live.rs");
        assert_eq!(text.matches("unix::net").count(), 1, "one import");
        assert!(text.contains("use std::os::unix::net::UnixStream;"));
        assert_eq!(
            text.matches("UnixStream").count(),
            2,
            "the import and one connect"
        );
        assert_eq!(
            text.matches("UnixStream::connect(data_dir.join(\"mcp-live.sock\"))")
                .count(),
            1,
            "live.rs connects only to <data dir>/mcp-live.sock"
        );
        assert!(
            text.contains("#[cfg(unix)]\nuse std::os::unix::net::UnixStream;"),
            "UnixStream only on macOS and Linux"
        );
        check_windows_pipe(text);
    }
    let lib = sources
        .iter()
        .find(|(p, _)| p.ends_with("src/lib.rs"))
        .unwrap();
    assert!(lib.1.contains("#[cfg(any(unix, windows))]\nmod live;"));
}

/// Windows: live.rs reads the pipe name from <data dir>/mcp-live.sock, checks
/// it, and opens `\\.\pipe\<name>` (this computer only) for reading and
/// writing, once, in a `#[cfg(windows)]` fn. It never makes, empties or adds
/// to a file, and the server may not act as this program (anonymous).
fn check_windows_pipe(text: &str) {
    let flat: String = text.chars().filter(|c| !c.is_whitespace()).collect();
    assert_eq!(
        text.matches("OpenOptions").count(),
        2,
        "the OpenOptionsExt import and one open"
    );
    assert_eq!(
        flat.matches(
            "std::fs::OpenOptions::new().read(true).write(true)\
.security_qos_flags(SECURITY_ANONYMOUS).open(&pipe)"
        )
        .count(),
        1,
        "one open, of the pipe, read and write"
    );
    assert!(flat.contains("constSECURITY_ANONYMOUS:u32=0;"));
    assert_eq!(flat.matches("letpipe=").count(), 1);
    assert!(
        flat.contains(r#"letpipe=format!(r"\\.\pipe\{name}");"#),
        "a pipe on this computer"
    );
    assert!(flat.contains("letSome(name)=pipe_name(data_dir)else{"));
    assert_eq!(
        flat.matches("File::open(data_dir.join(\"mcp-live.sock\"))")
            .count(),
        1,
        "the name comes from <data dir>/mcp-live.sock"
    );
    for word in [".create(", ".append(", ".truncate(", "create_new"] {
        assert!(!text.contains(word), "live.rs: {word}");
    }
    let lines: Vec<&str> = text.lines().collect();
    for name in ["fn connect_pipe(", "fn pipe_name(", "use std::os::windows"] {
        let at = lines
            .iter()
            .position(|l| l.trim_start().starts_with(name) || l.contains(name))
            .unwrap_or_else(|| panic!("live.rs: no {name}"));
        let mut before = lines[..at].iter().rev().map(|l| l.trim());
        let attr = if name.starts_with("use") {
            before.find(|l| l.starts_with("#["))
        } else {
            before.find(|l| !l.starts_with("///") && !l.is_empty())
        };
        assert_eq!(
            attr,
            Some("#[cfg(windows)]"),
            "live.rs: {name} only on Windows"
        );
    }
}

/// The only channel file named is mcp-live.sock.
#[test]
fn only_the_live_channel_file_is_named() {
    for (path, text) in sources() {
        for (i, _) in text.match_indices(".sock\"") {
            let start = text[..i].rfind('"').unwrap();
            assert_eq!(
                &text[start..i + 6],
                "\"mcp-live.sock\"",
                "{}",
                path.display()
            );
        }
    }
}
