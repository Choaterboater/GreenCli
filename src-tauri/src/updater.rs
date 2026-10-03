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
/// Update files must be assets of a GreenCLI release: release.yml writes
/// their download link into latest.json (`github.com/<repo>/releases/
/// download/v<version>/<name>`, which doesn't count against GitHub's API
/// limit). Their API address (`api.github.com/repos/<repo>/releases/assets/
/// <id>`, as tauri-action writes it) is accepted too: 2.0.0's latest.json
/// has it.
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
/// `v<version>` (its release job), and its update-files job fails when
/// latest.json's version doesn't match the tag.
fn release_dir(version: &Version) -> String {
    format!("{RELEASES}/download/v{version}")
}

/// One release's update manifest (written by release.yml's update-files
/// job, from the release's update files and their .sig files).
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

/// What a check does once it has asked GitHub for the latest release, given
/// the update already downloaded and waiting for "Restart to update", if any.
#[derive(Debug, PartialEq, Eq)]
pub enum CheckNext {
    /// Nothing newer than this app is published (none at all, or the waiting
    /// update's release was withdrawn): drop what is waiting.
    UpToDate,
    /// Answer with the waiting update and fetch nothing: it is still the
    /// latest release, or GitHub couldn't be reached to say otherwise.
    Keep(String),
    /// Download this release. Nothing is waiting, or the waiting update is
    /// this release or newer, so its own release was withdrawn (or its
    /// version can't be read): drop it first.
    Fetch(Version),
    /// Download this release, which is newer than the waiting update. The
    /// waiting update stays ready until the new download passes its signature
    /// check, so a download that fails (offline, no build for this system,
    /// refused) leaves it ready, as offline does.
    Replace(Version),
    /// The check failed and nothing is waiting.
    Fail(&'static str),
}

/// The waiting version (`waiting`, as `Update::version` writes it) against
/// the latest release (`latest`, step 1 of a check) and this app's version.
pub fn check_next(
    current: &Version,
    waiting: Option<String>,
    latest: Result<Option<Version>, &'static str>,
) -> CheckNext {
    match latest {
        // Offline: an update already downloaded and checked stays ready.
        Err(e) => waiting.map_or(CheckNext::Fail(e), CheckNext::Keep),
        Ok(Some(release)) if is_newer(current, &release) => match waiting {
            Some(w) if w == release.to_string() => CheckNext::Keep(w),
            Some(w) if Version::parse(&w).is_ok_and(|w| is_newer(&w, &release)) => {
                CheckNext::Replace(release)
            }
            _ => CheckNext::Fetch(release),
        },
        Ok(_) => CheckNext::UpToDate,
    }
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

    /// Forget the waiting update (and free its bytes).
    fn drop_pending(&self) {
        *self.pending.lock().unwrap_or_else(|p| p.into_inner()) = None;
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

/// Checking and installing both need updates on and the app in a normal
/// place. From the disk image or a translocated copy the install can't work,
/// so a check there would only download an update that can't be used.
fn may_update(
    off: Option<OffReason>,
    place: impl FnOnce() -> InstallPlace,
) -> Result<(), &'static str> {
    if off.is_some() {
        return Err(ERR_OFF);
    }
    if place() != InstallPlace::Normal {
        return Err(ERR_PLACE);
    }
    Ok(())
}

/// Look for a newer version and, when there is one, download it and check its
/// signature. Returns the new version, or None when this is the latest.
/// Never installs. An update already downloaded is checked against the latest
/// release too: one the owner withdrew is dropped, and one a newer release
/// replaces stays ready until the newer download passes its signature check.
#[tauri::command]
pub async fn update_check(
    app: AppHandle,
    state: State<'_, UpdaterState>,
) -> Result<Option<String>, String> {
    may_update(state.off, current_place)?;
    let platform = current_platform().ok_or(ERR_OFF)?;
    let _one_at_a_time = state.checking.lock().await;
    let waiting = state.pending_version();

    let client = small_client().map_err(|e| {
        log::warn!("Update check setup failed: {}", e.without_url());
        ERR_NETWORK
    });
    // 1. Which release: the latest one's version. Nothing newer, nothing more
    // to fetch; the one already waiting, nothing to download again.
    let latest = match &client {
        Ok(client) => latest_release(client).await,
        Err(e) => Err(*e),
    };
    let (release, kept) = match check_next(&app.package_info().version, waiting.clone(), latest) {
        CheckNext::UpToDate => {
            state.drop_pending();
            return Ok(None);
        }
        CheckNext::Keep(version) => return Ok(Some(version)),
        CheckNext::Fail(e) => return Err(e.into()),
        // The waiting update's release was withdrawn: it goes whatever
        // happens to this download.
        CheckNext::Fetch(release) => {
            state.drop_pending();
            (release, None)
        }
        // The waiting update is replaced only once the newer one passes.
        CheckNext::Replace(release) => (release, waiting),
    };
    // Step 1 used it, so it is there.
    let client = client?;
    match download_release(&app, &state, &client, release, platform).await {
        Ok(Some(pending)) => {
            let version = pending.update.version.clone();
            *state.pending.lock().unwrap_or_else(|p| p.into_inner()) = Some(pending);
            Ok(Some(version))
        }
        // The newer release can't be used (no build or key for this system,
        // offline, or refused; logged): the update already waiting stays
        // ready and is the answer, as when offline.
        result => match kept {
            Some(version) => Ok(Some(version)),
            None => result.map(|_| None).map_err(Into::into),
        },
    }
}

/// Steps 2 and 3 of a check: download `release`'s update for this system and
/// check its signature. `Ok(None)` when that release has no update for it.
async fn download_release(
    app: &AppHandle,
    state: &UpdaterState,
    client: &reqwest::Client,
    release: Version,
    platform: &str,
) -> Result<Option<Pending>, &'static str> {
    // 2. That release's key for this system, and 3. that release's manifest:
    // both from the same tag, so a release published in between can't mix
    // one release's key with another's files.
    let Some(pubkey) = release_key(client, &release, platform).await? else {
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
            return Err(ERR_NETWORK);
        }
    };
    if !download_url_ok(&update.download_url) {
        log::warn!("Update refused: its file is not a GreenCLI release asset");
        return Err(ERR_SOURCE);
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
    Ok(Some(Pending { update, bytes }))
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
    may_update(state.off, current_place)?;
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

/// The app keeps running when the installer couldn't start: bring back the
/// MCP servers the hook stopped, so the AI's tools don't silently vanish.
/// Once the installer starts the app has exited, so an error inside the
/// installer leaves GreenCLI closed; opening it again reconnects the
/// turned-on servers.
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
    fn a_waiting_update_is_checked_against_the_latest_release() {
        use CheckNext::*;
        let current = v("2.0.0");
        let held = || Some("2.0.1".to_string());
        let latest = |s: &str| Ok(Some(v(s)));
        // Nothing waiting: fetch a newer release, else up to date.
        assert_eq!(
            check_next(&current, None, latest("2.0.1")),
            Fetch(v("2.0.1"))
        );
        assert_eq!(check_next(&current, None, latest("2.0.0")), UpToDate);
        assert_eq!(check_next(&current, None, Ok(None)), UpToDate);
        // Still the latest release: keep it, download nothing again.
        assert_eq!(
            check_next(&current, held(), latest("2.0.1")),
            Keep("2.0.1".into())
        );
        // A newer release replaces it, but only once that one's download
        // passes: a failed one leaves it ready.
        assert_eq!(
            check_next(&current, held(), latest("2.0.2")),
            Replace(v("2.0.2"))
        );
        assert_eq!(
            check_next(&current, Some("2.0.1-beta.1".into()), latest("2.0.1")),
            Replace(v("2.0.1"))
        );
        // Its release was withdrawn: the latest is this app's version (or
        // older), or there is no release with update files at all.
        assert_eq!(check_next(&current, held(), latest("2.0.0")), UpToDate);
        assert_eq!(check_next(&current, held(), latest("1.9.0")), UpToDate);
        assert_eq!(check_next(&current, held(), Ok(None)), UpToDate);
        // Withdrawn, with an older release still newer than this app: it
        // goes before the download, which may fail.
        assert_eq!(
            check_next(&current, Some("2.0.2".into()), latest("2.0.1")),
            Fetch(v("2.0.1"))
        );
        // A waiting version that can't be read is never kept.
        assert_eq!(
            check_next(&current, Some("2.0".into()), latest("2.0.2")),
            Fetch(v("2.0.2"))
        );
        // Offline: what is waiting stays ready; with nothing waiting, the
        // check fails.
        assert_eq!(
            check_next(&current, held(), Err(ERR_NETWORK)),
            Keep("2.0.1".into())
        );
        assert_eq!(
            check_next(&current, None, Err(ERR_NETWORK)),
            Fail(ERR_NETWORK)
        );
        // The plugin writes Update::version with semver's to_string, which
        // plain_version requires to match the text exactly.
        assert_eq!(
            check_next(
                &current,
                Some("2.0.1-beta.1".into()),
                latest("2.0.1-beta.1")
            ),
            Keep("2.0.1-beta.1".into())
        );
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
        // What release.yml (like tauri-action) writes into latest.json.
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
    fn no_check_or_install_from_the_disk_image() {
        let normal = || InstallPlace::Normal;
        assert_eq!(may_update(None, normal), Ok(()));
        for place in [InstallPlace::DiskImage, InstallPlace::Translocated] {
            assert_eq!(may_update(None, || place), Err(ERR_PLACE), "{place:?}");
        }
        for off in [OffReason::Dev, OffReason::Platform, OffReason::Setup] {
            assert_eq!(may_update(Some(off), normal), Err(ERR_OFF), "{off:?}");
        }
        // Both commands start with it, before any download or install.
        let src = include_str!("updater.rs");
        for command in ["pub async fn update_check(", "pub async fn update_install("] {
            let body = &src[src.find(command).expect(command)..];
            // The first brace opens the body (any line endings).
            let body = &body[body.find('{').expect("a body") + 1..];
            assert!(
                body.trim_start()
                    .starts_with("may_update(state.off, current_place)?;"),
                "{command} must call may_update first"
            );
        }
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
        // The builds upload their update files and .sig files; only
        // update-files writes latest.json (release_workflow_makes_one_draft_for_all_builds).
        assert!(yml.contains("uploadUpdaterJson: false"));
        // The app builds release URLs from v<version>.
        assert!(yml.contains(
            "if [ \"$REF_TYPE\" = tag ]; then tag=\"$REF_NAME\"; \
             else tag=\"v$(jq -r .version src-tauri/tauri.conf.json)\"; fi"
        ));

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
        assert!(delete < after("name: Upload the installers and the update key"));
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
        /// The keys of the `with:` block (not of the block an alias names).
        with_keys: Vec<String>,
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
        job_steps(yml, "build")
    }

    fn indent(line: &str) -> usize {
        line.len() - line.trim_start().len()
    }

    /// The lines of one job of release.yml, from its header up to the next
    /// job, with comment lines left out.
    fn job_lines<'a>(yml: &'a str, job: &str) -> Vec<&'a str> {
        let lines: Vec<&str> = yml
            .lines()
            .filter(|l| !l.trim_start().starts_with('#'))
            .collect();
        let header = format!("  {job}:");
        let start = lines
            .iter()
            .position(|l| *l == header)
            .unwrap_or_else(|| panic!("release.yml has no job {job:?}"));
        let len = lines[start + 1..]
            .iter()
            .position(|l| indent(l) <= 2 && !l.trim().is_empty())
            .unwrap_or(lines.len() - start - 1);
        lines[start..=start + len].to_vec()
    }

