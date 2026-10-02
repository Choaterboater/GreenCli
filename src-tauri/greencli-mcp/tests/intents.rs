// list_intents serves names and results, never commands, matchers or details.

mod common;

use common::*;
use serde_json::{json, Value};

#[test]
fn lists_intents_without_commands_matchers_or_details() {
    let dir = temp_dir("intents");
    std::fs::copy(
        manifest_dir().join("testdata/fixture/intents.json"),
        dir.join("intents.json"),
    )
    .unwrap();
    let (is_error, body, text) = call(&dir, "list_intents", json!({}));
    assert!(!is_error, "{text}");
    assert!(!text.contains("SECRET"), "{text}");
    assert!(!text.contains("hunter2"), "{text}");
    assert_eq!(body["total"], 2);
    assert_eq!(
        body["intents"][0],
        json!({
            "id": "i1", "name": "NTP is set", "kind": "config-contains", "severity": "warning",
            "lastResult": {"status": "fail", "at": 1700000000000u64},
            "devices": [{"device": "sw-core-01", "status": "pass"}, {"device": "sw-core-02", "status": "fail"}]
        })
    );
    assert_eq!(body["intents"][1]["lastResult"], Value::Null);
    std::fs::remove_dir_all(dir).ok();
}

#[test]
fn no_file_is_an_empty_list_and_a_corrupt_one_an_error() {
    let dir = temp_dir("intents-none");
    let (is_error, body, _) = call(&dir, "list_intents", json!({}));
    assert!(!is_error);
    assert_eq!(body["total"], 0);
    std::fs::write(dir.join("intents.json"), "[{").unwrap();
    let (is_error, body, _) = call(&dir, "list_intents", json!({}));
    assert!(is_error);
    assert!(body["error"].as_str().unwrap().contains("couldn't be read"));
    let names: Vec<_> = std::fs::read_dir(&dir)
        .unwrap()
        .map(|e| e.unwrap().file_name())
        .collect();
    assert_eq!(names, ["intents.json"]);
    std::fs::remove_dir_all(dir).ok();
}

#[test]
fn many_intents_and_devices_page_under_the_cap() {
    let dir = temp_dir("intents-many");
    let per_device: Vec<Value> = (0..400)
        .map(|i| json!({"device": format!("{}-{i}", "d".repeat(100)), "status": "pass", "detail": "SECRET"}))
        .collect();
    let intents: Vec<Value> = (0..60)
        .map(|i| {
            json!({"id": format!("i{i}"), "name": format!("intent {i}"), "kind": "config-contains",
                   "command": "SECRET", "matcher": {"kind": "contains", "value": "SECRET"},
                   "severity": "critical",
                   "lastResult": {"status": "pass", "detail": "SECRET", "at": 5, "perDevice": per_device}})
        })
        .collect();
    std::fs::write(dir.join("intents.json"), Value::Array(intents).to_string()).unwrap();
    let mut seen = 0;
    let mut cursor: Option<String> = None;
    loop {
        let args = cursor.as_ref().map_or(json!({}), |c| json!({"cursor": c}));
        let (is_error, body, text) = call(&dir, "list_intents", args);
        assert!(!is_error);
        assert!(!text.contains("SECRET"));
        for intent in body["intents"].as_array().unwrap() {
            assert_eq!(intent["devices"].as_array().unwrap().len(), 50);
            assert_eq!(intent["moreDevices"], 350);
            seen += 1;
        }
        match body["nextCursor"].as_str() {
            Some(c) => cursor = Some(c.to_string()),
            None => break,
        }
    }
    assert_eq!(seen, 60);
    std::fs::remove_dir_all(dir).ok();
}
