// The "symbols" of a device config for Go to Symbol (Ctrl+Shift+O, and the
// Outline button): interfaces, LAGs, VLANs, routing and other sections, with
// the lines each one spans. Pure, so it is unit-tested; the providers file
// hands them to Monaco.

export type ConfigSymbolKind = 'interface' | 'lag' | 'vlan' | 'routing' | 'section';

export interface ConfigSymbol {
  name: string;
  kind: ConfigSymbolKind;
  /** 1-based first and last line of the block. */
  line: number;
  endLine: number;
}

const MAX_SYMBOLS = 2000;
const JUNOS = new Set(['juniper-junos', 'mist']);
// Junos sections whose children are worth their own entry ("interfaces ge-0/0/1").
const JUNOS_PARENTS = new Set(['interfaces', 'vlans', 'protocols', 'routing-instances', 'policy-options', 'firewall']);
const COMMENT = /^\s*(?:!|#|\/\*|\*)/;

export function symbolKind(name: string): ConfigSymbolKind {
  if (/^interface\s+lag\b|^interfaces\s+ae\d/i.test(name)) return 'lag';
  if (/^interface\s+vlan\b|^interfaces\s+irb\b|^vlans?\b/i.test(name)) return 'vlan';
  if (/^interfaces?\b/i.test(name)) return 'interface';
  if (/^(?:router|ip\s+route|routing-options|routing-instances|protocols|policy-options)\b/i.test(name)) return 'routing';
  return 'section';
}

const make = (name: string, line: number, endLine: number): ConfigSymbol => ({
  name: name.length > 80 ? `${name.slice(0, 79)}…` : name,
  kind: symbolKind(name),
  line,
  endLine,
});

/** Aruba and other indented CLIs: each unindented line that has indented lines under it (or names an interface, VLAN or router). */
function indentedSymbols(lines: string[]): ConfigSymbol[] {
  const out: ConfigSymbol[] = [];
  let open: { name: string; line: number; last: number; children: boolean } | null = null;
  const close = () => {
    if (open && (open.children || /^(?:interface|vlan|router)\b/i.test(open.name))) out.push(make(open.name, open.line, open.last));
    open = null;
  };
  lines.forEach((raw, index) => {
    if (!raw.trim() || COMMENT.test(raw)) return;
    if (/^\s/.test(raw)) {
      if (open) {
        open.children = true;
        open.last = index + 1;
      }
      return;
    }
    close();
    open = { name: raw.trim(), line: index + 1, last: index + 1, children: false };
  });
  close();
  return out;
}

/** Junos set style: one entry per section (or interface, VLAN …), from its first set line to its last. */
function junosSetSymbols(lines: string[]): ConfigSymbol[] {
  const spans = new Map<string, { line: number; last: number }>();
  lines.forEach((raw, index) => {
    const m = /^\s*(?:set|deactivate)\s+(\S+)(?:\s+(\S+))?/i.exec(raw);
    if (!m) return;
    const key = JUNOS_PARENTS.has(m[1].toLowerCase()) && m[2] ? `${m[1]} ${m[2]}` : m[1];
    const span = spans.get(key);
    if (span) span.last = index + 1;
    else spans.set(key, { line: index + 1, last: index + 1 });
  });
  return [...spans].map(([name, span]) => make(name, span.line, span.last)).sort((a, b) => a.line - b.line);
}

/** Junos brace style: top-level sections, plus the children of interfaces, vlans, protocols …, each to its closing brace. */
function junosBraceSymbols(lines: string[]): ConfigSymbol[] {
  const out: ConfigSymbol[] = [];
  const stack: Array<{ name: string; symbol: ConfigSymbol | null }> = [];
  lines.forEach((raw, index) => {
    const text = raw.replace(/\/\*.*?\*\//g, '').replace(/#.*$/, '').trim();
    if (text.endsWith('{')) {
      const name = text.slice(0, -1).trim().replace(/^(?:inactive|protect):\s*/i, '');
      const depth = stack.length;
      const parent = stack[depth - 1]?.name.toLowerCase();
      let symbol: ConfigSymbol | null = null;
      if (depth === 0) symbol = make(name, index + 1, index + 1);
      else if (depth === 1 && parent && JUNOS_PARENTS.has(parent)) symbol = make(`${parent} ${name}`, index + 1, index + 1);
      if (symbol) out.push(symbol);
      stack.push({ name, symbol });
    } else if (text.startsWith('}')) {
      const closed = stack.pop();
      if (closed?.symbol) closed.symbol.endLine = index + 1;
    }
  });
  return out;
}

export function configSymbols(text: string, language: string): ConfigSymbol[] {
  const lines = text.split('\n');
  let symbols: ConfigSymbol[];
  if (JUNOS.has(language)) {
    symbols = lines.some((line) => /^\s*set\s/i.test(line)) ? junosSetSymbols(lines) : junosBraceSymbols(lines);
  } else {
    symbols = indentedSymbols(lines);
  }
  return symbols.slice(0, MAX_SYMBOLS);
}
