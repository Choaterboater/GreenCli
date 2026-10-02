# GreenCLI

One cockpit for **Aruba · Juniper · Mist**. A modern, cross-platform terminal, SSH client, config editor, REST API explorer, and AI assistant built as a SecureCRT/Termius replacement, with multi-vendor syntax highlighting for network engineers.

> 📘 **New here? See the [Setup & Configuration Guide](docs/SETUP.md)** — installing,
> running, and configuring every feature (SSH/vault, AI providers, MCP, Aruba Central,
> on-prem REST, network intent, TLS, screenshots).

![GreenCLI — home](docs/screenshots/01-home.png)

## Features

- **SSH, Telnet, Serial & Local PTY** connections (with jump-host / ProxyJump)
- **Aruba** AOS-CX / AOS-S / InstantOS / ArubaOS syntax highlighting
- **Juniper Junos** (EX/QFX/SRX/MX) syntax highlighting
- **Juniper Mist** cloud awareness (API Explorer integration)
- **Auto device detection** - identifies vendor/OS from the prompt
- **Tabbed sessions**
- **Session manager** with folders and organization
- **Encrypted credential vault** (AES-256-GCM + Argon2)
- **Real-time syntax highlighting** with ANSI color injection
- **Modern dark/light themes**
- **Keyboard shortcuts** (Ctrl+T connect, Ctrl+W close, Ctrl+F search, Ctrl+, settings)
- **Fast terminal rendering** via xterm.js
- **Automatic updates** on macOS and Windows, from GitHub releases, checked against their signature before they install
- **AI keys and MCP logins in the system password store** (macOS Keychain, Windows Credential Manager, Linux Secret Service)
- **greencli-mcp**, a read-only MCP server so Casper or Claude Code can read your devices, configs (secrets hidden) and intents

## Tech Stack

| Layer | Technology |
|-------|------------|
| Frontend | React 18 + TypeScript + Tailwind CSS |
| Terminal | xterm.js 5.x |
| Shell | Tauri 2 (Rust + WebView) |
| SSH | russh 0.63 (Rust native SSH library) |
| Telnet | tokio async TCP |
| Serial | tokio-serial |
| Crypto | AES-256-GCM + Argon2 |

## Project Structure

