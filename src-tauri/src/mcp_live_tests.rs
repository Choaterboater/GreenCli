// Tests for mcp_live.rs. The client side is greencli-mcp's own
// `ask_live_with_wait`, so these also check both ends speak the same lines.

use super::*;
use serde_json::json;
use std::io::{Read, Write};
use std::os::unix::fs::{FileTypeExt, PermissionsExt};
use std::os::unix::net::UnixStream as StdStream;
use std::path::Path;
use std::sync::Mutex as StdMutex;
use std::time::Instant;

fn temp_dir() -> PathBuf {
    let mut p = std::env::temp_dir();
    p.push(format!("gc-live-{}", rand::random::<u32>()));
    std::fs::create_dir_all(&p).unwrap();
    p
}

/// Records what GreenCLI would send to the webview.
#[derive(Default)]
struct FakeWebview {
    asks: StdMutex<Vec<Value>>,
    cancels: StdMutex<Vec<String>>,
}

impl LiveSink for FakeWebview {
    fn ask(&self, request: Value) {
        self.asks.lock().unwrap().push(request);
    }
    fn cancel(&self, id: &str) {
        self.cancels.lock().unwrap().push(id.to_string());
    }
}

fn channel(dir: &Path, wait: Duration) -> (Arc<LiveChannel>, Arc<FakeWebview>) {
    let web = Arc::new(FakeWebview::default());
    let ch = Arc::new(LiveChannel::new(dir.to_path_buf(), web.clone()).with_wait(wait));
    (ch, web)
}

