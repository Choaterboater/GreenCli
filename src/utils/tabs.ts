// Pure helpers for session TABS vs saved HOSTS. A tab's config.id is its own
// session id (what the backend keys the connection by); config.savedId points
// back at the saved sidebar host, so one host can have several tabs open while
// per-host things (AI agent, sidebar dot, recents, Edit) stay keyed by host.

import type { ConnectionConfig, Session } from '../types';

type TabConfig = Pick<ConnectionConfig, 'id' | 'savedId'>;

/** The saved host a tab belongs to. Tabs restored from older workspaces have
 *  no savedId — their tab id WAS the saved host's id, so it still resolves. */
export function savedHostId(config: TabConfig): string {
  return config.savedId ?? config.id;
}

/** Every open tab of one host, in tab order. */
export function tabsOfHost(sessions: Session[], hostId: string): Session[] {
  return sessions.filter((s) => savedHostId(s.config) === hostId);
}

const isLive = (s: Session) =>
  s.connected || s.connectionStatus === 'connecting' || s.connectionStatus === 'reconnecting';

/**
 * The tab a plain open (double-click, Enter, palette) of a host should bring
 * back: the active one if it's live, else any live one, else a dropped one to
 * reconnect in place (keeps its scrollback) — the active one first.
 */
export function findHostTab(
  sessions: Session[],
  hostId: string,
  activeSessionId: string | null | undefined,
): Session | undefined {
  const tabs = tabsOfHost(sessions, hostId);
  const active = tabs.find((s) => s.sessionId === activeSessionId);
  if (active && isLive(active)) return active;
  return tabs.find(isLive) ?? active ?? tabs[0];
}

/**
 * Copy number for another tab of a host, given the copy numbers of its open
 * tabs (unset counts as 1): the lowest free one, so closing "(2)" lets the
 * next copy reuse it. Returns undefined for 1 — the first copy has no number.
 */
export function nextCopyNumber(copies: Array<number | undefined>): number | undefined {
  const used = new Set(copies.map((n) => n ?? 1));
  let n = 1;
  while (used.has(n)) n++;
  return n === 1 ? undefined : n;
}

/**
 * The config to connect when a host is opened. Unless `newTab` is set, a tab
 * the host already has is reused (same session id — handleConnect focuses it,
 * or reconnects it if it dropped) with the host's current details. Otherwise
 * it is a fresh tab with its own id and the next free copy number.
 */
export function tabConfigForOpen(
  sessions: Session[],
  host: ConnectionConfig,
  opts: { newTab?: boolean; activeSessionId?: string | null; newId: string },
): ConnectionConfig {
  const hostId = savedHostId(host);
  const existing = opts.newTab ? undefined : findHostTab(sessions, hostId, opts.activeSessionId);
  if (existing) {
    return {
      ...host,
      // A username typed at this tab's login prompt, for a host saved
      // without one — or reconnecting would ask for it all over again.
      username: host.username || existing.config.username,
      id: existing.sessionId,
      savedId: hostId,
      copyNumber: existing.config.copyNumber,
      tabName: existing.config.tabName,
    };
  }
  return {
    ...host,
    id: opts.newId,
    savedId: hostId,
    copyNumber: nextCopyNumber(tabsOfHost(sessions, hostId).map((s) => s.config.copyNumber)),
    // A rename belongs to the tab it was given to, not to its copies.
    tabName: undefined,
  };
}

const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;
// Two or more colons, hex digits only (plus an embedded IPv4 tail).
const IPV6 = /^(?=[^:]*:[^:]*:)[0-9a-f:.]+$/i;

/** True when a host's name only repeats its address (or is empty) — e.g. a
 *  Quick Connect to 10.1.1.1 — so the hostname from the prompt says more. */
export function isAddressName(
  config: Pick<ConnectionConfig, 'name' | 'host' | 'serialPort' | 'username'>,
): boolean {
  const name = config.name?.trim();
  if (!name) return true;
  if (name === config.host || name === config.serialPort) return true;
  if (config.host && config.username && name === `${config.username}@${config.host}`) return true;
  return IPV4.test(name) || IPV6.test(name);
}

type LabelSession = Pick<Session, 'config' | 'promptHost'>;

/**
 * What a tab is called: the user's Rename wins; else the host's name — or the
 * hostname read from the device prompt when the name is just the address —
 * with the copy number for the second and later tabs of one host.
 */
export function tabLabel(session: LabelSession): string {
  const { config, promptHost } = session;
  const custom = config.tabName?.trim();
  if (custom) return custom;
  const base =
    promptHost && isAddressName(config)
      ? promptHost
      : config.name || config.host || config.serialPort || 'Session';
  return config.copyNumber && config.copyNumber > 1 ? `${base} (${config.copyNumber})` : base;
}

/** Tab tooltip name: the label plus the detected hostname and the address
 *  when the label doesn't already show them ("core-sw-01 · 10.1.1.1"). */
export function tabTooltipName(session: LabelSession): string {
  const label = tabLabel(session);
  const parts = [label];
  const address = session.config.host || session.config.serialPort;
  for (const extra of [session.promptHost, address]) {
    if (extra && !parts.some((p) => p.includes(extra))) parts.push(extra);
  }
  return parts.join(' · ');
}
