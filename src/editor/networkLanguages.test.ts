import { describe, expect, it, vi } from 'vitest';
import {
  CONFIG_WORD_PATTERN,
  CONFIG_WORD_SEPARATORS,
  DEFAULT_WORD_SEPARATORS,
  NETWORK_KEYWORDS,
  NETWORK_LANGUAGE_IDS,
  detectConfigLanguage,
  languageConfiguration,
  registerNetworkLanguages,
  tokenizer,
  wordSeparatorsFor,
} from './networkLanguages';

const words = (text: string) => text.match(new RegExp(CONFIG_WORD_PATTERN.source, 'g'));

describe('what a double-click picks', () => {
  it('takes ports, addresses and names whole', () => {
    expect(words('interface 1/1/5')).toEqual(['interface', '1/1/5']);
    expect(words('interface 1/1/1-1/1/48')).toEqual(['interface', '1/1/1-1/1/48']);
    expect(words('set interfaces ge-0/0/0.100 unit 100')).toEqual(['set', 'interfaces', 'ge-0/0/0.100', 'unit', '100']);
    expect(words('ip address 10.1.1.1/24')).toEqual(['ip', 'address', '10.1.1.1/24']);
    expect(words('mac aa:bb:cc:dd:ee:ff')).toEqual(['mac', 'aa:bb:cc:dd:ee:ff']);
    expect(words('spanning-tree bpdu-guard')).toEqual(['spanning-tree', 'bpdu-guard']);
  });

  it('stops at quotes, braces and semicolons', () => {
    expect(words('description "uplink to core"; vlan { 10 }')).toEqual(['description', 'uplink', 'to', 'core', 'vlan', '10']);
  });
});

describe('word separators (double-click, Ctrl+Left/Right)', () => {
  it('join ports and addresses in device configs and stay default for code', () => {
    for (const char of ['/', '.', '-', ':', '@', '$']) {
      expect([char, CONFIG_WORD_SEPARATORS.includes(char)]).toEqual([char, false]);
      expect([char, DEFAULT_WORD_SEPARATORS.includes(char)]).toEqual([char, true]);
    }
    for (const char of ['"', "'", '{', '}', ';', ',', '(', ')', '[', ']']) expect(CONFIG_WORD_SEPARATORS).toContain(char);
    expect(wordSeparatorsFor('juniper-junos')).toBe(CONFIG_WORD_SEPARATORS);
    expect(wordSeparatorsFor('python')).toBe(DEFAULT_WORD_SEPARATORS);
  });

  it('agree with the word pattern: no separator is a word character', () => {
    for (const char of CONFIG_WORD_SEPARATORS) expect([char, new RegExp(`^${CONFIG_WORD_PATTERN.source}$`).test(`a${char}b`)]).toEqual([char, false]);
  });
});

describe('language rules', () => {
  it('uses # and /* */ comments for Junos, ! for Aruba (Ctrl+/ follows these)', () => {
    expect(languageConfiguration('juniper-junos').comments).toEqual({ lineComment: '#', blockComment: ['/*', '*/'] });
    expect(languageConfiguration('mist').comments?.lineComment).toBe('#');
    expect(languageConfiguration('aruba-cx').comments).toEqual({ lineComment: '!' });
    expect(languageConfiguration('aruba-aos-s').brackets).toContainEqual(['{', '}']);
  });

  it('colors with the keyword list (it used to be unused) and knows Junos block comments', () => {
    expect(tokenizer('aruba-cx').keywords).toBe(NETWORK_KEYWORDS);
    expect(Object.keys(tokenizer('juniper-junos').tokenizer)).toContain('blockComment');
    expect(JSON.stringify(tokenizer('aruba-cx').tokenizer.root)).not.toContain('@blockComment');
  });

  it('registers every device language once per Monaco instance', () => {
    const monaco = {
      languages: { register: vi.fn(), setMonarchTokensProvider: vi.fn(), setLanguageConfiguration: vi.fn() },
    };
    registerNetworkLanguages(monaco as never);
    registerNetworkLanguages(monaco as never);
    expect(monaco.languages.register).toHaveBeenCalledTimes(NETWORK_LANGUAGE_IDS.length);
    expect(monaco.languages.setLanguageConfiguration).toHaveBeenCalledTimes(NETWORK_LANGUAGE_IDS.length);
  });
});

describe('detectConfigLanguage', () => {
  it('spots a device config and leaves short or other text alone', () => {
    expect(detectConfigLanguage('set interfaces ge-0/0/1 unit 0 family ethernet-switching vlan members users\nset vlans users vlan-id 10\n')).toBe('juniper-junos');
    expect(detectConfigLanguage('hello')).toBeNull();
  });
});
