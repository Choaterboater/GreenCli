// Running a local AI CLI: spawn it, feed it the prompt, read its output,
// wait, and stop it on Stop, on a timeout, or when GreenCLI quits.
//
// Shared by every CLI the AI panel runs (Local CLI and Casper). Uses tokio and
// std only, no Tauri, so it moves to Tauri 2 unchanged.
//
// - The CLI gets its own process group (unix) so Stop reaches what it started
//   in that group; on Windows it starts without a console window and Stop
//   ends its process tree with taskkill.
// - The prompt is written from its own task: a CLI that never reads stdin
//   can't hold up Stop or the timeout.
// - stdout and stderr are drained on their own tasks, keeping the last 1 MiB
//   of each, so a runaway CLI can't fill memory before the timeout.
// - Each running CLI is recorded, so quitting GreenCLI can stop it: Tauri v1
//   leaves through std::process::exit, so kill_on_drop never runs on quit.

use super::casper::RunEnd;
use std::collections::HashMap;
use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

/// Max bytes kept from each of the CLI's stdout/stderr. The TAIL is kept: the
/// answer is at the end of the output.
pub const MAX_CLI_OUTPUT_BYTES: usize = 1024 * 1024;

/// How often a running CLI is checked for Stop and the timeout.
const TICK: Duration = Duration::from_millis(250);
/// After a stop: how long the CLI gets to close down before it is killed.
#[cfg_attr(not(unix), allow(dead_code))]
const TERM_GRACE: Duration = Duration::from_secs(2);
/// After the CLI exits: how long its output may keep coming (a process it
/// left behind can hold the pipes open).
const DRAIN_GRACE: Duration = Duration::from_secs(5);

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// How to run one CLI.
pub struct RunOpts<'a> {
    pub cwd: Option<&'a Path>,
    pub env: Vec<(&'static str, OsString)>,
    pub timeout: Duration,
    pub cancel: Option<Arc<AtomicBool>>,
}

/// How a CLI run ended, and what it printed.
pub struct CliRun {
    pub end: RunEnd,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
}

/// Running CLIs: a key → pid (= process group id on unix).
fn running_cli() -> &'static Mutex<HashMap<u64, u32>> {
    static RUNNING: OnceLock<Mutex<HashMap<u64, u32>>> = OnceLock::new();
    RUNNING.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Removes a run from `running_cli` when dropped, however the run ends.
struct Registered(u64);

impl Registered {
    fn new(pid: u32) -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(1);
        let key = NEXT.fetch_add(1, Ordering::Relaxed);
        if let Ok(mut map) = running_cli().lock() {
            map.insert(key, pid);
        }
        Registered(key)
    }
}

impl Drop for Registered {
    fn drop(&mut self) {
        if let Ok(mut map) = running_cli().lock() {
            map.remove(&self.0);
        }
    }
}

/// Read a pipe to EOF into `buf`, keeping at most the last
/// `MAX_CLI_OUTPUT_BYTES`. The buffer is shared so what was read survives the
/// task being aborted.
async fn drain_tail<R: tokio::io::AsyncRead + Unpin>(mut r: R, buf: Arc<Mutex<Vec<u8>>>) {
    use tokio::io::AsyncReadExt;
    let mut chunk = [0u8; 8192];
    loop {
        match r.read(&mut chunk).await {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                let Ok(mut b) = buf.lock() else { break };
                b.extend_from_slice(&chunk[..n]);
                if b.len() > MAX_CLI_OUTPUT_BYTES {
                    let cut = b.len() - MAX_CLI_OUTPUT_BYTES;
                    b.drain(..cut);
                }
            }
        }
    }
}

fn take(buf: &Arc<Mutex<Vec<u8>>>) -> Vec<u8> {
    buf.lock()
        .map(|mut b| std::mem::take(&mut *b))
        .unwrap_or_default()
}

