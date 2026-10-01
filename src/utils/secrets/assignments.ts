// Copied from casper src/secrets/assignments.ts @ ad678b6. Do not edit here: change Casper, re-copy.
// ---- casper source below ----
import { KIND_ORDER, keepLiterally, replaceSpans, windowedSpans, type SecretKind } from "./patterns";
import { SECRET_MARKER, snakeKey, type ScrubTextResult } from "./scrub";

/**
 * Secret-named values in text: KEY=VALUE, key: value and "key": "value" lines, Authorization headers,
 * user:password@ addresses and exact known values. Pure string work with no file or environment access,
 * so other tools can copy this file as it is (GreenCLI does).
 */

/** Name parts that mean "the value is a secret". */
const SECRET_PARTS = new Set(["password", "passwd", "passphrase", "pwd", "pass", "secret", "secrets", "token", "apikey", "psk",
  "credential", "credentials", "bearer", "community", "privatekey", "accesskey", "secretkey", "authkey", "sessionkey", "signingkey"]);
/** Two-part names: api_key, access_key, private_key, client_secret ... */
const SECRET_PAIRS = /(?:^|_)(?:api|access|private|priv|secret|auth|session|signing|encryption|master|shared|pre_shared|client|app|account|service|webhook|consumer)_(?:key|secret|token)(?:_|$)/;
/** A last name part that says the value is not the secret itself. */
const NOT_SECRET_LAST = new Set(["url", "uri", "file", "path", "dir", "host", "hostname", "port", "endpoint", "expiry", "expires", "expiration",
  "ttl", "type", "name", "id", "length", "len", "count", "enabled", "enable", "header", "prefix", "policy", "required", "min", "max", "env",
  "var", "field", "label", "hint", "prompt", "rotation", "format", "help", "location", "region", "mode", "version", "at", "limit", "size",
  "timeout", "user", "username", "cmd", "command", "helper", "method", "scope", "scopes", "audience", "issuer"]);
/** Paging and usage words that end in "token" but are not logins. */
const NOT_SECRET_ANY = /(?:^|_)(?:next|page|continuation|pagination|cursor|sync|resume|start|continue|max|input|output|total|csrf_field|num)(?:_|$)/;

/** Whether a KEY=VALUE, key: value or "key": "value" name looks like it holds a secret. */
export function isSecretName(name: string): boolean {
  const key = snakeKey(name);
  const parts = key.split("_").filter(Boolean);
  // The shell's working folder, not a password.
  if (!parts.length || key === "pwd" || key === "oldpwd") return false;
  // A webhook or DSN address is itself the login: SLACK_WEBHOOK_URL, SENTRY_DSN.
  if (parts.some((part) => part === "webhook" || part === "dsn") && ["webhook", "dsn", "url", "uri"].includes(parts.at(-1)!)) return true;
  if (NOT_SECRET_LAST.has(parts.at(-1)!) || NOT_SECRET_ANY.test(key)) return false;
  if (parts.some((part) => SECRET_PARTS.has(part))) return true;
  if (SECRET_PAIRS.test(key)) return true;
  // Glued names: MIST_APITOKEN, dbpassword, clientsecret.
  return parts.some((part) => /(?:token|secret|password|passwd|passphrase|apikey)$/.test(part));
}

/** Words that are code or types, never a secret value, in command and grep output. */
const CODE_WORDS = new Set(["str", "string", "int", "bool", "boolean", "number", "bytes", "none", "null", "nil", "true", "false", "undefined",
  "any", "unknown", "object", "optional", "required", "self", "this", "secret", "password", "token", "changeme", "example", "xxx", "redacted"]);

function kindFor(name: string): SecretKind {
  const key = snakeKey(name);
  if (/community/.test(key)) return "community";
  if (/psk|passphrase/.test(key)) return "psk";
  if (/pass|pwd/.test(key)) return "password";
  return "key";
}

