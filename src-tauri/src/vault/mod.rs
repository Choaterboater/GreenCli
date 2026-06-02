pub mod crypto;
pub mod storage;

pub use crypto::VaultCipher;
pub use storage::VaultStorage;

use crate::error::AppError;
use std::sync::Mutex;
use zeroize::Zeroize;

/// Thread-safe credential vault with AES-256-GCM encryption.
///
/// The salt and a verification token are persisted alongside the ciphertext
/// (see `storage::Envelope`), so the same key is re-derived on every unlock and
/// a wrong password is rejected immediately.
pub struct CredentialVault {
    storage: VaultStorage,
    cipher: Mutex<Option<VaultCipher>>,
}

impl CredentialVault {
    pub fn new(app_dir: std::path::PathBuf) -> Result<Self, AppError> {
        let vault_path = app_dir.join("vault.enc");
        Ok(Self {
            storage: VaultStorage::new(vault_path)?,
            cipher: Mutex::new(None),
        })
    }

    pub fn unlock(&self, password: &str) -> Result<(), AppError> {
        let cipher = match self.storage.load()? {
            Some(env) => {
                // Existing vault: derive with the stored salt and verify.
                let salt = VaultStorage::salt_from(&env)?;
                let mut key = crypto::derive_key(password, &salt)?;
                let cipher = VaultCipher::new(&key)?;
                key.zeroize();
                if !VaultStorage::verify(&env, &cipher)? {
                    return Err(AppError::VaultError("Invalid vault password".into()));
                }
                cipher
            }
            None => {
                // First unlock: initialize a fresh vault with a new salt.
                let salt = crypto::generate_salt();
                let mut key = crypto::derive_key(password, &salt)?;
                let cipher = VaultCipher::new(&key)?;
                key.zeroize();
                self.storage.init(&salt, &cipher)?;
                cipher
            }
        };

        *self
            .cipher
            .lock()
            .map_err(|e| AppError::VaultError(e.to_string()))? = Some(cipher);
        Ok(())
    }

    pub fn lock(&self) {
        let _ = self.cipher.lock().map(|mut c| *c = None);
    }

    pub fn is_unlocked(&self) -> bool {
        self.cipher.lock().map(|c| c.is_some()).unwrap_or(false)
    }

    pub fn is_initialized(&self) -> bool {
        self.storage.exists()
    }

    fn with_cipher<T>(
        &self,
        f: impl FnOnce(&VaultCipher) -> Result<T, AppError>,
    ) -> Result<T, AppError> {
        let guard = self
            .cipher
            .lock()
            .map_err(|e| AppError::VaultError(e.to_string()))?;
        let cipher = guard
            .as_ref()
            .ok_or_else(|| AppError::VaultError("Vault is locked. Call unlock() first.".into()))?;
        f(cipher)
    }

    pub fn store(&self, key: &str, value: &str) -> Result<(), AppError> {
        self.with_cipher(|cipher| {
            let mut data = self.storage.read_decrypted(cipher)?;
            data.insert(key.to_string(), value.to_string());
            self.storage.write_encrypted(cipher, &data)
        })
    }

    pub fn retrieve(&self, key: &str) -> Result<Option<String>, AppError> {
        self.with_cipher(|cipher| {
            let data = self.storage.read_decrypted(cipher)?;
            Ok(data.get(key).cloned())
        })
    }

    pub fn delete(&self, key: &str) -> Result<(), AppError> {
        self.with_cipher(|cipher| {
            let mut data = self.storage.read_decrypted(cipher)?;
            data.remove(key);
            self.storage.write_encrypted(cipher, &data)
        })
    }

    #[cfg_attr(not(test), allow(dead_code))]
    pub fn change_password(&self, old_password: &str, new_password: &str) -> Result<(), AppError> {
        // Decrypt existing data under the old password + stored salt.
        let env = self
            .storage
            .load()?
            .ok_or_else(|| AppError::VaultError("Vault not initialized".into()))?;
        let old_salt = VaultStorage::salt_from(&env)?;
        let mut old_key = crypto::derive_key(old_password, &old_salt)?;
        let old_cipher = VaultCipher::new(&old_key)?;
        old_key.zeroize();
        if !VaultStorage::verify(&env, &old_cipher)? {
            return Err(AppError::VaultError("Invalid current password".into()));
        }
        let data = self.storage.read_decrypted(&old_cipher)?;

        // Re-key under the new password with a fresh salt.
        let new_salt = crypto::generate_salt();
        let mut new_key = crypto::derive_key(new_password, &new_salt)?;
        let new_cipher = VaultCipher::new(&new_key)?;
        new_key.zeroize();
        self.storage.rewrite(&new_salt, &new_cipher, &data)?;

        *self
            .cipher
            .lock()
            .map_err(|e| AppError::VaultError(e.to_string()))? = Some(new_cipher);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir() -> std::path::PathBuf {
        let mut p = std::env::temp_dir();
        p.push(format!("atp-vault-test-{}", rand::random::<u64>()));
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    #[test]
    fn roundtrip_survives_restart() {
        let dir = temp_dir();
        {
            let v = CredentialVault::new(dir.clone()).unwrap();
            v.unlock("hunter2").unwrap();
            v.store("router1", "s3cret").unwrap();
        }
        // New instance == simulated app restart.
        let v2 = CredentialVault::new(dir.clone()).unwrap();
        v2.unlock("hunter2").unwrap();
        assert_eq!(v2.retrieve("router1").unwrap().as_deref(), Some("s3cret"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn wrong_password_is_rejected() {
        let dir = temp_dir();
        {
            let v = CredentialVault::new(dir.clone()).unwrap();
            v.unlock("correct").unwrap();
            v.store("k", "val").unwrap();
        }
        let v2 = CredentialVault::new(dir.clone()).unwrap();
        assert!(v2.unlock("wrong").is_err());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn change_password_preserves_data() {
        let dir = temp_dir();
        let v = CredentialVault::new(dir.clone()).unwrap();
        v.unlock("old").unwrap();
        v.store("k", "val").unwrap();
        v.change_password("old", "new").unwrap();
        v.lock();
        assert!(v.unlock("old").is_err());
        v.unlock("new").unwrap();
        assert_eq!(v.retrieve("k").unwrap().as_deref(), Some("val"));
        std::fs::remove_dir_all(&dir).ok();
    }
}
