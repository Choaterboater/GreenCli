// Copied from casper src/secrets/prose.ts @ 81438ae. Do not edit here: change Casper, re-copy.
// ---- casper source below ----
import { keepLiterally, KIND_ORDER, replaceSpans, windowedSpans, type SecretKind } from "./patterns";
import { SECRET_MARKER, type ScrubTextResult } from "./scrub";

/**
 * Secrets written the way people write them in notes, docs and commands, not as KEY=VALUE:
 * "**Password:** X", "pw: X", "password X", "root / X", "login: admin / X", "creds: user / X", user:X@host,
 * a table with a Password column, Proxmox API tokens (user@realm!name=<uuid>, PVEAPIToken=...) and
 * token=<uuid or long hex>. Each rule hides the value only, so the AI still sees what the line is about. Values
 * must look like a secret (a digit or a symbol) where plain words could follow, so ordinary sentences about
 * passwords stay readable.
 */

interface Span { start: number; end: number; kind: SecretKind }

const UUID = String.raw`[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}`;
/** Words that are placeholders or code, never a value. */
const NOT_A_VALUE = /^(?:str|string|int|bool|none|null|nil|true|false|undefined|required|optional|secret|password|token|changeme|example|xxx+|redacted|hidden|n\/a|na|tbd|todo|unknown|same|none\.?|empty|blank)$/i;

