//! Web links (a URL in terminal output, the API Explorer's docs links) open in
//! the system browser through the `open_url` command. The webview can't open
//! them itself: Tauri 2 sets no new-window handler, so on Windows wry marks
//! WebView2's new-window request handled and `window.open` / `target="_blank"`
//! open nothing (1.9's WebView2 opened its own pop-up), and macOS never did.

/// The link to hand the system opener, or why it is refused. Only http and
/// https URLs with a host pass, so the opener can't be made to run a file or
/// another app's URL scheme. The result is the URL as `url` writes it out,
/// which never holds whitespace, a quote or a control character (checked
/// again here, because Windows gets it inside quotes). Errors don't repeat
/// the URL: it may carry a token.
pub fn checked_web_url(url: &str) -> Result<String, String> {
    let parsed = reqwest::Url::parse(url).map_err(|e| format!("Not a web link ({e})."))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err(format!(
            "Only http and https links open in the browser, not {}: links.",
            parsed.scheme()
        ));
    }
    if parsed.host_str().is_none_or(str::is_empty) {
        return Err("The link has no host.".to_string());
    }
    let text = parsed.as_str();
    if text
        .chars()
        .any(|c| c.is_whitespace() || c.is_control() || c == '"')
    {
        return Err("The link has characters a browser link can't have.".to_string());
    }
    Ok(text.to_string())
}

/// The one argument for Windows' `explorer`. Explorer reads commas outside
/// quotes as separators (as in `/select,<path>`), so the URL goes in quotes;
/// `checked_web_url` makes sure it holds none itself.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn explorer_arg(checked_url: &str) -> String {
    format!("\"{checked_url}\"")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn web_links_pass() {
        assert_eq!(
            checked_web_url("https://example.com").as_deref(),
            Ok("https://example.com/")
        );
        assert_eq!(
            checked_web_url("http://10.1.1.1:8080/ui?a=1&b=2^3#top").as_deref(),
            Ok("http://10.1.1.1:8080/ui?a=1&b=2^3#top")
        );
        assert_eq!(
            checked_web_url("HTTPS://[fe80::1]/x").as_deref(),
            Ok("https://[fe80::1]/x")
        );
        // Commas stay as they are (Windows quotes the whole URL instead).
        assert_eq!(
            checked_web_url("https://maps.example.com/@40.7,-74.0,15z").as_deref(),
            Ok("https://maps.example.com/@40.7,-74.0,15z")
        );
    }

    #[test]
    fn other_schemes_are_refused() {
        for url in [
            "file:///C:/Windows/System32/calc.exe",
            "file:///etc/passwd",
            "javascript:alert(1)",
            "ms-settings:privacy",
            "ssh://router.example.com",
            "ftp://example.com/x",
            "mailto:me@example.com",
            "data:text/html,hi",
            "about:blank",
        ] {
            assert!(checked_web_url(url).is_err(), "{url} must be refused");
        }
    }

    #[test]
    fn non_urls_are_refused() {
        for url in ["", "example.com", "/etc/passwd", "C:\\Windows", "http://", "https:///"] {
            assert!(checked_web_url(url).is_err(), "{url:?} must be refused");
        }
    }

    #[test]
    fn quotes_and_spaces_never_reach_the_opener() {
        let url = checked_web_url("https://example.com/a\"b c?q=\"x y\"#\"f g\"").unwrap();
        assert!(!url.contains('"') && !url.contains(' '), "{url}");
        assert_eq!(explorer_arg(&url), format!("\"{url}\""));
        // A quote in user info is escaped too.
        let url = checked_web_url("https://a\"b:c\"d@example.com/").unwrap();
        assert!(!url.contains('"'), "{url}");
    }

    #[test]
    fn errors_do_not_repeat_the_url() {
        let err = checked_web_url("ftp://example.com/?token=SECRETVALUE").unwrap_err();
        assert!(!err.contains("SECRETVALUE"), "{err}");
        let err = checked_web_url("http://[bad/?token=SECRETVALUE").unwrap_err();
        assert!(!err.contains("SECRETVALUE"), "{err}");
    }
}
