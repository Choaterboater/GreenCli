// Host import: turn a CSV file, SecureCRT sessions, Aruba Central / Juniper
// Mist inventory or ~/.ssh/config into saved-host candidates. Everything here
// is pure (API calls come in through an injected `request`), so the Import
// hosts dialog can run every source through one preview → dedupe → folder →
// save step, and the parsers are unit-tested without Tauri.
//
// Passwords are never imported from any source: CSV has no password column,
// and SecureCRT's encrypted password fields are ignored.

import { normalizeTags } from './tags';
import { ConnectionConfig, DeviceType } from '../types';
import { hostIdentity, parseHostSpec } from './hosts';
import type { ImportedHost } from './sshImport';

export type ImportSource = 'csv' | 'securecrt' | 'central' | 'mist' | 'ssh';

/** Folder a host lands in when its source doesn't put it in one. */
export const SOURCE_FOLDER: Record<ImportSource, string> = {
  csv: 'Imported',
  securecrt: 'SecureCRT',
  central: 'Aruba Central',
  mist: 'Juniper Mist',
  ssh: 'SSH config',
};

export interface ImportCandidate {
  name: string;
  protocol: 'ssh' | 'telnet' | 'serial';
  host?: string;
  port?: number;
  username?: string;
  serialPort?: string;
  baudRate?: number;
  dataBits?: number;
  parity?: string;
  stopBits?: number;
  deviceType: DeviceType;
  /** Folder in the source (nested SecureCRT folders read "Lab / Core"). */
  folder?: string;
  tags: string[];
  keyPath?: string;
  jumpHost?: string;
  jumpPort?: number;
  jumpUsername?: string;
  /** Things worth knowing about this host, shown on its preview row. */
  notes: string[];
}

/** A row / session / device that can't be imported, and why. */
export interface ImportProblem {
  /** Where it came from: "Line 7", "Lab/sw1.ini", "Switch IDF-2". */
  where: string;
  message: string;
}

export interface ImportParse {
  hosts: ImportCandidate[];
  problems: ImportProblem[];
}

const isObj = (x: unknown): x is Record<string, unknown> =>
  !!x && typeof x === 'object' && !Array.isArray(x);

/** A trimmed string field, or '' (numbers are stringified — some APIs send ids as numbers). */
function str(x: unknown): string {
  if (typeof x === 'string') return x.trim();
  if (typeof x === 'number' && Number.isFinite(x)) return String(x);
  return '';
}

function validPort(n: number | undefined): number | undefined {
  return n != null && Number.isInteger(n) && n >= 1 && n <= 65535 ? n : undefined;
}

// ─── Device type names ───

const TYPE_ALIASES: Record<string, DeviceType> = {
  cx: 'aruba-cx',
  'aos-cx': 'aruba-cx',
  aoscx: 'aruba-cx',
  'aruba-cx': 'aruba-cx',
  'aos-s': 'aruba-aos-s',
  aoss: 'aruba-aos-s',
  procurve: 'aruba-aos-s',
  provision: 'aruba-aos-s',
  'aruba-aos-s': 'aruba-aos-s',
  aos8: 'aruba-controller',
  'aos-8': 'aruba-controller',
  controller: 'aruba-controller',
  'mobility-controller': 'aruba-controller',
  mc: 'aruba-controller',
  gateway: 'aruba-controller',
  'aruba-controller': 'aruba-controller',
  instant: 'aruba-ap',
  iap: 'aruba-ap',
  ap: 'aruba-ap',
  'aruba-ap': 'aruba-ap',
  junos: 'juniper-junos',
  juniper: 'juniper-junos',
  ex: 'juniper-junos',
  qfx: 'juniper-junos',
  srx: 'juniper-junos',
  mx: 'juniper-junos',
  'juniper-junos': 'juniper-junos',
  mist: 'mist',
  generic: 'generic',
  normal: 'generic',
  other: 'generic',
};

/** Friendly type name ("cx", "aos-s", "IAP", "Junos", …) → DeviceType.
 *  Blank = generic; an unknown name = undefined so the caller can say so. */
export function deviceTypeFromName(raw: string | undefined): DeviceType | undefined {
  const key = (raw ?? '').trim().toLowerCase().replace(/[\s_]+/g, '-');
  if (!key) return 'generic';
  return TYPE_ALIASES[key];
}

