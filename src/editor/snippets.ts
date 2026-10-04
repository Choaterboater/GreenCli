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
    label: 'AOS-CX: VLAN',
    prefix: 'cx-vlan',
    description: 'A VLAN with a name.',
    languages: CX,
    body: 'vlan ${vlan_id}\n    name ${vlan_name}\n',
  },
  {
    label: 'AOS-CX: routed port',
    prefix: 'cx-routed',
    description: 'A port with its own IP address (no VLANs).',
    languages: CX,
    body: 'interface ${interface}\n    no shutdown\n    routing\n    ip address ${ip_cidr}\n',
  },
  {
    label: 'AOS-CX: OSPF',
    prefix: 'cx-ospf',
    description: 'OSPF area 0 on a point-to-point link.',
    languages: CX,
    body:
      'router ospf 1\n    router-id ${router_id}\n    area 0.0.0.0\n' +
      'interface ${interface}\n    ip ospf 1 area 0.0.0.0\n    ip ospf network point-to-point\n',
  },
  {
    label: 'AOS-CX: BGP peer',
    prefix: 'cx-bgp',
    description: 'One eBGP neighbor for IPv4.',
    languages: CX,
    body:
      'router bgp ${local_asn}\n    bgp router-id ${router_id}\n    neighbor ${peer_ip} remote-as ${peer_asn}\n' +
      '    address-family ipv4 unicast\n        neighbor ${peer_ip} activate\n    exit-address-family\n',
  },
  {
    label: 'AOS-CX: static route',
    prefix: 'cx-static',
    description: 'One static route.',
    languages: CX,
    body: 'ip route ${prefix} ${next_hop}\n',
  },
  {
    label: 'AOS-CX: DHCP relay',
    prefix: 'cx-helper',
    description: 'Relay DHCP from a VLAN to a DHCP server.',
    languages: CX,
    body: 'interface vlan ${vlan_id}\n    ip helper-address ${dhcp_server}\n',
  },
  {
    label: 'AOS-CX: ACL on a port',
    prefix: 'cx-acl',
    description: 'An IPv4 ACL that allows one TCP port and logs the rest, applied inbound.',
    languages: CX,
    body:
      'access-list ip ${acl_name}\n    10 permit tcp ${source} ${destination} eq ${port}\n    20 deny any any any log\n' +
      'interface ${interface}\n    apply access-list ip ${acl_name} in\n',
  },
  {
    label: 'AOS-CX: RADIUS login',
    prefix: 'cx-radius',
    description: 'Log in to the switch with RADIUS, local accounts as the fallback. vrf: mgmt or default.',
    languages: CX,
    body:
      '! Send safely: a wrong key can lock you out of SSH.\n' +
      'radius-server host ${radius_ip} key plaintext ${radius_key} vrf ${vrf}\n' +
      'aaa group server radius ${group}\n    server ${radius_ip} vrf ${vrf}\n' +
      'aaa authentication login default group ${group} local\n' +
      'aaa accounting all-mgmt default start-stop group ${group}\n',
  },
  {
    label: 'AOS-CX: 802.1X on a port',
    prefix: 'cx-dot1x',
    description: '802.1X on one port, against a RADIUS server group (cx-radius).',
    languages: CX,
    body:
      'aaa authentication port-access dot1x authenticator\n    radius server-group ${group}\n    enable\n' +
      'interface ${interface}\n    aaa authentication port-access dot1x authenticator\n        enable\n',
  },
  {
    label: 'AOS-CX: SNMPv3 user',
    prefix: 'cx-snmpv3',
    description: 'An SNMPv3 user with SHA and AES. vrf: mgmt or default.',
    languages: CX,
    body:
      'snmp-server vrf ${vrf}\n' +
      'snmpv3 user ${user} auth sha auth-pass plaintext ${auth_pass} priv aes priv-pass plaintext ${priv_pass}\n',
  },
  {
    label: 'AOS-CX: edge port',
    prefix: 'cx-edge',
    description: 'A port to a PC or AP: no spanning-tree wait, shut by a BPDU.',
    languages: CX,
    body: 'interface ${interface}\n    spanning-tree port-type admin-edge\n    spanning-tree bpdu-guard\n',
  },
  {
    label: 'AOS-CX: trust DSCP',
    prefix: 'cx-qos-trust',
    description: 'Trust the DSCP marking that arrives (all ports).',
    languages: CX,
    body: 'qos trust dscp\n',
  },
  {
    label: 'AOS-S: access port',
    prefix: 'aoss-access',
    description: 'A VLAN with one untagged port.',
    languages: AOSS,
    body: 'vlan ${vlan_id}\n   name "${vlan_name}"\n   untagged ${port}\n   exit\n',
  },
  {
    label: 'AOS-S: tagged uplink',
    prefix: 'aoss-trunk',
    description: 'Carry a VLAN tagged on uplink ports.',
    languages: AOSS,
    body: 'vlan ${vlan_id}\n   tagged ${ports}\n   exit\n',
  },
  {
    label: 'AOS-S: LACP trunk',
    prefix: 'aoss-lacp',
    description: 'Bundle ports into an LACP trunk (trk1…) and tag a VLAN on it.',
    languages: AOSS,
    body: 'trunk ${ports} ${trk} lacp\nvlan ${vlan_id}\n   tagged ${trk}\n   exit\n',
  },
  {
    label: 'AOS-S: RADIUS login',
    prefix: 'aoss-radius',
    description: 'Log in over SSH with RADIUS, local accounts as the fallback.',
    languages: AOSS,
    body:
      '! Send safely: a wrong key can lock you out of SSH.\n' +
      'radius-server host ${radius_ip} key ${radius_key}\n' +
      'aaa authentication ssh login radius local\naaa authentication ssh enable radius local\n',
  },
  {
    label: 'AOS-S: 802.1X on ports',
    prefix: 'aoss-dot1x',
    description: '802.1X on ports, against RADIUS. Needs a RADIUS server first (aoss-radius).',
    languages: AOSS,
    body:
      'aaa authentication port-access eap-radius\n' +
      'aaa port-access authenticator ${ports}\naaa port-access authenticator active\n',
  },
  {
    label: 'AOS-S: edge ports',
    prefix: 'aoss-edge',
    description: 'Ports to PCs or APs: no spanning-tree wait, shut by a BPDU or a loop.',
    languages: AOSS,
    body: 'spanning-tree ${ports} admin-edge-port\nspanning-tree ${ports} bpdu-protection\nloop-protect ${ports}\n',
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
    label: 'Junos: LACP uplink (2 ports)',
    prefix: 'junos-lag',
    description: 'An LACP LAG (ae0…) trunk with two member ports.',
    languages: JUNOS,
    body:
      'set chassis aggregated-devices ethernet device-count ${count}\n' +
      'set interfaces ${member_1} ether-options 802.3ad ${ae}\n' +
      'set interfaces ${member_2} ether-options 802.3ad ${ae}\n' +
      'set interfaces ${ae} aggregated-ether-options lacp active\n' +
      'set interfaces ${ae} unit 0 family ethernet-switching interface-mode trunk\n' +
      'set interfaces ${ae} unit 0 family ethernet-switching vlan members [ ${vlan_names} ]\n',
  },
  {
    label: 'Junos: VLAN interface (IRB)',
    prefix: 'junos-irb',
    description: 'A routed interface for a VLAN.',
    languages: JUNOS,
    body:
      'set interfaces irb unit ${vlan_id} family inet address ${ip_cidr}\n' +
      'set vlans ${vlan_name} l3-interface irb.${vlan_id}\n',
  },
  {
    label: 'Junos: OSPF',
    prefix: 'junos-ospf',
    description: 'OSPF area 0 on a routed point-to-point uplink, plus the loopback.',
    languages: JUNOS,
    body:
      'set routing-options router-id ${router_id}\n' +
      'set interfaces lo0 unit 0 family inet address ${router_id}/32\n' +
      'set interfaces ${uplink} unit 0 family inet address ${p2p_ip_cidr}\n' +
      'set protocols ospf area 0.0.0.0 interface ${uplink}.0 interface-type p2p\n' +
      'set protocols ospf area 0.0.0.0 interface lo0.0 passive\n',
  },
  {
    label: 'Junos: BGP peer',
    prefix: 'junos-bgp',
    description: 'One eBGP neighbor.',
    languages: JUNOS,
    body:
      'set routing-options router-id ${router_id}\n' +
      'set routing-options autonomous-system ${local_asn}\n' +
      'set protocols bgp group EBGP type external\n' +
      'set protocols bgp group EBGP neighbor ${peer_ip} peer-as ${peer_asn}\n',
  },
  {
    label: 'Junos: NTP + syslog',
    prefix: 'junos-ntp-syslog',
    description: 'Sync time from NTP and send logs to syslog.',
    languages: JUNOS,
    body: 'set system ntp server ${ntp_server}\nset system syslog host ${syslog_server} any notice\n',
  },
  {
    label: 'Junos: RADIUS login',
    prefix: 'junos-radius',
    description: 'Log in with RADIUS, local passwords as the fallback.',
    languages: JUNOS,
    body:
      '/* Send safely: a wrong key can lock you out of SSH. */\n' +
      'set system radius-server ${radius_ip} secret ${radius_secret}\n' +
      'set system authentication-order [ radius password ]\n',
  },
  {
    label: 'Junos: SNMPv3 user',
    prefix: 'junos-snmpv3',
    description: 'A read-only SNMPv3 user with SHA and AES.',
    languages: JUNOS,
    body:
      'set snmp v3 usm local-engine user ${user} authentication-sha authentication-password ${auth_pass}\n' +
      'set snmp v3 usm local-engine user ${user} privacy-aes128 privacy-password ${priv_pass}\n' +
      'set snmp v3 vacm security-to-group security-model usm security-name ${user} group ${group}\n' +
      'set snmp v3 vacm access group ${group} default-context-prefix security-model usm security-level privacy read-view all\n' +
      'set snmp view all oid .1 include\n',
  },
  {
    label: 'Junos: 802.1X on a port',
    prefix: 'junos-dot1x',
    description: '802.1X on one port, against a RADIUS server.',
    languages: JUNOS,
    body:
      'set access radius-server ${radius_ip} secret ${radius_secret}\n' +
      'set access profile ${profile} authentication-order radius\n' +
      'set access profile ${profile} radius authentication-server ${radius_ip}\n' +
      'set protocols dot1x authenticator authentication-profile-name ${profile}\n' +
      'set protocols dot1x authenticator interface ${interface} supplicant multiple\n',
  },
  {
    label: 'Junos: edge port',
    prefix: 'junos-edge',
    description: 'A port to a PC or AP: no spanning-tree wait, blocked by a BPDU.',
    languages: JUNOS,
    body: 'set protocols rstp interface ${interface} edge\nset protocols layer2-control bpdu-block interface ${interface}\n',
  },
  {
    label: 'Junos/Mist: commit confirmed',
    prefix: 'commit-confirmed',
    description: 'For a plain Send: apply, and roll back by itself in 5 minutes unless you commit again. Send safely does both for you.',
    languages: JUNOS,
    body: 'commit confirmed 5 comment "GreenCLI change"\n',
  },
  {
    label: 'Junos/Mist: keep the change (confirm)',
    prefix: 'commit-keep',
    description: 'After commit confirmed: commit again to keep the change, or it rolls back.',
    languages: JUNOS,
    body: 'commit comment "${comment}"\n',
  },
  {
    label: 'Junos/Mist: commit check',
    prefix: 'commit-check',
    description: 'Check the changes for errors without applying them.',
    languages: JUNOS,
    body: 'commit check\n',
  },
  {
    label: 'Instant AP: WLAN',
    prefix: 'iap-wlan',
    description: 'A WPA2 WLAN with a passphrase.',
    languages: IAP,
    body:
      'wlan ssid-profile ${ssid}\n    enable\n    essid ${ssid}\n    opmode wpa2-psk-aes\n    wpa-passphrase ${passphrase}\nexit\n' +
      '! Plain Send: finish with commit apply\n',
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

/** A Snippets menu section: one vendor's snippets. */
export interface SnippetGroup {
  vendor: string;
  snippets: ConfigSnippet[];
  /** Offered in the open tab's language: these come first. */
  current: boolean;
}

const VENDOR_ORDER = ['AOS-CX', 'AOS-S', 'Instant AP', 'ArubaOS 8', 'Junos', 'Common'];

/** The vendor a snippet is for, from its label ("Junos/Mist: …" counts as Junos). */
function vendorOf(snippet: ConfigSnippet): string {
  const vendor = snippet.label.split(':')[0];
  return vendor === 'Junos/Mist' ? 'Junos' : vendor;
}

/**
 * The Snippets menu, by vendor: the groups offered in the open tab's language
 * first (its own vendor, then Common), the rest after. Nothing is left out.
 */
export function snippetMenuGroups(language: string): SnippetGroup[] {
  const groups = VENDOR_ORDER.map((vendor) => {
    const snippets = CONFIG_SNIPPETS.filter((snippet) => vendorOf(snippet) === vendor);
    return { vendor, snippets, current: snippets.some((snippet) => snippet.languages.includes(language)) };
  }).filter((group) => group.snippets.length > 0);
  return [...groups.filter((group) => group.current), ...groups.filter((group) => !group.current)];
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