```
green-cli/
├── src/                          # React frontend
│   ├── App.tsx                   # Root component / view routing
│   ├── PopOutTerminal.tsx        # Pop-out terminal window entry
│   ├── main.tsx                  # React entry point
│   ├── components/               # UI components
│   │   ├── Terminal.tsx          # xterm.js wrapper
│   │   ├── TerminalTabs.tsx      # Tab bar
│   │   ├── Sidebar.tsx           # Session tree
│   │   ├── StatusBar.tsx         # Connection status
│   │   ├── QuickConnect.tsx      # Quick connect dialog
│   │   ├── SshAuthDialog.tsx     # SSH authentication
│   │   ├── SettingsPanel.tsx     # Settings UI
│   │   ├── SearchOverlay.tsx     # Terminal search
│   │   ├── AiAssistant.tsx       # AI assistant panel
│   │   ├── ApiExplorer.tsx       # REST API explorer (Central / device / Mist)
│   │   ├── BulkRunner.tsx        # Run one command across sessions
│   │   ├── ConfigEditor.tsx      # Monaco config editor
│   │   ├── HelpPanel.tsx         # In-app help (F1)
│   │   ├── IntentPanel.tsx       # Network intent / desired state
│   │   ├── McpServers.tsx        # MCP server manager
│   │   ├── SftpBrowser.tsx       # SFTP file browser
│   │   ├── TunnelsManager.tsx    # SSH local/dynamic forwards
│   │   └── …                     # Command palette, vault, triggers, dialogs, toaster
│   ├── syntax/                   # Syntax highlighting engine
│   │   ├── highlighter.ts        # Core highlighting engine
│   │   ├── grammar-aruba-cx.ts   # Aruba CX grammar (100 commands, 120 subcommands)
│   │   ├── grammar-aruba-ap.ts   # Aruba AP grammar (56 commands, 88 subcommands)
│   │   ├── grammar-aruba-ctrl.ts # Aruba Controller grammar (76 commands, 80 subcommands)
│   │   ├── grammar-junos.ts      # Juniper Junos grammar
│   │   └── ansi-processor.ts     # ANSI sequence processor
│   ├── data/                     # Static content (help topics, intent packs)
│   ├── hooks/                    # React hooks
│   ├── store/                    # Zustand state stores
│   ├── types/                    # TypeScript types
│   ├── styles/                   # Global CSS
│   └── utils/                    # Shared helpers (clipboard, backup, vault, intent, terminal)
├── e2e/                          # Playwright end-to-end tests (npm run test:e2e)
├── scripts/                      # Utility scripts (screenshot capture)
├── src-tauri/                    # Rust backend
│   ├── Cargo.toml                # Rust dependencies (and the workspace)
│   ├── tauri.conf.json           # Tauri configuration
│   ├── capabilities/             # What the app window may call (Tauri 2)
│   ├── greencli-mcp/             # Read-only MCP server crate
│   └── src/
│       ├── main.rs               # Tauri commands
│       ├── ssh/                  # SSH client (russh)
│       ├── telnet/               # Telnet client
│       ├── serial/               # Serial port client
│       ├── sftp/                 # SFTP file transfer
│       ├── vault/                # Credential vault (AES-256-GCM)
│       ├── session/              # Session manager
│       ├── ai/                   # AI provider backends
│       ├── api/                  # On-box REST (AOS-CX/AOS-8/AOS-S)
│       ├── central/              # Aruba Central client
│       ├── intent/               # Network intent engine
│       ├── local/                # Local PTY
│       ├── mcp/                  # MCP client (stdio + streamable HTTP)
│       ├── secret_store.rs       # AI keys + MCP logins in the system password store
│       ├── updater.rs            # Automatic updates from GitHub releases
│       └── bin/greencli-mcp.rs   # The greencli-mcp binary that ships next to the app
├── package.json                  # Node dependencies
└── playwright.config.ts          # Playwright configuration
```

## Quick Start

### Runs on

- **macOS 13.3 (Ventura) or newer.** Older macOS versions lack features the app needs to hide device secrets from the AI.
- **Windows 10/11** with the WebView2 runtime.
- **Linux** with WebKitGTK 4.1 (Ubuntu 24.04 or newer). On an old WebKitGTK, the AI panel withholds device output instead of sending it unchecked. There is no Linux release build, so no automatic updates there.

### Prerequisites

