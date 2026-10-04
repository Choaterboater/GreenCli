// Config snippets with blanks you fill in with Tab, like VS Code. They show
// in the Snippets menu and as you type at the start of a line (the prefix).
// Bodies use ${name} for each blank; toMonacoSnippet turns them into Monaco
// tabstops and escapes everything else, so a $9$ hash or a } stays as typed.
// A blank you skip stays ${name} in the editor, so Problems shows it in red
// and Send safely asks for a value: it never goes out as a bare word.

import type * as Monaco from 'monaco-editor';

export interface ConfigSnippet {
  label: string;
  /** What you type to get it. */
  prefix: string;
  description: string;
  /** Languages it is offered in as you type. */
  languages: readonly string[];
  body: string;
}

const CX = ['aruba-cx'];
const AOSS = ['aruba-aos-s'];
const IAP = ['aruba-ap'];
const AOS8 = ['aruba-controller', 'generic'];
const JUNOS = ['juniper-junos', 'mist'];
const ALL = ['aruba-cx', 'aruba-aos-s', 'aruba-ap', 'aruba-controller', 'juniper-junos', 'mist', 'generic'];

export const CONFIG_SNIPPETS: readonly ConfigSnippet[] = [
  {
    label: 'Common: hostname',
    prefix: 'hostname',
    description: 'Set the device name.',
    languages: ALL.filter((id) => !JUNOS.includes(id)),
    body: 'hostname ${hostname}\n',
  },
  {
    label: 'ArubaOS 8: syslog + NTP',
    prefix: 'syslog-ntp',
    description: 'Send logs to a syslog server and sync time from NTP.',
    languages: AOS8,
    body: 'logging ${syslog_server}\nntp server ${ntp_server}\n',
  },
  {
    label: 'AOS-CX: NTP + syslog',
    prefix: 'cx-ntp-syslog',
    description: 'Sync time from NTP and send logs to syslog, through a VRF (mgmt or default).',
    languages: CX,
    body: 'ntp server ${ntp_server} iburst\nntp vrf ${vrf}\nntp enable\nlogging ${syslog_server} vrf ${vrf}\n',
  },
  {
    label: 'AOS-S: NTP + syslog',
    prefix: 'aoss-ntp-syslog',
    description: 'Sync time from NTP and send logs to syslog.',
    languages: AOSS,
    body: 'timesync ntp\nntp unicast\nntp server ${ntp_server} iburst\nntp enable\nlogging ${syslog_server}\n',
  },
  {
    label: 'Instant AP: NTP + syslog',
    prefix: 'iap-ntp-syslog',
    description: 'Sync time from NTP and send logs to syslog.',
    languages: IAP,
    body: 'ntp-server ${ntp_server}\nsyslog-server ${syslog_server}\n',
  },
  {
    label: 'AOS-CX: access port',
    prefix: 'cx-access',
    description: 'One access port in one VLAN.',
    languages: CX,
    body: 'interface ${interface}\n    description ${description}\n    no shutdown\n    no routing\n    vlan access ${vlan_id}\n',
  },
  {
    label: 'AOS-CX: trunk port',
    prefix: 'cx-trunk',
    description: 'A trunk port with a native VLAN and an allowed list.',
    languages: CX,
    body:
      'interface ${interface}\n    description ${description}\n    no shutdown\n    no routing\n' +
      '    vlan trunk native ${native_vlan}\n    vlan trunk allowed ${allowed_vlans}\n',
  },
  {
    label: 'AOS-CX: VLAN + SVI',
    prefix: 'cx-svi',
    description: 'A VLAN and its routed interface.',
    languages: CX,
    body: 'vlan ${vlan_id}\n    name ${vlan_name}\ninterface vlan ${vlan_id}\n    ip address ${ip_cidr}\n',
  },
  {
    label: 'AOS-CX: LACP uplink (2 ports)',
    prefix: 'cx-lag',
    description: 'A LACP LAG trunk with two member ports.',
    languages: CX,
    body:
      'interface lag ${lag_id}\n    no shutdown\n    no routing\n    vlan trunk native ${native_vlan}\n    vlan trunk allowed ${allowed_vlans}\n' +
      '    lacp mode active\ninterface ${member_1}\n    no shutdown\n    lag ${lag_id}\n' +
      'interface ${member_2}\n    no shutdown\n    lag ${lag_id}\n',
  },
  {
    label: 'AOS-S: access port',
    prefix: 'aoss-access',
    description: 'A VLAN with one untagged port.',
    languages: AOSS,
    body: 'vlan ${vlan_id}\n   name "${vlan_name}"\n   untagged ${port}\n   exit\n',
  },
  {
    label: 'Junos: access port',
    prefix: 'junos-access',
    description: 'A VLAN and one access port in it.',
    languages: JUNOS,
    body:
      'set vlans ${vlan_name} vlan-id ${vlan_id}\n' +
      'set interfaces ${interface} unit 0 family ethernet-switching interface-mode access\n' +
      'set interfaces ${interface} unit 0 family ethernet-switching vlan members ${vlan_name}\n',
  },
  {
    label: 'Junos: trunk port',
    prefix: 'junos-trunk',
    description: 'A trunk port carrying a list of VLANs.',
    languages: JUNOS,
    body:
      'set interfaces ${interface} unit 0 family ethernet-switching interface-mode trunk\n' +
      'set interfaces ${interface} unit 0 family ethernet-switching vlan members [ ${vlan_names} ]\n',
  },
  {
    label: 'Junos/Mist: commit confirmed',
    prefix: 'commit-confirmed',
    description: 'For a plain Send: apply, and roll back by itself in 5 minutes unless you commit again. Send safely does both for you.',
    languages: JUNOS,
    body: 'commit confirmed 5 comment "GreenCLI change"\n',
  },
];

