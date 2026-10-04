// Export GreenCLI's MCP servers as a {"mcpServers": {...}} file that Claude Code (.mcp.json)
// and Casper (mcp.json / .mcp.json / ~/.mcp.json) both read. Pure: no file, Tauri or window access.
//
// Only the fields both accept are written:
//   stdio -> type "stdio", command, args, env
//   http  -> type "http", url, headers
// Left out on purpose:
//   cwd                           Casper reads it (casper src/mcp/config.ts:75-115); Claude Code's .mcp.json has none.
//   disabled                      Casper reads it (config.ts:133); Claude Code turns project servers on and off in its settings.
//   connectTimeout / callTimeout  Casper only (config.ts:117-129); Claude Code uses the MCP_TIMEOUT env var.
//   type "sse"                    Claude Code only; Casper refuses it (config.ts:137, import.ts:115). GreenCLI has no SSE transport.
//   "." in names                  Casper allows it (config.ts:132); Claude Code does not.
//   writes off                    Neither file format has it. While a server's writes are off, the read-only
//                                 settings GreenCLI adds at connect (mcp_export_pins) go in the file, and a note
//                                 names the servers whose writes-off setting can't be kept.
// Secrets become ${NAME}. Both tools expand ${NAME} in command, args, env and headers. Claude Code also
// expands it in url; Casper does not (manager.ts:793), so we add a note when a url has one.
// GreenCLI itself never expands ${...} (client.rs sends values verbatim), so a ${X} the user typed
// changes meaning once exported. Where Claude Code would send it to a remote server (an http server,
// and addresses and -H headers in stdio args) it gets a new name made from the server's name, so a
// key already set in the user's shell is not sent there by mistake. Elsewhere the summary says so.
//
// Casper line numbers and the two regexes marked "casper" below are from casper @ ad678b6.
//
// The secret helpers below use regex lookbehind and the `d` flag at load time: load this module
// with `await import(...)` only after secretFilterSupported() (as forCopy.ts does).

import type { McpServerDef } from '../types';
import type { McpExportPins } from './mcpTypes';
import { isSecretName } from './secrets/assignments';
import { isSecretKey, snakeKey } from './secrets/scrub';
import { scrubForAi } from './secrets/engine';

export const EXPORT_FILE_NAME = '.mcp.json';
export const CASPER_MAX_SERVERS = 64;

export type ExportedServer =
  | { type: 'stdio'; command: string; args: string[]; env?: Record<string, string> }
  | { type: 'http'; url: string; headers?: Record<string, string> };

export interface McpExportFile {
  mcpServers: Record<string, ExportedServer>;
}

/** Where a ${NAME} is used. origin is set for http servers ("https://host:port"). */
export interface VariablePlace {
  server: string;
  where: string;
  origin?: string;
}

export type VariableWhy = 'secret' | 'basic-auth' | 'credentials-file' | 'already-a-reference' | 'renamed-reference';

export interface VariableToSet {
  name: string;
  why: VariableWhy;
  /** "Bearer" | "Basic" | "Token", when a header kept its scheme. */
  scheme?: string;
  /** credentials-file only: the server's name in GreenCLI. */
  greencliName?: string;
  /** secret only: the value sits in an address and must be set percent-encoded (%40 for @). */
  urlEncoded?: boolean;
  /** renamed-reference only: the ${NAME} the user wrote in GreenCLI. */
  from?: string;
  /** First-seen order, no duplicates. */
  places: VariablePlace[];
}

export interface McpExportResult {
  file: McpExportFile;
  /** JSON.stringify(file, null, 2) + '\n' */
  text: string;
  count: number;
  /** First-seen order. */
  variables: VariableToSet[];
  notes: string[];
}

export interface McpExportOptions {
  /** Names of stdio servers that have saved credentials (from mcp_has_credentials). */
  withCredentials?: ReadonlySet<string>;
  /** mcp_export_pins: the read-only settings GreenCLI adds to each server whose writes are off. */
  pins?: ReadonlyMap<string, McpExportPins>;
  /** GreenCLI's own read-only server (greencli-mcp): its path, or why it is left out. */
  greencli?: GreencliExport;
}

/** greencli-mcp in the export: the binary's full path and GreenCLI's data folder (passed as
 *  `--data-dir`, since Casper starts servers without the app's environment), or why it is left
 *  out ("missing": not next to GreenCLI in this build; "not-installed": GreenCLI runs from
 *  outside Applications, so the path would change). */
export type GreencliExport =
  | { command: string; dataDir: string; /** Its show commands are on (MCP Servers switch, macOS/Linux). */ showCommands?: boolean }
  | { leftOut: 'missing' | 'not-installed' };

/** The server name greencli-mcp gets in the file. */
export const GREENCLI_SERVER_NAME = 'greencli';

/** The server as GreenCLI starts it while writes are off: the pinned args, and the pinned env
 *  (a user key equal to a pin key, ignoring case, is dropped first, as Rust apply_pins does). */
function withPins(def: McpServerDef, pins: McpExportPins | undefined): McpServerDef {
  if (def.writes === 'on' || def.transport === 'http' || pins?.kind !== 'pinned') return def;
  const env = { ...(def.env ?? {}) };
  for (const [key, value] of pins.env) {
    for (const k of Object.keys(env)) if (k.toLowerCase() === key.toLowerCase()) delete env[k];
    env[key] = value;
  }
  return { ...def, args: [...pins.args], env };
}

// ─── References ───

/** `${NAME}` or `${NAME:-default}`: same as casper config.ts:264. Only used with replace/matchAll,
 *  which never leave lastIndex set; REFERENCE_ONE is the non-global copy for test(). */
const REFERENCE = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;
const REFERENCE_ONE = new RegExp(REFERENCE.source);

/** True when the value contains a ${NAME} or ${NAME:-default}. */
export function hasReference(value: string): boolean {
  return REFERENCE_ONE.test(value);
}

/** True when nothing but references and spaces is left after removing every reference. */
export function onlyReferences(value: string): boolean {
  return hasReference(value) && value.replace(REFERENCE, '').trim() === '';
}

/** True when the value is only plain ${NAME}s (and spaces): it holds no text of its own. A
 *  ${NAME:-default} with a default doesn't count, since the default is literal text that stays in
 *  the file. (${NAME-default} is no reference at all, so its text counts as literal too.) */
export function onlyPlainReferences(value: string): boolean {
  return onlyReferences(value) && [...value.matchAll(REFERENCE)].every((m) => !m[2]);
}

function ref(name: string): string {
  return '${' + name + '}';
}

/** Run fn on the text between references; the references themselves are kept as they are. */
function mapLiterals(value: string, fn: (literal: string) => string): string {
  let out = '';
  let last = 0;
  for (const m of value.matchAll(REFERENCE)) {
    const at = m.index ?? 0;
    out += fn(value.slice(last, at)) + m[0];
    last = at + m[0].length;
  }
  return out + fn(value.slice(last));
}

// ─── Names ───