// ─── CSV ───

export const CSV_COLUMNS = ['name', 'host', 'port', 'user', 'type', 'folder', 'tags', 'jump'] as const;

export const CSV_TEMPLATE = [
  CSV_COLUMNS.join(','),
  'core-sw-01,10.0.0.1,22,admin,cx,HQ / Core,core;hq,',
  'idf2-sw-01,10.0.10.21,22,manager,aos-s,HQ / Access,access;hq,',
  'mc-01,10.0.0.10,22,admin,aos8,HQ,wireless,',
  'branch12-srx,192.0.2.1,22,netops,junos,Branch 12,wan,netops@bastion.example.com',
  '"lab-sw, rack 4",lab-sw4.example.com,2222,,generic,Lab,,',
  '',
].join('\r\n');

/** Header spellings accepted for each column (compared without case, spaces,
 *  '-' or '_'). Earlier entries win when a file has several. */
const COLUMN_ALIASES: Record<string, string[]> = {
  name: ['name', 'devicename', 'sessionname'],
  host: ['host', 'address', 'ip', 'ipaddress', 'mgmtip', 'hostname'],
  port: ['port'],
  user: ['user', 'username', 'login'],
  type: ['type', 'devicetype', 'device'],
  folder: ['folder', 'group', 'site'],
  tags: ['tags', 'tag', 'labels'],
  jump: ['jump', 'jumphost', 'proxyjump', 'bastion'],
  protocol: ['protocol'],
};

const normHeader = (h: string) => h.trim().toLowerCase().replace(/[\s_-]+/g, '');

/** Excel saves "CSV" with ';' in some locales and pastes as tabs — use
 *  whichever separator the header row has most of. */
function detectDelimiter(text: string): string {
  const header = text.split(/\r\n|\n|\r/, 1)[0] ?? '';
  let best = ',';
  let bestCount = 0;
  for (const d of [',', ';', '\t']) {
    const count = header.split(d).length - 1;
    if (count > bestCount) {
      best = d;
      bestCount = count;
    }
  }
  return best;
}

/**
 * Split CSV text into records, RFC 4180 style: quoted fields may contain the
 * separator, line breaks and "" for a quote. Each record carries the 1-based
 * line it starts on (for error messages). Blank lines are dropped.
 */
export function parseCsv(input: string, delimiter?: string): { line: number; cells: string[] }[] {
  const text = input.replace(/^\uFEFF/, '');
  const sep = delimiter ?? detectDelimiter(text);
  const records: { line: number; cells: string[] }[] = [];
  let cells: string[] = [];
  let cell = '';
  let quoted = false;
  let line = 1;
  let startLine = 1;

  const endRecord = () => {
    cells.push(cell);
    if (cells.some((c) => c.trim() !== '')) records.push({ line: startLine, cells });
    cells = [];
    cell = '';
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        if (ch === '\n') line++;
        cell += ch;
      }
    } else if (ch === '"' && cell.trim() === '') {
      // A quote only opens a quoted field at its start (after optional spaces).
      quoted = true;
      cell = '';
    } else if (ch === sep) {
      cells.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      endRecord();
      line++;
      startLine = line;
    } else {
      cell += ch;
    }
  }
  if (cell !== '' || cells.length > 0) endRecord();
  return records;
}

/** CSV (header row required) → hosts. Columns: name, host, port, user, type,
 *  folder, tags (separated by ';'), jump — plus an optional protocol column
 *  (ssh / telnet). */
