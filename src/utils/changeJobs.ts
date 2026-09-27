// Change Jobs: push one config change to many devices safely — per-device
// variables, a dry run, a mandatory canary pause, vendor rollback timers and a
// run that stops at the first device error. This file is the pure part
// (parsing, plans, the device and job runners over injected IO) so every rule
// is testable without a live session; ChangeJobs.tsx supplies the terminal IO.

import type { ConnectionConfig, DeviceType, Session, SessionFolder } from '../types';
import { isRiskyCommand } from './commandRisk';
import {
  ENTER_CONFIG,
  hasDeviceError,
  isDangerousLine,
  looksLikeQuestion,
  prepareSendLines,
  type SendResult,
} from './configSafety';
import { endsAtPager } from './paging';

// ─── CSV ───

/**
 * Parse pasted/loaded CSV into rows of trimmed cells. Handles quoted fields
 * ("" escapes, commas and newlines inside quotes), a UTF-8 BOM (Excel's CSV
 * export), and picks the delimiter from the first line: tab when pasted
 * straight from a spreadsheet, `;` from European Excel, else `,`.
 */
export function parseCsv(input: string): string[][] {
  const text = input.replace(/^\uFEFF/, '');
  const first = text.split(/\r?\n/).find((l) => l.trim()) ?? '';
  const count = (ch: string) => first.split(ch).length - 1;
  const delim = count('\t') > 0 ? '\t' : count(';') > count(',') ? ';' : ',';

  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false; // this field was quoted: keep its spaces
  let inQuotes = false;
  const endField = () => {
    row.push(quoted ? field : field.trim());
    field = '';
    quoted = false;
  };
  const endRow = () => {
    endField();
    if (row.some((c) => c !== '')) rows.push(row);
    row = [];
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c !== '"') field += c;
      else if (text[i + 1] === '"') {
        field += '"';
        i++;
      } else inQuotes = false;
    } else if (c === '"' && field.trim() === '') {
      inQuotes = true;
      quoted = true;
      field = '';
    } else if (c === delim) endField();
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      endRow();
    } else field += c;
  }
  if (field !== '' || row.length) endRow();
  return rows;
}

/** Neutralize a leading formula character so device text can't run as a
 *  formula when the CSV is opened in Excel/Sheets (same rule as Bulk Runner). */
export function csvCell(value: string): string {
  const safe = /^\s*[=+\-@]/.test(value) || /^[\t\r]/.test(value) ? `'${value}` : value;
  return `"${safe.replace(/"/g, '""')}"`;
}

export function toCsv(rows: string[][]): string {
  return rows.map((r) => r.map(csvCell).join(',')).join('\n');
}

// ─── Variables ───

// `${vlan}`, `${mgmt_ip}`, `${site.name}` — no spaces, so a CSV header can't
// silently fail to match what the block says.
const VAR_NAME = /^[A-Za-z_][\w.-]*$/;
const PLACEHOLDER = /\$\{([^}]*)\}/g;

/** Values every device has without a table (a CSV column of the same name wins). */
export const BUILTIN_VARIABLES = ['name', 'host'];

export interface VariableTable {
  /** Header of the first column (device name or host). */
  keyColumn: string;
  /** Variable names from the header, first column included. */
  columns: string[];
  /** Lower-cased device name/host → lower-cased variable name → value. */
  rows: Map<string, Record<string, string>>;
  errors: string[];
}

/**
 * The per-device variables table: first column = device name or host, header
 * row = variable names. Problems are collected (not thrown) so the dry run can
 * show all of them at once.
 */
export function parseVariableTable(text: string): VariableTable {
  const table: VariableTable = { keyColumn: '', columns: [], rows: new Map(), errors: [] };
  const rows = parseCsv(text);
  if (rows.length === 0) return table;
  const [header, ...data] = rows;
  table.keyColumn = header[0] || 'device';
  table.columns = header;
  const seen = new Set<string>();
  header.forEach((h, i) => {
    if (!h) table.errors.push(`Column ${i + 1} of the header has no name.`);
    else if (!VAR_NAME.test(h))
      table.errors.push(`Column "${h}" can't be a variable name — use letters, numbers, _ . or - (no spaces).`);
    else if (seen.has(h.toLowerCase())) table.errors.push(`Column "${h}" appears twice in the header.`);
    seen.add(h.toLowerCase());
  });
  data.forEach((cells, r) => {
    const line = r + 2; // 1-based, after the header
    const key = (cells[0] ?? '').toLowerCase();
    if (!key) {
      table.errors.push(`Row ${line} has no device in the first column.`);
      return;
    }
    if (cells.length > header.length) {
      table.errors.push(`Row ${line} (${cells[0]}) has more values than the header has columns.`);
    }
    if (table.rows.has(key)) {
      table.errors.push(`"${cells[0]}" has more than one row.`);
      return;
    }
    const values: Record<string, string> = {};
    header.forEach((h, i) => {
      if (h) values[h.toLowerCase()] = cells[i] ?? '';
    });
    table.rows.set(key, values);
  });
  return table;
}

