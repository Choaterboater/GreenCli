// SFTP file transfer over an existing SSH session.
// Uses russh-sftp to open a subsystem channel on the active SSH handle.

use crate::error::AppError;
use russh::client::Handle;
use russh_sftp::client::SftpSession;
use serde::{Deserialize, Serialize};
use tokio::io::AsyncWriteExt;

use crate::ssh::client::ClientHandler;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RemoteEntry {
    pub name: String,
    pub is_dir: bool,
    pub size: u64,
}

/// Open an SFTP session on an existing SSH handle.
pub async fn open_sftp(handle: &mut Handle<ClientHandler>) -> Result<SftpSession, AppError> {
    let channel = handle
        .channel_open_session()
        .await
        .map_err(|e| AppError::SshError(format!("SFTP channel open failed: {}", e)))?;
    channel
        .request_subsystem(true, "sftp")
        .await
        .map_err(|e| AppError::SshError(format!("SFTP subsystem request failed: {}", e)))?;
    let sftp = SftpSession::new(channel.into_stream())
        .await
        .map_err(|e| AppError::SshError(format!("SFTP session init failed: {}", e)))?;
    Ok(sftp)
}

/// List a remote directory.
pub async fn list_dir(sftp: &SftpSession, path: &str) -> Result<Vec<RemoteEntry>, AppError> {
    let entries = sftp
        .read_dir(path)
        .await
        .map_err(|e| AppError::SshError(format!("SFTP readdir '{}': {}", path, e)))?;
    let mut result = Vec::new();
    for entry in entries {
        let name = entry.file_name();
        if name == "." || name == ".." {
            continue;
        }
        let is_dir = entry.file_type().is_dir();
        let size = entry.metadata().len();
        result.push(RemoteEntry { name, is_dir, size });
    }
    result.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then_with(|| a.name.cmp(&b.name)));
    Ok(result)
}

/// Download a remote file to a local path.
pub async fn download(
    sftp: &SftpSession,
    remote_path: &str,
    local_path: &str,
) -> Result<u64, AppError> {
    let mut remote_file = sftp
        .open(remote_path)
        .await
        .map_err(|e| AppError::SshError(format!("SFTP open '{}': {}", remote_path, e)))?;
    // Write to a sibling temp file and atomically rename on success. A failed or
    // aborted transfer then never truncates or replaces the user's existing file
    // (tokio::fs::rename replaces the destination atomically on every platform).
    let tmp_path = format!("{}.part", local_path);
    let mut local_file = tokio::fs::File::create(&tmp_path)
        .await
        .map_err(|e| AppError::SshError(format!("Create local '{}': {}", tmp_path, e)))?;
    // Stream in chunks rather than buffering the whole file in RAM — a firmware
    // image / capture can be GBs and would otherwise OOM the app. Buffer 256 KiB
    // per read so each SFTP READ fills the negotiated max packet (~256 KiB) rather
    // than tokio::io::copy's fixed 8 KiB, cutting round-trips ~32x on high-RTT links.
    let mut reader = tokio::io::BufReader::with_capacity(256 * 1024, &mut remote_file);
    let len = match tokio::io::copy_buf(&mut reader, &mut local_file).await {
        Ok(n) => n,
        Err(e) => {
            let _ = tokio::fs::remove_file(&tmp_path).await;
            return Err(AppError::SshError(format!(
                "SFTP download '{}': {}",
                remote_path, e
            )));
        }
    };
    // A failed final write (disk full, quota) must not report success.
    if let Err(e) = local_file.flush().await {
        drop(local_file);
        let _ = tokio::fs::remove_file(&tmp_path).await;
        return Err(AppError::SshError(format!(
            "Write local '{}': {}",
            local_path, e
        )));
    }
    // Close the fd before renaming — Windows rejects renaming an open file.
    drop(local_file);
    if let Err(e) = tokio::fs::rename(&tmp_path, local_path).await {
        let _ = tokio::fs::remove_file(&tmp_path).await;
        return Err(AppError::SshError(format!(
            "Finalize local '{}': {}",
            local_path, e
        )));
    }
    Ok(len)
}

/// Create a remote directory.
pub async fn mkdir(sftp: &SftpSession, path: &str) -> Result<(), AppError> {
    sftp.create_dir(path)
        .await
        .map_err(|e| AppError::SshError(format!("SFTP mkdir '{}': {}", path, e)))
}

/// Remove a remote file.
pub async fn remove_file(sftp: &SftpSession, path: &str) -> Result<(), AppError> {
    sftp.remove_file(path)
        .await
        .map_err(|e| AppError::SshError(format!("SFTP rm '{}': {}", path, e)))
}

/// Remove a remote (empty) directory.
pub async fn remove_dir(sftp: &SftpSession, path: &str) -> Result<(), AppError> {
    sftp.remove_dir(path)
        .await
        .map_err(|e| AppError::SshError(format!("SFTP rmdir '{}': {}", path, e)))
}

/// Rename / move a remote path.
pub async fn rename(sftp: &SftpSession, from: &str, to: &str) -> Result<(), AppError> {
    sftp.rename(from, to)
        .await
        .map_err(|e| AppError::SshError(format!("SFTP rename '{}'→'{}': {}", from, to, e)))
}

/// Upload a local file to a remote path. When `overwrite` is false and the remote
/// path already exists, returns a distinguishable `EEXIST:` error so the UI can
/// confirm before clobbering it (e.g. a device running-config / firmware file).
pub async fn upload(
    sftp: &SftpSession,
    local_path: &str,
    remote_path: &str,
    overwrite: bool,
) -> Result<u64, AppError> {
    if !overwrite && sftp.metadata(remote_path).await.is_ok() {
        return Err(AppError::ApiError(format!(
            "EEXIST: '{}' already exists on the remote",
            remote_path
        )));
    }
    let mut local_file = tokio::fs::File::open(local_path)
        .await
        .map_err(|e| AppError::SshError(format!("Open local '{}': {}", local_path, e)))?;
    let mut remote_file = sftp
        .create(remote_path)
        .await
        .map_err(|e| AppError::SshError(format!("SFTP create '{}': {}", remote_path, e)))?;
    // Stream in chunks rather than reading the whole local file into RAM. Buffer
    // the local reads at 256 KiB so we emit fewer, fuller WRITE packets and keep
    // russh-sftp's write pipeline full (do NOT buffer the remote writer — that
    // would coalesce writes and defeat its concurrent-write pipelining).
    let mut reader = tokio::io::BufReader::with_capacity(256 * 1024, &mut local_file);
    let len = match tokio::io::copy_buf(&mut reader, &mut remote_file).await {
        Ok(n) => n,
        Err(e) => {
            // Don't leave a truncated file at the real remote path on failure.
            let _ = remote_file.shutdown().await;
            let _ = sftp.remove_file(remote_path).await;
            return Err(AppError::SshError(format!(
                "SFTP upload '{}': {}",
                remote_path, e
            )));
        }
    };
    // shutdown() carries the SFTP flush/close status — ignoring it reported
    // truncated/failed uploads as successful. A failed close must likewise not
    // leave a truncated file behind.
    if let Err(e) = remote_file.shutdown().await {
        let _ = sftp.remove_file(remote_path).await;
        return Err(AppError::SshError(format!(
            "SFTP close '{}': {}",
            remote_path, e
        )));
    }
    Ok(len)
}
