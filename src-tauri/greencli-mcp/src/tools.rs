//! The tool list and the argument checks. Every tool only reads.

use crate::archive::{self, DiffFrom};
use serde_json::{json, Map, Value};
use std::path::Path;

pub enum ToolFail {
    /// Bad arguments or an unknown tool: a JSON-RPC error.
    BadParams(String),
    /// The tool ran but can't answer: an isError result with this text.
    Error(String),
}

#[derive(Clone, Copy, PartialEq)]
enum Kind {
    Text,
    Ts,
    /// Declared as text; a ts number is taken too.
    TextOrTs,
}

struct Param {
    name: &'static str,
    kind: Kind,
    required: bool,
    description: &'static str,
}

struct ToolSpec {
    name: &'static str,
    title: &'static str,
    description: &'static str,
    params: &'static [Param],
}

const CURSOR: Param = Param {
    name: "cursor",
    kind: Kind::Text,
    required: false,
    description: "nextCursor from the last page, to get the next one.",
};

const DEVICE: Param = Param {
    name: "device",
    kind: Kind::Text,
    required: true,
    description: "The device's archiveKey from list_devices (its name in GreenCLI).",
};

const TOOLS: &[ToolSpec] = &[
    ToolSpec {
        name: "access_check",
        title: "Access check",
        description: "Says what this server may do: GreenCLI data, read-only. \
It never changes a device or GreenCLI.",
        params: &[],
    },
    ToolSpec {
        name: "list_devices",
        title: "List devices",
        description: "Lists the devices saved in GreenCLI: name, folder, protocol, host, port, \
device type, tags, and archiveKey (the device name to use with the config tools). \
No passwords, user names, notes or startup commands.",
        params: &[CURSOR],
    },
    ToolSpec {
        name: "list_config_history",
        title: "List config history",
        description: "Lists a device's saved config snapshots, newest first: ts, source \
(connect, manual, before-change, after-change), golden, and hasHiddenCopy. Only snapshots \
with hasHiddenCopy can be read with get_config or get_config_diff.",
        params: &[DEVICE, CURSOR],
    },
    ToolSpec {
        name: "get_config",
        title: "Get config",
        description: "Gets a saved config snapshot with its secrets hidden (passwords, keys and \
community strings are replaced). Leave out ts for the newest one. Long configs come in pages: \
pass nextCursor to get the next one.",
        params: &[
            DEVICE,
            Param {
                name: "ts",
                kind: Kind::Ts,
                required: false,
                description: "The snapshot's ts from list_config_history. Default: the newest.",
            },
            CURSOR,
        ],
    },
    ToolSpec {
        name: "get_config_diff",
        title: "Get config diff",
        description: "Shows what changed between two saved config snapshots, as a unified diff \
of the copies with secrets hidden. A changed password or key looks the same on both sides, so \
a diff can't show a changed secret. Default: the newest snapshot against the one before it.",
        params: &[
            DEVICE,
            Param {
                name: "from",
                kind: Kind::TextOrTs,
                required: false,
                description: "previous (the snapshot before `to`), golden, or a snapshot ts. Default: previous.",
            },
            Param {
                name: "to",
                kind: Kind::Ts,
                required: false,
                description: "The newer snapshot's ts. Default: the newest.",
            },
            CURSOR,
        ],
    },
    ToolSpec {
        name: "list_intents",
        title: "List intents",
        description: "Lists GreenCLI's network intents (checks like \"NTP is set on every switch\") \
with their kind, severity, last result (status and time) and each device's status. \
Not the commands, match rules or output details.",
        params: &[CURSOR],
    },
];

/// The tools/list entries.
pub fn list() -> Vec<Value> {
    TOOLS.iter().map(describe).collect()
}

fn describe(tool: &ToolSpec) -> Value {
    let mut properties = Map::new();
    for p in tool.params {
        let schema = match p.kind {
            Kind::Text | Kind::TextOrTs => {
                json!({ "type": "string", "description": p.description })
            }
            Kind::Ts => json!({ "type": "integer", "minimum": 0, "description": p.description }),
        };
        properties.insert(p.name.to_string(), schema);
    }
    let required: Vec<&str> = tool
        .params
        .iter()
        .filter(|p| p.required)
        .map(|p| p.name)
        .collect();
    json!({
        "name": tool.name,
        "title": tool.title,
        "description": tool.description,
        "inputSchema": {
            "type": "object",
            "properties": properties,
            "required": required,
            "additionalProperties": false
        },
        "annotations": {
            "title": tool.title,
            "readOnlyHint": true,
            "destructiveHint": false,
            "idempotentHint": true,
            "openWorldHint": false
        },
        "_meta": { "casper/safety": "read" }
    })
}

