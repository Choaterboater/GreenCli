import { describe, expect, it, vi } from 'vitest';
import { CONFIG_SNIPPETS, registerSnippetCompletions, snippetsFor, toMonacoSnippet } from './snippets';
import { buildProblems } from '../utils/configProblems';
import { prepareSendLines } from '../utils/configSafety';

/** What the editor holds after inserting a snippet and pressing Esc without filling anything. */
function insertedUnfilled(monacoSnippet: string): string {
  return monacoSnippet
    .replace(/\$0$/, '')
    .replace(/\$\{\d+:((?:\\.|[^\\}])*)\}/g, '$1')
    .replace(/\\([\\$}])/g, '$1');
}

describe('toMonacoSnippet', () => {
  it('turns each blank into a numbered Tab stop and ends with the cursor after it', () => {
    expect(toMonacoSnippet('interface ${interface}\n    vlan access ${vlan_id}\n')).toBe(
      'interface ${1:\\${interface\\}}\n    vlan access ${2:\\${vlan_id\\}}\n$0'
    );
  });

  it('gives the same blank the same number, so filling one fills both', () => {
    expect(toMonacoSnippet('vlan ${id}\ninterface vlan ${id}\n')).toBe('vlan ${1:\\${id\\}}\ninterface vlan ${1:\\${id\\}}\n$0');
  });

  it('keeps $ (a Junos $9$ hash), } and \\ as typed', () => {
    expect(toMonacoSnippet('set system root-authentication encrypted-password "$9$abc}def\\x"')).toBe(
      'set system root-authentication encrypted-password "\\$9\\$abc\\}def\\\\x"$0'
    );
  });

  it('converts every built-in snippet, one Tab stop per distinct blank', () => {
    for (const snippet of CONFIG_SNIPPETS) {
      const blanks = new Set([...snippet.body.matchAll(/\$\{([^}]+)\}/g)].map((m) => m[1]));
      const stops = new Set([...toMonacoSnippet(snippet.body).matchAll(/\$\{(\d+):/g)].map((m) => m[1]));
      expect([snippet.label, stops.size]).toEqual([snippet.label, blanks.size]);
    }
  });
});

describe('built-in snippets', () => {
  const vendorLanguages: Record<string, readonly string[]> = {
    'AOS-CX': ['aruba-cx'],
    'AOS-S': ['aruba-aos-s'],
    'Instant AP': ['aruba-ap'],
    'ArubaOS 8': ['aruba-controller', 'generic'],
    Junos: ['juniper-junos', 'mist'],
    'Junos/Mist': ['juniper-junos', 'mist'],
  };
  const sendLines = (body: string) => prepareSendLines(body).map((l) => l.text);

  it('leaves each blank showing as ${name} when inserted and not filled, so Problems flags it', () => {
    for (const snippet of CONFIG_SNIPPETS) {
      const held = insertedUnfilled(toMonacoSnippet(snippet.body));
      expect([snippet.label, held]).toEqual([snippet.label, snippet.body]);
      const blanks = [...snippet.body.matchAll(/\$\{[^}]+\}/g)].length;
      const placeholders = buildProblems(held, snippet.languages[0]).filter((p) => p.code === 'placeholder').length;
      expect([snippet.label, placeholders]).toEqual([snippet.label, blanks]);
    }
  });

  it('is tagged with its platform: the label says which, and it is offered only there', () => {
    for (const snippet of CONFIG_SNIPPETS) {
      const vendor = snippet.label.split(':')[0];
      if (vendor === 'Common') {
        expect([snippet.label, snippet.languages.length > 2]).toEqual([snippet.label, true]);
        continue;
      }
      expect([snippet.label, snippet.languages]).toEqual([snippet.label, vendorLanguages[vendor]]);
    }
  });

  it('holds no secret: every key, secret or password is a blank', () => {
    const secretValue = /\b(?:key|secret|passphrase|psk|-password|-pass)(?:\s+plaintext)?\s+(?!\$\{)([^\s\]]+)/i;
    for (const snippet of CONFIG_SNIPPETS) {
      for (const line of snippet.body.split('\n')) expect([snippet.label, line.match(secretValue)?.[1]]).toEqual([snippet.label, undefined]);
      const codes = buildProblems(snippet.body, snippet.languages[0]).map((p) => p.code);
      expect([snippet.label, codes.includes('plaintext-secret')]).toEqual([snippet.label, false]);
    }
  });

  it('puts no routing on every AOS-CX port it sets a VLAN on (8xxx ports are routed by default)', () => {
    for (const snippet of CONFIG_SNIPPETS.filter((s) => s.languages.includes('aruba-cx'))) {
      if (!/vlan (?:access|trunk)/.test(snippet.body)) continue;
      expect([snippet.label, /^\s+no routing$/m.test(snippet.body)]).toEqual([snippet.label, true]);
    }
  });

  it('never saves or commits by itself, except the Junos commit snippets', () => {
    for (const snippet of CONFIG_SNIPPETS) {
      const lines = sendLines(snippet.body);
      expect([snippet.label, lines.some((l) => /^write\s+mem/i.test(l))]).toEqual([snippet.label, false]);
      if (snippet.languages.some((l) => l === 'juniper-junos' || l === 'mist') && !snippet.prefix.startsWith('commit-')) {
        expect([snippet.label, lines.some((l) => /^commit\b/i.test(l))]).toEqual([snippet.label, false]);
      }
    }
  });

  it('offers NTP and syslog in each platform\'s own words', () => {
    const prefixes = (language: string) => snippetsFor(language).map((s) => s.prefix);
    expect(prefixes('aruba-ap')).toContain('iap-ntp-syslog');
    expect(prefixes('aruba-ap')).not.toContain('syslog-ntp');
    expect(prefixes('aruba-cx')).toContain('cx-ntp-syslog');
    expect(prefixes('aruba-cx')).not.toContain('syslog-ntp');
    expect(prefixes('aruba-aos-s')).toContain('aoss-ntp-syslog');
    expect(prefixes('aruba-aos-s')).not.toContain('syslog-ntp');
    expect(prefixes('aruba-controller')).toContain('syslog-ntp');
    const cx = CONFIG_SNIPPETS.find((s) => s.prefix === 'cx-ntp-syslog')!;
    expect(cx.body).toContain('ntp enable');
    expect(CONFIG_SNIPPETS.find((s) => s.prefix === 'aoss-ntp-syslog')!.body).toContain('timesync ntp');
  });

  it('says what keeps a commit confirmed: Send safely, or a second commit', () => {
    const description = CONFIG_SNIPPETS.find((s) => s.prefix === 'commit-confirmed')!.description;
    expect(description).toMatch(/Send safely/);
    expect(description).toMatch(/commit again/);
  });
});

