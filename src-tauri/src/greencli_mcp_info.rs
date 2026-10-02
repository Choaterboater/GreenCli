//! Where the greencli-mcp binary is: next to the app's own executable
//! (GreenCLI.app/Contents/MacOS on macOS, the install folder on Windows).
//! The MCP settings show this path, and the MCP export uses it.

use crate::app_location::{install_place, InstallPlace};
use serde::Serialize;
use std::path::Path;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GreencliMcpInfo {
    /// Full path to the greencli-mcp binary.
    pub path: String,
    /// False when this build has no greencli-mcp next to the app.
    pub exists: bool,
    /// Where the app runs from. Outside Applications the path changes.
    pub place: InstallPlace,
}

/// The greencli-mcp next to `exe`.
pub fn info_for(exe: &Path) -> Option<GreencliMcpInfo> {
    let name = format!("greencli-mcp{}", std::env::consts::EXE_SUFFIX);
    let path = exe.parent()?.join(name);
    Some(GreencliMcpInfo {
        exists: path.is_file(),
        path: path.to_string_lossy().into_owned(),
        place: install_place(exe),
    })
}

#[tauri::command]
pub fn greencli_mcp_info() -> Result<GreencliMcpInfo, String> {
    let exe =
        std::env::current_exe().map_err(|_| "Can't find GreenCLI's own folder.".to_string())?;
    info_for(&exe).ok_or_else(|| "Can't find GreenCLI's own folder.".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_path_is_next_to_the_app() {
        let dir = std::env::temp_dir().join(format!("greencli-mcp-info-{}", rand::random::<u64>()));
        std::fs::create_dir_all(&dir).unwrap();
        let exe = dir.join("GreenCLI");
        let info = info_for(&exe).unwrap();
        let want = dir.join(format!("greencli-mcp{}", std::env::consts::EXE_SUFFIX));
        assert_eq!(info.path, want.to_string_lossy());
        assert!(!info.exists);
        std::fs::write(&want, b"").unwrap();
        assert!(info_for(&exe).unwrap().exists);
        // A folder with that name is not the binary.
        std::fs::remove_file(&want).unwrap();
        std::fs::create_dir_all(&want).unwrap();
        assert!(!info_for(&exe).unwrap().exists);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn serializes_for_the_frontend() {
        let info = GreencliMcpInfo {
            path: "/Applications/GreenCLI.app/Contents/MacOS/greencli-mcp".into(),
            exists: true,
            place: InstallPlace::Translocated,
        };
        assert_eq!(
            serde_json::to_value(&info).unwrap(),
            serde_json::json!({
                "path": "/Applications/GreenCLI.app/Contents/MacOS/greencli-mcp",
                "exists": true,
                "place": "translocated"
            })
        );
    }
}