/// Run `argv` (program first, no shell) with `stdin` and a trailing newline
/// on its stdin. Stops it when `cancel` trips or `timeout` passes. A cancel
/// that tripped before the call never spawns anything.
pub async fn run_cli_process(
    argv: &[String],
    stdin: Vec<u8>,
    opts: RunOpts<'_>,
) -> Result<CliRun, std::io::Error> {
    let tripped = || {
        opts.cancel
            .as_ref()
            .is_some_and(|c| c.load(Ordering::Relaxed))
    };
    if tripped() {
        return Ok(CliRun {
            end: RunEnd::Cancelled,
            stdout: Vec::new(),
            stderr: Vec::new(),
        });
    }
    let Some(program) = argv.first() else {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "empty command",
        ));
    };
    let mut cmd = tokio::process::Command::new(program);
    cmd.args(&argv[1..]);
    #[cfg(unix)]
    {
        let home = std::env::var_os("HOME").map(PathBuf::from);
        let current = std::env::var_os("PATH").unwrap_or_default();
        cmd.env(
            "PATH",
            super::casper::augmented_path(&current, home.as_deref()),
        );
        cmd.process_group(0);
    }
    #[cfg(windows)]
    {
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    if let Some(dir) = opts.cwd {
        cmd.current_dir(dir);
    }
    for (key, value) in &opts.env {
        cmd.env(key, value);
    }
    let mut child = cmd
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn()?;
    let _registered = child.id().map(Registered::new);

    let stdin_task = child.stdin.take().map(|mut pipe| {
        tokio::spawn(async move {
            use tokio::io::AsyncWriteExt;
            let _ = pipe.write_all(&stdin).await;
            let _ = pipe.write_all(b"\n").await;
            drop(pipe);
        })
    });
    let out_buf = Arc::new(Mutex::new(Vec::new()));
    let err_buf = Arc::new(Mutex::new(Vec::new()));
    let mut drains = Vec::new();
    if let Some(pipe) = child.stdout.take() {
        drains.push(tokio::spawn(drain_tail(pipe, out_buf.clone())));
    }
    if let Some(pipe) = child.stderr.take() {
        drains.push(tokio::spawn(drain_tail(pipe, err_buf.clone())));
    }

    let deadline = tokio::time::Instant::now() + opts.timeout;
    let mut tick = tokio::time::interval(TICK);
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let waited = loop {
        let exited = tokio::select! {
            status = child.wait() => Some(status),
            _ = tick.tick() => None,
        };
        match exited {
            Some(Ok(status)) => break Ok(RunEnd::Exited(status.code())),
            Some(Err(e)) => {
                stop_child(&mut child).await;
                break Err(e);
            }
            None if tripped() => {
                stop_child(&mut child).await;
                break Ok(RunEnd::Cancelled);
            }
            None if tokio::time::Instant::now() >= deadline => {
                stop_child(&mut child).await;
                break Ok(RunEnd::TimedOut);
            }
            None => {}
        }
    };
    if let Some(task) = stdin_task {
        task.abort();
    }
    if matches!(waited, Ok(RunEnd::Exited(_))) {
        let _ = tokio::time::timeout(DRAIN_GRACE, async {
            for task in drains.iter_mut() {
                let _ = task.await;
            }
        })
        .await;
    }
    for task in &drains {
        task.abort();
    }
    Ok(CliRun {
        end: waited?,
        stdout: take(&out_buf),
        stderr: take(&err_buf),
    })
}

/// `/usr/bin/pkill -<SIGNAL> -g <pgid>`: signal every process in a group.
#[cfg_attr(not(unix), allow(dead_code))]
const PKILL: &str = "/usr/bin/pkill";

/// pkill's arguments to send `signal` ("TERM", "KILL") to process group `pgid`.
#[cfg_attr(not(unix), allow(dead_code))]
fn group_signal_argv(signal: &str, pgid: u32) -> [String; 3] {
    [format!("-{signal}"), "-g".to_string(), pgid.to_string()]
}

/// taskkill's arguments to end process `pid` and its children, forcefully.
#[cfg_attr(not(windows), allow(dead_code))]
fn tree_kill_argv(pid: u32) -> [String; 4] {
    [
        "/PID".to_string(),
        pid.to_string(),
        "/T".to_string(),
        "/F".to_string(),
    ]
}

/// `<SystemRoot>\System32\taskkill.exe`, never looked up on PATH.
#[cfg_attr(not(windows), allow(dead_code))]
fn taskkill_path(system_root: Option<&OsStr>) -> PathBuf {
    let root = system_root
        .filter(|r| !r.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(r"C:\Windows"));
    root.join("System32").join("taskkill.exe")
}

#[cfg(unix)]
async fn signal_group(signal: &str, pgid: u32) {
    let run = tokio::process::Command::new(PKILL)
        .args(group_signal_argv(signal, pgid))
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true)
        .status();
    let _ = tokio::time::timeout(Duration::from_secs(5), run).await;
}

