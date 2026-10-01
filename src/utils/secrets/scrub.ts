// Copied from casper src/secrets/scrub.ts @ 81438ae. Do not edit here: change Casper, re-copy.
// Left out here: the node:path import and the file-read rules (CODE_EXTENSIONS … shouldScrubRead).
// ---- casper source below ----
import {
  AUTH_SERVER_BLOCK, CONFIG_ANCHORS, JUNOS_SNMP_BLOCK, KIND_ORDER, KIND_WORDS, PEM_BEGIN, PEM_END, SECRET_RULES,
  keepLiterally, replaceSpans, windowedSpans, type SecretKind, type SecretRule,
} from "./patterns";

/** What the AI sees in place of a secret value. */
export const SECRET_MARKER = "<secret hidden>";
/** What the AI sees when a whole line had to go (the extra netconan check found something). */
export const LINE_MARKER = "<line hidden: secret>";

export interface ScrubTextResult { text: string; hidden: number; kinds: SecretKind[] }
export interface ScrubValueResult<T = unknown> { value: T; hidden: number; kinds: SecretKind[] }

interface Span { start: number; end: number; kind: SecretKind }

function ruleSpans(line: string, rules: readonly SecretRule[]): Span[] {
  const spans: Span[] = [];
  for (const rule of rules) {
    rule.re.lastIndex = 0;
    for (let match = rule.re.exec(line); match; match = rule.re.exec(line)) {
      if (match[0].length === 0) rule.re.lastIndex++;
      for (const group of rule.groups) {
        const indices = match.indices?.[group];
        const found = match[group];
        if (!indices || found === undefined) continue;
        let [start, end] = indices;
        // Quoted values keep their quotes; only the inside is replaced.
        if (found.length >= 2 && (found[0] === "\"" || found[0] === "'") && found.at(-1) === found[0]) { start++; end--; }
        const inner = line.slice(start, end);
        if (keepLiterally(inner) || line.startsWith(SECRET_MARKER, start)) continue;
        spans.push({ start, end, kind: rule.kind });
      }
    }
  }
  return spans;
}

function mergeSpans(spans: Span[]): Span[] {
  const sorted = [...spans].sort((a, b) => a.start - b.start || b.end - a.end);
  const merged: Span[] = [];
  for (const span of sorted) {
    const last = merged.at(-1);
    if (last && span.start < last.end) { last.end = Math.max(last.end, span.end); continue; }
    merged.push({ ...span });
  }
  return merged;
}

function orderKinds(kinds: Set<SecretKind>): SecretKind[] {
  return KIND_ORDER.filter((kind) => kinds.has(kind));
}

const LINE_RULES = SECRET_RULES.filter((entry) => !entry.block);
const AUTH_SERVER_RULES = SECRET_RULES.filter((entry) => entry.block === "auth-server");
const JUNOS_SNMP_RULES = SECRET_RULES.filter((entry) => entry.block === "junos-snmp");

function indentOf(line: string): number { return /^\s*/.exec(line)![0].length; }

/**
 * Hide known secret formats line by line. Block state covers AOS 8 / Cisco
 * RADIUS and TACACS server blocks ("key X" only counts inside them), Junos
 * curly "snmp { community NAME }", and PEM private keys.
 */
export function scrubText(text: string): ScrubTextResult {
  const lines = text.split("\n");
  const kinds = new Set<SecretKind>();
  let hidden = 0;
  let authIndent: number | undefined;
  let snmpDepth: number | undefined;
  let depth = 0;
  let inPem = false;
  for (let index = 0; index < lines.length; index++) {
    const raw = lines[index]!;
    const carriage = raw.endsWith("\r");
    const line = carriage ? raw.slice(0, -1) : raw;
    if (inPem) {
      if (PEM_END.test(line)) { inPem = false; continue; }
      lines[index] = SECRET_MARKER + (carriage ? "\r" : "");
      continue;
    }
    if (PEM_BEGIN.test(line)) {
      inPem = !PEM_END.test(line.slice(line.search(PEM_BEGIN) + 16));
      hidden++;
      kinds.add("private-key");
      if (!inPem) lines[index] = line.replace(/(-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----)[\s\S]*?(-----END)/, `$1${SECRET_MARKER}$2`) + (carriage ? "\r" : "");
      continue;
    }
    const trimmed = line.trim();
    if (authIndent !== undefined && trimmed && (indentOf(line) <= authIndent || trimmed === "!")) authIndent = undefined;
    const auth = AUTH_SERVER_BLOCK.exec(line);
    const rules: SecretRule[] = [...LINE_RULES];
    if (authIndent !== undefined) rules.push(...AUTH_SERVER_RULES);
    if (snmpDepth !== undefined) rules.push(...JUNOS_SNMP_RULES);
    if (auth) authIndent = auth[1]!.length;
    if (JUNOS_SNMP_BLOCK.test(line) && snmpDepth === undefined) snmpDepth = depth;
    for (const char of line) {
      if (char === "{") depth++;
      else if (char === "}") depth = Math.max(0, depth - 1);
    }
    if (snmpDepth !== undefined && depth <= snmpDepth && !JUNOS_SNMP_BLOCK.test(line)) snmpDepth = undefined;
    const spans = mergeSpans(windowedSpans(line, (part) => ruleSpans(part, rules)));
    if (!spans.length) continue;
    for (const span of spans) kinds.add(span.kind);
    hidden += spans.length;
    lines[index] = replaceSpans(line, spans, SECRET_MARKER) + (carriage ? "\r" : "");
  }
  return { text: hidden ? lines.join("\n") : text, hidden, kinds: orderKinds(kinds) };
}

