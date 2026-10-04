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

/// What device_show tells the AI (tools/list, pinned in tools_list.json): the
/// box's three buttons by name, never number keys, and that a filter's text
/// may be a pattern.
#[test]
fn device_show_description_names_the_buttons_and_the_filter_pattern() {
    let tools: Vec<Value> =
        serde_json::from_str(include_str!("../testdata/tools_list.json")).unwrap();
    let show = tools.iter().find(|t| t["name"] == "device_show").unwrap();
    let text = show["description"].as_str().unwrap();
    assert!(
        text.contains("No, Yes this once, or Yes, show commands on <device> until GreenCLI closes"),
        "{text}"
    );
    for key in ["1 No", "2 Yes", "3 Yes"] {
        assert!(!text.contains(key), "{key}: {text}");
    }
    assert!(text.contains("^ $ * . ( ) [ ] +"), "{text}");
    assert!(text.contains("never ?"), "{text}");
}
