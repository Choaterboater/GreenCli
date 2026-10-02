// The environment a stdio MCP server starts with. GreenCLI used to pass its
// whole environment on, so every API key in the user's shell reached every
// server. Now a server gets only a short list of basic variables, plus the
// ones the user typed in that server's Env box. Pure: no Tauri, no I/O.
//
// The first six Unix names and the first twelve Windows names are the MCP
// TypeScript SDK's DEFAULT_INHERITED_ENV_VARS, the list Casper uses.

use std::ffi::OsString;

pub const UNIX_INHERITED: &[&str] = &[
    "HOME", "LOGNAME", "PATH", "SHELL", "TERM", "USER", "LANG", "LC_ALL", "LC_CTYPE", "TMPDIR",
];

pub const WINDOWS_INHERITED: &[&str] = &[
    "APPDATA",
    "HOMEDRIVE",
    "HOMEPATH",
    "LOCALAPPDATA",
    "PATH",
    "PROCESSOR_ARCHITECTURE",
    "SYSTEMDRIVE",
    "SYSTEMROOT",
    "TEMP",
    "USERNAME",
    "USERPROFILE",
    "PROGRAMFILES",
    "PATHEXT",
    "COMSPEC",
    "WINDIR",
    "TMP",
];

/// Network plumbing servers need, on both systems: ssh-agent for PyEZ/netmiko key logins, and proxy and
/// company-CA settings for uvx/npx fetches and cloud APIs. None of them is an API key.
pub const NETWORK_INHERITED: &[&str] = &[
    "SSH_AUTH_SOCK",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "ALL_PROXY",
    "http_proxy",
    "https_proxy",
    "no_proxy",
    "all_proxy",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "REQUESTS_CA_BUNDLE",
    "CURL_CA_BUNDLE",
    "NODE_EXTRA_CA_CERTS",
];

fn allowed(name: &str, windows: bool) -> bool {
    if windows {
        WINDOWS_INHERITED
            .iter()
            .chain(NETWORK_INHERITED)
            .any(|n| n.eq_ignore_ascii_case(name))
    } else {
        UNIX_INHERITED
            .iter()
            .chain(NETWORK_INHERITED)
            .any(|n| *n == name)
    }
}

/// The parent variables a stdio server may see. Windows names match case-insensitively; values starting "()" are dropped.
pub fn inherited_env<I: IntoIterator<Item = (OsString, OsString)>>(
    vars: I,
    windows: bool,
) -> Vec<(OsString, OsString)> {
    vars.into_iter()
        .filter(|(key, value)| {
            // A name that isn't valid Unicode is never on the list.
            let Some(name) = key.to_str() else {
                return false;
            };
            // Shell functions exported as variables (the Shellshock shape).
            allowed(name, windows) && !value.to_string_lossy().starts_with("()")
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vars(pairs: &[(&str, &str)]) -> Vec<(OsString, OsString)> {
        pairs
            .iter()
            .map(|(k, v)| (OsString::from(k), OsString::from(v)))
            .collect()
    }

    fn names(out: &[(OsString, OsString)]) -> Vec<String> {
        out.iter()
            .map(|(k, _)| k.to_string_lossy().into_owned())
            .collect()
    }

    #[test]
    fn only_listed_names_pass() {
        let out = inherited_env(
            vars(&[
                ("PATH", "/usr/bin"),
                ("HOME", "/home/me"),
                ("OPENAI_API_KEY", "sk-x"),
                ("AWS_SECRET_ACCESS_KEY", "y"),
                ("LANG", "en_US.UTF-8"),
            ]),
            false,
        );
        assert_eq!(names(&out), vec!["PATH", "HOME", "LANG"]);
    }

    #[test]
    fn network_plumbing_passes() {
        let out = inherited_env(
            vars(&[
                ("SSH_AUTH_SOCK", "/tmp/agent"),
                ("HTTPS_PROXY", "http://proxy:3128"),
                ("https_proxy", "http://proxy:3128"),
                ("SSL_CERT_FILE", "/etc/ca.pem"),
            ]),
            false,
        );
        assert_eq!(out.len(), 4);
        let win = inherited_env(
            vars(&[("SSH_AUTH_SOCK", "x"), ("NODE_EXTRA_CA_CERTS", "y")]),
            true,
        );
        assert_eq!(win.len(), 2);
    }

    #[test]
    fn exported_shell_functions_are_dropped() {
        let out = inherited_env(
            vars(&[("TERM", "() { :; }; echo hi"), ("SHELL", "/bin/zsh")]),
            false,
        );
        assert_eq!(names(&out), vec!["SHELL"]);
    }

    #[test]
    fn windows_names_ignore_case() {
        assert_eq!(
            names(&inherited_env(vars(&[("Path", "C:\\x")]), true)),
            vec!["Path"]
        );
        assert!(inherited_env(vars(&[("path", "/usr/bin")]), false).is_empty());
        // Unix-only names don't pass on Windows, and the other way round.
        assert!(inherited_env(vars(&[("SHELL", "x")]), true).is_empty());
        assert!(inherited_env(vars(&[("SYSTEMROOT", "x")]), false).is_empty());
    }
}
