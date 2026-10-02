//! Automatic updates from GreenCLI's GitHub releases.
//!
//! There is no long-lived signing key. Every release build makes a one-time
//! key pair, signs its update files with it, and publishes the public half next
//! to them as `update-key-<os>-<arch>.pub` (release.yml). When the app checks
//! for an update it first fetches that public key from the latest published
//! release (HTTPS only, GitHub's release hosts only, size-capped), then gives
//! it to the updater, which checks the downloaded file's signature against it.
//! Drafts are invisible at /releases/latest, so only published releases count.
//!
//! Checking downloads the update but never installs it: only `update_install`
//! does, and the app calls that only when the user taps "Restart to update".

use std::{cmp::Ordering, sync::Mutex, time::Duration};

use reqwest::Url;
use semver::Version;
use serde::Serialize;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_updater::{Update, UpdaterExt};

use crate::app_location::{install_place, InstallPlace};

/// GreenCLI's releases. Everything the updater fetches starts here.
pub const RELEASES: &str = "https://github.com/Choaterboater/GreenCli/releases";
/// The update manifest tauri-action writes into each release.
pub const LATEST_JSON_URL: &str =
    "https://github.com/Choaterboater/GreenCli/releases/latest/download/latest.json";
/// Update files must be assets of a GreenCLI release (the path under github.com).
const DOWNLOAD_PATH_PREFIX: &str = "/Choaterboater/GreenCli/releases/download/";
/// The only hosts update requests may reach: github.com, and the hosts it
/// redirects release downloads to (release-assets is where GitHub sends them
/// today, objects is the older name).
pub const ALLOWED_HOSTS: [&str; 3] = [
    "github.com",
    "objects.githubusercontent.com",
    "release-assets.githubusercontent.com",
];
/// A minisign public key file is about 150 bytes.
const MAX_KEY_BYTES: usize = 4096;
const MAX_REDIRECTS: usize = 5;
const KEY_TIMEOUT: Duration = Duration::from_secs(20);
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

/// The release asset that holds a platform's public key.
pub fn key_asset_name(platform: &str) -> String {
    format!("update-key-{platform}.pub")
}

/// Where the latest published release keeps a platform's public key.
pub fn key_url(platform: &str) -> String {
    format!("{RELEASES}/latest/download/{}", key_asset_name(platform))
}