export function parseHostsCsv(text: string): ImportParse {
  const hosts: ImportCandidate[] = [];
  const problems: ImportProblem[] = [];
  const rows = parseCsv(text);
  if (rows.length === 0) {
    return { hosts, problems: [{ where: 'File', message: 'The file is empty.' }] };
  }

  const header = rows[0].cells.map(normHeader);
  const col: Record<string, number> = {};
  for (const [key, aliases] of Object.entries(COLUMN_ALIASES)) {
    for (const alias of aliases) {
      const idx = header.indexOf(alias);
      if (idx >= 0 && !Object.values(col).includes(idx)) {
        col[key] = idx;
        break;
      }
    }
  }
  if (col.host == null) {
    return {
      hosts,
      problems: [
        {
          where: `Line ${rows[0].line}`,
          message: `No "host" column. The first row must name the columns: ${CSV_COLUMNS.join(', ')}.`,
        },
      ],
    };
  }
  if (header.some((h) => /^(password|passwd|pass|secret)$/.test(h))) {
    problems.push({ where: 'Header', message: 'The password column was ignored — passwords are never imported.' });
  }

  for (const row of rows.slice(1)) {
    const get = (key: string) => (col[key] != null ? (row.cells[col[key]] ?? '').trim() : '');
    const where = `Line ${row.line}`;
    const notes: string[] = [];

    const rawHost = get('host');
    if (!rawHost) {
      problems.push({ where, message: 'Missing host.' });
      continue;
    }
    // "admin@10.0.0.1:2222" in the host cell is fine; the port / user
    // columns win when both are given.
    const spec = parseHostSpec(rawHost);
    if (!spec.host || /\s/.test(spec.host)) {
      problems.push({ where, message: `"${rawHost}" is not a host name or address.` });
      continue;
    }

    const proto = get('protocol').toLowerCase();
    let protocol: 'ssh' | 'telnet';
    if (proto === '' || proto === 'ssh' || proto === 'ssh2') protocol = 'ssh';
    else if (proto === 'telnet') protocol = 'telnet';
    else {
      problems.push({ where, message: `Protocol "${get('protocol')}" isn't supported (use ssh or telnet).` });
      continue;
    }

    const rawPort = get('port');
    let port = spec.port ?? (protocol === 'telnet' ? 23 : 22);
    if (rawPort) {
      const p = /^\d+$/.test(rawPort) ? validPort(Number(rawPort)) : undefined;
      if (!p) {
        problems.push({ where, message: `Bad port "${rawPort}" (use 1–65535).` });
        continue;
      }
      port = p;
    }

    const rawType = get('type');
    let deviceType = deviceTypeFromName(rawType);
    if (!deviceType) {
      notes.push(`Unknown type "${rawType}" — saved as Normal Device.`);
      deviceType = 'generic';
    }

    const host: ImportCandidate = {
      name: get('name') || spec.host,
      protocol,
      host: spec.host,
      port,
      username: get('user') || spec.user,
      deviceType,
      folder: get('folder') || undefined,
      tags: normalizeTags(get('tags').split(';')),
      notes,
    };

    const jump = get('jump');
    if (jump) {
      const j = parseHostSpec(jump);
      if (protocol !== 'ssh') notes.push('Jump host only applies to SSH — ignored.');
      else if (!j.host) notes.push(`Jump host "${jump}" not understood — ignored.`);
      else {
        host.jumpHost = j.host;
        host.jumpPort = j.port;
        host.jumpUsername = j.user;
      }
    }
    hosts.push(host);
  }
  if (rows.length === 1) problems.push({ where: 'File', message: 'Only a header row — no hosts in the file.' });
  return { hosts, problems };
}

// ─── SecureCRT ───

/** One SecureCRT session's settings, keys lower-cased. */
export interface SecureCrtSettings {
  strings: Record<string, string>;
  dwords: Record<string, number>;
}

/**
 * Read a SecureCRT session .ini: `S:"Key"=text` strings and `D:"Key"=0000xxxx`
 * DWORDs, which SecureCRT writes as 8 hex digits (port 22 is `00000016`).
 * Multi-line `Z:`/`B:` blocks are skipped.
 */
export function parseSecureCrtIni(text: string): SecureCrtSettings {
  const strings: Record<string, string> = {};
  const dwords: Record<string, number> = {};
  for (const raw of text.replace(/^\uFEFF/, '').split(/\r\n|\n|\r/)) {
    const m = /^([SD]):"([^"]+)"=(.*)$/.exec(raw);
    if (!m) continue;
    const key = m[2].toLowerCase();
    if (m[1] === 'S') strings[key] = m[3].trim();
    else if (/^[0-9a-f]{1,8}$/i.test(m[3].trim())) dwords[key] = parseInt(m[3].trim(), 16);
  }
  return { strings, dwords };
}

const SERIAL_PARITY = ['none', 'odd', 'even', 'mark', 'space'];