- [Node.js](https://nodejs.org/) 18+ and npm
- [Rust](https://rustup.rs/) stable toolchain, 1.90+ (MSRV)
- OS-specific build tools for Tauri 2: [Tauri Prerequisites](https://v2.tauri.app/start/prerequisites/). On Linux: `libwebkit2gtk-4.1-dev libgtk-3-dev librsvg2-dev libudev-dev libdbus-1-dev pkg-config` (see [docs/SETUP.md](docs/SETUP.md)).

### Install Dependencies

```bash
# Install Node dependencies
npm install

# Install Tauri CLI (if not already installed)
npm install -g @tauri-apps/cli
```

### Development Mode

```bash
# Start the dev server (Vite + Tauri)
npm run tauri-dev
```

### Build for Production

```bash
# Build the application
npm run tauri-build
```

The built application will be in `src-tauri/target/release/`.

### Cross-Platform Builds

```bash
# macOS (Universal binary)
npm run tauri-build -- --target universal-apple-darwin

# Windows (from Linux/macOS with cross-compilation)
npm run tauri-build -- --target x86_64-pc-windows-msvc

# Linux
npm run tauri-build -- --target x86_64-unknown-linux-gnu
```

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl+T` | Quick Connect |
| `Ctrl+W` | Close Active Tab |
| `Ctrl+F` | Search Terminal |
| `Ctrl+,` | Open Settings |
| `F1` | Help & documentation (in-app) |
| `Ctrl+B` | Toggle Sidebar |
| `Ctrl+K` | Command Palette |
| `Ctrl+1`–`Ctrl+9` | Jump to tab N |
| `Ctrl+Tab` | Cycle to next tab |
| `Ctrl+Shift+A` | Toggle API Explorer |
| `Ctrl+Shift+I` | Toggle AI Assistant |
| `Ctrl+Shift+E` | Toggle Config Editor |
| `Ctrl+=` / `Ctrl+-` | Zoom terminal font in / out |
| `Ctrl+0` | Reset terminal font size |

(On macOS use `Cmd` instead of `Ctrl`.)

## Aruba Syntax Highlighting

The syntax highlighter supports **232 commands**, **288 subcommands**, and **144 keywords** across all three Aruba device types. It features:

- **Prompt detection** - Identifies device type from CLI prompt patterns
- **Auto-detection** - Scans terminal buffer to automatically identify connected device type
- **Theme colors** - Uses the terminal theme's own colors, so highlighting follows light/dark and any color scheme, and re-colors when you switch
- **Comment lines** - `!` lines (Aruba) and `#` / `/* */` lines (Junos) show dimmed
- **Longest-match-first** - Correctly handles multi-word commands like `no shutdown`
- **Value highlighting** - Colors IP addresses, MAC addresses, VLAN IDs, and interface names

### Supported Device Types

| Device | Grammar Coverage |
|--------|-----------------|
| Aruba CX Switch | 100 commands, 120 subcommands, 59 keywords |
| Aruba Wireless AP | 56 commands, 88 subcommands, 44 keywords |
| Aruba Mobility Controller | 76 commands, 80 subcommands, 41 keywords |

## greencli-mcp: GreenCLI data for Casper or Claude Code

GreenCLI ships a small read-only MCP server, `greencli-mcp`, next to the app
(`GreenCLI.app/Contents/MacOS/greencli-mcp` on macOS, `greencli-mcp.exe` in the
install folder on Windows). Settings → AI & MCP → MCP Servers shows its full path,
with Copy buttons for the path and the command. On a Mac, move GreenCLI to
Applications first. To add it to Claude Code:

```bash
claude mcp add --scope user greencli -- "/Applications/GreenCLI.app/Contents/MacOS/greencli-mcp"
```

`--scope user` makes it available in every folder; without it Claude Code only
adds it for the folder you run the command in.

"Export for Casper / Claude…" puts it in the `.mcp.json` file too.

It has seven read tools: `access_check`, `list_devices`, `list_archive_devices`,
`list_config_history`, `get_config`, `get_config_diff` and `list_intents`.
`list_archive_devices` finds config history kept under a device's old name, after
a rename or delete in GreenCLI.

- It only reads GreenCLI's data folder. It never writes a file, opens a network
  connection or starts a program (a source-scan test checks this).
- The device list has no passwords, user names, notes or startup commands.
- Configs and diffs come only from copies made with secrets hidden, saved when a
  config is captured. A snapshot without a current hidden copy is refused, never
  served raw. In Config archive, **Make hidden copies** makes them for older
  snapshots.
- A diff can't show a changed secret: both sides show it hidden.

See [docs/SETUP.md](docs/SETUP.md) §6 for the full details.

## Automatic updates

On macOS and Windows, GreenCLI updates itself from its GitHub releases. Settings →
Updates has **Check for updates** and **Check once a day** (on by default). An
update is downloaded and checked against its signature first, and nothing installs
until you tap **Restart to update**. Each release build signs its own files, so
there is no signing key to keep. 1.9 and older have no updater: install 2.0 by
hand once. See [docs/SETUP.md](docs/SETUP.md) §2 for releasing and for what the
signature does and doesn't protect against.

## Security Features

- **AES-256-GCM encryption** for stored credentials
- **AI keys and MCP logins in the system password store**; an MCP login is on disk only while its server runs
- **Signed updates**, checked before they install, from GreenCLI's GitHub releases only
- **Argon2id** password hashing for master password
- Password-protected credential vault
- **Device REST TLS verification on by default** (opt out only for self-signed lab gear)
- **TOFU SSH host-key pinning**, with a warning when a known host offers an unseen host-key algorithm
- **Device secrets hidden from the AI**: passwords, keys, SNMP communities and private keys in tool output reach the model as `<secret hidden>`
- SSH private keys held in zeroized memory (wiped on drop)

## License

MIT