/** True when the text has at least two config anchor lines, or any strict rule hits. */
export function looksLikeDeviceConfig(text: string): boolean {
  let anchors = 0;
  for (const anchor of CONFIG_ANCHORS) if (anchor.test(text) && ++anchors >= 2) return true;
  const strict = SECRET_RULES.filter((entry) => entry.strict && !entry.block);
  for (const line of text.split("\n")) {
    if (PEM_BEGIN.test(line)) return true;
    if (windowedSpans(line, (part) => ruleSpans(part, strict)).length) return true;
  }
  return false;
}

const SECRET_KEYS = new Set(["password", "passwd", "passphrase", "psk", "secret", "shared_secret", "radius_secret", "community",
  "community_name", "community_string", "auth_key", "priv_key", "private_key", "client_secret", "api_key", "access_token",
  "refresh_token", "key_string", "wpa_passphrase",
  // AOS-CX REST: RADIUS/TACACS server passkey, SNMPv3 user pass phrases, the system's list of SNMP communities.
  "passkey", "pass_phrase", "snmp_communities"]);
/** Learned from hpe-networking-mcp: a "_key" rule broke _pagination.list_key. */
const NEVER_SECRET_KEYS = new Set(["next_cursor", "cursor", "list_key", "key", "public_key"]);

export function snakeKey(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/[-\s.]+/g, "_").toLowerCase();
}

export function isSecretKey(name: string): boolean {
  const key = snakeKey(name);
  if (NEVER_SECRET_KEYS.has(key)) return false;
  if (SECRET_KEYS.has(key) || /_(?:password|secret|psk|passphrase|pass_phrase|passkey|community)$/.test(key)) return true;
  // Device keys under their own names: pre_shared_key, tacacs_key, wep_key, secret_key, papi_security_key,
  // ospf_auth_md5_keys (AOS-CX: a map of key id to key), ...
  if (SECRET_KEY_SUFFIX.test(key)) return true;
  // Login tokens (token, api_token, bearer_token), but not paging tokens (next_token, page_token).
  return /(^|_)token$/.test(key) && !PAGING_TOKEN.test(key);
}
const SECRET_KEY_SUFFIX = /(^|_)(?:pre_?shared|shared|psk|wpa|wep|tacacs|radius|md5|auth|authentication|encryption|secret|private|priv|api|server|security)_keys?$/;
const PAGING_TOKEN = /(^|_)(?:next|page|continuation|pagination|cursor|sync|resume|start|continue)(_|$)/;

function keyKind(name: string): SecretKind {
  const key = snakeKey(name);
  if (/communit(?:y|ies)/.test(key)) return "community";
  if (/psk|passphrase/.test(key)) return "psk";
  if (/key|token/.test(key)) return "key";
  return "password";
}

/**
 * The value under a secret-named key, with every string in it hidden: the string itself, a list of
 * strings (snmp_communities) or a map of strings (ospf_auth_md5_keys: {"1": "..."}). Undefined when
 * nothing was hidden or the value holds objects, so the walk looks at it key by key as usual.
 */
function hideUnderSecretKey(value: unknown): { value: unknown; hidden: number } | undefined {
  if (typeof value === "string") return value && !keepLiterally(value) ? { value: SECRET_MARKER, hidden: 1 } : undefined;
  if (!value || typeof value !== "object") return undefined;
  const entries = Array.isArray(value) ? value : Object.values(value);
  if (entries.some((entry) => entry !== null && typeof entry === "object")) return undefined;
  let hidden = 0;
  const swap = (entry: unknown) => {
    if (typeof entry !== "string" || !entry || keepLiterally(entry)) return entry;
    hidden++;
    return SECRET_MARKER;
  };
  const next = Array.isArray(value) ? value.map(swap)
    : Object.fromEntries(Object.entries(value).map(([name, entry]) => [name, swap(entry)]));
  return hidden ? { value: next, hidden } : undefined;
}

