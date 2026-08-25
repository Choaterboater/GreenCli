use crate::error::AppError;
use russh::keys::{decode_secret_key, Algorithm, HashAlg, PrivateKey, PublicKey};

pub struct SshKeyManager;

impl SshKeyManager {
    /// Generate an Ed25519 keypair. Kept for backward compatibility; new
    /// callers should prefer [`generate_keypair_of_type`] to select the type.
    pub fn generate_keypair() -> Result<(String, String), AppError> {
        Self::generate_keypair_of_type("ed25519")
    }

    /// Generate an SSH keypair of the requested type and return
    /// `(public_openssh_line, private_key_pem)`.
    ///
    /// Supported `key_type` values (case-insensitive):
    ///   * `"ed25519"` (default) — modern, compact, recommended
    ///   * `"rsa"` / `"rsa-2048"` — RSA 2048-bit, for legacy network gear
    ///   * `"rsa-4096"` — RSA 4096-bit
    ///
    /// RSA generation requires the `rsa-keys` crate feature; without it, RSA
    /// requests return an error (same gate as the russh-keys/openssl era).
    pub fn generate_keypair_of_type(key_type: &str) -> Result<(String, String), AppError> {
        let algorithm = match key_type.trim().to_ascii_lowercase().as_str() {
            "" | "ed25519" | "ssh-ed25519" => Algorithm::Ed25519,
            "rsa" | "rsa-2048" | "rsa2048" => Self::rsa_algorithm()?,
            "rsa-4096" | "rsa4096" => Self::rsa_algorithm()?,
            other => {
                return Err(AppError::SshError(format!(
                    "Unsupported key type '{}' (expected: ed25519, rsa-2048, rsa-4096)",
                    other
                )))
            }
        };

        let mut rng = rand_os::rng();
        let key_pair = PrivateKey::random(&mut rng, algorithm)
            .map_err(|e| AppError::SshError(format!("Key generation failed: {}", e)))?;

        let public_ssh = key_pair
            .public_key()
            .to_openssh()
            .map_err(|e| AppError::SshError(format!("Public key export: {}", e)))?;
        let public_ssh_format = format!("{} greencli", public_ssh);
        let private_key_pem = key_pair
            .to_openssh(russh::keys::ssh_key::LineEnding::LF)
            .map_err(|e| AppError::SshError(format!("OpenSSH export: {}", e)))?
            .to_string();

        Ok((public_ssh_format, private_key_pem))
    }

    fn rsa_algorithm() -> Result<Algorithm, AppError> {
        #[cfg(feature = "rsa-keys")]
        {
            Ok(Algorithm::Rsa { hash: None })
        }
        #[cfg(not(feature = "rsa-keys"))]
        {
            Err(AppError::SshError(
                "RSA key generation is not available in this build; enable the 'rsa-keys' \
                 feature to generate RSA keys"
                    .into(),
            ))
        }
    }

    pub fn load_private_key(
        pem_data: &[u8],
        passphrase: Option<&str>,
    ) -> Result<PrivateKey, AppError> {
        let pem_data = std::str::from_utf8(pem_data)
            .map_err(|e| AppError::SshError(format!("Key UTF-8 decode: {}", e)))?;
        decode_secret_key(pem_data, passphrase)
            .map_err(|e| AppError::SshError(format!("Key decode: {:?}", e)))
    }
}

/// SHA256 fingerprint in the russh-keys 0.43 wire format: unpadded base64 of
/// SHA256(SSH-wire-public-key), **without** an `SHA256:` prefix. Existing
/// `known_hosts.json` entries were written that way; changing the string would
/// look like a MITM on every saved host.
pub fn tofu_fingerprint(key: &PublicKey) -> String {
    let fp = key.fingerprint(HashAlg::Sha256).to_string();
    fp.strip_prefix("SHA256:").unwrap_or(&fp).to_string()
}

pub fn tofu_key_type(key: &PublicKey) -> String {
    key.algorithm().to_string()
}
