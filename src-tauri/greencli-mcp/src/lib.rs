//! greencli-mcp: a read-only MCP server over GreenCLI's data folder.
//!
//! Casper or Claude Code start it as a stdio MCP server. It reads the files
//! GreenCLI keeps (saved sessions, the config archive, intents) and answers
//! with the safe parts only. It never writes, never opens a network
//! connection and never starts another program; `tests/source_scan.rs`
//! checks the source for that.
//!
//! Config text is served only from the hidden copies GreenCLI writes at
//! capture time (`<ts>.hidden.json`, made with the same secret filter the AI
//! uses). When a hidden copy is missing or was made by an older filter, the
//! tool fails closed: the raw snapshot is never read.

use std::io::{BufRead, Write};
use std::path::{Path, PathBuf};

mod devices;
mod files;
mod page;
mod protocol;
mod tools;
mod transport;

/// The secret filter version of a hidden copy. GreenCLI writes it into each
/// `<ts>.hidden.json`; this server refuses any other value. Bump it (and
/// `HIDDEN_COPY_FILTER` in src/utils/configArchive.ts) whenever the secret
/// filter in src/utils/secrets changes, so old copies are made again.
pub const HIDDEN_COPY_FILTER: u32 = 1;

/// The app's bundle identifier: the name of its data folder.
pub const APP_IDENTIFIER: &str = "com.choatelabs.greencli";

/// This server's version (the same as the app's).
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

/// GreenCLI's data folder: `<data dir>/com.choatelabs.greencli`, the folder
/// Tauri's `app_data_dir` gives the app.
pub fn data_dir() -> Option<PathBuf> {
    dirs::data_dir().map(|d| d.join(APP_IDENTIFIER))
}

/// Serve MCP on `reader`/`writer` until the reader ends.
pub fn serve<R: BufRead, W: Write>(data_dir: &Path, reader: R, writer: W) -> std::io::Result<()> {
    protocol::serve(data_dir, reader, writer)
}

/// The binary's entry point: serve on stdin/stdout. Returns the exit code.
pub fn run() -> i32 {
    let Some(dir) = data_dir() else {
        eprintln!("greencli-mcp: can't find this user's data folder");
        return 2;
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
