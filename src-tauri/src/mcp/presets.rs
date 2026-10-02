// Presets for known network MCP servers. Ported from casper
// src/mcp/presets.ts @ ad678b6 (MIT, Choaterboater). This pass has the
// matching part only (how GreenCLI recognises a server); the read-only
// settings, hiding and argument checks come later.
//
// Matching keeps Casper's order: the first preset that matches wins. There is
// no regex crate, so each Casper pattern is written out by hand.

use super::client::{McpServerDef, McpTransport};
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PresetId {
    HpeNetworkingMcp,
    Centralmcp,
    CentralMcpServer,
    JunosMcpServer,
    MistHosted,
    Netbox,
    NetmikoMcp,
    OxidizedLibrenms,
    Grafana,
    ClearpassMcp,
}

/// Casper's table order: the first match wins.
const ORDER: [PresetId; 10] = [
    PresetId::HpeNetworkingMcp,
    PresetId::Centralmcp,
    PresetId::CentralMcpServer,
    PresetId::JunosMcpServer,
    PresetId::MistHosted,
    PresetId::Netbox,
    PresetId::NetmikoMcp,
    PresetId::OxidizedLibrenms,
    PresetId::Grafana,
    PresetId::ClearpassMcp,
];

/// Product name for the user, e.g. "Junos" in "This looks like a Junos server".
pub fn preset_label(id: PresetId) -> &'static str {
    match id {
        PresetId::HpeNetworkingMcp => "HPE networking",
        PresetId::Centralmcp => "Central",
        PresetId::CentralMcpServer => "Central",
        PresetId::JunosMcpServer => "Junos",
        PresetId::MistHosted => "Mist",
        PresetId::Netbox => "NetBox",
        PresetId::NetmikoMcp => "Netmiko",
        PresetId::OxidizedLibrenms => "Oxidized/LibreNMS",
        PresetId::Grafana => "Grafana",
        PresetId::ClearpassMcp => "ClearPass",
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum MatchBy {
    Definition,
    Tools,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PresetMatch {
    pub id: PresetId,
    /// How it was recognised.
    pub by: MatchBy,
    /// Recognised by its definition, but the tool list doesn't carry the preset's signature.
    pub mismatch: bool,
}

/// Tool names that must all be present to recognise a server by its tool list.
fn signature(id: PresetId) -> &'static [&'static str] {
    match id {
        PresetId::HpeNetworkingMcp => &["find_tool", "invoke_read_tool", "invoke_tool"],
        PresetId::JunosMcpServer => &[
            "execute_junos_command",
            "load_and_commit_config",
            "get_router_list",
        ],
        _ => &[],
    }
}

/// Command and args as one lowercase list (stdio only), like Casper's words().
fn words(def: &McpServerDef) -> Vec<String> {
    if def.transport != McpTransport::Stdio {
        return Vec::new();
    }
    let file_name = std::path::Path::new(&def.command)
        .file_name()
        .map(|f| f.to_string_lossy().into_owned())
        .unwrap_or_default();
    std::iter::once(def.command.clone())
        .chain(std::iter::once(file_name))
        .chain(def.args.iter().cloned())
        .map(|w| w.to_lowercase())
        .collect()
}

fn env_keys(def: &McpServerDef) -> Vec<&str> {
    if def.transport != McpTransport::Stdio {
        return Vec::new();
    }
    def.env.keys().map(String::as_str).collect()
}

fn http_host(def: &McpServerDef) -> Option<String> {
    if def.transport != McpTransport::Http {
        return None;
    }
    let url = reqwest::Url::parse(def.url.as_deref()?.trim()).ok()?;
    url.host_str().map(|h| h.to_lowercase())
}

struct Facts {
    words: Vec<String>,
    env_keys: Vec<String>,
    host: Option<String>,
}

impl Facts {
    fn of(def: &McpServerDef) -> Self {
        Facts {
            words: words(def),
            env_keys: env_keys(def).into_iter().map(str::to_string).collect(),
            host: http_host(def),
        }
    }
    fn word(&self, test: impl Fn(&str) -> bool) -> bool {
        self.words.iter().any(|w| test(w))
    }
    fn word_contains(&self, needle: &str) -> bool {
        self.word(|w| w.contains(needle))
    }
    fn env_starts(&self, prefix: &str) -> bool {
        self.env_keys.iter().any(|k| k.starts_with(prefix))
    }
    fn host_contains(&self, needle: &str) -> bool {
        self.host.as_deref().is_some_and(|h| h.contains(needle))
    }
}

/// presets.ts matchDefinition, one preset at a time.
fn matches_definition(id: PresetId, f: &Facts) -> bool {
    match id {
        // /tool_router\.py$|^hpe-mcp-router$|hpe_networking_mcp/ or an HPE_MCP_ env key.
        PresetId::HpeNetworkingMcp => {
            f.word(|w| {
                w.ends_with("tool_router.py")
                    || w == "hpe-mcp-router"
                    || w.contains("hpe_networking_mcp")
            }) || f.env_starts("HPE_MCP_")
        }
        PresetId::Centralmcp => f.word_contains("centralmcp") || f.env_starts("CENTRALMCP_"),
        PresetId::CentralMcpServer => {
            f.word_contains("central-mcp-server") || f.word_contains("central_mcp_server")
        }
        // /jmcp\.py$|junos-mcp-server|junos_mcp/
        PresetId::JunosMcpServer => f.word(|w| {
            w.ends_with("jmcp.py") || w.contains("junos-mcp-server") || w.contains("junos_mcp")
        }),
        PresetId::MistHosted => f
            .host
            .as_deref()
            .is_some_and(|h| h == "mist.com" || h.ends_with(".mist.com")),
        PresetId::Netbox => {
            f.word_contains("netbox") || f.env_starts("NETBOX_") || f.host_contains("netbox")
        }
        PresetId::NetmikoMcp => f.word_contains("netmiko"),
        PresetId::OxidizedLibrenms => {
            f.word_contains("oxidized")
                || f.word_contains("librenms")
                || f.env_starts("OXIDIZED_")
                || f.env_starts("LIBRENMS_")
                || f.host_contains("oxidized")
                || f.host_contains("librenms")
        }
        // /mcp-grafana|grafana\/mcp-grafana|^mcp\/grafana/
        PresetId::Grafana => f.word(|w| w.contains("mcp-grafana") || w.starts_with("mcp/grafana")),
        PresetId::ClearpassMcp => f.word_contains("clearpass") || f.env_starts("CLEARPASS_"),
    }
}

fn tools_match(id: PresetId, tool_names: &[&str]) -> bool {
    let sig = signature(id);
    !sig.is_empty() && sig.iter().all(|s| tool_names.contains(s))
}

/// The preset for a definition, and (once its tools are known) whether its
/// tool list fits. presets.ts:406-415.
pub fn match_preset(def: &McpServerDef, tool_names: Option<&[&str]>) -> Option<PresetMatch> {
    let facts = Facts::of(def);
    if let Some(id) = ORDER.into_iter().find(|id| matches_definition(*id, &facts)) {
        let mismatch =
            tool_names.is_some_and(|names| !signature(id).is_empty() && !tools_match(id, names));
        return Some(PresetMatch {
            id,
            by: MatchBy::Definition,
            mismatch,
        });
    }
    match_by_tools(tool_names?)
}

/// A match on the tool list alone, for a server with no saved definition.
pub fn match_by_tools(tool_names: &[&str]) -> Option<PresetMatch> {
    ORDER
        .into_iter()
        .find(|id| tools_match(*id, tool_names))
        .map(|id| PresetMatch {
            id,
            by: MatchBy::Tools,
            mismatch: false,
        })
}

/// How long one tool call may run. Junos commits can take minutes; the
/// server's own timeout is 360 seconds (presets.ts limits.callMs).
pub fn call_timeout_secs(id: Option<PresetId>) -> u64 {
    match id {
        Some(PresetId::JunosMcpServer) => 400,
        _ => 300,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn stdio(command: &str, args: &[&str], env: &[&str]) -> McpServerDef {
        McpServerDef {
            name: "s".into(),
            transport: McpTransport::Stdio,
            command: command.into(),
            args: args.iter().map(|a| a.to_string()).collect(),
            env: env
                .iter()
                .map(|k| (k.to_string(), "1".to_string()))
                .collect(),
            cwd: None,
            url: None,
            credentials_env_var: None,
            headers: HashMap::new(),
            enabled: true,
            show_opt_in: false,
        }
    }

    fn http(url: &str) -> McpServerDef {
        McpServerDef {
            transport: McpTransport::Http,
            url: Some(url.into()),
            ..stdio("", &[], &[])
        }
    }

    fn id_of(def: &McpServerDef) -> Option<PresetId> {
        match_preset(def, None).map(|m| m.id)
    }

    #[test]
    fn junos_matches_by_jmcp_py() {
        let def = stdio(
            "python3",
            &["/opt/junos/jmcp.py", "-f", "devices.json"],
            &[],
        );
        assert_eq!(id_of(&def), Some(PresetId::JunosMcpServer));
    }

    #[test]
    fn centralmcp_matches_by_env_key() {
        let def = stdio("uv", &["run", "server.py"], &["CENTRALMCP_X"]);
        assert_eq!(id_of(&def), Some(PresetId::Centralmcp));
    }

    #[test]
    fn mist_matches_its_host_only() {
        assert_eq!(
            id_of(&http("https://api.mist.com/mcp")),
            Some(PresetId::MistHosted)
        );
        assert_eq!(
            id_of(&http("https://mist.com/mcp")),
            Some(PresetId::MistHosted)
        );
        assert_eq!(id_of(&http("https://evilmist.com/mcp")), None);
        assert_eq!(id_of(&http("not a url")), None);
    }

    #[test]
    fn grafana_matches_the_docker_image() {
        let def = stdio("docker", &["run", "-i", "--rm", "mcp/grafana"], &[]);
        assert_eq!(id_of(&def), Some(PresetId::Grafana));
    }

    #[test]
    fn a_plain_server_matches_nothing() {
        assert_eq!(id_of(&stdio("uvx", &["something"], &[])), None);
        assert_eq!(
            match_preset(&stdio("uvx", &["something"], &[]), Some(&["get_x"])),
            None
        );
    }

    #[test]
    fn hpe_wins_over_centralmcp_for_tool_router_py() {
        // Casper's order: the HPE preset matches any .../tool_router.py first.
        let def = stdio(
            "python",
            &["/home/me/centralmcp/mcp_servers/tool_router.py"],
            &[],
        );
        assert_eq!(id_of(&def), Some(PresetId::HpeNetworkingMcp));
    }

    #[test]
    fn tools_only_match_on_the_hpe_signature() {
        let names = ["find_tool", "invoke_read_tool", "invoke_tool", "other"];
        let m = match_preset(&stdio("uvx", &["something"], &[]), Some(&names)).unwrap();
        assert_eq!(m.id, PresetId::HpeNetworkingMcp);
        assert_eq!(m.by, MatchBy::Tools);
        assert!(!m.mismatch);
        assert_eq!(
            match_by_tools(&names).map(|m| m.id),
            Some(PresetId::HpeNetworkingMcp)
        );
        assert_eq!(match_by_tools(&["find_tool", "invoke_tool"]), None);
    }

    #[test]
    fn mismatch_when_the_signature_is_missing() {
        let def = stdio("python3", &["jmcp.py"], &[]);
        let m = match_preset(&def, Some(&["get_router_list"])).unwrap();
        assert_eq!(m.by, MatchBy::Definition);
        assert!(m.mismatch);
        let ok = match_preset(
            &def,
            Some(&[
                "execute_junos_command",
                "load_and_commit_config",
                "get_router_list",
            ]),
        )
        .unwrap();
        assert!(!ok.mismatch);
        // No signature, no mismatch.
        let netbox = stdio("uvx", &["netbox-mcp"], &[]);
        assert!(!match_preset(&netbox, Some(&[])).unwrap().mismatch);
    }

    #[test]
    fn junos_calls_get_more_time() {
        assert_eq!(call_timeout_secs(Some(PresetId::JunosMcpServer)), 400);
        assert_eq!(call_timeout_secs(Some(PresetId::Netbox)), 300);
        assert_eq!(call_timeout_secs(None), 300);
    }

    #[test]
    fn ids_serialise_like_the_ts_type() {
        assert_eq!(
            serde_json::to_value(PresetId::HpeNetworkingMcp).unwrap(),
            "hpe-networking-mcp"
        );
        assert_eq!(
            serde_json::to_value(PresetId::Centralmcp).unwrap(),
            "centralmcp"
        );
        assert_eq!(
            serde_json::to_value(PresetId::OxidizedLibrenms).unwrap(),
            "oxidized-librenms"
        );
        assert_eq!(
            serde_json::to_value(PresetId::ClearpassMcp).unwrap(),
            "clearpass-mcp"
        );
        assert_eq!(serde_json::to_value(MatchBy::Tools).unwrap(), "tools");
        assert_eq!(preset_label(PresetId::JunosMcpServer), "Junos");
    }
}
