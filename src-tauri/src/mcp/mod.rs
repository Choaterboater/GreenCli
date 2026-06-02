pub mod client;
pub mod server;

pub use client::{McpClient, McpManager, McpServerDef};
pub use server::{McpInitializeRequest, McpResourceReadRequest, McpServer, McpToolCallRequest};
