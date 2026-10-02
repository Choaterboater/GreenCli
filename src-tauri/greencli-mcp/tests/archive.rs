// Config history, configs and diffs come from hidden copies only, and fail
// closed when a copy is missing, out of date or not this snapshot's.

mod common;

use common::*;
use greencli_mcp::HIDDEN_COPY_FILTER as F;
use serde_json::{json, Value};

const RAW: &str = "hostname sw1\nradius-server key RAW-SECRET-1\n";
const HIDDEN: &str = "hostname sw1\nradius-server key <hidden>\n";

fn fixture(tag: &str) -> std::path::PathBuf {
    let dir = temp_dir(tag);
    let mut golden = snap(
        200,
        &format!("{RAW}vlan 10\n"),
        Some((&format!("{HIDDEN}vlan 10\n"), Some(F))),
    );
    golden.golden = true;
    write_archive(
        &dir,
        "sw1",
        &[
            snap(
                300,
                &format!("{RAW}vlan 10\nvlan 20\n"),
                Some((&format!("{HIDDEN}vlan 10\nvlan 20\n"), Some(F))),
            ),
            golden,
            snap(100, RAW, None),
        ],
    );
    // An old filter's copy, and a copy with no filter at all.
    write_archive(
        &dir,
        "sw2",
        &[snap(50, RAW, Some(("STALE-COPY-TEXT", Some(0))))],
    );
    write_archive(
        &dir,
        "sw3",
        &[snap(60, RAW, Some(("NOFILTER-COPY-TEXT", None)))],
    );
    dir
}

fn error_text(body: &Value) -> &str {
    body["error"].as_str().unwrap()
}

#[test]
fn history_marks_which_snapshots_can_be_read() {
    let dir = fixture("history");
    let (is_error, body, text) = call(&dir, "list_config_history", json!({"device": "sw1"}));
    assert!(!is_error, "{text}");
    assert_eq!(body["total"], 3);
    let rows = body["snapshots"].as_array().unwrap();
    let flags: Vec<(u64, bool, bool)> = rows
        .iter()
        .map(|r| {
            (
                r["ts"].as_u64().unwrap(),
                r["golden"].as_bool().unwrap(),
                r["hasHiddenCopy"].as_bool().unwrap(),
            )
        })
        .collect();
    assert_eq!(
        flags,
        [(300, false, true), (200, true, true), (100, false, false)]
    );
    let (_, body, _) = call(&dir, "list_config_history", json!({"device": "sw2"}));
    assert_eq!(body["snapshots"][0]["hasHiddenCopy"], false);
    let (is_error, body, _) = call(&dir, "list_config_history", json!({"device": "nope"}));
    assert!(is_error);
    assert!(error_text(&body).contains("no config history"));
    assert_eq!(
        call_error_code(&dir, "list_config_history", json!({})),
        -32602
    );
    std::fs::remove_dir_all(dir).ok();
}

#[test]
fn get_config_serves_the_hidden_copy() {
    let dir = fixture("get");
    let (is_error, body, text) = call(&dir, "get_config", json!({"device": "sw1"}));
    assert!(!is_error, "{text}");
    assert_eq!(body["ts"], 300);
    assert_eq!(body["text"], format!("{HIDDEN}vlan 10\nvlan 20\n"));
    assert_eq!(body["totalLines"], 4);
    assert_eq!(body["fromLine"], 1);
    assert_eq!(body["toLine"], 4);
    assert_eq!(body["nextCursor"], Value::Null);
    assert!(!text.contains("RAW-SECRET"));
    let (_, body, _) = call(&dir, "get_config", json!({"device": "sw1", "ts": 200}));
    assert_eq!(body["golden"], true);
    std::fs::remove_dir_all(dir).ok();
}

#[test]
fn a_missing_copy_is_refused_and_the_raw_config_never_shows() {
    let dir = fixture("missing");
    let (is_error, body, text) = call(&dir, "get_config", json!({"device": "sw1", "ts": 100}));
    assert!(is_error);
    assert!(
        error_text(&body).starts_with("No hidden copy for this snapshot."),
        "{text}"
    );
    assert!(error_text(&body).contains("Make hidden copies"));
    assert!(!text.contains("RAW-SECRET"));
    // A ts that isn't in the index.
    let (is_error, body, _) = call(&dir, "get_config", json!({"device": "sw1", "ts": 101}));
    assert!(is_error);
    assert!(error_text(&body).contains("no snapshot with that ts"));
    std::fs::remove_dir_all(dir).ok();
}

