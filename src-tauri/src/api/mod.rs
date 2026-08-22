pub mod aruba_cx;
pub mod onprem;

pub use aruba_cx::ArubaCxClient;
pub use onprem::{Aos8Client, ApstraClient, AossClient, JunosClient, MistClient};

/// Whether an absolute `url` shares an origin (scheme + host + effective port)
/// with the client's configured `base` URL.
///
/// The Postman-style `*_request` commands accept absolute URLs from the webview.
/// Credentials (bearer tokens, Basic auth, CSRF headers, UIDARUBA) must only be
/// attached when the target is the configured device/controller — otherwise a
/// crafted URL exfiltrates live credentials to an arbitrary host.
pub(crate) fn same_origin(base: &str, url: &str) -> bool {
    match (reqwest::Url::parse(base), reqwest::Url::parse(url)) {
        (Ok(b), Ok(u)) => {
            b.scheme() == u.scheme()
                && b.host_str() == u.host_str()
                && b.port_or_known_default() == u.port_or_known_default()
        }
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::same_origin;

    #[test]
    fn same_origin_matches_scheme_host_port() {
        assert!(same_origin("https://10.0.0.1/rest/v10.09", "https://10.0.0.1/other"));
        assert!(same_origin("https://api.mist.com", "https://api.mist.com/api/v1/sites"));
        assert!(same_origin("https://host:4343", "https://host:4343/v1/api"));
        // Default-port equivalence (https:443).
        assert!(same_origin("https://host", "https://host:443/x"));
    }

    #[test]
    fn different_origin_is_rejected() {
        assert!(!same_origin("https://10.0.0.1/rest/v10.09", "https://evil.example.com/"));
        assert!(!same_origin("https://10.0.0.1", "http://10.0.0.1/")); // scheme downgrade
        assert!(!same_origin("https://host:4343", "https://host:8443/")); // port change
        assert!(!same_origin("https://host", "not a url"));
    }
}
