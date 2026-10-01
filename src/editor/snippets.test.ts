import { describe, expect, it, vi } from 'vitest';
import { CONFIG_SNIPPETS, registerSnippetCompletions, snippetsFor, toMonacoSnippet } from './snippets';

describe('toMonacoSnippet', () => {
  it('turns each blank into a numbered Tab stop and ends with the cursor after it', () => {
    expect(toMonacoSnippet('interface ${interface}\n    vlan access ${vlan_id}\n')).toBe(
      'interface ${1:interface}\n    vlan access ${2:vlan_id}\n$0'
    );
  });

  it('gives the same blank the same number, so filling one fills both', () => {
    expect(toMonacoSnippet('vlan ${id}\ninterface vlan ${id}\n')).toBe('vlan ${1:id}\ninterface vlan ${1:id}\n$0');
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
