// Live show commands: GreenCLI's end of greencli-mcp's channel.
//
// greencli-mcp (started by Casper, Claude Code or another AI tool) connects to
// `mcp-live.sock` in GreenCLI's data folder and sends one JSON line; GreenCLI
// answers one JSON line and closes (greencli-mcp/src/live.rs has the shapes).
//
// - The channel exists only while GreenCLI is open and "show commands" is on
//   in MCP Servers. It is on by default; turning it off writes `mcp-live.off`
//   so it stays off on the next start.
// - The file is 0600 in the 0700 data folder, and only programs of the same
//   user get in (peer uid). The peer pid goes to the webview, which shows it as
//   "a program on this computer (pid N)", never as a program name.
// - Windows: the channel is a named pipe on this computer, made new each time
//   with a random name (`greencli-live-` and 32 hex digits) that GreenCLI
//   writes in `mcp-live.sock` in the data folder, with a random secret on the
//   next line. Only this user may read that file. Any local user can list
//   pipe names, though, so after a crash someone else could make a pipe
//   under the old name. So GreenCLI's first line on each call holds the
//   secret, and greencli-mcp sends nothing until it matches; and at start an
//   old name counts as another GreenCLI only if that pipe's program is this
//   user or it knows the secret (pipe_in_use). The pipe's rules let in this
//   user only, and each program is checked again by its process's user
//   (mcp_live_windows.rs). Remote computers are refused.
// - Only plain show lines pass (greencli_mcp::is_plain_show); the webview then
//   checks the tab, asks you in a box, types the line and hides secrets.
// - The webview gets `mcp_live_request` {id, pid, op, tab|device, show} and
//   answers with the `mcp_live_reply` command. If the program hangs up, the
//   wait (60 s, under Casper's 90 s) runs out, or the switch goes off, the
//   webview gets `mcp_live_cancel` {id} and must close that box; a late answer
//   then goes nowhere. The webview's own box closes at 40 s, so a Yes always
//   leaves time to run the line within the 60 s.
// - A data folder path too long for this kind of file gives a plain refusal.
//   There is no second place to put it. (Not on Windows: a pipe name has no
//   such limit.)

// Other systems keep the shared parts but never open the channel.
#![cfg_attr(not(any(unix, windows)), allow(dead_code))]

use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;
use tauri::{Emitter, State};
use tokio::sync::oneshot;

/// The channel's file name in the data folder (the only name greencli-mcp uses).
pub const SOCKET_NAME: &str = "mcp-live.sock";
/// Present when the user turned show commands off.
pub const OFF_FILE: &str = "mcp-live.off";
/// How long a request waits for the webview (and your answer in its box).
pub const LIVE_WAIT: Duration = greencli_mcp::LIVE_WAIT;
/// The most show output sent back, in bytes.
pub const MAX_OUTPUT: usize = 16 * 1024;
#[cfg_attr(any(unix, windows), allow(dead_code))]
pub const NOT_HERE: &str = "Live show commands aren't on this system.";

/// Requests handled at once; more get "busy".
const MAX_AT_ONCE: usize = 4;
/// How long a program has to send its request line.
const REQUEST_WAIT: Duration = Duration::from_secs(5);
const MAX_TARGET: usize = 200;
const MAX_ERROR: usize = 500;
const MAX_DEVICES: usize = 200;
/// Longest path for this kind of file, without the ending NUL.
#[cfg(any(
    target_os = "macos",
    target_os = "ios",
    target_os = "freebsd",
    target_os = "openbsd",
    target_os = "netbsd",
    target_os = "dragonfly"
))]
const MAX_PATH: usize = 103;
#[cfg(all(
    unix,
    not(any(
        target_os = "macos",
        target_os = "ios",
        target_os = "freebsd",
        target_os = "openbsd",
        target_os = "netbsd",
        target_os = "dragonfly"
    ))
))]
const MAX_PATH: usize = 107;

