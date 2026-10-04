import { describe, expect, it, vi } from 'vitest';
import { CONFIG_SNIPPETS, registerSnippetCompletions, snippetMenuGroups, snippetsFor, toMonacoSnippet } from './snippets';
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
    const secretValue = /\b(?:key|secret|passphrase|psk|-password|-pass)(?:\s+plaintext)?\s+(?!\$\{|plaintext\b)([^\s\]]+)/i;
    for (const snippet of CONFIG_SNIPPETS) {
      for (const line of sendLines(snippet.body)) expect([snippet.label, line.match(secretValue)?.[1]]).toEqual([snippet.label, undefined]);
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

describe('the everyday set', () => {
  const byPrefix = (prefix: string) => CONFIG_SNIPPETS.find((s) => s.prefix === prefix);

  it('covers VLANs, routing, ACLs, 802.1X, SNMPv3, LAGs, edge ports and NTP/syslog on each platform', () => {
    const wanted: Record<string, string[]> = {
      'aruba-cx': ['cx-vlan', 'cx-routed', 'cx-ospf', 'cx-bgp', 'cx-static', 'cx-helper', 'cx-acl', 'cx-radius', 'cx-dot1x', 'cx-snmpv3', 'cx-edge', 'cx-qos-trust', 'cx-ntp-syslog'],
      'aruba-aos-s': ['aoss-trunk', 'aoss-lacp', 'aoss-radius', 'aoss-dot1x', 'aoss-edge', 'aoss-ntp-syslog'],
      'juniper-junos': ['junos-lag', 'junos-irb', 'junos-ospf', 'junos-bgp', 'junos-ntp-syslog', 'junos-radius', 'junos-snmpv3', 'junos-dot1x', 'junos-edge', 'commit-keep', 'commit-check'],
      mist: ['junos-ospf', 'commit-keep'],
      'aruba-ap': ['iap-wlan', 'iap-ntp-syslog'],
    };
    for (const [language, prefixes] of Object.entries(wanted)) {
      const offered = snippetsFor(language).map((s) => s.prefix);
      for (const prefix of prefixes) expect([language, offered.includes(prefix)]).toEqual([language, true]);
    }
  });

  it('leaves the rollback timer to Send safely (no cx-safe wrapper to confirm by hand)', () => {
    expect(byPrefix('cx-safe')).toBeUndefined();
    for (const snippet of CONFIG_SNIPPETS) expect([snippet.label, /checkpoint\s+auto/.test(snippet.body)]).toEqual([snippet.label, false]);
  });

  it('warns on every login and 802.1X RADIUS snippet that a wrong key can lock you out', () => {
    for (const prefix of ['cx-radius', 'aoss-radius', 'junos-radius']) {
      expect([prefix, byPrefix(prefix)!.body]).toEqual([prefix, expect.stringMatching(/Send safely: a wrong key can lock you out of SSH\./)]);
    }
  });

  it('AOS-S 802.1X uses RADIUS and says it needs a RADIUS server', () => {
    const dot1x = byPrefix('aoss-dot1x')!;
    expect(dot1x.body).toContain('aaa authentication port-access eap-radius');
    expect(dot1x.description).toMatch(/aoss-radius/);
  });

  it('Junos RADIUS login keeps local passwords as a fallback', () => {
    expect(byPrefix('junos-radius')!.body).toContain('set system authentication-order [ radius password ]');
  });

  it('the Instant AP WLAN leaves commit apply to the person or to Send safely', () => {
    const body = byPrefix('iap-wlan')!.body;
    expect(prepareSendLines(body).some((l) => /^commit\s+apply/i.test(l.text))).toBe(false);
    expect(body).toContain('! Plain Send: finish with commit apply');
    expect(body).toContain('wpa-passphrase ${passphrase}');
  });

  it('commit-keep confirms a commit confirmed; commit-check only checks', () => {
    expect(byPrefix('commit-keep')!.body).toBe('commit comment "${comment}"\n');
    expect(byPrefix('commit-check')!.body).toBe('commit check\n');
  });
});

describe('snippetMenuGroups', () => {
  const flat = (language: string) => snippetMenuGroups(language).flatMap((g) => g.snippets);

  it('puts the open tab\'s vendor first, then every other vendor', () => {
    const groups = snippetMenuGroups('aruba-cx');
    expect(groups[0]).toMatchObject({ vendor: 'AOS-CX', current: true });
    expect(groups[0].snippets.every((s) => s.label.startsWith('AOS-CX:'))).toBe(true);
    const current = groups.filter((g) => g.current);
    expect(groups.slice(0, current.length)).toEqual(current);
    expect(current.flatMap((g) => g.snippets.map((s) => s.prefix)).sort()).toEqual(snippetsFor('aruba-cx').map((s) => s.prefix).sort());
    expect(groups.slice(1).map((g) => g.vendor)).toContain('Junos');
    expect(snippetMenuGroups('juniper-junos')[0]).toMatchObject({ vendor: 'Junos', current: true });
    expect(snippetMenuGroups('aruba-ap')[0]).toMatchObject({ vendor: 'Instant AP', current: true });
  });

  it('hides nothing and repeats nothing', () => {
    for (const language of ['aruba-cx', 'mist', 'aruba-ap', 'python']) {
      const prefixes = flat(language).map((s) => s.prefix);
      expect(new Set(prefixes).size).toBe(prefixes.length);
      expect(prefixes.length).toBe(CONFIG_SNIPPETS.length);
    }
  });

  it('has no current group on a tab that is not device config', () => {
    expect(snippetMenuGroups('python').some((g) => g.current)).toBe(false);
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
