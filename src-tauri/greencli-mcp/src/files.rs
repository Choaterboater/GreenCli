//! Reading GreenCLI's files. Read-only: files are only opened for reading and
//! never changed. A file that is a link, or bigger than its cap, is refused.

use std::fs;
use std::io::Read;
use std::path::Path;

pub enum ReadFile {
    Missing,
    Bytes(Vec<u8>),
}

pub enum ReadError {
    /// Not a plain file (a link or a folder), or unreadable.
    NotPlain,
    TooBig,
}

/// Read a plain file of at most `cap` bytes.
pub fn read_capped(path: &Path, cap: u64) -> Result<ReadFile, ReadError> {
    let meta = match fs::symlink_metadata(path) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(ReadFile::Missing),
        Err(_) => return Err(ReadError::NotPlain),
    };
    if !meta.file_type().is_file() {
        return Err(ReadError::NotPlain);
    }
    if meta.len() > cap {
        return Err(ReadError::TooBig);
    }
    let file = fs::File::open(path).map_err(|_| ReadError::NotPlain)?;
    let mut bytes = Vec::new();
    file.take(cap + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| ReadError::NotPlain)?;
    if bytes.len() as u64 > cap {
        return Err(ReadError::TooBig);
    }
    Ok(ReadFile::Bytes(bytes))
}

/// Whether `path` is a plain file of at most `cap` bytes, without reading it.
pub fn is_plain_file(path: &Path, cap: u64) -> bool {
    fs::symlink_metadata(path).is_ok_and(|m| m.file_type().is_file() && m.len() <= cap)
}