/// Whether updates run in this build.
pub fn updates_enabled(is_dev: bool, platform: Option<&str>) -> Result<&str, OffReason> {
    if is_dev {
        return Err(OffReason::Dev);
    }
    platform.ok_or(OffReason::Platform)
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
/// release on github.com (GitHub then redirects to its download host).
pub fn download_url_ok(url: &Url) -> bool {
    url_allowed(url)
        && url.host_str() == Some("github.com")
        && url.query().is_none()
        && url
            .path()
            .get(..DOWNLOAD_PATH_PREFIX.len())
            .is_some_and(|p| p.eq_ignore_ascii_case(DOWNLOAD_PATH_PREFIX))
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

/// A downloaded key file: the key text when it is a real public key.
fn parse_key(body: &[u8]) -> Option<String> {
    let text = std::str::from_utf8(body).ok()?.trim();
    pubkey_valid(text).then(|| text.to_string())
}

#[derive(Debug, PartialEq, Eq)]
enum KeyError {
    Network,
    /// Too big, not text, or not a public key.
    Bad,
}

/// Fetch the latest release's public key for `platform`. `Ok(None)` when the
/// latest release has no key for it (no update for this system).
async fn fetch_update_key(platform: &str) -> Result<Option<String>, KeyError> {
    let net = |e: reqwest::Error| {
        log::warn!("Update key download failed: {}", e.without_url());
        KeyError::Network
    };
    let client = reqwest::Client::builder()
        .https_only(true)
        .redirect(reqwest::redirect::Policy::custom(|a| {
            if redirect_allowed(a.url(), a.previous().len()) {
                a.follow()
            } else {
                a.error("redirect to a host GreenCLI doesn't use for updates")
            }
        }))
        .timeout(KEY_TIMEOUT)
        .user_agent(concat!("GreenCLI/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(net)?;
    let mut resp = client.get(key_url(platform)).send().await.map_err(net)?;
    if !url_allowed(resp.url()) {
        return Err(KeyError::Network);
    }
    if resp.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(None);
    }
    if !resp.status().is_success() {
        log::warn!("Update key download failed: HTTP {}", resp.status());
        return Err(KeyError::Network);
    }
    if resp.content_length().is_some_and(|n| n > MAX_KEY_BYTES as u64) {
        return Err(KeyError::Bad);
    }
    let mut body = Vec::new();
    while let Some(chunk) = resp.chunk().await.map_err(net)? {
        if body.len() + chunk.len() > MAX_KEY_BYTES {
            return Err(KeyError::Bad);
        }
        body.extend_from_slice(&chunk);
    }
    parse_key(&body).map(Some).ok_or(KeyError::Bad)
}

/// Keep the updater plugin's own requests (latest.json and the update file)
/// on HTTPS and on GitHub's release hosts, like the key download.
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
    let off = match updates_enabled(cfg!(debug_assertions), current_platform()) {
        Err(reason) => Some(reason),
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
    let platform = current_platform().ok_or(ERR_OFF)?;
    let _one_at_a_time = state.checking.lock().await;
    if let Some(version) = state.pending_version() {
        return Ok(Some(version));
    }

    let pubkey = match fetch_update_key(platform).await {
        Ok(Some(key)) => key,
        Ok(None) => return Ok(None),
        Err(KeyError::Network) => return Err(ERR_NETWORK.into()),
        Err(KeyError::Bad) => return Err(ERR_SIGNATURE.into()),
    };
    let endpoint = Url::parse(LATEST_JSON_URL).map_err(|_| ERR_NETWORK)?;
    // The plugin is registered (state.off is None), so updater_builder has
    // its state. The key fetched above replaces the empty one in the config.
    let updater = app
        .updater_builder()
        .pubkey(pubkey)
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
    /// in latest.json. Each has its own key file.
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
    fn key_file_names_and_urls() {
        assert_eq!(key_asset_name("darwin-aarch64"), "update-key-darwin-aarch64.pub");
        assert_eq!(
            key_url("windows-x86_64"),
            "https://github.com/Choaterboater/GreenCli/releases/latest/download/update-key-windows-x86_64.pub"
        );
        for p in SHIPPED_PLATFORMS {
            let u = url(&key_url(p));
            assert!(url_allowed(&u), "{u}");
            assert!(u.path().starts_with("/Choaterboater/GreenCli/releases/latest/download/"));
        }
        let manifest = url(LATEST_JSON_URL);
        assert!(url_allowed(&manifest));
        assert_eq!(manifest.as_str(), format!("{RELEASES}/latest/download/latest.json"));
    }

    #[test]
    fn only_https_github_release_hosts() {
        for ok in [
            "https://github.com/Choaterboater/GreenCli/releases/latest/download/latest.json",
            "https://objects.githubusercontent.com/github-production-release-asset-2e65be/1?x=1",
            "https://release-assets.githubusercontent.com/github-production-release-asset/1/2?sp=r",
            "https://github.com:443/a",
        ] {
            assert!(url_allowed(&url(ok)), "{ok}");
        }
        for bad in [
            "http://github.com/Choaterboater/GreenCli/releases/latest/download/latest.json",
            "https://github.com.evil.example/x",
            "https://evilgithub.com/x",
            "https://api.github.com/repos/x",
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
        assert_eq!(parse_key(format!("{TEST_PUB}\n").as_bytes()).as_deref(), Some(TEST_PUB));
        assert_eq!(parse_key(b"<html>Not Found</html>"), None);
        assert_eq!(parse_key(&[0xff, 0xfe, 0x00]), None);
    }

    #[test]
    fn updates_on_only_in_release_builds_of_shipped_systems() {
        assert_eq!(updates_enabled(false, Some("darwin-aarch64")), Ok("darwin-aarch64"));
        assert_eq!(updates_enabled(true, Some("darwin-aarch64")), Err(OffReason::Dev));
        assert_eq!(updates_enabled(false, None), Err(OffReason::Platform));
        assert_eq!(updates_enabled(true, None), Err(OffReason::Dev));
        assert_eq!(serde_json::to_value(OffReason::Platform).unwrap(), "platform");
    }

    fn conf() -> Value {
        serde_json::from_str(include_str!("../tauri.conf.json")).unwrap()
    }

    #[test]
    fn config_has_no_key_and_the_github_endpoint() {
        let c = conf();
        let u = &c["plugins"]["updater"];
        // The key comes from each release at check time, never from the config.
        assert_eq!(u["pubkey"], "", "no public key in tauri.conf.json");
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
}