/** One SecureCRT session (from an .ini or the XML export) → a host. */
function secureCrtHost(
  name: string,
  folder: string,
  where: string,
  s: SecureCrtSettings,
): { host?: ImportCandidate; problem?: ImportProblem } {
  const get = (k: string) => (s.strings[k.toLowerCase()] ?? '').trim();
  const num = (k: string) => s.dwords[k.toLowerCase()];
  const notes: string[] = [];
  const base = { name, folder: folder || undefined, deviceType: 'generic' as DeviceType, tags: [], notes };
  // New SecureCRT sessions default to SSH2, so a file without the key is SSH2.
  const protoName = get('Protocol Name') || 'SSH2';
  const proto = protoName.toLowerCase();

  if (proto === 'serial') {
    const serialPort = get('Com Port');
    if (!serialPort) return { problem: { where, message: 'Serial session without a port.' } };
    const parityCode = num('Parity') ?? 0;
    let parity = SERIAL_PARITY[parityCode] ?? 'none';
    if (parity === 'mark' || parity === 'space') {
      notes.push(`${parity} parity isn't supported — set to none.`);
      parity = 'none';
    }
    // SecureCRT stores stop bits as 0 = 1, 1 = 1.5, 2 = 2.
    const stopCode = num('Stop Bits') ?? 0;
    if (stopCode === 1) notes.push("1.5 stop bits isn't supported — set to 1.");
    const dataBits = num('Data Bits');
    return {
      host: {
        ...base,
        protocol: 'serial',
        serialPort,
        baudRate: num('Baud Rate') || 9600,
        dataBits: dataBits && dataBits >= 5 && dataBits <= 8 ? dataBits : 8,
        parity,
        stopBits: stopCode === 2 ? 2 : 1,
      },
    };
  }

  let protocol: 'ssh' | 'telnet';
  let port: number | undefined;
  if (proto === 'ssh2' || proto === 'ssh1') {
    protocol = 'ssh';
    port = validPort(num(`[${protoName.toUpperCase()}] Port`)) ?? 22;
    if (proto === 'ssh1') notes.push('SSH1 session — will connect with SSH2.');
  } else if (proto === 'telnet') {
    protocol = 'telnet';
    port = validPort(num('Port')) ?? 23;
  } else {
    return { problem: { where, message: `${protoName} sessions aren't supported.` } };
  }

  const host = get('Hostname');
  if (!host) return { problem: { where, message: 'No hostname.' } };

  // SecureCRT's "Firewall" is a proxy or a jump through another session. It
  // can't be carried over as-is, so say so rather than silently drop it.
  const firewall = get('Firewall Name');
  if (firewall && firewall.toLowerCase() !== 'none') {
    notes.push(`Uses firewall / jump "${firewall}" in SecureCRT — not imported; set a jump host after import.`);
  }

  return {
    host: {
      ...base,
      protocol,
      host,
      port,
      username: get('Username') || undefined,
    },
  };
}

/** SecureCRT session files (paths relative to the Sessions folder) → hosts.
 *  Nested folders keep their full path, "Lab / Core", so two "Core" folders
 *  under different sites stay apart in the (flat) sidebar. */
export function parseSecureCrtFiles(files: { path: string; text: string }[]): ImportParse {
  const hosts: ImportCandidate[] = [];
  const problems: ImportProblem[] = [];
  for (const f of files) {
    const parts = f.path.split(/[\\/]/).filter(Boolean);
    const file = parts.pop() ?? f.path;
    const name = file.replace(/\.ini$/i, '');
    const r = secureCrtHost(name, parts.join(' / '), f.path, parseSecureCrtIni(f.text));
    if (r.host) hosts.push(r.host);
    if (r.problem) problems.push(r.problem);
  }
  return { hosts, problems };
}

/** A DWORD from the XML export: decimal there, but accept the .ini's
 *  8-digit hex form too in case a tool wrote that. */
function xmlDword(text: string): number | undefined {
  const t = text.trim();
  if (/^0[0-9a-f]{7}$/i.test(t)) return parseInt(t, 16);
  if (/^\d+$/.test(t)) return Number(t);
  return undefined;
}

