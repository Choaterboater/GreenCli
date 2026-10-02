// The one place that decides which MCP tools the AI may see and which calls
// GreenCLI refuses. Pure: no Tauri, no I/O. The manager (client.rs) gathers
// the facts (the saved definition, the tool list, the access_check answer) and
// asks here.
//
// Hiding follows Casper's isHidden (casper src/mcp/presets.ts:484-489 @ ad678b6):
// a read-only login hides everything above diagnostic; writes off hides write
// and destructive tools and the preset's own list. Tools that only run
// commands (exec) stay visible with writes off; the AI panel asks before every
// one. A command tool whose name also makes a change (push_cli_config) is
// hidden like a write.
// Refusals mirror the TS gate (src/utils/mcpGate.ts steps 3 and 6-8), so a
// call the panel would refuse is refused here too.

use super::access::{
    no_definition_reason, read_only_login_reason, writes_off_reason, AccessCheck, AccessState,
};
use super::client::{McpServerDef, McpToolInfo, McpWrites};
use super::labels::{
    call_label, is_router, read_named, routed_calls, router_unclear, skipped_check, too_deep,
    tool_label, writes_off_hides, SafetyLabel,
};
use super::presets::{
    hide_when_writes_off, junos_guard, junos_show, match_by_tools, match_preset, tighten,
    JunosShow, PresetId, PresetMatch,
};
use serde_json::Value;

pub const AUDITOR_REFUSAL: &str =
    "The Read-only Auditor agent is attached, so only tools that read can run.";

const TOO_DEEP_REASON: &str = "the arguments are nested too deeply to check (over 32 levels).";
const WRITES_ON_HINT: &str = "Only the user can turn writes on, in Settings → MCP Servers.";

/// What GreenCLI knows about one server right now.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ServerPolicy {
    /// A saved definition exists. Without one, every tool is blocked (fail closed).
    pub has_def: bool,
    pub writes_on: bool,
    pub preset: Option<PresetMatch>,
    pub access: AccessState,
    pub show_opt_in: bool,
}

/// def None (a client with no saved settings): has_def false, writes off,
/// opt-in off, preset from the tools only.
pub fn server_policy(
    def: Option<&McpServerDef>,
    tool_names: &[&str],
    access: Option<&AccessCheck>,
) -> ServerPolicy {
    ServerPolicy {
        has_def: def.is_some(),
        writes_on: def.is_some_and(McpServerDef::writes_on),
        preset: match def {
            Some(d) => match_preset(d, Some(tool_names)),
            None => match_by_tools(tool_names),
        },
        access: access.map_or(AccessState::Unknown, |a| a.state),
        show_opt_in: def.is_some_and(|d| d.show_opt_in),
    }
}

fn preset_id(p: &ServerPolicy) -> Option<PresetId> {
    p.preset.map(|m| m.id)
}

/// The tool's own label: its hints and name (labels::tool_label), raised by the preset.
pub fn final_label(p: &ServerPolicy, tool: &McpToolInfo) -> SafetyLabel {
    let label = tool_label(&tool.name, tool.annotations.as_ref(), tool.meta.as_ref());
    match preset_id(p) {
        Some(id) => tighten(id, &tool.name, label),
        None => label,
    }
}

/// Why the tool is hidden from the AI and blocked, or None.
pub fn hidden_reason(
    p: &ServerPolicy,
    tool: &McpToolInfo,
    label: SafetyLabel,
    server: &str,
) -> Option<String> {
    if !p.has_def {
        return Some(no_definition_reason(server));
    }
    if p.access == AccessState::ReadOnly && label > SafetyLabel::Diagnostic {
        return Some(read_only_login_reason(server));
    }
    if p.writes_on {
        return None;
    }
    let preset_hides = preset_id(p).is_some_and(|id| hide_when_writes_off(id, tool));
    if writes_off_hides(label, &tool.name) || preset_hides {
        return Some(writes_off_reason(server));
    }
    None
}