#[test]
fn an_out_of_date_copy_is_refused() {
    let dir = fixture("stale");
    for device in ["sw2", "sw3"] {
        let (is_error, body, text) = call(&dir, "get_config", json!({"device": device}));
        assert!(is_error, "{device}");
        assert!(error_text(&body).contains("out of date"), "{text}");
        assert!(
            !text.contains("COPY-TEXT") && !text.contains("RAW-SECRET"),
            "{text}"
        );
    }
    let (is_error, _, text) = call(&dir, "list_config_history", json!({"device": "sw3"}));
    assert!(!is_error);
    assert!(!text.contains("COPY-TEXT"));
    std::fs::remove_dir_all(dir).ok();
}

#[test]
fn a_copy_of_another_snapshot_is_refused() {
    let dir = fixture("swap");
    // Put sw1's ts 300 copy where ts 200's belongs.
    let folder = dir.join("config_archive").join(dir_for("sw1"));
    std::fs::copy(
        folder.join("300.hidden.json"),
        folder.join("200.hidden.json"),
    )
    .unwrap();
    let (is_error, body, _) = call(&dir, "get_config", json!({"device": "sw1", "ts": 200}));
    assert!(is_error);
    assert!(error_text(&body).contains("couldn't be read"));
    // A copy that is not JSON.
    std::fs::write(folder.join("300.hidden.json"), "RAW-SECRET-1").unwrap();
    let (is_error, _, text) = call(&dir, "get_config", json!({"device": "sw1"}));
    assert!(is_error);
    assert!(!text.contains("RAW-SECRET"));
    std::fs::remove_dir_all(dir).ok();
}

#[test]
fn diffs_compare_hidden_copies() {
    let dir = fixture("diff");
    let (is_error, body, text) = call(&dir, "get_config_diff", json!({"device": "sw1"}));
    assert!(!is_error, "{text}");
    assert_eq!(body["from"]["ts"], 200);
    assert_eq!(body["to"]["ts"], 300);
    assert_eq!(body["same"], false);
    let diff = body["diff"].as_str().unwrap();
    assert!(diff.starts_with("--- 200\n+++ 300\n"), "{diff}");
    assert!(diff.contains("+vlan 20\n"), "{diff}");
    assert!(!text.contains("RAW-SECRET"));

    for from in [json!("golden"), json!("200"), json!(200)] {
        let (is_error, body, _) = call(
            &dir,
            "get_config_diff",
            json!({"device": "sw1", "from": from}),
        );
        assert!(!is_error);
        assert_eq!(body["from"]["ts"], 200);
    }
    let (_, body, _) = call(
        &dir,
        "get_config_diff",
        json!({"device": "sw1", "from": 300, "to": 300}),
    );
    assert_eq!(body["same"], true);
    assert_eq!(body["diff"], "");

    // The snapshot before 200 has no hidden copy.
    let (is_error, body, text) = call(&dir, "get_config_diff", json!({"device": "sw1", "to": 200}));
    assert!(is_error);
    assert!(error_text(&body).starts_with("No hidden copy"));
    assert!(!text.contains("RAW-SECRET"));
    // Nothing before the oldest.
    let (is_error, body, _) = call(&dir, "get_config_diff", json!({"device": "sw1", "to": 100}));
    assert!(is_error);
    assert!(error_text(&body).contains("no earlier one"));
    // No golden.
    let (is_error, body, _) = call(
        &dir,
        "get_config_diff",
        json!({"device": "sw2", "from": "golden"}),
    );
    assert!(is_error);
    assert!(error_text(&body).contains("no golden"));
    assert_eq!(
        call_error_code(
            &dir,
            "get_config_diff",
            json!({"device": "sw1", "from": "latest"})
        ),
        -32602
    );
    assert_eq!(
        call_error_code(
            &dir,
            "get_config_diff",
            json!({"device": "sw1", "to": "300"})
        ),
        -32602
    );
    std::fs::remove_dir_all(dir).ok();
}

fn page_through(dir: &std::path::Path, tool: &str, args: Value, field: &str) -> (String, usize) {
    let mut joined = String::new();
    let mut pages = 0;
    let mut cursor: Option<String> = None;
    loop {
        let mut a = args.clone();
        if let Some(c) = &cursor {
            a["cursor"] = json!(c);
        }
        let (is_error, body, text) = call(dir, tool, a);
        assert!(!is_error, "{text}");
        assert!(text.len() <= 16 * 1024);
        joined.push_str(body[field].as_str().unwrap());
        pages += 1;
        match body["nextCursor"].as_str() {
            Some(c) => cursor = Some(c.to_string()),
            None => return (joined, pages),
        }
    }
}