/**
 * SecureCRT's XML export (File ▸ Export Settings) → hosts. Sessions live under
 * <key name="Sessions">; a <key> holding a "Hostname" or "Protocol Name" value
 * is a session, any other <key> is a folder.
 */
export function parseSecureCrtXml(xml: string): ImportParse {
  const hosts: ImportCandidate[] = [];
  const problems: ImportProblem[] = [];
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length > 0) {
    return { hosts, problems: [{ where: 'File', message: 'Not a valid XML file.' }] };
  }
  const childKeys = (el: Element) => Array.from(el.children).filter((c) => c.tagName === 'key');
  const sessionsKey = childKeys(doc.documentElement).find((k) => k.getAttribute('name') === 'Sessions');
  if (!sessionsKey) {
    return {
      hosts,
      problems: [{ where: 'File', message: 'No sessions in this file. Export with File ▸ Export Settings and include Sessions.' }],
    };
  }

  const settingsOf = (el: Element): SecureCrtSettings | null => {
    const strings: Record<string, string> = {};
    const dwords: Record<string, number> = {};
    for (const c of Array.from(el.children)) {
      const name = c.getAttribute('name')?.toLowerCase();
      if (!name) continue;
      if (c.tagName === 'string') strings[name] = c.textContent ?? '';
      else if (c.tagName === 'dword') {
        const n = xmlDword(c.textContent ?? '');
        if (n != null) dwords[name] = n;
      }
    }
    return 'hostname' in strings || 'protocol name' in strings ? { strings, dwords } : null;
  };

  const walk = (el: Element, folders: string[]) => {
    for (const k of childKeys(el)) {
      const name = k.getAttribute('name') ?? '';
      if (name === '__FolderData__' || (folders.length === 0 && name === 'Default')) continue;
      const settings = settingsOf(k);
      if (settings) {
        const where = [...folders, name].join('/');
        const r = secureCrtHost(name, folders.join(' / '), where, settings);
        if (r.host) hosts.push(r.host);
        if (r.problem) problems.push(r.problem);
      } else {
        walk(k, [...folders, name]);
      }
    }
  };
  walk(sessionsKey, []);
  return { hosts, problems };
}

// ─── ~/.ssh/config ───

export function sshConfigToHosts(entries: ImportedHost[]): ImportParse {
  return {
    hosts: entries.map((h) => {
      const jump = h.jumpHost ? parseHostSpec(h.jumpHost) : undefined;
      return {
        name: h.name,
        protocol: 'ssh',
        host: h.host,
        port: h.port,
        username: h.username,
        keyPath: h.identityFile,
        deviceType: 'generic',
        tags: [],
        jumpHost: jump?.host,
        jumpPort: jump?.port,
        jumpUsername: jump?.user,
        notes: [],
      };
    }),
    problems: [],
  };
}

// ─── Cloud inventory (Aruba Central, Juniper Mist) ───

/** The central_request / mist_request commands: { status, body } for any reply. */
export type ApiRequest = (method: string, path: string) => Promise<{ status: number; body: unknown }>;

/** Readable error for a non-2xx reply — the APIs use different fields. */
export function apiErrorText(status: number, body: unknown): string {
  let detail = '';
  if (isObj(body)) {
    for (const k of ['error_description', 'description', 'message', 'detail', 'error']) {
      const v = str(body[k]);
      if (v) {
        detail = v;
        break;
      }
    }
  } else if (typeof body === 'string') {
    detail = body.trim().slice(0, 200);
  }
  if (status === 401) return `Sign-in rejected (HTTP 401) — the token may have expired.${detail ? ` ${detail}` : ''}`;
  if (status === 403) return `Not allowed for this account (HTTP 403).${detail ? ` ${detail}` : ''}`;
  return `HTTP ${status}${detail ? `: ${detail}` : ''}`;
}

const MAX_PAGES = 50;

export type CentralKind = 'switch' | 'ap' | 'gateway';

// Classic Central monitoring APIs. Each allows up to 1000 rows per page.
export const CENTRAL_LISTS: Record<CentralKind, { path: string; listKey: string; label: string }> = {
  switch: { path: '/monitoring/v1/switches', listKey: 'switches', label: 'Switch' },
  ap: { path: '/monitoring/v2/aps', listKey: 'aps', label: 'Access point' },
  gateway: { path: '/monitoring/v1/gateways', listKey: 'gateways', label: 'Gateway' },
};
const CENTRAL_PAGE = 1000;

