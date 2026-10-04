// Presets for known network MCP servers. Ported from casper
// src/mcp/presets.ts @ ad678b6 (MIT, Choaterboater): matching (how GreenCLI
// recognises a server), the read-only pins sent while writes are off, the
// label tighten rules, which tools writes-off hides, and the Junos show-only
// parser. A preset only ever makes GreenCLI stricter.
//
// Matching keeps Casper's order: the first preset that matches wins. There is
// no regex crate, so each Casper pattern is written out by hand. "Casper"
// became "GreenCLI" in the reason texts.

use super::client::{McpServerDef, McpToolInfo, McpTransport};
use super::labels::{strictest, SafetyLabel};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PresetId {
    HpeNetworkingMcp,
    Centralmcp,
    CentralMcpServer,
    JunosMcpServer,
    MistHosted,
    GreencliMcp,
    MistMcp,
    Netbox,
    NetmikoMcp,
    OxidizedLibrenms,
    Grafana,
    ClearpassMcp,
}

/// Casper's table order: the first match wins.
const ORDER: [PresetId; 12] = [
    PresetId::HpeNetworkingMcp,
    PresetId::Centralmcp,
    PresetId::CentralMcpServer,
    PresetId::JunosMcpServer,
    PresetId::MistHosted,
    PresetId::GreencliMcp,
    PresetId::MistMcp,
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
        PresetId::GreencliMcp => "GreenCLI",
        PresetId::MistMcp => "Mist",
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
        // GreenCLI's own server, by the program's file name from any folder.
        PresetId::GreencliMcp => f
            .words
            .first()
            .and_then(|command| command.rsplit(['/', '\\']).next())
            .is_some_and(is_greencli_mcp_file),
        // A local Mist API server (mist_mcp) with a MIST_READ_ONLY switch.
        PresetId::MistMcp => {
            f.word(|w| w.contains("mist-mcp") || w.contains("mist_mcp"))
                || f.env_keys.iter().any(|k| k == "MIST_READ_ONLY")
        }
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

/// greencli-mcp or greencli-mcp.exe (any case): GreenCLI's own read-only
/// server. Casper presets.ts matches the same file names.
pub fn is_greencli_mcp_file(file_name: &str) -> bool {
    matches!(
        file_name.to_lowercase().as_str(),
        "greencli-mcp" | "greencli-mcp.exe"
    )
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

// ─── Read-only pins (presets.ts:251-380, 421-466) ───

/// Settings that keep the server itself read-only while writes are off.
pub struct Pins {
    pub env: &'static [(&'static str, &'static str)],
    pub append_args: &'static [&'static str],
}

/// The HPE server's own read-only settings. safe-read-only with any write gate
/// at 1 is a startup error in that server, so every gate is pinned to 0.
const HPE_PINS: &[(&str, &str)] = &[
    ("HPE_MCP_ACCESS_PROFILE", "safe-read-only"),
    ("HPE_MCP_READONLY", "1"),
    ("HPE_MCP_PRODUCT_ACCESS", "read-only"),
    ("HPE_MCP_CENTRAL_WRITES", "0"),
    ("HPE_MCP_GLP_V2BETA1_WRITES", "0"),
    ("HPE_MCP_AOS8_WRITES", "0"),
    ("HPE_MCP_EDGECONNECT_WRITES", "0"),
    ("HPE_MCP_APSTRA_WRITES", "0"),
    ("HPE_MCP_MIST_WRITES", "0"),
    ("HPE_MCP_CLEARPASS_WRITES", "0"),
    ("HPE_MCP_UXI_WRITES", "0"),
    ("HPE_MCP_AXIS_WRITES", "0"),
    ("HPE_MCP_AOS8_ROLLBACK_WRITES", "0"),
];

pub fn pins(id: PresetId) -> Option<Pins> {
    match id {
        PresetId::HpeNetworkingMcp => Some(Pins {
            env: HPE_PINS,
            append_args: &[],
        }),
        PresetId::Centralmcp => Some(Pins {
            env: &[("CENTRALMCP_READONLY", "1")],
            append_args: &[],
        }),
        PresetId::Grafana => Some(Pins {
            env: &[],
            append_args: &["--disable-write"],
        }),
        PresetId::ClearpassMcp => Some(Pins {
            env: &[("CLEARPASS_READ_ONLY", "true")],
            append_args: &[],
        }),
        PresetId::MistMcp => Some(Pins {
            env: &[("MIST_READ_ONLY", "1")],
            append_args: &[],
        }),
        _ => None,
    }
}

pub const CANT_PIN_REMOTE: &str = "it runs elsewhere";

/// Why a preset has no read-only setting GreenCLI can send.
pub fn no_pin_reason(id: PresetId) -> Option<&'static str> {
    match id {
        PresetId::CentralMcpServer
        | PresetId::JunosMcpServer
        | PresetId::Netbox
        | PresetId::OxidizedLibrenms => Some("it has no read-only setting"),
        PresetId::NetmikoMcp => Some("GreenCLI can't set its allowlist"),
        PresetId::MistHosted => Some(CANT_PIN_REMOTE),
        PresetId::GreencliMcp => Some("it has no read-only setting; GreenCLI ships no write tools"),
        _ => None,
    }
}

