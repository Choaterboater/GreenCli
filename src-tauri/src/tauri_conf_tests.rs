//! Guards for the Tauri 2 move. Users must keep their data after the upgrade
//! from 1.x: the same bundle id and data folder, and the same webview origin
//! (on Windows Tauri 2 defaults to http://tauri.localhost, while 1.x used
//! https; a new origin starts with empty localStorage, losing every setting).
//! The windows may call only the short list of commands 1.x allowed.

use serde_json::Value;
use std::collections::BTreeSet;

const CONF: &str = include_str!("../tauri.conf.json");
const CAPS: &str = include_str!("../capabilities/default.json");
const MAIN_RS: &str = include_str!("main.rs");

/// The WiX upgrade code 1.x installers used (uuid5 of "GreenCLI.exe.app.x64").
/// A different code would install 2.x next to 1.x instead of over it.
const UPGRADE_CODE: &str = "718138b6-2db8-5ffd-9235-e853b5bba5b8";

/// Exactly what the windows may call. Adding a permission is a decision:
/// change this list in the same commit, and say why.
const PERMISSIONS: [&str; 12] = [
    "core:event:allow-listen",
    "core:event:allow-unlisten",
    "core:event:allow-emit",
    "core:window:allow-start-dragging",
    "core:window:allow-set-focus",
    "core:window:allow-close",
    "core:window:allow-get-all-windows",
    "core:window:allow-show",
    "dialog:allow-open",
    "dialog:allow-save",
    "clipboard-manager:allow-read-text",
    "clipboard-manager:allow-write-text",
];

fn conf() -> Value {
    serde_json::from_str(CONF).expect("tauri.conf.json is JSON")
}

fn caps() -> Value {
    serde_json::from_str(CAPS).expect("capabilities/default.json is JSON")
}

/// Every key anywhere in the value, at any depth.
fn all_keys(value: &Value, out: &mut BTreeSet<String>) {
    match value {
        Value::Object(map) => {
            for (key, item) in map {
                out.insert(key.clone());
                all_keys(item, out);
            }
        }
        Value::Array(list) => list.iter().for_each(|item| all_keys(item, out)),
        _ => {}
    }
}

#[test]
fn identity_matches_1x() {
    let c = conf();
    assert_eq!(c["identifier"], "com.choatelabs.greencli");
    assert_eq!(c["productName"], "GreenCLI");
    assert_eq!(c["mainBinaryName"], "GreenCLI");
    assert_eq!(c["bundle"]["macOS"]["minimumSystemVersion"], "13.3");
    assert_eq!(c["bundle"]["windows"]["wix"]["upgradeCode"], UPGRADE_CODE);
}

#[test]
fn same_origin_and_data_folder() {
    let c = conf();
    let windows = c["app"]["windows"].as_array().expect("app.windows");
    assert!(!windows.is_empty());
    for w in windows {
        assert_eq!(w["useHttpsScheme"], true, "window {} must keep https", w["label"]);
    }
    let mut keys = BTreeSet::new();
    all_keys(&c, &mut keys);
    for banned in ["withGlobalTauri", "appDirectoriesOverride", "allowlist"] {
        assert!(!keys.contains(banned), "{banned} must not be set");
    }
    let csp = c["app"]["security"]["csp"].as_str().expect("csp");
    let connect = csp
        .split(';')
        .map(str::trim)
        .find(|d| d.starts_with("connect-src "))
        .expect("connect-src");
    let sources: Vec<&str> = connect.split_whitespace().collect();
    for needed in ["ipc:", "http://ipc.localhost", "https://ipc.localhost"] {
        assert!(sources.contains(&needed), "connect-src needs {needed}");
    }
}

#[test]
fn updater_files_off_by_default() {
    let c = conf();
    let made = &c["bundle"]["createUpdaterArtifacts"];
    assert!(made.is_null() || *made == false, "createUpdaterArtifacts must stay off");
    // No v1 updater block either.
    assert!(c.get("tauri").is_none());
}

#[test]
fn one_capability_file() {
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("capabilities");
    let files: Vec<String> = std::fs::read_dir(&dir)
        .expect("capabilities folder")
        .map(|e| e.expect("entry").file_name().to_string_lossy().into_owned())
        .collect();
    assert_eq!(files, vec!["default.json".to_string()]);
}

#[test]
fn capability_is_the_short_list() {
    let c = caps();
    assert_eq!(c["identifier"], "default");
    assert_eq!(c["local"], true);
    assert!(c.get("remote").is_none(), "no remote URLs may call the app");
    assert_eq!(c["windows"], serde_json::json!(["main", "popout-*"]));
    let perms = c["permissions"].as_array().expect("permissions");
    let got: Vec<&str> = perms
        .iter()
        .map(|p| p.as_str().expect("plain permission names only"))
        .collect();
    let got_set: BTreeSet<&str> = got.iter().copied().collect();
    assert_eq!(got.len(), got_set.len(), "no duplicates");
    let want: BTreeSet<&str> = PERMISSIONS.into_iter().collect();
    assert_eq!(got_set, want);
}

#[test]
fn pop_outs_keep_https() {
    let mut rest = MAIN_RS;
    let mut seen = 0;
    while let Some(at) = rest.find("WebviewWindowBuilder::new(") {
        let after = &rest[at..];
        let build = after.find(".build()").expect("builder ends with .build()");
        assert!(
            after[..build].contains(".use_https_scheme(true)"),
            "every WebviewWindowBuilder needs .use_https_scheme(true) before .build()"
        );
        seen += 1;
        rest = &after[build..];
    }
    assert!(seen >= 1, "the pop-out builder is in main.rs");
}

/// Sync commands run on the main thread, so slow work in one freezes every
/// window. The config archive reads and parses files under one lock (the
/// hidden copy count reads every hidden copy), so each command that uses it
/// is async and hands the work to the blocking pool through `archive_task`.
#[test]
fn config_archive_commands_leave_the_main_thread() {
    let mut seen = 0;
    for (at, _) in MAIN_RS.match_indices("#[tauri::command") {
        let rest = &MAIN_RS[at..];
        let end = rest.find("\n}\n").expect("each command ends with a closing brace");
        let item = &rest[..end];
        if !item.contains("config_archive") {
            continue;
        }
        let name = item.lines().find(|l| l.contains("fn ")).unwrap_or(item);
        assert!(
            name.contains("async fn "),
            "{name}: a config archive command must be async"
        );
        assert!(
            item.contains("archive_task(") && !item.contains(".config_archive"),
            "{name}: use the archive only inside archive_task"
        );
        seen += 1;
    }
    assert!(seen >= 7, "found only {seen} config archive commands");
}
