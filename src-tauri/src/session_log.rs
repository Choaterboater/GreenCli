// Session logging: stream a session's terminal output to a plain-text file.
//
// The backend sees the raw PTY bytes, which are full of ANSI/VT control
// sequences (colors, cursor moves, pager redraws, window titles). Written
// as-is they made the log unreadable outside a terminal, so every chunk goes
// through `LogCleaner` first: escape sequences are dropped, and CR / BS /
// erase-line are applied the way a terminal would, so `--More--` prompts and
// in-line edits don't leave debris in the file. The cleaner is a byte state
// machine — a sequence or UTF-8 character split across two chunks is carried
// in its state rather than mangled.

use std::fs::File;
use std::io::{self, Write};
use std::path::{Path, PathBuf};

/// A line with no newline in sight (binary dump, runaway progress bar) is
/// written out at this length rather than buffered without bound.
const MAX_LINE_CHARS: usize = 8192;
/// An OSC/DCS string that never terminates would swallow the rest of the
/// session; give up on it after this many bytes.
const MAX_STRING_BYTES: usize = 4096;
/// CSI parameter bytes kept — only short numeric params are ever needed.
const MAX_CSI_PARAMS: usize = 32;
/// Longest session-name part of a log file name.
const MAX_STEM_CHARS: usize = 80;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum EscState {
    Ground,
    /// Saw ESC.
    Escape,
    /// ESC plus intermediate bytes, e.g. `ESC ( B` (character-set select).
    EscapeIntermediate,
    /// Inside `ESC [ params final`.
    Csi,
    /// Inside an OSC / DCS / SOS / PM / APC string, until BEL or `ESC \`.
    Str,
    /// Saw ESC inside a string; `\` ends it.
    StrEscape,
}

/// Turns raw terminal output into clean log lines.
pub struct LogCleaner {
    state: EscState,
    csi_params: Vec<u8>,
    str_len: usize,
    /// Bytes of a multi-byte UTF-8 character still being assembled.
    utf8: [u8; 4],
    utf8_len: usize,
    utf8_need: usize,
    /// The current (unfinished) screen line and the cursor column in it.
    line: Vec<char>,
    cursor: usize,
    timestamps: bool,
}

impl LogCleaner {
    pub fn new(timestamps: bool) -> Self {
        Self {
            state: EscState::Ground,
            csi_params: Vec::new(),
            str_len: 0,
            utf8: [0; 4],
            utf8_len: 0,
            utf8_need: 0,
            line: Vec::new(),
            cursor: 0,
            timestamps,
        }
    }

    /// Clean one output chunk. Returns every line this chunk completed, each
    /// ending in `\n`; a trailing partial line (usually the prompt) stays
    /// buffered until its newline arrives or `finish` is called.
    /// `local_secs` is local wall-clock time, used for the optional stamp.
    pub fn feed(&mut self, data: &[u8], local_secs: i64) -> String {
        let mut out = String::new();
        for &b in data {
            self.step(b, local_secs, &mut out);
        }
        out
    }

    /// Flush the buffered partial line, for when the log is closed.
    pub fn finish(&mut self, local_secs: i64) -> String {
        let mut out = String::new();
        if self.line.iter().any(|c| !c.is_whitespace()) {
            self.end_line(local_secs, &mut out);
        }
        self.line.clear();
        self.cursor = 0;
        out
    }

