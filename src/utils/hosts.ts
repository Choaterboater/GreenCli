// Pure helpers for typing, showing and de-duplicating saved hosts — shared by
// Quick Connect, the sidebar and host import.

import { ConnectionConfig, DeviceType } from '../types';

export interface HostSpec {
  host: string;
  user?: string;
  port?: number;
}

function validPort(raw: string | undefined): number | undefined {
  if (!raw || !/^\d+$/.test(raw)) return undefined;
  const port = Number(raw);
  return port >= 1 && port <= 65535 ? port : undefined;
}

/**
 * Split what people paste into a Host box (or an ssh_config ProxyJump) —
 * `user@host:port`, `host:port`, `[2001:db8::1]:22` — into its parts.
 *
 * - The user is everything before the LAST '@', like OpenSSH: TACACS/RADIUS
 *   usernames can themselves contain '@'.
 * - A bare IPv6 address (several colons, no brackets) has no port; splitting
 *   on its last ':' would eat the final hextet.
 * - An out-of-range port is left in the host so the typo stays visible.
 */
export function parseHostSpec(input: string): HostSpec {
  let rest = input.trim();
  let user: string | undefined;
  const at = rest.lastIndexOf('@');
  if (at >= 0) {
    user = rest.slice(0, at).trim() || undefined;
    rest = rest.slice(at + 1).trim();
  }
  let port: number | undefined;
  const bracket = rest.match(/^\[([^\]]+)\](?::(\d+))?$/);
  if (bracket) {
    rest = bracket[1];
    port = validPort(bracket[2]);
  } else if (rest.indexOf(':') === rest.lastIndexOf(':')) {
    const colon = rest.lastIndexOf(':');
    const p = colon >= 0 ? validPort(rest.slice(colon + 1)) : undefined;
    if (p) {
      port = p;
      rest = rest.slice(0, colon);
    }
  }
  return { host: rest, user, port };
}

/** Console speed a device family ships with: AOS-CX consoles run at 115200,
 *  AOS-S / AOS-8 / APs / Junos at 9600. */
export function defaultBaudRate(deviceType: DeviceType): number {
  return deviceType === 'aruba-cx' ? 115200 : 9600;
}

/** "user@host[:port]" (or the serial port) — what a saved host points at. */
export function hostSummary(
  config: Pick<ConnectionConfig, 'protocol' | 'host' | 'port' | 'username' | 'serialPort'>,
): string {
  if (config.protocol === 'serial') return config.serialPort ?? '';
  if ((config.protocol !== 'ssh' && config.protocol !== 'telnet') || !config.host) return '';
  const defaultPort = config.protocol === 'ssh' ? 22 : 23;
  const showPort = config.port != null && config.port !== defaultPort;
  // An IPv6 literal needs brackets before a port, or the port reads as a hextet.
  const host = showPort && config.host.includes(':') ? `[${config.host}]` : config.host;
  return `${config.username ? `${config.username}@` : ''}${host}${showPort ? `:${config.port}` : ''}`;
}

type HostIdentityFields = { host?: string; port?: number; username?: string };

/** Same device + port + login = same saved host (hostnames are case-insensitive). */
export function hostIdentity(h: HostIdentityFields): string {
  return `${(h.host ?? '').trim().toLowerCase()}|${h.port ?? 22}|${h.username ?? ''}`;
}

/** Split import candidates into ones not saved yet and duplicates — of an
 *  existing saved host, or of an earlier candidate in the same batch. */
export function splitNewHosts<T extends HostIdentityFields>(
  candidates: T[],
  existing: HostIdentityFields[],
): { fresh: T[]; duplicates: T[] } {
  const seen = new Set(existing.map(hostIdentity));
  const fresh: T[] = [];
  const duplicates: T[] = [];
  for (const c of candidates) {
    const id = hostIdentity(c);
    if (seen.has(id)) {
      duplicates.push(c);
    } else {
      seen.add(id);
      fresh.push(c);
    }
  }
  return { fresh, duplicates };
}

/** 0 = looks like a USB console cable, 1 = other port (COM1, ttyS0),
 *  2 = noise: macOS Bluetooth/debug ports and the tty.* twin of a cu.* port
 *  (tty.* waits for carrier-detect, which console cables never raise). */
function serialPortRank(port: string, all: Set<string>): number {
  if (/bluetooth|debug-console|wlan-debug/i.test(port)) return 2;
  if (port.startsWith('/dev/tty.') && all.has(port.replace('/dev/tty.', '/dev/cu.'))) return 2;
  if (/usbserial|usbmodem|ttyUSB|ttyACM|SLAB_USB|wchusbserial/i.test(port)) return 0;
  return 1;
}

/**
 * Order serial ports likely-console-cable first, and pick the one to preselect:
 * only when exactly one port is plausible — guessing between two cables would
 * open the wrong console.
 */
export function rankSerialPorts(ports: string[]): { ordered: string[]; preferred?: string } {
  const all = new Set(ports);
  const ranked = [...all]
    .map((port) => ({ port, rank: serialPortRank(port, all) }))
    .sort((a, b) => a.rank - b.rank || a.port.localeCompare(b.port, undefined, { numeric: true }));
  const best = ranked.length > 0 && ranked[0].rank < 2 ? ranked[0].rank : null;
  const candidates = best == null ? [] : ranked.filter((r) => r.rank === best);
  return {
    ordered: ranked.map((r) => r.port),
    preferred: candidates.length === 1 ? candidates[0].port : undefined,
  };
}
