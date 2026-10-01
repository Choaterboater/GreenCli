pub mod aruba_cx;
pub mod onprem;

pub use aruba_cx::ArubaCxClient;
pub use onprem::{Aos8Client, AossClient, JunosClient, MistClient};

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

/// Checks a request path for callers that must stay on the logged-in device.
///
/// The `*_request` clients treat a path that starts with "http" as an absolute
/// URL, which the API Explorer uses on purpose. Every other caller, including
/// the AI's REST tools, gets only a path on the device: it must start with a
/// single '/'. That also stops "@evil.example.com/" from turning
/// "https://switch" into "https://switch@evil.example.com/" when the base URL
/// has no path of its own.
pub(crate) fn require_device_path(path: &str) -> Result<(), String> {
    if path.starts_with('/') && !path.starts_with("//") && !path.starts_with("/\\") {
        Ok(())
    } else {
        Err(format!(
            "Refused: \"{}\" is not a path on this device. Use a path that starts with '/', \
             such as /system/interfaces.",
            path.chars().take(80).collect::<String>()
        ))
    }
}

/// True for localhost, 127.0.0.0/8 and ::1 only. A host NAME that merely
/// starts with "127." (127.evil.example) is not loopback.
pub(crate) fn is_loopback_host(url: &reqwest::Url) -> bool {
    let Some(host) = url.host_str() else {
        return false;
    };
    if host.eq_ignore_ascii_case("localhost") {
        return true;
    }
    // IPv6 hosts come back bracketed ("[::1]").
    host.trim_start_matches('[')
        .trim_end_matches(']')
        .parse::<std::net::IpAddr>()
        .map(|ip| ip.is_loopback())
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::{is_loopback_host, require_device_path, same_origin};

    #[test]
    fn loopback_means_this_machine_only() {
        let lb = |u: &str| is_loopback_host(&reqwest::Url::parse(u).unwrap());
        assert!(lb("http://localhost:8080/hook"));
        assert!(lb("http://127.0.0.1/hook"));
        assert!(lb("http://127.9.9.9/hook"));
        assert!(lb("http://[::1]:9000/hook"));
        assert!(!lb("http://127.evil.example/hook"));
        assert!(!lb("http://127.0.0.1.nip.io/hook"));
        assert!(!lb("http://10.0.0.5/hook"));
        assert!(!lb("http://localhost.evil.example/hook"));
    }

    #[test]
    fn device_path_must_be_relative_to_the_device() {
        assert!(require_device_path("/system/interfaces?depth=2").is_ok());
        assert!(require_device_path("/vlans").is_ok());
        assert!(require_device_path("https://evil.example.com/x").is_err());
        assert!(require_device_path("http://10.0.0.9/").is_err());
        assert!(require_device_path("//evil.example.com/x").is_err());
        assert!(require_device_path("/\\evil.example.com/x").is_err());
        assert!(require_device_path("@evil.example.com/x").is_err());
        assert!(require_device_path("system").is_err());
        assert!(require_device_path("").is_err());
    }

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
