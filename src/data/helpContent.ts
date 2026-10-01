// In-app help content. Kept in sync with docs/SETUP.md but structured so the Help
// panel can search, filter, and render it — and offer per-topic quick actions.

import {
  Rocket,
  PlugZap,
  Lock,
  Bot,
  Server,
  Cloud,
  ShieldCheck,
  Target,
  Waypoints,
  Keyboard,
  LifeBuoy,
  TerminalSquare,
  Download,
  KeyRound,
  type LucideIcon,
} from 'lucide-react';
import { isMac, platform, shortcutLabel, type ShortcutId } from '../utils/shortcuts';

// Help text names the chords for THIS OS (⌘ on macOS, Ctrl / Ctrl+Shift on
// Windows and Linux) — the owner switches between both.
const k = (id: ShortcutId) => `\`${shortcutLabel(id)}\``;
const MOD = isMac ? '⌘' : 'Ctrl';

const COPY_PASTE =
  platform === 'mac'
    ? '**Copy / paste**: select text, then `⌘C`; paste with `⌘V`. `Ctrl+C` always goes to the device (interrupt).'
    : platform === 'windows'
      ? '**Copy / paste**: select text, then `Ctrl+C` (or `Ctrl+Shift+C` / `Ctrl+Insert`) — with nothing selected, `Ctrl+C` interrupts as usual. Paste with `Ctrl+V`, `Ctrl+Shift+V` or `Shift+Insert`.'
      : '**Copy / paste**: select text, then `Ctrl+Shift+C` (`Ctrl+C` also copies while text is selected). Paste with `Ctrl+Shift+V` or `Shift+Insert` — plain `Ctrl+V` stays the shell\'s.';

/** Quick-action a topic can offer — resolved to a store action by the Help panel. */
export type HelpActionId =
  | 'open-settings'
  | 'open-quick-connect'
  | 'open-ai'
  | 'open-api'
  | 'open-intent'
  | 'open-tunnels'
  | 'open-import';

export interface HelpBlock {
  kind: 'p' | 'steps' | 'bullets' | 'code' | 'note';
  /** for p / code / note */
  text?: string;
  /** for steps / bullets */
  items?: string[];
}

export interface HelpTopic {
  id: string;
  title: string;
  icon: LucideIcon;
  summary: string;
  keywords: string[];
  blocks: HelpBlock[];
  /** Optional quick action. `focus` (with id 'open-settings') deep-links to a
   *  Settings section anchor (`set-<focus>`) and flashes it. */
  action?: { label: string; id: HelpActionId; focus?: string };
}

