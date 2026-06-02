use crate::error::AppError;
use russh_keys::key::KeyPair;
use russh_keys::{decode_secret_key, encode_pkcs8_pem, PublicKeyBase64};

pub struct SshKeyManager;

impl SshKeyManager {
    pub fn generate_keypair() -> Result<(String, String), AppError> {
        let key_pair = KeyPair::generate_ed25519()
            .ok_or_else(|| AppError::SshError("Failed to generate ED25519 key".into()))?;

        let public_key = key_pair
            .clone_public_key()
            .map_err(|e| AppError::SshError(format!("Public key export: {:?}", e)))?;

        let public_key_base64 = public_key.public_key_base64();

        let mut private_key_pem = Vec::new();
        encode_pkcs8_pem(&key_pair, &mut private_key_pem)
            .map_err(|e| AppError::SshError(format!("PKCS8 export: {:?}", e)))?;
        let private_key_pem = String::from_utf8(private_key_pem)
            .map_err(|e| AppError::SshError(format!("UTF-8 export: {}", e)))?;

        let public_ssh_format = format!("ssh-ed25519 {} greencli", public_key_base64);

        Ok((public_ssh_format, private_key_pem))
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