const NOT_PLAIN: &str = "Only a plain show line can run: one line that starts with show, with \
only filters such as include, exclude, begin, section or count after |.";
const MISMATCH: &str = "GreenCLI and greencli-mcp don't match. Update GreenCLI and try again.";
const BAD_ANSWER: &str = "GreenCLI's answer didn't make sense. Restart GreenCLI and try again.";
const TURNED_OFF: &str = "Show commands were turned off in GreenCLI.";
/// The webview closes its box at 40 s and says nothing ran then; this 60 s
/// wait can only run out while a line is being typed, so it never says
/// nothing ran. greencli-mcp waits a little longer (LIVE_CLIENT_WAIT), so
/// this is the text the AI gets.
const NO_ANSWER: &str =
    "GreenCLI didn't answer in time. The line may have run; check in GreenCLI before asking again.";
const BUSY: &str = "GreenCLI is busy with other show commands. Try again in a moment.";
const TOO_LONG: &str = "The request is too long.";

/// Where requests go: the webview in the app, a fake in tests.
pub trait LiveSink: Send + Sync + 'static {
    /// A new request: {id, pid, op, tab|device, show}.
    fn ask(&self, request: Value);
    /// Nobody waits for `id` any more: close its box, run nothing.
    fn cancel(&self, id: &str);
}

/// The app's sink: events to the webview.
pub struct WebviewSink(pub tauri::AppHandle);

impl LiveSink for WebviewSink {
    fn ask(&self, request: Value) {
        let _ = self.0.emit("mcp_live_request", request);
    }
    fn cancel(&self, id: &str) {
        let _ = self.0.emit("mcp_live_cancel", json!({ "id": id }));
    }
}

/// What MCP Servers shows next to the switch.
#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    /// The switch.
    pub on: bool,
    /// The channel is open right now.
    pub listening: bool,
    /// This system has live show commands (macOS, Linux and Windows).
    pub supported: bool,
    /// Why it isn't open although the switch is on, in plain words.
    pub problem: Option<String>,
}

#[derive(Default)]
struct Pending {
    next: u64,
    waiting: HashMap<String, oneshot::Sender<Value>>,
    /// False once the switch goes off: a connection taken before that, whose
    /// line comes after, is refused instead of handed to the webview.
    on: bool,
}

struct Shared {
    wait: Duration,
    request_wait: Duration,
    sink: Arc<dyn LiveSink>,
    pending: Mutex<Pending>,
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    // Nothing here is left half-changed by a panic, so a poisoned lock is used.
    m.lock().unwrap_or_else(|e| e.into_inner())
}

impl Shared {
    /// None when the switch is off.
    fn register(&self) -> Option<(String, oneshot::Receiver<Value>)> {
        let mut p = lock(&self.pending);
        if !p.on {
            return None;
        }
        p.next += 1;
        let id = format!("live-{}", p.next);
        let (tx, rx) = oneshot::channel();
        p.waiting.insert(id.clone(), tx);
        Some((id, rx))
    }

    fn forget(&self, id: &str) {
        lock(&self.pending).waiting.remove(id);
    }
}

struct Running {
    task: tauri::async_runtime::JoinHandle<()>,
}

pub struct LiveChannel {
    dir: PathBuf,
    shared: Arc<Shared>,
    running: Mutex<Option<Running>>,
    problem: Mutex<Option<String>>,
}

impl LiveChannel {
    pub fn new(dir: PathBuf, sink: Arc<dyn LiveSink>) -> Self {
        Self {
            dir,
            shared: Arc::new(Shared {
                wait: LIVE_WAIT,
                request_wait: REQUEST_WAIT,
                sink,
                pending: Mutex::new(Pending::default()),
            }),
            running: Mutex::new(None),
            problem: Mutex::new(None),
        }
    }

    /// A shorter wait (tests).
    #[cfg(test)]
    pub fn with_wait(mut self, wait: Duration) -> Self {
        Arc::get_mut(&mut self.shared)
            .expect("with_wait before start")
            .wait = wait;
        self
    }

    /// A shorter wait for the request line (tests).
    #[cfg(test)]
    pub fn with_request_wait(mut self, wait: Duration) -> Self {
        Arc::get_mut(&mut self.shared)
            .expect("with_request_wait before start")
            .request_wait = wait;
        self
    }

