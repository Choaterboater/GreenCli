// Live show commands: list_connected_devices and device_show ask the running
// GreenCLI over <data dir>/mcp-live.sock. A fake GreenCLI here answers one
// JSON line per call, the way the app does.

mod common;

use common::*;
use serde_json::json;

#[test]
fn the_wait_is_shorter_than_casper_gives_a_call() {
    // Casper gives up on an MCP call after 90 s (MCP_LIMITS.callMs). The
    // binary must give up first, so a late Yes never types into a tab with
    // no one waiting for the answer.
    assert!(greencli_mcp::LIVE_WAIT < std::time::Duration::from_secs(90));
    assert!(greencli_mcp::LIVE_WAIT >= std::time::Duration::from_secs(30));
    assert_eq!(greencli_mcp::MAX_LIVE_REQUEST, 4 * 1024);
    // The tools wait a little longer than GreenCLI, so GreenCLI's own answer arrives first.
    assert!(
        greencli_mcp::LIVE_CLIENT_WAIT
            >= greencli_mcp::LIVE_WAIT + std::time::Duration::from_secs(2)
    );
    assert!(greencli_mcp::LIVE_CLIENT_WAIT < std::time::Duration::from_secs(90));
}

#[cfg(not(unix))]
#[test]
fn windows_says_not_yet() {
    let dir = temp_dir("live-win");
    for (tool, args) in [
        ("list_connected_devices", json!({})),
        (
            "device_show",
            json!({"device": "sw1", "show": "show version"}),
        ),
    ] {
        let (is_error, body, _) = call(&dir, tool, args);
        assert!(is_error, "{tool}");
        assert_eq!(body["error"], "Live show commands aren't on Windows yet.");
    }
    std::fs::remove_dir_all(dir).ok();
}

