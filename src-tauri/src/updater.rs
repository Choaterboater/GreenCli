//! Automatic updates from GreenCLI's GitHub releases.
//!
//! The owner holds one signing key pair. Its public half is built into the
//! app (`plugins.updater.pubkey` in tauri.conf.json) and is never downloaded;
//! release.yml signs update files with the private half from the
//! TAURI_SIGNING_PRIVATE_KEY repo secret. The updater checks every downloaded
//! file against the built-in key, so a file someone else signed is refused
//! even when it sits in a GreenCLI release. Until the owner's public key is
//! in tauri.conf.json, updates are off (`OffReason::NoKey`).
//!
//! Checking downloads the update but never installs it: only `update_install`
//! does, and the app calls that only when the user taps "Restart to update".

use std::{
    cmp::Ordering,
    sync::Mutex,
    time::Duration,
};

use reqwest::Url;
use semver::Version;
use serde::Serialize;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_updater::{Update, UpdaterExt};

use crate::app_location::{install_place, InstallPlace};

/// The update manifest tauri-action writes into each release. Everything the
/// updater fetches starts here.
pub const LATEST_JSON_URL: &str =
    "https://github.com/Choaterboater/GreenCli/releases/latest/download/latest.json";
/// Update files must be assets of a GreenCLI release: tauri-action writes
/// their API address into latest.json (`api.github.com/repos/<repo>/releases/
/// assets/<id>`); a plain release download link is accepted too.
const ASSET_API_PREFIX: &str = "/repos/Choaterboater/GreenCli/releases/assets/";
const DOWNLOAD_PATH_PREFIX: &str = "/Choaterboater/GreenCli/releases/download/";
/// The only hosts update requests may reach: github.com and its API, and the
/// hosts they redirect release downloads to (release-assets is where GitHub
/// sends them today, objects is the older name).
pub const ALLOWED_HOSTS: [&str; 4] = [
    "github.com",
    "api.github.com",
    "objects.githubusercontent.com",
    "release-assets.githubusercontent.com",
];
const MAX_REDIRECTS: usize = 5;
const CHECK_TIMEOUT: Duration = Duration::from_secs(30);
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(15 * 60);

// Short errors, never with a URL in them.
pub const ERR_NETWORK: &str = "Couldn't check for updates. Check your internet connection.";
pub const ERR_SIGNATURE: &str = "The update didn't pass its signature check.";
pub const ERR_SOURCE: &str = "The update didn't come from GreenCLI's GitHub releases.";
pub const ERR_OFF: &str = "Updates are off in this build.";
pub const ERR_PLACE: &str = "Move GreenCLI to Applications, then try again.";
pub const ERR_NOT_READY: &str = "Check for updates first.";
pub const ERR_INSTALL: &str =
    "Couldn't install the update. Try again, or get it from the GitHub Releases page.";

/// Why updates are off.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum OffReason {
    /// A development build (`tauri dev`, debug builds).
    Dev,
    /// A system release.yml doesn't build for (Linux, Windows on Arm…).
    Platform,
    /// The updater plugin failed to start (logged).
    Setup,
    /// No public key is built in yet (tauri.conf.json `plugins.updater.pubkey`).
    NoKey,
}

/// The `<os>-<arch>` name Tauri uses in latest.json for a shipped build, from
/// Rust's `std::env::consts` names. None for systems with no release build.
pub fn platform_key(os: &str, arch: &str) -> Option<&'static str> {
    match (os, arch) {
        ("macos", "aarch64") => Some("darwin-aarch64"),
        ("macos", "x86_64") => Some("darwin-x86_64"),
        ("windows", "x86_64") => Some("windows-x86_64"),
        _ => None,
    }
}

/// This build's platform name, if GreenCLI ships updates for it.
pub fn current_platform() -> Option<&'static str> {
    platform_key(std::env::consts::OS, std::env::consts::ARCH)
}

/// Whether updates run in this build: a release build, for a system
/// release.yml builds, with a real public key built in.
pub fn updates_enabled<'a>(
    is_dev: bool,
    platform: Option<&'a str>,
    pubkey: &str,
) -> Result<&'a str, OffReason> {
    if is_dev {
        return Err(OffReason::Dev);
    }
    let platform = platform.ok_or(OffReason::Platform)?;
    if !pubkey_valid(pubkey) {
        return Err(OffReason::NoKey);
    }
    Ok(platform)
}

