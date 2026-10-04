// A whole session against a data folder full of secrets: every tool, every
// page, and the error paths. No secret may appear in any answer, every
// answer stays under 16 KiB, and no file is created, changed or touched.

mod common;

use common::*;
use greencli_mcp::HIDDEN_COPY_FILTER as F;
use serde_json::{json, Value};
use std::collections::hash_map::DefaultHasher;
use std::collections::BTreeMap;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::time::SystemTime;

/// Text that must never leave the server.
const SECRETS: &[&str] = &[
    "SECRET",
    "hunter2",
    "sk-ant-api03",
    "RAW-CONFIG-PASSWORD",
    "STALE-COPY-PASSWORD",
    "NOFILTER-COPY-PASSWORD",
];

fn build_data_folder() -> PathBuf {
    let dir = temp_dir("session");
    let fixture = manifest_dir().join("testdata/fixture");
    std::fs::copy(fixture.join("sessions.json"), dir.join("sessions.json")).unwrap();
    std::fs::copy(fixture.join("intents.json"), dir.join("intents.json")).unwrap();
    std::fs::write(
        dir.join("ai_keys.json"),
        r#"{"anthropic":"sk-ant-api03-SECRET-AI-KEY"}"#,
    )
    .unwrap();
    std::fs::write(
        dir.join("mcp_creds.json"),
        r#"{"central":"client_secret: SECRET-MCP-CREDS"}"#,
    )
    .unwrap();
    std::fs::create_dir_all(dir.join("mcp_creds")).unwrap();
    std::fs::write(
        dir.join("mcp_creds/central-0123456789abcdef"),
        "SECRET-MCP-CREDS-FILE",
    )
    .unwrap();
    std::fs::write(dir.join("secret_store.json"), r#"{"store":"os","since":1}"#).unwrap();
    std::fs::write(dir.join("vault.enc"), "SECRET-VAULT-BYTES").unwrap();
    std::fs::write(
        dir.join("mcp_servers.json"),
        r#"[{"name":"x","env":{"TOKEN":"SECRET-ENV"}}]"#,
    )
    .unwrap();

    let raw = |n: usize| -> String {
        let mut s =
            format!("hostname sw-core-01\nuser admin password plaintext RAW-CONFIG-PASSWORD-{n}\n");
        for i in 0..800 {
            s.push_str(&format!(
                "interface 1/1/{i}\n  description \"link {i} rev {n}\"\n"
            ));
        }
        s
    };
    let hidden = |n: usize| raw(n).replace(&format!("RAW-CONFIG-PASSWORD-{n}"), "<hidden>");
    let mut golden = snap(400, &raw(2), Some((&hidden(2), Some(F))));
    golden.golden = true;
    write_archive(
        &dir,
        "sw-core-01",
        &[
            snap(500, &raw(3), Some((&hidden(3), Some(F)))),
            golden,
            snap(300, &raw(1), None),
            snap(200, &raw(0), Some(("STALE-COPY-PASSWORD", Some(0)))),
            snap(100, &raw(0), Some(("NOFILTER-COPY-PASSWORD", None))),
        ],
    );
    write_archive(
        &dir,
        "10.0.0.2",
        &[snap(50, "RAW-CONFIG-PASSWORD-x\n", None)],
    );
    dir
}

/// Every file and folder under `dir`: (size, modified time, content hash).
fn tree(dir: &Path) -> BTreeMap<PathBuf, (u64, SystemTime, u64)> {
    let mut out = BTreeMap::new();
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        for entry in std::fs::read_dir(&d).unwrap() {
            let path = entry.unwrap().path();
            let meta = std::fs::symlink_metadata(&path).unwrap();
            let mut h = DefaultHasher::new();
            if meta.is_dir() {
                stack.push(path.clone());
            } else {
                std::fs::read(&path).unwrap().hash(&mut h);
            }
            out.insert(path, (meta.len(), meta.modified().unwrap(), h.finish()));
        }
    }
    let meta = std::fs::metadata(dir).unwrap();
    out.insert(dir.to_path_buf(), (meta.len(), meta.modified().unwrap(), 0));
    out
}

struct Session {
    dir: PathBuf,
    answers: usize,
}

impl Session {
    /// Send one request; check the raw line for secrets and size.
    fn ask(&mut self, method: &str, params: Value) -> Value {
        let line =
            json!({"jsonrpc": "2.0", "id": self.answers, "method": method, "params": params});
        let out = run_raw(&self.dir, &format!("{line}\n"));
        assert_eq!(out.len(), 1, "one answer per request");
        for secret in SECRETS {
            assert!(!out[0].contains(secret), "{secret} leaked: {}", out[0]);
        }
        self.answers += 1;
        serde_json::from_str(&out[0]).unwrap()
    }

