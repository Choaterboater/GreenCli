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

// Argon2 params for envelopes written before KDF params were persisted. These
// MUST equal argon2 0.5.x `Argon2::default()` so that pre-existing vaults (whose
// JSON has no m_cost/t_cost/p_cost) re-derive with the exact params they were
// created under. See crypto::ARGON2_*.
fn default_m_cost() -> u32 {
    super::crypto::ARGON2_M_COST
}
fn default_t_cost() -> u32 {
    super::crypto::ARGON2_T_COST
}
fn default_p_cost() -> u32 {
    super::crypto::ARGON2_P_COST
}

/// JSON envelope persisted to `vault.enc`. `salt` is plaintext (it is not
/// secret); `check` and `data` are AES-256-GCM ciphertexts (nonce-prefixed).
/// `m_cost`/`t_cost`/`p_cost` record the Argon2id parameters the key was derived
/// with, so a crate-default change can never lock the vault out; they default
/// (via serde) to the 0.5.x values for vaults written before they were stored.
#[derive(Serialize, Deserialize)]
pub struct Envelope {
    pub v: u8,
    pub salt: String,
    pub check: String,
    pub data: String,
    #[serde(default = "default_m_cost")]
    pub m_cost: u32,
    #[serde(default = "default_t_cost")]
    pub t_cost: u32,
    #[serde(default = "default_p_cost")]
    pub p_cost: u32,
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
            // A present-but-empty file is never a legitimately-uninitialized
            // vault (init() always writes a non-empty envelope, and a truly new
            // vault has no file at all). It is the signature of a crash/power
            // loss that truncated the file, so refuse to treat it as "new" —
            // otherwise unlock()'s init path would overwrite it with an empty
            // vault, destroying every secret.
            return Err(AppError::VaultError(
                "Vault file exists but is empty (likely truncated by a crash or power loss). \
                 Refusing to overwrite it — back up and remove vault.enc to start fresh."
                    .into(),
            ));
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

    /// Persist the envelope atomically AND durably: write a sibling temp file
    /// (created 0600 from the start — never briefly world-readable), fsync it so
    /// the bytes are physically on disk, rename it over the target (atomic on the
    /// same filesystem, so a reader never sees a torn file), then fsync the
    /// parent directory so the rename itself survives a power loss. Without the
    /// fsync, a crash could leave a zero-length vault.enc that load() would have
    /// to reject to avoid destroying the previous good vault.
    fn save(&self, env: &Envelope) -> Result<(), AppError> {
        use std::io::Write;
        let json = serde_json::to_vec(env).map_err(AppError::from)?;
        let tmp = self.vault_path.with_extension("enc.tmp");
        {
            let mut f = create_restricted(&tmp)?;
            f.write_all(&json).map_err(AppError::from)?;
            f.sync_all().map_err(AppError::from)?;
        }
        fs::rename(&tmp, &self.vault_path).map_err(AppError::from)?;
        restrict_perms(&self.vault_path)?;
        // Make the directory entry created by rename() durable. Directory fsync
        // is a Unix concept; on other platforms the rename ordering suffices.
        #[cfg(unix)]
        if let Some(parent) = self.vault_path.parent() {
            if let Ok(dir) = fs::File::open(parent) {
                let _ = dir.sync_all();
            }
        }
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
            m_cost: super::crypto::ARGON2_M_COST,
            t_cost: super::crypto::ARGON2_T_COST,
            p_cost: super::crypto::ARGON2_P_COST,
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
        // Wrap the serialized-all-secrets blob so it is wiped from memory after
        // encryption rather than lingering as freed-but-unzeroed plaintext.
        let json_str = zeroize::Zeroizing::new(serde_json::to_string(data).map_err(AppError::from)?);
        let encrypted = cipher.encrypt(json_str.as_bytes())?;
        env.data = B64.encode(encrypted);
        self.save(&env)
    }

    /// Rewrite the whole vault under a new salt + cipher (used by change_password).
    pub fn rewrite(
        &self,
        salt: &[u8],
        cipher: &VaultCipher,
        data: &HashMap<String, String>,
    ) -> Result<(), AppError> {
        let check = cipher.encrypt(CHECK_PLAINTEXT)?;
        let json_str = zeroize::Zeroizing::new(serde_json::to_string(data)?);
        let data_ct = cipher.encrypt(json_str.as_bytes())?;
        let env = Envelope {
            v: VERSION,
            salt: B64.encode(salt),
            check: B64.encode(check),
            data: B64.encode(data_ct),
            m_cost: super::crypto::ARGON2_M_COST,
            t_cost: super::crypto::ARGON2_T_COST,
            p_cost: super::crypto::ARGON2_P_COST,
        };
        self.save(&env)
    }
}

/// Create (and truncate) a file owner-only (0600) from the moment it exists on
/// Unix, so it is never briefly group/world-readable in the window between
/// create and chmod (the bug that `fs::write` + `restrict_perms` had). Falls
/// back to a plain create on non-Unix platforms.
#[cfg(unix)]
fn create_restricted(path: &std::path::Path) -> Result<fs::File, AppError> {
    use std::os::unix::fs::OpenOptionsExt;
    fs::OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .mode(0o600)
        .open(path)
        .map_err(AppError::from)
}
#[cfg(not(unix))]
fn create_restricted(path: &std::path::Path) -> Result<fs::File, AppError> {
    fs::File::create(path).map_err(AppError::from)
}

/// Restrict a file to owner-only read/write (0600) on Unix; no-op elsewhere.
/// The vault holds encrypted secrets, but the salt/check token and the file's
/// mere presence shouldn't be group/world-readable. Returns the chmod error
/// (rather than silently swallowing it) so a failure to lock down the durable
/// vault.enc surfaces instead of leaving it world-readable.
#[cfg(unix)]
fn restrict_perms(path: &std::path::Path) -> Result<(), AppError> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600)).map_err(AppError::from)
}
#[cfg(not(unix))]
fn restrict_perms(_path: &std::path::Path) -> Result<(), AppError> {
    Ok(())
}
