// Live show commands: list_connected_devices and device_show ask the running
// GreenCLI over <data dir>/mcp-live.sock (on Windows, over the named pipe that
// file names). A fake GreenCLI here answers one JSON line per call, the way
// the app does.

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

#[cfg(not(any(unix, windows)))]
#[test]
fn other_systems_say_not_here() {
    let dir = temp_dir("live-other");
    for (tool, args) in [
        ("list_connected_devices", json!({})),
        (
            "device_show",
            json!({"device": "sw1", "show": "show version"}),
        ),
    ] {
        let (is_error, body, _) = call(&dir, tool, args);
        assert!(is_error, "{tool}");
        assert_eq!(body["error"], "Live show commands aren't on this system.");
    }
    std::fs::remove_dir_all(dir).ok();
}

#[cfg(any(unix, windows))]
mod calls {
    use super::*;
    use serde_json::Value;
    use std::time::Duration;

    #[cfg(unix)]
    use unix::{fake, hold, short_dir};
    #[cfg(windows)]
    use windows::{fake, hold, short_dir};

    #[cfg(unix)]
    mod unix {
        use std::io::{BufRead, BufReader, Write};
        use std::os::unix::net::UnixListener;
        use std::path::{Path, PathBuf};
        use std::sync::atomic::{AtomicU32, Ordering};
        use std::thread::JoinHandle;
        use std::time::Duration;