/** The placeholder names used in `text`, in order of first use (as written). */
export function findVariables(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(PLACEHOLDER)) {
    const name = m[1].trim();
    if (!seen.has(name.toLowerCase())) {
      seen.add(name.toLowerCase());
      out.push(name);
    }
  }
  return out;
}

/** Fill `${var}` placeholders (names match case-insensitively). An empty value
 *  counts as missing: a blank VLAN id would send a broken line. */
export function substitute(
  text: string,
  values: Record<string, string>
): { text: string; missing: string[] } {
  const missing: string[] = [];
  const out = text.replace(PLACEHOLDER, (whole, raw: string) => {
    const name = raw.trim();
    const v = values[name.toLowerCase()];
    if (v == null || v === '') {
      if (!missing.includes(name)) missing.push(name);
      return whole;
    }
    return v;
  });
  return { text: out, missing };
}

/** A device's variables: built-ins, then its table row (matched on name, then
 *  host). `row` is null when the table has no row for it. */
export function deviceVariables(
  table: VariableTable | null,
  device: { name: string; host?: string }
): { values: Record<string, string>; row: Record<string, string> | null } {
  const values: Record<string, string> = { name: device.name, host: device.host ?? '' };
  const row =
    table?.rows.get(device.name.toLowerCase()) ??
    (device.host ? table?.rows.get(device.host.toLowerCase()) : undefined) ??
    null;
  return { values: { ...values, ...(row ?? {}) }, row };
}

// ─── Checks ───

export interface CheckSpec {
  command: string;
  /** Optional expectation on the output: `=> text` (must appear) or
   *  `!=> text` (must not appear). */
  expect?: { text: string; absent: boolean };
}

/** Show commands, one per line, with an optional `=> text` / `!=> text`. */
export function parseChecks(text: string): CheckSpec[] {
  return prepareSendLines(text).map(({ text: line }) => {
    const m = line.match(/^(.*?)\s+(!?)=>\s*(.*)$/);
    if (!m || !m[1].trim()) return { command: line };
    const want = m[3].trim();
    return want ? { command: m[1].trim(), expect: { text: want, absent: m[2] === '!' } } : { command: m[1].trim() };
  });
}

/** The command's own output: without the echoed command line and the
 *  trailing prompt, so neither can trip the error or expectation match. */