    pub fn path(&self) -> PathBuf {
        self.dir.join(SOCKET_NAME)
    }

    /// The switch: on unless the user turned it off.
    pub fn is_on(&self) -> bool {
        !self.dir.join(OFF_FILE).exists()
    }

    pub fn is_listening(&self) -> bool {
        lock(&self.running).is_some()
    }

    pub fn status(&self) -> Status {
        Status {
            on: self.is_on(),
            listening: self.is_listening(),
            supported: cfg!(any(unix, windows)),
            problem: lock(&self.problem).clone(),
        }
    }

    /// At start: open the channel if the switch is on.
    pub fn start_if_on(&self) -> Result<(), String> {
        if !self.is_on() {
            return Ok(());
        }
        self.start()
    }

    /// The switch in MCP Servers: remembered, and the channel opens or closes
    /// at once.
    pub fn set_on(&self, on: bool) -> Result<(), String> {
        let off = self.dir.join(OFF_FILE);
        if on {
            match std::fs::remove_file(&off) {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(format!("GreenCLI couldn't turn show commands on: {e}")),
            }
            self.start()
        } else {
            crate::private_fs::write_private(
                &off,
                b"Show commands from AI tools outside GreenCLI are off (MCP Servers).\n",
            )
            .map_err(|e| format!("GreenCLI couldn't turn show commands off: {e}"))?;
            self.stop();
            *lock(&self.problem) = None;
            Ok(())
        }
    }

    fn start(&self) -> Result<(), String> {
        let mut running = lock(&self.running);
        if running.is_some() {
            return Ok(());
        }
        match self.bind() {
            Ok(r) => {
                *running = Some(r);
                lock(&self.shared.pending).on = true;
                *lock(&self.problem) = None;
                Ok(())
            }
            Err(e) => {
                *lock(&self.problem) = Some(e.clone());
                Err(e)
            }
        }
    }

    /// Close the channel (switch off, or GreenCLI quits). Waiting requests end
    /// with "turned off" and their boxes close.
    pub fn stop(&self) {
        if let Some(r) = lock(&self.running).take() {
            r.task.abort();
            let _ = std::fs::remove_file(self.path());
        }
        // Dropping the senders wakes each waiting request; connections already
        // taken but not yet registered are refused by register().
        let waiting: Vec<_> = {
            let mut p = lock(&self.shared.pending);
            p.on = false;
            p.waiting.drain().collect()
        };
        drop(waiting);
    }

    /// The webview's answer for `id`. False when nobody waits for it any more.
    pub fn answer(&self, id: &str, reply: Value) -> bool {
        let tx = lock(&self.shared.pending).waiting.remove(id);
        tx.is_some_and(|tx| tx.send(reply).is_ok())
    }

    #[cfg(not(any(unix, windows)))]
    fn bind(&self) -> Result<Running, String> {
        Err(NOT_HERE.into())
    }

    #[cfg(windows)]
    fn bind(&self) -> Result<Running, String> {
        let path = self.path();
        let failed =
            |e: &dyn std::fmt::Display| format!("GreenCLI couldn't start show commands: {e}");
        let user = windows::current_user().map_err(|e| failed(&e))?;
        clear_old_file(&path, &user)?;
        let name = format!("{PIPE_PREFIX}{}", random_hex(16).map_err(|e| failed(&e))?);
        let secret = random_hex(32).map_err(|e| failed(&e))?;
        // The pipe belongs to the runtime its task runs on.
        let runtime = tauri::async_runtime::handle();
        let first = {
            let _inside = runtime.inner().enter();
            windows::create_pipe(&name, &user, true).map_err(|e| failed(&e))?
        };
        let text = format!("{name}\n{secret}");
        if let Err(e) = windows::write_only_user(&path, text.as_bytes(), &user) {
            let _ = std::fs::remove_file(&path);
            return Err(failed(&e));
        }
        let hello: Arc<str> = greencli_mcp::live_hello(&secret).into();
        let shared = self.shared.clone();
        let task = runtime.spawn(accept_pipe_loop(first, name, user, hello, shared));
        Ok(Running { task })
    }

