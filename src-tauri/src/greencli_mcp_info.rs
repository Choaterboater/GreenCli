//! Where the greencli-mcp binary is: next to the app's own executable
//! (GreenCLI.app/Contents/MacOS on macOS, the install folder on Windows).
//! The MCP settings show this path, and the MCP export uses it, with the
//! app's data folder for `--data-dir`.

use crate::app_location::{install_place, InstallPlace};
use crate::AppState;
use serde::Serialize;
use std::path::Path;
use tauri::State;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GreencliMcpInfo {
    /// Full path to the greencli-mcp binary.
    pub path: String,
    /// False when this build has no greencli-mcp next to the app.
    pub exists: bool,
    /// Where the app runs from. Outside Applications the path changes.
    pub place: InstallPlace,
    /// The app's data folder, for greencli-mcp's `--data-dir`. Without it,
    /// greencli-mcp finds the folder from its own environment, and Casper
    /// starts servers with a smaller one (on Linux, no XDG_DATA_HOME).
    pub data_dir: String,
}

/// The greencli-mcp next to `exe`, reading `data_dir`.
pub fn info_for(exe: &Path, data_dir: &Path) -> Option<GreencliMcpInfo> {
    let name = format!("greencli-mcp{}", std::env::consts::EXE_SUFFIX);
    let path = exe.parent()?.join(name);
    Some(GreencliMcpInfo {
        exists: path.is_file(),
        path: path.to_string_lossy().into_owned(),
        place: install_place(exe),
        data_dir: data_dir.to_string_lossy().into_owned(),
    })
}

#[tauri::command]
pub fn greencli_mcp_info(state: State<'_, AppState>) -> Result<GreencliMcpInfo, String> {
    let exe =
        std::env::current_exe().map_err(|_| "Can't find GreenCLI's own folder.".to_string())?;
    info_for(&exe, &state.app_dir).ok_or_else(|| "Can't find GreenCLI's own folder.".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_path_is_next_to_the_app() {
        let dir = std::env::temp_dir().join(format!("greencli-mcp-info-{}", rand::random::<u64>()));
        std::fs::create_dir_all(&dir).unwrap();
        let exe = dir.join("GreenCLI");
        let data = dir.join("data").join("com.choatelabs.greencli");
        let info = info_for(&exe, &data).unwrap();
        let want = dir.join(format!("greencli-mcp{}", std::env::consts::EXE_SUFFIX));
        assert_eq!(info.path, want.to_string_lossy());
        assert_eq!(info.data_dir, data.to_string_lossy());
        assert!(!info.exists);
        std::fs::write(&want, b"").unwrap();
        assert!(info_for(&exe, &data).unwrap().exists);
        // A folder with that name is not the binary.
        std::fs::remove_file(&want).unwrap();
        std::fs::create_dir_all(&want).unwrap();
        assert!(!info_for(&exe, &data).unwrap().exists);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn serializes_for_the_frontend() {
        let info = GreencliMcpInfo {
            path: "/Applications/GreenCLI.app/Contents/MacOS/greencli-mcp".into(),
            exists: true,
            place: InstallPlace::Translocated,
            data_dir: "/Users/me/Library/Application Support/com.choatelabs.greencli".into(),
        };
        assert_eq!(
            serde_json::to_value(&info).unwrap(),
            serde_json::json!({
                "path": "/Applications/GreenCLI.app/Contents/MacOS/greencli-mcp",
                "exists": true,
                "place": "translocated",
                "dataDir": "/Users/me/Library/Application Support/com.choatelabs.greencli"
            })
        );
    }
}
