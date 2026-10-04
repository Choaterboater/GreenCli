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
  Database,
  RefreshCw,
  type LucideIcon,
} from 'lucide-react';
import { formatChord, isMac, platform, shortcutLabel, type ShortcutId } from '../utils/shortcuts';

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
      { kind: 'note', text: 'Secrets are never kept in the browser: AI keys and MCP logins go in the system password store (Keychain on a Mac, Credential Manager on Windows), SSH passwords in the encrypted vault.' },
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
    summary: 'Provider-neutral assistant (Anthropic, OpenRouter, Moonshot, Ollama, Local CLI, Casper).',
    keywords: ['ai', 'assistant', 'claude', 'anthropic', 'openrouter', 'moonshot', 'kimi', 'ollama', 'llm', 'model', 'api key', 'tools', 'secrets', 'hidden', 'redact', 'casper', 'sandbox', 'local cli'],
    blocks: [
      { kind: 'p', text: 'Settings → **AI Assistant**. The assistant works with any provider — keys are kept in the system password store (Keychain, Credential Manager), never in the browser.' },
      {
        kind: 'steps',
        items: [
          'Pick a **provider** (Anthropic / OpenRouter / Moonshot need a key; Ollama is local; Local CLI shells out to an installed agent; **Casper (no key)** uses Casper on your computer).',
          'Enter the **API key** and choose a **model**.',
          'Enable the opt-in **Assistant tools** you want (run CLI commands, device REST, MCP tools, evaluate intents).',
        ],
      },
      { kind: 'note', text: 'Responses stream token-by-token; **Stop** actually aborts the provider request, not just the UI. Local CLI and Casper answer all at once, and **Stop** ends the CLI.' },
      {
        kind: 'note',
        text: '**Casper**: each question gets a fresh folder (or one you pick with **Choose…**; **Check Casper** tests it). GreenCLI never turns Casper’s sandbox off, and won’t start Casper while a port forward or a local MCP server is open. Casper can’t use device tools or MCP servers. Its own file tools can read files outside its folder, including GreenCLI’s session logs and archived configs, and `ai_keys.json` and `mcp_creds.json` when no system password store is found, so only ask it about text you trust.',
      },
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
        'Starter agents ship ready: **Read-only Auditor**, **Junos Expert**, **Aruba CX Expert**.',
        'The **Read-only Auditor** is enforced: only plain read commands (`show`, `display`, `ping` with a count …) and read-only MCP tools run; anything else is refused. Type `show`, not `sh`.',
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
    keywords: ['mcp', 'tools', 'centralmcp', 'stdio', 'http', 'streamable', 'server', 'context protocol', 'approval', 'allow writes', 'writes', 'read-only', 'export', '.mcp.json', 'claude code', 'casper', 'junos show', 'login', 'credentials', 'password store', 'mcp_creds'],
    blocks: [
      { kind: 'p', text: 'The app is an **MCP client**: it connects to external MCP servers — stdio (launches a command) or Streamable HTTP (points at one already running) — and exposes their tools to the AI for every API provider (not Local CLI or Casper).' },
      {
        kind: 'steps',
        items: [
          'Settings → **AI & MCP → MCP Servers** (or **MCP Servers** in the command palette) → Add server.',
          'Click **Paste config JSON instead** to auto-fill from a setup wizard snippet, or fill in by hand.',
          'Stdio: set the **command**, **args** (one per line), and any **env**. HTTP: set the **server URL**.',
          'Stdio only — for secrets, set a **credentials env var** + paste the content. It is kept in the system password store; while the server runs it is written to a private (0600) file that the env var points at.',
          'Click **Connect**; the tool count appears in the AI panel.',
        ],
      },
      {
        kind: 'bullets',
        items: [
          '**Approval box**: a tool that might change something asks first: **No**, **Yes, this once**, or (for plain reads only) **Yes, until GreenCLI closes**. Router calls and calls where the AI set confirm itself always ask.',
          '**Allow writes** (per server, off by default): with writes off, tools that change or delete things are hidden and blocked, and known servers start with their own read-only settings.',
          'Junos: **Run plain show commands without asking** skips the box for `show …` with safe pipes.',
          '**Export for Casper / Claude…** saves a `.mcp.json` with every secret turned into a `${NAME}` variable, and lists the names to set. It also adds greencli-mcp as `greencli`.',
          '**Login file**: it exists only while its server runs, in `mcp_creds/`, and is deleted when the server stops, exits or fails to connect. Files a crash left are deleted at the next start.',
          'Removing a server removes its saved login too. If the password store can’t be reached, nothing is removed.',
        ],
      },
      { kind: 'note', text: 'Example: the centralmcp server (Aruba Central / GLP / monitoring / NAC / ops / RAG) routes hundreds of backend tools through a compact set exposed to the AI. Tool names are namespaced `mcp__<server>__<tool>`. Supports stdio (launch command) or Streamable HTTP (point at a URL).' },
    ],
    action: { label: 'Open MCP settings', id: 'open-settings', focus: 'mcp' },
  },
  {
    id: 'greencli-mcp',
    title: 'greencli-mcp (for Casper / Claude Code)',
    icon: Database,
    summary: 'A read-only MCP server that lets Casper or Claude Code read your GreenCLI data.',
    keywords: ['greencli-mcp', 'greencli', 'mcp', 'claude code', 'casper', 'claude mcp add', 'read-only', 'hidden copy', 'make hidden copies', 'config archive', 'diff', 'devices', 'intents', 'list_archive_devices', 'renamed device', 'show commands', 'device_show', 'list_connected_devices', 'live'],
    blocks: [
      { kind: 'p', text: 'greencli-mcp lets Casper or Claude Code read your GreenCLI data. It can’t change anything: it only reads GreenCLI’s data folder, and never writes a file, opens a network connection or starts a program. It sits next to the app. The one exception is its show commands (below): on macOS and Linux they ask the GreenCLI app on this computer, and nothing else.' },
      {
        kind: 'steps',
        items: [
          'Settings → **AI & MCP → MCP Servers**: copy its path, or copy the `claude mcp add --scope user greencli -- "<path>" --data-dir "<data folder>"` command and run it in a terminal. `--scope user` makes it available in every folder; without it Claude Code only adds it for the folder you run the command in. `--data-dir` is GreenCLI’s data folder, so greencli-mcp reads the same one as the app.',
          'Or use **Export for Casper / Claude…**, which adds it as `greencli`.',
          'On a Mac, move GreenCLI to Applications first, or the path changes every time it starts.',
        ],
      },
      {
        kind: 'bullets',
        items: [
          'It shows your devices (no passwords, user names, notes or startup commands), config history, configs and diffs with secrets hidden, and intent results.',
          'Config history stays under the name a device had when it was captured. After you rename or delete a saved device, or for a Quick Connect you never saved, the AI finds that history with `list_archive_devices`.',
          'Configs come only from **hidden copies** made when a config is captured. If a tool says a snapshot has no hidden copy, or that it is out of date, open **Config Archive** (activity bar or command palette) and click **Make hidden copies**. If it says the copy was made by a newer GreenCLI, restart Claude Code or Casper so they use the updated greencli-mcp.',
          'A diff can’t show a changed password: both sides show it hidden.',
        ],
      },
      {
        kind: 'bullets',
        items: [
          '**Show commands** (macOS and Linux; on Windows they say not on Windows yet): `list_connected_devices` lists the device tabs connected in GreenCLI now, and `device_show` runs one `show` line on one of them. GreenCLI must be open with the device connected.',
          'GreenCLI asks you each time: **No**, **Yes, this once**, or **Yes, show commands on this device until GreenCLI closes**. The box names the asker as a program on this computer, with its process number.',
          'Casper asks first too (it treats `device_show` as a check on a device), so you answer two boxes: Casper’s, then GreenCLI’s.',
          'Only plain `show` lines run, with filters after `|` (include, exclude, begin, section, match, count …). Never config mode, never on Linux or Windows host tabs, and never while something is half-typed in the tab. `show running-config` and `show tech` work; secrets are hidden and the output stops at 16 KB.',
          'GreenCLI waits 60 seconds for your answer. To turn this off, clear **Let AI tools outside GreenCLI ask to run show commands** in **MCP Servers**.',
        ],
      },
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
    id: 'updates',
    title: 'Updates',
    icon: RefreshCw,
    summary: 'GreenCLI updates itself from its GitHub releases (macOS and Windows).',
    keywords: ['update', 'updates', 'new version', 'upgrade', 'check for updates', 'restart to update', 'release', 'github', 'signature', 'daily', 'vault'],
    blocks: [
      { kind: 'p', text: 'Settings → **Updates** shows the version, **Check for updates** and **Check once a day** (on by default).' },
      {
        kind: 'bullets',
        items: [
          'A check downloads a newer version and checks its signature, but never installs it. When it is ready you see “GreenCLI X is ready.” with **Restart to update**.',
          '**Restart to update** asks first, says how many open sessions will close, and warns about unsaved Config Editor edits or a password change still waiting for the vault to unlock (it would be lost). It says when an AI answer is still running, and won’t restart while a Change Job, bulk run, Config Editor send or SFTP upload or download is going.',
          'Updates come only from GreenCLI releases on GitHub. Each release build signs its own files, and the app checks the signature before it installs.',
          isMac
            ? 'Run GreenCLI from **Applications**. From the disk image (or straight from Downloads) it offers no update. After an update, restart Claude Code and Casper so they use the new greencli-mcp.'
            : platform === 'windows'
              ? 'Close Claude Code and Casper before you update (the **Restart to update** box reminds you). GreenCLI closes when the installer starts. If the installer then shows “Error opening file for writing”, close Claude Code and Casper and click **Retry**. After **Abort**, open GreenCLI again.'
              : 'There is no Linux release build, so updates are off on Linux.',
        ],
      },
      { kind: 'note', text: 'Coming from 1.9 or older? It has no updater: install 2.0 by hand once.' },
    ],
    action: { label: 'Open Updates', id: 'open-settings', focus: 'updates' },
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
    keywords: ['tunnel', 'forward', 'socks', 'sftp', 'file', 'upload', 'download', 'trigger', 'bulk', 'editor', 'problems', 'snippet', 'f8', 'ctrl+shift+m', 'status', 'send to', 'vendor', 'copy', 'secrets', 'hidden', 'share', 'ticket', 'hover', 'junos', 'quick fix', 'ctrl+.', 'symbol', 'outline', 'ctrl+shift+o', 'diff', 'compare', 'comment', 'selection', 'send safely', 'change job', 'rollback', 'ask ai', 'explain', 'convert', 'review', 'apply', 'suggestion'],
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
          '**Config Editor problems**: risky lines, blanks to fill in, terminal junk and a Junos edit with no commit are underlined and counted in the toolbar. Click the count (or **' + formatChord('Mod+Shift+M') + '**) for the Problems panel; **F8** jumps to the next one. A line the switch rejected shows in red.',
          '**Go to Symbol**: press **' + formatChord('Mod+Shift+O') + '** (or click Outline) and type to jump to an interface, VLAN or section.',
          '**Quick fixes**: on a problem press **' + formatChord('Mod+.') + '** (or click the light bulb) to strip terminal junk, comment out a risky line, add commit confirmed 5, or swap a plain-text password for a blank.',
          '**Hover cards**: hover an Aruba CX or Junos line to see what it does and how the other vendor writes it.',
          '**Secrets in code files**: a password, token or key written into a YAML, JSON, Python, shell or .env file gets a warning.',
          '**Copy with secrets hidden**: the eye button next to Copy copies the tab with passwords, keys and SNMP communities hidden, safe for a ticket or chat.',
          '**Editor status line**: where Send goes, the device\'s CLI, **CONFIG MODE**, and when you pulled its config. It warns in red when the tab is for another vendor than the device.',
          '**After a Send**: bars beside the lines show what reached the switch (green), what it rejected (red) and what was never sent (grey).',
          '**Config Editor smarts**: **' + formatChord('Mod+/') + '** comments a line (`!` Aruba, `#` Junos); a double-click picks `1/1/5` or `ge-0/0/0.100` whole.',
          '**Snippets**: type `cx-access`, `cx-ospf`, `aoss-radius`, `junos-bgp`, `iap-wlan`, … at the start of a line, or pick from *Snippets* (your tab\'s vendor is listed first); **Tab** moves to the next blank. A blank you skip stays `${name}` and shows red in Problems.',
          '**Templates**: a whole starter config opens in its own tab. Fill its `${name}` blanks, or leave them: in Send safely they become per-device values.',
          '**Diff**: compare the editor with the running-config you pulled, or with a file. Edit your tab on the right; the arrow beside a change takes the left side.',
          '**Folder view**: the folder button opens a folder as a file tree beside the editor; click a file to open it.',
          '**Send selected lines**: select lines, then the arrow next to Send (or right-click). Only those lines go out.',
          '**Send safely**: the arrow next to Send opens Change Jobs with the tab and this device filled in: a dry run, then the switch\'s own rollback timer.',
          '**Ask AI** (editor toolbar or right-click): explain, check, fix, or convert Aruba ↔ Junos the selected lines. Secrets are hidden first. **Mark mistakes with Casper** has Casper mark what it finds as squiggles and Problems rows named Casper, and says what it cost.',
          '**Review in Editor**: an AI answer\'s code opens as a diff against the lines you asked about. Apply or Discard; ' + formatChord('Mod+Z') + ' undoes an Apply.',
        ],
      },
    ],
    action: { label: 'Open Tunnels', id: 'open-tunnels' },
  },
  {
    id: 'security',
    title: 'Security & your data',
    icon: ShieldCheck,
    summary: 'What is encrypted, where keys are kept, where data lives.',
    keywords: ['security', 'data', 'storage', 'permissions', '0600', 'known_hosts', 'privacy', 'telemetry', 'keychain', 'credential manager', 'password store', 'keyring', 'secret_store', 'ai_keys', 'mcp_creds', 'backup', 'downgrade', 'outbound', 'firewall'],
    blocks: [
      {
        kind: 'bullets',
        items: [
          'AI keys and MCP logins are kept in the system password store: macOS Keychain, Windows Credential Manager, or the Secret Service on Linux. Settings says where.',
          'The vault (`vault.enc`) and the other secret files are owner-only (`0600`), written atomically.',
          'SSH uses **TOFU** host-key pinning — a changed key is rejected.',
          'No secrets in browser storage; no telemetry. GreenCLI calls only the providers and devices you configure, plus GitHub for the update check on macOS and Windows (turn off **Check once a day** in Settings → **Updates**).',
        ],
      },
      {
        kind: 'note',
        text: 'Copying the GreenCLI folder to another computer does not copy the AI keys and MCP logins in the password store. On a Linux computer with no keyring, delete `secret_store.json` from the copy while GreenCLI is closed, then enter the keys again. 1.9 can’t read the password store, so if you go back to 1.9, enter your AI keys and MCP logins again there. When you start 2.0 again, any key or login in 1.9’s files (typed there, or copied back from a backup) replaces the one in the password store, and the files are deleted. The others stay as they were. If you go back to 2.0.0, enter again there any MCP login it shows as not saved (on Windows, one for a server whose name has a capital letter or a character other than `a-z`, `0-9` and `-_.: `, such as “Central”) or that reaches the server as a short `GCS1 …` line (a very long login). On Windows, enter the first kind once more after you update again.',
      },
      { kind: 'p', text: 'Data lives in the OS app-data dir for `com.choatelabs.greencli` (sessions.json, vault.enc, secret_store.json, mcp_servers.json, known_hosts.json, intents.json, config_archive/, logs/). `secret_store.json` only says the keys are in the password store. `ai_keys.json` and `mcp_creds.json` are there only when no password store is found, or when an old 1.9 file is left in this folder: Settings shows the path of one it can’t read as keys, or says some keys were not moved yet.' },
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
      'link', 'url', 'web', 'browser',
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
          `**Open a web address**: \`${MOD}\`-click an http/https link in the output to open it in your browser. A plain click does nothing, so clicking to focus the pane or clear a selection doesn't open a page.`,
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
    keywords: ['troubleshoot', 'problem', 'error', 'fix', 'ollama', 'cert', 'cli', 'path', 'frozen', 'password store', 'keychain', 'hidden copy'],
    blocks: [
      {
        kind: 'bullets',
        items: [
          'AI *“is Ollama running?”* — start it with `ollama serve` and check the URL in Settings.',
          'Local CLI not found — the app adds `~/.local/bin`, `~/.cargo/bin`, and Homebrew to PATH; install your CLI there.',
          'Device REST cert error — verification is on by default; for self-signed lab gear turn *Verify device TLS* off in Settings → Connections & Security (heed the interception warning).',
          'Connected tab but no shell — a restricted account/appliance refused a PTY/shell; this now surfaces as a connect error.',
          '“Can’t reach the system password store” — keys saved on this computer are still there. Log in to the desktop (on Linux, start a keyring such as GNOME Keyring), then try again. On a Mac after an update, macOS may ask to let GreenCLI use its Keychain items: enter your login password and choose **Always Allow** (**Allow** alone asks again later). If you chose **Deny**, open Settings or the AI panel again and allow it. If you copied the GreenCLI folder from another computer, the keys aren’t on this one: start a keyring, or quit GreenCLI and delete `secret_store.json` to keep keys in private files, then enter them again.',
          'greencli-mcp says a snapshot has no hidden copy, or it is out of date — open **Config Archive** (activity bar or command palette) and click **Make hidden copies**.',
          'greencli-mcp says a hidden copy was made by a newer GreenCLI — GreenCLI was updated while Claude Code or Casper kept running the old greencli-mcp. Restart Claude Code or Casper. After you update GreenCLI, restart them so they use the new greencli-mcp.',
        ],
      },
    ],
  },
];
