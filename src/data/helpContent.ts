// In-app help content. Kept in sync with docs/SETUP.md but structured so the Help
// panel can search, filter, and render it — and offer per-topic quick actions.

import {
  Rocket,
  PlugZap,
  Lock,
  Bot,
  Server,
  Cloud,
  Network,
  ShieldCheck,
  Target,
  Waypoints,
  Keyboard,
  LifeBuoy,
  type LucideIcon,
} from 'lucide-react';

/** Quick-action a topic can offer — resolved to a store action by the Help panel. */
export type HelpActionId =
  | 'open-settings'
  | 'open-quick-connect'
  | 'open-ai'
  | 'open-api'
  | 'open-intent'
  | 'open-tunnels';

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
          'Press `Ctrl+T` (or click **Quick Connect**) to open a connection.',
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
    keywords: ['ssh', 'telnet', 'serial', 'local', 'jump', 'proxyjump', 'bastion', 'agent', 'key', 'password', 'connect'],
    blocks: [
      { kind: 'p', text: 'Open **Quick Connect** (`Ctrl+T`) or double-click a saved host in the sidebar.' },
      {
        kind: 'bullets',
        items: [
          '**SSH auth**: password, private key (Browse… to load a key file), or **ssh-agent**.',
          'If `password` auth is refused it falls back to **keyboard-interactive** (TACACS+/RADIUS); only the first prompt gets the password, so an OTP prompt is left for you.',
          '**Jump host / ProxyJump**: set a bastion; it tries the jump password, then your key, then the agent.',
          '**Startup commands**: per-host commands run automatically once the shell is ready (e.g. `terminal length 0`).',
        ],
      },
    ],
    action: { label: 'Open Quick Connect', id: 'open-quick-connect' },
  },
  {
    id: 'vault',
    title: 'Credential vault',
    icon: Lock,
    summary: 'Encrypted store for SSH passwords (AES-256-GCM + Argon2).',
    keywords: ['vault', 'password', 'master', 'encrypt', 'argon2', 'aes', 'credentials', 'secret'],
    blocks: [
      { kind: 'p', text: 'Unlock the vault with a master password; saved SSH passwords are encrypted (AES-256-GCM, Argon2id key) and offered automatically on the next connect.' },
      { kind: 'p', text: 'Aruba Central / Apstra **secrets** are also stored in the vault (encrypted) once it is unlocked, so they survive a restart. While the vault is locked they live in memory for the session only.' },
      { kind: 'note', text: 'A corrupt/incompatible `vault.enc` is never auto-overwritten — it errors and is preserved so nothing is silently lost.' },
    ],
  },
  {
    id: 'ai',
    title: 'AI assistant',
    icon: Bot,
    summary: 'Provider-neutral assistant (Anthropic, OpenRouter, Moonshot, Ollama, Local CLI).',
    keywords: ['ai', 'assistant', 'claude', 'anthropic', 'openrouter', 'moonshot', 'kimi', 'ollama', 'llm', 'model', 'api key', 'tools'],
    blocks: [
      { kind: 'p', text: 'Settings → **AI Assistant**. The assistant works with any provider — keys are stored owner-only outside the webview, never in the browser.' },
      {
        kind: 'steps',
        items: [
          'Pick a **provider** (Anthropic / OpenRouter / Moonshot need a key; Ollama is local; Local CLI shells out to an installed agent).',
          'Enter the **API key** and choose a **model**.',
          'Enable the opt-in **Assistant tools** you want (run CLI commands, device REST, MCP tools, Apstra, evaluate intents).',
        ],
      },
      { kind: 'note', text: 'Responses stream token-by-token; **Stop** actually aborts the provider request, not just the UI.' },
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
          'Open the AI assistant on that session — its header shows the active agent, and the instructions/model are applied.',
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
    summary: 'Launch external MCP servers and expose their tools to the AI.',
    keywords: ['mcp', 'tools', 'centralmcp', 'stdio', 'server', 'context protocol'],
    blocks: [
      { kind: 'p', text: 'The app is an **MCP client**: it launches external MCP servers over stdio and exposes their tools to the AI for every provider.' },
      {
        kind: 'steps',
        items: [
          'Settings → **MCP Servers** → Add server.',
          'Set the **command**, **args** (one per line), and any **env** (`KEY=VALUE`).',
          'For secrets, set a **credentials env var** + paste the content — it is written to a 0600 file and injected via that env var.',
          'Click **Connect**; the tool count appears in the AI panel.',
        ],
      },
      { kind: 'note', text: 'Example: the centralmcp server exposes 145 Aruba Central / GLP / monitoring / NAC / ops tools. Tool names are namespaced `mcp__<server>__<tool>`.' },
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
      { kind: 'p', text: 'Settings → **Aruba Central**: enter a Base URL + Client ID/Secret (OAuth), or paste an access **token** (SSO).' },
      { kind: 'bullets', items: ['Save/load/delete named **accounts** (loading then Save updates in place, no duplicate).', 'Reach Central data via the **API Explorer** (target = Central) or via centralmcp.'] },
    ],
    action: { label: 'Open Central settings', id: 'open-settings', focus: 'central' },
  },
  {
    id: 'apstra',
    title: 'Juniper Apstra & on-prem REST',
    icon: Network,
    summary: 'Apstra fabric controller + AOS-CX/AOS-8/AOS-S on-box REST.',
    keywords: ['apstra', 'juniper', 'fabric', 'blueprint', 'aos-cx', 'aos-8', 'aos-s', 'rest', 'on-prem', 'on-box'],
    blocks: [
      { kind: 'bullets', items: ['**AOS-CX / AOS-8 / AOS-S** — the AI auto-logs in with the active session’s SSH creds; enable *Assistant tools → Aruba device REST APIs*.', '**Juniper Apstra** — Settings → Juniper Apstra: host, username, password (token auth, auto-refresh); enable *Assistant tools → Juniper Apstra*.'] },
      { kind: 'p', text: 'Explore the same endpoints interactively in the **API Explorer** (target = device or apstra).' },
    ],
    action: { label: 'Set up Apstra', id: 'open-settings', focus: 'apstra' },
  },
  {
    id: 'tls',
    title: 'Device REST security (TLS)',
    icon: ShieldCheck,
    summary: 'Control certificate verification for device REST.',
    keywords: ['tls', 'ssl', 'certificate', 'verify', 'self-signed', 'security', 'mitm'],
    blocks: [
      { kind: 'p', text: 'Settings → **Device REST security → Verify device TLS certificates**. Off by default because field gear usually ships a self-signed cert.' },
      { kind: 'note', text: 'Turn it **on** to reject untrusted certs across AOS-CX/AOS-8/AOS-S/Apstra. The API Explorer’s per-login Verify-TLS checkbox defaults from this setting.' },
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
      { kind: 'p', text: 'Title-bar **Target** icon → Network Intent. Declare what should be true and check live compliance.' },
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
    keywords: ['tunnel', 'forward', 'socks', 'sftp', 'file', 'upload', 'download', 'trigger', 'bulk', 'editor'],
    blocks: [
      {
        kind: 'bullets',
        items: [
          '**Tunnels** (title bar): local (`-L`) and dynamic SOCKS5 (`-D`) forwards over any SSH session.',
          '**SFTP**: browse/upload/download; uploads confirm before overwriting a remote file.',
          '**Output triggers** (Settings): toast/beep on a keyword/regex in any terminal.',
          '**Bulk Runner**: run one command across many sessions; export CSV.',
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
      { kind: 'p', text: 'Data lives in the OS app-data dir for `com.greencli.app` (sessions.json, vault.enc, ai_keys.json, mcp_servers.json, known_hosts.json, intents.json).' },
    ],
  },
  {
    id: 'shortcuts',
    title: 'Keyboard shortcuts',
    icon: Keyboard,
    summary: 'The essentials.',
    keywords: ['keyboard', 'shortcut', 'hotkey', 'keys'],
    blocks: [
      {
        kind: 'bullets',
        items: [
          '`Ctrl+T` — Quick Connect',
          '`Ctrl+W` — Close active tab',
          '`Ctrl+F` — Search terminal',
          '`Ctrl+K` — Command palette',
          '`Ctrl+,` — Settings · `F1` — Help',
          '`Ctrl+Shift+E / A / I` — Editor / API / AI',
          '`Ctrl+B` — Toggle sidebar',
        ],
      },
    ],
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
          'Device REST cert error — self-signed gear: leave *Verify device TLS* off (default); turn it on to enforce.',
          'Connected tab but no shell — a restricted account/appliance refused a PTY/shell; this now surfaces as a connect error.',
        ],
      },
    ],
  },
];