    #[cfg(unix)]
    fn bind(&self) -> Result<Running, String> {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        use std::os::unix::net::{UnixListener, UnixStream};
        let path = self.path();
        let too_long = || {
            format!(
                "GreenCLI's data folder path is too long for show commands, so they stay off: {}",
                self.dir.display()
            )
        };
        if path.as_os_str().len() > MAX_PATH {
            return Err(too_long());
        }
        if let Ok(meta) = std::fs::symlink_metadata(&path) {
            if UnixStream::connect(&path).is_ok() {
                return Err(
                    "Another GreenCLI is already open; show commands go to that one.".into(),
                );
            }
            if meta.is_dir() {
                return Err(format!(
                    "GreenCLI can't start show commands: a folder is named {}.",
                    path.display()
                ));
            }
            // Left by a GreenCLI that didn't close cleanly.
            std::fs::remove_file(&path)
                .map_err(|e| format!("GreenCLI couldn't remove an old {SOCKET_NAME}: {e}"))?;
        }
        let listener = UnixListener::bind(&path).map_err(|e| {
            if e.kind() == std::io::ErrorKind::InvalidInput {
                too_long()
            } else {
                format!("GreenCLI couldn't start show commands: {e}")
            }
        })?;
        let ready = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))
            .and_then(|()| listener.set_nonblocking(true))
            .and_then(|()| std::fs::metadata(&path).map(|m| m.uid()));
        let own_uid = match ready {
            Ok(uid) => uid,
            Err(e) => {
                let _ = std::fs::remove_file(&path);
                return Err(format!("GreenCLI couldn't start show commands: {e}"));
            }
        };
        let shared = self.shared.clone();
        let task = tauri::async_runtime::spawn(accept_loop(listener, own_uid, shared));
        Ok(Running { task })
    }
}

/// Only programs running as the same user as GreenCLI get in.
fn same_user<U: PartialEq>(peer: Option<U>, own: U) -> bool {
    peer == Some(own)
}

/// Windows: the pipe's name starts with this; 32 hex digits follow.
#[cfg(windows)]
const PIPE_PREFIX: &str = "greencli-live-";

/// Windows: `bytes` random bytes from the system, as lowercase hex.
#[cfg(windows)]
fn random_hex(bytes: usize) -> Result<String, rand::Error> {
    use rand::RngCore;
    let mut buf = vec![0u8; bytes];
    rand::rngs::OsRng.try_fill_bytes(&mut buf)?;
    Ok(buf.iter().map(|b| format!("{b:02x}")).collect())
}

/// Windows: the pipe's name and the secret in `file`, both checked the way
/// greencli-mcp checks them. None for anything else.
#[cfg(windows)]
fn channel_file(file: &std::path::Path) -> Option<(String, String)> {
    use std::io::Read;
    let mut text = String::new();
    std::fs::File::open(file)
        .ok()?
        .take(256)
        .read_to_string(&mut text)
        .ok()?;
    let (name, secret) = greencli_mcp::live_channel_parts(&text)?;
    Some((name.to_string(), secret.to_string()))
}

/// Windows: before a start, remove the file a GreenCLI that didn't close
/// cleanly left, unless another GreenCLI of `own` is open on it.
#[cfg(windows)]
fn clear_old_file(path: &std::path::Path, own: &windows::UserSid) -> Result<(), String> {
    let Ok(meta) = std::fs::symlink_metadata(path) else {
        return Ok(());
    };
    if meta.is_dir() {
        return Err(format!(
            "GreenCLI can't start show commands: a folder is named {}.",
            path.display()
        ));
    }
    if pipe_in_use(path, own) {
        return Err("Another GreenCLI is already open; show commands go to that one.".into());
    }
    std::fs::remove_file(path)
        .map_err(|e| format!("GreenCLI couldn't remove an old {SOCKET_NAME}: {e}"))
}