    fn step(&mut self, b: u8, now: i64, out: &mut String) {
        match self.state {
            EscState::Ground => self.ground(b, now, out),
            EscState::Escape => match b {
                b'[' => {
                    self.csi_params.clear();
                    self.state = EscState::Csi;
                }
                b']' | b'P' | b'X' | b'^' | b'_' => {
                    self.str_len = 0;
                    self.state = EscState::Str;
                }
                0x20..=0x2f => self.state = EscState::EscapeIntermediate,
                0x1b => {}
                0x18 | 0x1a => self.state = EscState::Ground,
                // C0 controls inside a sequence still act (VT behavior).
                0x00..=0x1f => self.control(b, now, out),
                // Two-byte sequences (ESC 7, ESC =, ESC M, …) and junk.
                _ => self.state = EscState::Ground,
            },
            EscState::EscapeIntermediate => match b {
                0x20..=0x2f => {}
                0x1b => self.state = EscState::Escape,
                0x18 | 0x1a => self.state = EscState::Ground,
                0x00..=0x1f => self.control(b, now, out),
                _ => self.state = EscState::Ground,
            },
            EscState::Csi => match b {
                0x30..=0x3f => {
                    if self.csi_params.len() < MAX_CSI_PARAMS {
                        self.csi_params.push(b);
                    }
                }
                0x20..=0x2f => {}
                0x40..=0x7e => {
                    self.state = EscState::Ground;
                    self.csi(b);
                }
                0x1b => self.state = EscState::Escape,
                0x18 | 0x1a => self.state = EscState::Ground,
                0x00..=0x1f => self.control(b, now, out),
                _ => self.state = EscState::Ground,
            },
            EscState::Str => match b {
                0x07 => self.state = EscState::Ground,
                0x1b => self.state = EscState::StrEscape,
                _ => {
                    self.str_len += 1;
                    if self.str_len > MAX_STRING_BYTES {
                        self.state = EscState::Ground;
                    }
                }
            },
            EscState::StrEscape => {
                if b == b'\\' {
                    self.state = EscState::Ground;
                } else {
                    // ESC not followed by `\` ends the string and starts a new
                    // sequence.
                    self.state = EscState::Escape;
                    self.step(b, now, out);
                }
            }
        }
    }

    fn ground(&mut self, b: u8, now: i64, out: &mut String) {
        if b >= 0x80 {
            self.utf8_byte(b, now, out);
            return;
        }
        if self.utf8_need > 0 {
            // An ASCII byte cut a multi-byte character short.
            self.utf8_need = 0;
            self.utf8_len = 0;
            self.put_char(char::REPLACEMENT_CHARACTER, now, out);
        }
        match b {
            0x1b => self.state = EscState::Escape,
            0x20..=0x7e => self.put_char(b as char, now, out),
            _ => self.control(b, now, out),
        }
    }

    fn utf8_byte(&mut self, b: u8, now: i64, out: &mut String) {
        if self.utf8_need == 0 {
            let need = match b {
                0xc2..=0xdf => 1,
                0xe0..=0xef => 2,
                0xf0..=0xf4 => 3,
                _ => 0,
            };
            if need == 0 {
                self.put_char(char::REPLACEMENT_CHARACTER, now, out);
            } else {
                self.utf8[0] = b;
                self.utf8_len = 1;
                self.utf8_need = need;
            }
        } else if (0x80..=0xbf).contains(&b) {
            self.utf8[self.utf8_len] = b;
            self.utf8_len += 1;
            self.utf8_need -= 1;
            if self.utf8_need == 0 {
                let ch = std::str::from_utf8(&self.utf8[..self.utf8_len])
                    .ok()
                    .and_then(|s| s.chars().next())
                    .unwrap_or(char::REPLACEMENT_CHARACTER);
                self.utf8_len = 0;
                self.put_char(ch, now, out);
            }
        } else {
            // A new lead byte interrupted an unfinished character.
            self.utf8_need = 0;
            self.utf8_len = 0;
            self.put_char(char::REPLACEMENT_CHARACTER, now, out);
            self.utf8_byte(b, now, out);
        }
    }

    fn control(&mut self, b: u8, now: i64, out: &mut String) {
        match b {
            // LF ends the line; VT and FF behave as LF on a terminal.
            b'\n' | 0x0b | 0x0c => self.end_line(now, out),
            // A lone CR returns to column 0, so whatever follows overwrites
            // (progress counters, pager prompts). CRLF is just a newline.
            b'\r' => self.cursor = 0,
            0x08 => self.cursor = self.cursor.saturating_sub(1),
            b'\t' => self.put_char('\t', now, out),
            // BEL, NUL, SO/SI, … carry no text.
            _ => {}
        }
    }