export const HELP_TOPICS: HelpTopic[] = [
  {
    id: 'getting-started',
    title: 'Getting started',
    icon: Rocket,
    summary: 'What this app is and the first thing to do.',
    keywords: ['intro', 'overview', 'start', 'welcome', 'first'],
    blocks: [
      {
        kind: 'p',
        text: 'One cockpit for **Aruba · Juniper · Mist**: a terminal/SSH client, config editor, REST API explorer, an MCP-powered AI assistant, and a network-intent (desired-state) layer.',
      },
      {
        kind: 'steps',
        items: [
          `Press ${k('quickConnect')} (or click **Quick Connect**) to open a connection.`,
          'Pick a protocol (SSH / Telnet / Serial / Local) and enter the host.',
          'Optionally check **Save to sidebar** to keep the session (never the password).',
        ],
      },
      { kind: 'note', text: 'All secrets live in owner-only files outside the browser — nothing sensitive is stored in plaintext.' },
    ],
    action: { label: 'Open Quick Connect', id: 'open-quick-connect' },
  },
  {
    id: 'connecting',
    title: 'Connecting to devices',
    icon: PlugZap,
    summary: 'SSH/Telnet/Serial/Local, auth methods, jump host, startup commands.',
    keywords: ['ssh', 'telnet', 'serial', 'local', 'jump', 'proxyjump', 'bastion', 'agent', 'key', 'password', 'connect', 'duplicate', 'second session', 'new session'],
    blocks: [
      { kind: 'p', text: `Open **Quick Connect** (${k('quickConnect')}) or double-click a saved host in the sidebar.` },
      {
        kind: 'p',
        text: `Double-clicking a host that already has a tab brings that tab back. For **another session** to the same device, ${isMac ? '`⇧`-double-click' : '`Shift`+double-click'} it, right-click it → **Open new session**, or right-click its tab → **Duplicate tab**. Extra tabs are numbered: \`core-sw-01 (2)\`.`,
      },
      {
        kind: 'bullets',
        items: [
          '**SSH auth**: password, private key (Browse… to load a key file), or **ssh-agent**.',
          'If `password` auth is refused it falls back to **keyboard-interactive** (TACACS+/RADIUS); only the first prompt gets the password, so an OTP prompt is left for you.',
          '**Jump host / ProxyJump**: set a bastion and how to log in to it — a password (kept in the vault for saved hosts), a shared login, or your key / agent. Bastions that ask for a one-time code (MFA) are not supported yet.',
          '**Startup commands**: per-host commands run automatically once the shell is ready (e.g. `terminal length 0`).',
        ],
      },
    ],
    action: { label: 'Open Quick Connect', id: 'open-quick-connect' },
  },
  {
    id: 'import',
    title: 'Importing hosts',
    icon: Download,
    summary: 'Bring saved hosts in from a CSV file, SecureCRT, Aruba Central, Juniper Mist or ~/.ssh/config.',
    keywords: ['import', 'csv', 'securecrt', 'migrate', 'central', 'mist', 'inventory', 'ssh config', 'bulk', 'sessions', 'folders'],
    blocks: [
      { kind: 'p', text: 'Open **Import hosts** from the activity bar on the left, the sidebar (download icon), the command palette, or Settings → Connections & Security. Every source shows a preview first: hosts you already have (same host, port and user) are greyed out, and nothing is saved until you press **Import**.' },
      {
        kind: 'bullets',
        items: [
          '**CSV**: columns `name, host, port, user, type, folder, tags, jump` (only `host` is required; tags separated by `;`). **Download template CSV** gives you a starting file.',
          '**SecureCRT**: choose the **Sessions** folder — macOS `~/Library/Application Support/VanDyke/SecureCRT/Config/Sessions`, Windows `%APPDATA%\\VanDyke\\Config\\Sessions`. SSH, Telnet and Serial sessions come across with their folders. An XML export (File ▸ Export Settings) works too.',
          '**Aruba Central** / **Juniper Mist**: loads devices with an IP address from the account set up in Settings → Integrations; the site becomes the folder.',
          '**Folders**: keep the source folders, or put everything in one folder. Existing folders with the same name are reused.',
        ],
      },
      { kind: 'note', text: 'Passwords are never imported. SecureCRT firewall / jump settings aren\'t either — add a jump host with **Edit…** after importing.' },
    ],
    action: { label: 'Import hosts', id: 'open-import' },
  },
  {
    id: 'vault',
    title: 'Credential vault',
    icon: Lock,
    summary: 'Encrypted store for SSH passwords (AES-256-GCM + Argon2).',
    keywords: ['vault', 'password', 'master', 'encrypt', 'argon2', 'aes', 'credentials', 'secret'],
    blocks: [
      { kind: 'p', text: 'Unlock the vault with a master password; saved SSH passwords are encrypted (AES-256-GCM, Argon2id key) and offered automatically on the next connect.' },
      { kind: 'p', text: 'Aruba Central / Mist **secrets** are also stored in the vault (encrypted) once it is unlocked, so they survive a restart. While the vault is locked they live in memory for the session only.' },
      { kind: 'note', text: 'A corrupt/incompatible `vault.enc` is never auto-overwritten — it errors and is preserved so nothing is silently lost.' },
    ],
  },
  {
    id: 'logins',
    title: 'Shared logins',
    icon: KeyRound,
    summary: 'One TACACS/RADIUS password for many devices — change it once.',
    keywords: ['login', 'tacacs', 'radius', 'credential', 'profile', 'password', 'rotation', 'folder', 'shared'],
    blocks: [
      { kind: 'p', text: 'Create a **shared login** (name, username, password) in **Settings → Connections & Security → Shared Logins**. Make it a folder\'s default (right-click the folder → **Default login…**) or pick it for one host in **Edit…**.' },
      {
        kind: 'bullets',
        items: [
          'A host uses its own login if it has one, else its folder\'s. **Per-host password** keeps a host on its own saved password.',
          'The login\'s username is used when the host has none of its own.',
          'When the password rotates, change it once in Settings — or, when a device rejects it, choose **Update this login\'s password** in the password dialog.',
        ],
      },
      { kind: 'note', text: 'Only the name and username are stored in settings; the password is kept in the encrypted vault.' },
    ],
    action: { label: 'Manage logins', id: 'open-settings', focus: 'logins' },
  },
  {
    id: 'ai',
    title: 'AI assistant',
    icon: Bot,
    summary: 'Provider-neutral assistant (Anthropic, OpenRouter, Moonshot, Ollama, Local CLI).',
    keywords: ['ai', 'assistant', 'claude', 'anthropic', 'openrouter', 'moonshot', 'kimi', 'ollama', 'llm', 'model', 'api key', 'tools', 'secrets', 'hidden', 'redact'],
    blocks: [
      { kind: 'p', text: 'Settings → **AI Assistant**. The assistant works with any provider — keys are stored owner-only outside the webview, never in the browser.' },
      {
        kind: 'steps',
        items: [
          'Pick a **provider** (Anthropic / OpenRouter / Moonshot need a key; Ollama is local; Local CLI shells out to an installed agent).',
          'Enter the **API key** and choose a **model**.',
          'Enable the opt-in **Assistant tools** you want (run CLI commands, device REST, MCP tools, evaluate intents).',
        ],
      },
      { kind: 'note', text: 'Responses stream token-by-token; **Stop** actually aborts the provider request, not just the UI.' },
      {
        kind: 'note',
        text: 'Device secrets (passwords, keys, SNMP communities, private keys) are hidden before the AI sees any tool output: they show as `<secret hidden>`, and the tool row shows how many were hidden. The AI can’t send the marker back to a device. Text you type into the chat is sent as you typed it.',
      },
    ],
    action: { label: 'Set up AI provider', id: 'open-settings', focus: 'ai' },
  },
  {
    id: 'agents',
    title: 'AI agents (per-session)',
    icon: Bot,
    summary: 'Attach a saved persona — instructions + provider/model — to a session.',
    keywords: ['agent', 'agents', 'persona', 'per session', 'read only', 'auditor', 'instructions', 'system prompt', 'model', 'sidebar'],
    blocks: [
      { kind: 'p', text: 'An **agent** is a saved persona: custom instructions plus an optional provider/model override. Attach one to a session and the AI assistant uses it whenever that session is active.' },
      {
        kind: 'steps',
        items: [
          'Settings → **AI Agents** → **New agent**: name it, write instructions, and (optionally) pick a provider + model.',
          'In the **sidebar**, right-click a host → **AI Agent…** and choose the agent (or pick the chip under the host).',
          'Open the AI assistant on that session — the bar above the chat shows the active agent, and the instructions/model are applied.',
        ],
      },
      { kind: 'bullets', items: [
        'Starter agents ship ready: **Read-only Auditor** (never runs config), **Junos Expert**, **Aruba CX Expert**.',
        'Provider/model are optional — leave on **Default** to inherit the global AI settings.',
      ] },
      { kind: 'note', text: 'The agent’s instructions are appended to the system prompt for that session only — different tabs can run different agents.' },
    ],
    action: { label: 'Manage AI agents', id: 'open-settings', focus: 'agents' },
  },
  {
    id: 'mcp',
    title: 'MCP servers',
    icon: Server,
    summary: 'Connect external MCP servers and expose their tools to the AI.',
    keywords: ['mcp', 'tools', 'centralmcp', 'stdio', 'http', 'streamable', 'server', 'context protocol'],
    blocks: [
      { kind: 'p', text: 'The app is an **MCP client**: it connects to external MCP servers — stdio (launches a command) or Streamable HTTP (points at one already running) — and exposes their tools to the AI for every provider.' },
      {
        kind: 'steps',
        items: [
          'Settings → **AI & MCP → MCP Servers** (or **MCP Servers** in the command palette) → Add server.',
          'Click **Paste config JSON instead** to auto-fill from a setup wizard snippet, or fill in by hand.',
          'Stdio: set the **command**, **args** (one per line), and any **env**. HTTP: set the **server URL**.',
          'Stdio only — for secrets, set a **credentials env var** + paste the content — it is written to a 0600 file and injected via that env var.',
          'Click **Connect**; the tool count appears in the AI panel.',
        ],
      },
      { kind: 'note', text: 'Example: the centralmcp server (Aruba Central / GLP / monitoring / NAC / ops / RAG) routes hundreds of backend tools through a compact set exposed to the AI. Tool names are namespaced `mcp__<server>__<tool>`. Supports stdio (launch command) or Streamable HTTP (point at a URL).' },
    ],
    action: { label: 'Open MCP settings', id: 'open-settings', focus: 'mcp' },
  },
  {
    id: 'central',
    title: 'Aruba Central',
    icon: Cloud,
    summary: 'OAuth client-credentials or token auth; multi-account.',
    keywords: ['central', 'aruba', 'oauth', 'client', 'token', 'account', 'cloud', 'glp'],
    blocks: [
      { kind: 'p', text: 'Settings → **Integrations → Aruba Central**: enter a Base URL + Client ID/Secret (OAuth), or paste an access **token** (SSO).' },
      { kind: 'bullets', items: ['Save/load/delete named **accounts** (loading then Save updates in place, no duplicate).', 'Reach Central data via the **API Explorer** (target = Central) or via centralmcp.'] },
    ],
    action: { label: 'Open Central settings', id: 'open-settings', focus: 'central' },
  },
  {
    id: 'tls',
    title: 'Device REST security (TLS)',
    icon: ShieldCheck,
    summary: 'Control certificate verification for device REST.',
    keywords: ['tls', 'ssl', 'certificate', 'verify', 'self-signed', 'security', 'mitm'],
    blocks: [
      { kind: 'p', text: 'Settings → **Connections & Security → Device REST security → Verify device TLS certificates**. **On by default** for new installs — untrusted certs are rejected across AOS-CX/AOS-8/AOS-S.' },
      { kind: 'note', text: 'Turn it off only for self-signed lab gear; the toggle warns that credentials can be intercepted on untrusted networks while verification is off. The API Explorer’s per-login Verify-TLS checkbox defaults from this setting.' },
    ],
    action: { label: 'Open TLS setting', id: 'open-settings', focus: 'tls' },
  },
  {
    id: 'intent',
    title: 'Network Intent (assurance)',
    icon: Target,
    summary: 'Declare desired state and check live compliance.',
    keywords: ['intent', 'desired state', 'assurance', 'compliance', 'drift', 'matcher', 'operational', 'config'],
    blocks: [
      { kind: 'p', text: '**Network Intent** in the activity bar on the left (the target icon — a red badge counts intents that failed their last check). Declare what should be true and check live compliance.' },
      {
        kind: 'steps',
        items: [
          'Add an intent: name, kind (config/operational), a **command**, a **matcher** (contains / not-contains / regex / regex-absent) + expected value, severity, and scope (all / tags / device types).',
          'Click **Evaluate all** — each command runs against in-scope connected sessions and a per-device result is recorded.',
          'Results: ok / violation / unknown (empty output is *unknown*, never a false pass). The AI tool `evaluate_network_intents` summarizes compliance.',
        ],
      },
    ],
    action: { label: 'Open Network Intent', id: 'open-intent' },
  },
  {
    id: 'tunnels-sftp',
    title: 'Tunnels, SFTP & tools',
    icon: Waypoints,
    summary: 'Port forwarding, file transfer, triggers, config editor, bulk runner.',
    keywords: ['tunnel', 'forward', 'socks', 'sftp', 'file', 'upload', 'download', 'trigger', 'bulk', 'editor', 'problems', 'snippet', 'f8', 'ctrl+shift+m', 'status', 'send to', 'vendor', 'diff', 'compare', 'comment'],
    blocks: [
      {
        kind: 'bullets',
        items: [
          '**SSH Tunnels** (activity bar on the left): local (`-L`) and dynamic SOCKS5 (`-D`) forwards over any SSH session.',
          '**SFTP**: browse/upload/download; uploads confirm before overwriting a remote file.',
          '**Output triggers** (Settings): toast/beep on a keyword/regex in any terminal.',
          '**Bulk Runner**: run one command across many sessions; export CSV.',
        ],
      },
      {
        kind: 'bullets',
        items: [
          '**Config Editor problems**: risky lines, blanks to fill in, terminal junk and a Junos edit with no commit are underlined and counted in the toolbar. Click the count (or **Ctrl+Shift+M**) for the Problems panel; **F8** jumps to the next one. A line the switch rejected shows in red.',
          '**Editor status line**: where Send goes, the device\'s CLI, **CONFIG MODE**, and when you pulled its config. It warns in red when the tab is for another vendor than the device.',
          '**Config Editor smarts**: **Ctrl+/** comments a line (`!` Aruba, `#` Junos); a double-click picks `1/1/5` or `ge-0/0/0.100` whole.',
          '**Snippets**: type `cx-access`, `junos-trunk`, … at the start of a line, or pick from *Snippets*; **Tab** moves to the next blank.',
          '**Diff**: compare the editor with the running-config you pulled, or with a file.',
        ],
      },
    ],
    action: { label: 'Open Tunnels', id: 'open-tunnels' },
  },
  {
    id: 'security',
    title: 'Security & your data',
    icon: ShieldCheck,
    summary: 'What is encrypted, file permissions, where data lives.',
    keywords: ['security', 'data', 'storage', 'permissions', '0600', 'known_hosts', 'privacy', 'telemetry'],
    blocks: [
      {
        kind: 'bullets',
        items: [
          'Vault & API keys & MCP creds are owner-only (`0600`), written atomically.',
          'SSH uses **TOFU** host-key pinning — a changed key is rejected.',
          'No secrets in browser storage; no telemetry — only the providers and devices you configure.',
        ],
      },
      { kind: 'p', text: 'Data lives in the OS app-data dir for `com.choatelabs.greencli` (sessions.json, vault.enc, ai_keys.json, mcp_servers.json, known_hosts.json, intents.json).' },
    ],
  },
  {
    id: 'shortcuts',
    title: 'Keyboard shortcuts',
    icon: Keyboard,
    summary: 'The essentials.',
    keywords: ['keyboard', 'shortcut', 'hotkey', 'keys', 'tab', 'find', 'close', 'mac', 'windows'],
    blocks: [
      {
        kind: 'bullets',
        items: [
          `${k('quickConnect')} — Quick Connect`,
          `${k('closeTab')} — Close the active tab (asks first while it is connected)`,
          `${k('find')} — Find in terminal · ${k('findNext')} / ${k('findPrev')} — next / previous match${isMac ? ' (`F3` / `Shift+F3` work too)' : ''}`,
          `${k('commandPalette')} — Command palette`,
          `${k('nextTab')} / ${k('prevTab')} — Next / previous tab${isMac ? ' (also `⌘⇧]` / `⌘⇧[`)' : ' (also `Ctrl+PgDn` / `Ctrl+PgUp`)'}`,
          `${k('jumpTab')} — Jump to tab 1–9`,
          `${k('settings')} — Settings · ${k('help')} — Help`,
          `${k('editor')} / ${k('api')} / ${k('ai')} — Editor / API / AI tab of the side panel (again closes it)`,
          `${k('sidebar')} — Toggle sidebar`,
          `${k('zoomIn')} / ${k('zoomOut')} / ${k('zoomReset')} — Zoom terminal + config-editor font (${MOD}+wheel inside the editor)`,
        ],
      },
      ...(isMac
        ? []
        : [
            {
              kind: 'note' as const,
              text: 'Inside a session, plain `Ctrl+T`, `Ctrl+F`, `Ctrl+K` and `Ctrl+W` belong to the device shell (transpose, forward, kill-line, delete-word) — that is why the app uses the `Ctrl+Shift` versions. The plain ones still work when the focus is outside the terminal.',
            },
          ]),
    ],
  },
  {
    id: 'terminal',
    title: 'Working in the terminal',
    icon: TerminalSquare,
    summary: 'Copy & paste, selecting, right-click, paste guard, logging, split view, pop-out, tabs, reconnect.',
    keywords: [
      'terminal', 'copy', 'paste', 'select', 'selection', 'mouse', 'right-click', 'context menu', 'paste guard', 'open in editor', 'colors',
      'log', 'logging', 'record', 'drop', 'file', 'path', 'split', 'pane', 'pop-out', 'window', 'tab', 'reconnect',
      'scrollback', 'save', 'option', 'alt', 'meta', 'rename', 'duplicate', 'config mode', 'configure', 'prompt', 'hostname',
    ],
    blocks: [
      {
        kind: 'bullets',
        items: [
          COPY_PASTE,
          isMac
            ? '**Selecting inside full-screen apps** (vim, tmux, htop, AI CLIs): when the app uses the mouse a plain drag goes to the app — hold `Option` while dragging to select text anyway.'
            : '**Selecting inside full-screen apps** (vim, tmux, htop, AI CLIs): when the app uses the mouse a plain drag goes to the app — hold `Shift` while dragging to select text anyway.',
          '**Keyboard selection**: `Shift+Arrow`, `Shift+Home` / `Shift+End` extend a selection from the cursor; `Esc` clears it (at the normal prompt — full-screen apps keep those keys).',
          `**Copy an address**: \`${MOD}\`-click an IP address, MAC address, interface name or path in the output to copy it (Settings → Terminal → Smart Links).`,
          '**Right-click** opens a menu: Copy, Paste, **Copy & Paste** (types the selection at the prompt), **Find Selection**, **Open in Editor** (the selection in a new Config Editor tab, in the device\'s language), Select All, **Save Scrollback…** (the whole buffer to a text file) and Clear. `Esc` closes it. Settings → Terminal → **Right-Click in Terminal** can make it paste straight away (PuTTY) or copy-if-selected-else-paste (Windows Terminal).',
          '**Paste guard**: pasting two or more lines asks first, because every line runs as a command on the device. Change the threshold or turn it off in Settings → Terminal.',
          '**Logging**: click **Log** in the status bar to record the session to a file (it shows **REC** while recording). Click again to stop.',
          '**Drop a file** on the window to type its path at the cursor (quoted when needed) — handy for `scp`, `copy` or AI CLIs. While the SFTP browser is open a drop uploads instead.',
        ],
      },
      {
        kind: 'bullets',
        items: [
          `**Tabs**: ${k('nextTab')} / ${k('prevTab')} move between tabs, ${k('jumpTab')} jumps to tab 1–9 — also while typing in a session.${isMac ? '' : ' (`Ctrl`+digit is left for the device.)'}`,
          '**Right-click a tab** for Duplicate tab, Reconnect, Disconnect, **Rename tab** (double-clicking the tab works too — only the tab is renamed, not the saved host), Pop out, Close other tabs and Close disconnected tabs.',
          '**Config mode**: GreenCLI reads the device prompt. While a device is in configuration mode — `switch(config)#`, `(host) [mynode] (config) #`, Junos `user@host#` — its tab turns amber with a **CONFIG** badge and the status bar says **Config mode**. A tab named only by its IP address shows the hostname from the prompt.',
          '**Split view** (the split button at the right end of the tab strip, next to Snippets and Multi-send): up to four sessions side by side. Click a pane to work in it — its header gets the accent bar, and Close, Find, snippets, logging and file drops all act on that pane. Each pane header has a session picker, an add-pane `+` and a close `×` (the session stays open as a tab).',
          '**Pop-out**: the tab’s pop-out button moves a session into its own window. Its header shows the live status, **Find**, **Reconnect** when the session drops, and **Dock** to put it back in its tab.',
          '**Dropped session**: press `Enter` in the terminal (or click **Reconnect**) to connect again.',
          `**Closing** a still-connected tab (× or ${k('closeTab')}) asks first. Turn that off in Settings → Terminal → **Confirm Before Closing a Connected Tab**.`,
        ],
      },
      ...(isMac
        ? [
            {
              kind: 'note' as const,
              text: 'On non-US keyboards, if `Option` won’t type `| [ ] { } @ \\ ~` in the terminal, turn off Settings → Terminal → **Option Key as Meta**. (Leave it on to use `Option+B` / `Option+F` word jumps at the prompt.)',
            },
          ]
        : []),
    ],
    action: { label: 'Terminal settings', id: 'open-settings', focus: 'terminal' },
  },
  {
    id: 'troubleshooting',
    title: 'Troubleshooting',
    icon: LifeBuoy,
    summary: 'Common issues and fixes.',
    keywords: ['troubleshoot', 'problem', 'error', 'fix', 'ollama', 'cert', 'cli', 'path', 'frozen'],
    blocks: [
      {
        kind: 'bullets',
        items: [
          'AI *“is Ollama running?”* — start it with `ollama serve` and check the URL in Settings.',
          'Local CLI not found — the app adds `~/.local/bin`, `~/.cargo/bin`, and Homebrew to PATH; install your CLI there.',
          'Device REST cert error — verification is on by default; for self-signed lab gear turn *Verify device TLS* off in Settings → Connections & Security (heed the interception warning).',
          'Connected tab but no shell — a restricted account/appliance refused a PTY/shell; this now surfaces as a connect error.',
        ],
      },
    ],
  },
];