/// Windows: another GreenCLI is open on the pipe named in `file`. After a
/// crash, someone else may have made a pipe under that name, so it counts
/// only if its program runs as `own`, or its first line holds the secret in
/// `file`. Nothing is sent to it, and it may not act as GreenCLI (anonymous).
/// A pipe that stays busy can't be checked, so it doesn't count either.
#[cfg(windows)]
fn pipe_in_use(file: &std::path::Path, own: &windows::UserSid) -> bool {
    use std::os::windows::fs::OpenOptionsExt;
    const SECURITY_ANONYMOUS: u32 = 0;
    const ERROR_PIPE_BUSY: i32 = 231;
    let Some((name, secret)) = channel_file(file) else {
        return false;
    };
    let start = std::time::Instant::now();
    let pipe = loop {
        match std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .security_qos_flags(SECURITY_ANONYMOUS)
            .open(windows::pipe_path(&name))
        {
            Ok(pipe) => break pipe,
            Err(e)
                if e.raw_os_error() == Some(ERROR_PIPE_BUSY)
                    && start.elapsed() < Duration::from_secs(2) =>
            {
                std::thread::sleep(Duration::from_millis(20));
            }
            Err(_) => return false,
        }
    };
    if windows::pipe_server_user(&pipe).as_ref() == Some(own) {
        return true;
    }
    // A pipe has no read timeout: read on a thread, wait here at most
    // LIVE_HELLO_WAIT. A pipe that never speaks keeps only that thread.
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut reader = std::io::BufReader::new(pipe);
        let _ = tx.send(greencli_mcp::read_live_hello(&mut reader, &secret));
    });
    rx.recv_timeout(greencli_mcp::LIVE_HELLO_WAIT)
        .unwrap_or(false)
}

fn refuse(text: impl Into<String>) -> Value {
    json!({ "ok": false, "error": text.into() })
}

#[derive(Debug, PartialEq, Eq)]
enum Request {
    Sessions,
    Show {
        key: &'static str,
        target: String,
        show: String,
    },
}

/// Check one request line. Refusals are plain words for the program.
fn parse_request(bytes: &[u8]) -> Result<Request, String> {
    let v: Value = serde_json::from_slice(bytes).map_err(|_| MISMATCH.to_string())?;
    if v.get("v").and_then(Value::as_u64) != Some(1) {
        return Err(MISMATCH.into());
    }
    match v.get("op").and_then(Value::as_str) {
        Some("sessions") => Ok(Request::Sessions),
        Some("show") => {
            let show = v.get("show").and_then(Value::as_str).unwrap_or_default();
            if !greencli_mcp::is_plain_show(show) {
                return Err(NOT_PLAIN.into());
            }
            let key = match (v.get("tab"), v.get("device")) {
                (Some(_), None) => "tab",
                (None, Some(_)) => "device",
                _ => return Err("A show command needs one tab or one device.".into()),
            };
            let target = v
                .get(key)
                .and_then(Value::as_str)
                .filter(|t| !t.trim().is_empty() && t.chars().count() <= MAX_TARGET)
                .ok_or_else(|| format!("The {key} name is empty or too long."))?;
            Ok(Request::Show {
                key,
                target: target.to_string(),
                show: show.to_string(),
            })
        }
        _ => Err(MISMATCH.into()),
    }
}

/// The webview's answer, cut down to the exact reply shape.
fn shape(request: &Request, answer: Value) -> Value {
    if answer.get("ok").and_then(Value::as_bool) != Some(true) {
        let text: String = answer
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("GreenCLI said no.")
            .chars()
            .take(MAX_ERROR)
            .collect();
        return refuse(text);
    }
    match request {
        Request::Sessions => {
            let Some(list) = answer.get("devices").and_then(Value::as_array) else {
                return refuse(BAD_ANSWER);
            };
            let mut devices = Vec::new();
            for d in list.iter().take(MAX_DEVICES) {
                let field = |k: &str| d.get(k).and_then(Value::as_str);
                let (Some(tab), Some(name), Some(kind)) =
                    (field("tabId"), field("name"), field("type"))
                else {
                    return refuse(BAD_ANSWER);
                };
                devices.push(json!({ "tabId": tab, "name": name, "type": kind }));
            }
            json!({ "ok": true, "devices": devices })
        }
        Request::Show { .. } => {
            let Some(output) = answer.get("output").and_then(Value::as_str) else {
                return refuse(BAD_ANSWER);
            };
            let truncated = answer
                .get("truncated")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let (output, cut) = cap(output, MAX_OUTPUT);
            json!({ "ok": true, "output": output, "truncated": truncated || cut })
        }
    }
}

