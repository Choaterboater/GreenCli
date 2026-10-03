// Which folder the server reads. GreenCLI passes its own data folder with
// --data-dir, since the folder this process finds can differ from the app's
// (on Linux, Casper starts servers without XDG_DATA_HOME). A folder that
// isn't there is an error, never empty lists that read as "no devices".

mod common;

use common::*;
use greencli_mcp::data_dir_arg;
use serde_json::json;
use std::ffi::OsString;

fn args(list: &[&str]) -> Vec<OsString> {
    list.iter().map(OsString::from).collect()
}

#[test]
fn takes_only_a_full_data_dir() {
    // A full path on every platform.
    let dir = std::env::temp_dir();
    let full = dir.to_str().unwrap();
    assert_eq!(data_dir_arg(args(&[])), Ok(None));
    assert_eq!(data_dir_arg(args(&["--data-dir", full])), Ok(Some(dir.clone())));
    let spaced = dir.join("Application Support").join("com.choatelabs.greencli");
    assert_eq!(
        data_dir_arg(args(&["--data-dir", spaced.to_str().unwrap()])),
        Ok(Some(spaced.clone()))
    );
    for bad in [
        vec!["--data-dir"],
        vec!["--data-dir", ""],
        vec!["--data-dir", "relative/folder"],
        vec!["--data-dir", full, "--data-dir", full],
        vec!["--data-dir", full, "--verbose"],
        vec!["--verbose"],
        vec![full],
    ] {
        let got = data_dir_arg(args(&bad));
        assert!(got.is_err(), "{bad:?} gave {got:?}");
    }
}

#[test]
fn a_missing_data_folder_is_an_error_not_empty_lists() {
    let parent = temp_dir("missing");
    let dir = parent.join("com.choatelabs.greencli");
    for (tool, a) in [
        ("list_devices", json!({})),
        ("list_archive_devices", json!({})),
        ("list_intents", json!({})),
        ("list_config_history", json!({"device": "sw1"})),
        ("get_config", json!({"device": "sw1"})),
        ("get_config_diff", json!({"device": "sw1"})),
    ] {
        let (is_error, body, text) = call(&dir, tool, a);
        assert!(is_error, "{tool}: {text}");
        let error = body["error"].as_str().unwrap();
        assert_eq!(
            error,
            format!(
                "GreenCLI's data folder {} wasn't found. Open GreenCLI once, or add greencli \
again from GreenCLI's MCP settings.",
                dir.display()
            ),
            "{tool}"
        );
    }
    // access_check reads nothing, so it still answers.
    let (is_error, body, text) = call(&dir, "access_check", json!({}));
    assert!(!is_error, "{text}");
    assert_eq!(body["contract"], "casper/access-check v1");

    // With the folder there and nothing in it, the lists are empty.
    std::fs::create_dir_all(&dir).unwrap();
    for tool in ["list_devices", "list_archive_devices", "list_intents"] {
        let (is_error, body, text) = call(&dir, tool, json!({}));
        assert!(!is_error, "{tool}: {text}");
        assert_eq!(body["total"], 0, "{tool}: {text}");
    }
    std::fs::remove_dir_all(parent).ok();
}