const MAX_DEPTH = 64;

/**
 * Walk an MCP result (or any JSON-like value) and hide secrets. Text blocks
 * that hold JSON are parsed, scrubbed and written back as JSON, so the text
 * contract of the result stays the same. Nothing is changed in place.
 */
export function scrubValue<T>(input: T, scrubString: (text: string) => ScrubTextResult = scrubText): ScrubValueResult<T> {
  const kinds = new Set<SecretKind>();
  let hidden = 0;
  const add = (result: { hidden: number; kinds: SecretKind[] }) => {
    hidden += result.hidden;
    for (const kind of result.kinds) kinds.add(kind);
  };
  const seen = new WeakSet<object>();
  const text = (value: string): string => {
    const trimmed = value.trimStart();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        const parsed: unknown = JSON.parse(value);
        const inner = scrubValue(parsed, scrubString);
        if (!inner.hidden) return value;
        add(inner);
        return JSON.stringify(inner.value, null, /\n\s/.test(value) ? 2 : undefined);
      } catch { /* not JSON: scrub as text */ }
    }
    const result = scrubString(value);
    add(result);
    return result.text;
  };
  const walk = (value: unknown, depth: number, underPagination: boolean): unknown => {
    if (typeof value === "string") return text(value);
    if (!value || typeof value !== "object" || depth > MAX_DEPTH) return value;
    if (seen.has(value)) return value;
    seen.add(value);
    if (Array.isArray(value)) return value.map((entry) => walk(entry, depth + 1, underPagination));
    const out: Record<string, unknown> = {};
    for (const [name, entry] of Object.entries(value as Record<string, unknown>)) {
      const pagination = underPagination || snakeKey(name) === "_pagination";
      const secret = !pagination && isSecretKey(name) ? hideUnderSecretKey(entry) : undefined;
      if (secret) {
        out[name] = secret.value;
        hidden += secret.hidden;
        kinds.add(keyKind(name));
        continue;
      }
      out[name] = walk(entry, depth + 1, pagination);
    }
    return out;
  };
  const value = walk(input, 0, false) as T;
  return { value: hidden ? value : input, hidden, kinds: orderKinds(kinds) };
}

/**
 * The string leaves scrubValue would pass to its text scrubber (JSON text
 * blocks are opened the same way), limited to ones that look like device config.
 */
export function configStrings(input: unknown, limit = 8): string[] {
  const found = new Set<string>();
  const seen = new WeakSet<object>();
  const walk = (value: unknown, depth: number): void => {
    if (found.size >= limit || depth > MAX_DEPTH) return;
    if (typeof value === "string") {
      const trimmed = value.trimStart();
      if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
        try { walk(JSON.parse(value), depth + 1); return; } catch { /* plain text */ }
      }
      if (looksLikeDeviceConfig(value)) found.add(value);
      return;
    }
    if (!value || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    for (const entry of Array.isArray(value) ? value : Object.values(value)) walk(entry, depth + 1);
  };
  walk(input, 0);
  return [...found];
}

/** True when a hidden-secret marker appears anywhere in a value (for example tool arguments). */
export function containsHiddenSecret(value: unknown, depth = 0): boolean {
  if (typeof value === "string") return value.includes(SECRET_MARKER) || value.includes(LINE_MARKER);
  if (!value || typeof value !== "object" || depth > MAX_DEPTH) return false;
  const entries = Array.isArray(value) ? value : [...Object.keys(value), ...Object.values(value)];
  return entries.some((entry) => containsHiddenSecret(entry, depth + 1));
}

/** "3 secrets hidden before the AI saw this (passwords, keys, SNMP communities)." */
export function hiddenNote(hidden: number, kinds: readonly SecretKind[]): string {
  if (hidden <= 0) return "";
  const words = kinds.map((kind) => KIND_WORDS[kind]);
  return `${hidden} ${hidden === 1 ? "secret" : "secrets"} hidden before the AI saw this${words.length ? ` (${words.join(", ")})` : ""}.`;
}

/** bash and grep output is scrubbed only when it looks like device config. */
export function shouldScrubCommandOutput(text: string): boolean {
  return looksLikeDeviceConfig(text);
}
