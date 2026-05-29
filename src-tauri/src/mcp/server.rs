// MCP (Model Context Protocol) server that exposes terminal sessions
// as resources and tools for AI assistants

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;

// ─── MCP Protocol Types ───

#[derive(Debug, Serialize, Deserialize)]
pub struct McpInitializeRequest {
    #[serde(rename = "protocolVersion")]
    pub protocol_version: String,
    pub capabilities: Value,
    #[serde(rename = "clientInfo")]
    pub client_info: McpClientInfo,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct McpClientInfo {
    pub name: String,
    pub version: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct McpTool {
    pub name: String,
    pub description: String,
    #[serde(rename = "inputSchema")]
    pub input_schema: Value,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct McpResource {
    pub uri: String,
    pub name: String,
    #[serde(rename = "mimeType")]
    pub mime_type: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct McpToolListResponse {
    pub tools: Vec<McpTool>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct McpToolCallRequest {
    pub name: String,
    pub arguments: Value,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct McpToolCallResponse {
    pub content: Vec<McpContentItem>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_error: Option<bool>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct McpContentItem {
    #[serde(rename = "type")]
    pub content_type: String,
    pub text: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct McpResourceListResponse {
    pub resources: Vec<McpResource>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct McpResourceReadRequest {
    pub uri: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct McpResourceReadResponse {
    pub contents: Vec<McpResourceContent>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct McpResourceContent {
    pub uri: String,
    #[serde(rename = "mimeType")]
    pub mime_type: String,
    pub text: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct McpInitializeResponse {
    #[serde(rename = "protocolVersion")]
    pub protocol_version: String,
    pub capabilities: Value,
    #[serde(rename = "serverInfo")]
    pub server_info: McpServerInfo,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct McpServerInfo {
    pub name: String,
    pub version: String,
}

// ─── Terminal Session State (shared with main app) ───

#[derive(Default, Debug)]
pub struct TerminalSessionState {
    pub buffers: HashMap<String, String>,
    pub device_info: HashMap<String, Value>,
}

impl TerminalSessionState {
    pub fn new() -> Self {
        Self {
            buffers: HashMap::new(),
            device_info: HashMap::new(),
        }
    }

    pub fn update_buffer(&mut self, session_id: &str, data: &str) {
        self.buffers
            .entry(session_id.to_string())
            .and_modify(|b| b.push_str(data))
            .or_insert_with(|| data.to_string());
    }

    pub fn get_buffer(&self, session_id: &str) -> Option<&String> {
        self.buffers.get(session_id)
    }

    pub fn set_device_info(&mut self, session_id: &str, info: Value) {
        self.device_info.insert(session_id.to_string(), info);
    }

    pub fn get_device_info(&self, session_id: &str) -> Option<&Value> {
        self.device_info.get(session_id)
    }

    pub fn list_sessions(&self) -> Vec<String> {
        self.buffers.keys().cloned().collect()
    }
}

// ─── MCP Server ───

pub struct McpServer {
    state: TerminalSessionState,
}

impl McpServer {
    pub fn new() -> Self {
        Self {
            state: TerminalSessionState::new(),
        }
    }

    pub fn initialize(&self, _request: McpInitializeRequest) -> McpInitializeResponse {
        McpInitializeResponse {
            protocol_version: "2024-11-05".to_string(),
            capabilities: json!({
                "tools": { "listChanged": false },
                "resources": { "subscribe": false, "listChanged": false }
            }),
            server_info: McpServerInfo {
                name: "aruba-terminal-pro-mcp".to_string(),
                version: env!("CARGO_PKG_VERSION").to_string(),
            },
        }
    }

    pub fn list_tools(&self) -> McpToolListResponse {
        McpToolListResponse {
            tools: vec![
                McpTool {
                    name: "send_command".to_string(),
                    description: "Send a CLI command to an active terminal session".to_string(),
                    input_schema: json!({
                        "type": "object",
                        "properties": {
                            "session_id": {
                                "type": "string",
                                "description": "The session ID to send the command to"
                            },
                            "command": {
                                "type": "string",
                                "description": "The CLI command to execute"
                            }
                        },
                        "required": ["session_id", "command"]
                    }),
                },
                McpTool {
                    name: "get_terminal_output".to_string(),
                    description: "Get recent terminal output from a session".to_string(),
                    input_schema: json!({
                        "type": "object",
                        "properties": {
                            "session_id": {
                                "type": "string",
                                "description": "The session ID to read output from"
                            },
                            "lines": {
                                "type": "integer",
                                "description": "Number of recent lines to return (default: 50)"
                            }
                        },
                        "required": ["session_id"]
                    }),
                },
                McpTool {
                    name: "get_device_info".to_string(),
                    description: "Get detected device information for a session".to_string(),
                    input_schema: json!({
                        "type": "object",
                        "properties": {
                            "session_id": {
                                "type": "string",
                                "description": "The session ID to get device info for"
                            }
                        },
                        "required": ["session_id"]
                    }),
                },
                McpTool {
                    name: "configure_interface".to_string(),
                    description: "Helper to generate interface configuration commands for Aruba switches".to_string(),
                    input_schema: json!({
                        "type": "object",
                        "properties": {
                            "interface": {
                                "type": "string",
                                "description": "Interface name (e.g., '1/1/1')"
                            },
                            "vlan": {
                                "type": "integer",
                                "description": "VLAN ID to assign"
                            },
                            "description": {
                                "type": "string",
                                "description": "Interface description"
                            },
                            "shutdown": {
                                "type": "boolean",
                                "description": "Whether to shut down the interface"
                            }
                        },
                        "required": ["interface"]
                    }),
                },
            ],
        }
    }

    pub fn call_tool(&self, request: McpToolCallRequest) -> McpToolCallResponse {
        match request.name.as_str() {
            "send_command" => {
                let session_id = request.arguments["session_id"].as_str().unwrap_or("");
                let command = request.arguments["command"].as_str().unwrap_or("");
                McpToolCallResponse {
                    content: vec![McpContentItem {
                        content_type: "text".to_string(),
                        text: format!(
                            "Command '{}' queued for session '{}'. Use get_terminal_output to retrieve results.",
                            command, session_id
                        ),
                    }],
                    is_error: None,
                }
            }
            "get_terminal_output" => {
                let session_id = request.arguments["session_id"].as_str().unwrap_or("");
                let lines = request.arguments["lines"].as_u64().unwrap_or(50) as usize;
                let buffer = self.state.get_buffer(session_id);
                let output = match buffer {
                    Some(buf) => {
                        let all_lines: Vec<&str> = buf.lines().collect();
                        let start = all_lines.len().saturating_sub(lines);
                        all_lines[start..].join("\n")
                    }
                    None => format!("No buffer found for session '{}'", session_id),
                };
                McpToolCallResponse {
                    content: vec![McpContentItem {
                        content_type: "text".to_string(),
                        text: output,
                    }],
                    is_error: None,
                }
            }
            "get_device_info" => {
                let session_id = request.arguments["session_id"].as_str().unwrap_or("");
                let info = self.state.get_device_info(session_id);
                let text = match info {
                    Some(i) => serde_json::to_string_pretty(i).unwrap_or_else(|_| "{}".to_string()),
                    None => format!("No device info for session '{}'", session_id),
                };
                McpToolCallResponse {
                    content: vec![McpContentItem {
                        content_type: "text".to_string(),
                        text,
                    }],
                    is_error: None,
                }
            }
            "configure_interface" => {
                let interface = request.arguments["interface"].as_str().unwrap_or("");
                let vlan = request.arguments["vlan"].as_u64();
                let desc = request.arguments["description"].as_str();
                let shutdown = request.arguments["shutdown"].as_bool();

                let mut commands = vec![format!("interface {}", interface)];
                if let Some(v) = vlan {
                    commands.push(format!("vlan access {}", v));
                }
                if let Some(d) = desc {
                    commands.push(format!("description {}", d));
                }
                if let Some(true) = shutdown {
                    commands.push("shutdown".to_string());
                } else {
                    commands.push("no shutdown".to_string());
                }
                commands.push("exit".to_string());

                McpToolCallResponse {
                    content: vec![McpContentItem {
                        content_type: "text".to_string(),
                        text: commands.join("\n"),
                    }],
                    is_error: None,
                }
            }
            _ => McpToolCallResponse {
                content: vec![McpContentItem {
                    content_type: "text".to_string(),
                    text: format!("Unknown tool: {}", request.name),
                }],
                is_error: Some(true),
            },
        }
    }

    pub fn list_resources(&self) -> McpResourceListResponse {
        let mut resources = vec![];
        for session_id in self.state.list_sessions() {
            resources.push(McpResource {
                uri: format!("terminal://{}/buffer", session_id),
                name: format!("Terminal Buffer - {}", session_id),
                mime_type: "text/plain".to_string(),
            });
            resources.push(McpResource {
                uri: format!("terminal://{}/config", session_id),
                name: format!("Running Config - {}", session_id),
                mime_type: "text/plain".to_string(),
            });
        }
        McpResourceListResponse { resources }
    }

    pub fn read_resource(&self, request: McpResourceReadRequest) -> McpResourceReadResponse {
        let uri = request.uri;
        let parts: Vec<&str> = uri.strip_prefix("terminal://").unwrap_or("").split('/').collect();
        let session_id = parts.first().unwrap_or(&"").to_string();
        let resource_type = parts.get(1).unwrap_or(&"buffer").to_string();

        let text = if resource_type == "config" {
            format!(
                "! Running configuration for session {}\n! (placeholder - fetch via CLI)",
                session_id
            )
        } else {
            match self.state.get_buffer(&session_id) {
                Some(buf) => buf.clone(),
                None => format!("! No buffer for session {}", session_id),
            }
        };

        McpResourceReadResponse {
            contents: vec![McpResourceContent {
                uri: uri.clone(),
                mime_type: "text/plain".to_string(),
                text,
            }],
        }
    }

    pub fn get_state_mut(&mut self) -> &mut TerminalSessionState {
        &mut self.state
    }

    pub fn get_state(&self) -> &TerminalSessionState {
        &self.state
    }
}

impl Default for McpServer {
    fn default() -> Self {
        Self::new()
    }
}
