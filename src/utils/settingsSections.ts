// Where every Settings section lives, and the words that find it. The nav
// groups it by task (what you're trying to set up) rather than by the order
// sections were added, and the search box filters sections by these titles
// and labels — so a setting can be found without knowing its group.

export type SettingsGroupId =
  | 'appearance'
  | 'terminal'
  | 'connections'
  | 'automation'
  | 'ai'
  | 'integrations'
  | 'backup';

export const SETTINGS_GROUPS: { id: SettingsGroupId; label: string }[] = [
  { id: 'appearance', label: 'Appearance' },
  { id: 'terminal', label: 'Terminal' },
  { id: 'connections', label: 'Connections & Security' },
  { id: 'automation', label: 'Automation' },
  { id: 'ai', label: 'AI & MCP' },
  { id: 'integrations', label: 'Integrations' },
  { id: 'backup', label: 'Backup & Reset' },
];

export interface SettingsSection {
  /** Deep-link id: the section's element is `set-<id>` (settingsFocus). */
  id: string;
  group: SettingsGroupId;
  title: string;
  /** The labels inside the section, plus words people search for. */
  keywords: string[];
}

/** In display order: grouped, and in each group's reading order. */
export const SETTINGS_SECTIONS: SettingsSection[] = [
  {
    id: 'appearance',
    group: 'appearance',
    title: 'Appearance',
    keywords: ['theme', 'dark', 'light', 'system', 'terminal color scheme', 'colour', 'font size', 'font family', 'zoom'],
  },
  {
    id: 'terminal',
    group: 'terminal',
    title: 'Terminal',
    keywords: [
      'cursor style', 'cursor blink', 'scrollback lines', 'bell', 'syntax highlighting',
      'paste guard', 'paste history', 'copy on select', 'smart links', 'background activity alerts',
      'silence alerts', 'confirm before closing a connected tab', 'option key as meta', 'middle-click paste',
      'right-click in terminal', 'context menu', 'paste guard threshold', 'silence alert delay', 'ergonomics',
    ],
  },
  {
    id: 'device-profiles',
    group: 'terminal',
    title: 'Device Profiles',
    keywords: ['custom profile', 'map device', 'highlighting', 'import', 'export', 'vendor'],
  },
  {
    id: 'logins',
    group: 'connections',
    title: 'Shared Logins',
    keywords: ['login', 'credentials', 'username', 'password', 'tacacs', 'radius', 'folder default', 'vault'],
  },
  {
    id: 'connection',
    group: 'connections',
    title: 'Connection',
    keywords: ['keep-alive interval', 'keepalive', 'auto reconnect', 'dropped', 'timeout', 'idle'],
  },
  {
    id: 'hosts',
    group: 'connections',
    title: 'Host Import & SSH Host Keys',
    keywords: [
      'known hosts', 'host keys', 'trusted', 'fingerprint', 'forget', 'import hosts', 'csv', 'securecrt',
      'ssh config', 'central', 'mist', 'inventory',
    ],
  },
  {
    id: 'tls',
    group: 'connections',
    title: 'Device REST security',
    keywords: ['tls', 'https', 'certificate', 'self-signed', 'verify', 'rest api'],
  },
  {
    id: 'triggers',
    group: 'automation',
    title: 'Output triggers',
    keywords: ['trigger', 'keyword', 'regex', 'pattern', 'alert', 'toast', 'beep', 'bell'],
  },
  {
    id: 'config-archive',
    group: 'automation',
    title: 'Config archive',
    keywords: ['capture running-config on connect', 'snapshot', 'history', 'golden', 'backup config'],
  },
  {
    id: 'intent-schedule',
    group: 'automation',
    title: 'Scheduled intent evaluation',
    keywords: ['intent', 'drift', 'violation', 'interval', 'schedule', 'webhook'],
  },
  {
    id: 'logging',
    group: 'automation',
    title: 'Session Logging',
    keywords: ['log', 'log every session automatically', 'timestamp each line', 'log folder', 'record', 'rec'],
  },
  {
    id: 'ai',
    group: 'ai',
    title: 'AI Assistant',
    keywords: [
      'provider', 'api key', 'model', 'anthropic', 'claude', 'openrouter', 'ollama', 'moonshot', 'kimi',
      'local cli', 'casper', 'working folder', 'check casper', 'assistant tools', 'device cli commands',
      'rest apis', 'best-practice references', 'standards', 'jvd',
    ],
  },
  {
    id: 'agents',
    group: 'ai',
    title: 'AI Agents',
    keywords: ['agent', 'persona', 'instructions', 'system prompt', 'model override'],
  },
  {
    id: 'mcp',
    group: 'ai',
    title: 'MCP Servers',
    keywords: ['mcp', 'model context protocol', 'tools', 'server', 'centralmcp'],
  },
  {
    id: 'central',
    group: 'integrations',
    title: 'Aruba Central',
    keywords: ['central', 'account', 'client id', 'client secret', 'token', 'base url', 'region', 'cloud'],
  },
  {
    id: 'mist',
    group: 'integrations',
    title: 'Juniper Mist',
    keywords: ['mist', 'api token', 'api base', 'region', 'cloud'],
  },
  {
    id: 'backup',
    group: 'backup',
    title: 'Backup & Transfer',
    keywords: ['export backup', 'import backup', 'merge', 'replace', 'transfer', 'move to another computer'],
  },
  {
    id: 'reset',
    group: 'backup',
    title: 'Reset Settings',
    keywords: ['reset all settings', 'defaults', 'factory'],
  },
];

/** Deep-link ids that name part of a section (e.g. `set-import` inside Host Import). */
const FOCUS_ALIASES: Record<string, string> = {
  import: 'hosts',
  'known-hosts': 'hosts',
};

/** The nav group that holds a deep-linked section (settingsFocus), if any. */
export function groupForFocus(focus: string): SettingsGroupId | null {
  const id = FOCUS_ALIASES[focus] ?? focus;
  return SETTINGS_SECTIONS.find((s) => s.id === id)?.group ?? null;
}

/**
 * Sections matching a search, in display order. Every word must appear in
 * the section's title, keywords or group name (so "ssh key" finds SSH Host
 * Keys, and "ai model" the AI Assistant).
 */
export function searchSettings(query: string): SettingsSection[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return SETTINGS_SECTIONS;
  return SETTINGS_SECTIONS.filter((s) => {
    const group = SETTINGS_GROUPS.find((g) => g.id === s.group)?.label ?? '';
    const hay = `${s.title} ${s.keywords.join(' ')} ${group}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}