/** AOS-CX vs AOS-S for a Central switch: Central says so in `switch_type`;
 *  older replies only have the model ("Aruba 6300M 48G …", "Aruba2930F-24G …"). */
export function centralSwitchType(row: Record<string, unknown>): DeviceType {
  const t = str(row.switch_type).toUpperCase();
  if (t.includes('CX')) return 'aruba-cx';
  if (t.includes('AOS-S') || t === 'AOSS') return 'aruba-aos-s';
  const model = str(row.model);
  if (/\bCX\b/i.test(model) || /(?:^|\D)(4100i|6[0-4]\d{2}|8[1-4]\d{2}|9300|10000)(?:\D|$)/i.test(model)) {
    return 'aruba-cx';
  }
  if (/(?:^|\D)(25[34]0|26[12]0|29[123]0|3800|3810|54\d{2})(?:\D|$)/.test(model)) return 'aruba-aos-s';
  return 'generic';
}

/** Central labels come as names or as { label_name } objects depending on the API. */
function labelNames(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((l) => (isObj(l) ? str(l.label_name) || str(l.name) : str(l))).filter(Boolean);
}

/** Central monitoring rows → hosts. Site → folder; group + labels → tags. */
export function centralDevicesToHosts(kind: CentralKind, rows: unknown[]): ImportParse {
  const hosts: ImportCandidate[] = [];
  const problems: ImportProblem[] = [];
  const { label } = CENTRAL_LISTS[kind];
  for (const row of rows) {
    if (!isObj(row)) continue;
    const name = str(row.name) || str(row.serial) || str(row.macaddr) || 'unnamed';
    const ip = str(row.ip_address);
    if (!ip) {
      problems.push({ where: `${label} ${name}`, message: 'No IP address in Central (offline?) — skipped.' });
      continue;
    }
    const deviceType: DeviceType =
      kind === 'switch' ? centralSwitchType(row) : kind === 'ap' ? 'aruba-ap' : 'aruba-controller';
    hosts.push({
      name,
      protocol: 'ssh',
      host: ip,
      port: 22,
      deviceType,
      folder: str(row.site) || undefined,
      tags: normalizeTags([str(row.group_name), ...labelNames(row.labels)]),
      notes: [],
    });
  }
  return { hosts, problems };
}

async function fetchCentralList(request: ApiRequest, kind: CentralKind): Promise<unknown[]> {
  const { path, listKey } = CENTRAL_LISTS[kind];
  const all: unknown[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const { status, body } = await request('GET', `${path}?limit=${CENTRAL_PAGE}&offset=${page * CENTRAL_PAGE}`);
    if (status < 200 || status >= 300) throw new Error(apiErrorText(status, body));
    const rows = isObj(body) ? body[listKey] : undefined;
    if (!Array.isArray(rows)) throw new Error(`Unexpected reply from ${path}.`);
    all.push(...rows);
    const total = isObj(body) && typeof body.total === 'number' ? body.total : undefined;
    if (rows.length < CENTRAL_PAGE || (total != null && all.length >= total)) break;
  }
  return all;
}

/** Switches, APs and gateways from Aruba Central. One list failing (e.g. no
 *  gateway permission) is reported and the others still load. */
export async function fetchCentralHosts(request: ApiRequest): Promise<ImportParse> {
  const out: ImportParse = { hosts: [], problems: [] };
  const failures: string[] = [];
  for (const kind of ['switch', 'ap', 'gateway'] as CentralKind[]) {
    try {
      const r = centralDevicesToHosts(kind, await fetchCentralList(request, kind));
      out.hosts.push(...r.hosts);
      out.problems.push(...r.problems);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      failures.push(message);
      out.problems.push({ where: `${CENTRAL_LISTS[kind].label} list`, message });
    }
  }
  // Every list failing is one problem (bad token, wrong region), not three.
  if (failures.length === 3) throw new Error(failures[0]);
  return out;
}

export interface MistScopes {
  orgs: { id: string; name: string }[];
  /** Sites the token reaches without org access. */
  sites: { id: string; name: string }[];
}