/// Check `args` against the tool's parameters.
fn check_args(tool: &ToolSpec, args: &Map<String, Value>) -> Result<(), ToolFail> {
    for (key, value) in args {
        let Some(param) = tool.params.iter().find(|p| p.name == key) else {
            let shown: String = key.chars().take(64).collect();
            return Err(ToolFail::BadParams(format!(
                "{} has no argument named {shown}.",
                tool.name
            )));
        };
        let ok = match param.kind {
            Kind::Text => value.is_string(),
            Kind::Ts => value.is_u64(),
            Kind::TextOrTs => value.is_string() || value.is_u64(),
        };
        if !ok {
            let what = match param.kind {
                Kind::Text | Kind::TextOrTs => "text",
                Kind::Ts => "a whole number",
            };
            return Err(ToolFail::BadParams(format!(
                "{} must be {what}.",
                param.name
            )));
        }
    }
    for param in tool.params.iter().filter(|p| p.required) {
        if !args.contains_key(param.name) {
            return Err(ToolFail::BadParams(format!(
                "{} needs {}.",
                tool.name, param.name
            )));
        }
    }
    Ok(())
}

/// The text argument `name`, if given.
pub fn text_arg<'a>(args: &'a Map<String, Value>, name: &str) -> Option<&'a str> {
    args.get(name).and_then(Value::as_str)
}

/// The number argument `name`, if given.
pub fn ts_arg(args: &Map<String, Value>, name: &str) -> Option<u64> {
    args.get(name).and_then(Value::as_u64)
}

/// get_config_diff's `from`.
fn from_arg(args: &Map<String, Value>) -> Result<Option<DiffFrom>, ToolFail> {
    let bad = || ToolFail::BadParams("from must be previous, golden or a snapshot ts.".into());
    Ok(match args.get("from") {
        None => None,
        Some(Value::String(s)) => Some(match s.trim() {
            "previous" => DiffFrom::Previous,
            "golden" => DiffFrom::Golden,
            t => DiffFrom::Ts(t.parse().map_err(|_| bad())?),
        }),
        Some(v) => Some(DiffFrom::Ts(v.as_u64().ok_or_else(bad)?)),
    })
}

pub fn call(data_dir: &Path, name: &str, args: &Map<String, Value>) -> Result<Value, ToolFail> {
    let Some(tool) = TOOLS.iter().find(|t| t.name == name) else {
        let shown: String = name.chars().take(64).collect();
        return Err(ToolFail::BadParams(format!("Unknown tool: {shown}")));
    };
    check_args(tool, args)?;
    match tool.name {
        "access_check" => Ok(access_check()),
        "list_intents" => crate::intents::list_intents(data_dir, text_arg(args, "cursor")),
        "list_devices" => crate::devices::list_devices(data_dir, text_arg(args, "cursor")),
        "list_config_history" => archive::list_config_history(
            data_dir,
            text_arg(args, "device").unwrap_or_default(),
            text_arg(args, "cursor"),
        ),
        "get_config" => archive::get_config(
            data_dir,
            text_arg(args, "device").unwrap_or_default(),
            ts_arg(args, "ts"),
            text_arg(args, "cursor"),
        ),
        "get_config_diff" => archive::get_config_diff(
            data_dir,
            text_arg(args, "device").unwrap_or_default(),
            from_arg(args)?,
            ts_arg(args, "to"),
            text_arg(args, "cursor"),
        ),
        _ => Err(ToolFail::BadParams("Unknown tool.".into())),
    }
}

/// The `casper/access-check v1` answer: GreenCLI data, read-only.
pub fn access_check() -> Value {
    json!({
        "contract": "casper/access-check v1",
        "products": [{
            "product": "greencli",
            "access": "read-only",
            "identity": format!("greencli-mcp {}", crate::VERSION)
        }]
    })
}
