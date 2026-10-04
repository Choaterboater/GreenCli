//! Recent terminal output per session, kept as text so the AI assistant can
//! read back command results.

/// A bounded tail of a session's output. Chunks can end partway through a
/// UTF-8 character, so up to 3 leftover bytes wait for the next chunk instead
/// of turning into U+FFFD (the session log and the terminal do the same).
#[derive(Default)]
pub struct TerminalBuffer {
    text: String,
    pending: Vec<u8>,
}

impl TerminalBuffer {
    /// Append one output chunk and keep a bounded tail (~150KB) on a char boundary.
    pub fn push(&mut self, data: &[u8]) {
        let mut bytes = std::mem::take(&mut self.pending);
        bytes.extend_from_slice(data);
        let mut rest: &[u8] = &bytes;
        loop {
            match std::str::from_utf8(rest) {
                Ok(s) => {
                    self.text.push_str(s);
                    break;
                }
                Err(e) => {
                    let (good, after) = rest.split_at(e.valid_up_to());
                    // valid_up_to() always marks valid UTF-8.
                    self.text
                        .push_str(std::str::from_utf8(good).unwrap_or_default());
                    match e.error_len() {
                        Some(n) => {
                            self.text.push('\u{FFFD}');
                            rest = &after[n..];
                        }
                        // The chunk ends inside a character: carry it over.
                        None => {
                            self.pending = after.to_vec();
                            break;
                        }
                    }
                }
            }
        }
        if self.text.len() > 200_000 {
            let mut cut = self.text.len() - 150_000;
            while cut < self.text.len() && !self.text.is_char_boundary(cut) {
                cut += 1;
            }
            self.text = self.text[cut..].to_string();
        }
    }

    pub fn text(&self) -> &str {
        &self.text
    }
}

#[cfg(test)]
mod tests {
    use super::TerminalBuffer;

    #[test]
    fn a_character_split_across_chunks_comes_out_whole() {
        let bytes = "é ✓ 🙂".as_bytes();
        for split in 0..=bytes.len() {
            let mut buf = TerminalBuffer::default();
            buf.push(&bytes[..split]);
            buf.push(&bytes[split..]);
            assert_eq!(buf.text(), "é ✓ 🙂", "split at byte {split}");
        }
    }

    #[test]
    fn a_four_byte_character_split_into_single_bytes_comes_out_whole() {
        let mut buf = TerminalBuffer::default();
        for b in "a🙂b".as_bytes() {
            buf.push(&[*b]);
        }
        assert_eq!(buf.text(), "a🙂b");
    }

    #[test]
    fn bad_bytes_still_show_as_a_replacement_character() {
        let mut buf = TerminalBuffer::default();
        buf.push(b"a\xffb");
        buf.push(b"\xe2\x9c");
        buf.push(b"c");
        assert_eq!(buf.text(), "a\u{FFFD}b\u{FFFD}c");
    }

    #[test]
    fn keeps_a_bounded_tail_on_a_char_boundary() {
        let mut buf = TerminalBuffer::default();
        let chunk = "é".repeat(1_000);
        for _ in 0..150 {
            buf.push(chunk.as_bytes());
        }
        assert!(buf.text().len() <= 200_000);
        assert!(buf.text().len() >= 150_000);
        assert!(buf.text().chars().all(|c| c == 'é'));
    }
}
