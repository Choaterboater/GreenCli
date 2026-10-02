//! Where the running app was started from. On macOS an app run straight from
//! the downloaded disk image, or one macOS "translocated" (moved to a random
//! read-only folder because it was never moved out of Downloads), can't
//! update itself in place, and paths to its files change on every start.

use serde::Serialize;
use std::path::Path;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum InstallPlace {
    /// A normal install (Applications, or any folder on other systems).
    Normal,
    /// macOS App Translocation: a read-only random copy.
    Translocated,
    /// Running from a mounted disk image (/Volumes/...).
    DiskImage,
}

/// Where `exe` (the app's own executable) lives. Only macOS has the special
/// places; other systems always get `Normal`.
pub fn install_place(exe: &Path) -> InstallPlace {
    if cfg!(target_os = "macos") {
        place_on_macos(exe)
    } else {
        InstallPlace::Normal
    }
}

fn place_on_macos(exe: &Path) -> InstallPlace {
    let text = exe.to_string_lossy();
    if text.contains("/AppTranslocation/") {
        InstallPlace::Translocated
    } else if text.starts_with("/Volumes/") {
        InstallPlace::DiskImage
    } else {
        InstallPlace::Normal
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn macos_places() {
        let p = |s: &str| place_on_macos(Path::new(s));
        assert_eq!(
            p("/Applications/GreenCLI.app/Contents/MacOS/GreenCLI"),
            InstallPlace::Normal
        );
        assert_eq!(
            p("/Users/me/Applications/GreenCLI.app/Contents/MacOS/GreenCLI"),
            InstallPlace::Normal
        );
        assert_eq!(
            p("/private/var/folders/xy/abc/T/AppTranslocation/1234-ABCD/d/GreenCLI.app/Contents/MacOS/GreenCLI"),
            InstallPlace::Translocated
        );
        assert_eq!(
            p("/Volumes/GreenCLI/GreenCLI.app/Contents/MacOS/GreenCLI"),
            InstallPlace::DiskImage
        );
        // Only a /Volumes prefix counts, not the word somewhere else.
        assert_eq!(
            p("/Users/me/Volumes/GreenCLI.app/Contents/MacOS/GreenCLI"),
            InstallPlace::Normal
        );
    }

    #[test]
    fn this_system() {
        let exe = Path::new("/Volumes/GreenCLI/GreenCLI.app/Contents/MacOS/GreenCLI");
        let want = if cfg!(target_os = "macos") {
            InstallPlace::DiskImage
        } else {
            InstallPlace::Normal
        };
        assert_eq!(install_place(exe), want);
        assert_eq!(
            install_place(Path::new(r"C:\Program Files\GreenCLI\GreenCLI.exe")),
            InstallPlace::Normal
        );
    }

    #[test]
    fn serializes_for_the_frontend() {
        assert_eq!(
            serde_json::to_string(&InstallPlace::DiskImage).unwrap(),
            "\"diskImage\""
        );
    }
}