    /// Apply the few CSI sequences that change the text of the current line;
    /// everything else (colors, modes, scroll regions) has no text effect.
    fn csi(&mut self, final_byte: u8) {
        // Private sequences (`ESC [ ? 25 h`, …) never touch text.
        if matches!(self.csi_params.first(), Some(b'?' | b'>' | b'<' | b'=')) {
            return;
        }
        let params: Vec<usize> = self
            .csi_params
            .split(|&c| c == b';')
            .map(|p| {
                std::str::from_utf8(p)
                    .ok()
                    .and_then(|s| s.parse().ok())
                    .unwrap_or(0)
            })
            .collect();
        let first = params.first().copied().unwrap_or(0);
        let count = first.max(1);
        match final_byte {
            // Erase in line / display: only the current line matters here.
            b'K' | b'J' => match first {
                0 => self.line.truncate(self.cursor),
                1 => {
                    let end = (self.cursor + 1).min(self.line.len());
                    self.line[..end].fill(' ');
                }
                _ => self.line.clear(),
            },
            b'D' => self.cursor = self.cursor.saturating_sub(count),
            b'C' => self.cursor = (self.cursor + count).min(MAX_LINE_CHARS),
            b'G' | b'`' => self.cursor = (count - 1).min(MAX_LINE_CHARS),
            // Cursor position: keep the column, ignore the row (AOS-S redraws
            // its prompt on a fixed bottom row this way).
            b'H' | b'f' => {
                let col = params.get(1).copied().unwrap_or(0).max(1);
                self.cursor = (col - 1).min(MAX_LINE_CHARS);
            }
            // Delete characters (line editors use it for backspace).
            b'P' => {
                if self.cursor < self.line.len() {
                    let end = (self.cursor + count).min(self.line.len());
                    self.line.drain(self.cursor..end);
                }
            }
            // Erase characters in place.
            b'X' => {
                let end = (self.cursor + count).min(self.line.len());
                if self.cursor < end {
                    self.line[self.cursor..end].fill(' ');
                }
            }
            _ => {}
        }
    }

    fn put_char(&mut self, c: char, now: i64, out: &mut String) {
        if self.cursor < self.line.len() {
            self.line[self.cursor] = c;
        } else {
            self.line.resize(self.cursor, ' ');
            self.line.push(c);
        }
        self.cursor += 1;
        if self.line.len() >= MAX_LINE_CHARS {
            self.end_line(now, out);
        }
    }

    fn end_line(&mut self, now: i64, out: &mut String) {
        let text: String = self.line.iter().collect();
        let text = text.trim_end();
        if self.timestamps {
            out.push_str(&clock_stamp(now));
            if !text.is_empty() {
                out.push(' ');
            }
        }
        out.push_str(text);
        out.push('\n');
        self.line.clear();
        self.cursor = 0;
    }
}

/// `[HH:MM:SS]` for local wall-clock seconds.
fn clock_stamp(local_secs: i64) -> String {
    let s = local_secs.rem_euclid(86_400);
    format!("[{:02}:{:02}:{:02}]", s / 3600, (s / 60) % 60, s % 60)
}

/// `YYYY-MM-DD_HHMMSS` for local wall-clock seconds (used in file names).
pub fn file_stamp(local_secs: i64) -> String {
    let (y, m, d) = civil_from_days(local_secs.div_euclid(86_400));
    let s = local_secs.rem_euclid(86_400);
    format!(
        "{y:04}-{m:02}-{d:02}_{:02}{:02}{:02}",
        s / 3600,
        (s / 60) % 60,
        s % 60
    )
}

