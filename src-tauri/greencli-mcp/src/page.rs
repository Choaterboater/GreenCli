//! Paging: every answer stays well under the 16 KiB result cap. Cursors are
//! opaque `v1:` strings that name the tool, what was asked and where the next
//! page starts.

use serde_json::{json, Value};

/// Room for the items or text of one page. The rest of the answer (names,
/// counts, the cursor) fits in what is left of 16 KiB.
pub const PAGE_BUDGET: usize = 12 * 1024;

/// Most items on one page. Casper cuts every list to 50 items and keeps the
/// cursor, so a longer page would skip the items it cut.
pub const MAX_PAGE_ITEMS: usize = 50;

pub const BAD_CURSOR: &str = "That cursor doesn't fit this request. Start again without a cursor.";

const PREFIX: &str = "v1:";
const MAX_CURSOR: usize = 4096;

/// What a cursor holds: the request it belongs to and where the next page starts.
pub struct Cursor {
    pub key: Value,
    pub offset: usize,
}

pub fn make_cursor(tool: &str, key: &Value, offset: usize) -> String {
    let text = json!([tool, key, offset]).to_string();
    let mut out = String::with_capacity(PREFIX.len() + text.len() * 2);
    out.push_str(PREFIX);
    for b in text.bytes() {
        out.push_str(&format!("{b:02x}"));
    }
    out
}

/// Read a cursor made for `tool`. None when it is malformed or for another tool.
pub fn read_cursor(tool: &str, cursor: &str) -> Option<Cursor> {
    if cursor.len() > MAX_CURSOR {
        return None;
    }
    let hex = cursor.strip_prefix(PREFIX)?;
    if hex.len() % 2 != 0 {
        return None;
    }
    let mut bytes = Vec::with_capacity(hex.len() / 2);
    for pair in hex.as_bytes().chunks(2) {
        let pair = std::str::from_utf8(pair).ok()?;
        bytes.push(u8::from_str_radix(pair, 16).ok()?);
    }
    let value: Value = serde_json::from_slice(&bytes).ok()?;
    let parts = value.as_array()?;
    if parts.len() != 3 || parts[0].as_str() != Some(tool) {
        return None;
    }
    let offset = usize::try_from(parts[2].as_u64()?).ok()?;
    Some(Cursor {
        key: parts[1].clone(),
        offset,
    })
}

/// Items from `start` that fit in `budget` bytes of JSON, at most
/// `MAX_PAGE_ITEMS` of them, and where the next page starts. At least one
/// item is taken, so each item must be small.
pub fn take_items(items: &[Value], start: usize, budget: usize) -> (Vec<Value>, Option<usize>) {
    let mut used = 0;
    let mut out = Vec::new();
    let mut i = start;
    while i < items.len() {
        let size = items[i].to_string().len() + 1;
        if out.len() == MAX_PAGE_ITEMS || (!out.is_empty() && used + size > budget) {
            break;
        }
        used += size;
        out.push(items[i].clone());
        i += 1;
    }
    let next = (i < items.len()).then_some(i);
    (out, next)
}

/// Bytes `c` takes inside a JSON string.
fn escaped_len(c: char) -> usize {
    match c {
        '"' | '\\' | '\n' | '\r' | '\t' | '\u{8}' | '\u{c}' => 2,
        c if (c as u32) < 0x20 => 6,
        c => c.len_utf8(),
    }
}

/// A piece of `text` from byte `start`: whole lines that fit in `budget`
/// bytes once escaped for JSON, or part of one line when a single line is
/// longer than that. Returns the end of the piece, or None when `start` is
/// not a place a page can start.
pub fn take_text(text: &str, start: usize, budget: usize) -> Option<usize> {
    if start > text.len() || !text.is_char_boundary(start) {
        return None;
    }
    let mut used = 0;
    let mut end = start;
    let mut last_line_end = None;
    for (i, c) in text[start..].char_indices() {
        let size = escaped_len(c);
        if used + size > budget {
            break;
        }
        used += size;
        end = start + i + c.len_utf8();
        if c == '\n' {
            last_line_end = Some(end);
        }
    }
    if end == text.len() {
        return Some(end);
    }
    Some(last_line_end.unwrap_or(end))
}

/// 1-based line number of byte `at` in `text`.
pub fn line_at(text: &str, at: usize) -> usize {
    text.as_bytes()[..at]
        .iter()
        .filter(|b| **b == b'\n')
        .count()
        + 1
}

/// At most `max` characters of `text`, with "…" when it was cut.
pub fn clip(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    let mut out: String = text.chars().take(max.saturating_sub(1)).collect();
    out.push('…');
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cursors_round_trip_and_reject_others() {
        let c = make_cursor("get_config", &json!(["sw1", 5]), 42);
        assert!(c.starts_with("v1:"));
        let back = read_cursor("get_config", &c).unwrap();
        assert_eq!(back.key, json!(["sw1", 5]));
        assert_eq!(back.offset, 42);
        assert!(read_cursor("list_devices", &c).is_none());
        assert!(read_cursor("get_config", "v1:zz").is_none());
        assert!(read_cursor("get_config", "v2:00").is_none());
        assert!(read_cursor("get_config", "garbage").is_none());
        assert!(read_cursor("get_config", &"v1:00".repeat(2000)).is_none());
    }

    #[test]
    fn text_pages_cover_everything_once() {
        let text: String = (0..500).map(|i| format!("line {i} \"quoted\"\n")).collect();
        let mut start = 0;
        let mut joined = String::new();
        while start < text.len() {
            let end = take_text(&text, start, 1000).unwrap();
            assert!(end > start);
            let piece = &text[start..end];
            assert!(serde_json::to_string(piece).unwrap().len() <= 1002);
            joined.push_str(piece);
            start = end;
        }
        assert_eq!(joined, text);
    }

    #[test]
    fn a_long_line_is_split() {
        let text = format!("{}\nshort\n", "é".repeat(5000));
        let end = take_text(&text, 0, 1000).unwrap();
        assert!(end > 0 && end < 5000 * 2);
        assert!(text.is_char_boundary(end));
        assert!(take_text(&text, 1, 1000).is_none());
        assert!(take_text(&text, text.len() + 1, 1000).is_none());
    }

    #[test]
    fn items_page() {
        let items: Vec<Value> = (0..100).map(|i| json!({ "n": i })).collect();
        let (first, next) = take_items(&items, 0, 100);
        assert!(!first.is_empty());
        let next = next.unwrap();
        assert_eq!(next, first.len());
        let (rest, none) = take_items(&items, 60, 1 << 20);
        assert_eq!(rest.len(), 40);
        assert_eq!(rest[0], json!({ "n": 60 }));
        assert!(none.is_none());
    }

    #[test]
    fn a_page_holds_at_most_fifty_items() {
        let items: Vec<Value> = (0..120).map(|i| json!(i)).collect();
        let mut start = 0;
        let mut pages = Vec::new();
        loop {
            let (page, next) = take_items(&items, start, 1 << 20);
            pages.push((page.len(), next));
            match next {
                Some(n) => start = n,
                None => break,
            }
        }
        assert_eq!(pages, [(50, Some(50)), (50, Some(100)), (20, None)]);
    }
}