/** "X-API-Key" -> "X_API_KEY", "apiKey" -> "API_KEY", "1st" -> "_1ST", "" or "---" -> "SECRET". */
export function toEnvName(raw: string): string {
  const n = snakeKey(raw.replace(/^-+/, ''))
    .toUpperCase()
    .replace(/[^A-Z0-9_]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  return !n ? 'SECRET' : /^[0-9]/.test(n) ? `_${n}` : n;
}

/** [A-Za-z0-9_-]{1,64}, not de-duplicated. */
export function exportServerName(name: string): string {
  return (
    name
      .trim()
      .replace(/[^A-Za-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 64) || 'server'
  );
}

const VALID_NAME = /^[A-Za-z0-9_-]{1,64}$/;

function lastPart(snake: string): string {
  return snake.split('_').filter(Boolean).at(-1) ?? '';
}

// The reused helpers return false for these last name parts (checked: MIST_KEY, OPENAI_KEY,
// x-functions-key, GITHUB_PAT, ?sig=, SWITCH_PW, --pwd, ...). Here over-hiding only adds a variable to set.
const EXTRA_SECRET_LAST = new Set([
  'key', 'keys', 'jwt', 'pat', 'sas', 'sig', 'signature', 'session', 'sessionid', 'auth',
  'pw', 'pwd', 'passwd', 'pass', 'privkey', 'cookie',
]);

// Network logins: SWITCH_LOGIN, ARUBA_CREDS, SNMP_V3_PRIV, ENABLE (the enable password), RADIUS and
// TACACS secrets, SNMP communities. A plain true/false or number under these names stays
// (FEATURE_ENABLE=true): those are switches, not logins.
const NETWORK_SECRET_LAST = new Set(['creds', 'login', 'priv', 'enable', 'radius', 'tacacs', 'community']);
const PLAIN_SWITCH = /^(?:true|false|yes|no|on|off|\d{1,5})$/i;

function isNetworkSecretName(name: string): boolean {
  const key = snakeKey(name);
  return NETWORK_SECRET_LAST.has(lastPart(key)) || key.split('_').includes('community');
}

/** A network login name (isNetworkSecretName) whose value is a plain true/false or number. */
function plainSwitchValue(name: string, value: string): boolean {
  return isNetworkSecretName(name) && !isSecretName(name) && !isSecretKey(name) && PLAIN_SWITCH.test(value.trim());
}

/** For flags: isSecretFieldName, but not --enable (--enable tools turns a feature on). */
function isSecretFlagName(flag: string): boolean {
  return isSecretFieldName(flag) && lastPart(snakeKey(flag)) !== 'enable';
}

/** user:password typed as one value: one or more non-space characters, a colon, one or more
 *  non-space characters. GreenCLI can't tell a password from an image tag by its shape (jdoe:123-dev
 *  and node:20-alpine look alike, and CORP\jdoe or jdoe%40corp.com is as good a user as jdoe), so
 *  every value shaped like this is hidden unless userPassKept says it is something else, or its name
 *  says what it is (isPlainValueName). */
const USER_PASS = /^\S+:\S+$/;
/** Package specifiers (deno, npm): npm:@scope/pkg, jsr:@std/x, node:fs, file:..., data:...,
 *  github:org/repo, git+https:..., git+ssh:.... */
const PACKAGE_SCHEME = /^(?:npm|jsr|node|file|data|github|git\+https|git\+ssh):/;
/** host:port, or a port mapping: only digits and colons after the host (localhost:8080, 8080:80,
 *  127.0.0.1:8080:80). Each number is a port, 1 to 65535. */
const PORT_LIST = /^\d{1,5}(?::\d{1,5})*$/;
/** A Windows drive path: C:\tools, C:/tools. */
const DRIVE_PATH = /^[A-Za-z]:[\\/]/;
/** A git remote: the ssh user is git (git@github.com:org/repo), or the value ends in .git. */
const GIT_REMOTE = /^git@[^\s@:]+:\S+$|\.git$/;
/** A Docker volume or bind mount: name:/path or /host:/container, maybe with :ro or :rw (and the
 *  SELinux z or Z). Only the value right after -v, --volume or --mount. */
const VOLUME = /^(?:[A-Za-z0-9][\w.-]*|[/~.][^\s:]*|\$\{[A-Za-z_][A-Za-z0-9_]*\}[^\s:]*):\/[^\s:]*(?::(?:ro|rw|z|Z)(?:,(?:ro|rw|z|Z))*)?$/;
const VOLUME_FLAGS = new Set(['-v', '--volume', '--mount']);
/** Env names whose value is a list of folders joined by colons (bin:/usr/bin). */
const PATH_LIST_NAMES = new Set(['PATH', 'PYTHONPATH', 'NODE_PATH', 'LD_LIBRARY_PATH', 'DYLD_LIBRARY_PATH', 'CLASSPATH', 'MANPATH']);

/** Where a value sits: the env name or NAME= it is under, or the flag right before it. */
interface UserPassPlace {
  envName?: string;
  flag?: string;
}

function isPort(digits: string): boolean {
  const n = Number(digits);
  return n >= 1 && n <= 65535;
}

/** host:port or a port mapping (PORT_LIST), also with an [IPv6] host. */
function hostPort(value: string): boolean {
  const rest = value.startsWith('[') ? /^\[[0-9A-Fa-f:.]+\]:(.+)$/.exec(value)?.[1] : value.slice(value.indexOf(':') + 1);
  return rest !== undefined && PORT_LIST.test(rest) && rest.split(':').every(isPort);
}

/** The user:password-shaped values that stay plain: an address with a scheme and //, a package
 *  specifier, host:port, a Windows drive path, a git remote, a volume after -v/--volume/--mount and
 *  a folder list under PATH and its kin. */
function userPassKept(value: string, place: UserPassPlace): boolean {
  if (URL_START.test(value) || PACKAGE_SCHEME.test(value) || hostPort(value) || DRIVE_PATH.test(value) || GIT_REMOTE.test(value)) {
    return true;
  }
  if (place.flag !== undefined && VOLUME_FLAGS.has(place.flag) && VOLUME.test(value)) return true;
  return place.envName !== undefined && PATH_LIST_NAMES.has(place.envName.toUpperCase());
}

/** A user:password-shaped value (USER_PASS) that is not kept by userPassKept. Only plain ${NAME}s,
 *  or only plain ${NAME}s after the colon (admin:${DB_PASS}), hold no password to hide. A default
 *  is literal text: admin:${DB_PASS:-Summer2024} is hidden like admin:Summer2024. */
function looksLikeUserPass(value: string, place: UserPassPlace): boolean {
  if (!USER_PASS.test(value) || onlyPlainReferences(value)) return false;
  if (onlyPlainReferences(value.slice(value.indexOf(':') + 1))) return false;
  return !userPassKept(value, place);
}

/** Names that clearly hold no secret, so a user:password-shaped value under them stays plain:
 *  IMAGE=node:20-alpine, NODE_IMAGE=..., --platform linux:arm64. */
const PLAIN_VALUE_NAMES = new Set([
  'image', 'tag', 'version', 'platform', 'arch', 'mode', 'level', 'format', 'node_version', 'python_version',
]);
const PLAIN_VALUE_ENDINGS = ['_image', '_tag', '_version', '_platform'];

function isPlainValueName(name: string): boolean {
  const key = snakeKey(name.replace(/^-+/, ''));
  return PLAIN_VALUE_NAMES.has(key) || PLAIN_VALUE_ENDINGS.some((end) => key.endsWith(end));
}

function isPublicKeyName(name: string): boolean {
  const key = snakeKey(name);
  return key === 'public_key' || key.endsWith('_public_key');
}

/** For env keys, flag names and arg names. */
export function isSecretFieldName(name: string): boolean {
  if (isPublicKeyName(name)) return false;
  return (
    isSecretName(name) || isSecretKey(name) || EXTRA_SECRET_LAST.has(lastPart(snakeKey(name))) || isNetworkSecretName(name)
  );
}

/** For env keys: isSecretFieldName, but never a variable every shell has (PWD is the working folder). */
function isSecretEnvKey(key: string): boolean {
  return !STANDARD_VARS.has(key.toUpperCase()) && isSecretFieldName(key);
}

/** For URL query names: isSecretFieldName plus code and auth.
 *  ?code= (Azure Functions) and ?key= (Google) are logins in URLs. */
export function isSecretQueryName(name: string): boolean {
  return isSecretFieldName(name) || ['code', 'auth'].includes(lastPart(snakeKey(name)));
}

// Headers on a remote MCP server are almost always logins (x-functions-key, Ocp-Apim-Subscription-Key,
// X-Org-Key all slip past name checks), so we hide every header but a short safe list.
const SAFE_HEADERS = new Set([
  'accept',
  'accept-encoding',
  'accept-language',
  'content-type',
  'user-agent',
  'cache-control',
  'mcp-protocol-version',
  'x-request-id',
  'x-correlation-id',
]);

/** Every header is secret unless it is on the short safe list. */
export function isSecretHeaderName(name: string): boolean {
  return !SAFE_HEADERS.has(name.trim().toLowerCase());
}

/** For `NAME=value` and `Name: value` args, where "every header is secret" would be wrong. */
function isArgHeaderName(name: string): boolean {
  return isSecretFieldName(name) || ['authorization', 'proxy-authorization', 'cookie'].includes(name.toLowerCase());
}

/** Same scheme words as AUTH_HEADER in secrets/assignments.ts:64 (not exported there). */
const SCHEME = /^(Bearer|Basic|Token)\s+(\S[\s\S]*)$/i;

/** casper config.ts:141: plain http is allowed only for these. */
const LOOPBACK = ['localhost', '127.0.0.1', '[::1]'];

/** Same list as client.rs:332-335 validate_stdio_command; keep in step. */
const SHELLS = ['sh', 'bash', 'zsh', 'fish', 'cmd', 'cmd.exe', 'powershell', 'powershell.exe', 'pwsh', 'pwsh.exe'];

function isShell(command: string): boolean {
  const base = (command.trim().split(/[\\/]/).at(-1) ?? '').trim().toLowerCase();
  return SHELLS.includes(base);
}

/** Variables every shell has; a ${HOME} in a stdio server is not something to set. */
const STANDARD_VARS = new Set([
  'HOME', 'USER', 'LOGNAME', 'PATH', 'PWD', 'SHELL', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA',
]);

/** Copy of casper src/secrets/files.ts:25. Casper hides an env var's value from its own output only
 *  when its name matches this or isSecretName. */
const CASPER_SECRET_ENV_NAME = /(TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|PRIVATE_KEY|CLIENT_SECRET|BEARER|CREDENTIAL)/i;

/** True when Casper will hide this variable's value from the AI's shell output. */
export function isCasperSecretName(name: string): boolean {
  return isSecretName(name) || CASPER_SECRET_ENV_NAME.test(name);
}

// ─── Values ───

function entropy(value: string): number {
  const counts = new Map<string, number>();
  for (const char of value) counts.set(char, (counts.get(char) ?? 0) + 1);
  let bits = 0;
  for (const count of counts.values()) {
    const p = count / value.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

/** A run of 16+ letters and digits with a digit or mixed case: the random part of a key. Package
 *  names and versions (hpe-networking-mcp==0.4.2, mcp-server-filesystem-v2.3.1) have none. */
function hasRandomRun(value: string): boolean {
  return (value.match(/[A-Za-z0-9]{16,}/g) ?? []).some((run) => /[0-9]/.test(run) || (/[a-z]/.test(run) && /[A-Z]/.test(run)));
}

/** A long, mixed, random-looking word with no spaces: ghp_..., sk-ant-..., AWS keys, long hex keys. */
function tokenShaped(value: string): boolean {
  return (
    value.length >= 20 &&
    /^[A-Za-z0-9_\-+/=.~]+$/.test(value) &&
    /[A-Za-z]/.test(value) &&
    /[0-9]/.test(value) &&
    !/^[/~.]/.test(value) &&
    !/^[A-Za-z]:[\\/]/.test(value) &&
    hasRandomRun(value) &&
    entropy(value) >= 3.5
  );
}

/** 32 or more hex digits, with or without dashes (a UUID, an API key in hex). In an address it is
 *  usually a key or a private link, so it is treated as one. */
function longHexId(value: string): boolean {
  return /^[0-9a-f-]+$/i.test(value) && value.replace(/-/g, '').length >= 32;
}

/** A path segment or query value that looks like a key. */
function urlPartLooksSecret(value: string, query: boolean): boolean {
  if (onlyReferences(value)) return false;
  return (query ? looksLikeSecretValue(value) : tokenShaped(value)) || longHexId(value);
}

/** Last-resort check for a value no name rule caught. */
export function looksLikeSecretValue(value: string): boolean {
  const v = value.replace(REFERENCE, '');
  if (!v.trim()) return false;
  // A JSON blob, jdbc and other user:pass URLs, --token x, Bearer ..., device config lines.
  if (scrubForAi(v).hidden > 0) return true;
  return tokenShaped(v.trim());
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

// ─── Refused save paths ───

const REFUSED_FILES = new Set([
  '.claude.json',
  'claude_desktop_config.json',
  'settings.json',
  'settings.local.json',
  'mcp_config.json',
  'mcp_servers.json',
  'mcp_creds.json',
]);
const REFUSED_FOLDERS = new Set(['.claude', '.casper', '.vscode', '.cursor', '.codeium', 'mcp_creds', 'com.choatelabs.greencli']);

/** null when fine; otherwise the plain-English reason the path is refused. A quick check on the text;
 *  src-tauri/src/export_file.rs checks the real path again (links too). Keep the two lists in step. */
export function refusedExportPath(path: string): string | null {
  const parts = path.split(/[\\/]/).map((part) => part.toLowerCase());
  const base = parts.at(-1) ?? '';
  const folders = parts.slice(0, -1);
  const vscodeUser =
    base === 'mcp.json' && folders.length >= 2 && ['code', 'code - insiders'].includes(folders[folders.length - 2]) && folders[folders.length - 1] === 'user';
  if (REFUSED_FILES.has(base) || folders.some((folder) => REFUSED_FOLDERS.has(folder)) || vscodeUser) {
    return "GreenCLI does not write other apps' own settings files. Pick another place, for example .mcp.json in a project folder.";
  }
  return null;
}

// ─── Name book ───

interface Entry {
  variable: VariableToSet;
  value?: string;
}

interface TakeExtra {
  scheme?: string;
  urlEncoded?: boolean;
}

/** Hands out variable names: no two variables share a name (ignoring case, as Windows does), and the
 *  same secret in two places gets one name. */
class NameBook {
  private byName = new Map<string, Entry>();
  private taken = new Set<string>();
  readonly order: VariableToSet[] = [];

  /** A ${NAME} the user wrote. Its places are filled in from the finished file. */
  reserve(name: string): void {
    if (this.byName.has(name)) return;
    const variable: VariableToSet = { name, why: 'already-a-reference', places: [] };
    this.byName.set(name, { variable });
    this.taken.add(name.toUpperCase());
    this.order.push(variable);
  }

  isUsersOwn(name: string): boolean {
    return this.byName.get(name)?.variable.why === 'already-a-reference';
  }

  /** A name for this value. With no place, the variable is only for the sweep and is listed only
   *  if the sweep uses it. */
  take(base: string, value: string | undefined, why: VariableWhy, place: VariablePlace | undefined, extra: TakeExtra = {}): string {
    const { scheme, urlEncoded } = extra;
    for (let i = 1; ; i++) {
      const name = i === 1 ? base : `${base}_${i}`;
      const entry = this.byName.get(name);
      if (
        entry &&
        entry.variable.why === why &&
        entry.variable.scheme === scheme &&
        entry.variable.urlEncoded === urlEncoded &&
        value !== undefined &&
        entry.value === value
      ) {
        if (place) this.addPlace(name, place);
        return name;
      }
      if (!this.taken.has(name.toUpperCase())) {
        const variable: VariableToSet = { name, why, ...(scheme ? { scheme } : {}), ...(urlEncoded ? { urlEncoded } : {}), places: [] };
        this.byName.set(name, { variable, value });
        this.taken.add(name.toUpperCase());
        this.order.push(variable);
        if (place) this.addPlace(name, place);
        return name;
      }
    }
  }

  get(name: string): VariableToSet | undefined {
    return this.byName.get(name)?.variable;
  }

  addPlace(name: string, place: VariablePlace): void {
    const variable = this.byName.get(name)?.variable;
    if (!variable) return;
    const same = variable.places.some((p) => p.server === place.server && p.where === place.where && p.origin === place.origin);
    if (!same) variable.places.push(place);
  }

  /** Values to look for again in the whole file, longest first. Only variables that stand for the
   *  plain text itself: not a base64 login, not a percent-encoded value, not a renamed ${NAME}. */
  literals(): { name: string; value: string }[] {
    const out: { name: string; value: string }[] = [];
    for (const [name, entry] of this.byName) {
      const plain = entry.variable.why === 'secret' && !entry.variable.urlEncoded;
      if (plain && entry.value !== undefined && entry.value.length >= 6 && !hasReference(entry.value)) out.push({ name, value: entry.value });
    }
    return out.sort((a, b) => b.value.length - a.value.length);
  }
}

// ─── Per-server work ───

interface Server {
  book: NameBook;
  /** Exported name. */
  name: string;
  /** toEnvName(name): put in front of names that come from a header, flag or query name. */
  prefix: string;
  origin?: string;
  notes: string[];
  defaultsNoted: Set<string>;
  renamedNoted: Set<string>;
}

interface SecretOptions {
  /** The name the variable is built from: an env key, header, flag or query name. */
  raw: string;
  where: string;
  /** false only for a stdio env value and an env URL password: their name is the env key. */
  prefix: boolean;
  why?: 'secret' | 'basic-auth';
  scheme?: string;
  urlEncoded?: boolean;
}

function placeOf(s: Server, where: string): VariablePlace {
  return s.origin ? { server: s.name, where, origin: s.origin } : { server: s.name, where };
}

function withPrefix(s: Server, raw: string): string {
  const base = toEnvName(raw);
  return base === s.prefix || base.startsWith(s.prefix + '_') ? base : `${s.prefix}_${base}`;
}

/** A new variable for a secret; returns its name. */
function secretName(s: Server, value: string, o: SecretOptions): string {
  let base = o.prefix ? withPrefix(s, o.raw) : toEnvName(o.raw);
  // Casper hides a variable's value from the AI's shell output only when the name looks secret.
  if (!isCasperSecretName(base)) base += '_SECRET';
  return s.book.take(base, value, o.why ?? 'secret', placeOf(s, o.where), { scheme: o.scheme, urlEncoded: o.urlEncoded });
}

/** A variable only for the sweep: the plain text of a secret that the file holds in another form
 *  (base64 in a Basic header, percent-encoded in an address). Listed only if the sweep finds it. */
function sweepOnly(s: Server, raw: string, value: string): void {
  if (value.length < 6) return;
  let base = withPrefix(s, raw);
  if (!isCasperSecretName(base)) base += '_SECRET';
  s.book.take(base, value, 'secret', undefined);
}

/** A secret found inside an address. raw is the text as written there; when it is percent-encoded,
 *  the variable must be set encoded too, and the plain text gets its own sweep variable. */
function hideUrlPart(s: Server, raw: string, o: SecretOptions, guess = false): string {
  const plain = safeDecode(raw);
  const urlEncoded = plain !== raw;
  const opts: SecretOptions = { ...o, ...(urlEncoded ? { urlEncoded } : {}) };
  const name = guess ? guessed(s, raw, opts) : ref(secretName(s, raw, opts));
  if (urlEncoded) sweepOnly(s, `${o.raw}_PLAIN`, plain);
  return name;
}

/** A ${NAME} the user wrote where Claude Code would fill it in and send it to a remote server.
 *  GreenCLI sent the text as it is, so the export gives it a new name made from the server's name:
 *  a key already set in the user's shell (ANTHROPIC_API_KEY, GITHUB_TOKEN) is then never sent to
 *  that server unless the user sets the new name on purpose. keep: names left as they are. */
function renameRefs(s: Server, text: string, where: string, origin = s.origin, keep?: (name: string) => boolean): string {
  if (!hasReference(text)) return text;
  return text.replace(REFERENCE, (whole, name: string, fallback: string | undefined) => {
    if (keep?.(name)) return whole;
    const place: VariablePlace = origin ? { server: s.name, where, origin } : { server: s.name, where };
    const fresh = s.book.take(`${s.prefix}_${toEnvName(name)}`, name, 'renamed-reference', place);
    const variable = s.book.get(fresh);
    if (variable) variable.from = name;
    if (isCasperSecretName(name) && !s.renamedNoted.has(name)) {
      s.renamedNoted.add(name);
      s.notes.push(
        `${s.name}: ${where} used \${${name}}, which looks like one of your own keys. It is now \${${fresh}}, so a key already set in your shell is not sent to ${origin ?? 'this server'} by mistake. Set ${fresh} only if you trust that server.`,
      );
    }
    return '${' + fresh + (fallback !== undefined ? `:-${fallback}` : '') + '}';
  });
}

/** Args whose ${NAME}s are sent to a remote server: an address, or a header after -H/--header. */
function remoteArgAt(args: readonly string[], i: number): boolean {
  const arg = args[i];
  if (arg.includes('://')) return true;
  const eq = FLAG_EQ.exec(arg) ?? FLAG_SPACE.exec(arg);
  if (eq && HEADER_FLAG.test(eq[2])) return true;
  const prev = i > 0 ? FLAG.exec(args[i - 1])?.[1] : undefined;
  return prev !== undefined && HEADER_FLAG.test(prev);
}

/** The origin of the first http(s) address in the args (mcp-remote's server), if any. */
function remoteOriginOf(args: readonly string[]): string | undefined {
  for (const arg of args) {
    const at = arg.search(/https?:\/\//i);
    if (at < 0) continue;
    try {
      return new URL(arg.slice(at).replace(REFERENCE, 'x')).origin;
    } catch {
      continue;
    }
  }
  return undefined;
}

/** Remove ${X:-default} defaults: every one in a secret position, and secret-looking ones elsewhere. */
function stripDefaults(s: Server, value: string, secret: boolean): string {
  if (!hasReference(value)) return value;
  return value.replace(REFERENCE, (whole, name: string, fallback: string | undefined) => {
    if (fallback === undefined || fallback === '' || !(secret || looksLikeSecretValue(fallback))) return whole;
    if (!s.defaultsNoted.has(name)) {
      s.defaultsNoted.add(name);
      s.notes.push(`${s.name}: the default value in \${${name}:-…} was removed, because it may be a secret. Set ${name} yourself.`);
    }
    return ref(name);
  });
}

/** A value in a secret position: kept when it is already a ${NAME}, otherwise replaced whole. */
function hideWhole(s: Server, value: string, o: SecretOptions): string {
  const v = stripDefaults(s, value, true);
  if (onlyReferences(v)) return v;
  return ref(secretName(s, value, o));
}

/** Like hideWhole, but "Bearer x" keeps "Bearer " and only the token becomes a variable. */
function hideKeepingScheme(s: Server, value: string, o: SecretOptions, minToken = 1): string {
  const m = SCHEME.exec(value);
  if (m && m[2].length >= minToken) return `${m[1]} ${hideWhole(s, m[2], { ...o, scheme: m[1] })}`;
  return hideWhole(s, value, o);
}

function guessed(s: Server, value: string, o: SecretOptions): string {
  const name = secretName(s, value, o);
  s.notes.push(`${s.name}: ${o.where} looked like a secret, so it is now ${ref(name)}.`);
  return ref(name);
}

/** A value hidden only because it is shaped like user:password. It may well be an image tag or
 *  something else harmless, so the note says how to put it back. */
function hideUserPass(s: Server, value: string, o: SecretOptions): string {
  const name = secretName(s, value, o);
  s.notes.push(
    `${s.name}: ${o.where} looked like user:password, so it is now ${ref(name)}. It may not be a secret (an image tag such as node:20-alpine looks the same). If it isn't, put the value back in place of ${ref(name)} in the file, or set ${name} to it.`,
  );
  return ref(name);
}

/** hideUserPass for args: --flag=value, NAME=value, the value after a --flag, or an arg on its own.
 *  The flag or NAME is the name; an arg on its own has none, so it is always hidden. Values after
 *  -H/--header are headers, which the header rule already judged. */
function hideUserPassArgs(s: Server, args: readonly string[]): string[] {
  return args.map((arg, i) => {
    const n = i + 1;
    // --flag=value, "--flag value" typed as one arg, NAME=value.
    const flagged = FLAG_EQ.exec(arg) ?? FLAG_SPACE.exec(arg);
    const bare = flagged ? null : BARE_EQ.exec(arg);
    const named = flagged ? { name: flagged[2], value: flagged.at(-1)! } : bare ? { name: bare[1], value: bare[2] } : undefined;
    if (named) {
      const { name, value } = named;
      const place = flagged ? { flag: `${flagged[1]}${name}` } : { envName: name };
      if (HEADER_FLAG.test(name) || !looksLikeUserPass(value, place) || isPlainValueName(name)) return arg;
      const head = arg.slice(0, arg.length - value.length);
      return head + hideUserPass(s, value, { raw: name, where: `argument ${head.trim()}`, prefix: true });
    }
    if (!looksLikeUserPass(arg, { flag: i > 0 ? args[i - 1] : undefined })) return arg;
    const flag = i > 0 ? FLAG.exec(args[i - 1])?.[1] : undefined;
    if (flag !== undefined && (HEADER_FLAG.test(flag) || isPlainValueName(flag))) return arg;
    return hideUserPass(s, arg, { raw: flag ?? `ARG_${n}`, where: `argument ${n}`, prefix: true });
  });
}

/** The query rule: secret-named values become ${NAME}, and so do values that look like keys whatever
 *  their name (?k=ghp_..., a bare ?ghp_...). Every other pair keeps its bytes. whereFor gets "?name="
 *  or "query" for a pair with no name. */
function hideQuery(s: Server, query: string, whereFor: (label: string) => string): string {
  return query
    .split('&')
    .map((pair) => {
      const eq = pair.indexOf('=');
      const left = eq < 0 ? '' : pair.slice(0, eq);
      const right = eq < 0 ? pair : pair.slice(eq + 1);
      const keep = eq < 0 ? '' : `${left}=`;
      const name = safeDecode(left);
      if (!right) return pair;
      const label = name ? `?${name}=` : 'query';
      if (name && isSecretQueryName(name)) {
        const v = stripDefaults(s, right, true);
        if (onlyReferences(v)) return `${keep}${v}`;
        return keep + hideUrlPart(s, right, { raw: name, where: whereFor(label), prefix: true });
      }
      if (!urlPartLooksSecret(safeDecode(right), true)) return pair;
      return keep + hideUrlPart(s, right, { raw: name || 'QUERY', where: whereFor(label), prefix: true }, true);
    })
    .join('&');
}

/** The path rule: a segment that looks like a key (a long random word, or 32+ hex digits such as a
 *  UUID) becomes ${NAME}. Private links often carry the key in the path. */
function hidePath(s: Server, path: string, o: { raw: string; where: string; prefix: boolean }): string {
  return path
    .split('/')
    .map((segment) => (segment && urlPartLooksSecret(safeDecode(segment), false) ? hideUrlPart(s, segment, o, true) : segment))
    .join('/');
}

const URL_START = /^((?:[a-z][a-z0-9+.-]*:)+)\/\//i;
const SPECIAL_SCHEMES = ['http', 'https', 'ws', 'wss', 'ftp', 'file'];

interface UrlOptions {
  /** env key, or "URL" for an arg. */
  owner: string;
  ownerPrefix: boolean;
  /** "argument 2" or "env DATABASE_URL". */
  where: string;
}

/** Hide the password (or a token used as the user name), key-like path segments and secret query
 *  values in an address inside an arg or env value. String work that follows WHATWG's split points. */
function hideInUrl(s: Server, raw: string, o: UrlOptions): string {
  const m = URL_START.exec(raw);
  if (!m) return raw;
  const last = (m[1].slice(0, -1).split(':').at(-1) ?? '').toLowerCase();
  const special = SPECIAL_SCHEMES.includes(last);
  const rest = raw.slice(m[0].length);
  const end = rest.search(special ? /[/?#\\]/ : /[/?#]/);
  let authority = end < 0 ? rest : rest.slice(0, end);
  let tail = end < 0 ? '' : rest.slice(end);
  const loginWhere = `password in the address in ${o.where}`;

  const at = authority.lastIndexOf('@');
  if (at >= 0) {
    const userinfo = authority.slice(0, at);
    const host = authority.slice(at + 1);
    const colon = userinfo.indexOf(':');
    if (colon >= 0) {
      const user = userinfo.slice(0, colon);
      const password = userinfo.slice(colon + 1);
      if (password) {
        const v = stripDefaults(s, password, true);
        const hidden = onlyReferences(v)
          ? v
          : hideUrlPart(s, password, { raw: `${o.owner}_PASSWORD`, where: loginWhere, prefix: o.ownerPrefix });
        authority = `${user}:${hidden}@${host}`;
      }
    } else if (userinfo && (['http', 'https', 'ws', 'wss'].includes(last) || last.startsWith('snmp'))) {
      // snmp://public@10.0.0.1: the user part is the community.
      const v = stripDefaults(s, userinfo, true);
      const raw = last.startsWith('snmp') ? `${o.owner}_COMMUNITY` : `${o.owner}_TOKEN`;
      const hidden = onlyReferences(v) ? v : hideUrlPart(s, userinfo, { raw, where: loginWhere, prefix: o.ownerPrefix });
      authority = `${hidden}@${host}`;
    }
  }

  const hash = tail.indexOf('#');
  const fragment = hash < 0 ? '' : tail.slice(hash);
  tail = hash < 0 ? tail : tail.slice(0, hash);
  const q = tail.indexOf('?');
  const path = q < 0 ? tail : tail.slice(0, q);
  const query = q < 0 ? '' : '?' + hideQuery(s, tail.slice(q + 1), (label) => `${o.where} ${label}`);
  const hiddenPath = hidePath(s, path, { raw: `${o.owner}_PATH`, where: `address path in ${o.where}`, prefix: o.ownerPrefix });
  return m[0] + authority + hiddenPath + query + fragment;
}

// ─── stdio ───

const FLAG_EQ = /^(--?)([A-Za-z][\w.-]*)=([\s\S]*)$/;
const BARE_EQ = /^([A-Za-z_][\w.-]*)=([\s\S]*)$/;
const FLAG_SPACE = /^(--?)([A-Za-z][\w.-]*)([ \t]+)(\S[\s\S]*)$/;
const HEADER_ARG = /^([A-Za-z][\w-]*)(:[ \t]*)(\S[\s\S]*)$/;
const FLAG = /^--?([A-Za-z][\w.-]*)$/;
/** A real flag (--kebab-case, a short group like -v or -xvf, or --name=value). "-abcdef123" and
 *  "--weird--" are not: after --password they are the password. */
const PLAIN_FLAG = /^(?:--[A-Za-z][A-Za-z0-9]*(?:[-_][A-Za-z0-9]+)*|-[A-Za-z]{1,3})$/;
/** mcp-remote and curl style: --header "Authorization: Bearer x", -H "...". */
const HEADER_FLAG = /^(?:h|header|headers)$/i;

function isNoOrStdin(flag: string): boolean {
  return /^no[-_]/i.test(flag) || /[-_]stdin$/i.test(flag);
}

function isPlainFlag(arg: string): boolean {
  return PLAIN_FLAG.test(arg) || FLAG_EQ.test(arg);
}

/** -p and -P: the password flag of many switch and controller tools. Not when the value is a port, a
 *  port mapping or a version (-p 22, -p 8080:80, uv's -p 3.12), not a package runner's own -p
 *  (npx -p pkg), and never for docker and podman, where -p publishes a port and -P takes no value. */
const PORT_OR_VERSION = /^(?:v?\d+(?:\.\d+)*|[\d.:[\]]+(?:\/(?:tcp|udp))?)$/i;
const RUNNERS = new Set(['npx', 'pnpx', 'pnpm', 'bunx', 'bun', 'npm', 'yarn', 'uvx', 'uv', 'pipx']);
const CONTAINERS = new Set(['docker', 'podman', 'nerdctl']);
const RUNNER_VALUE_FLAG = /^(?:-[pP]|--package|--python|--from|--with)$/;

function isShortPasswordFlag(dashes: string, flag: string): boolean {
  return dashes === '-' && (flag === 'p' || flag === 'P');
}

/** Index of the first arg that is not the package runner's own (0 when the command is no runner, all
 *  of them for docker and podman). */
function runnerFlagsEnd(command: string, args: readonly string[]): number {
  const base = (command.trim().split(/[\\/]/).at(-1) ?? '').toLowerCase().replace(/\.(?:exe|cmd)$/, '');
  if (CONTAINERS.has(base)) return args.length;
  if (!RUNNERS.has(base)) return 0;
  let i = 0;
  while (i < args.length && args[i].startsWith('-')) i += RUNNER_VALUE_FLAG.test(args[i]) ? 2 : 1;
  return i;
}

/** `Name: value` in an arg. In a header position every header but the safe list counts; elsewhere only
 *  secret-looking names do, so `localhost:8080` and `C:\path` are left alone. */
function hideHeaderArg(s: Server, value: string, headerPosition: boolean): string | undefined {
  const m = HEADER_ARG.exec(value);
  if (!m || m[3].startsWith('//')) return undefined;
  const [, name, separator, headerValue] = m;
  if (!(headerPosition ? isSecretHeaderName(name) : isArgHeaderName(name))) return undefined;
  return `${name}${separator}${hideKeepingScheme(s, headerValue, { raw: name, where: `argument "${name}: …"`, prefix: true })}`;
}

interface ArgValueOptions {
  n: number;
  /** Name the backstop variable is built from. */
  base: string;
  headerPosition: boolean;
  checkHeader: boolean;
}

/** A value with no secret name: a header, an address, or (last resort) something that looks secret. */
function argValue(s: Server, value: string, o: ArgValueOptions): string {
  if (o.checkHeader) {
    const header = hideHeaderArg(s, value, o.headerPosition);
    if (header !== undefined) return header;
  }
  if (URL_START.test(value)) {
    const hidden = hideInUrl(s, value, { owner: 'URL', ownerPrefix: true, where: `argument ${o.n}` });
    if (hidden !== value) return hidden;
  }
  if (!isPlainFlag(value) && !onlyReferences(value) && looksLikeSecretValue(value)) {
    return guessed(s, value, { raw: o.base, where: `argument ${o.n}`, prefix: true });
  }
  return value;
}

function exportArgs(s: Server, command: string, args: readonly string[]): string[] {
  const out: string[] = [];
  const runnerEnd = runnerFlagsEnd(command, args);
  /** Whether this flag's value is a secret. at: the flag's index. */
  const secretFlag = (dashes: string, flag: string, value: string | undefined, at: number): boolean =>
    isShortPasswordFlag(dashes, flag)
      ? at >= runnerEnd && value !== undefined && !PORT_OR_VERSION.test(value)
      : isSecretFlagName(flag) && !isNoOrStdin(flag) && !(value !== undefined && plainSwitchValue(flag, value));
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const n = i + 1;
    const prevFlag = i > 0 ? FLAG.exec(args[i - 1])?.[1] : undefined;
    const headerPosition = prevFlag !== undefined && HEADER_FLAG.test(prevFlag);

    // 1. Already a ${NAME}.
    if (onlyReferences(arg)) {
      out.push(arg);
      continue;
    }
    // 2. --name=value
    let m = FLAG_EQ.exec(arg);
    if (m && m[3] !== '') {
      const [, dashes, name, value] = m;
      out.push(
        `${dashes}${name}=` +
          (secretFlag(dashes, name, value, i)
            ? hideKeepingScheme(s, value, { raw: name, where: `argument ${dashes}${name}=`, prefix: true })
            : argValue(s, value, { n, base: name, headerPosition: HEADER_FLAG.test(name), checkHeader: true })),
      );
      continue;
    }
    // 3. NAME=value (Authorization=Bearer x, api_key=xyz)
    m = BARE_EQ.exec(arg);
    if (m && m[2] !== '') {
      const [, name, value] = m;
      out.push(
        `${name}=` +
          (isArgHeaderName(name) && !plainSwitchValue(name, value)
            ? hideKeepingScheme(s, value, { raw: name, where: `argument ${name}=`, prefix: true })
            : argValue(s, value, { n, base: name, headerPosition: false, checkHeader: true })),
      );
      continue;
    }
    // 4. "--token abc" typed on one line (one arg).
    m = FLAG_SPACE.exec(arg);
    if (m) {
      const [, dashes, flag, space, value] = m;
      out.push(
        `${dashes}${flag}${space}` +
          (secretFlag(dashes, flag, value, i)
            ? hideKeepingScheme(s, value, { raw: flag, where: `argument ${dashes}${flag}`, prefix: true })
            : argValue(s, value, { n, base: flag, headerPosition: HEADER_FLAG.test(flag), checkHeader: true })),
      );
      continue;
    }
    // 5. "Authorization: Bearer x" (mcp-remote --header).
    const header = hideHeaderArg(s, arg, headerPosition);
    if (header !== undefined) {
      out.push(header);
      continue;
    }
    // 6. -pPASSWORD glued together (mysql style), after the package runner's own flags. Only when the
    //    rest has a letter and a digit or symbol, so -port and -p8080 stay.
    const glued = /^-([pP])(\S{3,})$/.exec(arg);
    if (glued && i >= runnerEnd && /[A-Za-z]/.test(glued[2]) && /[^A-Za-z]/.test(glued[2]) && !PORT_OR_VERSION.test(glued[2])) {
      out.push(`-${glued[1]}` + hideWhole(s, glued[2], { raw: 'p', where: `argument -${glued[1]}…`, prefix: true }));
      continue;
    }
    // 7. --token, then its value in the next arg (even one starting with "-", unless it is a real flag).
    const flag = FLAG.exec(arg)?.[1];
    const next = args[i + 1];
    if (flag !== undefined && secretFlag(arg.startsWith('--') ? '--' : '-', flag, next, i)) {
      out.push(arg);
      if (next !== undefined && !isPlainFlag(next)) {
        out.push(hideKeepingScheme(s, next, { raw: flag, where: `argument ${arg}`, prefix: true }));
        i++;
      }
      continue;
    }
    // 8 and 9. An address, or a value that looks secret.
    out.push(argValue(s, arg, { n, base: prevFlag ?? `ARG_${n}`, headerPosition, checkHeader: false }));
  }
  return out;
}

function exportEnvValue(s: Server, key: string, value: string): string {
  if (value === '') return value;
  if (isSecretEnvKey(key) && !plainSwitchValue(key, value)) {
    return hideKeepingScheme(s, value, { raw: key, where: `env ${key}`, prefix: false });
  }
  if (onlyReferences(stripDefaults(s, value, false))) return value;
  const m = SCHEME.exec(value);
  if (m && m[2].length >= 8) return hideKeepingScheme(s, value, { raw: key, where: `env ${key}`, prefix: false }, 8);
  if (URL_START.test(value)) {
    const hidden = hideInUrl(s, value, { owner: key, ownerPrefix: false, where: `env ${key}` });
    if (hidden !== value) return hidden;
  }
  if (looksLikeSecretValue(value)) return guessed(s, value, { raw: key, where: `env ${key}`, prefix: false });
  return value;
}

function isAbsolutePath(path: string): boolean {
  return /^(?:[/~]|[A-Za-z]:[\\/]|\\\\)/.test(path);
}

/** Whether the server depends on the folder it starts in (Claude Code and Casper use the project folder). */
function usesStartFolder(command: string, args: readonly string[]): boolean {
  const cmd = command.trim();
  if (!isAbsolutePath(cmd) && /[\\/]/.test(cmd)) return true;
  const base = (cmd.split(/[\\/]/).at(-1) ?? '').toLowerCase().replace(/\.(?:exe|cmd)$/, '');
  // Casper's needsProjectFolder rule (import.ts), without addresses and npm @scope/ names.
  const relativeArg = args.some(
    (arg) =>
      !arg.startsWith('-') &&
      !isAbsolutePath(arg) &&
      !arg.startsWith('${') &&
      !arg.startsWith('@') &&
      !arg.includes('://') &&
      (arg.startsWith('.') || arg.includes('/') || /\.(?:py|js|mjs|ts)$/.test(arg)),
  );
  return (
    relativeArg ||
    args.includes('-m') ||
    base === 'npx' ||
    (base === 'uv' && args.includes('run') && !args.some((arg) => arg === '--directory' || arg.startsWith('--directory=')))
  );
}

// ─── Build ───

interface Built {
  s: Server;
  def: McpServerDef;
  /** stdio */
  command?: string;
  args?: string[];
  env?: [string, string][];
  /** http: protocol//host, never changed, then path+query. */
  head?: string;
  rest?: string;
  headers?: [string, string][];
  hostname?: string;
  protocol?: string;
}

function sortedEntries(map: Record<string, string> | null | undefined): [string, string][] {
  return Object.entries(map ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

export function buildMcpExport(servers: readonly McpServerDef[], options: McpExportOptions = {}): McpExportResult {
  const withCredentials = options.withCredentials ?? new Set<string>();
  const notes: string[] = [];
  const book = new NameBook();

  // Step 1: skips. A server whose writes are off is exported as GreenCLI starts it: with its pins.
  const kept: { def: McpServerDef; url?: URL }[] = [];
  for (const def of servers.map((d) => withPins(d, options.pins?.get(d.name)))) {
    const quoted = `"${def.name}"`;
    if (def.transport === 'http') {
      const raw = (def.url ?? '').trim();
      if (!raw) {
        notes.push(`${quoted} was left out: it has no server URL.`);
        continue;
      }
      let url: URL | undefined;
      try {
        url = new URL(raw);
      } catch {
        url = undefined;
      }
      if (!url || (url.protocol !== 'http:' && url.protocol !== 'https:')) {
        notes.push(`${quoted} was left out: its server URL is not valid.`);
        continue;
      }
      kept.push({ def, url });
    } else {
      if ((def.command ?? '').trim() === '') {
        notes.push(`${quoted} was left out: it has no command.`);
        continue;
      }
      if (isShell(def.command)) {
        notes.push(`${quoted} was left out: GreenCLI does not start shell programs (like bash or PowerShell) as MCP servers.`);
        continue;
      }
      kept.push({ def });
    }
  }

  // Step 2: server names. A valid name is never renamed.
  const used = new Set<string>();
  const names = new Map<McpServerDef, string>();
  for (const { def } of kept) {
    if (VALID_NAME.test(def.name) && !used.has(def.name)) {
      used.add(def.name);
      names.set(def, def.name);
    }
  }
  for (const { def } of kept) {
    if (names.has(def)) continue;
    const base = exportServerName(def.name);
    if (!used.has(base)) {
      used.add(base);
      names.set(def, base);
      notes.push(`"${def.name}" is saved as "${base}". Names can only use letters, numbers, - and _.`);
      continue;
    }
    for (let i = 2; ; i++) {
      const suffix = `-${i}`;
      const candidate = base.slice(0, 64 - suffix.length) + suffix;
      if (used.has(candidate)) continue;
      used.add(candidate);
      names.set(def, candidate);
      notes.push(`"${def.name}" is saved as "${candidate}", because another server already uses "${base}".`);
      break;
    }
  }

  // Steps 3 and 4: normalize, then reserve every ${NAME} the user wrote that stays as it is, before any
  // new name is made. The ones sent to a remote server (every one in an http server, and in a stdio
  // server's addresses and -H headers) are renamed in step 5 instead; see renameRefs.
  const prepared = kept.map(({ def, url }) => {
    const name = names.get(def) ?? exportServerName(def.name);
    const s: Server = { book, name, prefix: toEnvName(name), notes: [], defaultsNoted: new Set(), renamedNoted: new Set() };
    let credVar: string | undefined;
    let keepRef: ((name: string) => boolean) | undefined;
    if (url) {
      s.origin = url.origin;
    } else {
      if (withCredentials.has(def.name)) credVar = def.credentialsEnvVar?.trim() || 'CREDS_PATH';
      const env = sortedEntries(def.env).filter(([k]) => k !== credVar);
      // A stdio server's own env keys (mcp-remote's --header "Authorization:${AUTH_HEADER}") and HOME and
      // the like stay: the server itself fills those in.
      const envKeys = new Set(env.map(([k]) => k));
      keepRef = (ref) => envKeys.has(ref) || STANDARD_VARS.has(ref);
      const args = def.args ?? [];
      const texts = [def.command, ...env.map(([, v]) => v)];
      args.forEach((arg, i) => {
        if (!remoteArgAt(args, i)) texts.push(arg);
      });
      for (const text of texts) for (const m of text.matchAll(REFERENCE)) book.reserve(m[1]);
      args.forEach((arg, i) => {
        if (remoteArgAt(args, i)) for (const m of arg.matchAll(REFERENCE)) if (keepRef?.(m[1])) book.reserve(m[1]);
      });
    }
    return { def, url, s, credVar, keepRef };
  });

  // Step 5: transform.
  const built: Built[] = prepared.map(({ def, url, s, credVar, keepRef }) => {
    if (!url) {
      const raw = def.args ?? [];
      const remote = remoteOriginOf(raw);
      const renamed = raw.map((arg, i) => (remoteArgAt(raw, i) ? renameRefs(s, arg, `argument ${i + 1}`, remote, keepRef) : arg));
      const args = exportArgs(s, def.command, renamed);
      const env = sortedEntries(def.env)
        .filter(([key]) => key !== credVar)
        .map(([key, value]): [string, string] => [key, exportEnvValue(s, key, value)]);
      if (credVar) {
        const name = book.take(withPrefix(s, credVar), undefined, 'credentials-file', placeOf(s, `env ${credVar}`));
        const variable = book.get(name);
        if (variable) variable.greencliName = def.name;
        env.push([credVar, ref(name)]);
        env.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      }
      const cwd = def.cwd?.trim();
      if (cwd) {
        s.notes.push(
          `${s.name}: its working folder (${cwd}) is left out, because Claude Code has no setting for it. Claude Code and Casper start it in the project folder instead, so files there can change what runs. Use full paths in the command and args. For uv, add --directory ${cwd} to the args.`,
        );
      } else if (usesStartFolder(def.command, def.args ?? [])) {
        s.notes.push(
          `${s.name}: Claude Code and Casper start this in the project folder you open, so files in that folder can change what runs. Use full paths if you can.`,
        );
      }
      return { s, def, command: def.command.trim(), args, env };
    }

    const login = url.username || url.password ? `${safeDecode(url.username)}:${safeDecode(url.password)}` : undefined;
    const headers = sortedEntries(def.headers).map(([name, given]): [string, string] => {
      if (given === '') return [name, given];
      const value = renameRefs(s, given, `header ${name}`);
      const o: SecretOptions = { raw: name, where: `header ${name}`, prefix: true };
      if (isSecretHeaderName(name)) return [name, hideKeepingScheme(s, value, o)];
      if (!onlyReferences(value) && looksLikeSecretValue(value)) return [name, guessed(s, value, o)];
      return [name, value];
    });
    if (login !== undefined) {
      if (!headers.some(([name]) => name.toLowerCase() === 'authorization')) {
        const name = secretName(s, login, { raw: 'AUTHORIZATION', where: 'header Authorization', prefix: true, why: 'basic-auth' });
        headers.push(['Authorization', `Basic ${ref(name)}`]);
        // The variable is the login in base64. The plain login (and password) elsewhere in the file
        // get their own variables from the sweep.
        sweepOnly(s, 'LOGIN', login);
        if (url.password) sweepOnly(s, 'PASSWORD', safeDecode(url.password));
        headers.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
        s.notes.push(`${s.name}: the login in the address was moved to an Authorization header, because Claude Code and Casper don't accept it in the address.`);
      } else {
        s.notes.push(
          `${s.name}: the address had a login in it, and you also set an Authorization header. GreenCLI sent both. The export keeps only the header, so check that it is the right login.`,
        );
      }
    }
    // The address as reqwest sent it: no login, no #fragment, "\" read as "/".
    const path = hidePath(s, url.pathname, { raw: 'URL_PATH', where: 'address path', prefix: true });
    const search = renameRefs(s, url.search, 'address');
    const query = search ? '?' + hideQuery(s, search.slice(1), (label) => `address ${label}`) : '';
    return {
      s,
      def,
      head: `${url.protocol}//${url.host}`,
      rest: path + query,
      headers,
      hostname: url.hostname,
      protocol: url.protocol,
    };
  });

  // Secret-looking defaults anywhere else.
  for (const b of built) {
    const strip = (value: string) => stripDefaults(b.s, value, false);
    if (b.args) b.args = b.args.map(strip);
    if (b.env) b.env = b.env.map(([k, v]) => [k, strip(v)]);
    if (b.headers) b.headers = b.headers.map(([k, v]) => [k, strip(v)]);
    if (b.rest !== undefined) b.rest = strip(b.rest);
  }

  // Step 6: sweep. A secret found once is also replaced where it sits under a harmless name.
  const literals = book.literals();
  if (literals.length) {
    for (const b of built) {
      // Each replacement adds a ${NAME}; the rest of the loop must skip it, so sweep literal pieces in turn.
      const sweepAll = (value: string, where: string): string => {
        let out = value;
        for (const { name, value: secret } of literals) {
          const next = mapLiterals(out, (text) => (text.includes(secret) ? text.split(secret).join(ref(name)) : text));
          if (next !== out) {
            book.addPlace(name, placeOf(b.s, where));
            out = next;
          }
        }
        return out;
      };
      if (b.args) b.args = b.args.map((v, i) => sweepAll(v, `argument ${i + 1}`));
      if (b.env) b.env = b.env.map(([k, v]) => [k, sweepAll(v, `env ${k}`)]);
      if (b.headers) b.headers = b.headers.map(([k, v]) => [k, sweepAll(v, `header ${k}`)]);
      if (b.rest !== undefined) b.rest = sweepAll(b.rest, 'address');
    }
  }

  // Step 6b: a user:password value that the sweep didn't already replace, unless its name says it
  // holds no secret.
  for (const b of built) {
    if (b.env) {
      b.env = b.env.map(([k, v]) => [
        k,
        looksLikeUserPass(v, { envName: k }) && !isPlainValueName(k) ? hideUserPass(b.s, v, { raw: k, where: `env ${k}`, prefix: false }) : v,
      ]);
    }
    if (b.args) b.args = hideUserPassArgs(b.s, b.args);
  }

  // Step 7: finish.
  const entries: [string, ExportedServer][] = [];
  const writesLost: string[] = [];
  const keptNames = new Set<string>();
  for (const b of built) {
    const { s } = b;
    if (b.head !== undefined && b.rest !== undefined) {
      const url = b.head + b.rest;
      let sameOrigin = false;
      try {
        sameOrigin = new URL(url.replace(REFERENCE, 'x')).origin === s.origin;
      } catch {
        sameOrigin = false;
      }
      if (!sameOrigin) {
        notes.push(`"${b.def.name}" was left out: its server URL is not valid.`);
        continue;
      }
      if (b.protocol === 'http:' && !LOOPBACK.includes(b.hostname ?? '')) {
        s.notes.push(`${s.name}: Casper only connects to https:// addresses (or to this computer), so Casper will skip this server. Claude Code will use it.`);
      }
      if (hasReference(url)) {
        s.notes.push(
          `${s.name}: the address has a \${...} variable. Claude Code fills it in. Casper does not, so Casper sends the text as it is. If Casper needs this server, send the token in a header instead.`,
        );
      }
      const headers = b.headers ?? [];
      entries.push([s.name, { type: 'http', url, ...(headers.length ? { headers: Object.fromEntries(headers) } : {}) }]);
      // The user's own ${NAME}s, with where they now go.
      referencePlaces(book, s, [
        ['address', url],
        ...headers.map(([k, v]): [string, string] => [`header ${k}`, v]),
      ]);
    } else {
      const env = b.env ?? [];
      entries.push([
        s.name,
        { type: 'stdio', command: b.command ?? '', args: b.args ?? [], ...(env.length ? { env: Object.fromEntries(env) } : {}) },
      ]);
      referencePlaces(
        book,
        s,
        [
          ['command', b.command ?? ''],
          ...(b.args ?? []).map((v, i): [string, string] => [`argument ${i + 1}`, v]),
          ...env.map(([k, v]): [string, string] => [`env ${k}`, v]),
        ],
        STANDARD_VARS,
      );
    }
    if (b.def.enabled === false) {
      s.notes.push(`${s.name}: it is turned off in GreenCLI, but Claude Code and Casper will offer to start it. Remove it from the file if you don't want it.`);
    }
    if (b.def.writes !== 'on') {
      const pins = options.pins?.get(b.def.name);
      if (b.def.transport !== 'http' && pins?.kind === 'pinned') {
        s.notes.push(`${s.name}: writes are off in GreenCLI, so its read-only settings are in the file too (${pins.shown.join(', ')}).`);
      } else {
        writesLost.push(s.name);
      }
    }
    keptNames.add(s.name);
    notes.push(...s.notes);
  }
  if (writesLost.length) {
    const one = writesLost.length === 1;
    notes.push(
      `Writes are off in GreenCLI for ${joinNames(writesLost)}, but the file can't keep that. ` +
        `Claude Code will offer ${one ? 'its' : 'their'} tools that change things. Casper starts every server with writes off.`,
    );
  }

  // GreenCLI's own read-only server. It has nothing secret in it: just its path, and the app's
  // data folder. On Linux, Casper starts it without XDG_DATA_HOME, so without the folder it
  // could read another one than the app's.
  const greencli = options.greencli;
  if (greencli && 'command' in greencli) {
    let name = GREENCLI_SERVER_NAME;
    for (let i = 2; used.has(name); i++) name = `${GREENCLI_SERVER_NAME}-${i}`;
    used.add(name);
    if (name !== GREENCLI_SERVER_NAME) {
      notes.push(`GreenCLI's read-only server is saved as "${name}", because another server already uses "${GREENCLI_SERVER_NAME}".`);
    }
    entries.push([name, { type: 'stdio', command: greencli.command, args: ['--data-dir', greencli.dataDir] }]);
    if (greencli.showCommands) {
      notes.push(
        `"${name}" can also run show commands on device tabs connected in GreenCLI. GreenCLI asks you each time, and Casper asks first too. Turn it off in MCP Servers.`,
      );
    }
  } else if (greencli) {
    notes.push(
      greencli.leftOut === 'missing'
        ? `"${GREENCLI_SERVER_NAME}" (GreenCLI's read-only server) was left out: greencli-mcp isn't next to GreenCLI in this build.`
        : `"${GREENCLI_SERVER_NAME}" (GreenCLI's read-only server) was left out: move GreenCLI to Applications first, then export again.`,
    );
  }

  const count = entries.length;
  if (count > CASPER_MAX_SERVERS) {
    notes.push(`Casper uses at most ${CASPER_MAX_SERVERS} servers in total, from all its files together. This file alone has ${count}.`);
  }
  const file: McpExportFile = { mcpServers: Object.fromEntries(entries) };
  const variables = book.order
    .map((variable) => ({ ...variable, places: variable.places.filter((place) => keptNames.has(place.server)) }))
    .filter((variable) => variable.places.length > 0);
  return { file, text: JSON.stringify(file, null, 2) + '\n', count, variables, notes };
}

/** "a", "a and b", "a, b and c" */
function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

function referencePlaces(book: NameBook, s: Server, values: [string, string][], skip?: ReadonlySet<string>): void {
  for (const [where, value] of values) {
    for (const m of value.matchAll(REFERENCE)) {
      const name = m[1];
      if (skip?.has(name) || !book.isUsersOwn(name)) continue;
      book.addPlace(name, placeOf(s, where));
    }
  }
}

// ─── Summary ───

export interface ExportSummary {
  title: string;
  variablesIntro: string;
  variables: { name: string; text: string }[];
  whereToPut: string;
  notes: string[];
  check: string;
}

function placesText(places: readonly VariablePlace[]): string {
  return places.map((p) => `${p.server} (${p.where}${p.origin ? `, sent to ${p.origin}` : ''})`).join(' and ');
}

function variableText(v: VariableToSet): string {
  const places = placesText(v.places);
  switch (v.why) {
    case 'secret':
      return (
        `the secret that was in ${places}.` +
        (v.scheme ? ` Set just the token, without "${v.scheme}".` : '') +
        (v.urlEncoded ? ' It sits in an address, so set it URL-encoded, the way it was written there (for example %40 for @ and %2F for /).' : '')
      );
    case 'basic-auth':
      return `the login that was in the address of ${places}: the user name, a colon, then the password (for a token with no password, the token and a colon), base64-encoded. To make it without saving it in your shell history, run base64, type the text, then press Control-D twice.`;
    case 'credentials-file': {
      const server = v.greencliName ?? v.places[0]?.server ?? '';
      return `the full path to a credentials file for ${server}. GreenCLI keeps its saved copy private and does not show it again, so use your own copy: the credentials you pasted into ${server} in GreenCLI, saved in a file that only you can read (chmod 600). Set this to that file's full path.`;
    }
    case 'already-a-reference':
      return `already written as a variable in ${places}. GreenCLI sent it as plain text, but Claude Code and Casper will fill it in from your environment. If it is already set in your shell, this server gets it. Remove it from the file unless this server should have it.`;
    case 'renamed-reference':
      return `written as \${${v.from ?? ''}} in ${places}. GreenCLI sent that text as it is, but Claude Code fills it in and sends it to the server. So it has a new name, and a ${v.from ?? ''} already set in your shell is not sent there by mistake. Set it only if you trust that server.`;
  }
}

export function exportSummary(result: McpExportResult, savedTo: string): ExportSummary {
  return {
    title: `Saved ${result.count} server${result.count === 1 ? '' : 's'} to ${savedTo}`,
    variablesIntro: result.variables.length
      ? [
          'GreenCLI replaced the passwords and tokens it found with ${NAME} variables, listed below. Check the file for any it missed.',
          "To set them, put export NAME='value' lines in a file only you can read (chmod 600). Then run source on that file in the terminal you start Claude Code or Casper from.",
          "Typing them in works too, but saves them in your shell history. Don't put them in ~/.zshrc: every program you start would see them.",
          "Programs started from that terminal, including the AI's own shell commands, can read them.",
        ].join('\n')
      : 'GreenCLI found no passwords or tokens, so there is nothing to set.',
    variables: result.variables.map((v) => ({ name: v.name, text: variableText(v) })),
    whereToPut:
      'Claude Code reads .mcp.json in the folder you start it in. Casper reads .mcp.json in your project folder, and ~/.mcp.json in your home folder. ' +
      'In Casper, type /mcp connect NAME once for each server. ' +
      "GreenCLI's approval box doesn't go with the file: Claude Code and Casper ask in their own way. " +
      'If a file was already there, it was replaced, not merged. On a Mac, Finder hides names that start with a dot; press Command-Shift-. to see them.',
    notes: result.notes,
    check: 'Values that look like passwords, keys or tokens were replaced, but check the file before you share it.',
  };
}