export function checkBody(output: string, sent: string): string {
  const lines = output.split('\n');
  const squash = (s: string) => s.replace(/\s+/g, '');
  if (lines.length && sent && squash(lines[0]).includes(squash(sent))) lines.shift();
  const last = (lines[lines.length - 1] ?? '').trimEnd();
  if (lines.length && /[#>$%]$/.test(last) && last.length <= 200) lines.pop();
  return lines.join('\n');
}

export function evaluateCheck(
  spec: CheckSpec,
  output: string,
  sent: string = spec.command
): { ok: boolean; reason?: string } {
  if (!output.trim()) return { ok: false, reason: 'no response' };
  const body = checkBody(output, sent);
  if (hasDeviceError(body)) {
    const line = body.split('\n').find((l) => hasDeviceError(l)) ?? '';
    return { ok: false, reason: `the device rejected it${line.trim() ? `: ${line.trim()}` : ''}` };
  }
  if (!spec.expect) return { ok: true };
  if (endsAtPager(output)) return { ok: false, reason: 'the output stopped at a --More-- prompt' };
  const found = body.toLowerCase().includes(spec.expect.text.toLowerCase());
  if (spec.expect.absent && found) return { ok: false, reason: `"${spec.expect.text}" is in the output` };
  if (!spec.expect.absent && !found) return { ok: false, reason: `"${spec.expect.text}" is not in the output` };
  return { ok: true };
}

// ─── Vendors ───

/** What protects the change: Junos `commit confirmed`, AOS-CX `checkpoint
 *  auto`, or nothing (the change is live line by line). */
export type SafetyWrapper = 'commit-confirmed' | 'checkpoint' | 'none';

export interface VendorSteps {
  label: string;
  /** The rollback timer this vendor supports. */
  wrapper: SafetyWrapper;
  /** Enters config mode; null = the block is sent exactly as written. */
  enter: string | null;
  /** Leaves config mode (and applies, for Instant APs). */
  exit: string[];
  /** Saves the running config; null when a commit already persists it. */
  save: string | null;
  /** Sent after a rejected line so the session isn't left in config mode
   *  (Junos also throws the uncommitted edits away). */
  abort: string[];
}

export function vendorSteps(deviceType: DeviceType): VendorSteps {
  switch (deviceType) {
    case 'aruba-cx':
      return { label: 'AOS-CX', wrapper: 'checkpoint', enter: 'configure terminal', exit: ['end'], save: 'write memory', abort: ['end'] };
    case 'aruba-aos-s':
      return { label: 'AOS-S', wrapper: 'none', enter: 'configure terminal', exit: ['end'], save: 'write memory', abort: ['end'] };
    case 'aruba-controller':
      return { label: 'ArubaOS 8', wrapper: 'none', enter: 'configure terminal', exit: ['end'], save: 'write memory', abort: ['end'] };
    case 'aruba-ap':
      // Instant stages config until `commit apply`; a rejected line exits
      // without applying anything.
      return { label: 'Instant AP', wrapper: 'none', enter: 'configure terminal', exit: ['end', 'commit apply'], save: null, abort: ['end'] };
    case 'juniper-junos':
    case 'mist':
      // `configure exclusive`: nobody else edits mid-change, and it refuses to
      // start over someone's uncommitted work (a plain commit would push it).
      // `exit configuration-mode` leaves from any [edit …] level.
      return {
        label: deviceType === 'mist' ? 'Junos (Mist)' : 'Junos',
        wrapper: 'commit-confirmed',
        enter: 'configure exclusive',
        exit: ['exit configuration-mode'],
        save: null,
        abort: ['top', 'rollback 0', 'exit configuration-mode'],
      };
    default:
      return { label: 'Normal device', wrapper: 'none', enter: null, exit: [], save: null, abort: [] };
  }
}

const JOB_COMMENT = 'GreenCLI change job';

// ─── Plans ───

export interface JobOptions {
  /** Use the vendor's rollback timer where there is one. */
  safetyWrapper: boolean;
  /** Minutes before an unconfirmed change rolls back (1–60). */
  confirmMinutes: number;
  /** Save the config once a device passes (where saving is a separate step). */
  save: boolean;
}

export const DEFAULT_JOB_OPTIONS: JobOptions = { safetyWrapper: true, confirmMinutes: 5, save: true };

export interface PlanLine {
  text: string;
  /** From the user's block (vs added by the job: configure, commit, save…). */
  fromBlock: boolean;
  /** Changes device state (commandRisk). */
  risky: boolean;
  /** Erases, reboots, shuts down or removes something (configSafety). */
  dangerous: boolean;
}

export interface DevicePlan {
  vendor: VendorSteps;
  /** The rollback timer in effect for this device. */
  wrapper: SafetyWrapper;
  confirmMinutes: number;
  preChecks: CheckSpec[];
  /** Everything sent to make the change, in order. */
  change: PlanLine[];
  /** Index in `change` of the line that starts the rollback timer (-1: none). */
  armIndex: number;
  /** Sent after post-checks pass to keep the change (rollback timer only). */
  confirm: PlanLine[];
  save: PlanLine[];
  abort: string[];
  postChecks: CheckSpec[];
  /** Any error keeps this device from running. */
  errors: string[];
  warnings: string[];
}

export interface PlanInput {
  block: string;
  preChecks: string;
  postChecks: string;
  device: { name: string; host?: string; deviceType: DeviceType };
  table: VariableTable | null;
  options: JobOptions;
}

export const clampMinutes = (n: number) => Math.min(60, Math.max(1, Math.round(Number.isFinite(n) ? n : 5)));

const jobLine = (text: string): PlanLine => ({ text, fromBlock: false, risky: false, dangerous: false });
const blockLine = (text: string): PlanLine => ({
  text,
  fromBlock: true,
  risky: isRiskyCommand(text),
  dangerous: isDangerousLine(text),
});

/** Exactly what one device will get, after variables — the dry run shows it
 *  and the run sends it. */
export function buildDevicePlan(input: PlanInput): DevicePlan {
  const { device, table, options } = input;
  const vendor = vendorSteps(device.deviceType);
  const errors: string[] = [];
  const warnings: string[] = [];

  // Variables: one message per problem, not per line.
  const all = [input.block, input.preChecks, input.postChecks].join('\n');
  const needed = findVariables(all).filter((v) => !BUILTIN_VARIABLES.includes(v.toLowerCase()));
  const { values, row } = deviceVariables(table, device);
  const hasTable = !!table && table.columns.length > 0;
  if (needed.length && !hasTable) {
    errors.push(`Uses ${needed.map((v) => `\${${v}}`).join(', ')} but there is no variables table.`);
  } else if (needed.length && !row) {
    errors.push(
      `No row for this device in the variables table (the first column must be "${device.name}"` +
        `${device.host && device.host !== device.name ? ` or "${device.host}"` : ''}).`
    );
  }
  const block = substitute(input.block, values);
  const pre = substitute(input.preChecks, values);
  const post = substitute(input.postChecks, values);
  if (row || !needed.length) {
    const missing = [...new Set([...block.missing, ...pre.missing, ...post.missing])];
    for (const m of missing) {
      errors.push(
        table && !table.columns.some((c) => c.toLowerCase() === m.toLowerCase())
          ? `\${${m}} is not a column in the variables table.`
          : `No value for \${${m}}.`
      );
    }
  }

  let lines = prepareSendLines(block.text).map((l) => l.text);
  // The job enters and leaves config mode itself; a copy of those in the
  // block would fail (or, for `end` at the exec prompt, be rejected).
  if (vendor.enter && lines.length && ENTER_CONFIG.test(lines[0])) {
    warnings.push(`Left out your "${lines[0]}" line — the job enters config mode itself.`);
    lines = lines.slice(1);
  }
  if (vendor.enter && vendor.exit[0] === 'end' && lines.length && /^end$/i.test(lines[lines.length - 1])) {
    warnings.push('Left out your final "end" — the job leaves config mode itself.');
    lines = lines.slice(0, -1);
  }
  if (lines.length === 0) errors.push('The config block is empty.');

  const wrapper: SafetyWrapper = options.safetyWrapper ? vendor.wrapper : 'none';
  const minutes = clampMinutes(options.confirmMinutes);

  if (vendor.wrapper === 'commit-confirmed' && lines.some((l) => /^commit\b/i.test(l))) {
    errors.push(
      wrapper === 'commit-confirmed'
        ? 'Take out the "commit" line — the job commits for you (commit confirmed, then a confirming commit).'
        : 'Take out the "commit" line — the job commits for you once the whole block is in.'
    );
  }
  if (device.deviceType === 'aruba-cx' && lines.some((l) => /^checkpoint\s+auto\b/i.test(l))) {
    errors.push('Take out the "checkpoint auto" line — the job adds the rollback timer itself.');
  }
  if (wrapper !== 'none' && lines.some((l) => /^(?:write\s+mem(?:ory)?|copy\s+run\S*\s+start\S*)$/i.test(l))) {
    warnings.push(
      'Your block saves the config before the change is confirmed — take that line out and use the Save option, which saves after confirming.'
    );
  }
  if (!vendor.enter) {
    warnings.push('Normal device: the block is sent exactly as written — include the lines that enter config mode and save.');
  }
  if (device.deviceType === 'mist') {
    warnings.push('Mist-managed switch: Mist may overwrite CLI changes with its next config push.');
  }

  // Checks run at the exec prompt with no stop-on-error loop, so they must
  // only read.
  const preChecks = parseChecks(pre.text);
  const postChecks = parseChecks(post.text);
  for (const c of [...preChecks, ...postChecks]) {
    if (isRiskyCommand(c.command)) errors.push(`Checks must only read: "${c.command}" changes the device.`);
  }

  const body = lines.map(blockLine);
  const change: PlanLine[] = [];
  let armIndex = -1;
  const confirm: PlanLine[] = [];
  if (wrapper === 'checkpoint') {
    // AOS-CX: arm first; the switch restores this checkpoint unless
    // `checkpoint auto confirm` arrives within the time.
    change.push(jobLine(`checkpoint auto ${minutes}`));
    armIndex = 0;
    change.push(jobLine(vendor.enter!), ...body, ...vendor.exit.map(jobLine));
    confirm.push(jobLine('checkpoint auto confirm'));
  } else if (wrapper === 'commit-confirmed') {
    // Junos: the timer starts at the commit; a second, plain commit keeps it.
    change.push(jobLine(vendor.enter!), ...body);
    armIndex = change.length;
    change.push(jobLine(`commit confirmed ${minutes} comment "${JOB_COMMENT}"`), ...vendor.exit.map(jobLine));
    confirm.push(jobLine(vendor.enter!), jobLine(`commit comment "${JOB_COMMENT} (confirmed)"`), ...vendor.exit.map(jobLine));
  } else if (vendor.wrapper === 'commit-confirmed') {
    change.push(jobLine(vendor.enter!), ...body, jobLine(`commit comment "${JOB_COMMENT}"`), ...vendor.exit.map(jobLine));
  } else if (vendor.enter) {
    change.push(jobLine(vendor.enter), ...body, ...vendor.exit.map(jobLine));
  } else {
    change.push(...body);
  }

  return {
    vendor,
    wrapper,
    confirmMinutes: minutes,
    preChecks,
    change,
    armIndex,
    confirm,
    save: options.save && vendor.save ? [jobLine(vendor.save)] : [],
    abort: vendor.abort,
    postChecks,
    errors,
    warnings,
  };
}

// ─── Targets ───

export interface TargetPick {
  folders: string[];
  tags: string[];
  /** Saved host ids. */
  hosts: string[];
  /** Open session ids. */
  sessions: string[];
}

export interface JobTarget {
  key: string;
  name: string;
  config: ConnectionConfig;
  /** The open tab to use; null = connect it when the job reaches it. */
  sessionId: string | null;
}

const isNetworkProtocol = (c: ConnectionConfig) => c.protocol === 'ssh' || c.protocol === 'telnet';

/** Same box, however it was opened: a saved host and an ad-hoc tab to the
 *  same address must not get the change twice. */
export function deviceIdentity(c: ConnectionConfig): string {
  if (c.protocol === 'serial') return `serial|${c.serialPort ?? ''}`;
  if (!c.host) return `id|${c.id}`;
  return `${c.host.trim().toLowerCase()}|${c.port ?? (c.protocol === 'telnet' ? 23 : 22)}`;
}

/**
 * The devices a pick covers, de-duplicated, in sidebar order then open-tab
 * order. Folders and tags only sweep in ssh/telnet hosts (a serial console
 * may be mid-staging); a host or tab ticked by hand may be serial. Local
 * shells are never targets. A saved host that is already open uses its tab.
 */
export function resolveTargets(folders: SessionFolder[], sessions: Session[], pick: TargetPick): JobTarget[] {
  const out: JobTarget[] = [];
  const byIdentity = new Map<string, JobTarget>();
  const openFor = (c: ConnectionConfig) =>
    sessions.find((s) => s.sessionId === c.id) ??
    sessions.find((s) => s.config.protocol !== 'local' && deviceIdentity(s.config) === deviceIdentity(c));
  const add = (config: ConnectionConfig, sessionId: string | null) => {
    const id = deviceIdentity(config);
    if (byIdentity.has(id)) return;
    const t: JobTarget = { key: sessionId ?? config.id, name: config.name || config.host || 'device', config, sessionId };
    byIdentity.set(id, t);
    out.push(t);
  };
  for (const f of folders) {
    for (const item of f.items) {
      if (item.protocol === 'local') continue;
      const picked =
        pick.hosts.includes(item.id) ||
        (isNetworkProtocol(item) &&
          (pick.folders.includes(f.id) || (item.tags ?? []).some((t) => pick.tags.includes(t))));
      if (!picked) continue;
      const open = openFor(item);
      add(open ? open.config : item, open?.sessionId ?? null);
    }
  }
  for (const s of sessions) {
    if (s.config.protocol === 'local' || !pick.sessions.includes(s.sessionId)) continue;
    add(s.config, s.sessionId);
  }
  return out;
}

// ─── The device prompt ───

export type PromptState = 'exec' | 'config' | 'question' | 'pager' | 'login' | 'press-key' | 'unknown';

/**
 * What the session's terminal is showing at its tail, so the job only starts
 * typing at a plain exec prompt: never into a question, a pager, a login, or
 * a config session someone left open.
 */
export function promptState(output: string): PromptState {
  const tail = output.replace(/\r/g, '').slice(-800);
  const lines = tail.split('\n');
  const last = lines[lines.length - 1].trimEnd();
  if (/press any key to continue/i.test(lines.slice(-3).join('\n'))) return 'press-key';
  if (endsAtPager(tail)) return 'pager';
  if (/(?:login|username|user name|password)\s*:$/i.test(last)) return 'login';
  if (looksLikeQuestion(last)) return 'question';
  if (!last || last.length > 200 || !/[#>$%]$/.test(last)) return 'unknown';
  // Aruba config contexts: sw(config)#, sw(config-if)#, AOS-S (vlan-10)# /
  // (eth-1/1/1)#, AOS 8 "(host) (config) #". Junos: an [edit …] line above #.
  if (/\((?:config|conf-|vlan-|eth-|int)[^)]*\)\s*#$/i.test(last)) return 'config';
  if (last.endsWith('#')) {
    const above = lines.slice(0, -1).reverse().find((l) => l.trim());
    if (above && /^\[edit\b.*\]$/.test(above.trim())) return 'config';
  }
  return 'exec';
}

// ─── Diff ───

export interface DiffLine {
  kind: 'same' | 'add' | 'del';
  text: string;
}

export interface LineDiff {
  lines: DiffLine[];
  added: number;
  removed: number;
}

// Past this many cells in the LCS table (after trimming the common head and
// tail) fall back to "all removed, all added" rather than stall the UI.
const DIFF_CELL_CAP = 4_000_000;

/** Line diff of two captures (before → after). */
export function diffLines(before: string, after: string): LineDiff {
  const a = before.replace(/\r/g, '').split('\n');
  const b = after.replace(/\r/g, '').split('\n');
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const am = a.slice(head, a.length - tail);
  const bm = b.slice(head, b.length - tail);
  const mid: DiffLine[] = [];
  if (am.length * bm.length > DIFF_CELL_CAP) {
    mid.push(...am.map((text) => ({ kind: 'del' as const, text })), ...bm.map((text) => ({ kind: 'add' as const, text })));
  } else {
    // Classic LCS table, walked forward.
    const n = am.length;
    const m = bm.length;
    const w = m + 1;
    const L = new Uint32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        L[i * w + j] = am[i] === bm[j] ? L[(i + 1) * w + j + 1] + 1 : Math.max(L[(i + 1) * w + j], L[i * w + j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (am[i] === bm[j]) {
        mid.push({ kind: 'same', text: am[i] });
        i++;
        j++;
      } else if (L[(i + 1) * w + j] >= L[i * w + j + 1]) mid.push({ kind: 'del', text: am[i++] });
      else mid.push({ kind: 'add', text: bm[j++] });
    }
    while (i < n) mid.push({ kind: 'del', text: am[i++] });
    while (j < m) mid.push({ kind: 'add', text: bm[j++] });
  }
  const lines: DiffLine[] = [
    ...a.slice(0, head).map((text) => ({ kind: 'same' as const, text })),
    ...mid,
    ...a.slice(a.length - tail).map((text) => ({ kind: 'same' as const, text })),
  ];
  return {
    lines,
    added: mid.filter((l) => l.kind === 'add').length,
    removed: mid.filter((l) => l.kind === 'del').length,
  };
}

/** Only the changed lines plus `context` lines around them; `null` marks a gap. */
export function diffHunks(diff: LineDiff, context = 3): (DiffLine | null)[] {
  const keep = new Array<boolean>(diff.lines.length).fill(false);
  diff.lines.forEach((l, i) => {
    if (l.kind === 'same') return;
    for (let k = Math.max(0, i - context); k <= Math.min(diff.lines.length - 1, i + context); k++) keep[k] = true;
  });
  const out: (DiffLine | null)[] = [];
  diff.lines.forEach((l, i) => {
    if (keep[i]) out.push(l);
    else if (out.length && out[out.length - 1] !== null) out.push(null);
  });
  if (out.length && out[out.length - 1] === null) out.pop();
  return out;
}

// ─── Running one device ───

export type StepPhase = 'pre-check' | 'capture' | 'change' | 'post-check' | 'confirm' | 'save' | 'cleanup';

export interface JobStep {
  phase: StepPhase;
  label: string;
  ok: boolean;
  output: string;
  note?: string;
}

/** The live terminal, as the device runner sees it. */
export interface DeviceIO {
  /** Send lines through the stop-at-first-error loop (runConfigSend). */
  sendLines(lines: string[]): Promise<{ result: SendResult; output: string }>;
  /** Run one read-only command and return its output. */
  runCommand(command: string): Promise<{ output: string; truncated: boolean; sent: string }>;
  /** Pull the running config into the config archive. */
  captureConfig(when: 'before' | 'after'): Promise<{ content: string; truncated: boolean } | null>;
  /** Run `fn` with terminal paging off (restored afterwards). */
  withPagingOff<T>(fn: () => Promise<T>): Promise<T>;
  now(): number;
}

/** At the canary pause: keep the change (confirm/save) or not. */
export type HoldDecision = 'keep' | 'drop';

export interface DeviceControl {
  /** The job was stopped: don't start a change; don't confirm an armed one. */
  stopRequested(): boolean;
  /** "Roll back" was clicked for this device: don't confirm it. */
  rollbackRequested(): boolean;
  /** Canary only: called once post-checks pass, before confirm/save. */
  hold?: (armedUntil: number | null) => Promise<HoldDecision>;
  onStep(step: JobStep): void;
  /** The rollback timer is running and ends at `deadline` (null: confirmed). */
  onArmed(deadline: number | null): void;
}

export type DeviceFinal = 'ok' | 'error' | 'rolled-back' | 'skipped';

export interface DeviceOutcome {
  status: DeviceFinal;
  detail: string;
  before: string | null;
  after: string | null;
  /** Rollback deadline while armed and never confirmed. */
  revertsAt: number | null;
  /** Config lines reached the device (a failure here should stop the job). */
  touched: boolean;
}

/** Don't confirm this close to the device's own deadline: it may already be
 *  rolling back, and the estimate of when its timer started is approximate. */
export const CONFIRM_MARGIN_MS = 15_000;

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** How far a send got, in words. */
function describeSendFailure(result: SendResult, lines: string[]): string {
  switch (result.kind) {
    case 'device-error':
      return `The device rejected "${lines[result.failedIndex]}"${result.deviceText ? `: ${result.deviceText.split('\n').pop()}` : ''}.`;
    case 'question':
      return `The device asked a question after "${lines[result.failedIndex]}" — answer it in the terminal.`;
    case 'send-failed':
      return `Sending failed after ${plural(result.sent, 'line')} (is the session still connected?).`;
    case 'cancelled':
      return `Stopped after ${plural(result.sent, 'line')}.`;
    default:
      return '';
  }
}

/**
 * One device, start to finish: pre-checks and a "before" capture (paging
 * off), the change through the stop-on-error loop, post-checks and an "after"
 * capture, then — only if every check passed — confirm the rollback timer and
 * save. With a rollback timer armed, anything short of a clean pass simply
 * isn't confirmed, so the device reverts on its own.
 */
export async function runDevice(plan: DevicePlan, io: DeviceIO, ctl: DeviceControl): Promise<DeviceOutcome> {
  const out: DeviceOutcome = { status: 'ok', detail: '', before: null, after: null, revertsAt: null, touched: false };
  const finish = (status: DeviceFinal, detail: string): DeviceOutcome => ({ ...out, status, detail });
  const changeLines = plan.change.map((l) => l.text);

  const runChecks = async (phase: 'pre-check' | 'post-check', checks: CheckSpec[]) => {
    let failed: { spec: CheckSpec; reason: string } | null = null;
    for (const spec of checks) {
      const { output, truncated, sent } = await io.runCommand(spec.command);
      const verdict = evaluateCheck(spec, output, sent);
      ctl.onStep({
        phase,
        label: spec.command + (spec.expect ? ` ${spec.expect.absent ? '!=>' : '=>'} ${spec.expect.text}` : ''),
        ok: verdict.ok,
        output,
        note: [verdict.reason, truncated ? 'output may be incomplete' : ''].filter(Boolean).join('; ') || undefined,
      });
      if (!verdict.ok) {
        failed = { spec, reason: verdict.reason ?? 'failed' };
        // Pre-checks gate the change, so stop at the first; post-checks all
        // run for the fuller picture (they only read).
        if (phase === 'pre-check') break;
      }
    }
    return failed as { spec: CheckSpec; reason: string } | null;
  };

  const capture = async (when: 'before' | 'after') => {
    const snap = await io.captureConfig(when).catch(() => null);
    ctl.onStep({
      phase: 'capture',
      label: `Running config (${when})`,
      ok: !!snap,
      output: snap ? `${plural(snap.content.split('\n').length, 'line')} saved to the config archive` : '',
      note: !snap
        ? `could not capture — no ${when === 'before' ? 'diff' : 'after-change diff'} for this device`
        : snap.truncated
          ? 'capture may be incomplete, so the diff may be too'
          : undefined,
    });
    return snap?.content ?? null;
  };

  let armed = false;
  try {
    // 1. Look before touching anything.
    const preFail = await io.withPagingOff(async () => {
      const failed = await runChecks('pre-check', plan.preChecks);
      if (!failed) out.before = await capture('before');
      return failed;
    });
    if (preFail) return finish('error', `Pre-check failed — nothing was changed. ${preFail.spec.command}: ${preFail.reason}.`);
    if (ctl.stopRequested()) return finish('skipped', 'The job was stopped before this device was changed.');

    // 2. The change. AOS-CX's timer starts at `checkpoint auto` (before the
    // block), Junos's at `commit confirmed` (the end of it).
    const minutes = plan.confirmMinutes * 60_000;
    const changeStart = io.now();
    out.touched = true;
    const sent = await io.sendLines(changeLines);
    const r = sent.result;
    if (plan.armIndex >= 0) {
      armed =
        r.kind === 'done' ||
        ((r.kind === 'device-error' || r.kind === 'question') && r.failedIndex > plan.armIndex) ||
        ((r.kind === 'send-failed' || r.kind === 'cancelled') && r.sent > plan.armIndex);
      if (armed) {
        out.revertsAt = (plan.wrapper === 'checkpoint' ? changeStart : io.now()) + minutes;
        ctl.onArmed(out.revertsAt);
      }
    }
    ctl.onStep({
      phase: 'change',
      label: `Sent ${r.sent} of ${plural(changeLines.length, 'line')}`,
      ok: r.kind === 'done',
      output: sent.output,
      note: r.kind === 'done' ? undefined : describeSendFailure(r, changeLines),
    });
    if (r.kind !== 'done') {
      // Leave config mode (Junos: drop the uncommitted edits first). Not after
      // a question — these lines would become its answer — or a dead session.
      if (r.kind === 'device-error' && plan.abort.length) {
        const cleanup = await io.sendLines(plan.abort);
        ctl.onStep({ phase: 'cleanup', label: 'Left config mode', ok: cleanup.result.kind === 'done', output: cleanup.output });
      }
      const why = describeSendFailure(r, changeLines);
      if (armed) return finish('rolled-back', `${why} Not confirmed, so the device rolls back on its own.`);
      // Index of the first line that did NOT take effect.
      const failedAt = r.kind === 'device-error' || r.kind === 'question' ? r.failedIndex : r.sent;
      if (plan.vendor.wrapper === 'commit-confirmed') {
        // Junos edits a candidate: nothing is live until the commit line.
        const commitAt = changeLines.findIndex((l) => /^commit\b/i.test(l));
        if (failedAt <= commitAt) {
          return finish(
            'error',
            `${why} Nothing was committed${r.kind === 'device-error' ? '' : ' — the session may still be in config mode'}.`
          );
        }
      }
      const blockBefore = plan.change.slice(0, failedAt).filter((l) => l.fromBlock).length;
      return finish(
        'error',
        `${why}${blockBefore > 0 ? ` The ${plural(blockBefore, 'line')} before it are live on the device (not saved).` : ''}`
      );
    }

    // 3. Look again.
    const postFail = await io.withPagingOff(async () => {
      const failed = await runChecks('post-check', plan.postChecks);
      out.after = await capture('after');
      return failed;
    });
    if (postFail) {
      const why = `Post-check failed: ${postFail.spec.command}: ${postFail.reason}.`;
      if (armed) return finish('rolled-back', `${why} Not confirmed, so the device rolls back on its own.`);
      return finish('error', `${why} The change is live on the device${plan.save.length ? ' and was not saved' : ''}.`);
    }

    // 4. Keep it — after the user's OK on the canary.
    if (ctl.hold) {
      const decision = await ctl.hold(armed ? out.revertsAt : null);
      if (decision === 'drop') {
        if (armed) return finish('rolled-back', 'You chose not to keep it: not confirmed, so the device rolls back on its own.');
        return finish('ok', `Changed${plan.save.length ? ' but not saved (you chose not to save)' : ''}.`);
      }
    }
    if (armed) {
      if (ctl.rollbackRequested()) return finish('rolled-back', 'Roll back requested: not confirmed, so the device rolls back on its own.');
      if (ctl.stopRequested()) return finish('rolled-back', 'The job was stopped: not confirmed, so the device rolls back on its own.');
      if (io.now() > (out.revertsAt ?? 0) - CONFIRM_MARGIN_MS) {
        return finish('rolled-back', 'Too late to confirm — the rollback timer ran out, so the device reverts on its own.');
      }
      const confirm = await io.sendLines(plan.confirm.map((l) => l.text));
      ctl.onStep({
        phase: 'confirm',
        label: plan.wrapper === 'checkpoint' ? 'Confirm checkpoint' : 'Confirm commit',
        ok: confirm.result.kind === 'done',
        output: confirm.output,
        note: confirm.result.kind === 'done' ? undefined : describeSendFailure(confirm.result, plan.confirm.map((l) => l.text)),
      });
      if (confirm.result.kind !== 'done') {
        return finish('error', 'Could not confirm the change — unless it is confirmed by hand, the device rolls back on its own.');
      }
      out.revertsAt = null;
      ctl.onArmed(null);
    }
    if (plan.save.length) {
      const save = await io.sendLines(plan.save.map((l) => l.text));
      ctl.onStep({
        phase: 'save',
        label: `Save (${plan.save[0].text})`,
        ok: save.result.kind === 'done',
        output: save.output,
        note: save.result.kind === 'done' ? undefined : describeSendFailure(save.result, plan.save.map((l) => l.text)),
      });
      if (save.result.kind !== 'done') return finish('error', 'The change is live, but saving it failed.');
    }
    return finish('ok', `Changed${armed ? ' and confirmed' : ''}${plan.save.length ? ', saved' : ''}.`);
  } catch (e) {
    const why = `Stopped: ${e instanceof Error ? e.message : String(e)}.`;
    return finish(armed ? 'rolled-back' : 'error', armed ? `${why} Not confirmed, so the device rolls back on its own.` : why);
  }
}

// ─── Running the job ───

export type RowStatus =
  | 'queued'
  | 'connecting'
  | 'running'
  | 'waiting'
  | 'ok'
  | 'error'
  | 'skipped'
  | 'needs-login'
  | 'rolled-back';

export interface JobRunResult {
  status: RowStatus;
  /** Config lines reached the device. */
  touched: boolean;
  /** Canary only: the user said to go on to the other devices. */
  proceed?: boolean;
}

export type SkipCause = 'canary-failed' | 'canary-stop' | 'stopped' | 'halted';

export interface JobRunner<T> {
  /** Canary first. */
  targets: T[];
  /** How many of the non-canary devices run at once. */
  concurrency: number;
  /** Stop starting devices after the first one whose change fails. */
  stopOnError: boolean;
  isStopped: () => boolean;
  run: (target: T, canary: boolean) => Promise<JobRunResult>;
  skip: (target: T, cause: SkipCause, by?: T) => void;
}

export type JobEnd = 'finished' | 'canary-failed' | 'stopped' | 'halted';

/**
 * The canary runs alone and the job only goes on when it passed AND the user
 * said so. The rest run through a small worker pool (like Bulk Runner's).
 * A failed change stops new devices from starting when `stopOnError` is on;
 * devices that couldn't be reached, need a login, or failed a pre-check were
 * never touched, so they never stop the job.
 */
export async function runJob<T>(job: JobRunner<T>): Promise<{ end: JobEnd; haltedBy?: T }> {
  const [canary, ...rest] = job.targets;
  if (canary === undefined) return { end: 'finished' };
  const c = await job.run(canary, true);
  if (c.status !== 'ok') {
    rest.forEach((t) => job.skip(t, 'canary-failed', canary));
    return { end: 'canary-failed' };
  }
  if (!c.proceed || job.isStopped()) {
    rest.forEach((t) => job.skip(t, 'canary-stop', canary));
    return { end: 'stopped' };
  }
  let idx = 0;
  let haltedBy: T | undefined;
  const worker = async () => {
    while (idx < rest.length && haltedBy === undefined && !job.isStopped()) {
      const t = rest[idx++];
      const r = await job.run(t, false);
      if (job.stopOnError && r.touched && (r.status === 'error' || r.status === 'rolled-back') && haltedBy === undefined) {
        haltedBy = t;
      }
    }
  };
  const pool = Math.max(1, Math.min(job.concurrency, rest.length));
  await Promise.all(Array.from({ length: pool }, () => worker()));
  const left = rest.slice(idx);
  if (haltedBy !== undefined) {
    left.forEach((t) => job.skip(t, 'halted', haltedBy));
    return { end: 'halted', haltedBy };
  }
  if (left.length || job.isStopped()) {
    left.forEach((t) => job.skip(t, 'stopped'));
    return { end: 'stopped' };
  }
  return { end: 'finished' };
}

// ─── Display helpers ───

/** 4:05 — a countdown or a duration. */
export function formatClock(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}