describe('snippetsFor', () => {
  it('offers each vendor its own snippets', () => {
    const labels = (language: string) => snippetsFor(language).map((s) => s.label);
    expect(labels('aruba-cx')).toContain('AOS-CX: access port');
    expect(labels('aruba-cx')).not.toContain('Junos: access port');
    expect(labels('juniper-junos')).toContain('Junos/Mist: commit confirmed');
    expect(labels('juniper-junos')).not.toContain('Common: hostname');
    expect(labels('python')).toEqual([]);
  });

  it('has unique labels and prefixes', () => {
    expect(new Set(CONFIG_SNIPPETS.map((s) => s.label)).size).toBe(CONFIG_SNIPPETS.length);
    expect(new Set(CONFIG_SNIPPETS.map((s) => s.prefix)).size).toBe(CONFIG_SNIPPETS.length);
  });
});

describe('registerSnippetCompletions', () => {
  function fakeMonaco() {
    const providers = new Map<string, { provideCompletionItems: (model: unknown, position: unknown) => { suggestions: unknown[] } }>();
    return {
      providers,
      monaco: {
        languages: {
          CompletionItemKind: { Snippet: 27 },
          CompletionItemInsertTextRule: { InsertAsSnippet: 4 },
          registerCompletionItemProvider: vi.fn((language: string, provider) => providers.set(language, provider)),
        },
      },
    };
  }
  const model = (line: string, wordStart: number) => ({
    getWordUntilPosition: () => ({ startColumn: wordStart, endColumn: line.length + 1, word: line.slice(wordStart - 1) }),
    getLineContent: () => line,
  });

  it('registers once and offers snippets only at the start of a line', () => {
    const { monaco, providers } = fakeMonaco();
    registerSnippetCompletions(monaco as never, ['aruba-cx', 'python']);
    registerSnippetCompletions(monaco as never, ['aruba-cx']);
    expect(monaco.languages.registerCompletionItemProvider).toHaveBeenCalledTimes(1);
    const provider = providers.get('aruba-cx')!;
    const start = provider.provideCompletionItems(model('  cx-a', 3), { lineNumber: 1, column: 7 });
    expect(start.suggestions.length).toBe(snippetsFor('aruba-cx').length);
    expect(start.suggestions[0]).toMatchObject({ kind: 27, insertTextRules: 4 });
    const middle = provider.provideCompletionItems(model('description cx-a', 13), { lineNumber: 1, column: 17 });
    expect(middle.suggestions).toEqual([]);
  });
});
