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
    let mut local_file = tokio::fs::File::create(local_path)
        .await
        .map_err(|e| AppError::SshError(format!("Create local '{}': {}", local_path, e)))?;
    // Stream in chunks rather than buffering the whole file in RAM — a firmware
    // image / capture can be GBs and would otherwise OOM the app.
    let len = tokio::io::copy(&mut remote_file, &mut local_file)
        .await
        .map_err(|e| AppError::SshError(format!("SFTP download '{}': {}", remote_path, e)))?;
    local_file.flush().await.ok();
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
    // Stream in chunks rather than reading the whole local file into RAM.
    let len = tokio::io::copy(&mut local_file, &mut remote_file)
        .await
        .map_err(|e| AppError::SshError(format!("SFTP upload '{}': {}", remote_path, e)))?;
    remote_file.shutdown().await.ok();
    Ok(len)
}