/// Days since 1970-01-01 → (year, month, day) in the proleptic Gregorian
/// calendar (Howard Hinnant's `civil_from_days`). std has no calendar and
/// chrono isn't a dependency.
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = (if mp < 10 { mp + 3 } else { mp - 9 }) as u32;
    let y = yoe + era * 400 + i64::from(m <= 2);
    (y, m, d)
}

/// Session name → a file-name stem that is valid on Windows, macOS and Linux.
pub fn sanitize_stem(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| {
            if c.is_control() || matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*') {
                '_'
            } else {
                c
            }
        })
        .collect();
    // Windows rejects trailing dots/spaces; a leading dot hides the file on Unix.
    let edge = |c: char| c == '.' || c.is_whitespace();
    let stem: String = cleaned
        .trim_matches(edge)
        .chars()
        .take(MAX_STEM_CHARS)
        .collect();
    let stem = stem.trim_matches(edge);
    if stem.is_empty() {
        "session".to_string()
    } else {
        stem.to_string()
    }
}

/// The folder logs go to: the user's chosen folder, else `<app data>/logs`.
pub fn resolve_dir(app_dir: &Path, custom: Option<&str>) -> Result<PathBuf, String> {
    match custom.map(str::trim).filter(|s| !s.is_empty()) {
        None => Ok(app_dir.join("logs")),
        Some(dir) => {
            let dir = PathBuf::from(dir);
            // A relative path would land wherever the app's working dir is.
            if dir.is_absolute() {
                Ok(dir)
            } else {
                Err(format!("Log folder must be a full path: {}", dir.display()))
            }
        }
    }
}

/// Local wall-clock seconds for a UTC offset (the frontend sends its own,
/// since std can't read the OS time zone).
fn local_now(utc_offset_secs: i64) -> i64 {
    let utc = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    utc + utc_offset_secs
}

/// Create a log file new, owner-only (0600) from the moment it exists on Unix —
/// terminal output can contain pasted credentials / device secrets, so it must
/// never be briefly group/world-readable between create and chmod.
#[cfg(unix)]
fn open_log_file(path: &Path) -> io::Result<File> {
    use std::os::unix::fs::OpenOptionsExt;
    std::fs::OpenOptions::new()
        .create_new(true)
        .append(true)
        .mode(0o600)
        .open(path)
}
#[cfg(not(unix))]
fn open_log_file(path: &Path) -> io::Result<File> {
    std::fs::OpenOptions::new()
        .create_new(true)
        .append(true)
        .open(path)
}

/// Create `<stem>_<stamp>.log` in `dir`, adding `-2`, `-3`, … when the name is
/// taken (two tabs to one host started in the same second) — two sessions must
/// never append into the same file.
fn create_unique(dir: &Path, stem: &str, stamp: &str) -> io::Result<(File, PathBuf)> {
    std::fs::create_dir_all(dir)?;
    for n in 1..100 {
        let name = if n == 1 {
            format!("{stem}_{stamp}.log")
        } else {
            format!("{stem}_{stamp}-{n}.log")
        };
        let path = dir.join(name);
        match open_log_file(&path) {
            Ok(file) => return Ok((file, path)),
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e),
        }
    }
    Err(io::Error::new(
        io::ErrorKind::AlreadyExists,
        "too many log files with the same name",
    ))
}

/// One open session log.
pub struct SessionLog {
    file: File,
    path: PathBuf,
    cleaner: LogCleaner,
    utc_offset_secs: i64,
}