/// Why GreenCLI refuses this call, or None. Plain text; the manager adds "Not run: ".
pub fn call_refusal(
    p: &ServerPolicy,
    tool: Option<&McpToolInfo>,
    tool_name: &str,
    args: &Value,
    read_only_agent: bool,
    server: &str,
) -> Option<String> {
    // 1. Only tools the server lists now.
    let Some(tool) = tool else {
        return Some(format!("{server} does not offer {tool_name}."));
    };
    // 2. Hidden tools are blocked too.
    let own = final_label(p, tool);
    if let Some(reason) = hidden_reason(p, tool, own, server) {
        return Some(reason);
    }
    // 3. The call as a whole: a write behind a router counts (Casper refuseByPolicy).
    let schema = &tool.input_schema;
    let cl = call_label(own, tool_name, schema, args);
    if p.access == AccessState::ReadOnly && cl > SafetyLabel::Diagnostic {
        return Some(read_only_login_reason(server));
    }
    if !p.writes_on && writes_off_hides(cl, tool_name) {
        return Some(writes_off_reason(server));
    }
    // 4. A router must not reach a hidden tool by a name GreenCLI can't judge.
    if !p.writes_on
        && is_router(tool_name, schema, args)
        && (router_unclear(tool_name, schema, args)
            || routed_calls(tool_name, schema, args)
                .iter()
                .any(|(name, _)| !read_named(name)))
    {
        return Some(writes_off_reason(server));
    }
    // 5. Junos with writes off: only plain show commands.
    let junos = preset_id(p) == Some(PresetId::JunosMcpServer);
    if !p.writes_on && junos {
        if let Err(e) = junos_guard(tool_name, args, false) {
            return Some(format!("{e} {WRITES_ON_HINT}"));
        }
    }
    // 6. Deeper than the checks look.
    if too_deep(args) {
        return Some(TOO_DEEP_REASON.to_string());
    }
    // 7. The Read-only Auditor: only reads, and Junos plain shows.
    if read_only_agent {
        let skipped = skipped_check(args);
        let junos_show_ok = junos
            && matches!(
                tool_name,
                "execute_junos_command" | "execute_junos_command_batch"
            )
            && junos_show(tool_name, args) == JunosShow::AllShow
            && !skipped;
        if (skipped || cl > SafetyLabel::Diagnostic) && !junos_show_ok {
            return Some(AUDITOR_REFUSAL.to_string());
        }
    }
    None
}

