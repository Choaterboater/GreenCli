// The server reads the same folder as the app, and ships with the same version.

mod common;

use serde_json::Value;

fn tauri_conf() -> Value {
    let text = std::fs::read_to_string(common::manifest_dir().join("../tauri.conf.json")).unwrap();
    serde_json::from_str(&text).unwrap()
}

fn package_version(manifest: &str) -> String {
    let mut in_package = false;
    for line in manifest.lines() {
        let line = line.trim();
        if line.starts_with('[') {
            in_package = line == "[package]";
        } else if in_package && line.starts_with("version") {
            return line.split('"').nth(1).unwrap().to_string();
        }
    }
    panic!("no package version");
}

#[test]
fn reads_the_apps_data_folder() {
    let conf = tauri_conf();
    assert_eq!(conf["identifier"], greencli_mcp::APP_IDENTIFIER);
    let text = conf.to_string();
    assert!(
        !text.contains("appDirectoriesOverride"),
        "the app's data folder moved; greencli-mcp must follow it"
    );
    let dir = greencli_mcp::data_dir().unwrap();
    assert!(dir.ends_with(greencli_mcp::APP_IDENTIFIER));
}

#[test]
fn same_version_as_the_app() {
    let app = std::fs::read_to_string(common::manifest_dir().join("../Cargo.toml")).unwrap();
    assert_eq!(package_version(&app), greencli_mcp::VERSION);
    assert_eq!(tauri_conf()["version"], greencli_mcp::VERSION);
}