#[cfg(windows)]
async fn tree_kill(pid: u32) {
    let system_root = std::env::var_os("SystemRoot");
    let run = tokio::process::Command::new(taskkill_path(system_root.as_deref()))
        .args(tree_kill_argv(pid))
        .creation_flags(CREATE_NO_WINDOW)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true)
        .status();
    let _ = tokio::time::timeout(Duration::from_secs(5), run).await;
}

/// Stop a running CLI and reap it.
///
/// Unix: the pgid is saved BEFORE signalling (`id()` is None after reaping).
/// TERM goes to the whole group; the leader gets up to 2 s to exit; then KILL
/// goes to the same saved group (within that window), then start_kill + reap.
/// Casper's TERM handler closes its own detached process groups (checks, the
/// AI's bash, services) within its 1 s deadline; GreenCLI can't reach those
/// groups directly.
///
/// Windows: `taskkill /PID <pid> /T /F` ends the tree, then start_kill + reap.
/// Errors are ignored: this is cleanup.
async fn stop_child(child: &mut tokio::process::Child) {
    #[cfg(unix)]
    {
        if let Some(pgid) = child.id() {
            signal_group("TERM", pgid).await;
            let _ = tokio::time::timeout(TERM_GRACE, child.wait()).await;
            signal_group("KILL", pgid).await;
        }
    }
    #[cfg(windows)]
    {
        if let Some(pid) = child.id() {
            tree_kill(pid).await;
        }
    }
    let _ = child.start_kill();
    let _ = child.wait().await;
}