/// Fills the listing-time fields: preset, show_opt_in, writes (always Some:
/// Off unless writes are on), access (always Some), label and blocked. Uses
/// `tool.server` as the server name, so set it first.
pub fn decorate(p: &ServerPolicy, mut tool: McpToolInfo) -> McpToolInfo {
    let label = final_label(p, &tool);
    tool.preset = preset_id(p);
    tool.show_opt_in = p.show_opt_in;
    tool.writes = Some(if p.writes_on {
        McpWrites::On
    } else {
        McpWrites::Off
    });
    tool.access = Some(p.access);
    tool.label = Some(label);
    tool.blocked = hidden_reason(p, &tool, label, &tool.server);
    tool
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mcp::access::parse_access_check;
    use crate::mcp::client::{tool_from_json, McpTransport};
    use serde_json::json;
    use std::collections::HashMap;

    fn def(command: &str, args: &[&str], writes: Option<McpWrites>) -> McpServerDef {
        McpServerDef {
            name: "s".into(),
            transport: McpTransport::Stdio,
            command: command.into(),
            args: args.iter().map(|a| a.to_string()).collect(),
            env: HashMap::new(),
            cwd: None,
            url: None,
            credentials_env_var: None,
            headers: HashMap::new(),
            enabled: true,
            writes,
            show_opt_in: false,
        }
    }

    fn tool(name: &str) -> McpToolInfo {
        tool_from_json("s", &json!({ "name": name })).unwrap()
    }

    fn read_tool(name: &str) -> McpToolInfo {
        tool_from_json(
            "s",
            &json!({ "name": name, "annotations": { "readOnlyHint": true } }),
        )
        .unwrap()
    }

    fn policy(d: &McpServerDef, names: &[&str]) -> ServerPolicy {
        server_policy(Some(d), names, None)
    }

    fn hidden(p: &ServerPolicy, t: &McpToolInfo) -> Option<String> {
        hidden_reason(p, t, final_label(p, t), "s")
    }

    fn refuse(p: &ServerPolicy, t: &McpToolInfo, args: Value, agent: bool) -> Option<String> {
        call_refusal(p, Some(t), &t.name, &args, agent, "s")
    }

    fn read_only_access() -> AccessCheck {
        parse_access_check(&json!({ "structuredContent": {
            "contract": "casper/access-check v1",
            "products": [{ "product": "central", "access": "read-only" }]
        } }))
    }

    #[test]
    fn read_hinted_batch_and_method_routers_are_judged_by_what_they_run() {
        let d = def("uvx", &["some-server"], None);
        let p = policy(&d, &[]);
        let helper = read_tool("helper");
        let batch = json!({ "calls": [
            { "name": "get_a", "arguments": {} },
            { "name": "delete_b", "arguments": {} }
        ] });
        assert_eq!(
            refuse(&p, &helper, batch.clone(), false),
            Some(writes_off_reason("s"))
        );
        assert_eq!(
            refuse(
                &p,
                &helper,
                json!({ "method": "cycle_port", "params": {} }),
                false
            ),
            Some(writes_off_reason("s"))
        );
        let unclear = json!({ "requests": [{ "method": "get_a", "params": {} }, { "op": 1 }] });
        assert_eq!(
            refuse(&p, &helper, unclear.clone(), false),
            Some(writes_off_reason("s"))
        );
        let on = def("uvx", &["some-server"], Some(McpWrites::On));
        let p = policy(&on, &[]);
        assert_eq!(refuse(&p, &helper, batch, false), None);
        assert_eq!(
            refuse(&p, &helper, unclear, true),
            Some(AUDITOR_REFUSAL.to_string())
        );
        let reads = json!({ "calls": [{ "name": "get_a", "arguments": {} }, { "name": "list_b", "arguments": {} }] });
        assert_eq!(refuse(&p, &helper, reads, true), None);
    }

    #[test]
    fn writes_off_hides_writes_but_not_exec() {
        let d = def("uvx", &["some-server"], None);
        let p = policy(&d, &[]);
        assert!(!p.writes_on);
        assert_eq!(hidden(&p, &tool("set_ssid")), Some(writes_off_reason("s")));
        assert_eq!(hidden(&p, &tool("get_device")), None);
        assert_eq!(hidden(&p, &read_tool("get_device")), None);
        // Exec asks every time; writes off doesn't hide it.
        assert_eq!(final_label(&p, &tool("execute_command")), SafetyLabel::Exec);
        assert_eq!(hidden(&p, &tool("execute_command")), None);
        // A command tool whose name also makes a change is hidden and refused.
        for name in ["push_cli_config", "apply_config_command"] {
            assert_eq!(final_label(&p, &tool(name)), SafetyLabel::Exec);
            assert_eq!(hidden(&p, &tool(name)), Some(writes_off_reason("s")));
            assert_eq!(
                refuse(&p, &read_tool(name), json!({}), false),
                Some(writes_off_reason("s"))
            );
        }
    }

    #[test]
    fn presets_hide_their_own_lists() {
        let hpe = def("python", &["tool_router.py"], Some(McpWrites::Off));
        let p = policy(&hpe, &["find_tool", "invoke_read_tool", "invoke_tool"]);
        assert!(hidden(&p, &read_tool("invoke_tool")).is_some());
        assert!(hidden(&p, &read_tool("invoke_read_tool")).is_none());
        let netmiko = def("uvx", &["netmiko-mcp"], Some(McpWrites::Off));
        let p = policy(&netmiko, &[]);
        assert!(hidden(&p, &tool("get_config")).is_some());
        assert!(hidden(&p, &read_tool("list_devices")).is_none());
    }

    #[test]
    fn writes_on_hides_nothing_but_a_read_only_login_does() {
        let d = def("uvx", &["x"], Some(McpWrites::On));
        let p = policy(&d, &[]);
        assert_eq!(hidden(&p, &tool("delete_site")), None);
        assert_eq!(hidden(&p, &tool("get_device")), None);
        let ro = read_only_access();
        let p = server_policy(Some(&d), &[], Some(&ro));
        assert_eq!(p.access, AccessState::ReadOnly);
        assert_eq!(
            hidden(&p, &tool("get_device")),
            Some(read_only_login_reason("s"))
        );
        assert_eq!(hidden(&p, &read_tool("get_device")), None);
    }

    #[test]
    fn no_definition_blocks_everything() {
        let p = server_policy(None, &["get_device"], None);
        assert!(!p.has_def && !p.writes_on && !p.show_opt_in);
        assert_eq!(
            hidden(&p, &read_tool("get_device")),
            Some(no_definition_reason("s"))
        );
        assert_eq!(
            refuse(&p, &read_tool("get_device"), json!({}), false),
            Some(no_definition_reason("s"))
        );
    }

    #[test]
    fn routers_with_writes_off() {
        let d = def("uvx", &["x"], None);
        let p = policy(&d, &[]);
        let router = read_tool("invoke_read_tool");
        let off = Some(writes_off_reason("s"));
        assert_eq!(
            refuse(&p, &router, json!({ "name": "update_site" }), false),
            off
        );
        assert_eq!(
            refuse(&p, &router, json!({ "tool_id": "update_site" }), false),
            off
        );
        assert_eq!(
            refuse(
                &p,
                &router,
                json!({ "calls": [{ "name": "get_a" }, { "bad": 1 }] }),
                false
            ),
            off
        );
        assert_eq!(
            refuse(&p, &router, json!({ "name": "cycle_port" }), false),
            off
        );
        assert_eq!(
            refuse(&p, &router, json!({ "name": "get_device" }), false),
            None
        );
    }

    #[test]
    fn a_router_call_naming_two_tools_is_refused() {
        let d = def("uvx", &["x"], None);
        let p = policy(&d, &[]);
        let router = tool("call_tool");
        let off = Some(writes_off_reason("s"));
        let plain = json!({ "tool_name": "delete_vlan", "arguments": { "vlan": 10 } });
        assert_eq!(refuse(&p, &router, plain, false), off);
        let decoy = json!({
            "name": "get_status",
            "tool_name": "delete_vlan",
            "arguments": { "vlan": 10 }
        });
        assert_eq!(refuse(&p, &router, decoy.clone(), false), off);
        // Writes on: the Read-only Auditor still refuses it.
        let on = def("uvx", &["x"], Some(McpWrites::On));
        let p = policy(&on, &[]);
        assert_eq!(refuse(&p, &router, decoy.clone(), false), None);
        assert_eq!(
            refuse(&p, &router, decoy, true),
            Some(AUDITOR_REFUSAL.to_string())
        );
    }

    #[test]
    fn writes_off_catches_decoys_hidden_routers_and_late_change_words() {
        let d = def("uvx", &["x"], None);
        let p = policy(&d, &[]);
        let off = Some(writes_off_reason("s"));
        // A decoy read name next to the real tool name in another spelling.
        for key in ["toolName", "tool_id", "toolId", "method", "function"] {
            let mut args = json!({ "name": "get_status", "arguments": { "vlan": 10 } });
            args[key] = json!("delete_vlan");
            assert_eq!(
                refuse(&p, &read_tool("call_tool"), args, false),
                off,
                "{key}"
            );
        }
        // A read-only-hinted router under another name.
        let args = json!({ "name": "delete_site", "arguments": { "id": 1 } });
        for name in [
            "call_read_tool",
            "callTool",
            "tool_call",
            "use_tool",
            "proxy_tool",
        ] {
            assert_eq!(
                refuse(&p, &read_tool(name), args.clone(), false),
                off,
                "{name}"
            );
        }
        // A read word first, then a change word: hidden while unmarked.
        let late = tool("get_and_apply_config");
        assert_eq!(hidden(&p, &late), off);
        assert_eq!(refuse(&p, &late, json!({}), false), off);
        assert_eq!(hidden(&p, &read_tool("get_and_apply_config")), None);
        // The Auditor refuses the hidden router with writes on too.
        let on = def("uvx", &["x"], Some(McpWrites::On));
        let p = policy(&on, &[]);
        assert_eq!(
            refuse(&p, &read_tool("call_read_tool"), args, true),
            Some(AUDITOR_REFUSAL.to_string())
        );
    }

    #[test]
    fn read_only_login_refuses_a_routed_write() {
        let d = def("uvx", &["x"], Some(McpWrites::On));
        let ro = read_only_access();
        let p = server_policy(Some(&d), &[], Some(&ro));
        let router = read_tool("invoke_read_tool");
        assert_eq!(
            refuse(&p, &router, json!({ "name": "update_site" }), false),
            Some(read_only_login_reason("s"))
        );
    }

    #[test]
    fn unknown_tools_and_deep_args() {
        let d = def("uvx", &["x"], Some(McpWrites::On));
        let p = policy(&d, &[]);
        assert_eq!(
            call_refusal(&p, None, "nope", &json!({}), false, "s"),
            Some("s does not offer nope.".into())
        );
        let mut deep = json!({ "x": 1 });
        for _ in 0..33 {
            deep = json!({ "a": deep });
        }
        assert_eq!(
            refuse(&p, &read_tool("get_device"), deep, false),
            Some(TOO_DEEP_REASON.into())
        );
    }

    #[test]
    fn the_auditor_only_reads() {
        let d = def("uvx", &["x"], Some(McpWrites::On));
        let p = policy(&d, &[]);
        let auditor = Some(AUDITOR_REFUSAL.to_string());
        assert_eq!(refuse(&p, &tool("set_ssid"), json!({}), true), auditor);
        assert_eq!(refuse(&p, &tool("get_device"), json!({}), true), auditor);
        assert_eq!(refuse(&p, &read_tool("get_device"), json!({}), true), None);
        assert_eq!(
            refuse(
                &p,
                &read_tool("get_device"),
                json!({ "confirm": true }),
                true
            ),
            auditor
        );
        assert_eq!(
            refuse(
                &p,
                &read_tool("get_device"),
                json!({ "confirm": true }),
                false
            ),
            None
        );
    }

    #[test]
    fn junos_with_writes_off() {
        let d = def("python3", &["jmcp.py"], None);
        let names = [
            "execute_junos_command",
            "load_and_commit_config",
            "get_router_list",
        ];
        let p = policy(&d, &names);
        let exec = tool("execute_junos_command");
        assert_eq!(final_label(&p, &exec), SafetyLabel::Exec);
        assert!(hidden(&p, &exec).is_none());
        assert_eq!(
            refuse(&p, &exec, json!({ "command": "show version" }), false),
            None
        );
        let junos_off = Some(format!(
            "{} {}",
            super::super::presets::JUNOS_WRITES_OFF,
            WRITES_ON_HINT
        ));
        assert_eq!(
            refuse(&p, &exec, json!({ "command": "configure" }), false),
            junos_off
        );
        // The commit tool is destructive, so it is hidden and refused.
        let commit = tool("load_and_commit_config");
        assert_eq!(
            refuse(&p, &commit, json!({}), false),
            Some(writes_off_reason("s"))
        );
        // The Auditor may run plain shows on Junos, nothing else.
        assert_eq!(
            refuse(&p, &exec, json!({ "command": "show version" }), true),
            None
        );
        assert_eq!(
            refuse(
                &p,
                &exec,
                json!({ "command": "show version", "confirm": true }),
                true
            ),
            Some(AUDITOR_REFUSAL.into())
        );
        let pfe = tool("execute_junos_pfe_command");
        assert_eq!(
            refuse(&p, &pfe, json!({ "command": "show version" }), true),
            Some(AUDITOR_REFUSAL.into())
        );
    }

    #[test]
    fn decorate_fills_every_field() {
        let mut d = def("python3", &["jmcp.py"], None);
        d.show_opt_in = true;
        let p = policy(&d, &[]);
        let t = decorate(&p, tool("load_and_commit_config"));
        assert_eq!(t.label, Some(SafetyLabel::Destructive));
        assert_eq!(t.writes, Some(McpWrites::Off));
        assert_eq!(t.access, Some(AccessState::Unknown));
        assert_eq!(t.preset, Some(PresetId::JunosMcpServer));
        assert!(t.show_opt_in);
        assert_eq!(t.blocked, Some(writes_off_reason("s")));
        let v = serde_json::to_value(&t).unwrap();
        assert_eq!(v["label"], "destructive");
        assert_eq!(v["writes"], "off");
        assert_eq!(v["access"], "unknown");
        assert!(v["blocked"].as_str().unwrap().contains("writes are off"));
        let open = decorate(&p, read_tool("get_router_list"));
        assert_eq!(open.label, Some(SafetyLabel::Read));
        assert_eq!(open.blocked, None);
        assert!(serde_json::to_value(&open)
            .unwrap()
            .get("blocked")
            .is_none());
        d.writes = Some(McpWrites::On);
        let p = policy(&d, &[]);
        assert_eq!(decorate(&p, tool("x")).writes, Some(McpWrites::On));
    }
}
