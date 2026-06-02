use serde::Serialize;
use std::fmt;

#[derive(Debug, Serialize)]
pub enum AppError {
    SshError(String),
    TelnetError(String),
    SerialError(String),
    LocalError(String),
    VaultError(String),
    IoError(String),
    SessionNotFound(String),
    ConfigError(String),
    AuthError(String),
    ApiError(String),
}

impl fmt::Display for AppError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            AppError::SshError(msg) => write!(f, "SSH Error: {}", msg),
            AppError::TelnetError(msg) => write!(f, "Telnet Error: {}", msg),
            AppError::SerialError(msg) => write!(f, "Serial Error: {}", msg),
            AppError::LocalError(msg) => write!(f, "Local Error: {}", msg),
            AppError::VaultError(msg) => write!(f, "Vault Error: {}", msg),
            AppError::IoError(msg) => write!(f, "IO Error: {}", msg),
            AppError::SessionNotFound(msg) => write!(f, "Session Not Found: {}", msg),
            AppError::ConfigError(msg) => write!(f, "Config Error: {}", msg),
            AppError::AuthError(msg) => write!(f, "Auth Error: {}", msg),
            AppError::ApiError(msg) => write!(f, "API Error: {}", msg),
        }
    }
}

impl std::error::Error for AppError {}

impl From<std::io::Error> for AppError {
    fn from(err: std::io::Error) -> Self {
        AppError::IoError(err.to_string())
    }
}

impl From<russh::Error> for AppError {
    fn from(err: russh::Error) -> Self {
        AppError::SshError(err.to_string())
    }
}

impl From<serde_json::Error> for AppError {
    fn from(err: serde_json::Error) -> Self {
        AppError::ConfigError(err.to_string())
    }
}

impl From<reqwest::Error> for AppError {
    fn from(err: reqwest::Error) -> Self {
        AppError::ApiError(err.to_string())
    }
}