/** Which orgs / sites a Mist token can read, from GET /api/v1/self. Sites of
 *  an org already covered are dropped (the org listing includes them). */
export function mistScopes(self: unknown): MistScopes {
  const orgs = new Map<string, string>();
  const sites: { id: string; name: string; orgId: string }[] = [];
  const privileges = isObj(self) && Array.isArray(self.privileges) ? self.privileges : [];
  for (const p of privileges) {
    if (!isObj(p)) continue;
    const scope = str(p.scope);
    if (scope === 'org' && str(p.org_id)) orgs.set(str(p.org_id), str(p.name) || str(p.org_id));
    if (scope === 'site' && str(p.site_id)) {
      sites.push({ id: str(p.site_id), name: str(p.name) || str(p.site_id), orgId: str(p.org_id) });
    }
  }
  return {
    orgs: [...orgs].map(([id, name]) => ({ id, name })),
    sites: sites.filter((s) => !orgs.has(s.orgId)).map(({ id, name }) => ({ id, name })),
  };
}

/** Mist device stats → hosts. Site → folder. Switches (EX/QFX) and SRX
 *  gateways run Junos; Mist APs have no CLI, so they're left out unless asked. */
export function mistDevicesToHosts(
  devices: unknown[],
  siteNames: Record<string, string>,
  opts: { includeAps: boolean },
): ImportParse {
  const hosts: ImportCandidate[] = [];
  const problems: ImportProblem[] = [];
  let skippedAps = 0;
  for (const d of devices) {
    if (!isObj(d)) continue;
    const type = str(d.type) || 'ap';
    if (type === 'ap' && !opts.includeAps) {
      skippedAps++;
      continue;
    }
    const label = type === 'switch' ? 'Switch' : type === 'gateway' ? 'Gateway' : 'Access point';
    const name = str(d.name) || str(d.hostname) || str(d.mac) || 'unnamed';
    const ip = str(d.ip) || (isObj(d.ip_stat) ? str(d.ip_stat.ip) : '');
    if (!ip) {
      problems.push({ where: `${label} ${name}`, message: 'No management IP reported by Mist (offline?) — skipped.' });
      continue;
    }
    const model = str(d.model);
    const notes: string[] = [];
    let deviceType: DeviceType = 'juniper-junos';
    if (type === 'ap') {
      deviceType = 'mist';
      notes.push('Mist APs have no CLI to log in to.');
    } else if (type === 'gateway' && /^SSR/i.test(model)) {
      // Session Smart Routers run their own CLI, not Junos.
      deviceType = 'generic';
    }
    hosts.push({
      name,
      protocol: 'ssh',
      host: ip,
      port: 22,
      deviceType,
      folder: siteNames[str(d.site_id)] || undefined,
      tags: [],
      notes,
    });
  }
  if (skippedAps > 0) {
    problems.push({
      where: 'Access points',
      message: `${skippedAps} left out — Mist APs have no CLI. Tick "Include access points" to list them.`,
    });
  }
  return { hosts, problems };
}

async function mistGet(request: ApiRequest, path: string): Promise<unknown> {
  const { status, body } = await request('GET', path);
  if (status < 200 || status >= 300) throw new Error(apiErrorText(status, body));
  return body;
}

const MIST_PAGE = 1000;

async function mistDeviceStats(request: ApiRequest, path: string): Promise<unknown[]> {
  const all: unknown[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const body = await mistGet(request, `${path}?type=all&limit=${MIST_PAGE}&page=${page}`);
    if (!Array.isArray(body)) throw new Error(`Unexpected reply from ${path}.`);
    all.push(...body);
    if (body.length < MIST_PAGE) break;
  }
  return all;
}

/** Switches and gateways (and optionally APs) from every Mist org / site the
 *  token can read. Device stats carry the management IP; inventory doesn't. */