#[cfg(unix)]
mod unix {
    use super::*;
    use serde_json::Value;
    use std::io::{BufRead, BufReader, Write};
    use std::os::unix::net::UnixListener;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicU32, Ordering};
    use std::thread::JoinHandle;
    use std::time::Duration;

    /// A short folder: a Unix listener path must stay under about 104 bytes.
    fn short_dir() -> PathBuf {
        static N: AtomicU32 = AtomicU32::new(0);
        let dir = PathBuf::from(format!(
            "/tmp/gm-{}-{}",
            std::process::id(),
            N.fetch_add(1, Ordering::SeqCst)
        ));
        std::fs::remove_dir_all(&dir).ok();
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// A fake GreenCLI: takes one call, answers with `reply` (None: hangs
    /// up), and returns the request line it got.
    fn fake(dir: &Path, reply: Option<String>) -> JoinHandle<String> {
        let listener = UnixListener::bind(dir.join("mcp-live.sock")).unwrap();
        std::thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            let mut line = String::new();
            reader.read_line(&mut line).unwrap();
            if let Some(reply) = reply {
                let mut w = stream;
                w.write_all(reply.as_bytes()).unwrap();
                w.write_all(b"\n").unwrap();
            }
            line
        })
    }

    #[test]
    fn lists_connected_devices_with_three_fields_only() {
        let dir = short_dir();
        let got = fake(
            &dir,
            Some(
                json!({"ok": true, "devices": [
                    {"tabId": "t1", "name": "sw1", "type": "aruba-cx", "host": "hidden", "password": "x"},
                    {"tabId": "t2", "name": "edge", "type": "junos"},
                ]})
                .to_string(),
            ),
        );
        let (is_error, body, text) = call(&dir, "list_connected_devices", json!({}));
        assert!(!is_error, "{text}");
        assert_eq!(
            body,
            json!({"devices": [
                {"tabId": "t1", "name": "sw1", "type": "aruba-cx"},
                {"tabId": "t2", "name": "edge", "type": "junos"},
            ]})
        );
        let request: Value = serde_json::from_str(&got.join().unwrap()).unwrap();
        assert_eq!(request, json!({"v": 1, "op": "sessions"}));
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn device_show_returns_the_output_as_data() {
        let dir = short_dir();
        let got = fake(
            &dir,
            Some(
                json!({"ok": true, "output": "VLAN 1 up\nconf t\n", "truncated": false})
                    .to_string(),
            ),
        );
        let (is_error, body, text) = call(
            &dir,
            "device_show",
            json!({"device": "sw1", "show": "show vlan | include up"}),
        );
        assert!(!is_error, "{text}");
        assert_eq!(body["output"], "VLAN 1 up\nconf t\n");
        assert_eq!(body["truncated"], false);
        assert_eq!(body["show"], "show vlan | include up");
        assert_eq!(body["device"], "sw1");
        let request: Value = serde_json::from_str(&got.join().unwrap()).unwrap();
        assert_eq!(
            request,
            json!({"v": 1, "op": "show", "device": "sw1", "show": "show vlan | include up"})
        );
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn device_show_by_tab() {
        let dir = short_dir();
        let got = fake(
            &dir,
            Some(json!({"ok": true, "output": "ok", "truncated": true}).to_string()),
        );
        let (is_error, body, text) = call(
            &dir,
            "device_show",
            json!({"tab": "t2", "show": "show version"}),
        );
        assert!(!is_error, "{text}");
        assert_eq!(body["tab"], "t2");
        assert_eq!(body["truncated"], true);
        let request: Value = serde_json::from_str(&got.join().unwrap()).unwrap();
        assert_eq!(
            request,
            json!({"v": 1, "op": "show", "tab": "t2", "show": "show version"})
        );
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn a_long_output_is_cut_to_fit_one_answer() {
        let dir = short_dir();
        let long = "line \"quoted\"\n".repeat(4000);
        let _got = fake(
            &dir,
            Some(json!({"ok": true, "output": long, "truncated": false}).to_string()),
        );
        let (is_error, body, text) = call(
            &dir,
            "device_show",
            json!({"device": "sw1", "show": "show tech"}),
        );
        assert!(!is_error, "{text}");
        assert_eq!(body["truncated"], true);
        assert!(text.len() <= 16 * 1024);
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn greencli_refusals_come_back_as_errors() {
        let dir = short_dir();
        let _got = fake(
            &dir,
            Some(json!({"ok": false, "error": "You said No."}).to_string()),
        );
        let (is_error, body, _) = call(
            &dir,
            "device_show",
            json!({"device": "sw1", "show": "show version"}),
        );
        assert!(is_error);
        assert_eq!(body["error"], "You said No.");
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn greencli_not_open_fails_closed() {
        let dir = short_dir();
        for (tool, args) in [
            ("list_connected_devices", json!({})),
            (
                "device_show",
                json!({"device": "sw1", "show": "show version"}),
            ),
        ] {
            let (is_error, body, _) = call(&dir, tool, args);
            assert!(is_error, "{tool}");
            let error = body["error"].as_str().unwrap();
            assert!(error.starts_with("GreenCLI isn't open"), "{error}");
        }
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn bad_or_missing_answers_fail_closed() {
        for reply in [
            None,
            Some("not json".to_string()),
            Some(json!({"ok": true}).to_string()),
            Some(json!({"ok": true, "output": 5}).to_string()),
            Some(json!({"devices": []}).to_string()),
            Some("x".repeat(300 * 1024)),
        ] {
            let dir = short_dir();
            let _got = fake(&dir, reply.clone());
            let (is_error, body, _) = call(
                &dir,
                "device_show",
                json!({"device": "sw1", "show": "show version"}),
            );
            assert!(is_error, "{reply:?}");
            assert!(body["error"].is_string(), "{reply:?}");
            std::fs::remove_dir_all(dir).ok();
        }
    }

    #[test]
    fn a_line_that_is_not_plain_show_is_refused_before_asking() {
        // No fake GreenCLI: the binary must refuse without connecting.
        let dir = short_dir();
        for show in [
            "configure terminal",
            "show run | tail /etc/passwd",
            "show x\nreload",
            "do show vlan",
            "",
        ] {
            let (is_error, body, _) =
                call(&dir, "device_show", json!({"device": "sw1", "show": show}));
            assert!(is_error, "{show:?}");
            let error = body["error"].as_str().unwrap();
            assert!(error.contains("plain show"), "{error}");
        }
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn device_show_needs_exactly_one_of_tab_or_device() {
        let dir = short_dir();
        assert_eq!(
            call_error_code(&dir, "device_show", json!({"show": "show version"})),
            -32602
        );
        assert_eq!(
            call_error_code(
                &dir,
                "device_show",
                json!({"tab": "t1", "device": "sw1", "show": "show version"})
            ),
            -32602
        );
        assert_eq!(
            call_error_code(&dir, "device_show", json!({"device": "sw1"})),
            -32602
        );
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn a_request_over_4_kb_is_refused() {
        let dir = short_dir();
        let (is_error, body, _) = call(
            &dir,
            "device_show",
            json!({"device": "d".repeat(5000), "show": "show version"}),
        );
        assert!(is_error);
        assert_eq!(body["error"], "The request is too long.");
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn the_wait_is_honoured() {
        let dir = short_dir();
        let listener = UnixListener::bind(dir.join("mcp-live.sock")).unwrap();
        let hold = std::thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            std::thread::sleep(Duration::from_millis(1500));
            drop(stream);
        });
        let started = std::time::Instant::now();
        let answer = greencli_mcp::ask_live_with_wait(
            &dir,
            &json!({"v": 1, "op": "sessions"}),
            Duration::from_millis(200),
        );
        assert!(started.elapsed() < Duration::from_millis(1200));
        let error = answer.unwrap_err();
        assert!(error.contains("didn't answer"), "{error}");
        // By then GreenCLI's box has closed, so only a running line can be late:
        // never send the AI back to a box, and never promise nothing ran.
        assert!(!error.contains("box"), "{error}");
        assert!(error.contains("may have run"), "{error}");
        hold.join().unwrap();
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn a_folder_path_too_long_is_said_plainly() {
        let dir = short_dir();
        let deep = dir.join("x".repeat(120));
        std::fs::create_dir_all(&deep).unwrap();
        let (is_error, body, _) = call(&deep, "list_connected_devices", json!({}));
        assert!(is_error);
        let error = body["error"].as_str().unwrap();
        assert!(error.contains("too long"), "{error}");
        std::fs::remove_dir_all(dir).ok();
    }
}
