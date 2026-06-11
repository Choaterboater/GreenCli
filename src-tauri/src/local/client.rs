use crate::error::AppError;
use crate::ssh::client::{ConnectResponse, Connection};
use async_trait::async_trait;
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::io::Write;
use std::sync::Arc;
use tokio::sync::mpsc::channel;
use tokio::sync::Mutex;

/// Configuration for a local PTY session. When `command` is `None` a default
/// interactive login shell is launched; otherwise the named command (e.g. a
/// `claude` / `kimi` / `copilot` CLI) is run inside the PTY.
#[derive(Clone, Debug, Serialize)]
pub struct LocalConfig {
    pub id: String,
    pub command: Option<String>,
    pub args: Vec<String>,
    pub cwd: Option<String>,
}

pub struct LocalConnection {
    session_id: String,
    config: LocalConfig,
    master: Option<Arc<Mutex<Box<dyn MasterPty + Send>>>>,
    writer: Option<Arc<std::sync::Mutex<Box<dyn Write + Send>>>>,
    child: Option<Arc<Mutex<Box<dyn Child + Send + Sync>>>>,
    data_receiver: Option<tokio::sync::mpsc::Receiver<Vec<u8>>>,
    connected: bool,
}

/// Pick a sensible default interactive shell for the host OS.
fn default_shell() -> String {
    if cfg!(windows) {
        std::env::var("COMSPEC").unwrap_or_else(|_| "powershell.exe".to_string())
    } else {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string())
    }
}

impl LocalConnection {
    pub fn new(session_id: String, config: LocalConfig) -> Self {
        Self {
            session_id,
            config,
            master: None,
            writer: None,
            child: None,
            data_receiver: None,
            connected: false,
        }
    }

    pub fn take_data_receiver(&mut self) -> Option<tokio::sync::mpsc::Receiver<Vec<u8>>> {
        self.data_receiver.take()
    }
}

#[async_trait]
impl Connection for LocalConnection {
    async fn connect(&mut self) -> Result<ConnectResponse, AppError> {
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| AppError::LocalError(format!("openpty: {}", e)))?;

        // Launch through a LOGIN shell so the process inherits the user's full
        // PATH. GUI-launched apps (macOS especially) otherwise get a minimal
        // PATH and can't find Homebrew/npm CLIs like `claude`/`kimi`/`copilot`.
        let shell = default_shell();
        let mut cmd = if let Some(ref command) = self.config.command {
            let full = if self.config.args.is_empty() {
                command.clone()
            } else {
                format!("{} {}", command, self.config.args.join(" "))
            };
            if cfg!(windows) {
                let mut c = CommandBuilder::new("cmd.exe");
                c.arg("/C");
                c.arg(full);
                c
            } else {
                let mut c = CommandBuilder::new(&shell);
                c.arg("-lc");
                c.arg(full);
                c
            }
        } else {
            let mut c = CommandBuilder::new(&shell);
            if !cfg!(windows) {
                c.arg("-l"); // interactive login shell → loads profile/PATH
            }
            c
        };
        if let Some(cwd) = &self.config.cwd {
            cmd.cwd(cwd);
        }
        // Advertise a capable terminal so CLIs enable colour/TUI rendering.
        cmd.env("TERM", "xterm-256color");
        // On macOS GUI-launched apps, ensure common user-local bin dirs are
        // on PATH even if the login shell's dotfiles don't fully run.
        if !cfg!(windows) {
            if let Ok(home) = std::env::var("HOME") {
                let extra_paths = [
                    format!("{home}/.local/bin"),
                    format!("{home}/.cargo/bin"),
                    "/usr/local/bin".to_string(),
                    "/opt/homebrew/bin".to_string(),
                ];
                let current = std::env::var("PATH").unwrap_or_default();
                let mut parts: Vec<&str> = current.split(':').collect();
                for p in &extra_paths {
                    if !parts.contains(&p.as_str()) {
                        parts.push(p.as_str());
                    }
                }
                cmd.env("PATH", parts.join(":"));
            }
        }

        let child = pair.slave.spawn_command(cmd).map_err(|e| {
            let what = self.config.command.as_deref().unwrap_or("shell");
            AppError::LocalError(format!("spawn '{}': {}", what, e))
        })?;

        let mut reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| AppError::LocalError(format!("clone reader: {}", e)))?;
        let writer = pair
            .master
            .take_writer()
            .map_err(|e| AppError::LocalError(format!("take writer: {}", e)))?;

        // Drop the slave handle so the PTY signals EOF once the child exits.
        drop(pair.slave);

        let (data_tx, data_rx) = channel::<Vec<u8>>(1024);

        // portable-pty readers are blocking, so read on a dedicated OS thread
        // and hand bytes to the async forwarder via blocking_send.
        std::thread::spawn(move || {
            let mut buf = [0u8; 4096];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        if data_tx.blocking_send(buf[..n].to_vec()).is_err() {
                            break;
                        }
                    }
                    Err(_) => break,
                }
            }
        });

        self.master = Some(Arc::new(Mutex::new(pair.master)));
        self.writer = Some(Arc::new(std::sync::Mutex::new(writer)));
        self.child = Some(Arc::new(Mutex::new(child)));
        self.data_receiver = Some(data_rx);
        self.connected = true;

        Ok(ConnectResponse {
            session_id: self.session_id.clone(),
            success: true,
            error: None,
        })
    }

    async fn disconnect(&mut self) -> Result<(), AppError> {
        if let Some(child) = self.child.take() {
            // kill() alone leaves a defunct process: portable-pty's unix Child
            // doesn't reap on drop, so wait() on a blocking thread to collect
            // it (also reaps shells that already exited on their own).
            tokio::task::spawn_blocking(move || {
                let mut child = child.blocking_lock();
                let _ = child.kill();
                let _ = child.wait();
            });
        }
        self.connected = false;
        self.writer = None;
        self.master = None;
        self.data_receiver = None;
        Ok(())
    }

    async fn send(&self, data: &[u8]) -> Result<(), AppError> {
        let writer = self
            .writer
            .clone()
            .ok_or_else(|| AppError::LocalError("Local session not connected".into()))?;
        let data = data.to_vec();
        tokio::task::spawn_blocking(move || -> std::io::Result<()> {
            let mut w = writer.lock().map_err(|_| {
                std::io::Error::new(std::io::ErrorKind::Other, "writer mutex poisoned")
            })?;
            w.write_all(&data)?;
            w.flush()
        })
        .await
        .map_err(|e| AppError::LocalError(format!("write task: {}", e)))?
        .map_err(|e| AppError::LocalError(format!("write: {}", e)))
    }

    async fn resize(&self, cols: u16, rows: u16) -> Result<(), AppError> {
        if let Some(master) = &self.master {
            let master = master.lock().await;
            master
                .resize(PtySize {
                    rows,
                    cols,
                    pixel_width: 0,
                    pixel_height: 0,
                })
                .map_err(|e| AppError::LocalError(format!("resize: {}", e)))?;
        }
        Ok(())
    }

    fn is_connected(&self) -> bool {
        self.connected
    }

    fn get_session_id(&self) -> String {
        self.session_id.clone()
    }
}