#[test]
fn long_configs_and_diffs_come_in_pages() {
    let dir = temp_dir("pages");
    let old: String = (0..3000)
        .map(|i| format!("interface 1/1/{i}\n  description \"port {i}\"\n"))
        .collect();
    let mut new = old
        .replace("port 7", "uplink 7")
        .replace("port 2999", "core");
    new.push_str(&format!("banner {}\n", "x".repeat(40_000)));
    write_archive(
        &dir,
        "big",
        &[
            snap(2, "raw", Some((&new, Some(F)))),
            snap(1, "raw", Some((&old, Some(F)))),
        ],
    );
    let (text, pages) = page_through(&dir, "get_config", json!({"device": "big"}), "text");
    assert_eq!(text, new);
    assert!(pages > 10);
    let (diff, pages) = page_through(&dir, "get_config_diff", json!({"device": "big"}), "diff");
    assert!(
        diff.contains("-  description \"port 7\"\n+  description \"uplink 7\"\n"),
        "{}",
        &diff[..500]
    );
    assert!(diff.contains("+banner xxx"));
    assert!(pages >= 3);
    std::fs::remove_dir_all(dir).ok();
}

#[test]
fn a_cursor_only_fits_its_own_request() {
    let dir = temp_dir("cursor");
    let big: String = (0..2000).map(|i| format!("line {i}\n")).collect();
    write_archive(
        &dir,
        "a",
        &[
            snap(2, "raw", Some((&big, Some(F)))),
            snap(1, "raw", Some(("x\n", Some(F)))),
        ],
    );
    write_archive(&dir, "b", &[snap(2, "raw", Some((&big, Some(F))))]);
    let (_, body, _) = call(&dir, "get_config", json!({"device": "a"}));
    let cursor = body["nextCursor"].as_str().unwrap().to_string();
    let starts_again = |body: &Value| error_text(body).contains("Start again without a cursor");
    let (is_error, body, _) = call(&dir, "get_config", json!({"device": "b", "cursor": cursor}));
    assert!(is_error && starts_again(&body));
    let (is_error, body, _) = call(
        &dir,
        "get_config",
        json!({"device": "a", "ts": 1, "cursor": cursor}),
    );
    assert!(is_error && starts_again(&body));
    let (is_error, body, _) = call(
        &dir,
        "get_config_diff",
        json!({"device": "a", "cursor": cursor}),
    );
    assert!(is_error && starts_again(&body));
    let (is_error, body, _) = call(
        &dir,
        "list_config_history",
        json!({"device": "a", "cursor": cursor}),
    );
    assert!(is_error && starts_again(&body));
    let (is_error, body, _) = call(
        &dir,
        "get_config",
        json!({"device": "a", "cursor": "v1:zz"}),
    );
    assert!(is_error && starts_again(&body));
    // The right request with it works.
    let (is_error, _, _) = call(
        &dir,
        "get_config",
        json!({"device": "a", "ts": 2, "cursor": cursor}),
    );
    assert!(!is_error);
    std::fs::remove_dir_all(dir).ok();
}

#[test]
fn a_corrupt_index_is_an_error_and_left_alone() {
    let dir = temp_dir("corrupt");
    let root = dir.join("config_archive");
    std::fs::create_dir_all(&root).unwrap();
    std::fs::write(root.join("index.json"), "{\"devices\": {").unwrap();
    let (is_error, body, _) = call(&dir, "list_config_history", json!({"device": "sw1"}));
    assert!(is_error);
    assert!(error_text(&body).contains("index couldn't be read"));
    let names: Vec<_> = std::fs::read_dir(&root)
        .unwrap()
        .map(|e| e.unwrap().file_name())
        .collect();
    assert_eq!(names, ["index.json"]);
    std::fs::remove_dir_all(dir).ok();
}

#[test]
fn dir_for_matches_the_app() {
    let vectors: Value = serde_json::from_str(include_str!("../testdata/dir_for.json")).unwrap();
    for v in vectors.as_array().unwrap() {
        assert_eq!(
            dir_for(v["device"].as_str().unwrap()),
            v["dir"].as_str().unwrap()
        );
    }
}