/** Is this unquoted value a literal (a real value), not code? Only asked for command output. */
function literalValue(value: string, name: string, separator: string): boolean {
  if (value.length < 4 || /[\s(){}[\]<>`]/.test(value) || /^[$%&@*]/.test(value)) return false;
  if (CODE_WORDS.has(value.toLowerCase())) return false;
  // self.password, config.token, os.environ...
  if (/^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)+$/.test(value)) return false;
  // A bare identifier is a variable in code; it counts only in dotenv style (NAME=value, name upper case).
  if (/^[A-Za-z_]+$/.test(value)) return separator === "=" && /^[A-Z0-9_]+$/.test(name);
  return true;
}

const ASSIGNMENT = /(^[-+]|^|[^\w.-])(["']?)([A-Za-z_][\w.-]*)\2(\s*)([=:])(\s*)("(?:[^"\\\n]|\\.)*"|'[^'\n]*'|[^\s"'][^\n]*)?/dg;
const AUTH_HEADER = /\b(?:Bearer|Basic|Token)\s+([A-Za-z0-9._~+/-]{8,}=*)/dg;

interface Span { start: number; end: number; kind: SecretKind }

function assignmentSpans(line: string, strict: boolean): Span[] {
  const spans: Span[] = [];
  ASSIGNMENT.lastIndex = 0;
  for (let match = ASSIGNMENT.exec(line); match; match = ASSIGNMENT.exec(line)) {
    const name = match[3]!;
    const raw = match[7];
    const indices = match.indices?.[7];
    // Look for more pairs after this separator: "a=1, TOKEN=x" has two.
    ASSIGNMENT.lastIndex = match.indices![5]![1];
    if (!raw || !indices || !isSecretName(name)) continue;
    // "a == b" and "a := b" are comparisons or code, not stored values.
    if (line[indices[0]] === "=" || (match[5] === ":" && line[match.indices![5]![1]] === "=")) continue;
    let [start, end] = indices;
    let value = raw;
    const quoted = value.length >= 2 && (value[0] === "\"" || value[0] === "'") && value.at(-1) === value[0];
    if (quoted) { start++; end--; value = value.slice(1, -1); }
    else {
      // Unquoted: stop at a comment, a list separator or trailing space.
      const cut = value.search(/\s+#|\s*[,;]\s*(?:$|["'\w])|\s+$/);
      if (cut >= 0) { end = start + cut; value = value.slice(0, cut); }
      // Command output: a value runs to the first space.
      if (!strict) { const space = value.search(/\s/); if (space >= 0) { end = start + space; value = value.slice(0, space); } }
    }
    if (!value || keepLiterally(value) || value.includes(SECRET_MARKER)) continue;
    if (!strict && (quoted ? /\$\{|\{\{|^\s*$/.test(value) || value.length < 4 || CODE_WORDS.has(value.toLowerCase()) : !literalValue(value, name, match[5]!))) continue;
    // In a secret file, a ${VAR} reference is not a value.
    if (strict && /^\$\{?[A-Za-z_]\w*\}?$/.test(value)) continue;
    spans.push({ start, end, kind: kindFor(name) });
    ASSIGNMENT.lastIndex = Math.max(ASSIGNMENT.lastIndex, end);
  }
  AUTH_HEADER.lastIndex = 0;
  for (let match = AUTH_HEADER.exec(line); match; match = AUTH_HEADER.exec(line)) {
    const [start, end] = match.indices![1]!;
    if (!keepLiterally(match[1]!)) spans.push({ start, end, kind: "key" });
  }
  return spans;
}

function applySpans(line: string, spans: Span[], kinds: Set<SecretKind>): { line: string; hidden: number } {
  const sorted = [...spans].sort((a, b) => a.start - b.start || b.end - a.end);
  const merged: Span[] = [];
  for (const span of sorted) {
    const last = merged.at(-1);
    if (last && span.start < last.end) { last.end = Math.max(last.end, span.end); continue; }
    merged.push({ ...span });
  }
  for (const span of merged) kinds.add(span.kind);
  return { line: replaceSpans(line, merged, SECRET_MARKER), hidden: merged.length };
}

/**
 * Hide values of secret-named keys: MIST_APITOKEN=abc123, password = x, "client_secret": "y",
 * api_key: z, and Authorization: Bearer tokens. `strict` (a .env or credential file) hides every
 * value of such a key; otherwise (command and grep output) only values that look like literals, so
 * `token = getToken()` in grepped code stays as it is.
 */
export function scrubAssignments(text: string, strict: boolean): ScrubTextResult {
  const lines = text.split("\n");
  const kinds = new Set<SecretKind>();
  let hidden = 0;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    const spans = windowedSpans(line, (part) => assignmentSpans(part, strict));
    if (!spans.length) continue;
    const result = applySpans(line, spans, kinds);
    lines[index] = result.line;
    hidden += result.hidden;
  }
  return { text: hidden ? lines.join("\n") : text, hidden, kinds: KIND_ORDER.filter((kind) => kinds.has(kind)) };
}

/** Hide every exact copy of the given values (for example `printenv OPENROUTER_API_KEY`). */
export function scrubExactValues(text: string, values: readonly string[]): ScrubTextResult {
  let out = text;
  let hidden = 0;
  for (const value of values) {
    if (!out.includes(value)) continue;
    const parts = out.split(value);
    hidden += parts.length - 1;
    out = parts.join(SECRET_MARKER);
  }
  return { text: out, hidden, kinds: hidden ? ["key"] : [] };
}

/**
 * The password in an address such as postgres://admin:PASSWORD@db:5432/app. The match starts at "://" and a lookbehind
 * checks the scheme before it: starting at the scheme re-read a long run of letters and dashes from every letter.
 */
const URL_PASSWORD = /:\/\/(?<=\b[a-z][a-z0-9+.-]*:\/\/)([^\s/@:'"]+:)([^\s/@'"]+)@/gi;

/** Hide the password part of every user:password@ address, in any output. */
export function scrubUrlPasswords(text: string): ScrubTextResult {
  let hidden = 0;
  const out = text.replace(URL_PASSWORD, (whole, user: string, password: string) => {
    if (keepLiterally(password) || /^\$\{?\w+\}?$/.test(password) || password.includes(SECRET_MARKER)) return whole;
    hidden++;
    return `://${user}${SECRET_MARKER}@`;
  });
  return { text: hidden ? out : text, hidden, kinds: hidden ? ["password"] : [] };
}