fn cap(text: &str, max: usize) -> (&str, bool) {
    if text.len() <= max {
        return (text, false);
    }
    let mut end = max;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    (&text[..end], true)
}

#[cfg(unix)]
async fn accept_loop(
    listener: std::os::unix::net::UnixListener,
    own_uid: u32,
    shared: Arc<Shared>,
) {
    let listener = match tokio::net::UnixListener::from_std(listener) {
        Ok(l) => l,
        Err(e) => {
            log::warn!("show commands for AI tools didn't start: {e}");
            return;
        }
    };
    let slots = Arc::new(tokio::sync::Semaphore::new(MAX_AT_ONCE));
    loop {
        let stream = match listener.accept().await {
            Ok((stream, _)) => stream,
            Err(_) => {
                tokio::time::sleep(Duration::from_millis(100)).await;
                continue;
            }
        };
        let cred = stream.peer_cred().ok();
        if !same_user(cred.map(|c| c.uid()), own_uid) {
            log::warn!("show commands: refused a program of another user");
            continue;
        }
        let pid = cred
            .and_then(|c| c.pid())
            .and_then(|p| u32::try_from(p).ok());
        let slot = slots.clone().try_acquire_owned().ok();
        let shared = shared.clone();
        tokio::spawn(async move {
            let has_slot = slot.is_some();
            handle(stream, pid, has_slot, &shared).await;
            drop(slot);
        });
    }
}

/// Windows: take each program on the pipe. A new door opens before the
/// program that came in is served, so the next one can come in meanwhile.
/// Each one first gets `hello`, the line with the secret that proves this is
/// GreenCLI.
#[cfg(windows)]
async fn accept_pipe_loop(
    mut door: tokio::net::windows::named_pipe::NamedPipeServer,
    name: String,
    own: windows::UserSid,
    hello: Arc<str>,
    shared: Arc<Shared>,
) {
    let slots = Arc::new(tokio::sync::Semaphore::new(MAX_AT_ONCE));
    loop {
        let came_in = door.connect().await.is_ok();
        // The next door (a program that left before it was taken: a fresh one).
        let next = loop {
            match windows::create_pipe(&name, &own, false) {
                Ok(next) => break next,
                Err(e) => {
                    log::warn!("show commands: couldn't open the next pipe door: {e}");
                    tokio::time::sleep(Duration::from_millis(100)).await;
                }
            }
        };
        let stream = std::mem::replace(&mut door, next);
        if !came_in {
            tokio::time::sleep(Duration::from_millis(100)).await;
            continue;
        }
        let peer = windows::client_user(&stream);
        if !same_user(peer.as_ref().map(|(_, user)| user), &own) {
            log::warn!("show commands: refused a program of another user");
            continue;
        }
        let pid = peer.map(|(pid, _)| pid);
        let slot = slots.clone().try_acquire_owned().ok();
        let shared = shared.clone();
        let hello = hello.clone();
        tokio::spawn(async move {
            use tokio::io::AsyncWriteExt;
            let mut stream = stream;
            let has_slot = slot.is_some();
            if stream.write_all(hello.as_bytes()).await.is_ok() {
                handle(stream, pid, has_slot, &shared).await;
            }
            drop(slot);
        });
    }
}

