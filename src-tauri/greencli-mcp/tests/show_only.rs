// The show-only rule for live show commands. GreenCLI's app (mcp/presets.rs)
// and its webview (src/utils/mcpPresets.ts) run the same vectors, so the
// three checks cannot drift apart.

use serde_json::Value;

#[test]
fn show_only_vectors() {
    let cases: Vec<Value> =
        serde_json::from_str(include_str!("../testdata/show_only_cases.json")).unwrap();
    assert!(cases.len() >= 60);
    assert!(cases
        .iter()
        .any(|c| c["command"].as_str().unwrap().len() == 256 && c["plain"] == true));
    assert!(cases
        .iter()
        .any(|c| c["command"].as_str().unwrap().len() == 257 && c["plain"] == false));
    for case in &cases {
        let command = case["command"].as_str().unwrap();
        assert_eq!(
            greencli_mcp::is_plain_show(command),
            case["plain"].as_bool().unwrap(),
            "{command:?}"
        );
    }
}