/** A word that looks like a secret, not a plain word: a digit with a letter, a symbol, or a long number. */
function secretLike(value: string): boolean {
  if (value.length < 4 || (value.match(/[A-Za-z0-9]/g)?.length ?? 0) < 3 || /^[<{$%(\["']/.test(value) || /:\/\//.test(value) || /^[/~.]/.test(value)) return false;
  if (NOT_A_VALUE.test(value)) return false;
  return (/\d/.test(value) && /[A-Za-z]/.test(value)) || /[!@#$%^&*+=?~]/.test(value) || /^\d{6,}$/.test(value);
}

/** Any value that was marked as one (bold, backticks, after a colon): only placeholders and code words stay. */
function anyValue(value: string): boolean {
  return value.length >= 3 && !/^[<{$%]/.test(value) && !NOT_A_VALUE.test(value) && !keepLiterally(value) && !/^\*+$/.test(value);
}

/** A value in a command: 'quoted', "quoted" or one word. The quotes stay; only what is inside is hidden. */
const QUOTED = String.raw`'[^'\n]+'|"[^"\n]+"|[^\s'"]+`;
const unquote = (value: string) => /^(['"]).*\1$/s.test(value) ? value.slice(1, -1) : value;

interface ProseRule { re: RegExp; group: number; kind: SecretKind; accept: (value: string, match: RegExpExecArray) => boolean }

const PASSWORD_WORDS = String.raw`password|passwd|passphrase|pass|pw|secret|api[ _-]?key|api[ _-]?token|token|psk|pre-shared key`;

const RULES: ProseRule[] = [
  // **Password:** X, Password: **X**, pw: `X`, __Token__ = X (markdown around the key or the value).
  { re: new RegExp(String.raw`(?<![\w-])(\*\*|__)?(?:${PASSWORD_WORDS})(\*\*|__)?\s*[:=]\s*(\*\*|__)?\s*(\`{1,3})?([^\s\`*]+)`, "gid"),
    group: 5, kind: "password", accept: (value, match) => {
      const marked = Boolean(match[1] || match[2] || match[3] || match[4]);
      return marked || /^pw\b/i.test(match[0]) ? anyValue(value.replace(/[.,;)]+$/, "")) : secretLike(value);
    } },
  // password X, password is X, the pw was X: only a value that looks like a secret.
  { re: /(?<![\w-])(?:password|passwd|passphrase|pw)\s+(?:is\s+|was\s+|of\s+|=\s*)?(`?)([^\s`]+)\1/gid, group: 2, kind: "password",
    accept: (value, match) => match[1] === "`" ? anyValue(value) : secretLike(value) },
  // the root password for the lab is X: a few words between, and only a value that looks like a secret.
  { re: /(?<![\w-])(?:password|passwd|pw)\b[^\n.:=`]{1,40}?\s(?:is|was)\s+(`?)([^\s`]+)\1/gid, group: 2, kind: "password",
    accept: (value, match) => match[1] === "`" ? anyValue(value) : secretLike(value) },
  { re: /(?<![\w-])pass\s+([^\s`]+)/gid, group: 1, kind: "password", accept: (value) => secretLike(value) },
  // In commands: sshpass -p X, --password X, --token=X, curl -u user:X, mysql -pX, ipmitool -P X, smbclient -U user%X,
  // echo X | sudo -S, echo user:X | chpasswd.
  { re: new RegExp(String.raw`\bsshpass\s+(?:-[a-zA-Z]\s+)*?-p\s*(${QUOTED})`, "gid"), group: 1, kind: "password", accept: (value) => anyValue(unquote(value)) },
  { re: new RegExp(String.raw`(?<![\w-])--?(?:password|passwd|pass|pw|passphrase|token|api-?key|api-token|auth-token|access-token|secret|client-secret|psk)(?:=|\s+)(${QUOTED})`, "gid"),
    group: 1, kind: "password", accept: (value) => !unquote(value).startsWith("-") && anyValue(unquote(value)) },
  { re: /\b(?:curl|wget)\b[^;&|\n]*?\s(?:-u|--user)(?:\s+|=)?(['"]?)[^\s:'"]+:([^\s'"]+)\1/gid, group: 2, kind: "password", accept: (value) => anyValue(value) },
  { re: new RegExp(String.raw`\b(?:mysql|mariadb|mysqldump|mysqladmin)\b[^;&|\n]*?\s-p(?!\s)(${QUOTED})`, "gid"), group: 1, kind: "password", accept: (value) => anyValue(unquote(value)) },
  { re: new RegExp(String.raw`\bipmitool\b[^;&|\n]*?\s-P\s*(${QUOTED})`, "gid"), group: 1, kind: "password", accept: (value) => anyValue(unquote(value)) },
  { re: /(?<![\w-])-U\s*(['"]?)[^\s%'"]+%([^\s'"]+)\1/gid, group: 2, kind: "password", accept: (value) => anyValue(value) },
  { re: new RegExp(String.raw`\b(?:echo|printf)\s+(?:-\w+\s+)?(${QUOTED})\s*\|\s*sudo\b[^|;&\n]*?\s-\w*S\b`, "gid"), group: 1, kind: "password", accept: (value) => anyValue(unquote(value)) },
  { re: /\b(?:echo|printf)\s+(?:-\w+\s+)?(['"]?)[\w.-]+:([^\s'"]+)\1\s*\|\s*(?:sudo\s+)?chpasswd\b/gid, group: 2, kind: "password", accept: (value) => anyValue(value) },
  // login: admin / X, creds: user / X, username/password: admin / X, sign-in root / X.
  { re: /\b(?:login|logon|log-in|creds?|credentials?|sign[- ]?in|account|user(?:name)?\s*\/\s*pass(?:word)?|u\/p)\b[^\n/]{0,30}?(?:[:=-]\s*|\s)(`?)[\w.@\\-]+\1\s*\/\s*(`?)([^\s`]+)\2/gid,
    group: 3, kind: "password", accept: (value) => anyValue(value.replace(/[.,;)]+$/, "")) },
  // root / X, admin / X (spaces around the slash; a path has none).
  // Also root@pam / X (a Proxmox login with its realm) and **root** / **X** (markdown bold).
  { re: /(?<![/\w.-])(?:\*\*|__)?(?:root|admin|administrator|ubuntu|debian|pi|centos|ec2-user|operator|netadmin|cisco|juniper|aruba|manager|superuser|vagrant|support)(?:@[\w.-]+)?(?:\*\*|__)?\s+\/\s+(?:\*\*|__)?(`?)([^\s`*]+)\1/gid,
    group: 2, kind: "password", accept: (value) => anyValue(value.replace(/[.,;)]+$/, "")) },
  // user:X@host with no scheme (a URL with one is handled by scrubUrlPasswords).
  { re: /(?<![\w/:.@%-])([A-Za-z0-9._-]{1,64}):([^\s@/:'"`]{3,})@((?:\d{1,3}\.){3}\d{1,3}|[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+|localhost)\b/gid,
    group: 2, kind: "password", accept: (value, match) => !/^(?:mailto|email|e-mail|contact|from|to|cc|bcc|reply-to|author|by|at)$/i.test(match[1]!) && anyValue(value) && !/^\$\{?\w+\}?$/.test(value) },
  // Proxmox API tokens: root@pam!sampleapp=<uuid>, PVEAPIToken=user@realm!name=<uuid>.
  // Starts only at the start of a word: without the lookbehind, a long word with no "@" in it was retried from every
  // letter, and a 16 KB line took half a second.
  { re: new RegExp(String.raw`(?<![\w.-])[\w.-]+@[\w.-]+![\w.-]+\s*[=:]\s*(${UUID})`, "gid"), group: 1, kind: "key", accept: () => true },
  { re: new RegExp(String.raw`![\w.-]+=(${UUID})`, "gid"), group: 1, kind: "key", accept: () => true },
  // A uuid later on a line about a token or secret: "PVE token: root@pam!sampleapp 3f1c…" (the id is a name; the uuid
  // is the secret).
  { re: new RegExp(String.raw`(?:\b(?:tokens?|secrets?|api[ _-]?keys?)\b(?!\s+ids?\b)|![\w.-]+)[^\n]{0,80}?(?<![\w-])(${UUID})(?![\w-])`, "gid"), group: 1, kind: "key", accept: () => true },
  { re: /\bPVEAPIToken\s*=\s*[^\s'"=]+=([^\s'"]+)/gid, group: 1, kind: "key", accept: (value) => anyValue(value) },
  // token=<uuid or long hex>, api_secret: <uuid> (not token_id, which names a token). The regex takes the whole name,
  // starting where the name starts, and tokenName() checks it, so a long name is read once, not from every letter.
  // The name is taken whole, with no backing up into it (a match needs all of it); the value is only looked at, not
  // taken, so a name tokenName() turns down does not hide the next name from the search.
  { re: new RegExp(String.raw`(?<![\w-])(?=([\w-]+))\1(?=["']?\s*[=:]\s*["']?(${UUID}|[0-9a-fA-F]{32,})\b)`, "gid"),
    group: 2, kind: "key", accept: (_value, match) => tokenName(match[1]!) },
];

const TOKEN_ID = /token[-_]?id\b/gi;
const TOKEN_WORD = /token|secret|apikey|api_key|api-key/i;

/**
 * Whether the name before token=<uuid> marks a secret. The rule used to start at any word start inside the name and
 * skip a start that had token_id after it, so a name counts when, from its first word start after the last
 * token_id, it still holds token, secret or api key.
 */
function tokenName(name: string): boolean {
  let from = 0;
  for (const match of name.matchAll(TOKEN_ID)) from = match.index + 1;
  for (let at = from; at < name.length; at++) {
    const word = /\w/.test(name[at]!);
    if (word !== (at > 0 && /\w/.test(name[at - 1]!))) return TOKEN_WORD.test(name.slice(at));
  }
  return false;
}

/** Table headers whose column holds secrets. */
const SECRET_HEADER = /^(?:passwords?|passwd|pass|pw|pwd|secrets?|tokens?|api ?keys?|api ?tokens?|psk|pre-shared keys?|credentials?|creds|passphrases?|keys?|community)$/i;
const TABLE_ROW = /^\s*[|│┃]/;
const cellText = (cell: string) => cell.trim().replace(/^[*_`]+|[*_`]+$/g, "").trim();

/** The cells of a table row, with their start and end in the line. */
function cells(line: string): Array<{ start: number; end: number; text: string }> {
  const out: Array<{ start: number; end: number; text: string }> = [];
  const bars = [...line.matchAll(/[|│┃]/g)].map((match) => match.index!);
  for (let index = 0; index + 1 < bars.length; index++) {
    const raw = line.slice(bars[index]! + 1, bars[index + 1]!);
    const lead = raw.length - raw.trimStart().length;
    const text = raw.trim();
    out.push({ start: bars[index]! + 1 + lead, end: bars[index]! + 1 + lead + text.length, text });
  }
  return out;
}

/** The rule hits in one line (or one window of a long line). */
function ruleSpans(line: string): Span[] {
  const spans: Span[] = [];
  for (const rule of RULES) {
    rule.re.lastIndex = 0;
    for (let match = rule.re.exec(line); match; match = rule.re.exec(line)) {
      const value = match[rule.group];
      const at = match.indices?.[rule.group];
      if (!value || !at || value.includes(SECRET_MARKER) || keepLiterally(value)) continue;
      if (!rule.accept(value, match)) continue;
      let start = at[0];
      let end = at[1];
      if (/^(['"]).+\1$/s.test(value)) { start++; end--; }
      // Trailing sentence punctuation is not part of the value.
      const trail = /[.,;:)\]]+$/.exec(value);
      if (trail && trail[0].length < value.length && !/^['"]/.test(value)) end -= trail[0].length;
      spans.push({ start, end, kind: rule.kind });
    }
  }
  return spans;
}

/** Hide the prose, table and token forms above. */
export function scrubProseSecrets(text: string): ScrubTextResult {
  const lines = text.split("\n");
  const kinds = new Set<SecretKind>();
  const tokenTable = /tokenid/i.test(text);
  let hidden = 0;
  let columns: number[] | undefined;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    const spans: Span[] = windowedSpans(line, ruleSpans);
    if (TABLE_ROW.test(line)) {
      const row = cells(line);
      if (/^[\s|│┃:\-─═╞╪╡├┼┤+]+$/.test(line)) { /* a separator row */ }
      else if (!columns && row.some((cell) => SECRET_HEADER.test(cellText(cell.text)))) {
        columns = row.flatMap((cell, at) => SECRET_HEADER.test(cellText(cell.text)) ? [at] : []);
      } else {
        for (const column of columns ?? []) {
          const cell = row[column];
          if (cell && anyValue(cellText(cell.text)) && !cell.text.includes(SECRET_MARKER)) spans.push({ start: cell.start, end: cell.end, kind: "password" });
        }
        // A key/value table: "│ value │ <uuid> │" after pveum's token add, "| password | X |".
        for (let at = 0; at + 1 < row.length; at++) {
          const key = cellText(row[at]!.text).toLowerCase();
          const next = row[at + 1]!;
          if ((SECRET_HEADER.test(key) || (tokenTable && key === "value")) && anyValue(cellText(next.text)) && !next.text.includes(SECRET_MARKER)) {
            spans.push({ start: next.start, end: next.end, kind: key === "value" ? "key" : "password" });
          }
        }
      }
    } else columns = undefined;
    if (tokenTable) {
      // pveum's --output-format json or yaml: "value": "<uuid>", value: <uuid>.
      const json = new RegExp(String.raw`"?\bvalue"?\s*:\s*"?(${UUID})`, "gd");
      for (let match = json.exec(line); match; match = json.exec(line)) spans.push({ start: match.indices![1]![0], end: match.indices![1]![1], kind: "key" });
    }
    if (!spans.length) continue;
    const sorted = spans.sort((a, b) => a.start - b.start || b.end - a.end);
    const merged: Span[] = [];
    for (const span of sorted) {
      const last = merged.at(-1);
      if (last && span.start < last.end) { last.end = Math.max(last.end, span.end); continue; }
      merged.push({ ...span });
    }
    for (const span of merged) kinds.add(span.kind);
    lines[index] = replaceSpans(line, merged, SECRET_MARKER);
    hidden += merged.length;
  }
  return { text: hidden ? lines.join("\n") : text, hidden, kinds: KIND_ORDER.filter((kind) => kinds.has(kind)) };
}