        /// A short folder: a Unix listener path must stay under about 104 bytes.
        pub fn short_dir() -> PathBuf {
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
        pub fn fake(dir: &Path, reply: Option<String>) -> JoinHandle<String> {
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

        /// A GreenCLI that takes a call and says nothing for `wait`.
        pub fn hold(dir: &Path, wait: Duration) -> JoinHandle<()> {
            let listener = UnixListener::bind(dir.join("mcp-live.sock")).unwrap();
            std::thread::spawn(move || {
                let (stream, _) = listener.accept().unwrap();
                std::thread::sleep(wait);
                drop(stream);
            })
        }
    }

    #[cfg(windows)]
    pub mod windows {
        use std::path::{Path, PathBuf};
        use std::sync::atomic::{AtomicU32, Ordering};
        use std::thread::JoinHandle;
        use std::time::Duration;
        use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
        use tokio::net::windows::named_pipe::{NamedPipeServer, ServerOptions};
        use tokio::runtime::Runtime;

        pub fn short_dir() -> PathBuf {
            super::temp_dir("live")
        }

        /// A pipe name no other test uses.
        pub fn unique_name(prefix: &str) -> String {
            static N: AtomicU32 = AtomicU32::new(0);
            let nanos = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let n = u128::from(N.fetch_add(1, Ordering::SeqCst));
            let mix = nanos ^ (u128::from(std::process::id()) << 96) ^ (n << 64);
            format!("{prefix}{mix:032x}")
        }

        /// A pipe named `name`, made the way GreenCLI makes its own.
        pub fn pipe(name: &str) -> (Runtime, NamedPipeServer) {
            let rt = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap();
            let server = rt
                .block_on(async {
                    ServerOptions::new()
                        .first_pipe_instance(true)
                        .create(format!(r"\\.\pipe\{name}"))
                })
                .unwrap();
            (rt, server)
        }

        /// A secret the way GreenCLI writes it: 64 lowercase hex digits.
        pub fn secret() -> String {
            format!("{}{}", unique_name(""), unique_name(""))
        }

        /// The first line GreenCLI sends on each call: it proves the pipe is
        /// GreenCLI's.
        pub fn hello(secret: &str) -> String {
            format!("{{\"v\":1,\"greencli\":\"{secret}\"}}\n")
        }

        /// GreenCLI's pipe, and its name and secret written in
        /// <dir>/mcp-live.sock (one per line).
        pub fn listen(dir: &Path) -> (Runtime, NamedPipeServer, String) {
            let name = unique_name("greencli-live-");
            let secret = secret();
            std::fs::write(dir.join("mcp-live.sock"), format!("{name}\n{secret}")).unwrap();
            let (rt, server) = pipe(&name);
            (rt, server, secret)
        }

        /// A fake GreenCLI: takes one call, answers with `reply` (None: hangs
        /// up), and returns the request line it got.
        pub fn fake(dir: &Path, reply: Option<String>) -> JoinHandle<String> {
            let (rt, server, secret) = listen(dir);
            std::thread::spawn(move || {
                rt.block_on(async move {
                    let mut server = server;
                    server.connect().await.unwrap();
                    server.write_all(hello(&secret).as_bytes()).await.unwrap();
                    let mut reader = BufReader::new(server);
                    let mut line = String::new();
                    reader.read_line(&mut line).await.unwrap();
                    if let Some(reply) = reply {
                        let mut w = reader.into_inner();
                        w.write_all(reply.as_bytes()).await.unwrap();
                        w.write_all(b"\n").await.unwrap();
                        w.flush().await.unwrap();
                    }
                    line
                })
            })
        }

        /// A GreenCLI that takes a call and says nothing for `wait`.
        pub fn hold(dir: &Path, wait: Duration) -> JoinHandle<()> {
            let (rt, server, secret) = listen(dir);
            std::thread::spawn(move || {
                rt.block_on(async move {
                    let mut server = server;
                    server.connect().await.unwrap();
                    server.write_all(hello(&secret).as_bytes()).await.unwrap();
                    tokio::time::sleep(wait).await;
                    drop(server);
                })
            })
        }
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
        let hold = hold(&dir, Duration::from_millis(1500));
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

    #[cfg(unix)]
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

    /// The pipe name comes from a file, so it is checked: only GreenCLI's own
    /// kind of name on this computer, never a path or another computer.
    #[cfg(windows)]
    #[test]
    fn only_a_greencli_pipe_name_is_ever_opened() {
        let dir = short_dir();
        let other = windows::unique_name("not-greencli-");
        let (rt, server) = windows::pipe(&other);
        let hex = "0123456789abcdef0123456789abcdef";
        for text in [
            other.clone(),
            format!(r"\\.\pipe\{other}"),
            format!(r"\\far-away\pipe\greencli-live-{hex}"),
            format!("greencli-live-{}", &hex[1..]),
            format!("greencli-live-{hex}0"),
            format!("greencli-live-{}", hex.to_uppercase()),
            format!("greencli-live-{hex}\n"),
            format!(r"greencli-live-..\{}", &hex[3..]),
            String::new(),
        ] {
            std::fs::write(dir.join("mcp-live.sock"), &text).unwrap();
            let (is_error, body, _) = call(&dir, "list_connected_devices", json!({}));
            assert!(is_error, "{text:?}");
            let error = body["error"].as_str().unwrap();
            assert!(
                error.starts_with("GreenCLI isn't open"),
                "{text:?}: {error}"
            );
        }
        // The other pipe never got a call.
        let connected = rt.block_on(async {
            tokio::time::timeout(Duration::from_millis(200), server.connect()).await
        });
        assert!(
            connected.is_err(),
            "a pipe not named greencli-live-<hex> was opened"
        );
        std::fs::remove_dir_all(dir).ok();
    }

    /// The file holds the pipe's name and then GreenCLI's secret on a second
    /// line. Without a well-formed secret the pipe is never opened, so an
    /// older or broken file can't send a call to a pipe that can't prove
    /// itself.
    #[cfg(windows)]
    #[test]
    fn without_a_secret_the_pipe_is_never_opened() {
        let dir = short_dir();
        let name = windows::unique_name("greencli-live-");
        let (rt, server) = windows::pipe(&name);
        let secret = windows::secret();
        for text in [
            name.clone(),
            format!("{name}\n"),
            format!("{name}\n{}", &secret[1..]),
            format!("{name}\n{secret}0"),
            format!("{name}\n{}", secret.to_uppercase()),
            format!("{name}\n{secret}\n"),
            format!("{name}\r\n{secret}"),
            format!("{name}\n{secret}\nmore"),
            format!("{secret}\n{name}"),
        ] {
            std::fs::write(dir.join("mcp-live.sock"), &text).unwrap();
            let (is_error, body, _) = call(&dir, "list_connected_devices", json!({}));
            assert!(is_error, "{text:?}");
            let error = body["error"].as_str().unwrap();
            assert!(
                error.starts_with("GreenCLI isn't open"),
                "{text:?}: {error}"
            );
        }
        let connected = rt.block_on(async {
            tokio::time::timeout(Duration::from_millis(200), server.connect()).await
        });
        assert!(connected.is_err(), "the pipe was opened without a secret");
        std::fs::remove_dir_all(dir).ok();
    }

    /// GreenCLI crashed, and someone else made a pipe under the name its file
    /// still holds. That pipe doesn't know the secret: it must get no bytes of
    /// the request, and the AI gets the plain "isn't open".
    #[cfg(windows)]
    #[test]
    fn a_pipe_that_does_not_know_the_secret_gets_no_request() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let ok = json!({"ok": true, "devices": []}).to_string();
        let firsts: Vec<Option<Vec<u8>>> = vec![
            // Says nothing at all.
            None,
            // Answers at once, as if it were GreenCLI.
            Some(format!("{ok}\n").into_bytes()),
            // A first line with another secret.
            Some(windows::hello(&windows::secret()).into_bytes()),
            // The right shape, nearly: no line break.
            Some(
                windows::hello(&windows::secret())
                    .trim_end()
                    .as_bytes()
                    .to_vec(),
            ),
            // Far too much, and no line break.
            Some(vec![b'x'; 60_000]),
        ];
        for first in firsts {
            let dir = short_dir();
            let (rt, server, _secret) = windows::listen(&dir);
            let (done_tx, done_rx) = std::sync::mpsc::channel::<()>();
            let label = format!("{:?}", first.as_ref().map(|f| f.len()));
            let squatter = std::thread::spawn(move || {
                rt.block_on(async move {
                    let mut server = server;
                    // A client that already left may never show as connected.
                    let _ = tokio::time::timeout(Duration::from_secs(3), server.connect()).await;
                    if let Some(first) = first {
                        // May fail once the client hangs up.
                        let _ = server.write_all(&first).await;
                        let _ = server.flush().await;
                    }
                    // Whatever the client sent until it gave up.
                    let mut got = Vec::new();
                    let mut buf = [0u8; 4096];
                    let _ = done_rx.recv();
                    while let Ok(Ok(n)) =
                        tokio::time::timeout(Duration::from_millis(300), server.read(&mut buf))
                            .await
                    {
                        if n == 0 {
                            break;
                        }
                        got.extend_from_slice(&buf[..n]);
                    }
                    got
                })
            });
            let started = std::time::Instant::now();
            let answer = greencli_mcp::ask_live_with_wait(
                &dir,
                &json!({"v": 1, "op": "sessions"}),
                Duration::from_secs(1),
            );
            assert!(started.elapsed() < Duration::from_secs(3), "{label}");
            done_tx.send(()).unwrap();
            let error = answer.unwrap_err();
            assert!(error.starts_with("GreenCLI isn't open"), "{label}: {error}");
            let got = squatter.join().unwrap();
            assert!(
                got.is_empty(),
                "{label}: the pipe got {:?}",
                String::from_utf8_lossy(&got)
            );
            std::fs::remove_dir_all(dir).ok();
        }
    }

    /// GreenCLI quit without cleaning up: the file names a pipe that's gone.
    #[cfg(windows)]
    #[test]
    fn a_pipe_that_is_gone_means_greencli_is_not_open() {
        let dir = short_dir();
        let name = windows::unique_name("greencli-live-");
        std::fs::write(
            dir.join("mcp-live.sock"),
            format!("{name}\n{}", windows::secret()),
        )
        .unwrap();
        let (is_error, body, _) = call(&dir, "list_connected_devices", json!({}));
        assert!(is_error);
        let error = body["error"].as_str().unwrap();
        assert!(error.starts_with("GreenCLI isn't open"), "{error}");
        std::fs::remove_dir_all(dir).ok();
    }
}
