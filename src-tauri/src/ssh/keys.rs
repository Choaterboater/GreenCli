use crate::error::AppError;
use russh_keys::key::KeyPair;
use russh_keys::{decode_secret_key, encode_pkcs8_pem, PublicKeyBase64};

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
    /// RSA generation requires the `rsa-keys` crate feature (which enables
    /// `russh-keys/openssl`); without it, RSA requests return an error.
    pub fn generate_keypair_of_type(key_type: &str) -> Result<(String, String), AppError> {
        let (key_pair, ssh_type) = match key_type.trim().to_ascii_lowercase().as_str() {
            "" | "ed25519" | "ssh-ed25519" => {
                let kp = KeyPair::generate_ed25519()
                    .ok_or_else(|| AppError::SshError("Failed to generate ED25519 key".into()))?;
                (kp, "ssh-ed25519")
            }
            "rsa" | "rsa-2048" | "rsa2048" => (Self::generate_rsa_keypair(2048)?, "ssh-rsa"),
            "rsa-4096" | "rsa4096" => (Self::generate_rsa_keypair(4096)?, "ssh-rsa"),
            other => {
                return Err(AppError::SshError(format!(
                    "Unsupported key type '{}' (expected: ed25519, rsa-2048, rsa-4096)",
                    other
                )))
            }
        };

        let public_key = key_pair
            .clone_public_key()
            .map_err(|e| AppError::SshError(format!("Public key export: {:?}", e)))?;

        let public_key_base64 = public_key.public_key_base64();

        let mut private_key_pem = Vec::new();
        encode_pkcs8_pem(&key_pair, &mut private_key_pem)
            .map_err(|e| AppError::SshError(format!("PKCS8 export: {:?}", e)))?;
        let private_key_pem = String::from_utf8(private_key_pem)
            .map_err(|e| AppError::SshError(format!("UTF-8 export: {}", e)))?;

        let public_ssh_format = format!("{} {} greencli", ssh_type, public_key_base64);

        Ok((public_ssh_format, private_key_pem))
    }

    /// Generate an RSA keypair of the given bit size. Only available when the
    /// `rsa-keys` crate feature (which turns on `russh-keys/openssl`) is built
    /// in — otherwise `russh_keys` has no RSA support compiled and we return a
    /// clear error rather than failing to build.
    fn generate_rsa_keypair(bits: usize) -> Result<KeyPair, AppError> {
        #[cfg(feature = "rsa-keys")]
        {
            use russh_keys::key::SignatureHash;
            KeyPair::generate_rsa(bits, SignatureHash::SHA2_256)
                .ok_or_else(|| AppError::SshError(format!("Failed to generate RSA-{} key", bits)))
        }
        #[cfg(not(feature = "rsa-keys"))]
        {
            let _ = bits;
            Err(AppError::SshError(
                "RSA key generation is not available in this build; enable the 'rsa-keys' \
                 feature (russh-keys openssl support) to generate RSA keys"
                    .into(),
            ))
        }
    }

    pub fn load_private_key(
        pem_data: &[u8],
        passphrase: Option<&str>,
    ) -> Result<KeyPair, AppError> {
        let pem_data = std::str::from_utf8(pem_data)
            .map_err(|e| AppError::SshError(format!("Key UTF-8 decode: {}", e)))?;
        let key_pair = decode_secret_key(pem_data, passphrase)
            .map_err(|e| AppError::SshError(format!("Key decode: {:?}", e)))?;
        Ok(key_pair)
    }
}