/// One connection: read the request, ask the webview, answer, close.
async fn handle<S>(stream: S, pid: Option<u32>, has_slot: bool, shared: &Shared)
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite,
{
    use tokio::io::{AsyncWriteExt, BufReader};
    let (read, mut write) = tokio::io::split(stream);
    let mut reader = BufReader::new(read);
    let reply = match tokio::time::timeout(shared.request_wait, read_request(&mut reader)).await {
        Err(_) => refuse("GreenCLI didn't get a request in time."),
        Ok(Err(text)) => refuse(text),
        Ok(Ok(_)) if !has_slot => refuse(BUSY),
        Ok(Ok(bytes)) => match parse_request(&bytes) {
            Err(text) => refuse(text),
            Ok(request) => match serve(request, pid, shared, &mut reader).await {
                Some(reply) => reply,
                None => return, // the program hung up
            },
        },
    };
    let mut line = reply.to_string();
    line.push('\n');
    let _ = write.write_all(line.as_bytes()).await;
    let _ = write.shutdown().await;
}

/// One line of at most MAX_LIVE_REQUEST bytes, without its line break.
async fn read_request<R>(reader: &mut R) -> Result<Vec<u8>, &'static str>
where
    R: tokio::io::AsyncBufRead + Unpin,
{
    use tokio::io::{AsyncBufReadExt, AsyncReadExt};
    let max = greencli_mcp::MAX_LIVE_REQUEST;
    let mut line = Vec::new();
    (&mut *reader)
        .take(max as u64 + 1)
        .read_until(b'\n', &mut line)
        .await
        .map_err(|_| "GreenCLI couldn't read the request.")?;
    if line.last() != Some(&b'\n') {
        return Err(if line.len() > max {
            TOO_LONG
        } else {
            "The request ended early."
        });
    }
    line.pop();
    Ok(line)
}

/// Hand the request to the webview and wait for its answer, the wait to run
/// out, the program to hang up (None), or the switch to go off.
async fn serve<R>(
    request: Request,
    pid: Option<u32>,
    shared: &Shared,
    rest: &mut R,
) -> Option<Value>
where
    R: tokio::io::AsyncRead + Unpin,
{
    use tokio::io::AsyncReadExt;
    let Some((id, rx)) = shared.register() else {
        return Some(refuse(TURNED_OFF));
    };
    let mut ask = json!({ "id": id, "pid": pid });
    match &request {
        Request::Sessions => ask["op"] = json!("sessions"),
        Request::Show { key, target, show } => {
            ask["op"] = json!("show");
            ask[*key] = json!(target);
            ask["show"] = json!(show);
        }
    }
    shared.sink.ask(ask);
    let hang_up = async {
        let mut buf = [0u8; 256];
        while let Ok(n) = rest.read(&mut buf).await {
            if n == 0 {
                break;
            }
        }
    };
    tokio::select! {
        answer = rx => match answer {
            Ok(answer) => Some(shape(&request, answer)),
            Err(_) => {
                shared.sink.cancel(&id);
                Some(refuse(TURNED_OFF))
            }
        },
        () = tokio::time::sleep(shared.wait) => {
            shared.forget(&id);
            shared.sink.cancel(&id);
            Some(refuse(NO_ANSWER))
        }
        () = hang_up => {
            shared.forget(&id);
            shared.sink.cancel(&id);
            None
        }
    }
}

/// The switch and its state, for MCP Servers.
#[tauri::command]
pub fn mcp_live_status(live: State<'_, LiveChannel>) -> Status {
    live.status()
}

/// Turn show commands from AI tools outside GreenCLI on or off.
#[tauri::command]
pub fn mcp_live_set(on: bool, live: State<'_, LiveChannel>) -> Result<Status, String> {
    live.set_on(on)?;
    Ok(live.status())
}

/// The webview's answer to an `mcp_live_request`. False when the program
/// stopped waiting (the box should already be closed).
#[tauri::command]
pub fn mcp_live_reply(id: String, reply: Value, live: State<'_, LiveChannel>) -> bool {
    live.answer(&id, reply)
}

#[cfg(windows)]
#[path = "mcp_live_windows.rs"]
mod windows;

#[cfg(all(test, any(unix, windows)))]
#[path = "mcp_live_tests.rs"]
mod tests;