/// The public key built into this app: tauri.conf.json `plugins.updater.pubkey`
/// ("" when it isn't set).
fn builtin_pubkey(app: &tauri::App) -> String {
    app.config()
        .plugins
        .0
        .get("updater")
        .and_then(|u| u.get("pubkey"))
        .and_then(|k| k.as_str())
        .unwrap_or("")
        .trim()
        .to_string()
}

/// HTTPS on the standard port, no user name or password, and one of
/// ALLOWED_HOSTS exactly.
pub fn url_allowed(url: &Url) -> bool {
    url.scheme() == "https"
        && url.username().is_empty()
        && url.password().is_none()
        && url.port_or_known_default() == Some(443)
        && url.host_str().is_some_and(|h| ALLOWED_HOSTS.contains(&h))
}

/// A redirect is followed only to an allowed URL, and only a few times.
/// `already` is how many URLs were requested so far (reqwest's `previous()`).
pub fn redirect_allowed(next: &Url, already: usize) -> bool {
    already <= MAX_REDIRECTS && url_allowed(next)
}

/// The file an update manifest points to must be an asset of a GreenCLI
/// release (GitHub then redirects to its download host).
pub fn download_url_ok(url: &Url) -> bool {
    if !url_allowed(url) || url.query().is_some() || url.fragment().is_some() {
        return false;
    }
    let path = url.path();
    let starts = |prefix: &str| {
        path.get(..prefix.len())
            .is_some_and(|p| p.eq_ignore_ascii_case(prefix))
    };
    match url.host_str() {
        Some("api.github.com") => {
            starts(ASSET_API_PREFIX) && {
                let id = &path[ASSET_API_PREFIX.len()..];
                !id.is_empty() && id.bytes().all(|b| b.is_ascii_digit())
            }
        }
        Some("github.com") => starts(DOWNLOAD_PATH_PREFIX),
        _ => false,
    }
}

/// Install only a newer version. Build metadata (`+…`) is ignored, as semver
/// says; a pre-release sorts before its release.
pub fn is_newer(current: &Version, remote: &Version) -> bool {
    remote.cmp_precedence(current) == Ordering::Greater
}

/// The contents of a Tauri `.pub` file: base64 of a minisign public key.
pub fn pubkey_valid(pubkey: &str) -> bool {
    use base64::Engine;
    let Ok(raw) = base64::engine::general_purpose::STANDARD.decode(pubkey.trim()) else {
        return false;
    };
    let Ok(text) = String::from_utf8(raw) else {
        return false;
    };
    minisign_verify::PublicKey::decode(&text).is_ok()
}

/// Keep the updater plugin's own requests (latest.json and the update file)
/// on HTTPS and on GitHub's release hosts.
fn limit_client(b: reqwest_updater::ClientBuilder) -> reqwest_updater::ClientBuilder {
    b.https_only(true)
        .redirect(reqwest_updater::redirect::Policy::custom(|a| {
            if redirect_allowed(a.url(), a.previous().len()) {
                a.follow()
            } else {
                a.error("redirect to a host GreenCLI doesn't use for updates")
            }
        }))
}

fn is_signature_error(e: &tauri_plugin_updater::Error) -> bool {
    use tauri_plugin_updater::Error as E;
    matches!(
        e,
        E::Minisign(_)
            | E::Base64(_)
            | E::SignatureUtf8(_)
            | E::SignedVersionMismatch { .. }
            | E::MissingSignedVersion
    )
}

/// The latest release has nothing for this system (no manifest, or no entry
/// for this platform): treat it as "no update".
fn is_no_release(e: &tauri_plugin_updater::Error) -> bool {
    use tauri_plugin_updater::Error as E;
    matches!(e, E::ReleaseNotFound | E::TargetNotFound(_) | E::TargetsNotFound(_))
}

/// A downloaded update whose signature passed, waiting for "Restart to update".
struct Pending {
    update: Update,
    bytes: Vec<u8>,
}

pub struct UpdaterState {
    /// Why updates are off, or None when the updater plugin is registered.
    off: Option<OffReason>,
    pending: Mutex<Option<Pending>>,
    /// One check at a time (the daily check and the button can overlap).
    checking: tokio::sync::Mutex<()>,
}

