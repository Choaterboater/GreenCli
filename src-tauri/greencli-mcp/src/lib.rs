//! greencli-mcp: a read-only MCP server over GreenCLI's data folder.
//!
//! Casper or Claude Code start it as a stdio MCP server. It reads the files
//! GreenCLI keeps (saved sessions, the config archive, intents) and answers
//! with the safe parts only. It never writes, never opens a network
//! connection and never starts another program; `tests/source_scan.rs`
//! checks the source for that.
//!
//! One exception, on macOS and Linux only: the live tools
//! (list_connected_devices, device_show) connect to the running GreenCLI
//! through its own channel, `mcp-live.sock` in GreenCLI's data folder, and
//! nowhere else. GreenCLI then asks you before each show line and types it
//! into a tab you already have connected. Only src/live.rs may do this, and
//! tests/source_scan.rs checks that too. On Windows those tools answer "not
//! on Windows yet".
//!
//! Config text is served only from the hidden copies GreenCLI writes at
//! capture time (`<ts>.hidden.json`, made with the same secret filter the AI
//! uses). When a hidden copy is missing or was made by another filter (an
//! older one, or a newer one when GreenCLI was updated while this server ran),
//! the tool fails closed: the raw snapshot is never read.

use std::ffi::OsString;
use std::io::{BufRead, Write};
use std::path::{Path, PathBuf};

mod archive;
mod devices;
mod files;
mod intents;
#[cfg(unix)]
mod live;
mod page;
mod protocol;
mod show_only;
mod tools;
mod transport;

/// The secret filter version of a hidden copy. GreenCLI writes it into each
/// `<ts>.hidden.json`; this server refuses any other value. Bump it whenever
/// the secret filter in src/utils/secrets changes, so old copies are made
/// again: src/utils/hiddenFilterVersion.test.ts fails until the filter's new
/// hash is appended to `HIDDEN_COPY_FILTER_SOURCES` in
/// src/utils/configArchive.ts and `HIDDEN_COPY_FILTER` there equals that
/// list's length, and tests/identity.rs fails until this value equals it.
pub const HIDDEN_COPY_FILTER: u32 = 1;

pub use archive::hidden_copy_usable;
#[cfg(unix)]
pub use live::ask_live_with_wait;
pub use show_only::{is_plain_show, MAX_SHOW_LEN};

/// How long a live tool waits for GreenCLI (your answer in its box, then the
/// device's output). Casper gives up on an MCP call after 90 s, so this stays
/// below that: a late Yes must never type into a tab no one waits on.
pub const LIVE_WAIT: std::time::Duration = std::time::Duration::from_secs(60);

/// How long the live tools wait for GreenCLI's answer: a little longer than
/// GreenCLI's own LIVE_WAIT, so its answer when that runs out is the one the
/// AI gets.
pub const LIVE_CLIENT_WAIT: std::time::Duration = std::time::Duration::from_secs(65);

/// The longest request sent to GreenCLI's live channel, in bytes.
pub const MAX_LIVE_REQUEST: usize = 4 * 1024;

/// The app's bundle identifier: the name of its data folder.
pub const APP_IDENTIFIER: &str = "com.choatelabs.greencli";

/// This server's version (the same as the app's).
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

/// GreenCLI's data folder: `<data dir>/com.choatelabs.greencli`, the folder
/// Tauri's `app_data_dir` gives the app. It can differ when this server runs
/// with a smaller environment than the app (on Linux, Casper starts servers
/// without `XDG_DATA_HOME`), so GreenCLI passes its own with `--data-dir`.
pub fn data_dir() -> Option<PathBuf> {
    dirs::data_dir().map(|d| d.join(APP_IDENTIFIER))
}

/// The folder given by `--data-dir <full path>` (the arguments after the
/// program name), or None with no arguments. Anything else is an error.
pub fn data_dir_arg<I: IntoIterator<Item = OsString>>(args: I) -> Result<Option<PathBuf>, String> {
    let mut args = args.into_iter();
    let mut dir = None;
    while let Some(arg) = args.next() {
        if arg != "--data-dir" {
            let shown: String = arg.to_string_lossy().chars().take(64).collect();
            return Err(format!(
                "unknown option {shown:?}; the only option is --data-dir <folder>"
            ));
        }
        if dir.is_some() {
            return Err("--data-dir is given twice".into());
        }
        let Some(value) = args.next() else {
            return Err("--data-dir needs GreenCLI's data folder after it".into());
        };
        let path = PathBuf::from(value);
        if !path.is_absolute() {
            return Err(format!(
                "--data-dir needs a full path, not {:?}",
                path.to_string_lossy()
            ));
        }
        dir = Some(path);
    }
    Ok(dir)
}

/// Serve MCP on `reader`/`writer` until the reader ends.
pub fn serve<R: BufRead, W: Write>(data_dir: &Path, reader: R, writer: W) -> std::io::Result<()> {
    protocol::serve(data_dir, reader, writer)
}

/// The binary's entry point: serve on stdin/stdout. Returns the exit code.
pub fn run() -> i32 {
    let dir = match data_dir_arg(std::env::args_os().skip(1)) {
        Ok(Some(dir)) => dir,
        Ok(None) => match data_dir() {
            Some(dir) => dir,
            None => {
                eprintln!("greencli-mcp: can't find this user's data folder");
                return 2;
            }
        },
        Err(text) => {
            eprintln!("greencli-mcp: {text}");
            return 2;
        }
    };
    let stdin = std::io::stdin();
    let stdout = std::io::stdout();
    match serve(&dir, stdin.lock(), stdout.lock()) {
        Ok(()) => 0,
        Err(e) => {
            eprintln!("greencli-mcp: {e}");
            1
        }
    }
}
