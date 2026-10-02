//! Newline-delimited JSON-RPC over a byte stream. stdout carries protocol
//! messages only; anything else goes to stderr.

use serde_json::Value;
use std::io::{self, BufRead, Write};

/// The longest request line read. Every request this server takes is small.
pub const MAX_LINE: usize = 1024 * 1024;

pub enum Line {
    Text(Vec<u8>),
    /// Longer than MAX_LINE. The rest of it was read and dropped.
    TooLong,
    Eof,
}

/// Read one line (without its newline). A line over `max` bytes is skipped
/// to its end and reported as TooLong, so it never fills memory.
pub fn read_line<R: BufRead>(reader: &mut R, max: usize) -> io::Result<Line> {
    let mut line = Vec::new();
    let mut too_long = false;
    let mut saw_any = false;
    loop {
        let (done, used) = {
            let buf = match reader.fill_buf() {
                Ok(b) => b,
                Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
                Err(e) => return Err(e),
            };
            if buf.is_empty() {
                (true, 0)
            } else {
                saw_any = true;
                match buf.iter().position(|b| *b == b'\n') {
                    Some(i) => {
                        if !too_long && line.len() + i <= max {
                            line.extend_from_slice(&buf[..i]);
                        } else {
                            too_long = true;
                        }
                        (true, i + 1)
                    }
                    None => {
                        if !too_long && line.len() + buf.len() <= max {
                            line.extend_from_slice(buf);
                        } else {
                            too_long = true;
                            line.clear();
                        }
                        (false, buf.len())
                    }
                }
            }
        };
        reader.consume(used);
        if done {
            break;
        }
    }
    if !saw_any {
        return Ok(Line::Eof);
    }
    if too_long {
        return Ok(Line::TooLong);
    }
    if line.last() == Some(&b'\r') {
        line.pop();
    }
    Ok(Line::Text(line))
}

/// Write one message as a single line and flush it.
pub fn write_message<W: Write>(writer: &mut W, message: &Value) -> io::Result<()> {
    let mut text = serde_json::to_vec(message).map_err(io::Error::other)?;
    text.push(b'\n');
    writer.write_all(&text)?;
    writer.flush()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lines(input: &[u8], max: usize) -> Vec<String> {
        let mut r = io::BufReader::with_capacity(4, input);
        let mut out = Vec::new();
        loop {
            match read_line(&mut r, max).unwrap() {
                Line::Text(t) => out.push(String::from_utf8(t).unwrap()),
                Line::TooLong => out.push("<too long>".into()),
                Line::Eof => return out,
            }
        }
    }

    #[test]
    fn splits_lines_and_drops_long_ones() {
        assert_eq!(lines(b"ab\ncd\r\n", 10), ["ab", "cd"]);
        assert_eq!(
            lines(b"ab\n0123456789xyz\nef", 10),
            ["ab", "<too long>", "ef"]
        );
        assert_eq!(lines(b"0123456789", 10), ["0123456789"]);
        assert_eq!(lines(b"", 10), Vec::<String>::new());
        assert_eq!(lines(b"\n", 10), [""]);
    }
}