    /// Call a tool; returns (isError, body).
    fn tool(&mut self, name: &str, args: Value) -> (bool, Value) {
        let answer = self.ask("tools/call", json!({"name": name, "arguments": args}));
        let result = &answer["result"];
        let text = result["content"][0]["text"].as_str().unwrap();
        assert!(text.len() <= 16 * 1024, "{name}: {} bytes", text.len());
        (
            result["isError"] == json!(true),
            serde_json::from_str(text).unwrap(),
        )
    }

    /// Every page of a tool; returns how many pages.
    fn all_pages(&mut self, name: &str, args: Value) -> usize {
        let mut pages = 0;
        let mut cursor: Option<String> = None;
        loop {
            let mut a = args.clone();
            if let Some(c) = &cursor {
                a["cursor"] = json!(c);
            }
            let (is_error, body) = self.tool(name, a);
            assert!(!is_error, "{name}: {body}");
            pages += 1;
            match body["nextCursor"].as_str() {
                Some(c) => cursor = Some(c.to_string()),
                None => return pages,
            }
        }
    }
}

#[test]
fn a_whole_session_leaks_nothing_and_changes_nothing() {
    let dir = build_data_folder();
    let before = tree(&dir);
    let mut s = Session {
        dir: dir.clone(),
        answers: 0,
    };

    s.ask(
        "initialize",
        json!({"protocolVersion": "2025-06-18", "capabilities": {}}),
    );
    let tools = s.ask("tools/list", json!({}));
    let names: Vec<String> = tools["result"]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["name"].as_str().unwrap().to_string())
        .collect();
    assert_eq!(
        names,
        [
            "access_check",
            "list_devices",
            "list_archive_devices",
            "list_config_history",
            "get_config",
            "get_config_diff",
            "list_intents",
            "list_connected_devices",
            "device_show"
        ]
    );

    assert_eq!(s.all_pages("access_check", json!({})), 1);
    assert_eq!(s.all_pages("list_devices", json!({})), 1);
    assert_eq!(s.all_pages("list_archive_devices", json!({})), 1);
    assert_eq!(s.all_pages("list_intents", json!({})), 1);
    for device in ["sw-core-01", "10.0.0.2"] {
        s.all_pages("list_config_history", json!({"device": device}));
    }
    assert!(s.all_pages("get_config", json!({"device": "sw-core-01"})) > 2);
    assert!(s.all_pages("get_config", json!({"device": "sw-core-01", "ts": 400})) > 2);
    s.all_pages("get_config_diff", json!({"device": "sw-core-01"}));
    s.all_pages(
        "get_config_diff",
        json!({"device": "sw-core-01", "from": "golden"}),
    );

    // The error paths: a missing copy, a stale copy, a copy with no filter,
    // a diff that needs one of those, an unknown device, a bad cursor.
    let errors = [
        (
            "get_config",
            json!({"device": "sw-core-01", "ts": 300}),
            "No hidden copy",
        ),
        (
            "get_config",
            json!({"device": "sw-core-01", "ts": 200}),
            "out of date",
        ),
        (
            "get_config",
            json!({"device": "sw-core-01", "ts": 100}),
            "out of date",
        ),
        (
            "get_config",
            json!({"device": "10.0.0.2"}),
            "No hidden copy",
        ),
        (
            "get_config_diff",
            json!({"device": "sw-core-01", "to": 400}),
            "No hidden copy",
        ),
        (
            "get_config_diff",
            json!({"device": "sw-core-01", "from": 200}),
            "out of date",
        ),
        ("get_config", json!({"device": "nope"}), "no config history"),
        (
            "list_devices",
            json!({"cursor": "v1:7b7d"}),
            "Start again without a cursor",
        ),
        (
            "list_archive_devices",
            json!({"cursor": "v1:7b7d"}),
            "Start again without a cursor",
        ),
        (
            "get_config",
            json!({"device": "sw-core-01", "cursor": "abc"}),
            "Start again without a cursor",
        ),
    ];
    for (tool, args, want) in errors {
        let (is_error, body) = s.tool(tool, args.clone());
        assert!(is_error, "{tool} {args}");
        assert!(
            body["error"].as_str().unwrap().contains(want),
            "{tool} {args}: {body}"
        );
    }
    // Asking for the secret files by name gets nothing.
    for device in [
        "../ai_keys",
        "../../mcp_creds",
        "vault.enc",
        "../secret_store",
    ] {
        let (is_error, _) = s.tool("get_config", json!({"device": device}));
        assert!(is_error);
    }
    // With GreenCLI not open, the live tools fail closed and touch nothing.
    for (tool, args) in [
        ("list_connected_devices", json!({})),
        (
            "device_show",
            json!({"device": "sw-core-01", "show": "show version"}),
        ),
    ] {
        let (is_error, _) = s.tool(tool, args);
        assert!(is_error, "{tool}");
    }
    s.ask("ping", json!({}));

    assert!(s.answers > 20);
    assert_eq!(tree(&dir), before, "the server changed the data folder");
    std::fs::remove_dir_all(dir).ok();
}