/// Stop every CLI that is still running. Called when GreenCLI quits (Tauri v1
/// exits without running kill_on_drop): TERM each group, wait 1.2 s, then
/// KILL them (Windows: taskkill /T /F). Sync, std::process only.
pub fn stop_all_cli_runs() {
    let pids: Vec<u32> = running_cli()
        .lock()
        .map(|map| map.values().copied().collect())
        .unwrap_or_default();
    if pids.is_empty() {
        return;
    }
    #[cfg(unix)]
    {
        let signal = |signal: &str, pgid: u32| {
            let _ = std::process::Command::new(PKILL)
                .args(group_signal_argv(signal, pgid))
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status();
        };
        for pid in &pids {
            signal("TERM", *pid);
        }
        std::thread::sleep(Duration::from_millis(1200));
        for pid in &pids {
            signal("KILL", *pid);
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let system_root = std::env::var_os("SystemRoot");
        for pid in &pids {
            let _ = std::process::Command::new(taskkill_path(system_root.as_deref()))
                .args(tree_kill_argv(*pid))
                .creation_flags(CREATE_NO_WINDOW)
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn group_signal_argv_shape() {
        assert_eq!(
            group_signal_argv("TERM", 4242),
            ["-TERM".to_string(), "-g".to_string(), "4242".to_string()]
        );
        assert_eq!(group_signal_argv("KILL", 7)[0], "-KILL");
    }

    #[test]
    fn tree_kill_argv_shape() {
        assert_eq!(
            tree_kill_argv(99),
            ["/PID", "99", "/T", "/F"].map(String::from)
        );
    }

    #[test]
    fn taskkill_path_uses_system_root() {
        let p = taskkill_path(Some(OsStr::new(r"D:\Win")));
        assert!(p.starts_with(r"D:\Win"));
        assert!(p.ends_with(Path::new("System32").join("taskkill.exe")));
        let fallback = taskkill_path(None);
        assert!(fallback.starts_with(r"C:\Windows"));
        assert_eq!(taskkill_path(Some(OsStr::new(""))), fallback);
    }

    #[cfg(unix)]
    mod unix {
        use super::super::*;
        use std::time::Instant;

        fn temp_dir() -> PathBuf {
            let p = std::env::temp_dir()
                .join(format!("greencli-cli-run-test-{}", rand::random::<u64>()));
            std::fs::create_dir_all(&p).unwrap();
            p
        }

        fn sh(script: &str) -> Vec<String> {
            vec!["/bin/sh".into(), "-c".into(), script.into()]
        }

        fn opts(timeout: Duration, cancel: Option<Arc<AtomicBool>>) -> RunOpts<'static> {
            RunOpts {
                cwd: None,
                env: Vec::new(),
                timeout,
                cancel,
            }
        }

        /// Gone, or a zombie nobody has reaped yet.
        fn pid_gone(pid: &str) -> bool {
            let alive = std::process::Command::new("/bin/kill")
                .args(["-0", pid])
                .stderr(std::process::Stdio::null())
                .status()
                .map(|s| s.success())
                .unwrap_or(false);
            if !alive {
                return true;
            }
            std::process::Command::new("ps")
                .args(["-o", "stat=", "-p", pid])
                .output()
                .map(|o| String::from_utf8_lossy(&o.stdout).trim().starts_with('Z'))
                .unwrap_or(false)
        }

        #[tokio::test]
        async fn run_passes_stdin_cwd_and_env() {
            let dir = temp_dir();
            let run = run_cli_process(
                &sh("read line; echo \"got:$line\"; pwd; echo \"env:$GREENCLI_TEST\"; echo oops >&2; exit 3"),
                b"hello".to_vec(),
                RunOpts {
                    cwd: Some(&dir),
                    env: vec![("GREENCLI_TEST", OsString::from("yes"))],
                    timeout: Duration::from_secs(20),
                    cancel: None,
                },
            )
            .await
            .unwrap();
            assert_eq!(run.end, RunEnd::Exited(Some(3)));
            let out = String::from_utf8_lossy(&run.stdout);
            assert!(out.contains("got:hello"), "{out}");
            let canon = std::fs::canonicalize(&dir).unwrap();
            assert!(
                out.contains(&*dir.to_string_lossy()) || out.contains(&*canon.to_string_lossy()),
                "{out}"
            );
            assert!(out.contains("env:yes"), "{out}");
            assert_eq!(String::from_utf8_lossy(&run.stderr).trim(), "oops");
            let _ = std::fs::remove_dir_all(&dir);
        }

        #[tokio::test]
        async fn precancelled_never_spawns() {
            let dir = temp_dir();
            let pidfile = dir.join("pid");
            let cancel = Arc::new(AtomicBool::new(true));
            let run = run_cli_process(
                &sh(&format!("echo $$ > '{}'", pidfile.display())),
                Vec::new(),
                opts(Duration::from_secs(20), Some(cancel)),
            )
            .await
            .unwrap();
            assert_eq!(run.end, RunEnd::Cancelled);
            tokio::time::sleep(Duration::from_millis(300)).await;
            assert!(!pidfile.exists());
            let _ = std::fs::remove_dir_all(&dir);
        }

        #[tokio::test]
        async fn cancel_kills_process_group() {
            let dir = temp_dir();
            let pidfile = dir.join("pid");
            let cancel = Arc::new(AtomicBool::new(false));
            let script = format!("sleep 60 & echo $! > '{}'; wait", pidfile.display());
            let flag = cancel.clone();
            let file = pidfile.clone();
            tokio::spawn(async move {
                for _ in 0..100 {
                    if file.exists() {
                        break;
                    }
                    tokio::time::sleep(Duration::from_millis(50)).await;
                }
                tokio::time::sleep(Duration::from_millis(100)).await;
                flag.store(true, Ordering::Relaxed);
            });
            let started = Instant::now();
            let run = run_cli_process(
                &sh(&script),
                Vec::new(),
                opts(Duration::from_secs(60), Some(cancel)),
            )
            .await
            .unwrap();
            assert_eq!(run.end, RunEnd::Cancelled);
            assert!(started.elapsed() < Duration::from_secs(20));
            let pid = std::fs::read_to_string(&pidfile).unwrap();
            let pid = pid.trim();
            let mut gone = false;
            for _ in 0..30 {
                if pid_gone(pid) {
                    gone = true;
                    break;
                }
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
            assert!(gone, "grandchild {pid} still running");
            let _ = std::fs::remove_dir_all(&dir);
        }

        #[tokio::test]
        async fn stdin_not_read_still_stops() {
            let started = Instant::now();
            let run = run_cli_process(
                &["/bin/sleep".to_string(), "60".to_string()],
                vec![b'x'; 200 * 1024],
                opts(Duration::from_millis(500), None),
            )
            .await
            .unwrap();
            assert_eq!(run.end, RunEnd::TimedOut);
            assert!(started.elapsed() < Duration::from_secs(10));
        }

        #[tokio::test]
        async fn timeout_stops() {
            let started = Instant::now();
            let run = run_cli_process(
                &sh("trap '' TERM; sleep 30"),
                Vec::new(),
                opts(Duration::from_millis(300), None),
            )
            .await
            .unwrap();
            assert_eq!(run.end, RunEnd::TimedOut);
            assert!(started.elapsed() < Duration::from_secs(10));
        }
    }
}
