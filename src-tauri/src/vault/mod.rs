pub mod crypto;
pub mod storage;

pub use crypto::VaultCipher;
pub use storage::VaultStorage;

use crate::error::AppError;
use std::sync::Mutex;
use zeroize::Zeroize;

/// Minimum length for a NEW master password (or a rotated one). Enforced in the
/// backend as defense-in-depth so a modified/ bypassed frontend cannot create a
/// vault protected by a trivially brute-forceable password. Applied ONLY to the
/// create/rotate paths — never to unlocking an existing vault — so users who
/// created a vault under the old 4-char floor are not locked out.
const MIN_MASTER_PASSWORD_LEN: usize = 12;

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
                // Existing vault: derive with the stored salt AND the stored
                // KDF params (so a crate-default change can't change the key).
                let salt = VaultStorage::salt_from(&env)?;
                let mut key =
                    crypto::derive_key(password, &salt, env.m_cost, env.t_cost, env.p_cost)?;
                let cipher = VaultCipher::new(&key)?;
                key.zeroize();
                if !VaultStorage::verify(&env, &cipher)? {
                    return Err(AppError::VaultError("Invalid vault password".into()));
                }
                cipher
            }
            None => {
                // First unlock: initialize a fresh vault with a new salt.
                if password.chars().count() < MIN_MASTER_PASSWORD_LEN {
                    return Err(AppError::VaultError(format!(
                        "Master password must be at least {} characters",
                        MIN_MASTER_PASSWORD_LEN
                    )));
                }
                let salt = crypto::generate_salt();
                let mut key = crypto::derive_key(
                    password,
                    &salt,
                    crypto::ARGON2_M_COST,
                    crypto::ARGON2_T_COST,
                    crypto::ARGON2_P_COST,
                )?;
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

    pub fn change_password(&self, old_password: &str, new_password: &str) -> Result<(), AppError> {
        // Decrypt existing data under the old password + stored salt/params.
        let env = self
            .storage
            .load()?
            .ok_or_else(|| AppError::VaultError("Vault not initialized".into()))?;
        let old_salt = VaultStorage::salt_from(&env)?;
        let mut old_key =
            crypto::derive_key(old_password, &old_salt, env.m_cost, env.t_cost, env.p_cost)?;
        let old_cipher = VaultCipher::new(&old_key)?;
        old_key.zeroize();
        if !VaultStorage::verify(&env, &old_cipher)? {
            return Err(AppError::VaultError("Invalid current password".into()));
        }
        if new_password.chars().count() < MIN_MASTER_PASSWORD_LEN {
            return Err(AppError::VaultError(format!(
                "Master password must be at least {} characters",
                MIN_MASTER_PASSWORD_LEN
            )));
        }
        let data = self.storage.read_decrypted(&old_cipher)?;

        // Re-key under the new password with a fresh salt + current KDF params.
        let new_salt = crypto::generate_salt();
        let mut new_key = crypto::derive_key(
            new_password,
            &new_salt,
            crypto::ARGON2_M_COST,
            crypto::ARGON2_T_COST,
            crypto::ARGON2_P_COST,
        )?;
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
            v.unlock("hunter2-master-pw").unwrap();
            v.store("router1", "s3cret").unwrap();
        }
        // New instance == simulated app restart.
        let v2 = CredentialVault::new(dir.clone()).unwrap();
        v2.unlock("hunter2-master-pw").unwrap();
        assert_eq!(v2.retrieve("router1").unwrap().as_deref(), Some("s3cret"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn wrong_password_is_rejected() {
        let dir = temp_dir();
        {
            let v = CredentialVault::new(dir.clone()).unwrap();
            v.unlock("correct-master-pw").unwrap();
            v.store("k", "val").unwrap();
        }
        let v2 = CredentialVault::new(dir.clone()).unwrap();
        assert!(v2.unlock("wrong-master-pw").is_err());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn legacy_vault_without_kdf_params_still_unlocks() {
        // A vault created before KDF params were persisted has no m_cost/t_cost/
        // p_cost keys in its JSON. Simulate that by stripping those keys from a
        // freshly-written vault, then confirm a new instance still unlocks and
        // reads the secret — i.e. the serde defaults reproduce the exact params.
        let dir = temp_dir();
        let path = dir.join("vault.enc");
        {
            let v = CredentialVault::new(dir.clone()).unwrap();
            v.unlock("legacy-master-pw").unwrap();
            v.store("host", "pw").unwrap();
        }
        let mut json: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        let obj = json.as_object_mut().unwrap();
        obj.remove("m_cost");
        obj.remove("t_cost");
        obj.remove("p_cost");
        std::fs::write(&path, serde_json::to_vec(&json).unwrap()).unwrap();

        let v2 = CredentialVault::new(dir.clone()).unwrap();
        v2.unlock("legacy-master-pw").unwrap();
        assert_eq!(v2.retrieve("host").unwrap().as_deref(), Some("pw"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn change_password_preserves_data() {
        let dir = temp_dir();
        let v = CredentialVault::new(dir.clone()).unwrap();
        v.unlock("old-master-pw-1").unwrap();
        v.store("k", "val").unwrap();
        v.change_password("old-master-pw-1", "new-master-pw-2").unwrap();
        v.lock();
        assert!(v.unlock("old-master-pw-1").is_err());
        v.unlock("new-master-pw-2").unwrap();
        assert_eq!(v.retrieve("k").unwrap().as_deref(), Some("val"));
        std::fs::remove_dir_all(&dir).ok();
    }
}
