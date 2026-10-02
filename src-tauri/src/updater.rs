//! Automatic updates from GreenCLI's GitHub releases.
//!
//! How updates are trusted. Nobody keeps a signing key:
//! - Each release build makes its own one-time key pair, signs its update
//!   files with it, and puts the public half in the same release as
//!   `update-key-<os>-<arch>.pub` (release.yml). The private half never
//!   leaves the build job and is deleted right after the build.
//! - A check reads only the version from the latest release's latest.json,
//!   then takes the manifest and the key from that one release
//!   (`releases/download/v<version>/`), so they always belong together.
//! - The signature catches a broken, cut-short or swapped download, and a
//!   file from anywhere else. It trusts the GitHub account that publishes the
//!   releases: the same trust as downloading GreenCLI from the Releases page.
//!   So keep two-factor login on that account.
//!
//! All requests are HTTPS to GitHub's release hosts only. Drafts are not
//! visible at /releases/latest, so only published releases count.
//!
//! Checking downloads the update but never installs it: only `update_install`
//! does, and the app calls that only when the user taps "Restart to update".

use std::{
    cmp::Ordering,
    sync::{Arc, Mutex},
    time::Duration,
};

use reqwest::Url;
use semver::Version;
use serde::Serialize;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_updater::{Update, UpdaterExt};

use crate::app_location::{install_place, InstallPlace};

/// GreenCLI's releases. Everything the updater fetches starts here.
pub const RELEASES: &str = "https://github.com/Choaterboater/GreenCli/releases";
/// The latest published release's manifest. The app reads only its version.
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
/// A minisign public key file is about 150 bytes.
const MAX_KEY_BYTES: usize = 4096;
/// latest.json is a few KB (five entries and the release notes).
const MAX_MANIFEST_BYTES: usize = 1024 * 1024;
const MAX_REDIRECTS: usize = 5;
const FETCH_TIMEOUT: Duration = Duration::from_secs(20);
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

/// Whether updates run in this build: a release build, for a system
/// release.yml builds.
pub fn updates_enabled(is_dev: bool, platform: Option<&str>) -> Result<&str, OffReason> {
    if is_dev {
        return Err(OffReason::Dev);
    }
    platform.ok_or(OffReason::Platform)
}

/// The version in a release's latest.json, when it is plain semver: numbers
/// like 2.0.1, maybe with a pre-release part like -beta.1, nothing else. A
/// leading "v" is dropped, as the updater does. The version becomes part of
/// the release URLs, so anything odd means "not a release we can use".
pub fn plain_version(text: &str) -> Option<Version> {
    let text = text.strip_prefix('v').unwrap_or(text);
    let plain = !text.is_empty()
        && text.len() <= 64
        && text
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-');
    if !plain {
        return None;
    }
    let version = Version::parse(text).ok()?;
    // Exactly as written: the tag must be v<this text>.
    (version.to_string() == text).then_some(version)
}

/// The `version` field of a latest.json body (nothing else is read).
pub fn manifest_version(body: &[u8]) -> Option<Version> {
    let manifest: serde_json::Value = serde_json::from_slice(body).ok()?;
    plain_version(manifest.as_object()?.get("version")?.as_str()?)
}

/// Where one release keeps its files. release.yml tags a release
/// `v<version>` (tauri-action's `v__VERSION__`), and its update-files job
/// fails when latest.json's version doesn't match the tag.
fn release_dir(version: &Version) -> String {
    format!("{RELEASES}/download/v{version}")
}

/// One release's update manifest (written by tauri-action).
pub fn manifest_url(version: &Version) -> String {
    format!("{}/latest.json", release_dir(version))
}

/// The release asset that holds a platform's public key.
pub fn key_asset_name(platform: &str) -> String {
    format!("update-key-{platform}.pub")
}

/// Where one release keeps a platform's public key.
pub fn key_url(version: &Version, platform: &str) -> String {
    format!("{}/{}", release_dir(version), key_asset_name(platform))
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

/// Offer the release's update only when its manifest has the version the
/// check started from (the same release the key came from) and it is newer.
pub fn should_offer(current: &Version, release: &Version, remote: &Version) -> bool {
    remote == release && is_newer(current, remote)
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
enum FetchError {
    Network,
    TooBig,
}

/// The client for the small files the app fetches itself (latest.json and
/// the key): HTTPS only, GitHub's release hosts only, with a time limit.
fn small_client() -> reqwest::Result<reqwest::Client> {
    reqwest::Client::builder()
        .https_only(true)
        .redirect(reqwest::redirect::Policy::custom(|a| {
            if redirect_allowed(a.url(), a.previous().len()) {
                a.follow()
            } else {
                a.error("redirect to a host GreenCLI doesn't use for updates")
            }
        }))
        .timeout(FETCH_TIMEOUT)
        .user_agent(concat!("GreenCLI/", env!("CARGO_PKG_VERSION")))
        .build()
}

/// Fetch a small release file, at most `max` bytes. `Ok(None)` when the
/// release has no such file (HTTP 404).
async fn fetch_small(
    client: &reqwest::Client,
    url: &str,
    max: usize,
) -> Result<Option<Vec<u8>>, FetchError> {
    let net = |e: reqwest::Error| {
        log::warn!("Update file download failed: {}", e.without_url());
        FetchError::Network
    };
    let url = Url::parse(url).map_err(|_| FetchError::Network)?;
    if !url_allowed(&url) {
        return Err(FetchError::Network);
    }
    let mut resp = client.get(url).send().await.map_err(net)?;
    if !url_allowed(resp.url()) {
        return Err(FetchError::Network);
    }
    if resp.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(None);
    }
    if !resp.status().is_success() {
        log::warn!("Update file download failed: HTTP {}", resp.status());
        return Err(FetchError::Network);
    }
    if resp.content_length().is_some_and(|n| n > max as u64) {
        return Err(FetchError::TooBig);
    }
    let mut body = Vec::new();
    while let Some(chunk) = resp.chunk().await.map_err(net)? {
        if body.len() + chunk.len() > max {
            return Err(FetchError::TooBig);
        }
        body.extend_from_slice(&chunk);
    }
    Ok(Some(body))
}

/// The latest published release's version, from its latest.json. `Ok(None)`
/// when there is no such file (no release with update files yet).
async fn latest_release(client: &reqwest::Client) -> Result<Option<Version>, &'static str> {
    let body = match fetch_small(client, LATEST_JSON_URL, MAX_MANIFEST_BYTES).await {
        Ok(Some(body)) => body,
        Ok(None) => return Ok(None),
        Err(_) => return Err(ERR_NETWORK),
    };
    match manifest_version(&body) {
        Some(version) => Ok(Some(version)),
        None => {
            log::warn!("Update check failed: latest.json has no plain version");
            Err(ERR_NETWORK)
        }
    }
}

