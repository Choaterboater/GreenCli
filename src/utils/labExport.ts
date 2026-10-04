// Export the hosts tagged `lab` as Casper's lab file ({"hosts": [...]}), for `/lab import <file>` in Casper.
// Only each host's address goes out: never its name, login, password, key, port or jump host.
//
// The entry rules copy Casper src/network/spec.ts labEntry (keep in step). Casper refuses the whole file on one
// bad entry, so GreenCLI skips such hosts here and says why instead of writing them.

import type { SessionFolder } from '../types';
import { isLabHost } from './tags';

export const LAB_EXPORT_FILE_NAME = 'casper-lab.json';

/** Casper's lab list holds at most this many entries. */
export const LAB_EXPORT_MAX = 1024;

const HOSTNAME = /^[a-z0-9_]([a-z0-9_.-]{0,252})$/i;
const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

/** A valid IPv6 address (the webview has no isIP; the URL parser checks it). */
function isIPv6(value: string): boolean {
  if (!/^[0-9a-f:.]+$/i.test(value) || !value.includes(':')) return false;
  try {
    new URL(`http://[${value}]`);
    return true;
  } catch {
    return false;
  }
}

export type LabEntry = { entry: string; shortName: boolean } | { skip: string };

/** One saved host address as a Casper lab entry, or why Casper would refuse it. */
export function labEntryFor(address: string | undefined): LabEntry {
  let v = (address ?? '').trim();
  if (!v) return { skip: 'no address' };
  const bracketed = /^\[(.*)\]$/.exec(v);
  if (bracketed) v = bracketed[1].trim();
  // Casper never matches a listed trailing dot, so it goes.
  if (v.endsWith('.')) v = v.slice(0, -1);
  if (v.includes('%')) return { skip: 'has a zone id (like %en0)' };
  if (isIPv6(v)) return { entry: v.toLowerCase(), shortName: false };
  if (/[*?[\]]/.test(v)) return { skip: 'a wildcard; Casper takes exact names' };
  if (!HOSTNAME.test(v)) return { skip: 'not an address or name Casper takes' };
  const entry = v.toLowerCase();
  return { entry, shortName: !entry.includes('.') && !IPV4.test(entry) };
}

export interface LabExport {
  /** The file: {"hosts": [...]} as JSON. */
  text: string;
  hosts: string[];
  skipped: { name: string; reason: string }[];
  /** Exported one-word names: Casper treats any inventory host with that name as lab. */
  shortNames: string[];
}

/** Every lab-tagged ssh/telnet host's address, checked like Casper's lab list. */
export function buildLabExport(folders: readonly SessionFolder[]): LabExport {
  const hosts: string[] = [];
  const skipped: { name: string; reason: string }[] = [];
  const shortNames: string[] = [];
  for (const folder of folders) {
    for (const item of folder.items) {
      if (!isLabHost(item)) continue;
      if (item.protocol !== 'ssh' && item.protocol !== 'telnet') {
        skipped.push({ name: item.name, reason: `${item.protocol}, no network address` });
        continue;
      }
      const r = labEntryFor(item.host);
      if ('skip' in r) {
        skipped.push({ name: item.name, reason: r.skip });
        continue;
      }
      if (hosts.includes(r.entry)) continue;
      if (hosts.length >= LAB_EXPORT_MAX) {
        skipped.push({ name: item.name, reason: `Casper takes at most ${LAB_EXPORT_MAX}` });
        continue;
      }
      hosts.push(r.entry);
      if (r.shortName) shortNames.push(r.entry);
    }
  }
  return { text: `${JSON.stringify({ hosts }, null, 2)}\n`, hosts, skipped, shortNames };
}

/** The line to type in Casper. Casper strips the quotes, so a path with spaces works. */
export function labImportCommand(path: string): string {
  return `/lab import "${path}"`;
}