const BLANK = /\$\{([^}\n]+)\}/g;

/** Escape text so Monaco's snippet parser keeps it as typed. */
function literal(text: string): string {
  return text.replace(/[\\$}]/g, (char) => `\\${char}`);
}

/**
 * Turn a snippet body into Monaco snippet text: each ${name} becomes a numbered
 * tabstop whose default is the blank itself, ${name}, so one left unfilled
 * still shows as a blank (the same name twice shares a number,
 * so filling one fills both), everything else is escaped, and the cursor ends
 * after the snippet.
 */
export function toMonacoSnippet(body: string): string {
  const numbers = new Map<string, number>();
  let out = '';
  let at = 0;
  BLANK.lastIndex = 0;
  for (let match = BLANK.exec(body); match; match = BLANK.exec(body)) {
    const name = match[1];
    if (!numbers.has(name)) numbers.set(name, numbers.size + 1);
    out += literal(body.slice(at, match.index)) + `\${${numbers.get(name)}:${literal(match[0])}}`;
    at = match.index + match[0].length;
  }
  return `${out}${literal(body.slice(at))}$0`;
}

/** The snippets offered as you type in a language. */
export function snippetsFor(language: string): ConfigSnippet[] {
  return CONFIG_SNIPPETS.filter((snippet) => snippet.languages.includes(language));
}

const registered = new WeakSet<object>();

/** Offer snippets as you type, at the start of a line only (mid-line they'd be noise). */
export function registerSnippetCompletions(monaco: typeof Monaco, languages: readonly string[]): void {
  if (registered.has(monaco.languages)) return;
  registered.add(monaco.languages);
  for (const language of languages) {
    const snippets = snippetsFor(language);
    if (!snippets.length) continue;
    monaco.languages.registerCompletionItemProvider(language, {
      provideCompletionItems(model, position) {
        const word = model.getWordUntilPosition(position);
        const before = model.getLineContent(position.lineNumber).slice(0, word.startColumn - 1);
        if (before.trim()) return { suggestions: [] };
        const range = {
          startLineNumber: position.lineNumber,
          endLineNumber: position.lineNumber,
          startColumn: word.startColumn,
          endColumn: word.endColumn,
        };
        return {
          suggestions: snippets.map((snippet) => ({
            label: snippet.prefix,
            kind: monaco.languages.CompletionItemKind.Snippet,
            detail: snippet.label,
            documentation: `${snippet.description}\n\n${snippet.body}`,
            insertText: toMonacoSnippet(snippet.body),
            insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
            range,
          })),
        };
      },
    });
  }
}