/// Wait (up to 5 s) for `check` to give Some.
async fn until<T>(mut check: impl FnMut() -> Option<T>) -> T {
    let start = Instant::now();
    loop {
        if let Some(v) = check() {
            return v;
        }
        assert!(
            start.elapsed() < Duration::from_secs(5),
            "timed out waiting"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

/// The client call, off the async threads (it blocks).
fn ask_in_background(dir: &Path, request: Value) -> tokio::task::JoinHandle<Result<Value, String>> {
    let dir = dir.to_path_buf();
    tokio::task::spawn_blocking(move || {
        greencli_mcp::ask_live_with_wait(&dir, &request, Duration::from_secs(5))
    })
}

fn first_ask(web: &FakeWebview) -> Option<Value> {
    web.asks.lock().unwrap().first().cloned()
}

#[tokio::test]
async fn starts_owner_only_and_removes_a_stale_file_first() {
    let dir = temp_dir();
    let sock = dir.join(SOCKET_NAME);
    std::fs::write(&sock, "left over").unwrap();
    let (ch, _web) = channel(&dir, Duration::from_secs(5));
    ch.start_if_on().unwrap();
    let meta = std::fs::symlink_metadata(&sock).unwrap();
    assert!(meta.file_type().is_socket());
    assert_eq!(meta.permissions().mode() & 0o777, 0o600);
    assert!(ch.is_listening());
    ch.stop();
    assert!(!sock.exists());
}

#[tokio::test]
async fn a_second_greencli_does_not_take_over_a_working_channel() {
    let dir = temp_dir();
    let (first, _w1) = channel(&dir, Duration::from_secs(5));
    first.start_if_on().unwrap();
    let (second, _w2) = channel(&dir, Duration::from_secs(5));
    let err = second.start_if_on().unwrap_err();
    assert!(err.contains("already open"), "{err}");
    // The first one still answers.
    assert!(StdStream::connect(dir.join(SOCKET_NAME)).is_ok());
    first.stop();
}

#[tokio::test]
async fn switch_off_means_no_channel_and_toggling_binds_and_removes() {
    let dir = temp_dir();
    let sock = dir.join(SOCKET_NAME);
    let (ch, _web) = channel(&dir, Duration::from_secs(5));
    assert!(ch.is_on(), "on by default");

    ch.set_on(false).unwrap();
    assert!(!ch.is_on());
    assert!(!sock.exists());
    // Off is remembered: a new start (next launch) makes nothing.
    let (next, _w) = channel(&dir, Duration::from_secs(5));
    next.start_if_on().unwrap();
    assert!(!next.is_listening());
    assert!(!sock.exists());
    let err = greencli_mcp::ask_live_with_wait(
        &dir,
        &json!({"v":1,"op":"sessions"}),
        Duration::from_secs(1),
    )
    .unwrap_err();
    assert!(err.contains("isn't open"), "{err}");

    next.set_on(true).unwrap();
    assert!(next.is_on());
    assert!(next.is_listening());
    assert!(sock.exists());
    next.set_on(false).unwrap();
    assert!(!sock.exists());
    assert!(!next.is_listening());
}

#[tokio::test]
async fn a_path_too_long_is_refused_in_plain_words() {
    let mut dir = temp_dir();
    dir.push("x".repeat(120));
    let (ch, _web) = channel(&dir, Duration::from_secs(5));
    let err = ch.start_if_on().unwrap_err();
    assert!(err.contains("too long"), "{err}");
    assert!(!ch.is_listening());
    assert_eq!(ch.status().problem.as_deref(), Some(err.as_str()));
}

#[tokio::test]
async fn sessions_go_to_the_webview_and_its_answer_comes_back() {
    let dir = temp_dir();
    let (ch, web) = channel(&dir, Duration::from_secs(5));
    ch.start_if_on().unwrap();
    let client = ask_in_background(&dir, json!({"v":1,"op":"sessions"}));
    let ask = until(|| first_ask(&web)).await;
    assert_eq!(ask["op"], "sessions");
    assert_eq!(ask["pid"], json!(std::process::id()));
    let id = ask["id"].as_str().unwrap().to_string();
    assert!(ch.answer(
        &id,
        json!({"ok":true,"devices":[{"tabId":"t1","name":"core-sw","type":"aruba-cx","extra":"x"}]})
    ));
    let reply = client.await.unwrap().unwrap();
    assert_eq!(
        reply["devices"],
        json!([{"tabId":"t1","name":"core-sw","type":"aruba-cx"}])
    );
    // A second answer for the same id goes nowhere.
    assert!(!ch.answer(&id, json!({"ok":true,"devices":[]})));
    ch.stop();
}

#[tokio::test]
async fn show_passes_the_line_and_caps_the_output() {
    let dir = temp_dir();
    let (ch, web) = channel(&dir, Duration::from_secs(5));
    ch.start_if_on().unwrap();
    let client = ask_in_background(
        &dir,
        json!({"v":1,"op":"show","device":"core-sw","show":"show vlan | include 10"}),
    );
    let ask = until(|| first_ask(&web)).await;
    assert_eq!(ask["op"], "show");
    assert_eq!(ask["device"], "core-sw");
    assert_eq!(ask["show"], "show vlan | include 10");
    assert!(ask.get("tab").is_none());
    let id = ask["id"].as_str().unwrap().to_string();
    ch.answer(
        &id,
        json!({"ok":true,"output":"é".repeat(20_000),"truncated":false}),
    );
    let reply = client.await.unwrap().unwrap();
    let out = reply["output"].as_str().unwrap();
    assert!(out.len() <= MAX_OUTPUT);
    assert_eq!(reply["truncated"], true);
    ch.stop();
}

#[tokio::test]
async fn a_no_from_the_webview_comes_back_as_plain_words() {
    let dir = temp_dir();
    let (ch, web) = channel(&dir, Duration::from_secs(5));
    ch.start_if_on().unwrap();
    let client = ask_in_background(
        &dir,
        json!({"v":1,"op":"show","tab":"t1","show":"show clock"}),
    );
    let ask = until(|| first_ask(&web)).await;
    ch.answer(
        ask["id"].as_str().unwrap(),
        json!({"ok":false,"error":"You said no."}),
    );
    assert_eq!(client.await.unwrap().unwrap_err(), "You said no.");
    ch.stop();
}

#[tokio::test]
async fn lines_that_are_not_plain_show_never_reach_the_webview() {
    let dir = temp_dir();
    let (ch, web) = channel(&dir, Duration::from_secs(5));
    ch.start_if_on().unwrap();
    for show in [
        "configure terminal",
        "show run | tee x",
        "show x\nreload",
        "do show vlan",
        "",
    ] {
        let err = ask_in_background(&dir, json!({"v":1,"op":"show","tab":"t1","show":show}))
            .await
            .unwrap()
            .unwrap_err();
        assert!(err.contains("plain show line"), "{show:?}: {err}");
    }
    // Both tab and device, or neither, is refused too; so is an unknown op.
    for bad in [
        json!({"v":1,"op":"show","tab":"t1","device":"d","show":"show clock"}),
        json!({"v":1,"op":"show","show":"show clock"}),
        json!({"v":1,"op":"run","show":"show clock"}),
        json!({"v":2,"op":"sessions"}),
    ] {
        assert!(ask_in_background(&dir, bad).await.unwrap().is_err());
    }
    assert!(web.asks.lock().unwrap().is_empty());
    ch.stop();
}

#[tokio::test]
async fn an_oversized_request_is_refused() {
    let dir = temp_dir();
    let (ch, web) = channel(&dir, Duration::from_secs(5));
    ch.start_if_on().unwrap();
    let dir2 = dir.clone();
    let reply = tokio::task::spawn_blocking(move || {
        let mut s = StdStream::connect(dir2.join(SOCKET_NAME)).unwrap();
        s.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        let _ = s.write_all(&vec![b'a'; greencli_mcp::MAX_LIVE_REQUEST + 10]);
        let mut out = String::new();
        let _ = s.read_to_string(&mut out);
        out
    })
    .await
    .unwrap();
    let v: Value = serde_json::from_str(reply.trim()).unwrap();
    assert_eq!(v["ok"], false);
    assert!(v["error"].as_str().unwrap().contains("too long"));
    assert!(web.asks.lock().unwrap().is_empty());
    ch.stop();
}

#[tokio::test]
async fn hang_up_cancels_the_box() {
    let dir = temp_dir();
    let (ch, web) = channel(&dir, Duration::from_secs(5));
    ch.start_if_on().unwrap();
    let dir2 = dir.clone();
    let client = tokio::task::spawn_blocking(move || {
        let mut s = StdStream::connect(dir2.join(SOCKET_NAME)).unwrap();
        s.write_all(b"{\"v\":1,\"op\":\"show\",\"tab\":\"t1\",\"show\":\"show clock\"}\n")
            .unwrap();
        s
    });
    let ask = until(|| first_ask(&web)).await;
    let id = ask["id"].as_str().unwrap().to_string();
    drop(client.await.unwrap()); // the program gave up
    let cancelled = until(|| web.cancels.lock().unwrap().first().cloned()).await;
    assert_eq!(cancelled, id);
    // A late Yes types nothing: nobody is waiting for it.
    assert!(!ch.answer(&id, json!({"ok":true,"output":"","truncated":false})));
    ch.stop();
}

#[tokio::test]
async fn no_answer_in_time_cancels_the_box_and_says_so() {
    let dir = temp_dir();
    let (ch, web) = channel(&dir, Duration::from_millis(200));
    ch.start_if_on().unwrap();
    let err = ask_in_background(&dir, json!({"v":1,"op":"sessions"}))
        .await
        .unwrap()
        .unwrap_err();
    assert!(err.contains("in time"), "{err}");
    let id = first_ask(&web).unwrap()["id"].as_str().unwrap().to_string();
    assert_eq!(web.cancels.lock().unwrap().clone(), vec![id.clone()]);
    assert!(!ch.answer(&id, json!({"ok":true,"devices":[]})));
    ch.stop();
}

#[tokio::test]
async fn turning_off_ends_waiting_requests() {
    let dir = temp_dir();
    let (ch, web) = channel(&dir, Duration::from_secs(5));
    ch.start_if_on().unwrap();
    let client = ask_in_background(&dir, json!({"v":1,"op":"sessions"}));
    let ask = until(|| first_ask(&web)).await;
    ch.set_on(false).unwrap();
    let err = client.await.unwrap().unwrap_err();
    assert!(err.contains("turned off"), "{err}");
    assert_eq!(
        web.cancels.lock().unwrap().clone(),
        vec![ask["id"].as_str().unwrap().to_string()]
    );
}

#[test]
fn only_the_same_user_gets_in() {
    assert!(same_user(Some(501), 501));
    assert!(!same_user(Some(502), 501));
    assert!(!same_user(Some(0), 501), "not even root");
    assert!(!same_user(None, 501));
}

#[test]
fn the_wait_matches_the_mcp_server_and_stays_under_casper_limit() {
    assert_eq!(LIVE_WAIT, greencli_mcp::LIVE_WAIT);
    assert!(LIVE_WAIT < Duration::from_secs(90));
}

#[test]
fn the_channel_is_a_file_in_the_data_folder_never_a_port() {
    let dir = PathBuf::from("/data");
    let ch = LiveChannel::new(dir.clone(), Arc::new(FakeWebview::default()));
    assert_eq!(ch.path(), dir.join("mcp-live.sock"));
    assert!(!SOCKET_NAME.contains(':'));
}