    /// The steps of one job of release.yml (see [`Step`]).
    fn job_steps(yml: &str, job: &str) -> Vec<Step> {
        let mut steps: Vec<Step> = Vec::new();
        let mut block = "";
        for line in job_lines(yml, job) {
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
                    "with" => {
                        step.with = value;
                        block = "with";
                    }
                    "env" => block = "env",
                    "run" if value == "|" || value == ">-" => block = "run",
                    "run" => step.run = value,
                    _ => {}
                }
            } else if depth == 10 && block == "env" {
                let (k, v) = body.split_once(':').unwrap();
                step.env.push((k.to_string(), v.trim().to_string()));
            } else if depth == 10 && block == "with" {
                let (k, _) = body.split_once(':').unwrap();
                step.with_keys.push(k.to_string());
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
                "Stop if the release is already published",
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
                "Upload the installers and the update key",
                "Keep installers (build only)",
            ]
        );
        assert_eq!(steps[1].uses, "actions/checkout@v4");
        let (_, keygen) = step(&steps, "Make a one-time update signing key");
        assert_eq!(keygen.id, "keygen");
        assert!(keygen
            .run
            .ends_with("echo \"dir=$dir\" >> \"$GITHUB_OUTPUT\"\n"));
        let (_, upload) = step(&steps, "Upload the installers and the update key");
        assert_eq!(
            upload
                .env
                .iter()
                .map(|(k, _)| k.as_str())
                .collect::<Vec<_>>(),
            [
                "GH_TOKEN",
                "RELEASE_ID",
                "TAG",
                "BUNDLE",
                "TARGET",
                "KEY_NAME",
                "KEY_FILE"
            ]
        );
        let (_, build) = step(&steps, "Build + bundle (tauri-action)");
        assert_eq!(build.with_keys, ["uploadUpdaterJson", "args"]);
        let (_, keep) = step(&steps, "Keep installers (build only)");
        assert_eq!(keep.with_keys, ["name", "path", "if-no-files-found"]);
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

        // The stapled .dmg goes into the release job's draft with the other
        // files: "Notarize the .dmg" only staples it, before the upload step.
        let (dmg_at, dmg) = step(&steps, "Notarize the .dmg");
        assert_eq!(dmg.env("RELEASE_ID"), None);
        let (upload_at, upload) = step(&steps, "Upload the installers and the update key");
        assert_eq!(
            upload.env("RELEASE_ID"),
            Some("${{ needs.release.outputs.id }}")
        );
        assert!(dmg_at < upload_at);
    }

    /// No Apple secret goes into GITHUB_ENV, GITHUB_OUTPUT, the step summary
    /// or the log: steps that get one never trace their commands, never
    /// echo one, and hand the API key's id and issuer only to notarytool.
    #[test]
    fn release_workflow_keeps_the_apple_secrets_out_of_outputs_and_logs() {
        let steps = build_steps(RELEASE_YML);
        let code = code_lines(RELEASE_YML);

        // The only outputs are the gate job's skip flag, the draft's id and
        // tag, the update key folder and the Apple mode.
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
                "echo \"skip=true\" >> \"$GITHUB_OUTPUT\"",
                "echo \"id=$id\" >> \"$GITHUB_OUTPUT\"",
                "echo \"tag=$tag\" >> \"$GITHUB_OUTPUT\"",
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
            "Upload the installers and the update key",
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
        // The app's own ticket is only a warning (see the next test); the
        // .dmg's is a problem.
        assert!(mac
            .run
            .contains("xcrun stapler validate \"$app\" > /dev/null ||\necho \"::warning::"));
        assert!(mac
            .run
            .contains("xcrun stapler validate \"$dmg\" > /dev/null || problem "));
        assert!(at < step(&steps, "Check the update signatures").0);
        assert!(at < step(&steps, "Upload the installers and the update key").0);
        let (_, dmg) = step(&steps, "Notarize the .dmg");
        assert!(dmg.run.contains("xcrun stapler staple \"$dmg\" && break\n"));
        assert!(dmg.run.contains("if [ \"$status\" != Accepted ]; then\n"));
    }

    /// Runs "Check the Mac app" on a stand-in bundle, with stand-in codesign
    /// (a Developer ID signature with the hardened runtime) and xcrun (no
    /// stapled ticket on the files named in `no_ticket`, relative to the
    /// bundle). Returns the exit code and the output.
    #[cfg(unix)]
    fn run_mac_check(mode: &str, no_ticket: &[&str]) -> (Option<i32>, String) {
        use std::os::unix::fs::PermissionsExt;
        let steps = build_steps(RELEASE_YML);
        let (_, mac) = step(&steps, "Check the Mac app");
        let mut dir = std::env::temp_dir();
        dir.push(format!("greencli-mac-check-test-{}", rand::random::<u64>()));
        let bundle = dir.join("bundle");
        let programs = bundle.join("macos/GreenCLI.app/Contents/MacOS");
        std::fs::create_dir_all(&programs).unwrap();
        for exe in ["GreenCLI", "greencli-mcp"] {
            let p = programs.join(exe);
            std::fs::write(&p, "").unwrap();
            std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        std::fs::create_dir_all(bundle.join("dmg")).unwrap();
        std::fs::write(bundle.join("dmg/GreenCLI_2.0.0_aarch64.dmg"), "").unwrap();
        let script = format!(
            "codesign() {{\n\
             if [ \"$1\" = -d ]; then\n\
             echo 'Authority=Developer ID Application: Test (TEAMID)' >&2\n\
             echo 'CodeDirectory v=20500 size=1 flags=0x10000(runtime) hashes=1+1' >&2\n\
             fi\n\
             }}\n\
             xcrun() {{\n\
             echo \"xcrun $1 $2 ${{3#\"$BUNDLE/\"}}\" >&2\n\
             for t in $NO_TICKET; do [ \"$3\" = \"$BUNDLE/$t\" ] && return 65; done\n\
             return 0\n\
             }}\n\
             {}",
            mac.run
        );
        let out = std::process::Command::new("bash")
            .arg("-c")
            .arg(&script)
            .env("BUNDLE", &bundle)
            .env("MODE", mode)
            .env("NO_TICKET", no_ticket.join(" "))
            .output()
            .expect("bash");
        std::fs::remove_dir_all(&dir).unwrap();
        let text = format!(
            "{}{}",
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr)
        );
        (out.status.code(), text)
    }

    /// The bundler staples the notarized app once, right after Apple says
    /// "Accepted", and goes on when that fails (Apple's ticket can lag
    /// behind). The .dmg and the update file are made from that app before
    /// "Check the Mac app" runs, so an app with no stapled ticket is a
    /// warning, not a failed job; a .dmg with no ticket still fails it.
    #[cfg(unix)]
    #[test]
    fn release_workflow_warns_when_the_mac_app_has_no_stapled_ticket() {
        const APP: &str = "macos/GreenCLI.app";
        const DMG: &str = "dmg/GreenCLI_2.0.0_aarch64.dmg";
        let (code, out) = run_mac_check("notarize", &[]);
        assert_eq!(code, Some(0), "{out}");
        assert!(
            out.contains(&format!("xcrun stapler validate {APP}\n")),
            "{out}"
        );
        assert!(
            out.contains(&format!("xcrun stapler validate {DMG}\n")),
            "{out}"
        );
        assert!(
            !out.contains("::warning::") && !out.contains("::error::"),
            "{out}"
        );
        assert!(out.contains("The Mac app and the .dmg are signed and notarized.\n"));

        let (code, out) = run_mac_check("notarize", &[APP]);
        assert_eq!(code, Some(0), "{out}");
        assert_eq!(
            out.matches("::warning::The Mac app has no stapled ticket.")
                .count(),
            1
        );
        assert!(!out.contains("::error::"), "{out}");
        assert!(
            out.contains(&format!("xcrun stapler validate {DMG}\n")),
            "{out}"
        );

        for missing in [&[DMG][..], &[APP, DMG][..]] {
            let (code, out) = run_mac_check("notarize", missing);
            assert_eq!(code, Some(1), "{missing:?}: {out}");
            assert!(
                out.contains("::error::GreenCLI_2.0.0_aarch64.dmg has no notarization ticket.\n"),
                "{out}"
            );
        }

        // Signed only: no ticket is looked for.
        let (code, out) = run_mac_check("sign", &[APP, DMG]);
        assert_eq!(code, Some(0), "{out}");
        assert!(!out.contains("xcrun"), "{out}");
        assert!(
            out.contains("The Mac app is signed (not notarized).\n"),
            "{out}"
        );
    }

    /// Publishing a draft made by a release/** push or a manual run creates
    /// its tag, and that tag push starts release.yml again. The gate job
    /// skips such a run when the tag already has a published release, and
    /// every other job needs it, so nothing is built again into a second
    /// v<version> draft. A tag pushed before its release is published still
    /// builds. Runs the gate's own script with a stand-in gh.
    #[cfg(unix)]
    #[test]
    fn release_workflow_skips_a_tag_that_is_already_published() {
        // The jobs in order: gate first, and each one needs the one before
        // (update-files also needs the release job, for the draft's id).
        let code: Vec<&str> = RELEASE_YML
            .lines()
            .filter(|l| !l.trim_start().starts_with('#'))
            .collect();
        let jobs_at = code.iter().position(|l| *l == "jobs:").unwrap();
        let jobs: Vec<&str> = code[jobs_at + 1..]
            .iter()
            .copied()
            .filter(|l| indent(l) == 2 && l.ends_with(':'))
            .collect();
        assert_eq!(
            jobs,
            [
                "  gate:",
                "  ci:",
                "  release:",
                "  build:",
                "  update-files:"
            ]
        );
        let needs = |job: &str| -> Vec<&str> {
            job_lines(RELEASE_YML, job)
                .into_iter()
                .filter_map(|l| l.strip_prefix("    needs: "))
                .collect()
        };
        assert!(needs("gate").is_empty());
        assert_eq!(needs("ci"), ["gate"]);
        assert_eq!(needs("release"), ["ci"]);
        assert_eq!(needs("build"), ["release"]);
        assert_eq!(needs("update-files"), ["[release, build]"]);
        // ci runs unless the gate says skip. No job runs after a skipped
        // one: no job condition has always(), failure() or cancelled().
        let conds: Vec<&str> = code
            .iter()
            .copied()
            .filter_map(|l| l.strip_prefix("    if: "))
            .collect();
        assert_eq!(
            conds,
            [
                "needs.gate.outputs.skip != 'true'",
                "${{ github.event_name != 'workflow_dispatch' || inputs.publish }}",
            ]
        );
        assert_eq!(
            job_lines(RELEASE_YML, "ci")[1..3],
            [
                "    needs: gate",
                "    if: needs.gate.outputs.skip != 'true'"
            ]
        );
        let gate = job_lines(RELEASE_YML, "gate");
        for line in [
            "    runs-on: ubuntu-latest",
            "      contents: read",
            "      skip: ${{ steps.check.outputs.skip }}",
        ] {
            assert!(gate.contains(&line), "{line}");
        }
        assert!(!gate.iter().any(|l| l.contains("write")), "{gate:#?}");

        // Only a tag push is looked at; manual runs and release/** pushes
        // always build.
        let steps = job_steps(RELEASE_YML, "gate");
        assert_eq!(steps.len(), 1);
        let check = &steps[0];
        assert_eq!(check.id, "check");
        assert_eq!(
            check.cond,
            "github.event_name == 'push' && github.ref_type == 'tag'"
        );
        assert_eq!(
            check.env,
            [(
                "GH_TOKEN".to_string(),
                "${{ secrets.GITHUB_TOKEN }}".to_string()
            )]
        );

        // gh exits 0 when GitHub has a published release with that tag, and
        // 1 when it has none (404, also for a draft) or the call fails.
        let run = |gh_exit: u32| {
            let mut dir = std::env::temp_dir();
            dir.push(format!("greencli-gate-test-{}", rand::random::<u64>()));
            std::fs::create_dir_all(&dir).unwrap();
            let output = dir.join("output");
            let calls = dir.join("calls");
            std::fs::write(&output, "").unwrap();
            std::fs::write(&calls, "").unwrap();
            let script = format!(
                "gh() {{ echo \"gh $*\" >> \"$CALLS\"; return {gh_exit}; }}\n{}",
                check.run
            );
            let out = std::process::Command::new("bash")
                .args(["--noprofile", "--norc", "-eo", "pipefail", "-c", &script])
                .env("GITHUB_REPOSITORY", "Choaterboater/GreenCli")
                .env("GITHUB_REF_NAME", "v2.0.0")
                .env("GITHUB_OUTPUT", &output)
                .env("CALLS", &calls)
                .output()
                .expect("bash");
            let read = |p: &std::path::Path| std::fs::read_to_string(p).unwrap();
            let result = (
                out.status.code(),
                String::from_utf8_lossy(&out.stdout).into_owned(),
                read(&output),
                read(&calls),
            );
            std::fs::remove_dir_all(&dir).unwrap();
            result
        };
        let call = "gh api repos/Choaterboater/GreenCli/releases/tags/v2.0.0\n";

        let (code, stdout, output, calls) = run(0);
        assert_eq!(code, Some(0), "{stdout}");
        assert_eq!(output, "skip=true\n");
        assert_eq!(calls, call);
        assert_eq!(
            stdout,
            "::notice::v2.0.0 is already published, so there is nothing to build.\n"
        );

        let (code, stdout, output, calls) = run(1);
        assert_eq!(code, Some(0), "{stdout}");
        assert_eq!(output, "");
        assert_eq!(calls, call);
        assert_eq!(stdout, "");
    }

    /// Whether these programs run. The step tests below use the real jq
    /// and node, which GitHub's runners have; elsewhere a missing one skips
    /// the test with a note.
    #[cfg(unix)]
    fn have_programs(programs: &[&str]) -> bool {
        let missing: Vec<&str> = programs
            .iter()
            .copied()
            .filter(|p| {
                !std::process::Command::new(p)
                    .arg("--version")
                    .output()
                    .is_ok_and(|o| o.status.success())
            })
            .collect();
        if missing.is_empty() {
            return true;
        }
        assert!(
            std::env::var_os("CI").is_none(),
            "the release.yml step tests need {missing:?}"
        );
        eprintln!("skipped: {missing:?} not installed");
        false
    }

    /// Runs a release.yml step's script with bash from the repo root, with
    /// stand-in commands (shell functions) in front of it. `$T` is a new
    /// temp folder holding `files`; it is also $RUNNER_TEMP, $T/output is
    /// $GITHUB_OUTPUT and the stand-ins log their calls to $T/calls.
    /// Returns the exit code, stdout and the folder (the caller removes it).
    #[cfg(unix)]
    fn run_step(
        script: &str,
        stand_ins: &str,
        env: &[(&str, &str)],
        files: &[(&str, &str)],
    ) -> (Option<i32>, String, std::path::PathBuf) {
        let mut dir = std::env::temp_dir();
        dir.push(format!("greencli-step-test-{}", rand::random::<u64>()));
        std::fs::create_dir_all(&dir).unwrap();
        for (name, text) in files.iter().chain(&[("output", ""), ("calls", "")]) {
            std::fs::write(dir.join(name), text).unwrap();
        }
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap();
        let out = std::process::Command::new("bash")
            .args(["--noprofile", "--norc", "-c"])
            .arg(format!("{stand_ins}\n{script}"))
            .current_dir(root)
            .env("T", &dir)
            .env("RUNNER_TEMP", &dir)
            .env("GITHUB_OUTPUT", dir.join("output"))
            .env("GITHUB_REPOSITORY", "Choaterboater/GreenCli")
            .envs(env.iter().copied())
            .output()
            .expect("bash");
        let stdout = String::from_utf8_lossy(&out.stdout).into_owned();
        (out.status.code(), stdout, dir)
    }

    /// One job, release, finds or makes the draft, and the three builds
    /// upload into it by its id. When each build looked the draft up itself
    /// (tauri-action's tagName), two that started uploading together could
    /// each make their own. And only update-files writes latest.json: when
    /// each build added its entries to it (uploadUpdaterJson), two that
    /// finished together could drop each other's. Runs the release job's
    /// script with a stand-in gh.
    #[cfg(unix)]
    #[test]
    fn release_workflow_makes_one_draft_for_all_builds() {
        let code = code_lines(RELEASE_YML);
        // No build looks up or makes a release, or writes latest.json.
        // (tauri-action only builds: release_workflow_never_changes_a_published_release.)
        for bad in [
            "releaseId:",
            "tagName:",
            "releaseName:",
            "releaseDraft:",
            "outputs.releaseId",
            "uploadUpdaterJson: true",
        ] {
            assert!(!code.iter().any(|l| l.contains(bad)), "{bad}");
        }
        assert!(code.contains(&"uploadUpdaterJson: false"));
        // Everything that uploads after the build uses the same draft.
        let ids: Vec<&str> = code
            .iter()
            .copied()
            .filter(|l| l.starts_with("RELEASE_ID:"))
            .collect();
        assert_eq!(ids, ["RELEASE_ID: ${{ needs.release.outputs.id }}"; 4]);
        // The release job is the only one that makes a release.
        let makes: Vec<&str> = code
            .iter()
            .copied()
            .filter(|l| l.contains("-X POST \"repos/$GITHUB_REPOSITORY/releases\""))
            .collect();
        assert_eq!(makes.len(), 1, "{makes:#?}");
        let job = job_lines(RELEASE_YML, "release");
        for line in [
            "    runs-on: ubuntu-latest",
            "      contents: write",
            "      id: ${{ steps.draft.outputs.id }}",
            "      tag: ${{ steps.draft.outputs.tag }}",
        ] {
            assert!(job.contains(&line), "{line}");
        }
        let steps = job_steps(RELEASE_YML, "release");
        assert_eq!(steps.len(), 2);
        assert_eq!(steps[0].uses, "actions/checkout@v4");
        let (_, find) = step(&steps, "Find or make the draft release");
        assert_eq!(find.id, "draft");
        // Only publishing runs: a build-only run gets no id, so nothing is
        // uploaded.
        assert_eq!(
            find.cond,
            "${{ github.event_name != 'workflow_dispatch' || inputs.publish }}"
        );
        assert!(find.run.contains(makes[0]));
        // latest.json is uploaded in one place: update-files, after all
        // three builds, which then checks it.
        let uploads: Vec<&str> = code
            .iter()
            .copied()
            .filter(|l| l.contains("name=latest.json"))
            .collect();
        assert_eq!(uploads.len(), 1, "{uploads:#?}");
        let files = job_steps(RELEASE_YML, "update-files");
        assert_eq!(
            files.iter().map(|s| s.name.as_str()).collect::<Vec<_>>(),
            [
                "",
                "Write latest.json",
                "Check latest.json and the update signatures"
            ]
        );
        assert!(files[1].run.contains(uploads[0]));
        assert_eq!(
            files[2].env("TAG"),
            Some("${{ needs.release.outputs.tag }}")
        );
        assert!(files[2].run.contains(
            "darwin-aarch64 darwin-aarch64-app darwin-x86_64 darwin-x86_64-app \\\n\
             windows-x86_64 windows-x86_64-msi windows-x86_64-nsis\n"
        ));

        if !have_programs(&["jq"]) {
            return;
        }
        // gh --paginate prints one JSON list per page. git ls-remote gives
        // the remote's tags from $T/tags (no file: the call fails).
        let stand_ins = r#"gh() {
  echo "gh $*" >> "$T/calls"
  case "$*" in
    "api --paginate repos/Choaterboater/GreenCli/releases?per_page=100") cat "$T/pages" ;;
    "api -X POST repos/Choaterboater/GreenCli/releases "*) cat "$T/made" ;;
    "api -X PATCH repos/Choaterboater/GreenCli/releases/8 "*) echo '{"id":8}' ;;
    *) return 1 ;;
  esac
}
git() {
  echo "git $*" >> "$T/calls"
  case "$*" in
    "ls-remote --tags origin "*) cat "$T/tags" ;;
    *) return 1 ;;
  esac
}"#;
        let run_with_tags =
            |ref_type: &str, ref_name: &str, pages: &str, made: &str, tags: Option<&str>| {
                let mut files = vec![("pages", pages), ("made", made)];
                if let Some(t) = tags {
                    files.push(("tags", t));
                }
                let (code, stdout, dir) = run_step(
                    &find.run,
                    stand_ins,
                    &[
                        ("REF_TYPE", ref_type),
                        ("REF_NAME", ref_name),
                        ("GITHUB_SHA", "abc123"),
                    ],
                    &files,
                );
                let read = |name: &str| std::fs::read_to_string(dir.join(name)).unwrap();
                let result = (code, stdout, read("output"), read("calls"));
                std::fs::remove_dir_all(&dir).unwrap();
                result
            };
        // No tag v<version> on GitHub yet.
        let run = |ref_type: &str, ref_name: &str, pages: &str, made: &str| {
            run_with_tags(ref_type, ref_name, pages, made, Some(""))
        };
        let list = "gh api --paginate repos/Choaterboater/GreenCli/releases?per_page=100\n";
        let make = "gh api -X POST repos/Choaterboater/GreenCli/releases -f tag_name=v2.0.0 \
                    -f name=GreenCli v2.0.0 -F draft=true -F prerelease=false \
                    -f target_commitish=abc123 --jq .id\n";
        let published = r#"[{"id":5,"tag_name":"v2.0.0","draft":false},{"id":6,"tag_name":"v1.9.0","draft":true}]"#;

        // The draft with the tag is used again, on whichever page it is; a
        // published release or another tag's draft never counts.
        let pages = format!("{published}\n[{{\"id\":7,\"tag_name\":\"v2.0.0\",\"draft\":true}}]\n");
        let (code, stdout, output, calls) = run("tag", "v2.0.0", &pages, "");
        assert_eq!(code, Some(0), "{stdout}");
        assert_eq!(output, "id=7\ntag=v2.0.0\n");
        assert_eq!(calls, list);
        assert_eq!(stdout, "Uploading into the v2.0.0 draft.\n");

        // With none, it makes the draft once, on this commit.
        let (code, stdout, output, calls) = run("tag", "v2.0.0", published, "42\n");
        assert_eq!(code, Some(0), "{stdout}");
        assert_eq!(output, "id=42\ntag=v2.0.0\n");
        assert_eq!(calls, format!("{list}{make}"));
        assert_eq!(stdout, "Made the v2.0.0 draft.\n");

        // A release/** push or a manual run uses v<app version>. Its tag
        // is made when the draft is published, at the draft's target: a
        // draft it uses again (made by an earlier run, on an older commit)
        // is pointed at this run's commit, the one it builds. The same
        // call names the tag again: a draft edited without tag_name loses
        // its tag (GitHub renames it untagged-...), and then the app and
        // the next run can't find it. A tag push (above) changes nothing:
        // its tag is already there.
        let version = conf()["version"].as_str().unwrap().to_string();
        let pages = format!("[{{\"id\":8,\"tag_name\":\"v{version}\",\"draft\":true}}]");
        let (code, stdout, output, calls) = run("branch", "release/x", &pages, "");
        assert_eq!(code, Some(0), "{stdout}");
        assert_eq!(output, format!("id=8\ntag=v{version}\n"));
        // First it asks GitHub whether the tag exists (and, for an annotated
        // tag, its commit).
        let lookup =
            format!("git ls-remote --tags origin refs/tags/v{version} refs/tags/v{version}^{{}}\n");
        let retarget = format!(
            "gh api -X PATCH repos/Choaterboater/GreenCli/releases/8 \
             -f tag_name=v{version} -f target_commitish=abc123\n"
        );
        assert_eq!(calls, format!("{lookup}{list}{retarget}"));
        assert_eq!(
            stdout,
            format!(
                "Uploading into the v{version} draft.\nPointed the v{version} draft at abc123.\n"
            )
        );
        // A new draft is made on this commit, so there is nothing to move.
        let (code, stdout, output, calls) = run("branch", "release/x", "[]", "43\n");
        assert_eq!(code, Some(0), "{stdout}");
        assert_eq!(output, format!("id=43\ntag=v{version}\n"));
        assert!(!calls.contains("PATCH"), "{calls}");
        assert!(
            calls.ends_with("-f target_commitish=abc123 --jq .id\n"),
            "{calls}"
        );
        // GitHub refuses the move: no id, so nothing is built or uploaded.
        let pages = format!("[{{\"id\":9,\"tag_name\":\"v{version}\",\"draft\":true}}]");
        let (code, stdout, output, calls) = run("branch", "release/x", &pages, "");
        assert_ne!(code, Some(0), "{stdout}");
        assert_eq!(output, "");
        assert!(
            calls.ends_with(&format!(
                "releases/9 -f tag_name=v{version} -f target_commitish=abc123\n"
            )),
            "{calls}"
        );

        // The draft's target counts only while its tag doesn't exist: when
        // v<version> is already on GitHub (a tag push whose run failed,
        // say), publishing keeps that tag wherever it is. So a run on
        // another commit stops before it looks up, makes or moves a draft:
        // the installers would not match the tag. A lightweight tag gives
        // its commit; an annotated one gives the tag object and its commit
        // (the ^{} line, in either order), and the commit is what counts.
        let elsewhere = format!(
            "::error::The tag v{version} already exists, at def456, not at this run's commit \
             abc123. Publishing would keep that tag, so it would not match the installers. \
             Run the workflow from the tag instead, or delete the tag and its draft first, \
             or bump the version.\n"
        );
        for tags in [
            format!("def456\trefs/tags/v{version}\n"),
            format!("abc123\trefs/tags/v{version}\ndef456\trefs/tags/v{version}^{{}}\n"),
            format!("def456\trefs/tags/v{version}^{{}}\nabc123\trefs/tags/v{version}\n"),
        ] {
            for pages in ["[]".to_string(), pages.clone()] {
                let (code, stdout, output, calls) =
                    run_with_tags("branch", "release/x", &pages, "43\n", Some(&tags));
                assert_eq!(code, Some(1), "{tags}: {stdout}");
                assert_eq!(stdout, elsewhere, "{tags}");
                assert_eq!(output, "", "{tags}");
                assert_eq!(calls, lookup, "{tags}");
            }
        }
        // The tag is on this run's commit (a re-run from the tag's commit):
        // publishing keeps it, and it matches.
        for tags in [
            format!("abc123\trefs/tags/v{version}\n"),
            format!("fed987\trefs/tags/v{version}\nabc123\trefs/tags/v{version}^{{}}\n"),
        ] {
            let pages = format!("[{{\"id\":8,\"tag_name\":\"v{version}\",\"draft\":true}}]");
            let (code, stdout, output, calls) =
                run_with_tags("branch", "release/x", &pages, "", Some(&tags));
            assert_eq!(code, Some(0), "{tags}: {stdout}");
            assert_eq!(output, format!("id=8\ntag=v{version}\n"), "{tags}");
            assert_eq!(calls, format!("{lookup}{list}{retarget}"), "{tags}");
        }
        // The lookup fails: so does the job, before any draft is touched.
        let (code, _, output, calls) = run_with_tags("branch", "release/x", "[]", "43\n", None);
        assert_ne!(code, Some(0));
        assert_eq!(output, "");
        assert_eq!(calls, lookup);
        // A tag push builds its own tag: it never asks.
        let (code, _, _, calls) = run_with_tags("tag", "v2.0.0", "[]", "42\n", None);
        assert_eq!(code, Some(0));
        assert!(!calls.contains("git "), "{calls}");

        // Two drafts with the tag: the owner picks, nothing is uploaded.
        let pages = r#"[{"id":7,"tag_name":"v2.0.0","draft":true},{"id":9,"tag_name":"v2.0.0","draft":true}]"#;
        let (code, stdout, output, calls) = run("tag", "v2.0.0", pages, "");
        assert_eq!(code, Some(1), "{stdout}");
        assert_eq!(output, "");
        assert_eq!(calls, list);
        assert_eq!(
            stdout,
            "::error::There are 2 draft releases for v2.0.0. Delete all but one of them, \
             then run this again.\n"
        );

        // No id back from GitHub, or a failed list: no output, the job fails.
        let (code, stdout, output, _) = run("tag", "v2.0.0", published, "");
        assert_eq!(code, Some(1), "{stdout}");
        assert_eq!(output, "");
        assert!(stdout.ends_with("::error::GitHub gave no release id for v2.0.0.\n"));
        let (code, _, output, calls) = run("tag", "v2.0.0", "not json", "42\n");
        assert_ne!(code, Some(0));
        assert_eq!(output, "");
        assert_eq!(calls, list);
    }

    /// update-files writes latest.json from the draft's update files and
    /// their .sig files, in place of any older one. Runs the step with
    /// stand-in gh and curl (and the real jq and node).
    #[cfg(unix)]
    #[test]
    fn release_workflow_writes_latest_json_once() {
        if !have_programs(&["jq", "node"]) {
            return;
        }
        let files = job_steps(RELEASE_YML, "update-files");
        let (_, write) = step(&files, "Write latest.json");
        assert_eq!(
            write.env("RELEASE_ID"),
            Some("${{ needs.release.outputs.id }}")
        );
        let stand_ins = r#"gh() {
  echo "gh $*" >> "$T/calls"
  case "$*" in
    "api repos/Choaterboater/GreenCli/releases/42 --jq .draft") echo true ;;
    "api repos/Choaterboater/GreenCli/releases/42/assets?per_page=100") cat "$T/assets" ;;
    "api -H Accept: application/octet-stream repos/Choaterboater/GreenCli/releases/assets/"*)
      local url="${@: -1}"
      printf 'sig-%s' "${url##*/}" ;;
    "api -X DELETE repos/Choaterboater/GreenCli/releases/assets/"*) ;;
    *) return 1 ;;
  esac
}
curl() {
  echo "curl ${@: -1}" >> "$T/calls"
  local a
  for a in "$@"; do case "$a" in @*) cp "${a#@}" "$T/uploaded" ;; esac; done
}"#;
        let v = conf()["version"].as_str().unwrap().to_string();
        let asset = |id: u32, name: String| serde_json::json!({ "id": id, "name": name });
        let mut assets = vec![
            asset(101, format!("GreenCLI_{v}_aarch64.dmg")),
            asset(102, format!("GreenCLI_{v}_aarch64.app.tar.gz")),
            asset(103, format!("GreenCLI_{v}_aarch64.app.tar.gz.sig")),
            asset(202, format!("GreenCLI_{v}_x64.app.tar.gz")),
            asset(203, format!("GreenCLI_{v}_x64.app.tar.gz.sig")),
            asset(301, format!("GreenCLI_{v}_x64_en-US.msi")),
            asset(302, format!("GreenCLI_{v}_x64_en-US.msi.sig")),
            asset(304, format!("GreenCLI_{v}_x64-setup.exe")),
            asset(305, format!("GreenCLI_{v}_x64-setup.exe.sig")),
            asset(401, "update-key-darwin-aarch64.pub".into()),
        ];
        let run = |assets: &[Value]| {
            let list = serde_json::to_string(assets).unwrap();
            let (code, stdout, dir) = run_step(
                &write.run,
                stand_ins,
                &[
                    ("RELEASE_ID", "42"),
                    ("TAG", "v2.0.1"),
                    ("GH_TOKEN", "stand-in"),
                ],
                &[("assets", &list)],
            );
            let read = |name: &str| std::fs::read_to_string(dir.join(name)).ok();
            let result = (code, stdout, read("calls").unwrap(), read("uploaded"));
            std::fs::remove_dir_all(&dir).unwrap();
            result
        };
        // The release is still a draft (release_workflow_never_changes_a_published_release).
        let list = "gh api repos/Choaterboater/GreenCli/releases/42 --jq .draft\n\
                    gh api repos/Choaterboater/GreenCli/releases/42/assets?per_page=100\n";
        let sigs: String = [103, 203, 302, 305]
            .iter()
            .map(|id| {
                format!(
                    "gh api -H Accept: application/octet-stream \
                     repos/Choaterboater/GreenCli/releases/assets/{id}\n"
                )
            })
            .collect();
        let upload = "curl https://uploads.github.com/repos/Choaterboater/GreenCli/releases/42/\
                      assets?name=latest.json\n";

        // A first run: no latest.json yet.
        let (code, stdout, calls, uploaded) = run(&assets);
        assert_eq!(code, Some(0), "{stdout}");
        assert_eq!(calls, format!("{list}{sigs}{upload}"));
        let manifest: Value = serde_json::from_str(&uploaded.unwrap()).unwrap();
        assert_eq!(manifest["version"], v.as_str());
        let platforms = manifest["platforms"].as_object().unwrap();
        // Each url is the file's download link in the v<version> release,
        // not its API address: GitHub counts API downloads against its
        // limit of 60 requests an hour per address without a login.
        let entry = |id: u32| {
            let file = assets.iter().find(|a| a["id"] == id).unwrap()["name"]
                .as_str()
                .unwrap();
            serde_json::json!({
                "signature": format!("sig-{}", id + 1),
                "url": format!("https://github.com/Choaterboater/GreenCli/releases/download/v{v}/{file}"),
            })
        };
        let want = [
            ("darwin-aarch64", 102),
            ("darwin-aarch64-app", 102),
            ("darwin-x86_64", 202),
            ("darwin-x86_64-app", 202),
            ("windows-x86_64", 304),
            ("windows-x86_64-nsis", 304),
            ("windows-x86_64-msi", 301),
        ];
        assert_eq!(platforms.len(), want.len());
        for (name, id) in want {
            assert_eq!(platforms[name], entry(id), "{name}");
            // The app takes it.
            let link = platforms[name]["url"].as_str().unwrap();
            assert!(download_url_ok(&url(link)), "{link}");
        }
        // Every name the app looks up for a shipped build is there.
        for p in SHIPPED_PLATFORMS {
            assert!(platforms.contains_key(p), "{p}");
        }

        // A re-run: the older latest.json goes, after the new one is made.
        assets.push(asset(99, "latest.json".into()));
        let (code, stdout, calls, uploaded) = run(&assets);
        assert_eq!(code, Some(0), "{stdout}");
        let delete = "gh api -X DELETE repos/Choaterboater/GreenCli/releases/assets/99\n";
        assert_eq!(calls, format!("{list}{sigs}{delete}{upload}"));
        assert!(uploaded.is_some());

        // A build's files are missing: nothing is deleted or uploaded.
        assets.retain(|a| !a["name"].as_str().unwrap().contains("_x64.app.tar.gz"));
        let (code, _, calls, uploaded) = run(&assets);
        assert_eq!(code, Some(1));
        assert!(
            !calls.contains("DELETE") && !calls.contains("curl"),
            "{calls}"
        );
        assert!(uploaded.is_none());
    }

    /// The draft check, as each step that changes the release has it (with
    /// the file's indentation and comments left out, as job_steps reads it).
    #[cfg(unix)]
    const STOP_IF_PUBLISHED: &str = "\
draft=$(gh api \"repos/$GITHUB_REPOSITORY/releases/$RELEASE_ID\" --jq .draft)
if [ \"$draft\" != true ]; then
echo \"::error::The $TAG release is already published, so this run won't change it. \
Release a new version instead.\"
exit 1
fi
";

    /// One Release run at a time. Runs for the same version upload into
    /// the same draft, and each build replaces any file of the same name
    /// with its own, signed with its own one-time key. Two runs at once
    /// could leave a green update-files check on a latest.json whose
    /// signatures no longer match the files (or keys) the other run put in
    /// their place. So a run that starts while another one is going waits
    /// for it. The group is the same for every run of this workflow, not
    /// one per ref: a tag push and a release/** push have different refs
    /// but upload into the same v<version> draft. A running run is never
    /// cancelled halfway through its uploads.
    #[test]
    fn release_workflow_runs_one_at_a_time() {
        // Top level, with nothing after the group: no ref, no event.
        let lines: Vec<&str> = RELEASE_YML
            .lines()
            .filter(|l| !l.trim_start().starts_with('#'))
            .collect();
        let at = lines
            .iter()
            .position(|l| *l == "concurrency:")
            .expect("release.yml has no top-level concurrency");
        assert_eq!(
            lines[at + 1..at + 3],
            [
                "  group: release-${{ github.repository }}",
                "  cancel-in-progress: false",
            ]
        );
        assert_eq!(indent(lines[at + 3]), 0, "{:?}", lines[at + 3]);
        // Before the jobs, and no job has a group of its own.
        let jobs = lines.iter().position(|l| *l == "jobs:").unwrap();
        assert!(at < jobs);
        let groups = code_lines(RELEASE_YML)
            .into_iter()
            .filter(|l| l.starts_with("concurrency:"))
            .count();
        assert_eq!(groups, 1);
        // release.yml runs ci.yml (workflow_call) inside the same run, so a
        // ci.yml in this group would wait for the Release run it is part of.
        let ci = include_str!("../../.github/workflows/ci.yml");
        assert!(!ci.contains("release-${{ github.repository }}"));
    }

    /// No run changes a published release. Re-running one build job (or
    /// "Re-run failed jobs") does not run the release job again, so the
    /// build gets the id it found the first time, and the owner may have
    /// published that release since, or may publish it while the build
    /// runs. A build that then put its files and key into the live release
    /// would leave its latest.json with the old signatures, which the new
    /// files fail, so that platform could not update until a new version
    /// shipped. So the build stops before anything is built, every
    /// step that deletes or uploads a release file checks again first, and
    /// tauri-action (which would replace the release's files at the end of
    /// the build, with no check) only builds. Runs those steps with stand-in
    /// gh and curl.
    #[cfg(unix)]
    #[test]
    fn release_workflow_never_changes_a_published_release() {
        // The build job's first step, before the key is made and anything
        // is built; skipped on a build-only run (no id).
        let steps = build_steps(RELEASE_YML);
        let stop = &steps[0];
        assert_eq!(stop.name, "Stop if the release is already published");
        assert_eq!(stop.cond, "${{ needs.release.outputs.id != '' }}");
        assert_eq!(
            stop.env,
            [
                ("GH_TOKEN", "${{ secrets.GITHUB_TOKEN }}"),
                ("RELEASE_ID", "${{ needs.release.outputs.id }}"),
                ("TAG", "${{ needs.release.outputs.tag }}"),
            ]
            .map(|(k, v)| (k.to_string(), v.to_string()))
        );
        assert_eq!(stop.run, format!("set -euo pipefail\n{STOP_IF_PUBLISHED}"));
        let (keygen, _) = step(&steps, "Make a one-time update signing key");
        assert!(0 < keygen);
        let builds = tauri_builds(&steps);
        assert!(builds.iter().all(|(i, _)| 0 < *i));

        // tauri-action only builds. Given a releaseId or tagName it uploads
        // the build's files at the end, deleting any of the same name, with
        // no check that the release is still a draft; and it is a `uses:`
        // step, which the scan of `run:` scripts below can't see. So it
        // gets neither, and no token. (The three builds share one `with:`
        // block.)
        assert_eq!(builds.len(), 3);
        assert_eq!(builds[0].1.with, "&tauri-with");
        for (_, b) in &builds[1..] {
            assert_eq!(b.with, "*tauri-with", "{}", b.name);
            assert!(b.with_keys.is_empty(), "{}", b.name);
        }
        for key in ["releaseId", "tagName"] {
            assert!(!builds[0].1.with_keys.iter().any(|k| k == key), "{key}");
        }
        let tokens: Vec<&str> = job_lines(RELEASE_YML, "build")
            .into_iter()
            .map(str::trim)
            .filter(|l| l.contains("GITHUB_TOKEN") || l.contains("github.token"))
            .collect();
        assert_eq!(tokens, ["GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}"; 2]);
        let with_token: Vec<&str> = steps
            .iter()
            .filter(|s| s.env("GH_TOKEN").is_some())
            .map(|s| s.name.as_str())
            .collect();
        assert_eq!(
            with_token,
            [
                "Stop if the release is already published",
                "Upload the installers and the update key"
            ]
        );

        // Every step that deletes a release file or uploads one checks
        // first, in every job. These are the ones that do.
        let mut changers = Vec::new();
        for job in ["gate", "release", "build", "update-files"] {
            for s in job_steps(RELEASE_YML, job) {
                let first = ["-X DELETE", "uploads.github.com"]
                    .iter()
                    .filter_map(|w| s.run.find(w))
                    .min();
                if let Some(first) = first {
                    let check = s.run.find(STOP_IF_PUBLISHED);
                    assert!(check.is_some_and(|c| c < first), "{job}: {}", s.name);
                    assert_eq!(s.env("TAG"), Some("${{ needs.release.outputs.tag }}"));
                    changers.push(s.name);
                }
            }
        }
        assert_eq!(
            changers,
            [
                "Upload the installers and the update key",
                "Write latest.json"
            ]
        );
        // The build's one upload comes after it is built, notarized and
        // checked, and the key it uploads is the one the build signed with.
        let (upload_at, upload) = step(&steps, "Upload the installers and the update key");
        for before in [
            "Delete the update signing key",
            "Notarize the .dmg",
            "Check the Mac app",
            "Check the update signatures",
        ] {
            assert!(step(&steps, before).0 < upload_at, "{before}");
        }
        assert!(builds.iter().all(|(i, _)| *i < upload_at));
        assert_eq!(
            upload.cond,
            "${{ github.event_name != 'workflow_dispatch' || inputs.publish }}"
        );
        assert_eq!(
            upload.env("KEY_FILE"),
            Some("${{ steps.keygen.outputs.dir }}/updkey.pub")
        );
        assert_eq!(upload.env("TARGET"), Some("${{ matrix.target }}"));
        assert_eq!(
            upload.env("BUNDLE"),
            Some("src-tauri/target/${{ matrix.target }}/release/bundle")
        );

        if !have_programs(&["jq", "node"]) {
            return;
        }
        // gh says whether release 42 is a draft from $T/draft (no file: the
        // call fails), and answers the asset lookups with one old file. The
        // bundle is a Mac build's.
        let stand_ins = r#"gh() {
  echo "gh $*" >> "$T/calls"
  case "$*" in
    "api repos/Choaterboater/GreenCli/releases/42 --jq .draft") cat "$T/draft" ;;
    "api repos/Choaterboater/GreenCli/releases/42/assets --paginate --jq "*) echo 7 ;;
    "api repos/Choaterboater/GreenCli/releases/42/assets?per_page=100") echo '[]' ;;
    "api -X DELETE "*) ;;
    *) return 1 ;;
  esac
}
curl() {
  local a file=""
  for a in "$@"; do case "$a" in @*) file="${a#@}" ;; esac; done
  echo "curl ${file#"$T"/} ${@: -1}" >> "$T/calls"
}
BUNDLE="$T/bundle"
mkdir -p "$BUNDLE/dmg" "$BUNDLE/macos/GreenCLI.app"
: > "$BUNDLE/dmg/GreenCLI_2.0.1_aarch64.dmg"
: > "$BUNDLE/macos/GreenCLI.app.tar.gz"
: > "$BUNDLE/macos/GreenCLI.app.tar.gz.sig""#;
        let files = job_steps(RELEASE_YML, "update-files");
        let scripts = [
            ("Stop if the release is already published", &stop.run),
            ("Upload the installers and the update key", &upload.run),
            (
                "Write latest.json",
                &step(&files, "Write latest.json").1.run,
            ),
        ];
        let run = |script: &str, draft: Option<&str>| {
            let mut files = vec![];
            if let Some(d) = draft {
                files.push(("draft", d));
            }
            let (code, stdout, dir) = run_step(
                script,
                stand_ins,
                &[
                    ("RELEASE_ID", "42"),
                    ("TAG", "v2.0.1"),
                    ("GH_TOKEN", "stand-in"),
                    ("TARGET", "aarch64-apple-darwin"),
                    ("KEY_NAME", "update-key-darwin-aarch64.pub"),
                    ("KEY_FILE", "updkey.pub"),
                ],
                &files,
            );
            let calls = std::fs::read_to_string(dir.join("calls")).unwrap();
            std::fs::remove_dir_all(&dir).unwrap();
            (code, stdout, calls)
        };
        let check = "gh api repos/Choaterboater/GreenCli/releases/42 --jq .draft\n";
        let published = "::error::The v2.0.1 release is already published, so this run won't \
                         change it. Release a new version instead.\n";
        for (name, script) in scripts {
            // Published (say, while the build ran): the step fails at the
            // check, before it deletes or uploads anything.
            let (code, stdout, calls) = run(script, Some("false\n"));
            assert_eq!(code, Some(1), "{name}: {stdout}");
            assert!(stdout.ends_with(published), "{name}: {stdout}");
            assert_eq!(calls, check, "{name}");

            // The check itself fails: so does the step, and nothing changes.
            let (code, stdout, calls) = run(script, None);
            assert_ne!(code, Some(0), "{name}: {stdout}");
            assert_eq!(calls, check, "{name}");

            // Still a draft: the step goes on past the check.
            let (code, stdout, calls) = run(script, Some("true\n"));
            assert!(calls.starts_with(check), "{name}: {calls}");
            assert!(!stdout.contains("already published"), "{name}: {stdout}");
            match name {
                "Stop if the release is already published" => {
                    assert_eq!((code, stdout.as_str()), (Some(0), ""));
                }
                // It lists the assets (and then finds no update files:
                // release_workflow_writes_latest_json_once has those).
                "Write latest.json" => assert!(
                    calls.contains(&format!(
                        "{check}gh api repos/Choaterboater/GreenCli/releases/42/assets?per_page=100\n"
                    )),
                    "{calls}"
                ),
                // It replaces the release's old files with the build's,
                // named as tauri-action named them, and then the key.
                _ => {
                    assert_eq!(code, Some(0), "{name}: {stdout}");
                    let v = conf()["version"].as_str().unwrap().to_string();
                    let mut want = check.to_string();
                    let mut said = String::new();
                    for (file, asset) in [
                        (
                            "bundle/dmg/GreenCLI_2.0.1_aarch64.dmg",
                            "GreenCLI_2.0.1_aarch64.dmg".to_string(),
                        ),
                        (
                            "bundle/macos/GreenCLI.app.tar.gz",
                            format!("GreenCLI_{v}_aarch64.app.tar.gz"),
                        ),
                        (
                            "bundle/macos/GreenCLI.app.tar.gz.sig",
                            format!("GreenCLI_{v}_aarch64.app.tar.gz.sig"),
                        ),
                        ("updkey.pub", "update-key-darwin-aarch64.pub".to_string()),
                    ] {
                        want.push_str(&format!(
                            "gh api repos/Choaterboater/GreenCli/releases/42/assets --paginate \
                             --jq .[] | select(.name == \"{asset}\") | .id\n\
                             gh api -X DELETE repos/Choaterboater/GreenCli/releases/assets/7\n\
                             curl {file} https://uploads.github.com/repos/Choaterboater/GreenCli/\
                             releases/42/assets?name={asset}&label={asset}\n"
                        ));
                        said.push_str(&format!("Uploaded {asset}\n"));
                    }
                    assert_eq!(calls, want);
                    assert_eq!(stdout, said);
                }
            }
        }

        // With no build files the upload step stops before it changes
        // anything, even on a draft.
        let empty = format!("rm -r \"$BUNDLE\"\n{}", upload.run);
        let (code, _, calls) = run(&empty, Some("true\n"));
        assert_eq!(code, Some(1));
        assert_eq!(calls, "");
    }

    /// Apple's ticket can take a little while to show up after notarytool
    /// says "Accepted", so the .dmg staple is tried up to five times, 30
    /// seconds apart, before the job fails. Runs the step's own loop with a
    /// stand-in xcrun that fails a given number of times.
    #[cfg(unix)]
    #[test]
    fn release_workflow_retries_the_dmg_staple() {
        let steps = build_steps(RELEASE_YML);
        let (_, dmg) = step(&steps, "Notarize the .dmg");
        // The step staples in one place: the loop.
        assert_eq!(dmg.run.matches("xcrun stapler staple").count(), 1);
        let start = dmg
            .run
            .find("for i in 1 2 3 4 5; do\n")
            .expect("a retry loop around the .dmg staple");
        let len = dmg.run[start..].find("done\n").unwrap() + "done\n".len();
        let staple = &dmg.run[start..start + len];
        assert!(staple.contains("xcrun stapler staple \"$dmg\" && break\n"));
        let run = |fails: u32| {
            let script = format!(
                "set -euo pipefail\n\
                 n=0\n\
                 xcrun() {{ n=$((n + 1)); echo \"xcrun $*\"; [ \"$n\" -gt {fails} ]; }}\n\
                 sleep() {{ echo \"sleep $*\"; }}\n\
                 dmg=GreenCLI.dmg\n\
                 name=GreenCLI.dmg\n\
                 {staple}\
                 echo stapled\n"
            );
            let out = std::process::Command::new("bash")
                .arg("-c")
                .arg(&script)
                .output()
                .expect("bash");
            let stdout = String::from_utf8_lossy(&out.stdout).into_owned();
            (out.status.code(), stdout)
        };
        for fails in 0..5 {
            let (code, out) = run(fails);
            assert_eq!(code, Some(0), "{fails} failures: {out}");
            let tries = fails as usize + 1;
            assert_eq!(
                out.matches("xcrun stapler staple GreenCLI.dmg\n").count(),
                tries,
                "{out}"
            );
            assert_eq!(out.matches("sleep 30\n").count(), tries - 1, "{out}");
            assert!(out.ends_with("stapled\n"), "{out}");
        }
        let (code, out) = run(5);
        assert_eq!(code, Some(1), "{out}");
        assert_eq!(out.matches("xcrun stapler staple").count(), 5, "{out}");
        assert_eq!(out.matches("sleep 30\n").count(), 4, "{out}");
        assert!(out.contains("::error::Could not staple Apple's ticket to GreenCLI.dmg.\n"));
        assert!(!out.contains("stapled\n"), "{out}");
    }

    /// Matches a path against an upload-artifact pattern, one `/` part at a
    /// time: `**` is any number of parts, `*` any text inside one part.
    fn glob_matches(pattern: &[&str], path: &[&str]) -> bool {
        fn part(p: &str, s: &str) -> bool {
            match p.split_once('*') {
                None => p == s,
                Some((head, rest)) => {
                    s.starts_with(head) && (head.len()..=s.len()).any(|i| part(rest, &s[i..]))
                }
            }
        }
        match pattern.split_first() {
            None => path.is_empty(),
            Some((&"**", rest)) => (0..=path.len()).any(|i| glob_matches(rest, &path[i..])),
            Some((p, rest)) => {
                !path.is_empty() && part(p, path[0]) && glob_matches(rest, &path[1..])
            }
        }
    }

    /// A build-only run keeps the installers, not the raw GreenCLI.app:
    /// upload-artifact drops the execute bit (every file comes back 644), so
    /// the programs in a raw .app would not start. The .dmg and the
    /// .app.tar.gz keep the bit inside them.
    #[test]
    fn release_workflow_keeps_installers_not_the_raw_app() {
        // The step's lines (comments left out), up to the next step or job.
        let lines: Vec<&str> = RELEASE_YML
            .lines()
            .filter(|l| !l.trim_start().starts_with('#'))
            .collect();
        let at = lines
            .iter()
            .position(|l| *l == "      - name: Keep installers (build only)")
            .unwrap();
        let end = at
            + 1
            + lines[at + 1..]
                .iter()
                .position(|l| !l.trim().is_empty() && !l.starts_with("        "))
                .unwrap_or(lines.len() - at - 1);
        let body = &lines[at + 1..end];
        assert!(body.contains(&"        uses: actions/upload-artifact@v4"));
        let path_at = body
            .iter()
            .position(|l| *l == "          path: |")
            .expect("path: | in Keep installers (build only)");
        let patterns: Vec<String> = body[path_at + 1..]
            .iter()
            .take_while(|l| l.starts_with("            "))
            .map(|l| {
                l.trim()
                    .replace("${{ matrix.target }}", "aarch64-apple-darwin")
            })
            .collect();
        assert!(!patterns.is_empty());
        let kept = |file: &str| {
            let full = format!("src-tauri/target/aarch64-apple-darwin/{file}");
            let path: Vec<&str> = full.split('/').collect();
            let mut keep = false;
            for p in &patterns {
                let (exclude, p) = match p.strip_prefix('!') {
                    Some(p) => (true, p),
                    None => (false, p.as_str()),
                };
                let parts: Vec<&str> = p.split('/').collect();
                if glob_matches(&parts, &path) {
                    keep = !exclude;
                }
            }
            keep
        };
        let b = "release/bundle";
        for file in [
            "dmg/GreenCLI_2.0.0_aarch64.dmg",
            "macos/GreenCLI.app.tar.gz",
            "macos/GreenCLI.app.tar.gz.sig",
            "nsis/GreenCLI_2.0.0_x64-setup.exe",
            "nsis/GreenCLI_2.0.0_x64-setup.exe.sig",
            "msi/GreenCLI_2.0.0_x64_en-US.msi",
        ] {
            assert!(kept(&format!("{b}/{file}")), "{file} is left out");
        }
        for file in [
            "macos/GreenCLI.app/Contents/MacOS/GreenCLI",
            "macos/GreenCLI.app/Contents/MacOS/greencli-mcp",
            "macos/GreenCLI.app/Contents/Info.plist",
        ] {
            assert!(!kept(&format!("{b}/{file}")), "{file} is kept");
        }
        // Nothing outside the bundle folder.
        assert!(!kept("release/greencli-mcp"));
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
