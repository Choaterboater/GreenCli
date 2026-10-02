// The greencli-mcp binary, shipped next to GreenCLI. All the code is in the
// greencli-mcp crate; this file only makes a binary of it so the app bundle
// carries it. It keeps the console subsystem: MCP talks over stdin/stdout.
fn main() {
    std::process::exit(greencli_mcp::run())
}