export async function fetchMistHosts(request: ApiRequest, opts: { includeAps: boolean }): Promise<ImportParse> {
  const scopes = mistScopes(await mistGet(request, '/api/v1/self'));
  if (scopes.orgs.length === 0 && scopes.sites.length === 0) {
    throw new Error('This Mist token has no organization or site access.');
  }
  const out: ImportParse = { hosts: [], problems: [] };
  for (const org of scopes.orgs) {
    const siteNames: Record<string, string> = {};
    try {
      const sites = await mistGet(request, `/api/v1/orgs/${org.id}/sites?limit=1000`);
      for (const s of Array.isArray(sites) ? sites : []) {
        if (isObj(s) && str(s.id)) siteNames[str(s.id)] = str(s.name);
      }
    } catch (e) {
      // Without site names hosts still import, just without folders.
      out.problems.push({ where: `Org ${org.name}`, message: `Site names unavailable: ${e instanceof Error ? e.message : e}` });
    }
    const r = mistDevicesToHosts(await mistDeviceStats(request, `/api/v1/orgs/${org.id}/stats/devices`), siteNames, opts);
    out.hosts.push(...r.hosts);
    out.problems.push(...r.problems);
  }
  for (const site of scopes.sites) {
    const r = mistDevicesToHosts(
      await mistDeviceStats(request, `/api/v1/sites/${site.id}/stats/devices`),
      { [site.id]: site.name },
      opts,
    );
    out.hosts.push(...r.hosts);
    out.problems.push(...r.problems);
  }
  return out;
}

// ─── Preview + save helpers ───

export type RowStatus = 'new' | 'saved' | 'duplicate';

type IdentityFields = Pick<ConnectionConfig, 'protocol' | 'host' | 'port' | 'username' | 'serialPort' | 'baudRate'>;

/** Dedupe key: host + port + user (hosts.ts) for network hosts; a serial
 *  console has no host, so it is its port name + speed. */
export function importIdentity(h: Partial<IdentityFields>): string {
  if (h.protocol === 'serial') return `serial|${(h.serialPort ?? '').trim().toLowerCase()}|${h.baudRate ?? ''}`;
  return hostIdentity(h);
}

/** Per candidate: new, already saved, or a repeat of an earlier row. */
export function importStatuses(candidates: ImportCandidate[], saved: Partial<IdentityFields>[]): RowStatus[] {
  const savedIds = new Set(saved.map(importIdentity));
  const seen = new Set<string>();
  return candidates.map((c) => {
    const id = importIdentity(c);
    if (savedIds.has(id)) return 'saved';
    if (seen.has(id)) return 'duplicate';
    seen.add(id);
    return 'new';
  });
}

export type FolderMode = 'source' | 'single';

/** The sidebar folder a host goes to. */
export function targetFolder(
  c: Pick<ImportCandidate, 'folder'>,
  mode: FolderMode,
  source: ImportSource,
  singleName: string,
): string {
  if (mode === 'single') return singleName.trim() || SOURCE_FOLDER[source];
  return c.folder?.trim() || SOURCE_FOLDER[source];
}

/** An existing folder with this name (case-insensitive), so a re-import fills
 *  the folder it made last time instead of creating a twin. */
export function findFolderId(folders: { id: string; name: string }[], name: string): string | undefined {
  const want = name.trim().toLowerCase();
  return folders.find((f) => f.name.trim().toLowerCase() === want)?.id;
}

/** The saved host for a candidate (never carries a password). */
export function candidateToConfig(c: ImportCandidate, id: string): ConnectionConfig {
  const serial = c.protocol === 'serial';
  const ssh = c.protocol === 'ssh';
  return {
    id,
    name: c.name,
    protocol: c.protocol,
    host: serial ? undefined : c.host,
    port: serial ? undefined : c.port,
    username: serial ? undefined : c.username,
    authType: ssh && c.keyPath ? 'key' : 'password',
    keyPath: ssh ? c.keyPath : undefined,
    deviceType: c.deviceType,
    tags: c.tags.length > 0 ? c.tags : undefined,
    serialPort: serial ? c.serialPort : undefined,
    baudRate: serial ? c.baudRate : undefined,
    dataBits: serial ? c.dataBits : undefined,
    parity: serial ? c.parity : undefined,
    stopBits: serial ? c.stopBits : undefined,
    jumpHost: ssh ? c.jumpHost : undefined,
    jumpPort: ssh && c.jumpHost ? c.jumpPort : undefined,
    jumpUsername: ssh && c.jumpHost ? c.jumpUsername : undefined,
  };
}
