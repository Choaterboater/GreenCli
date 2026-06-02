use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;

use base64::Engine;
use serde::{Deserialize, Serialize};

use super::crypto::VaultCipher;
use crate::error::AppError;

/// On-disk envelope version. Bump when the format changes.
pub const VERSION: u8 = 1;

/// Fixed known plaintext encrypted under the derived key. Decrypting it back to
/// this value proves the password (and therefore the key) is correct, and lets
/// us distinguish a wrong password from a brand-new vault.
pub const CHECK_PLAINTEXT: &[u8] = b"atp-vault-v1";

const B64: base64::engine::general_purpose::GeneralPurpose =
    base64::engine::general_purpose::STANDARD;

/// JSON envelope persisted to `vault.enc`. `salt` is plaintext (it is not
/// secret); `check` and `data` are AES-256-GCM ciphertexts (nonce-prefixed).
#[derive(Serialize, Deserialize)]
pub struct Envelope {
    pub v: u8,
    pub salt: String,
    pub check: String,
    pub data: String,
}

pub struct VaultStorage {
    vault_path: PathBuf,
}

impl VaultStorage {
    pub fn new(vault_path: PathBuf) -> Result<Self, AppError> {
        // Ensure parent directory exists
        if let Some(parent) = vault_path.parent() {
            fs::create_dir_all(parent).map_err(AppError::from)?;
        }
        Ok(Self { vault_path })
    }

    pub fn exists(&self) -> bool {
        self.vault_path.exists()
    }

    /// Load the envelope. Returns `Ok(None)` ONLY for a genuinely missing/empty
    /// file (a vault that has never been initialized). A file that is present but
    /// unparseable, or a future/unknown version, returns `Err` — the caller MUST
    /// NOT treat that as "uninitialized" and overwrite it, or a truncated/corrupt
    /// vault (e.g. from a crash mid-write) would silently destroy every secret.
    pub fn load(&self) -> Result<Option<Envelope>, AppError> {
        if !self.exists() {
            return Ok(None);
        }
        let raw = fs::read(&self.vault_path).map_err(AppError::from)?;
        if raw.is_empty() {
            return Ok(None);
        }
        match serde_json::from_slice::<Envelope>(&raw) {
            Ok(env) if env.v == VERSION => Ok(Some(env)),
            Ok(env) => Err(AppError::VaultError(format!(
                "Vault file is version {} but this build supports version {}. \
                 Refusing to overwrite it — back up and remove vault.enc to start fresh.",
                env.v, VERSION
            ))),
            Err(e) => Err(AppError::VaultError(format!(
                "Vault file is present but unreadable ({e}). Refusing to overwrite it — \
                 your data may still be recoverable; back up vault.enc before removing it."
            ))),
        }
    }

    /// Persist the envelope atomically: write a sibling temp file (0600), then
    /// rename it over the target. Rename is atomic on the same filesystem, so a
    /// reader never sees a torn file and a crash mid-write leaves the previous
    /// good vault intact.
    fn save(&self, env: &Envelope) -> Result<(), AppError> {
        let json = serde_json::to_vec(env).map_err(AppError::from)?;
        let tmp = self.vault_path.with_extension("enc.tmp");
        fs::write(&tmp, &json).map_err(AppError::from)?;
        restrict_perms(&tmp);
        fs::rename(&tmp, &self.vault_path).map_err(AppError::from)?;
        restrict_perms(&self.vault_path);
        Ok(())
    }

    /// Initialize a fresh vault: persist the salt + an encrypted check token and
    /// an empty (encrypted) data map.
    pub fn init(&self, salt: &[u8], cipher: &VaultCipher) -> Result<(), AppError> {
        let check = cipher.encrypt(CHECK_PLAINTEXT)?;
        let empty: HashMap<String, String> = HashMap::new();
        let data = cipher.encrypt(serde_json::to_string(&empty)?.as_bytes())?;
        let env = Envelope {
            v: VERSION,
            salt: B64.encode(salt),
            check: B64.encode(check),
            data: B64.encode(data),
        };
        self.save(&env)
    }

    /// Decode the persisted salt from the envelope.
    pub fn salt_from(env: &Envelope) -> Result<Vec<u8>, AppError> {
        B64.decode(env.salt.as_bytes())
            .map_err(|e| AppError::VaultError(format!("Bad salt encoding: {}", e)))
    }

    /// Verify the check token decrypts to the expected plaintext under `cipher`.
    pub fn verify(env: &Envelope, cipher: &VaultCipher) -> Result<bool, AppError> {
        let check_ct = B64
            .decode(env.check.as_bytes())
            .map_err(|e| AppError::VaultError(format!("Bad check encoding: {}", e)))?;
        match cipher.decrypt(&check_ct) {
            Ok(pt) => Ok(pt == CHECK_PLAINTEXT),
            Err(_) => Ok(false),
        }
    }

    pub fn read_decrypted(
        &self,
        cipher: &VaultCipher,
    ) -> Result<HashMap<String, String>, AppError> {
        let env = match self.load()? {
            Some(env) => env,
            None => return Ok(HashMap::new()),
        };
        let data_ct = B64
            .decode(env.data.as_bytes())
            .map_err(|e| AppError::VaultError(format!("Bad data encoding: {}", e)))?;
        if data_ct.is_empty() {
            return Ok(HashMap::new());
        }
        // Wrap the decrypted plaintext + JSON so they are wiped from memory on drop
        // rather than lingering as freed-but-unzeroed secret bytes.
        let json_str = zeroize::Zeroizing::new(
            String::from_utf8(cipher.decrypt(&data_ct)?)
                .map_err(|e| AppError::VaultError(format!("UTF-8 decode: {}", e)))?,
        );
        let data: HashMap<String, String> =
            serde_json::from_str(&json_str).map_err(AppError::from)?;
        Ok(data)
    }

    /// Re-encrypt the data map, preserving the existing salt + check token.
    pub fn write_encrypted(
        &self,
        cipher: &VaultCipher,
        data: &HashMap<String, String>,
    ) -> Result<(), AppError> {
        let mut env = self.load()?.ok_or_else(|| {
            AppError::VaultError("Vault not initialized. Call unlock() first.".into())
        })?;
        let json_str = serde_json::to_string(data).map_err(AppError::from)?;
        let encrypted = cipher.encrypt(json_str.as_bytes())?;
        env.data = B64.encode(encrypted);
        self.save(&env)
    }

    /// Rewrite the whole vault under a new salt + cipher (used by change_password).
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn rewrite(
        &self,
        salt: &[u8],
        cipher: &VaultCipher,
        data: &HashMap<String, String>,
    ) -> Result<(), AppError> {
        let check = cipher.encrypt(CHECK_PLAINTEXT)?;
        let data_ct = cipher.encrypt(serde_json::to_string(data)?.as_bytes())?;
        let env = Envelope {
            v: VERSION,
            salt: B64.encode(salt),
            check: B64.encode(check),
            data: B64.encode(data_ct),
        };
        self.save(&env)
    }
}

/// Restrict a file to owner-only read/write (0600) on Unix; no-op elsewhere.
/// The vault holds encrypted secrets, but the salt/check token and the file's
/// mere presence shouldn't be group/world-readable.
#[cfg(unix)]
fn restrict_perms(path: &std::path::Path) {
    use std::os::unix::fs::PermissionsExt;
    let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));
}
#[cfg(not(unix))]
fn restrict_perms(_path: &std::path::Path) {}
