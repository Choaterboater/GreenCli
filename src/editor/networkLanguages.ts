// Teaches Monaco the device config languages: colors, comments (Ctrl+/),
// brackets, and what a "word" is (so a double-click picks 1/1/5 or
// ge-0/0/0.100 whole). Registered ONCE per Monaco instance from beforeMount
// (see setup.ts) — the editor's onMount runs again after every Diff toggle, so
// anything registered there would be registered twice.

import type * as Monaco from 'monaco-editor';
import { ArubaHighlighter } from '../syntax';
import { NETWORK_LANGUAGES } from '../utils/configProblems';

export const NETWORK_LANGUAGE_IDS = [...NETWORK_LANGUAGES];

const JUNOS_LANGUAGES = new Set(['juniper-junos', 'mist']);

/** Words colored as keywords (Monarch matches them case-insensitively). */
export const NETWORK_KEYWORDS = [
  // Aruba AOS-CX / AOS-S
  'show', 'configure', 'interface', 'vlan', 'router', 'ip', 'aaa',
  'ntp', 'snmp', 'logging', 'spanning-tree', 'lacp', 'bgp', 'ospf',
  'no', 'shutdown', 'description', 'access', 'trunk', 'native',
  'allowed', 'remote-as', 'neighbor', 'area', 'network', 'exit',
  'write', 'copy', 'ping', 'traceroute', 'end', 'hostname', 'username',
  'password', 'enable', 'disable', 'default', 'address-family',
  'unicast', 'activate', 'route-map', 'prefix-list', 'permit', 'deny',
  'lag', 'untagged', 'tagged', 'vrf', 'radius-server', 'tacacs-server',
  // Juniper Junos (set-style + hierarchy)
  'set', 'delete', 'commit', 'rollback', 'family', 'ethernet-switching',
  'interface-mode', 'members', 'vlan-id', 'vlans', 'protocols',
  'routing-options', 'autonomous-system', 'group', 'peer-as', 'unit',
  'inet', 'native-vlan-id', 'irb', 'p2p', 'interfaces', 'system',
  'deactivate', 'confirmed',
];

/**
 * One word in a config: letters, digits and the joiners ports, addresses and
 * names use — 1/1/5, 1/1/1-1/1/48, ge-0/0/0.100, 10.1.1.1/24, a MAC with
 * colons, spanning-tree, a $9$ hash.
 */
export const CONFIG_WORD_PATTERN = /[\w$][\w$./:@-]*/;

/** Monaco's own default word separators (code files keep these). */
export const DEFAULT_WORD_SEPARATORS = '`~!@#$%^&*()-=+[{]}\\|;:\'",.<>/?';
/** Device configs: / . - : @ $ join a port, address, MAC or hash into one word. */
export const CONFIG_WORD_SEPARATORS = '`~!#%^&*()=+[{]}\\|;\'",<>?';

/**
 * The editor's wordSeparators for a language. Double-click, Ctrl+Left/Right and
 * Ctrl+D go by this editor option, not by the language's wordPattern.
 */
export function wordSeparatorsFor(language: string): string {
  return NETWORK_LANGUAGES.has(language) ? CONFIG_WORD_SEPARATORS : DEFAULT_WORD_SEPARATORS;
}

export function languageConfiguration(id: string): Monaco.languages.LanguageConfiguration {
  const pairs = [
    { open: '{', close: '}' },
    { open: '[', close: ']' },
    { open: '(', close: ')' },
    { open: '"', close: '"' },
  ];
  return {
    comments: JUNOS_LANGUAGES.has(id) ? { lineComment: '#', blockComment: ['/*', '*/'] } : { lineComment: '!' },
    brackets: [
      ['{', '}'],
      ['[', ']'],
      ['(', ')'],
    ],
    autoClosingPairs: pairs,
    surroundingPairs: pairs,
    wordPattern: CONFIG_WORD_PATTERN,
  };
}

export function tokenizer(id: string): Monaco.languages.IMonarchLanguage {
  const junos = JUNOS_LANGUAGES.has(id);
  const comments: Monaco.languages.IMonarchLanguageRule[] = junos
    ? [
        [/#.*$/, 'comment'],
        [/\/\*/, 'comment', '@blockComment'],
      ]
    : [[/^\s*!.*$/, 'comment']];
  return {
    ignoreCase: true,
    keywords: NETWORK_KEYWORDS,
    tokenizer: {
      root: [
        ...comments,
        // Template blanks and hidden-secret markers: fill these in before sending.
        [/\$\{[^}\n]*\}/, 'variable'],
        [/<[^<>\s][^<>\n]*>/, 'variable'],
        [/\b(?:\d{1,3}\.){3}\d{1,3}(?:\/\d{1,2})?\b/, 'number.float'],
        // Ports: AOS-CX 1/1/1 and ranges, Junos ge-0/0/0.100.
        [/\b[a-z]{2,3}-\d+\/\d+\/\d+(?:\.\d+)?\b/, 'type'],
        [/\b\d+\/\d+\/\d+(?:-\d+\/\d+\/\d+)?\b/, 'type'],
        [/\b\d+\b/, 'number'],
        [/[a-z_][\w-]*/, { cases: { '@keywords': 'keyword', '@default': 'identifier' } }],
        [/"[^"\n]*"/, 'string'],
        [/'[^'\n]*'/, 'string'],
        [/[{}[\]()]/, '@brackets'],
      ],
      blockComment: [
        [/[^*/]+/, 'comment'],
        [/\*\//, 'comment', '@pop'],
        [/[*/]/, 'comment'],
      ],
    },
  };
}

const registered = new WeakSet<object>();

/** Register the device languages once per Monaco instance. */
export function registerNetworkLanguages(monaco: typeof Monaco): void {
  if (registered.has(monaco.languages)) return;
  registered.add(monaco.languages);
  for (const id of NETWORK_LANGUAGE_IDS) {
    monaco.languages.register({ id });
    monaco.languages.setMonarchTokensProvider(id, tokenizer(id));
    monaco.languages.setLanguageConfiguration(id, languageConfiguration(id));
  }
}

// Same vendor detection the terminal uses, so pasting a device config into a
// blank editor lights up with CLI-style colors without picking a language.
const DEVICE_DETECTOR = ArubaHighlighter.forDeviceType('generic');

/** The device language a config looks like, or null for anything else. */
export function detectConfigLanguage(text: string): string | null {
  if (text.length < 40) return null;
  const detected = DEVICE_DETECTOR.detectDeviceType(text.slice(0, 16_000));
  return detected === 'generic' ? null : detected;
}
