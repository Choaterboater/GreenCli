# HPE Network Terminal

One cockpit for **HPE Networking — Aruba · Juniper · Mist**. A modern, cross-platform terminal, SSH client, config editor, REST API explorer, and AI assistant built as a SecureCRT/Termius replacement, with multi-vendor syntax highlighting for network engineers.

> 📘 **New here? See the [Setup & Configuration Guide](docs/SETUP.md)** — installing,
> running, and configuring every feature (SSH/vault, AI providers, MCP, Aruba Central,
> Juniper Apstra, on-prem REST, network intent, TLS, screenshots).

![HPE Network Terminal — home](docs/screenshots/01-home.png)

## Features

- **SSH, Telnet, Serial & Local PTY** connections (with jump-host / ProxyJump)
- **Aruba** AOS-CX / AOS-S / InstantOS / ArubaOS syntax highlighting
- **Juniper Junos** (EX/QFX/SRX/MX) syntax highlighting
- **Juniper Mist** cloud awareness (API Explorer integration)
- **Auto device detection** - identifies vendor/OS from the prompt
- **Tabbed sessions** with drag-and-drop
- **Session manager** with folders and organization
- **Encrypted credential vault** (AES-256-GCM + Argon2)
- **Real-time syntax highlighting** with ANSI color injection
- **Modern dark/light themes**
- **Keyboard shortcuts** (Ctrl+T connect, Ctrl+W close, Ctrl+F search, Ctrl+, settings)
- **WebGL-accelerated terminal** rendering via xterm.js

## Tech Stack

| Layer | Technology |
|-------|------------|
| Frontend | React 18 + TypeScript + Tailwind CSS |
| Terminal | xterm.js 5.x with WebGL addon |
| Shell | Tauri 1.6 (Rust + WebView) |
| SSH | russh (Rust native SSH library) |
| Telnet | tokio async TCP |
| Serial | tokio-serial |
| Crypto | AES-256-GCM + Argon2 |

## Project Structure

```
aruba-terminal-pro/
├── src/                          # React frontend
│   ├── components/               # UI components
│   │   ├── Terminal.tsx          # xterm.js wrapper
│   │   ├── TerminalTabs.tsx      # Tab bar
│   │   ├── Sidebar.tsx           # Session tree
│   │   ├── StatusBar.tsx         # Connection status
│   │   ├── QuickConnect.tsx      # Quick connect dialog
│   │   ├── SshAuthDialog.tsx     # SSH authentication
│   │   ├── SettingsPanel.tsx     # Settings UI
│   │   └── SearchOverlay.tsx     # Terminal search
│   ├── syntax/                   # Syntax highlighting engine
│   │   ├── highlighter.ts        # Core highlighting engine
│   │   ├── grammar-aruba-cx.ts   # Aruba CX grammar (80 commands, 84 subcommands)
│   │   ├── grammar-aruba-ap.ts   # Aruba AP grammar (51 commands, 77 subcommands)
│   │   ├── grammar-aruba-ctrl.ts # Aruba Controller grammar (65 commands, 86 subcommands)
│   │   └── ansi-processor.ts     # ANSI sequence processor
│   ├── hooks/                    # React hooks
│   ├── store/                    # Zustand state stores
│   ├── types/                    # TypeScript types
│   └── styles/                   # Global CSS
├── src-tauri/                    # Rust backend
│   └── src/
│       ├── main.rs               # Tauri commands
│       ├── ssh/                  # SSH client (russh)
│       ├── telnet/               # Telnet client
│       ├── serial/               # Serial port client
│       ├── vault/                # Credential vault (AES-256-GCM)
│       └── session/              # Session manager
├── package.json                  # Node dependencies
├── Cargo.toml                    # Rust dependencies
└── tauri.conf.json               # Tauri configuration
```

## Quick Start

### Prerequisites

- [Node.js](https://nodejs.org/) 18+ and npm
- [Rust](https://rustup.rs/) toolchain
- OS-specific build tools for Tauri: [Tauri Prerequisites](https://tauri.app/v1/guides/getting-started/prerequisites)

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

## Aruba Syntax Highlighting

The syntax highlighter supports **196 commands**, **247 subcommands**, and **95 keywords** across all three Aruba device types. It features:

- **Prompt detection** - Identifies device type from CLI prompt patterns
- **Auto-detection** - Scans terminal buffer to automatically identify connected device type
- **256-color ANSI** - Injects color codes for vibrant terminal display
- **Longest-match-first** - Correctly handles multi-word commands like `no shutdown`
- **Value highlighting** - Colors IP addresses, MAC addresses, VLAN IDs, and interface names

### Supported Device Types

| Device | Grammar Coverage |
|--------|-----------------|
| Aruba CX Switch | 80 commands, 84 subcommands, 38 keywords |
| Aruba Wireless AP | 51 commands, 77 subcommands, 28 keywords |
| Aruba Mobility Controller | 65 commands, 86 subcommands, 29 keywords |

## Security Features

- **AES-256-GCM encryption** for stored credentials
- **Argon2id** password hashing for master password
- **SSH key pair generation** (ED25519)
- Password-protected credential vault with auto-lock

## License

MIT