impl UpdaterState {
    fn pending_version(&self) -> Option<String> {
        self.pending
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .as_ref()
            .map(|p| p.update.version.clone())
    }
}

/// Register the updater plugin when updates are on, and always manage
/// UpdaterState so the commands can answer. A plugin that fails to start
/// turns updates off instead of stopping the app.
pub fn register(app: &tauri::App) {
    let pubkey = builtin_pubkey(app);
    let off = match updates_enabled(cfg!(debug_assertions), current_platform(), &pubkey) {
        Err(reason) => {
            if reason == OffReason::NoKey && !pubkey.is_empty() {
                log::warn!("Updates are off: the built-in update key is not a valid public key");
            }
            Some(reason)
        }
        Ok(_) => match app.handle().plugin(tauri_plugin_updater::Builder::new().build()) {
            Ok(()) => None,
            Err(e) => {
                log::warn!("Updates are off: the updater didn't start: {e}");
                Some(OffReason::Setup)
            }
        },
    };
    app.manage(UpdaterState {
        off,
        pending: Mutex::new(None),
        checking: tokio::sync::Mutex::new(()),
    });
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatus {
    /// This app's version.
    version: String,
    enabled: bool,
    reason: Option<OffReason>,
    place: InstallPlace,
    /// A downloaded update's version, ready for "Restart to update".
    ready: Option<String>,
}

#[tauri::command]
pub fn update_status(app: AppHandle, state: State<'_, UpdaterState>) -> UpdateStatus {
    UpdateStatus {
        version: app.package_info().version.to_string(),
        enabled: state.off.is_none(),
        reason: state.off,
        place: current_place(),
        ready: state.pending_version(),
    }
}

fn current_place() -> InstallPlace {
    std::env::current_exe()
        .map(|exe| install_place(&exe))
        .unwrap_or(InstallPlace::Normal)
}

/// Look for a newer version and, when there is one, download it and check its
/// signature. Returns the new version, or None when this is the latest.
/// Never installs.
#[tauri::command]
pub async fn update_check(
    app: AppHandle,
    state: State<'_, UpdaterState>,
) -> Result<Option<String>, String> {
    if state.off.is_some() {
        return Err(ERR_OFF.into());
    }
    let _one_at_a_time = state.checking.lock().await;
    if let Some(version) = state.pending_version() {
        return Ok(Some(version));
    }

    let endpoint = Url::parse(LATEST_JSON_URL).map_err(|_| ERR_NETWORK)?;
    // The plugin is registered (state.off is None), so updater_builder has
    // its state, with the built-in public key from the config.
    let updater = app
        .updater_builder()
        .endpoints(vec![endpoint])
        .and_then(|b| {
            b.timeout(CHECK_TIMEOUT)
                .version_comparator(|current, release| is_newer(&current, &release.version))
                .configure_client(limit_client)
                .build()
        })
        .map_err(|e| {
            log::warn!("Update check setup failed: {e}");
            ERR_NETWORK
        })?;
    let mut update = match updater.check().await {
        Ok(Some(update)) => update,
        Ok(None) => return Ok(None),
        Err(e) if is_no_release(&e) => return Ok(None),
        Err(e) => {
            log::warn!("Update check failed: {}", plain_error(&e));
            return Err(ERR_NETWORK.into());
        }
    };
    if !download_url_ok(&update.download_url) {
        log::warn!("Update refused: its file is not a GreenCLI release asset");
        return Err(ERR_SOURCE.into());
    }
    update.timeout = Some(DOWNLOAD_TIMEOUT);
    let bytes = update.download(|_, _| {}, || {}).await.map_err(|e| {
        log::warn!("Update download failed: {}", plain_error(&e));
        if is_signature_error(&e) {
            ERR_SIGNATURE
        } else {
            ERR_NETWORK
        }
    })?;
    let version = update.version.clone();
    *state.pending.lock().unwrap_or_else(|p| p.into_inner()) = Some(Pending { update, bytes });
    Ok(Some(version))
}

/// Plugin errors for the log, with reqwest's URL left out.
fn plain_error(e: &tauri_plugin_updater::Error) -> String {
    match e {
        tauri_plugin_updater::Error::Reqwest(r) => {
            let mut r = r.to_string();
            if let Some(i) = r.find(" for url (") {
                r.truncate(i);
            }
            r
        }
        other => other.to_string(),
    }
}

/// Install the downloaded update and restart. The app calls this only after
/// the user taps "Restart to update" and confirms.
#[tauri::command]
pub async fn update_install(app: AppHandle, state: State<'_, UpdaterState>) -> Result<(), String> {
    if state.off.is_some() {
        return Err(ERR_OFF.into());
    }
    if current_place() != InstallPlace::Normal {
        return Err(ERR_PLACE.into());
    }
    let pending = state
        .pending
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .take()
        .ok_or(ERR_NOT_READY)?;

    // Windows: the installer closes the app right away (process exit, no
    // RunEvent::Exit), so stop MCP servers and CLI runs first. Elsewhere the
    // restart below goes through RunEvent::Exit, which does it.
    #[cfg(windows)]
    crate::shutdown_children(&app).await;

    let result = tauri::async_runtime::spawn_blocking(move || {
        let r = pending.update.install(&pending.bytes);
        (r, pending)
    })
    .await;
    match result {
        Ok((Ok(()), _)) => {
            app.request_restart();
            Ok(())
        }
        Ok((Err(e), pending)) => {
            log::warn!("Update install failed: {}", plain_error(&e));
            // Keep it, so "Restart to update" can be tried again.
            *state.pending.lock().unwrap_or_else(|p| p.into_inner()) = Some(pending);
            Err(ERR_INSTALL.into())
        }
        Err(e) => {
            log::warn!("Update install failed: {e}");
            Err(ERR_INSTALL.into())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    /// The public half of a key pair made once with `tauri signer generate`;
    /// the private key was deleted.
    const TEST_PUB: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDg2Q0EzNTY5MkZFMzg0NzAKUldSd2hPTXZhVFhLaHE3bDdsNmdqQnpkS3FzUEF0c1pQM1JFdmZicTR1SkFZY1huZDNoMlBtakMK";

    /// The platforms release.yml builds, in the `<os>-<arch>` form Tauri uses
    /// in latest.json.
    const SHIPPED_PLATFORMS: [&str; 3] = ["darwin-aarch64", "darwin-x86_64", "windows-x86_64"];

    fn url(s: &str) -> Url {
        Url::parse(s).unwrap()
    }

    fn v(s: &str) -> Version {
        Version::parse(s).unwrap()
    }

    #[test]
    fn platform_names_match_tauri() {
        assert_eq!(platform_key("macos", "aarch64"), Some("darwin-aarch64"));
        assert_eq!(platform_key("macos", "x86_64"), Some("darwin-x86_64"));
        assert_eq!(platform_key("windows", "x86_64"), Some("windows-x86_64"));
        // No release build for these, so no updates.
        for (os, arch) in [("linux", "x86_64"), ("windows", "aarch64"), ("windows", "x86"), ("freebsd", "x86_64")] {
            assert_eq!(platform_key(os, arch), None, "{os}-{arch}");
        }
        // Every shipped platform has a mapping, and nothing else does.
        let mapped: Vec<&str> = [("macos", "aarch64"), ("macos", "x86_64"), ("windows", "x86_64")]
            .iter()
            .filter_map(|(o, a)| platform_key(o, a))
            .collect();
        assert_eq!(mapped, SHIPPED_PLATFORMS);
        // On a shipped system, the name is the one the updater plugin itself
        // looks up in latest.json.
        if let Some(p) = current_platform() {
            assert_eq!(Some(p.to_string()), tauri_plugin_updater::target());
        }
    }

    #[test]
    fn manifest_url() {
        let manifest = url(LATEST_JSON_URL);
        assert!(url_allowed(&manifest));
        assert_eq!(manifest.path(), "/Choaterboater/GreenCli/releases/latest/download/latest.json");
    }

    #[test]
    fn only_https_github_release_hosts() {
        for ok in [
            "https://github.com/Choaterboater/GreenCli/releases/latest/download/latest.json",
            "https://objects.githubusercontent.com/github-production-release-asset-2e65be/1?x=1",
            "https://release-assets.githubusercontent.com/github-production-release-asset/1/2?sp=r",
            "https://github.com:443/a",
            "https://api.github.com/repos/Choaterboater/GreenCli/releases/assets/1",
        ] {
            assert!(url_allowed(&url(ok)), "{ok}");
        }
        for bad in [
            "http://github.com/Choaterboater/GreenCli/releases/latest/download/latest.json",
            "https://github.com.evil.example/x",
            "https://evilgithub.com/x",
            "https://raw.githubusercontent.com/x",
            "https://gist.githubusercontent.com/x",
            "https://user:pw@github.com/x",
            "https://user@github.com/x",
            "https://github.com:8443/x",
            "https://140.82.112.3/x",
            "https://[::1]/x",
            "ftp://github.com/x",
            "file:///etc/passwd",
        ] {
            assert!(!url_allowed(&url(bad)), "{bad}");
        }
    }

    #[test]
    fn redirects_stay_on_allowed_hosts_and_stop() {
        let asset = url("https://release-assets.githubusercontent.com/a");
        assert!(redirect_allowed(&asset, 1));
        assert!(redirect_allowed(&asset, MAX_REDIRECTS));
        assert!(!redirect_allowed(&asset, MAX_REDIRECTS + 1));
        assert!(!redirect_allowed(&url("https://example.com/a"), 1));
        assert!(!redirect_allowed(&url("http://objects.githubusercontent.com/a"), 1));
    }

    #[test]
    fn update_files_must_be_greencli_release_assets() {
        // What tauri-action writes into latest.json.
        assert!(download_url_ok(&url(
            "https://api.github.com/repos/Choaterboater/GreenCli/releases/assets/301234567"
        )));
        assert!(download_url_ok(&url(
            "https://github.com/Choaterboater/GreenCli/releases/download/v2.0.1/GreenCLI.app.tar.gz"
        )));
        assert!(download_url_ok(&url(
            "https://github.com/choaterboater/greencli/releases/download/v2.0.1/GreenCLI_2.0.1_x64-setup.exe"
        )));
        for bad in [
            "https://github.com/someone/GreenCli/releases/download/v2.0.1/GreenCLI.app.tar.gz",
            "https://github.com/Choaterboater/GreenCli-fork/releases/download/v2/x",
            "https://github.com/Choaterboater/GreenCli/archive/refs/tags/v2.0.1.tar.gz",
            "https://github.com/Choaterboater/GreenCli/releases/download/v2.0.1/x?token=1",
            "https://api.github.com/repos/someone/GreenCli/releases/assets/301234567",
            "https://api.github.com/repos/Choaterboater/GreenCli/releases/assets/",
            "https://api.github.com/repos/Choaterboater/GreenCli/releases/assets/12/../../../x",
            "https://api.github.com/repos/Choaterboater/GreenCli/releases/assets/12x",
            "https://api.github.com/repos/Choaterboater/GreenCli/releases/assets/12?access_token=1",
            "https://api.github.com/repos/Choaterboater/GreenCli/contents/x",
            "https://github.com/Choaterboater/GreenCli/releases/assets/12",
            "https://objects.githubusercontent.com/Choaterboater/GreenCli/releases/download/v2/x",
            "http://github.com/Choaterboater/GreenCli/releases/download/v2.0.1/x",
            "https://example.com/Choaterboater/GreenCli/releases/download/v2.0.1/x",
        ] {
            assert!(!download_url_ok(&url(bad)), "{bad}");
        }
    }

    #[test]
    fn version_compare() {
        assert!(is_newer(&v("1.9.0"), &v("2.0.0")));
        assert!(is_newer(&v("2.0.0"), &v("2.0.1")));
        assert!(is_newer(&v("1.9.0"), &v("1.10.0")), "numbers, not text");
        assert!(is_newer(&v("2.0.0-beta.1"), &v("2.0.0")));
        assert!(is_newer(&v("2.0.0-beta.1"), &v("2.0.0-beta.2")));
        assert!(!is_newer(&v("2.0.0"), &v("2.0.0")), "same version");
        assert!(!is_newer(&v("2.0.0"), &v("1.9.0")), "never a downgrade");
        assert!(!is_newer(&v("2.0.0"), &v("2.0.0-rc.1")), "a pre-release is older");
        assert!(!is_newer(&v("2.0.0"), &v("2.0.0+build.5")), "build metadata is not newer");
        assert!(!is_newer(&v("10.0.0"), &v("9.9.9")));
    }

    #[test]
    fn public_keys() {
        assert!(pubkey_valid(TEST_PUB));
        assert!(pubkey_valid(&format!("  {TEST_PUB}\n")));
        for bad in ["", "   ", "junk", "dW50cnVzdGVkIGNvbW1lbnQ6IGhp", "!!!!"] {
            assert!(!pubkey_valid(bad), "{bad:?}");
        }
    }

    #[test]
    fn updates_on_only_in_release_builds_of_shipped_systems_with_a_key() {
        let mac = Some("darwin-aarch64");
        assert_eq!(updates_enabled(false, mac, TEST_PUB), Ok("darwin-aarch64"));
        assert_eq!(updates_enabled(true, mac, TEST_PUB), Err(OffReason::Dev));
        assert_eq!(updates_enabled(false, None, TEST_PUB), Err(OffReason::Platform));
        assert_eq!(updates_enabled(true, None, TEST_PUB), Err(OffReason::Dev));
        // No built-in key (the owner hasn't sent it yet), or a broken one: off.
        assert_eq!(updates_enabled(false, mac, ""), Err(OffReason::NoKey));
        assert_eq!(updates_enabled(false, mac, "  "), Err(OffReason::NoKey));
        assert_eq!(updates_enabled(false, mac, "junk"), Err(OffReason::NoKey));
        assert_eq!(serde_json::to_value(OffReason::Platform).unwrap(), "platform");
        assert_eq!(serde_json::to_value(OffReason::NoKey).unwrap(), "noKey");
    }

    #[test]
    fn this_build_has_updates_off_until_the_key_is_built_in() {
        let key = conf()["plugins"]["updater"]["pubkey"].as_str().unwrap().to_string();
        let r = updates_enabled(false, Some("darwin-aarch64"), &key);
        if key.trim().is_empty() {
            assert_eq!(r, Err(OffReason::NoKey));
        } else {
            assert_eq!(r, Ok("darwin-aarch64"));
        }
    }


    fn conf() -> Value {
        serde_json::from_str(include_str!("../tauri.conf.json")).unwrap()
    }

    #[test]
    fn config_key_and_the_github_endpoint() {
        let c = conf();
        let u = &c["plugins"]["updater"];
        // The owner's public key, built into the app; empty until he sends it
        // (updates stay off). Never a private key or anything else.
        let key = u["pubkey"].as_str().expect("pubkey is text");
        assert!(key.is_empty() || pubkey_valid(key), "pubkey must be empty or a minisign public key");
        assert_eq!(key, key.trim(), "no spaces or line breaks around the key");
        assert_eq!(u["endpoints"], serde_json::json!([LATEST_JSON_URL]));
        assert_eq!(u["requireSignedVersion"], true);
        assert!(u.get("dangerousInsecureTransportProtocol").is_none());
        assert!(u.get("dangerousAcceptInvalidCerts").is_none());
        assert!(u.get("dangerousAcceptInvalidHostnames").is_none());
        assert!(u.get("allowDowngrades").is_none());
        // Update files are made only by release builds (release.yml --config).
        let made = &c["bundle"]["createUpdaterArtifacts"];
        assert!(made.is_null() || *made == false);
        // The plugin reads this section at start: it must parse, or the
        // updater would turn itself off.
        let parsed: tauri_plugin_updater::Config = serde_json::from_value(u.clone()).unwrap();
        assert!(parsed.require_signed_version);
        assert_eq!(parsed.endpoints, vec![url(LATEST_JSON_URL)]);
    }

    /// A file signed the way release builds sign update files (a key from
    /// `tauri signer generate`, then `tauri signer sign --app-version 2.0.1`);
    /// the private key was deleted.
    const SIGNED_PUB: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDZEMDdBRjE0NDk5M0ZEQ0YKUldUUC9aTkpGSzhIYlVnRGd4UjJJOWRMeVRoUVMvZytOTC9FRWFVNSs5RExnYmFsWmdsY1pWcjkK";
    const SIGNED_SIG: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVUUC9aTkpGSzhIYlEyemFrNWo5SFB0RHpoOFkwWDVqcnVFOGpxeTBPc3MvRUhERjROQ3NoVzJoUFgrTjlEQzBtckJMZDJrQnZDVHM4enZxazVDTFA3elFMbytqOVA1dUE0PQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzkwOTQ5MTU0CWZpbGU6Zml4dHVyZS50eHQJdmVyc2lvbjoyLjAuMQpXN1ZzeHBISzVxRWgwbExWYVEreGhmdHM5UUczUUNBK2lMTVJzcFk0bkFqdTEveWdzb3BhNDZBTTZWQ2dpbWNHbVVHeWhZZ3R0cG9ORmUyOXM3NlZEUT09Cg==";
    const SIGNED_DATA: &[u8] = b"GreenCLI update test\n";

    fn b64_text(s: &str) -> String {
        use base64::Engine;
        String::from_utf8(base64::engine::general_purpose::STANDARD.decode(s).unwrap()).unwrap()
    }

    /// The updater plugin checks downloads like this (minisign-verify, with
    /// the built-in key); a release build's signature must pass, and only for
    /// its own file and key.
    #[test]
    fn release_signatures_verify_with_the_builtin_key() {
        use minisign_verify::{PublicKey, Signature};
        assert!(pubkey_valid(SIGNED_PUB));
        let key = PublicKey::decode(&b64_text(SIGNED_PUB)).unwrap();
        let sig = Signature::decode(&b64_text(SIGNED_SIG)).unwrap();
        key.verify(SIGNED_DATA, &sig, false).unwrap();
        // The signed version requireSignedVersion compares with latest.json.
        assert!(sig.trusted_comment().split('\t').any(|f| f == "version:2.0.1"));
        assert!(key.verify(b"GreenCLI update test!\n", &sig, false).is_err());
        let other = PublicKey::decode(&b64_text(TEST_PUB)).unwrap();
        assert!(other.verify(SIGNED_DATA, &sig, false).is_err());
    }

    /// release.yml signs with the owner's key from the repo secrets, makes
    /// update files only when that key and the built-in public key are both
    /// there, and never makes or downloads a key of its own.
    #[test]
    fn release_workflow_signs_with_the_owner_key() {
        let yml = include_str!("../../.github/workflows/release.yml");
        // The platforms release.yml builds have the app's names.
        let mut pairs = Vec::new();
        let mut target = None;
        for line in yml.lines().map(str::trim) {
            if let Some(t) = line.strip_prefix("target: ").or_else(|| line.strip_prefix("- target: ")) {
                if !t.contains("${{") {
                    target = Some(t.trim().to_string());
                }
            } else if let Some(p) = line.strip_prefix("updater: ") {
                pairs.push((target.take().expect("target before updater"), p.trim().to_string()));
            }
        }
        assert_eq!(pairs.len(), SHIPPED_PLATFORMS.len(), "{pairs:?}");
        for (target, platform) in &pairs {
            let arch = target.split('-').next().unwrap();
            let os = if target.contains("apple-darwin") {
                "macos"
            } else if target.contains("windows") {
                "windows"
            } else {
                "other"
            };
            assert_eq!(platform_key(os, arch), Some(platform.as_str()), "{target}");
        }
        assert!(yml.contains("TAURI_SIGNING_PRIVATE_KEY: ${{ steps.upd.outputs.on == 'true' && secrets.TAURI_SIGNING_PRIVATE_KEY || '' }}"));
        assert!(yml.contains("TAURI_SIGNING_PRIVATE_KEY_PASSWORD: ${{ steps.upd.outputs.on == 'true' && secrets.TAURI_SIGNING_PRIVATE_KEY_PASSWORD || '' }}"));
        assert!(yml.contains("uploadUpdaterJson: ${{ steps.upd.outputs.on == 'true' }}"));
        assert!(yml.contains("config-key src-tauri/tauri.conf.json"));
        for gone in ["signer generate", "update-key-", "npx -y", "@tauri-apps/cli@"] {
            assert!(!yml.contains(gone), "release.yml still has {gone:?}");
        }
        // The private key only ever goes to tauri-action through env.
        for line in yml.lines().filter(|l| l.contains("TAURI_SIGNING_PRIVATE_KEY")) {
            assert!(!line.contains("GITHUB_ENV") && !line.contains("GITHUB_OUTPUT"), "{line}");
            assert!(!line.contains("echo"), "{line}");
        }
    }
}