impl SessionLog {
    /// Create a new log for session `name` in `dir`.
    pub fn create(
        dir: &Path,
        name: &str,
        timestamps: bool,
        utc_offset_minutes: i32,
    ) -> io::Result<Self> {
        // Real offsets are within ±14h; clamp so a bogus value can't skew dates.
        let utc_offset_secs = i64::from(utc_offset_minutes.clamp(-24 * 60, 24 * 60)) * 60;
        let stamp = file_stamp(local_now(utc_offset_secs));
        let (file, path) = create_unique(dir, &sanitize_stem(name), &stamp)?;
        Ok(Self {
            file,
            path,
            cleaner: LogCleaner::new(timestamps),
            utc_offset_secs,
        })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Clean and append one chunk of session output.
    pub fn write_chunk(&mut self, data: &[u8]) -> io::Result<()> {
        let text = self.cleaner.feed(data, local_now(self.utc_offset_secs));
        if text.is_empty() {
            return Ok(());
        }
        self.file.write_all(text.as_bytes())
    }
}

impl Drop for SessionLog {
    fn drop(&mut self) {
        // Keep the unfinished last line (usually the prompt) so the log ends
        // where the screen did.
        let tail = self.cleaner.finish(local_now(self.utc_offset_secs));
        if !tail.is_empty() {
            let _ = self.file.write_all(tail.as_bytes());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn clean(chunks: &[&[u8]]) -> String {
        let mut c = LogCleaner::new(false);
        let mut out = String::new();
        for chunk in chunks {
            out.push_str(&c.feed(chunk, 0));
        }
        out.push_str(&c.finish(0));
        out
    }

    #[test]
    fn strips_colors_and_normalizes_crlf() {
        let raw = b"\x1b[1;32mswitch#\x1b[0m show vlan\r\nVLAN  Name\r\n1     DEFAULT\r\n";
        assert_eq!(
            clean(&[raw]),
            "switch# show vlan\nVLAN  Name\n1     DEFAULT\n"
        );
    }

    #[test]
    fn strips_osc_title_and_charset_and_private_modes() {
        let raw = b"\x1b]0;core-sw1\x07\x1b(B\x1b[?25l\x1b[?1049hhello\x1b]2;t\x1b\\ world\n";
        assert_eq!(clean(&[raw]), "hello world\n");
    }

    #[test]
    fn drops_lone_controls_but_keeps_tabs() {
        assert_eq!(clean(&[b"a\x07b\x00c\td\x0e\n"]), "abc\td\n");
    }

    #[test]
    fn sequences_split_across_chunks() {
        // CSI split mid-params, OSC split before its terminator, and a UTF-8
        // character split between its bytes.
        let out = clean(&[
            b"one\x1b[3",
            b"1mred\x1b[0",
            b"m\r\n\x1b]0;ti",
            b"tle\x07two \xe2\x94",
            b"\x80\r\n",
        ]);
        assert_eq!(out, "onered\ntwo \u{2500}\n");
    }

    #[test]
    fn carriage_return_overwrites_and_erase_line_clears() {
        // Pager prompt erased with CR + ESC[K, then real output replaces it.
        let out = clean(&[b"--More--\r\x1b[Kinterface 1/1/1\r\n"]);
        assert_eq!(out, "interface 1/1/1\n");
        // Progress counter redrawn in place with bare CRs.
        assert_eq!(clean(&[b"10%\r20%\r100%\r\n"]), "100%\n");
        // AOS-S style "\n\r" line endings don't double-space.
        assert_eq!(clean(&[b"a\n\rb\n\r"]), "a\nb\n");
    }

    #[test]
    fn backspace_edits_apply() {
        // Typed "shw", erased with BS-space-BS, retyped.
        assert_eq!(clean(&[b"sw# shw\x08 \x08\x08 \x08how\r\n"]), "sw# show\n");
        // Line editor style: cursor left + delete char.
        assert_eq!(clean(&[b"abcX\x1b[D\x1b[P\n"]), "abc\n");
    }

    #[test]
    fn cursor_position_keeps_column() {
        // AOS-S redraws its prompt at column 1 of the bottom row.
        assert_eq!(clean(&[b"junk\x1b[24;1H\x1b[2KHP-2920# \n"]), "HP-2920#\n");
    }

    #[test]
    fn partial_line_waits_for_newline_then_flushes_on_finish() {
        let mut c = LogCleaner::new(false);
        assert_eq!(c.feed(b"line\r\nsw1# ", 0), "line\n");
        assert_eq!(c.feed(b"sh", 0), "");
        assert_eq!(c.finish(0), "sw1# sh\n");
        assert_eq!(c.finish(0), "");
    }

    #[test]
    fn timestamps_prefix_each_line() {
        let mut c = LogCleaner::new(true);
        // 13:05:09 local
        let t = 13 * 3600 + 5 * 60 + 9;
        assert_eq!(
            c.feed(b"a\r\n\r\nb\n", t),
            "[13:05:09] a\n[13:05:09]\n[13:05:09] b\n"
        );
    }

    #[test]
    fn unterminated_string_gives_up() {
        let mut raw = b"\x1b]0;".to_vec();
        raw.resize(raw.len() + MAX_STRING_BYTES + 10, b'x');
        raw.extend_from_slice(b"\nok\n");
        // The runaway string is abandoned; output after it survives.
        assert!(clean(&[&raw]).ends_with("ok\n"));
    }

    #[test]
    fn long_lines_are_split() {
        let raw = vec![b'x'; MAX_LINE_CHARS + 5];
        let out = clean(&[&raw]);
        assert_eq!(out.lines().count(), 2);
        assert_eq!(out.lines().next().unwrap().len(), MAX_LINE_CHARS);
    }

    #[test]
    fn invalid_utf8_becomes_replacement() {
        assert_eq!(clean(&[b"a\xffb\xe2(\n"]), "a\u{FFFD}b\u{FFFD}(\n");
    }

    #[test]
    fn stamps_and_dates() {
        assert_eq!(file_stamp(0), "1970-01-01_000000");
        assert_eq!(file_stamp(951_782_400), "2000-02-29_000000");
        assert_eq!(file_stamp(1_790_000_000), "2026-09-21_141320");
        assert_eq!(file_stamp(-86_400), "1969-12-31_000000");
        assert_eq!(file_stamp(4_102_444_800), "2100-01-01_000000");
        assert_eq!(clock_stamp(-1), "[23:59:59]");
    }

    #[test]
    fn stems_are_windows_safe() {
        assert_eq!(sanitize_stem("core-sw1"), "core-sw1");
        assert_eq!(sanitize_stem("10.0.0.1"), "10.0.0.1");
        assert_eq!(
            sanitize_stem("a:b/c\\d*e?f\"g<h>i|j"),
            "a_b_c_d_e_f_g_h_i_j"
        );
        assert_eq!(sanitize_stem("  .hidden. "), "hidden");
        assert_eq!(sanitize_stem("fe80::1"), "fe80__1");
        assert_eq!(sanitize_stem("..."), "session");
        assert_eq!(sanitize_stem(&"x".repeat(200)).len(), MAX_STEM_CHARS);
    }

    #[test]
    fn resolve_dir_requires_absolute_custom_path() {
        let app = Path::new("/tmp/app");
        assert_eq!(resolve_dir(app, None).unwrap(), app.join("logs"));
        assert_eq!(resolve_dir(app, Some("  ")).unwrap(), app.join("logs"));
        assert!(resolve_dir(app, Some("relative/logs")).is_err());
        let abs = std::env::temp_dir();
        assert_eq!(resolve_dir(app, abs.to_str()).unwrap(), abs);
    }

    #[test]
    fn creates_unique_files_and_flushes_tail_on_drop() {
        let dir = std::env::temp_dir().join(format!("greencli-log-test-{}", rand::random::<u64>()));
        let a = SessionLog::create(&dir, "sw:1", false, 0).unwrap();
        let mut b = SessionLog::create(&dir, "sw:1", false, 0).unwrap();
        assert_ne!(a.path(), b.path());
        let name = a.path().file_name().unwrap().to_string_lossy().into_owned();
        assert!(
            name.starts_with("sw_1_") && name.ends_with(".log"),
            "{name}"
        );
        b.write_chunk(b"\x1b[32mok\x1b[0m\r\nsw1# ").unwrap();
        let path = b.path().to_path_buf();
        drop(b);
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "ok\nsw1#\n");
        drop(a);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
