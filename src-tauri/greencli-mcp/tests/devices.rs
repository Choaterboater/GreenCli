// list_devices serves the safe fields only, and pages stay small.

mod common;

use common::*;
use serde_json::{json, Value};

fn fixture_dir(tag: &str) -> std::path::PathBuf {
    let dir = temp_dir(tag);
    std::fs::copy(
        manifest_dir().join("testdata/fixture/sessions.json"),
        dir.join("sessions.json"),
    )
    .unwrap();
    dir
}

#[test]
fn lists_safe_fields_only() {
    let dir = fixture_dir("devices");
    let (is_error, body, text) = call(&dir, "list_devices", json!({}));
    assert!(!is_error, "{text}");
    assert!(!text.contains("SECRET"), "{text}");
    assert!(!text.contains("hunter2"), "{text}");
    assert_eq!(body["total"], 3);
    assert_eq!(body["nextCursor"], Value::Null);
    let devices = body["devices"].as_array().unwrap();
    assert_eq!(
        devices[0],
        json!({
            "id": "s1", "name": "sw-core-01", "folder": "Core", "protocol": "ssh",
            "host": "10.0.0.1", "port": 22, "deviceType": "aruba-cx",
            "deviceProfileId": "aruba-cx", "tags": ["core", "dc1"], "archiveKey": "sw-core-01"
        })
    );
    // No name: the archive key is the host, as in the app.
    assert_eq!(devices[1]["archiveKey"], "10.0.0.2");
    assert_eq!(devices[2]["folder"], Value::Null);
    assert_eq!(devices[2]["archiveKey"], "my shell");
    std::fs::remove_dir_all(dir).ok();
}

#[test]
fn no_sessions_file_is_an_empty_list() {
    let dir = temp_dir("devices-none");
    let (is_error, body, _) = call(&dir, "list_devices", json!({}));
    assert!(!is_error);
    assert_eq!(body["total"], 0);
    std::fs::remove_dir_all(dir).ok();
}

#[test]
fn a_corrupt_file_is_an_error_and_left_alone() {
    let dir = temp_dir("devices-corrupt");
    std::fs::write(dir.join("sessions.json"), "{\"folders\": [").unwrap();
    let (is_error, body, _) = call(&dir, "list_devices", json!({}));
    assert!(is_error);
    assert!(body["error"].as_str().unwrap().contains("couldn't be read"));
    let names: Vec<_> = std::fs::read_dir(&dir)
        .unwrap()
        .map(|e| e.unwrap().file_name())
        .collect();
    assert_eq!(names, ["sessions.json"]);
    std::fs::remove_dir_all(dir).ok();
}

#[test]
fn many_devices_page_under_the_cap() {
    let dir = temp_dir("devices-many");
    let items: Vec<Value> = (0..700)
        .map(|i| {
            json!({"id": format!("id-{i}"), "name": format!("switch-{i}-{}", "x".repeat(200)),
                   "protocol": "ssh", "host": format!("10.1.{}.{}", i / 250, i % 250), "port": 22,
                   "deviceType": "aruba-cx", "tags": ["a", "b", "c"], "notes": "SECRET"})
        })
        .collect();
    let data = json!({"version": "1.0", "folders": [{"id": "f", "name": "All", "expanded": true, "items": items}]});
    std::fs::write(dir.join("sessions.json"), data.to_string()).unwrap();
    let mut seen = 0;
    let mut cursor: Option<String> = None;
    let mut pages = 0;
    loop {
        let args = match &cursor {
            Some(c) => json!({"cursor": c}),
            None => json!({}),
        };
        let (is_error, body, text) = call(&dir, "list_devices", args);
        assert!(!is_error);
        assert!(text.len() <= 16 * 1024);
        assert!(!text.contains("SECRET"));
        seen += body["devices"].as_array().unwrap().len();
        pages += 1;
        match body["nextCursor"].as_str() {
            Some(c) => cursor = Some(c.to_string()),
            None => break,
        }
    }
    assert_eq!(seen, 700);
    assert!(pages > 5);
    std::fs::remove_dir_all(dir).ok();
}

#[test]
fn a_bad_cursor_says_start_again() {
    let dir = fixture_dir("devices-cursor");
    for bad in [
        "nope",
        "v1:00",
        "v1:5b226c6973745f646576696365",
        "v1:5b22676574",
        "",
    ] {
        let (is_error, body, _) = call(&dir, "list_devices", json!({"cursor": bad}));
        assert!(is_error, "{bad}");
        assert!(body["error"]
            .as_str()
            .unwrap()
            .contains("Start again without a cursor"));
    }
    // A cursor past the end.
    let far = "v1:".to_string()
        + &json!(["list_devices", null, 999])
            .to_string()
            .bytes()
            .map(|b| format!("{b:02x}"))
            .collect::<String>();
    let (is_error, _, _) = call(&dir, "list_devices", json!({"cursor": far}));
    assert!(is_error);
    // Wrong argument type is a protocol error.
    assert_eq!(
        call_error_code(&dir, "list_devices", json!({"cursor": 5})),
        -32602
    );
    std::fs::remove_dir_all(dir).ok();
}