/// One release's public key for `platform`. `Ok(None)` when that release has
/// no key for it (no update for this system).
async fn release_key(
    client: &reqwest::Client,
    release: &Version,
    platform: &str,
) -> Result<Option<String>, &'static str> {
    match fetch_small(client, &key_url(release, platform), MAX_KEY_BYTES).await {
        Ok(Some(body)) => parse_key(&body).map(Some).ok_or_else(|| {
            log::warn!("Update refused: the release's key file is not a public key");
            ERR_SIGNATURE
        }),
        Ok(None) => Ok(None),
        Err(FetchError::TooBig) => {
            log::warn!("Update refused: the release's key file is too big");
            Err(ERR_SIGNATURE)
        }
        Err(FetchError::Network) => Err(ERR_NETWORK),
    }
}

/// Keep the updater plugin's own requests (latest.json and the update file)
/// on HTTPS and on GitHub's release hosts, like the app's own fetches.
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

/// The release has no entry for this system: treat it as "no update".
/// ReleaseNotFound is not here: the plugin returns it for any non-2xx answer,
/// and the pinned manifest is known to exist (step 1 read it via
/// /releases/latest/download/).
fn is_no_release(e: &tauri_plugin_updater::Error) -> bool {
    use tauri_plugin_updater::Error as E;
    matches!(e, E::TargetNotFound(_) | E::TargetsNotFound(_))
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
    /// Set when the Windows installer hook stopped MCP servers and CLI runs:
    /// the MCP servers that were connected.
    stopped_mcp: Arc<Mutex<Option<Vec<String>>>>,
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
        Ok(_) => match app
            .handle()
            .plugin(tauri_plugin_updater::Builder::new().build())
        {
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
        stopped_mcp: Arc::new(Mutex::new(None)),
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

    let client = small_client().map_err(|e| {
        log::warn!("Update check setup failed: {}", e.without_url());
        ERR_NETWORK
    })?;
    // 1. Which release: the latest one's version. Nothing newer, nothing more
    // to fetch.
    let Some(release) = latest_release(&client).await? else {
        return Ok(None);
    };
    if !is_newer(&app.package_info().version, &release) {
        return Ok(None);
    }
    // 2. That release's key for this system, and 3. that release's manifest:
    // both from the same tag, so a release published in between can't mix
    // one release's key with another's files.
    let Some(pubkey) = release_key(&client, &release, platform).await? else {
        return Ok(None);
    };
    let endpoint = Url::parse(&manifest_url(&release)).map_err(|_| ERR_NETWORK)?;
    // The plugin is registered (state.off is None), so updater_builder has
    // its state. The key fetched above replaces the empty one in the config.
    let stopped = state.stopped_mcp.clone();
    let hook_app = app.clone();
    let updater = app
        .updater_builder()
        .pubkey(pubkey)
        // Windows: runs after the update file is unpacked, just before the
        // installer starts and the app exits (no RunEvent::Exit there), so
        // MCP servers and CLI runs stop only when the install really goes
        // ahead. Elsewhere the restart goes through RunEvent::Exit.
        .on_before_exit(move || {
            let names = tauri::async_runtime::block_on(crate::stop_children_for_update(&hook_app));
            *stopped.lock().unwrap_or_else(|p| p.into_inner()) = Some(names);
        })
        .endpoints(vec![endpoint])
        .and_then(|b| {
            b.timeout(CHECK_TIMEOUT)
                .version_comparator(move |current, remote| {
                    if remote.version != release {
                        log::warn!("Update refused: the release's latest.json has another version");
                    }
                    should_offer(&current, &release, &remote.version)
                })
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

    // Stopping MCP servers and CLI runs on Windows happens in the
    // on_before_exit hook (update_check), right before the installer starts.
    take_stopped(&state.stopped_mcp);
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
            reconnect_if_stopped(&app, &state.stopped_mcp);
            Err(ERR_INSTALL.into())
        }
        Err(e) => {
            log::warn!("Update install failed: {e}");
            reconnect_if_stopped(&app, &state.stopped_mcp);
            Err(ERR_INSTALL.into())
        }
    }
}

/// The MCP servers the Windows hook stopped, when a failed install got that
/// far (the installer then didn't start). Clears what was kept.
fn take_stopped(stopped: &Mutex<Option<Vec<String>>>) -> Option<Vec<String>> {
    stopped.lock().unwrap_or_else(|p| p.into_inner()).take()
}

/// The app keeps running after a failed install: bring back the MCP
/// servers the hook stopped, so the AI's tools don't silently vanish.
fn reconnect_if_stopped(app: &AppHandle, stopped: &Mutex<Option<Vec<String>>>) {
    if let Some(names) = take_stopped(stopped) {
        log::info!("Update install failed after MCP servers stopped: reconnecting them");
        crate::spawn_mcp_connect(app.clone(), Some(names));
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
        for (os, arch) in [
            ("linux", "x86_64"),
            ("windows", "aarch64"),
            ("windows", "x86"),
            ("freebsd", "x86_64"),
        ] {
            assert_eq!(platform_key(os, arch), None, "{os}-{arch}");
        }
        // Every shipped platform has a mapping, and nothing else does.
        let mapped: Vec<&str> = [
            ("macos", "aarch64"),
            ("macos", "x86_64"),
            ("windows", "x86_64"),
        ]
        .iter()
        .filter_map(|(o, a)| platform_key(o, a))
        .collect();
        assert_eq!(mapped, SHIPPED_PLATFORMS);
        // The updater plugin (2.13, `target()`) names a system
        // `<updater_os>-<arch>`: Rust's arch names, and "darwin" for macOS
        // (Rust's "macos"). Checked here without depending on the host.
        let plugin_name = |os: &str, arch: &str| {
            let os = if os == "macos" { "darwin" } else { os };
            format!("{os}-{arch}")
        };
        for (os, arch) in [
            ("macos", "aarch64"),
            ("macos", "x86_64"),
            ("windows", "x86_64"),
        ] {
            assert_eq!(
                platform_key(os, arch).map(str::to_string),
                Some(plugin_name(os, arch))
            );
        }
        // Linux, where CI runs the Rust tests, has no release build; the
        // check against the plugin's own target() runs on macOS and Windows
        // hosts only (ci.yml runs the updater tests on Windows).
        match current_platform() {
            Some(p) => assert_eq!(Some(p.to_string()), tauri_plugin_updater::target()),
            // No mapping here, and the plugin doesn't name it a shipped one.
            None => assert!(tauri_plugin_updater::target()
                .is_none_or(|t| !SHIPPED_PLATFORMS.contains(&t.as_str()))),
        }
    }

    #[test]
    fn release_urls() {
        let latest = url(LATEST_JSON_URL);
        assert!(url_allowed(&latest));
        assert_eq!(
            latest.as_str(),
            format!("{RELEASES}/latest/download/latest.json")
        );
        assert_eq!(
            key_asset_name("darwin-aarch64"),
            "update-key-darwin-aarch64.pub"
        );
        let release = v("2.0.1");
        assert_eq!(
            manifest_url(&release),
            "https://github.com/Choaterboater/GreenCli/releases/download/v2.0.1/latest.json"
        );
        assert_eq!(
            key_url(&release, "windows-x86_64"),
            "https://github.com/Choaterboater/GreenCli/releases/download/v2.0.1/update-key-windows-x86_64.pub"
        );
        // The key and the manifest always come from the same release.
        let dir = |u: &str| u.rsplit_once('/').unwrap().0.to_string();
        for p in SHIPPED_PLATFORMS {
            let key = key_url(&release, p);
            assert_eq!(dir(&key), dir(&manifest_url(&release)), "{p}");
            let k = url(&key);
            assert!(url_allowed(&k), "{k}");
            assert!(k
                .path()
                .starts_with("/Choaterboater/GreenCli/releases/download/v2.0.1/"));
        }
        let pre = v("2.1.0-beta.1");
        assert_eq!(
            manifest_url(&pre),
            "https://github.com/Choaterboater/GreenCli/releases/download/v2.1.0-beta.1/latest.json"
        );
    }

    #[test]
    fn only_plain_versions_pick_a_release() {
        for (text, want) in [
            ("2.0.1", "2.0.1"),
            ("v2.0.1", "2.0.1"),
            ("10.20.30", "10.20.30"),
            ("2.1.0-beta.1", "2.1.0-beta.1"),
            ("0.0.0", "0.0.0"),
        ] {
            assert_eq!(plain_version(text), Some(v(want)), "{text}");
        }
        for bad in [
            "",
            "v",
            "vv2.0.1",
            "2.0",
            "2",
            "02.0.1",
            "2.0.1+build.5",
            "2.0.1 ",
            " 2.0.1",
            "2.0.1\n",
            "2.0.1/../../x",
            "../2.0.1",
            "2.0.1?x=1",
            "2.0.1#x",
            "2.0.1%2F",
            "2.0.1/latest.json",
            "\u{ff12}.0.1",
            "2.0.1-",
            "latest",
        ] {
            assert_eq!(plain_version(bad), None, "{bad:?}");
        }
        assert_eq!(plain_version(&format!("2.0.1-{}", "a".repeat(80))), None);
    }

    #[test]
    fn reads_only_the_version_from_latest_json() {
        let body = br#"{"version":"2.0.1","notes":"x","platforms":{"darwin-aarch64":{"url":"https://example.com/x","signature":"s"}}}"#;
        assert_eq!(manifest_version(body), Some(v("2.0.1")));
        assert_eq!(
            manifest_version(br#"{"version":"v2.0.2"}"#),
            Some(v("2.0.2"))
        );
        for bad in [
            &br#"{"version":"2.0.1/../../x"}"#[..],
            br#"{"version":2}"#,
            br#"{"version":null}"#,
            br#"{"platforms":{}}"#,
            br#"["2.0.1"]"#,
            b"<html>Not Found</html>",
            b"",
            &[0xff, 0xfe, 0x00],
        ] {
            assert_eq!(
                manifest_version(bad),
                None,
                "{:?}",
                String::from_utf8_lossy(bad)
            );
        }
    }

    #[test]
    fn offers_only_the_release_it_checked() {
        let (current, release) = (v("2.0.0"), v("2.0.1"));
        assert!(should_offer(&current, &release, &v("2.0.1")));
        // The release's manifest names another version: not offered.
        assert!(!should_offer(&current, &release, &v("2.0.2")));
        assert!(!should_offer(&current, &release, &v("2.0.0")));
        // Never the same version or a downgrade.
        assert!(!should_offer(&v("2.0.1"), &release, &v("2.0.1")));
        assert!(!should_offer(&v("2.1.0"), &release, &v("2.0.1")));
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
        assert!(!redirect_allowed(
            &url("http://objects.githubusercontent.com/a"),
            1
        ));
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
        assert!(
            !is_newer(&v("2.0.0"), &v("2.0.0-rc.1")),
            "a pre-release is older"
        );
        assert!(
            !is_newer(&v("2.0.0"), &v("2.0.0+build.5")),
            "build metadata is not newer"
        );
        assert!(!is_newer(&v("10.0.0"), &v("9.9.9")));
    }

    #[test]
    fn public_keys() {
        assert!(pubkey_valid(TEST_PUB));
        assert!(pubkey_valid(&format!("  {TEST_PUB}\n")));
        for bad in ["", "   ", "junk", "dW50cnVzdGVkIGNvbW1lbnQ6IGhp", "!!!!"] {
            assert!(!pubkey_valid(bad), "{bad:?}");
        }
        assert_eq!(
            parse_key(format!("{TEST_PUB}\n").as_bytes()).as_deref(),
            Some(TEST_PUB)
        );
        assert_eq!(parse_key(b"<html>Not Found</html>"), None);
        assert_eq!(parse_key(&[0xff, 0xfe, 0x00]), None);
    }

    #[test]
    fn updates_on_only_in_release_builds_of_shipped_systems() {
        assert_eq!(
            updates_enabled(false, Some("darwin-aarch64")),
            Ok("darwin-aarch64")
        );
        assert_eq!(
            updates_enabled(true, Some("darwin-aarch64")),
            Err(OffReason::Dev)
        );
        assert_eq!(updates_enabled(false, None), Err(OffReason::Platform));
        assert_eq!(updates_enabled(true, None), Err(OffReason::Dev));
        assert_eq!(
            serde_json::to_value(OffReason::Platform).unwrap(),
            "platform"
        );
        assert_eq!(serde_json::to_value(OffReason::Setup).unwrap(), "setup");
    }

    #[test]
    fn a_failed_install_reconnects_only_what_the_hook_stopped() {
        let stopped = Mutex::new(None);
        assert_eq!(
            take_stopped(&stopped),
            None,
            "the hook didn't run: nothing to reconnect"
        );
        *stopped.lock().unwrap() = Some(vec!["aruba".to_string(), "mist".to_string()]);
        assert_eq!(
            take_stopped(&stopped),
            Some(vec!["aruba".to_string(), "mist".to_string()])
        );
        assert_eq!(take_stopped(&stopped), None, "only once");
    }

    #[test]
    fn only_a_missing_platform_entry_means_no_update() {
        use tauri_plugin_updater::Error as E;
        assert!(is_no_release(&E::TargetNotFound("darwin-aarch64".into())));
        assert!(is_no_release(&E::TargetsNotFound(vec![
            "windows-x86_64".into()
        ])));
        // The plugin returns ReleaseNotFound for any non-2xx answer (a 403,
        // 429 or 5xx), and the pinned manifest is known to exist: a failed
        // check, not "You have the latest version."
        assert!(!is_no_release(&E::ReleaseNotFound));
    }

    fn conf() -> Value {
        serde_json::from_str(include_str!("../tauri.conf.json")).unwrap()
    }

    #[test]
    fn config_has_no_key_and_the_github_endpoint() {
        let c = conf();
        let u = &c["plugins"]["updater"];
        // Each check takes the key from the release it updates to, never
        // from the config (a release build's --config carries its own key
        // only so the bundler can sign).
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

    /// A file signed the way release builds sign update files (a one-time
    /// key from `tauri signer generate --ci`, then `tauri signer sign
    /// --app-version 2.0.1`); the private key was deleted.
    /// src/utils/updateSignatureScript.test.ts uses the same three.
    const SIGNED_PUB: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDZEMDdBRjE0NDk5M0ZEQ0YKUldUUC9aTkpGSzhIYlVnRGd4UjJJOWRMeVRoUVMvZytOTC9FRWFVNSs5RExnYmFsWmdsY1pWcjkK";
    const SIGNED_SIG: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVUUC9aTkpGSzhIYlEyemFrNWo5SFB0RHpoOFkwWDVqcnVFOGpxeTBPc3MvRUhERjROQ3NoVzJoUFgrTjlEQzBtckJMZDJrQnZDVHM4enZxazVDTFA3elFMbytqOVA1dUE0PQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzkwOTQ5MTU0CWZpbGU6Zml4dHVyZS50eHQJdmVyc2lvbjoyLjAuMQpXN1ZzeHBISzVxRWgwbExWYVEreGhmdHM5UUczUUNBK2lMTVJzcFk0bkFqdTEveWdzb3BhNDZBTTZWQ2dpbWNHbVVHeWhZZ3R0cG9ORmUyOXM3NlZEUT09Cg==";
    const SIGNED_DATA: &[u8] = b"GreenCLI update test\n";

    fn b64_text(s: &str) -> String {
        use base64::Engine;
        String::from_utf8(base64::engine::general_purpose::STANDARD.decode(s).unwrap()).unwrap()
    }

    /// The updater plugin checks downloads like this (minisign-verify, with
    /// the fetched key); a release build's signature must pass, and only for
    /// its own file and key.
    #[test]
    fn release_signatures_verify_with_the_fetched_key() {
        use minisign_verify::{PublicKey, Signature};
        assert!(pubkey_valid(SIGNED_PUB));
        assert_eq!(
            parse_key(SIGNED_PUB.as_bytes()).as_deref(),
            Some(SIGNED_PUB)
        );
        let key = PublicKey::decode(&b64_text(SIGNED_PUB)).unwrap();
        let sig = Signature::decode(&b64_text(SIGNED_SIG)).unwrap();
        key.verify(SIGNED_DATA, &sig, false).unwrap();
        // The signed version requireSignedVersion compares with latest.json.
        assert!(sig
            .trusted_comment()
            .split('\t')
            .any(|f| f == "version:2.0.1"));
        assert!(key.verify(b"GreenCLI update test!\n", &sig, false).is_err());
        let other = PublicKey::decode(&b64_text(TEST_PUB)).unwrap();
        assert!(other.verify(SIGNED_DATA, &sig, false).is_err());
    }

    /// A line of release.yml that names the private key file (`updkey`, not
    /// the public `updkey.pub`).
    fn names_private_key(line: &str) -> bool {
        line.match_indices("updkey")
            .any(|(i, m)| !line[i + m.len()..].starts_with(".pub"))
    }

    /// release.yml: each build makes its own key with the Tauri CLI that
    /// `npm ci` installed, names its public key like the app, and keeps the
    /// private key in one file that only tauri-action reads, as a path, and
    /// that is deleted even when the build fails.
    #[test]
    fn release_workflow_signs_automatically() {
        let yml = include_str!("../../.github/workflows/release.yml");
        // The platforms release.yml builds have the app's names.
        let mut pairs = Vec::new();
        let mut target = None;
        for line in yml.lines().map(str::trim) {
            if let Some(t) = line
                .strip_prefix("target: ")
                .or_else(|| line.strip_prefix("- target: "))
            {
                if !t.contains("${{") {
                    target = Some(t.trim().to_string());
                }
            } else if let Some(p) = line.strip_prefix("updater: ") {
                pairs.push((
                    target.take().expect("target before updater"),
                    p.trim().to_string(),
                ));
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
        assert!(yml.contains(&format!(
            "KEY_NAME: {}",
            key_asset_name("${{ matrix.updater }}")
        )));
        assert!(yml.contains("uploadUpdaterJson: true"));
        // The app builds release URLs from v<version>.
        assert!(yml.contains("'v__VERSION__'"));

        // The key is made by the locked Tauri CLI (package-lock.json, put in
        // place by `npm ci`), never one fetched at run time. No secrets.
        assert!(yml.contains("npx --no-install tauri signer generate --ci -w \"$dir/updkey\""));
        for bad in [
            "npx -y",
            "npx --yes",
            "@tauri-apps/cli@",
            "secrets.TAURI_SIGNING",
            "add-mask",
            "GITHUB_ENV",
        ] {
            assert!(!yml.contains(bad), "release.yml has {bad:?}");
        }
        // The key folder is under $RUNNER_TEMP, outside the checkout.
        assert!(yml.contains("dir=\"${RUNNER_TEMP//\\\\//}/greencli-update-key\""));
        // tauri-action gets the private key as a path, with no password
        // (the Tauri CLI makes and reads it with an empty one in CI). There
        // are three tauri-action steps (no Apple signing, signed, signed and
        // notarized; only one runs), and each gets the same two lines.
        let lines: Vec<&str> = yml.lines().map(str::trim).collect();
        let builds = lines
            .iter()
            .filter(|l| **l == "uses: tauri-apps/tauri-action@v1")
            .count();
        assert_eq!(builds, 3);
        let signing: Vec<&str> = lines
            .iter()
            .copied()
            .filter(|l| l.contains("TAURI_SIGNING"))
            .collect();
        assert_eq!(signing.len(), 2 * builds, "{signing:#?}");
        for pair in signing.chunks(2) {
            assert_eq!(
                pair,
                [
                    "TAURI_SIGNING_PRIVATE_KEY: ${{ steps.keygen.outputs.dir }}/updkey",
                    "TAURI_SIGNING_PRIVATE_KEY_PASSWORD: \"\"",
                ]
            );
        }
        // Every line that names the private key file: it is made, handed to
        // tauri-action, and deleted. Nothing else reads, prints, stores or
        // uploads it.
        let private: Vec<usize> = (0..lines.len())
            .filter(|&i| names_private_key(lines[i]))
            .collect();
        assert_eq!(
            private.len(),
            2 + builds,
            "{:#?}",
            private.iter().map(|&i| lines[i]).collect::<Vec<_>>()
        );
        assert!(lines[private[0]].starts_with("npx --no-install tauri signer generate"));
        assert!(lines[private[0]].ends_with("> /dev/null"));
        for &i in &private[1..=builds] {
            assert!(lines[i].starts_with("TAURI_SIGNING_PRIVATE_KEY: "));
        }
        let delete = private[builds + 1];
        assert_eq!(
            lines[delete],
            "run: rm -f \"${RUNNER_TEMP//\\\\//}/greencli-update-key/updkey\""
        );
        // The delete step runs even when a step before it failed, right
        // after the build: before the key's public half is checked or
        // published.
        assert!(
            lines[delete.saturating_sub(3)..delete].contains(&"if: always()"),
            "the key delete step needs if: always()"
        );
        let after = |what: &str| lines.iter().position(|l| l.contains(what)).unwrap();
        let last_build = lines
            .iter()
            .rposition(|l| l.contains("uses: tauri-apps/tauri-action"))
            .unwrap();
        assert!(last_build < delete);
        assert!(delete < after("name: Check the update signatures"));
        assert!(delete < after("name: Publish the update key"));
        // Outputs carry only the key folder, never a key.
        for line in lines.iter().filter(|l| l.contains("GITHUB_OUTPUT")) {
            for bad in ["updkey", "TAURI_SIGNING", "$("] {
                assert!(!line.contains(bad), "{line}");
            }
        }
        assert!(yml.contains("echo \"dir=$dir\" >> \"$GITHUB_OUTPUT\""));
    }

    // Apple signing in release.yml. Not the updater, but the same file and
    // the same build steps, so the checks live next to the ones above.

    /// The five repo secrets that turn Apple signing on (docs/SETUP.md,
    /// "Apple signing (optional)").
    const APPLE_SECRETS: [&str; 5] = [
        "APPLE_CERTIFICATE",
        "APPLE_CERTIFICATE_PASSWORD",
        "APPLE_API_ISSUER",
        "APPLE_API_KEY",
        "APPLE_API_KEY_P8",
    ];

    const RELEASE_YML: &str = include_str!("../../.github/workflows/release.yml");

    /// Where "Write the notarization key" puts the .p8 file.
    const P8_DIR: &str = "$RUNNER_TEMP/greencli-apple-key";

    /// One step of release.yml's build job, read from the text with the
    /// file's own layout: steps at 6 spaces, their keys at 8, env entries at
    /// 10, run lines deeper. Comment lines are left out.
    #[derive(Default, Debug)]
    struct Step {
        name: String,
        id: String,
        cond: String,
        uses: String,
        with: String,
        env: Vec<(String, String)>,
        run: String,
    }

    impl Step {
        fn env(&self, key: &str) -> Option<&str> {
            self.env
                .iter()
                .find(|(k, _)| k == key)
                .map(|(_, v)| v.as_str())
        }
        fn apple_env(&self) -> Vec<&str> {
            self.env
                .iter()
                .map(|(k, _)| k.as_str())
                .filter(|k| k.starts_with("APPLE_"))
                .collect()
        }
        /// Gets the value of an Apple secret (not just whether it is set).
        fn holds_apple_secret(&self) -> bool {
            self.env
                .iter()
                .any(|(_, v)| v.contains("secrets.APPLE_") && !v.ends_with(" != '' }}"))
        }
    }

    /// Lines of release.yml that are not comments, trimmed.
    fn code_lines(yml: &str) -> Vec<&str> {
        yml.lines()
            .map(str::trim)
            .filter(|l| !l.starts_with('#'))
            .collect()
    }

    fn build_steps(yml: &str) -> Vec<Step> {
        let indent = |l: &str| l.len() - l.trim_start().len();
        let lines: Vec<&str> = yml
            .lines()
            .filter(|l| !l.trim_start().starts_with('#'))
            .collect();
        let start = lines.iter().position(|l| *l == "  build:").unwrap();
        let end = start
            + 1
            + lines[start + 1..]
                .iter()
                .position(|l| indent(l) == 2 && !l.trim().is_empty())
                .unwrap();
        let mut steps: Vec<Step> = Vec::new();
        let mut block = "";
        for line in &lines[start..end] {
            if line.starts_with("      - ") {
                steps.push(Step::default());
            }
            let Some(step) = steps.last_mut() else {
                continue;
            };
            let (depth, body) = match line.trim().strip_prefix("- ") {
                Some(rest) if indent(line) == 6 => (8, rest),
                _ => (indent(line), line.trim()),
            };
            if body.is_empty() {
                continue;
            }
            if depth == 8 {
                let (key, value) = body.split_once(':').unwrap();
                let value = value.trim().to_string();
                block = "";
                match key {
                    "name" => step.name = value,
                    "id" => step.id = value,
                    "if" => step.cond = value,
                    "uses" => step.uses = value,
                    "with" => step.with = value,
                    "env" => block = "env",
                    "run" if value == "|" || value == ">-" => block = "run",
                    "run" => step.run = value,
                    _ => {}
                }
            } else if depth == 10 && block == "env" {
                let (k, v) = body.split_once(':').unwrap();
                step.env.push((k.to_string(), v.trim().to_string()));
            } else if depth > 8 && block == "run" {
                step.run.push_str(body);
                step.run.push('\n');
            }
        }
        steps
    }

    fn step<'a>(steps: &'a [Step], name: &str) -> (usize, &'a Step) {
        let i = steps
            .iter()
            .position(|s| s.name == name)
            .unwrap_or_else(|| panic!("release.yml has no step {name:?}"));
        (i, &steps[i])
    }

    fn tauri_builds(steps: &[Step]) -> Vec<(usize, &Step)> {
        steps
            .iter()
            .enumerate()
            .filter(|(_, s)| s.uses == "tauri-apps/tauri-action@v1")
            .collect()
    }

    /// The parser reads the steps the way GitHub does (checked against a
    /// YAML parser when this test was written).
    #[test]
    fn release_workflow_steps_parse() {
        let steps = build_steps(RELEASE_YML);
        let names: Vec<&str> = steps.iter().map(|s| s.name.as_str()).collect();
        assert_eq!(
            names,
            [
                "",
                "Setup Node",
                "Setup Rust",
                "Rust cache",
                "Install frontend dependencies",
                "Make a one-time update signing key",
                "Check the Apple secrets",
                "Write the notarization key",
                "Build + bundle (tauri-action)",
                "Build + bundle, signed (tauri-action)",
                "Build + bundle, signed and notarized (tauri-action)",
                "Delete the update signing key",
                "Notarize the .dmg",
                "Delete the notarization key",
                "Check the Mac app",
                "Check the update signatures",
                "Publish the update key",
                "Keep installers (build only)",
            ]
        );
        assert_eq!(steps[0].uses, "actions/checkout@v4");
        let (_, keygen) = step(&steps, "Make a one-time update signing key");
        assert_eq!(keygen.id, "keygen");
        assert!(keygen
            .run
            .ends_with("echo \"dir=$dir\" >> \"$GITHUB_OUTPUT\"\n"));
        let (_, publish) = step(&steps, "Publish the update key");
        assert_eq!(
            publish
                .env
                .iter()
                .map(|(k, _)| k.as_str())
                .collect::<Vec<_>>(),
            ["GH_TOKEN", "RELEASE_ID", "KEY_NAME", "KEY_FILE"]
        );
    }

    /// release.yml signs and notarizes the Mac app only when all five Apple
    /// secrets are set, signs it when only the certificate and its password
    /// are, and else builds it unsigned. A build without Apple signing (and
    /// every Windows build) gets no APPLE_* variable at all, because the
    /// Tauri bundler counts a set but empty variable as set.
    #[test]
    fn release_workflow_signs_the_mac_app_only_with_the_apple_secrets() {
        let steps = build_steps(RELEASE_YML);
        let code = code_lines(RELEASE_YML);

        // Only the five secrets; never the old Apple ID ones or a signing
        // identity (the bundler takes it from the certificate).
        let mut used: Vec<&str> = code
            .iter()
            .flat_map(|l| {
                l.match_indices("secrets.APPLE_")
                    .map(move |(i, _)| &l[i + 8..])
            })
            .map(|rest| {
                rest.split(|c: char| !(c.is_ascii_alphanumeric() || c == '_'))
                    .next()
                    .unwrap()
            })
            .collect();
        used.sort_unstable();
        used.dedup();
        let mut five = APPLE_SECRETS.to_vec();
        five.sort_unstable();
        assert_eq!(used, five);
        for old in [
            "APPLE_SIGNING_IDENTITY",
            "APPLE_ID",
            "APPLE_PASSWORD",
            "APPLE_TEAM_ID",
        ] {
            assert!(
                !code
                    .iter()
                    .any(|l| l.contains(&format!("{old}:"))
                        || l.contains(&format!("secrets.{old} "))),
                "release.yml uses {old}"
            );
        }

        // The check sees only whether each secret is set, and decides the
        // mode: no secrets is a notice, some is a warning that names the
        // missing ones (names only), and the build goes on either way.
        let (_, check) = step(&steps, "Check the Apple secrets");
        assert_eq!(check.id, "apple");
        assert_eq!(check.cond, "runner.os == 'macOS'");
        let expect: Vec<(String, String)> = APPLE_SECRETS
            .iter()
            .map(|n| (format!("HAS_{n}"), format!("${{{{ secrets.{n} != '' }}}}")))
            .collect();
        assert_eq!(check.env, expect);
        assert!(!check.holds_apple_secret());
        assert!(!check.run.contains("secrets."));
        assert!(!check.run.contains("$APPLE_"));
        let mut modes: Vec<&str> = check
            .run
            .lines()
            .filter_map(|l| l.strip_prefix("mode="))
            .collect();
        modes.sort_unstable();
        assert_eq!(modes, ["notarize", "off", "off", "sign"]);
        assert_eq!(
            check
                .run
                .matches("echo \"::notice::No Apple secrets")
                .count(),
            1
        );
        assert_eq!(check.run.matches("echo \"::warning::").count(), 2);
        assert_eq!(check.run.matches("Missing secrets: $missing.").count(), 2);
        assert!(check
            .run
            .contains("missing=\"$missing${missing:+, }$name\""));
        assert!(!check.run.contains("exit 1"));
        assert!(!check.run.contains("::error::"));

        // Three build steps, one per mode, with the same settings (one
        // `with:` block, shared by a YAML alias). Exactly one runs.
        let builds = tauri_builds(&steps);
        let b: Vec<&Step> = builds.iter().map(|(_, s)| *s).collect();
        assert_eq!(
            b.iter()
                .map(|s| (s.id.as_str(), s.cond.as_str(), s.with.as_str()))
                .collect::<Vec<_>>(),
            [
                (
                    "tauri",
                    "runner.os != 'macOS' || steps.apple.outputs.mode == 'off'",
                    "&tauri-with"
                ),
                (
                    "tauri_signed",
                    "steps.apple.outputs.mode == 'sign'",
                    "*tauri-with"
                ),
                (
                    "tauri_notarized",
                    "steps.apple.outputs.mode == 'notarize'",
                    "*tauri-with"
                ),
            ]
        );
        assert_eq!(RELEASE_YML.matches("&tauri-with").count(), 1);
        assert_eq!(RELEASE_YML.matches("*tauri-with").count(), 2);

        // The off path (and Windows) gets no APPLE_* variable at all; the
        // signed builds get exactly what their mode needs.
        assert_eq!(b[0].apple_env(), Vec::<&str>::new());
        assert_eq!(
            b[1].apple_env(),
            ["APPLE_CERTIFICATE", "APPLE_CERTIFICATE_PASSWORD"]
        );
        assert_eq!(
            b[2].apple_env(),
            [
                "APPLE_CERTIFICATE",
                "APPLE_CERTIFICATE_PASSWORD",
                "APPLE_API_ISSUER",
                "APPLE_API_KEY",
                "APPLE_API_KEY_PATH",
            ]
        );
        for n in ["APPLE_CERTIFICATE", "APPLE_CERTIFICATE_PASSWORD"] {
            let want = format!("${{{{ secrets.{n} }}}}");
            assert_eq!(b[1].env(n), Some(want.as_str()));
            assert_eq!(b[2].env(n), Some(want.as_str()));
        }
        // Apart from Apple's, the three builds get the same variables.
        for s in &b[1..] {
            let rest: Vec<&(String, String)> = s
                .env
                .iter()
                .filter(|(k, _)| !k.starts_with("APPLE_"))
                .collect();
            assert_eq!(rest, b[0].env.iter().collect::<Vec<_>>(), "{}", s.name);
        }
        // Any step that gets an APPLE_* variable runs only with Apple
        // signing on, and none is set for the whole job or workflow.
        for s in &steps {
            if !s.apple_env().is_empty() {
                assert!(
                    s.cond == "steps.apple.outputs.mode == 'sign'"
                        || s.cond == "steps.apple.outputs.mode == 'notarize'",
                    "{} sets APPLE_* without Apple signing on",
                    s.name
                );
            }
        }
        let in_steps: usize = steps.iter().map(|s| s.apple_env().len()).sum();
        let anywhere = code
            .iter()
            .filter(|l| l.starts_with("APPLE_") && l.contains(':'))
            .count();
        assert_eq!(in_steps, anywhere);

        // The update key is published from whichever build ran.
        let (_, publish) = step(&steps, "Publish the update key");
        assert_eq!(
            publish.env("RELEASE_ID"),
            Some(
                "${{ steps.tauri.outputs.releaseId || steps.tauri_signed.outputs.releaseId \
                 || steps.tauri_notarized.outputs.releaseId }}"
            )
        );
    }

    /// No Apple secret goes into GITHUB_ENV, GITHUB_OUTPUT, the step summary
    /// or the log: steps that get one never trace their commands, never
    /// echo one, and hand the API key's id and issuer only to notarytool.
    #[test]
    fn release_workflow_keeps_the_apple_secrets_out_of_outputs_and_logs() {
        let steps = build_steps(RELEASE_YML);
        let code = code_lines(RELEASE_YML);

        // The only outputs are the update key folder and the Apple mode.
        let writes: Vec<&str> = code
            .iter()
            .copied()
            .filter(|l| {
                l.contains("GITHUB_ENV")
                    || l.contains("GITHUB_OUTPUT")
                    || l.contains("GITHUB_STEP_SUMMARY")
            })
            .collect();
        assert_eq!(
            writes,
            [
                "echo \"dir=$dir\" >> \"$GITHUB_OUTPUT\"",
                "echo \"mode=$mode\" >> \"$GITHUB_OUTPUT\"",
            ]
        );
        assert!(!RELEASE_YML.contains("GITHUB_ENV"));

        let holders: Vec<&Step> = steps.iter().filter(|s| s.holds_apple_secret()).collect();
        assert_eq!(
            holders.iter().map(|s| s.name.as_str()).collect::<Vec<_>>(),
            [
                "Write the notarization key",
                "Build + bundle, signed (tauri-action)",
                "Build + bundle, signed and notarized (tauri-action)",
                "Notarize the .dmg",
            ]
        );
        for s in &holders {
            for bad in [
                "set -x",
                "set -o xtrace",
                "add-mask",
                "GITHUB_ENV",
                "GITHUB_OUTPUT",
                "GITHUB_STEP_SUMMARY",
                "GITHUB_PATH",
                "env |",
                "printenv",
            ] {
                assert!(!s.run.contains(bad), "{}: {bad}", s.name);
            }
            for line in s.run.lines().filter(|l| l.contains("$APPLE_")) {
                assert!(!line.contains("echo"), "{}: {line}", s.name);
                // The API key's id and issuer go only to notarytool; the
                // .p8 text only into its file.
                let ok = line.contains("--key-id \"$APPLE_API_KEY\"")
                    || line.contains("--issuer \"$APPLE_API_ISSUER\"")
                    || line == "(umask 077 && printf '%s\\n' \"$APPLE_API_KEY_P8\" > \"$dir/AuthKey.p8\")";
                assert!(ok, "{}: {line}", s.name);
                assert!(!line.contains("$APPLE_CERTIFICATE"), "{}: {line}", s.name);
            }
        }

        // The .p8 text is in one step only, which writes it to the file.
        let p8: Vec<&str> = steps
            .iter()
            .filter(|s| {
                s.env
                    .iter()
                    .any(|(_, v)| v == "${{ secrets.APPLE_API_KEY_P8 }}")
            })
            .map(|s| s.name.as_str())
            .collect();
        assert_eq!(p8, ["Write the notarization key"]);
        let (_, write) = step(&steps, "Write the notarization key");
        assert_eq!(write.run.matches("$APPLE_API_KEY_P8").count(), 1);
        // The certificate and its password go only to the bundler.
        for s in &steps {
            let cert = s.env.iter().any(|(_, v)| {
                v == "${{ secrets.APPLE_CERTIFICATE }}"
                    || v == "${{ secrets.APPLE_CERTIFICATE_PASSWORD }}"
            });
            if cert {
                assert_eq!(s.uses, "tauri-apps/tauri-action@v1", "{}", s.name);
            }
        }
    }

    /// The .p8 file is written under $RUNNER_TEMP (outside the checkout),
    /// used by the notarizing build and the .dmg step, and deleted by a step
    /// that runs even when a step before it failed, before anything is
    /// checked or published.
    #[test]
    fn release_workflow_deletes_the_notarization_key() {
        let steps = build_steps(RELEASE_YML);
        let (write_at, write) = step(&steps, "Write the notarization key");
        assert_eq!(write.cond, "steps.apple.outputs.mode == 'notarize'");
        assert!(write.run.contains(&format!("dir=\"{P8_DIR}\"\n")));
        assert!(write
            .run
            .contains("rm -rf \"$dir\" && mkdir -p \"$dir\" && chmod 700 \"$dir\"\n"));
        let builds = tauri_builds(&steps);
        assert_eq!(
            builds[2].1.env("APPLE_API_KEY_PATH"),
            Some("${{ runner.temp }}/greencli-apple-key/AuthKey.p8")
        );
        let (dmg_at, dmg) = step(&steps, "Notarize the .dmg");
        assert_eq!(dmg.cond, "steps.apple.outputs.mode == 'notarize'");
        assert!(dmg.run.contains(&format!("key=\"{P8_DIR}/AuthKey.p8\"\n")));

        let (delete_at, delete) = step(&steps, "Delete the notarization key");
        assert!(delete.cond.starts_with("always()"), "{}", delete.cond);
        assert_eq!(delete.run, format!("rm -rf \"{P8_DIR}\""));
        assert!(write_at < builds[0].0);
        assert!(builds[2].0 < delete_at);
        assert!(dmg_at < delete_at);
        for later in [
            "Check the Mac app",
            "Check the update signatures",
            "Publish the update key",
            "Keep installers (build only)",
        ] {
            assert!(delete_at < step(&steps, later).0, "{later}");
        }
        // Every line that names the key folder: made, used twice, deleted.
        let named: Vec<&str> = code_lines(RELEASE_YML)
            .into_iter()
            .filter(|l| l.contains("greencli-apple-key"))
            .collect();
        assert_eq!(named.len(), 4, "{named:#?}");
    }

    /// After the build, the Mac app is checked: greencli-mcp is inside, a
    /// signed app's programs are signed with the hardened runtime, and a
    /// notarized app and .dmg carry Apple's ticket (the bundler does not
    /// stop when stapling fails).
    #[test]
    fn release_workflow_checks_the_mac_app() {
        let steps = build_steps(RELEASE_YML);
        let (at, mac) = step(&steps, "Check the Mac app");
        assert_eq!(mac.cond, "runner.os == 'macOS'");
        assert_eq!(mac.env("MODE"), Some("${{ steps.apple.outputs.mode }}"));
        assert!(mac.run.contains("app=\"$BUNDLE/macos/GreenCLI.app\"\n"));
        assert_eq!(
            mac.run
                .matches("for exe in GreenCLI greencli-mcp; do")
                .count(),
            2
        );
        assert!(mac.run.contains("^Authority=Developer ID Application:"));
        assert!(mac.run.contains("runtime"));
        assert!(mac.run.contains("xcrun stapler validate \"$app\""));
        assert!(mac.run.contains("xcrun stapler validate \"$dmg\""));
        assert!(at < step(&steps, "Check the update signatures").0);
        assert!(at < step(&steps, "Publish the update key").0);
        let (_, dmg) = step(&steps, "Notarize the .dmg");
        assert!(dmg.run.contains("xcrun stapler staple \"$dmg\"\n"));
        assert!(dmg.run.contains("if [ \"$status\" != Accepted ]; then\n"));
    }

    /// greencli-mcp is a second program of this package (src/bin), so the
    /// Tauri bundler copies it into GreenCLI.app/Contents/MacOS and signs it
    /// with the hardened runtime before it signs the app. Apple's notary
    /// refuses an app with an unsigned program inside, so it must not move
    /// to resources, and the hardened runtime must stay on (Tauri's default).
    #[test]
    fn mac_app_signs_greencli_mcp_with_the_hardened_runtime() {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
        assert!(dir.join("src/bin/greencli-mcp.rs").is_file());
        let c = conf();
        let bundle = &c["bundle"];
        let mac = &bundle["macOS"];
        let runtime = &mac["hardenedRuntime"];
        assert!(
            runtime.is_null() || *runtime == true,
            "hardenedRuntime: {runtime}"
        );
        // No entitlements: GreenCLI needs none under the hardened runtime
        // (no JIT in the app's own process, no plug-ins, no Apple Events).
        assert!(mac["entitlements"].is_null());
        // The signing name comes from the certificate in APPLE_CERTIFICATE.
        assert!(mac["signingIdentity"].is_null());
        assert_eq!(bundle["externalBin"], serde_json::json!([]));
        assert!(!bundle["resources"].to_string().contains("greencli-mcp"));
    }
}
