# GreenCLI

One desktop app for Aruba, Juniper and Mist: an SSH terminal, a config editor that checks your
changes, safe changes with a rollback timer, and an AI helper that never sees your passwords.
For macOS and Windows. Free and open source.

[![Latest release](https://img.shields.io/github/v/release/Choaterboater/GreenCli?label=release&color=01a982)](https://github.com/Choaterboater/GreenCli/releases/latest)
[![CI](https://github.com/Choaterboater/GreenCli/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/Choaterboater/GreenCli/actions/workflows/ci.yml)

**[Download](https://github.com/Choaterboater/GreenCli/releases/latest)** ·
[Website](https://choaterboater.github.io/GreenCli/) ·
[Guide](docs/SETUP.md)

[![GreenCLI main window: an AOS-CX session, with saved hosts in folders on the left](docs/screenshots/01-main-window.png)](docs/screenshots/01-main-window.png)

## What's new in 2.0

- **Updates itself.** On macOS and Windows, GreenCLI gets new versions from its GitHub releases.
  Each one is checked against its signature, and nothing installs until you click
  **Restart to update**.
- **Keys in the system password store.** AI keys and MCP logins are now kept in macOS Keychain or
  Windows Credential Manager (the Secret Service on Linux), not in files.
- **greencli-mcp.** A read-only MCP server that comes with the app. Casper or Claude Code can read
  your saved devices, configs and intents, with secrets hidden. [More below](#greencli-mcp).
- **Tauri 2.** The app now runs on Tauri 2. Your hosts, settings, vault and logins stay where they
  were, and 2.0 installs over 1.9.

Coming from 1.9 or older? Install 2.0 by hand once. After that it updates itself. Back up your AI
keys first: see the [upgrade notes](CHANGELOG.md#200---2026-10-02).
Every change is in the [CHANGELOG](CHANGELOG.md), also on the site as
[What's new](https://choaterboater.github.io/GreenCli/whats-new/).

## Photos

Click a photo for full size. All of them use made-up demo data: no real devices, addresses or keys.

<table>
  <tr>
    <td width="50%" valign="top">
      <a href="docs/screenshots/02-config-editor.png"><img src="docs/screenshots/02-config-editor.png" width="100%" alt="Config Editor with squiggles and the Problems list"></a><br>
      <b>Config Editor.</b> Risky lines get a squiggle, and the Problems list shows each one. The
      bottom line says where Send goes.
    </td>
    <td width="50%" valign="top">
      <a href="docs/screenshots/03-ai-review-diff.png"><img src="docs/screenshots/03-ai-review-diff.png" width="100%" alt="An AI fix shown as a diff"></a><br>
      <b>AI fix as a diff.</b> Apply it or Discard it. Secrets the AI never saw get their real
      value back.
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <a href="docs/screenshots/05-ai-assistant.png"><img src="docs/screenshots/05-ai-assistant.png" width="100%" alt="AI Assistant next to a terminal"></a><br>
      <b>AI Assistant.</b> It ran a show command. The keys in the output reached it as
      <code>&lt;secret hidden&gt;</code>.
    </td>
    <td width="50%" valign="top">
      <a href="docs/screenshots/06-mcp-approval.png"><img src="docs/screenshots/06-mcp-approval.png" width="100%" alt="The approval box for an MCP tool"></a><br>
      <b>Approval box.</b> An MCP tool that can change things asks you first, with its full
      arguments.
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <a href="docs/screenshots/09-change-jobs.png"><img src="docs/screenshots/09-change-jobs.png" width="100%" alt="Change Jobs dry run"></a><br>
      <b>Change Jobs.</b> One VLAN change for four switches: a dry run first, then a rollback timer
      until you confirm.
    </td>
    <td width="50%" valign="top">
      <a href="docs/screenshots/11-network-intent.png"><img src="docs/screenshots/11-network-intent.png" width="100%" alt="Network Intent checks"></a><br>
      <b>Network Intent.</b> Write down what should be true, then check every device. Here one
      rule fails on two switches.
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <a href="docs/screenshots/07-settings-mcp-servers.png"><img src="docs/screenshots/07-settings-mcp-servers.png" width="100%" alt="Settings, MCP Servers"></a><br>
      <b>MCP Servers.</b> Writes are off until you turn them on. greencli-mcp has Copy buttons, and
      Export makes a file for Casper or Claude Code.
    </td>
    <td width="50%" valign="top">
      <a href="docs/screenshots/10-settings-ai.png"><img src="docs/screenshots/10-settings-ai.png" width="100%" alt="Settings, AI Assistant"></a><br>
      <b>AI settings.</b> Pick the provider and model. The API key is saved in Windows Credential Manager.
    </td>
  </tr>
</table>

The [website](https://choaterboater.github.io/GreenCli/#photos) has more photos, taken again for
every release.

## Features

**Terminal**
- SSH, Telnet, serial and a local shell, in tabs. Split view and pop-out windows.
- Jump hosts (ProxyJump), SSH keys, ssh-agent, and TACACS+ / RADIUS logins.
- Knows the device from its prompt: Aruba AOS-CX, AOS-S, access points and Mobility Controllers,
  and Juniper Junos. Their output shows in color, in your theme's colors.
- Saved hosts in folders. Import them from a CSV file, SecureCRT, Aruba Central, Juniper Mist or
  `~/.ssh/config`.
- SFTP, SSH tunnels (`-L` and SOCKS `-D`), Bulk Runner (one command on many devices), output
  triggers and session logs.

**Config Editor**
- The VS Code editor (Monaco), with templates and snippets for Aruba CX and Junos.
- Risky lines, blanks to fill in and terminal junk get a squiggle. A Problems list, quick fixes,
  and hover cards that say what a line does.
- Compare with the running config you pulled, or with a file. Open a whole folder as a tree.
- Send to the terminal, send only the lines you picked, or send safely as a Change Job.
- Copy with secrets hidden, for a ticket or a chat.

**Safe changes**
- **Change Jobs**: one change for many devices. A dry run, one canary device first, then the
  device's own rollback timer (AOS-CX `checkpoint auto`, Junos `commit confirmed`) until you
  confirm.
- **Network Intent**: write down what should be true and check all your devices, by hand or on a
  schedule.
- **Config archive**: saved running configs. Compare the newest one with your golden config or the
  one before it.

**AI helper**
- Anthropic (Claude), OpenRouter, Moonshot (Kimi), Ollama, a local CLI, or
  [Casper](https://github.com/Choaterboater/casper).
- Passwords, keys and SNMP communities in device output reach the AI as `<secret hidden>`.
- You choose which tools the AI may use: device commands, device REST and MCP tools. The
  Read-only Auditor agent can only read.
- **Ask AI** in the editor: explain, check or fix lines, or convert Aruba CX ↔ Junos.

**MCP and APIs**
- GreenCLI is an MCP client (stdio and HTTP). A tool that can change something asks you first,
  and **Allow writes** is off for each server until you turn it on.
- **Export for Casper / Claude…** saves your servers as a `.mcp.json` file with no secrets in it.
- API Explorer for Aruba Central, on-box REST (AOS-CX, AOS-S, AOS 8) and Juniper Mist.

## Install

Get the latest version from the [Releases page](https://github.com/Choaterboater/GreenCli/releases/latest)
or the [website](https://choaterboater.github.io/GreenCli/#download).

| Your computer | File |
|---------------|------|
| Mac with Apple Silicon (M1 or newer) | `GreenCLI_<version>_aarch64.dmg` |
| Mac with Intel | `GreenCLI_<version>_x64.dmg` |
| Windows | `GreenCLI_<version>_x64-setup.exe` or `GreenCLI_<version>_x64_en-US.msi` (either one works) |

It runs on macOS 13.3 (Ventura) or newer, and on Windows 10 or 11 with Microsoft WebView2 (Windows
11 has it built in). There is no Linux download: you can [build it yourself](#build-from-source).

- **Mac:** open the `.dmg` and drag GreenCLI to Applications. Always open it from there, or it
  can't update itself.
- **First open on a Mac:** if macOS won't open it, go to System Settings → Privacy & Security and
  click **Open Anyway**. A build that Apple has notarized opens with no warning.
- **First open on Windows:** if you see "Windows protected your PC", click **More info**, then
  **Run anyway**.
- **Updates:** Settings → Updates has **Check for updates** and **Check once a day** (on by
  default). On Windows, close Claude Code and Casper before you update.

## Keyboard shortcuts

| Action | Mac | Windows |
|--------|-----|---------|
| Quick Connect | `Cmd+T` | `Ctrl+Shift+T` |
| Command palette | `Cmd+K` | `Ctrl+Shift+P` |
| Find in the terminal | `Cmd+F` | `Ctrl+Shift+F` |
| Close the tab | `Cmd+W` | `Ctrl+Shift+W` |
| Next / previous tab | `Ctrl+Tab` / `Ctrl+Shift+Tab` | `Ctrl+Tab` / `Ctrl+Shift+Tab` |
| Go to tab 1 to 9 | `Cmd+1` … `Cmd+9` | `Alt+1` … `Alt+9` |
| Editor / API / AI panel | `Cmd+Shift+E` / `A` / `I` | `Ctrl+Shift+E` / `A` / `I` |
| Show or hide the sidebar | `Cmd+B` | `Ctrl+B` |
| Settings | `Cmd+,` | `Ctrl+,` |
| Help | `F1` | `F1` |

Inside a session on Windows, plain `Ctrl+T`, `Ctrl+F`, `Ctrl+K` and `Ctrl+W` go to the device, so
GreenCLI uses the `Ctrl+Shift` keys. Linux uses the Windows keys. All of them, with the Config
Editor keys, are in [Help](https://choaterboater.github.io/GreenCli/help/#shortcuts) and in the
[guide](docs/SETUP.md#11-keyboard-shortcuts).

## greencli-mcp

GreenCLI comes with a small read-only MCP server, `greencli-mcp`, so Casper or Claude Code can read
your GreenCLI data. It is next to the app: `GreenCLI.app/Contents/MacOS/greencli-mcp` on a Mac,
`greencli-mcp.exe` in the install folder on Windows. Settings → AI & MCP → MCP Servers shows its
full path, with Copy buttons for the path and the command. On a Mac, move GreenCLI to Applications
first. To add it to Claude Code:

```bash
claude mcp add greencli -- "/Applications/GreenCLI.app/Contents/MacOS/greencli-mcp"
```

**Export for Casper / Claude…** adds it to the `.mcp.json` file too.

It has six read tools: `access_check`, `list_devices`, `list_config_history`, `get_config`,
`get_config_diff` and `list_intents`.

- It only reads GreenCLI's data folder. It never writes a file, opens a network connection or
  starts a program (a test checks the source for this).
- The device list has no passwords, user names, notes or startup commands.
- Configs and diffs come only from copies with secrets hidden, saved when a config is captured. A
  snapshot with no up-to-date hidden copy is refused, never served raw. For older snapshots, open
  Config archive and click **Make hidden copies**.
- A diff can't show a changed secret: both sides show it hidden.

More in the guide: [greencli-mcp](docs/SETUP.md#greencli-mcp-greencli-data-for-casper-or-claude-code).

## Build from source

You need:

- [Node.js](https://nodejs.org/) 22 (or 20.19 and newer) and npm.
- [Rust](https://rustup.rs/) 1.90 or newer.
- The Tauri 2 build tools for your system: see [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/).
  On a Mac that is the Xcode Command Line Tools. On Windows, the Microsoft C++ Build Tools and
  WebView2. On Linux (Ubuntu 24.04 or newer):

  ```bash
  sudo apt install build-essential libwebkit2gtk-4.1-dev libgtk-3-dev librsvg2-dev libudev-dev \
    libdbus-1-dev pkg-config
  ```

Then, in the repo folder:

```bash
npm install            # also installs the Tauri command line tool
npm run tauri-dev      # run the app (the first run takes a few minutes)
npm run tauri-build    # make the app and installer for this computer
```

The installers land in `src-tauri/target/release/bundle/`. Build on the system you want the app
for. Release builds for macOS and Windows come from GitHub Actions
(`.github/workflows/release.yml`); the guide's
[Releasing](docs/SETUP.md#releasing) part has the steps.

Checks (the same ones CI runs):

```bash
npx tsc --noEmit       # types
npm run lint           # lint
npm test               # unit tests
npm run smoke          # build, then open the built app in Chromium
npm run build && cd src-tauri && cargo test --workspace   # Rust tests
```

`npm run smoke` and the photos need Chromium for Playwright: run `npx playwright install chromium`
once. New photos: `npm run build`, then `npm run screenshots`. The website: `npm run site:preview`
builds it and serves it at http://127.0.0.1:4173/. See [Screenshots](docs/SETUP.md#14-screenshots).

**What's in the repo**

| Folder | What it holds |
|--------|---------------|
| [`src/`](src) | The app's screens: React 18, TypeScript, Tailwind CSS, xterm.js and Monaco |
| [`src-tauri/`](src-tauri) | The Rust side on Tauri 2: SSH (russh), Telnet, serial, SFTP, the vault, AI, MCP and updates |
| [`src-tauri/greencli-mcp/`](src-tauri/greencli-mcp) | The read-only greencli-mcp server |
| [`e2e/`](e2e) | Playwright tests |
| [`scripts/`](scripts) | Photos, website, smoke test and release helpers |
| [`site/`](site) | The website's pages and style |
| [`docs/`](docs) | The guide and the photos |

## Docs

- **[Guide](https://choaterboater.github.io/GreenCli/guide/)**: install, set up and use every part
  of GreenCLI. It is [docs/SETUP.md](docs/SETUP.md) on the website.
- **[Help topics](https://choaterboater.github.io/GreenCli/help/)**: the same help as `F1` in the
  app, with the keys for Mac or Windows.
- **[What's new](https://choaterboater.github.io/GreenCli/whats-new/)**: every change, version by
  version. It is [CHANGELOG.md](CHANGELOG.md) on the website.
- [ROADMAP.md](ROADMAP.md): the work log.

## Security

- **SSH passwords** are in an encrypted vault: AES-256-GCM, with a key made from your master
  password by Argon2id. The vault file is owner-only.
- **AI keys and MCP logins** are in the system password store. An MCP login is on disk only while
  its server runs, in an owner-only file.
- **Device secrets are hidden from the AI**: passwords, keys, SNMP communities and private keys in
  tool output reach it as `<secret hidden>`.
- **SSH host keys** are pinned the first time you connect. A changed key is refused, and a new key
  type from a known host gets a warning.
- **Device REST checks TLS certificates** by default. Turn it off only for lab gear with
  self-signed certificates.
- **Updates** come only from GreenCLI's GitHub releases, and each one is checked against its
  signature before it can install.
- **greencli-mcp** is read-only and shows configs only with secrets hidden.
- SSH passwords and keys are wiped from memory when they are no longer needed.
- Nothing is sent home: no tracking. GreenCLI talks only to the devices, services and AI providers
  you set up, and to GitHub for updates.

More in the guide: [Security notes](docs/SETUP.md#12-security-notes).

## License

MIT. See [LICENSE](LICENSE). Licenses of the parts GreenCLI uses are in
[THIRD_PARTY_NOTICES.txt](THIRD_PARTY_NOTICES.txt), which also ships with the app.

GreenCLI by ChoateLabs.
