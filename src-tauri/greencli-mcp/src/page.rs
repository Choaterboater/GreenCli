//! Paging: every answer stays well under the 16 KiB result cap. Cursors are
//! opaque `v1:` strings that name the tool, what was asked and where the next
//! page starts.

use serde_json::{json, Value};

/// Room for the items or text of one page. The rest of the answer (names,
/// counts, the cursor) fits in what is left of 16 KiB.
pub const PAGE_BUDGET: usize = 12 * 1024;

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

/// Items from `start` that fit in `budget` bytes of JSON, and where the next
/// page starts. At least one item is taken, so each item must be small.
pub fn take_items(items: &[Value], start: usize, budget: usize) -> (Vec<Value>, Option<usize>) {
    let mut used = 0;
    let mut out = Vec::new();
    let mut i = start;
    while i < items.len() {
        let size = items[i].to_string().len() + 1;
        if !out.is_empty() && used + size > budget {
            break;
        }
        used += size;
        out.push(items[i].clone());
        i += 1;
    }
    let next = (i < items.len()).then_some(i);
    (out, next)
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
    fn items_page() {
        let items: Vec<Value> = (0..100).map(|i| json!({ "n": i })).collect();
        let (first, next) = take_items(&items, 0, 100);
        assert!(!first.is_empty());
        let next = next.unwrap();
        assert_eq!(next, first.len());
        let (all, none) = take_items(&items, 0, 1 << 20);
        assert_eq!(all.len(), 100);
        assert!(none.is_none());
    }
}
