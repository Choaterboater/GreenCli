//! The show-only rule for live show commands: the one line an AI tool outside
//! GreenCLI may ask to run on a connected device. GreenCLI's app calls this
//! same function, and its webview has the same rule in TypeScript
//! (isPlainShow in src/utils/mcpPresets.ts). This crate, the app
//! (src-tauri/src/mcp/presets.rs) and vitest all run the vectors in
//! testdata/show_only_cases.json.
//!
//! It extends the Junos plain-show rule (is_plain_junos_show in presets.rs):
//! - one line, never empty, at most 256 characters;
//! - only letters, digits, space, tab and . _ / : @ , = + - | (the Read-only
//!   Auditor's characters, without quotes), so nothing a device CLI or shell
//!   treats specially gets through;
//! - the literal first word `show` (no `do`, no `sh`), then a word starting
//!   with a letter;
//! - every `|` stage starts with a read-only filter: the Junos ones, or
//!   include, exclude, begin, section and their short forms. Never `s` (save
//!   on Junos), grep, head, tail, wc or any pipe that writes a file.

/// The longest line allowed.
pub const MAX_SHOW_LEN: usize = 256;

#[rustfmt::skip]
const SHOW_PIPES: &[&str] = &[
    // Junos (the same list as is_plain_junos_show).
    "match", "except", "count", "display", "no-more", "last", "find", "trim",
    // Aruba, Cisco and others, with their short forms.
    "i", "in", "inc", "incl", "inclu", "includ", "include",
    "e", "ex", "exc", "excl", "exclu", "exclud", "exclude",
    "b", "be", "beg", "begi", "begin",
    "sec", "sect", "secti", "sectio", "section",
];

fn show_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || " \t._/:@,=+|-".contains(c)
}

fn space(c: char) -> bool {
    c == ' ' || c == '\t'
}

/// True only for a plain `show` line with read-only filter pipes.
pub fn is_plain_show(line: &str) -> bool {
    if line.len() > MAX_SHOW_LEN || !line.chars().all(show_char) {
        return false;
    }
    let mut stages = line.split('|');
    let head: Vec<&str> = stages
        .next()
        .unwrap_or("")
        .split(space)
        .filter(|w| !w.is_empty())
        .collect();
    if head.first() != Some(&"show")
        || !head
            .get(1)
            .is_some_and(|w| w.starts_with(|c: char| c.is_ascii_alphabetic()))
    {
        return false;
    }
    stages.all(|stage| {
        stage
            .split(space)
            .find(|w| !w.is_empty())
            .is_some_and(|w| SHOW_PIPES.contains(&w))
    })
}