/// What connect does while writes are off. The export (mcp_export_pins)
/// sends it to the settings page as {"kind": "pinned", "args", "env", "shown"}.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum PinPlan {
    None,
    Pinned {
        args: Vec<String>,
        env: Vec<(String, String)>,
        /// "KEY=VALUE" and appended args, for the settings line.
        shown: Vec<String>,
    },
    CannotPin {
        reason: String,
    },
}

/// The pins as mcp_status shows them.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum PinView {
    None,
    Pinned { shown: Vec<String>, confirmed: bool },
    CannotPin { reason: String },
}

impl PinView {
    pub fn of(plan: &PinPlan, confirmed: bool) -> PinView {
        match plan {
            PinPlan::None => PinView::None,
            PinPlan::Pinned { shown, .. } => PinView::Pinned {
                shown: shown.clone(),
                confirmed,
            },
            PinPlan::CannotPin { reason } => PinView::CannotPin {
                reason: reason.clone(),
            },
        }
    }
}

/// presets.ts commandName: the file name, lowercase, without .exe/.cmd/.bat.
fn command_name(command: &str) -> String {
    let base = std::path::Path::new(command)
        .file_name()
        .map(|f| f.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    for ext in [".exe", ".cmd", ".bat"] {
        if let Some(stem) = base.strip_suffix(ext) {
            return stem.to_string();
        }
    }
    base
}

fn is_container_command(def: &McpServerDef) -> bool {
    def.transport == McpTransport::Stdio
        && matches!(command_name(&def.command).as_str(), "docker" | "podman")
}

/// Options that take a value in `docker run` / `podman run`.
#[rustfmt::skip]
const DOCKER_VALUE_OPTIONS: &[&str] = &[
    "-e", "--env", "--env-file", "-v", "--volume", "--name", "--network", "--net", "-p",
    "--publish", "-w", "--workdir", "-u", "--user", "--entrypoint", "--mount", "-l", "--label",
    "--platform", "--pull", "-h", "--hostname", "--add-host", "--cpus", "-m", "--memory", "--dns",
    "--cap-add", "--cap-drop", "--security-opt", "--tmpfs", "--ulimit", "--log-driver",
    "--log-opt", "--restart", "--stop-signal", "--stop-timeout", "--pids-limit", "--group-add",
    "--ipc", "--pid", "--userns",
];
/// Options without a value.
#[rustfmt::skip]
const DOCKER_FLAG_OPTIONS: &[&str] = &[
    "-i", "-t", "-it", "-ti", "--interactive", "--tty", "--rm", "-d", "--detach", "--init",
    "--read-only", "-q", "--quiet", "--privileged", "-P", "--publish-all", "--no-healthcheck",
    "--sig-proxy",
];

/// Where the image sits in `docker run ... image ...` (its index in args and
/// the image), or None when GreenCLI can't tell. Anything unknown stops the parse.
pub fn container_run(def: &McpServerDef) -> Option<(usize, String)> {
    if !is_container_command(def) {
        return None;
    }
    let args = &def.args;
    let mut index = usize::from(args.first().map(String::as_str) == Some("container"));
    if args.get(index).map(String::as_str) != Some("run") {
        return None;
    }
    index += 1;
    while index < args.len() {
        let arg = args[index].as_str();
        if !arg.starts_with('-') {
            return Some((index, arg.to_string()));
        }
        if arg == "--" {
            return None;
        }
        if let Some((option, _)) = arg.split_once('=') {
            if DOCKER_VALUE_OPTIONS.contains(&option) || DOCKER_FLAG_OPTIONS.contains(&option) {
                index += 1;
                continue;
            }
        }
        if DOCKER_FLAG_OPTIONS.contains(&arg) {
            index += 1;
            continue;
        }
        if DOCKER_VALUE_OPTIONS.contains(&arg) {
            index += 2;
            continue;
        }
        return None;
    }
    None
}

const SHELLS: &[&str] = &[
    "sh",
    "bash",
    "zsh",
    "dash",
    "fish",
    "cmd",
    "powershell",
    "pwsh",
];

/// The program to start while writes are off. Env pins beat the user's own
/// env. For docker and podman they go in as `-e NAME=VALUE` right before the
/// image, after the user's own options, so they are the last word. Args are
/// added once. When GreenCLI can't place a pin where the server will see it,
/// the plan says so instead of claiming a pin.
pub fn plan_pins(def: &McpServerDef, id: PresetId) -> PinPlan {
    let stdio = def.transport == McpTransport::Stdio;
    let cannot = |reason: &str| PinPlan::CannotPin {
        reason: reason.to_string(),
    };
    let pins = match pins(id) {
        Some(p) if !p.env.is_empty() || !p.append_args.is_empty() => p,
        _ => {
            if !stdio {
                return cannot(CANT_PIN_REMOTE);
            }
            return no_pin_reason(id).map_or(PinPlan::None, cannot);
        }
    };
    if !stdio {
        return cannot(CANT_PIN_REMOTE);
    }
    let env: Vec<(String, String)> = pins
        .env
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect();
    let mut shown: Vec<String> = env.iter().map(|(k, v)| format!("{k}={v}")).collect();
    shown.extend(pins.append_args.iter().map(|a| a.to_string()));
    let missing: Vec<String> = pins
        .append_args
        .iter()
        .filter(|a| !def.args.iter().any(|x| x == *a))
        .map(|a| a.to_string())
        .collect();
    if is_container_command(def) {
        let Some((image, _)) = container_run(def) else {
            return cannot("GreenCLI can't tell which part of the docker command is the image");
        };
        let mut args: Vec<String> = def.args[..image].to_vec();
        for (k, v) in &env {
            args.push("-e".into());
            args.push(format!("{k}={v}"));
        }
        args.extend_from_slice(&def.args[image..]);
        args.extend(missing);
        return PinPlan::Pinned {
            args,
            env: Vec::new(),
            shown,
        };
    }
    let command = command_name(&def.command);
    if !missing.is_empty()
        && (SHELLS.contains(&command.as_str()) || def.args.iter().any(|a| a == "--"))
    {
        return cannot("GreenCLI can't tell where its settings go in this command");
    }
    let mut args = def.args.clone();
    args.extend(missing);
    PinPlan::Pinned { args, env, shown }
}

/// Puts a Pinned plan into the definition GreenCLI starts: its args, then its
/// env. A user env key equal to a pin key, ignoring ASCII case, is removed
/// first (on every system), so no two keys name the same Windows variable and
/// HashMap order can never let the user's value win.
pub fn apply_pins(def: &mut McpServerDef, plan: &PinPlan) {
    if let PinPlan::Pinned { args, env, .. } = plan {
        def.args = args.clone();
        for (key, value) in env {
            def.env.retain(|k, _| !k.eq_ignore_ascii_case(key));
            def.env.insert(key.clone(), value.clone());
        }
    }
}

// ─── Labels and hiding (presets.ts:275, 314-319, 353-354, 484-489) ───

/// The preset's label for a tool, never below the label it already has.
/// Same rules as TS presetTighten.
pub fn tighten(id: PresetId, tool_name: &str, label: SafetyLabel) -> SafetyLabel {
    let raised = match id {
        PresetId::HpeNetworkingMcp if matches!(tool_name, "invoke_tool" | "invoke_tools_batch") => {
            SafetyLabel::Destructive
        }
        PresetId::JunosMcpServer
            if matches!(
                tool_name,
                "load_and_commit_config" | "render_and_apply_j2_template"
            ) =>
        {
            SafetyLabel::Destructive
        }
        PresetId::JunosMcpServer if tool_name.starts_with("execute_") => SafetyLabel::Exec,
        // /^send_|config/
        PresetId::NetmikoMcp if tool_name.starts_with("send_") || tool_name.contains("config") => {
            SafetyLabel::Exec
        }
        _ => label,
    };
    strictest(&[label, raised])
}

/// The preset's own list of tools hidden while writes are off (on top of
/// every write and destructive tool).
pub fn hide_when_writes_off(id: PresetId, tool: &McpToolInfo) -> bool {
    let not_annotated_read = || {
        tool.annotations
            .as_ref()
            .and_then(|a| a.get("readOnlyHint"))
            != Some(&Value::Bool(true))
    };
    match id {
        PresetId::HpeNetworkingMcp => {
            matches!(tool.name.as_str(), "invoke_tool" | "invoke_tools_batch")
        }
        PresetId::JunosMcpServer => matches!(
            tool.name.as_str(),
            "load_and_commit_config" | "render_and_apply_j2_template"
        ),
        PresetId::CentralMcpServer | PresetId::NetmikoMcp | PresetId::OxidizedLibrenms => {
            not_annotated_read()
        }
        _ => false,
    }
}

// ─── Junos show-only parser (presets.ts:209-245) ───

#[rustfmt::skip]
const JUNOS_PIPES: &[&str] = &[
    "match", "except", "count", "display", "no-more", "last", "find", "trim",
];
const JUNOS_EXECUTE: &[&str] = &[
    "execute_junos_command",
    "execute_junos_command_batch",
    "execute_junos_pfe_command",
];
pub const JUNOS_WRITES_OFF: &str = "Junos writes are off; only show commands run.";

fn junos_space(c: char) -> bool {
    c == ' ' || c == '\t'
}

/// A plain Junos `show` command: the literal word `show` first, no `;`, no
/// line breaks, no redirection, and every `|` stage from a small read-only
/// list. Like TS, any character outside printable ASCII and tab is refused
/// first, so length is bytes and white space is only space and tab.
pub fn is_plain_junos_show(command: &str) -> bool {
    if !command
        .chars()
        .all(|c| c == '\t' || (' '..='~').contains(&c))
    {
        return false;
    }
    if command.len() > 512 {
        return false;
    }
    if command.contains([';', '\r', '\n', '\0', '`', '>', '&', '$', '\\']) {
        return false;
    }
    let stages: Vec<&str> = command
        .split('|')
        .map(|s| s.trim_matches(junos_space))
        .collect();
    let words = |stage: &str| -> Vec<String> {
        stage
            .split(junos_space)
            .filter(|w| !w.is_empty())
            .map(str::to_string)
            .collect()
    };
    let head = words(stages[0]);
    if head.first().map(String::as_str) != Some("show")
        || head.len() < 2
        || !head[1].starts_with(|c: char| c.is_ascii_lowercase())
    {
        return false;
    }
    stages[1..].iter().all(|stage| {
        words(stage)
            .first()
            .is_some_and(|w| JUNOS_PIPES.contains(&w.as_str()))
    })
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum JunosShow {
    /// Every command/commands entry is a plain show.
    AllShow,
    NotShow,
    /// Not one of the execute tools.
    NotApplicable,
}

/// Same as TS junosShow.
pub fn junos_show(tool_name: &str, args: &Value) -> JunosShow {
    if !JUNOS_EXECUTE.contains(&tool_name) {
        return JunosShow::NotApplicable;
    }
    let mut commands: Vec<Option<&Value>> = Vec::new();
    if let Some(obj) = args.as_object() {
        if let Some(c) = obj.get("command") {
            commands.push(Some(c));
        }
        if let Some(cs) = obj.get("commands") {
            match cs.as_array() {
                Some(items) => commands.extend(items.iter().map(Some)),
                None => commands.push(None),
            }
        }
    }
    let all_show = !commands.is_empty()
        && commands
            .iter()
            .all(|c| c.and_then(Value::as_str).is_some_and(is_plain_junos_show));
    if all_show {
        JunosShow::AllShow
    } else {
        JunosShow::NotShow
    }
}

/// The refusing side of Casper's Junos argument guard: with writes off, only
/// plain show commands run, and the commit tools never do.
pub fn junos_guard(tool_name: &str, args: &Value, writes_on: bool) -> Result<(), String> {
    if writes_on {
        return Ok(());
    }
    let refused = matches!(
        tool_name,
        "load_and_commit_config" | "render_and_apply_j2_template"
    ) || junos_show(tool_name, args) == JunosShow::NotShow;
    if refused {
        Err(JUNOS_WRITES_OFF.to_string())
    } else {
        Ok(())
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
            writes: None,
            show_opt_in: false,
            wait_for_connect: false,
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

    #[test]
    fn mist_mcp_and_greencli_mcp_are_known() {
        // Casper's order: mist-hosted, greencli-mcp, mist-mcp, then netbox.
        let mist = stdio("uvx", &["mist-mcp"], &[]);
        assert_eq!(id_of(&mist), Some(PresetId::MistMcp));
        assert_eq!(
            id_of(&stdio("python", &["/opt/mist_mcp/server.py"], &[])),
            Some(PresetId::MistMcp)
        );
        assert_eq!(
            id_of(&stdio("uv", &["run", "server.py"], &["MIST_READ_ONLY"])),
            Some(PresetId::MistMcp)
        );
        let plan = plan_pins(&mist, PresetId::MistMcp);
        let (_, env, shown) = pinned(&plan);
        assert_eq!(env, &vec![("MIST_READ_ONLY".to_string(), "1".to_string())]);
        assert_eq!(shown, &vec!["MIST_READ_ONLY=1".to_string()]);
        assert_eq!(preset_label(PresetId::MistMcp), "Mist");

        let own = stdio(
            "/Applications/GreenCLI.app/Contents/MacOS/greencli-mcp",
            &[],
            &[],
        );
        assert_eq!(id_of(&own), Some(PresetId::GreencliMcp));
        assert_eq!(
            id_of(&stdio(
                "C:\\Program Files\\GreenCLI\\GREENCLI-MCP.EXE",
                &[],
                &[]
            )),
            Some(PresetId::GreencliMcp)
        );
        assert_eq!(id_of(&stdio("greencli-mcp-old", &[], &[])), None);
        assert_eq!(preset_label(PresetId::GreencliMcp), "GreenCLI");
        assert_eq!(
            reason(&plan_pins(&own, PresetId::GreencliMcp)),
            "it has no read-only setting; GreenCLI ships no write tools"
        );
        assert_eq!(serde_json::to_value(PresetId::MistMcp).unwrap(), "mist-mcp");
        assert_eq!(
            serde_json::to_value(PresetId::GreencliMcp).unwrap(),
            "greencli-mcp"
        );
        // Every id is in the table once.
        assert_eq!(ORDER.len(), 12);
        for id in ORDER {
            assert_eq!(ORDER.iter().filter(|x| **x == id).count(), 1);
            assert!(!preset_label(id).is_empty());
        }
    }

    // ─── pins ───

    fn pinned(plan: &PinPlan) -> (&Vec<String>, &Vec<(String, String)>, &Vec<String>) {
        match plan {
            PinPlan::Pinned { args, env, shown } => (args, env, shown),
            other => panic!("not pinned: {:?}", other),
        }
    }

    fn reason(plan: &PinPlan) -> &str {
        match plan {
            PinPlan::CannotPin { reason } => reason,
            other => panic!("no reason: {:?}", other),
        }
    }

    #[test]
    fn centralmcp_pin_overrides_the_users_value() {
        let mut def = stdio("uv", &["run", "centralmcp"], &[]);
        def.env.insert("CENTRALMCP_READONLY".into(), "0".into());
        let plan = plan_pins(&def, PresetId::Centralmcp);
        let (args, env, shown) = pinned(&plan);
        assert_eq!(args, &def.args);
        assert_eq!(
            env,
            &vec![("CENTRALMCP_READONLY".to_string(), "1".to_string())]
        );
        assert_eq!(shown, &vec!["CENTRALMCP_READONLY=1".to_string()]);
        apply_pins(&mut def, &plan);
        assert_eq!(def.env["CENTRALMCP_READONLY"], "1");
        // The shape the export reads (mcpTypes.ts McpExportPins).
        assert_eq!(
            serde_json::to_value(&plan).unwrap(),
            serde_json::json!({
                "kind": "pinned",
                "args": ["run", "centralmcp"],
                "env": [["CENTRALMCP_READONLY", "1"]],
                "shown": ["CENTRALMCP_READONLY=1"]
            })
        );
        assert_eq!(
            serde_json::to_value(PinPlan::CannotPin { reason: "x".into() }).unwrap(),
            serde_json::json!({ "kind": "cannot-pin", "reason": "x" })
        );
    }

    #[test]
    fn apply_pins_removes_other_case_keys() {
        let mut def = stdio("uv", &["run", "centralmcp"], &[]);
        def.env.insert("centralmcp_readonly".into(), "0".into());
        def.env.insert("OTHER".into(), "x".into());
        let plan = plan_pins(&def, PresetId::Centralmcp);
        apply_pins(&mut def, &plan);
        let keys: Vec<&String> = def
            .env
            .keys()
            .filter(|k| k.eq_ignore_ascii_case("centralmcp_readonly"))
            .collect();
        assert_eq!(keys, vec!["CENTRALMCP_READONLY"]);
        assert_eq!(def.env["OTHER"], "x");
        // Nothing to apply for other plans.
        let before = def.clone();
        apply_pins(&mut def, &PinPlan::None);
        assert_eq!(def.args, before.args);
        assert_eq!(def.env, before.env);
    }

    #[test]
    fn hpe_pins_every_gate() {
        let def = stdio("python", &["tool_router.py"], &[]);
        let plan = plan_pins(&def, PresetId::HpeNetworkingMcp);
        let (_, env, shown) = pinned(&plan);
        assert_eq!(env.len(), 13);
        assert_eq!(shown[0], "HPE_MCP_ACCESS_PROFILE=safe-read-only");
        assert!(shown.contains(&"HPE_MCP_AOS8_ROLLBACK_WRITES=0".to_string()));
    }

    #[test]
    fn grafana_appends_disable_write_once() {
        let def = stdio("mcp-grafana", &[], &[]);
        let plan = plan_pins(&def, PresetId::Grafana);
        let (args, env, shown) = pinned(&plan);
        assert_eq!(args, &vec!["--disable-write".to_string()]);
        assert!(env.is_empty());
        assert_eq!(shown, &vec!["--disable-write".to_string()]);
        let again = stdio("mcp-grafana", &["--disable-write"], &[]);
        let plan = plan_pins(&again, PresetId::Grafana);
        assert_eq!(pinned(&plan).0, &vec!["--disable-write".to_string()]);
    }

    #[test]
    fn docker_pins_go_before_the_image() {
        let def = stdio("docker", &["run", "-i", "--rm", "mcp/grafana"], &[]);
        assert_eq!(container_run(&def), Some((3, "mcp/grafana".to_string())));
        let plan = plan_pins(&def, PresetId::Grafana);
        assert_eq!(
            pinned(&plan).0,
            &vec!["run", "-i", "--rm", "mcp/grafana", "--disable-write"]
                .into_iter()
                .map(String::from)
                .collect::<Vec<_>>()
        );
        let hpe = stdio(
            "/usr/local/bin/docker",
            &[
                "run",
                "-i",
                "--rm",
                "-e",
                "HPE_MCP_READONLY=0",
                "--name=x",
                "hpe-mcp-router",
                "--flag",
            ],
            &[],
        );
        assert_eq!(id_of(&hpe), Some(PresetId::HpeNetworkingMcp));
        let plan = plan_pins(&hpe, PresetId::HpeNetworkingMcp);
        let (args, env, _) = pinned(&plan);
        assert!(env.is_empty());
        let user = args.iter().position(|a| a == "HPE_MCP_READONLY=0").unwrap();
        let pin = args.iter().position(|a| a == "HPE_MCP_READONLY=1").unwrap();
        let image = args.iter().position(|a| a == "hpe-mcp-router").unwrap();
        assert!(user < pin && pin < image);
        assert_eq!(args[pin - 1], "-e");
        assert_eq!(args.last().map(String::as_str), Some("--flag"));
        let podman = stdio("podman.exe", &["container", "run", "img"], &[]);
        assert_eq!(container_run(&podman), Some((2, "img".to_string())));
    }

    #[test]
    fn cases_that_cannot_pin() {
        let odd = stdio("docker", &["run", "--weird", "mcp/grafana"], &[]);
        assert_eq!(container_run(&odd), None);
        assert_eq!(
            reason(&plan_pins(&odd, PresetId::Grafana)),
            "GreenCLI can't tell which part of the docker command is the image"
        );
        let remote = http("https://grafana.example.com/mcp");
        assert_eq!(
            reason(&plan_pins(&remote, PresetId::Grafana)),
            CANT_PIN_REMOTE
        );
        let bash = stdio("bash", &["-c", "mcp-grafana"], &[]);
        assert_eq!(
            reason(&plan_pins(&bash, PresetId::Grafana)),
            "GreenCLI can't tell where its settings go in this command"
        );
        let dashdash = stdio("npx", &["mcp-grafana", "--"], &[]);
        assert!(matches!(
            plan_pins(&dashdash, PresetId::Grafana),
            PinPlan::CannotPin { .. }
        ));
        // Env-only pins still go in after a shell (nothing to place in args).
        let shell_env = stdio("bash", &["-c", "centralmcp"], &[]);
        assert!(matches!(
            plan_pins(&shell_env, PresetId::Centralmcp),
            PinPlan::Pinned { .. }
        ));
        let junos = stdio("python3", &["jmcp.py"], &[]);
        assert_eq!(
            reason(&plan_pins(&junos, PresetId::JunosMcpServer)),
            "it has no read-only setting"
        );
        assert_eq!(
            reason(&plan_pins(
                &stdio("uvx", &["netmiko-mcp"], &[]),
                PresetId::NetmikoMcp
            )),
            "GreenCLI can't set its allowlist"
        );
        assert_eq!(
            reason(&plan_pins(
                &http("https://api.mist.com/mcp"),
                PresetId::MistHosted
            )),
            CANT_PIN_REMOTE
        );
        assert_eq!(
            reason(&plan_pins(
                &http("https://netbox.local/mcp"),
                PresetId::Netbox
            )),
            CANT_PIN_REMOTE
        );
    }

    #[test]
    fn pin_view_serialises_like_the_ts_type() {
        let plan = plan_pins(&stdio("uv", &["centralmcp"], &[]), PresetId::Centralmcp);
        assert_eq!(
            serde_json::to_value(PinView::of(&plan, true)).unwrap(),
            serde_json::json!({ "kind": "pinned", "shown": ["CENTRALMCP_READONLY=1"], "confirmed": true })
        );
        assert_eq!(
            serde_json::to_value(PinView::of(&PinPlan::None, false)).unwrap(),
            serde_json::json!({ "kind": "none" })
        );
        let cannot = PinPlan::CannotPin { reason: "r".into() };
        assert_eq!(
            serde_json::to_value(PinView::of(&cannot, false)).unwrap(),
            serde_json::json!({ "kind": "cannot-pin", "reason": "r" })
        );
    }

    // ─── labels and hiding ───

    fn info(name: &str, read_only: bool) -> McpToolInfo {
        let mut t = serde_json::json!({ "name": name });
        if read_only {
            t["annotations"] = serde_json::json!({ "readOnlyHint": true });
        }
        crate::mcp::client::tool_from_json("s", &t).unwrap()
    }

    #[test]
    fn tighten_only_raises() {
        use SafetyLabel::*;
        assert_eq!(
            tighten(PresetId::JunosMcpServer, "load_and_commit_config", Read),
            Destructive
        );
        assert_eq!(
            tighten(PresetId::JunosMcpServer, "execute_junos_command", Read),
            Exec
        );
        assert_eq!(
            tighten(PresetId::JunosMcpServer, "execute_x", Destructive),
            Destructive
        );
        assert_eq!(tighten(PresetId::NetmikoMcp, "send_config_set", Read), Exec);
        assert_eq!(tighten(PresetId::NetmikoMcp, "get_config", Read), Exec);
        assert_eq!(tighten(PresetId::NetmikoMcp, "list_devices", Read), Read);
        assert_eq!(
            tighten(PresetId::HpeNetworkingMcp, "invoke_tools_batch", Read),
            Destructive
        );
        assert_eq!(tighten(PresetId::Netbox, "invoke_tool", Write), Write);
    }

    #[test]
    fn hide_lists() {
        assert!(hide_when_writes_off(
            PresetId::HpeNetworkingMcp,
            &info("invoke_tool", true)
        ));
        assert!(!hide_when_writes_off(
            PresetId::HpeNetworkingMcp,
            &info("invoke_read_tool", false)
        ));
        assert!(hide_when_writes_off(
            PresetId::JunosMcpServer,
            &info("render_and_apply_j2_template", true)
        ));
        assert!(!hide_when_writes_off(
            PresetId::JunosMcpServer,
            &info("execute_junos_command", false)
        ));
        for id in [
            PresetId::CentralMcpServer,
            PresetId::NetmikoMcp,
            PresetId::OxidizedLibrenms,
        ] {
            assert!(hide_when_writes_off(id, &info("get_config", false)));
            assert!(!hide_when_writes_off(id, &info("get_config", true)));
        }
        assert!(!hide_when_writes_off(
            PresetId::Netbox,
            &info("get_config", false)
        ));
    }

    // ─── Junos ───

    #[test]
    fn junos_show_fixture_matches() {
        let cases: Vec<serde_json::Value> =
            serde_json::from_str(include_str!("testdata/junos_show_cases.json")).unwrap();
        assert!(cases.len() >= 10);
        for case in &cases {
            let command = case["command"].as_str().unwrap();
            assert_eq!(
                is_plain_junos_show(command),
                case["plain"].as_bool().unwrap(),
                "{:?}",
                command
            );
        }
    }

    #[test]
    fn junos_show_shapes() {
        use serde_json::json;
        assert_eq!(
            junos_show("get_router_list", &json!({})),
            JunosShow::NotApplicable
        );
        assert_eq!(
            junos_show(
                "execute_junos_command",
                &json!({ "command": "show version" })
            ),
            JunosShow::AllShow
        );
        assert_eq!(
            junos_show(
                "execute_junos_command_batch",
                &json!({ "commands": ["show a", "show b | count"] })
            ),
            JunosShow::AllShow
        );
        assert_eq!(
            junos_show(
                "execute_junos_command_batch",
                &json!({ "commands": "show a" })
            ),
            JunosShow::NotShow
        );
        assert_eq!(
            junos_show("execute_junos_command", &json!({})),
            JunosShow::NotShow
        );
        assert_eq!(
            junos_show("execute_junos_command", &json!({ "command": 5 })),
            JunosShow::NotShow
        );
    }

    #[test]
    fn junos_guard_with_writes_off() {
        use serde_json::json;
        assert_eq!(
            junos_guard("load_and_commit_config", &json!({}), false),
            Err(JUNOS_WRITES_OFF.to_string())
        );
        assert_eq!(
            junos_guard("load_and_commit_config", &json!({}), true),
            Ok(())
        );
        assert_eq!(
            junos_guard(
                "execute_junos_command",
                &json!({ "command": "show version" }),
                false
            ),
            Ok(())
        );
        assert!(junos_guard(
            "execute_junos_command_batch",
            &json!({ "commands": ["show x", "configure"] }),
            false
        )
        .is_err());
        assert_eq!(junos_guard("get_router_list", &json!({}), false), Ok(()));
    }
}
