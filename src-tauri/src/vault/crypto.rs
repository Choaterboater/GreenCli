use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes256Gcm, Nonce,
};
use argon2::Argon2;
use rand::rngs::OsRng;
use rand::RngCore;
use zeroize::Zeroizing;

use crate::error::AppError;

const NONCE_SIZE: usize = 12;
pub const KEY_SIZE: usize = 32;
pub const SALT_SIZE: usize = 16;

/// Generate a fresh random salt for a new vault. Persisted alongside the
/// ciphertext so the same key can be re-derived on every unlock.
pub fn generate_salt() -> [u8; SALT_SIZE] {
    let mut salt = [0u8; SALT_SIZE];
    OsRng.fill_bytes(&mut salt);
    salt
}

/// Derive a 32-byte AES key from a password + persisted salt using Argon2id.
///
/// Uses `hash_password_into` to fill the raw key buffer directly, rather than
/// truncating the PHC-encoded hash string (which was the previous bug). The
/// salt MUST be the same one persisted with the vault, otherwise the derived
/// key — and therefore decryption — will differ between runs.
pub fn derive_key(password: &str, salt: &[u8]) -> Result<[u8; KEY_SIZE], AppError> {
    let argon2 = Argon2::default();
    let mut key = [0u8; KEY_SIZE];
    argon2
        .hash_password_into(password.as_bytes(), salt, &mut key)
        .map_err(|e| AppError::VaultError(format!("Key derivation failed: {}", e)))?;
    Ok(key)
}

/// Holds the raw AES-256 key in a zeroizing buffer (wiped on drop) and rebuilds
/// the GCM key schedule per operation, so the long-lived secret never sits in a
/// non-zeroized cipher state for the life of the unlock.
pub struct VaultCipher {
    key: Zeroizing<[u8; KEY_SIZE]>,
}

impl VaultCipher {
    pub fn new(key: &[u8; KEY_SIZE]) -> Result<Self, AppError> {
        // Validate the key length up front (cannot fail for a [u8; 32], but keep
        // the error path so callers get a clean error rather than a panic).
        Aes256Gcm::new_from_slice(key)
            .map_err(|e| AppError::VaultError(format!("Cipher init: {}", e)))?;
        Ok(Self {
            key: Zeroizing::new(*key),
        })
    }

    fn cipher(&self) -> Aes256Gcm {
        // The stored key is always exactly KEY_SIZE bytes, so this cannot fail.
        Aes256Gcm::new_from_slice(self.key.as_ref()).expect("vault key is 32 bytes")
    }

    pub fn encrypt(&self, plaintext: &[u8]) -> Result<Vec<u8>, AppError> {
        let mut nonce_bytes = [0u8; NONCE_SIZE];
        OsRng.fill_bytes(&mut nonce_bytes);
        let nonce = Nonce::from_slice(&nonce_bytes);

        let ciphertext = self
            .cipher()
            .encrypt(nonce, plaintext)
            .map_err(|e| AppError::VaultError(format!("Encrypt: {}", e)))?;

        let mut result = Vec::with_capacity(NONCE_SIZE + ciphertext.len());
        result.extend_from_slice(&nonce_bytes);
        result.extend_from_slice(&ciphertext);
        Ok(result)
    }

    pub fn decrypt(&self, ciphertext: &[u8]) -> Result<Vec<u8>, AppError> {
        if ciphertext.len() < NONCE_SIZE {
            return Err(AppError::VaultError("Ciphertext too short".into()));
        }

        let nonce = Nonce::from_slice(&ciphertext[..NONCE_SIZE]);
        let plaintext = self
            .cipher()
            .decrypt(nonce, &ciphertext[NONCE_SIZE..])
            .map_err(|e| AppError::VaultError(format!("Decrypt: {}", e)))?;
        Ok(plaintext)
    }
}
