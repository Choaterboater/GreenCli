// Hover cards for Aruba CX and Junos config lines: what the line does in plain
// words, and the same thing on the other vendor. Pure (no Monaco import) so
// it is unit-tested; networkLanguages registers the hover provider.

export interface CommandCard {
  id: string;
  title: string;
  /** What it does, in plain words. */
  meaning: string;
  cx: string[];
  junos: string[];
  /** Matches a trimmed Aruba CX line. */
  cxLine?: RegExp;
  /** Matches a trimmed Junos line, set style ("set" dropped) or brace style. */
  junosLine?: RegExp;
}

// More specific cards first: "interface vlan 20" before "interface 1/1/5",
// "vlan trunk" before "vlan 20", an irb or ae interface before any interface.
export const COMMAND_CARDS: CommandCard[] = [
  {
    id: 'svi',
    title: 'VLAN interface (gateway)',
    meaning: 'Gives a VLAN an IP address, so the switch can route for that VLAN.',
    cx: ['interface vlan 20', '    ip address 10.20.0.1/24'],
    junos: ['set interfaces irb unit 20 family inet address 10.20.0.1/24', 'set vlans users l3-interface irb.20'],
    cxLine: /^(?:interface\s+vlan\s*\d+|ip\s+address\s+\d)/i,
    junosLine: /^(?:interfaces\s+irb\b|irb\s*\{|vlans\s+\S+\s+l3-interface\b|l3-interface\s+irb)/i,
  },
  {
    id: 'lag',
    title: 'Link aggregation (LAG)',
    meaning: 'Bundles several ports into one logical link, with LACP checking both ends.',
    cx: ['interface lag 1', '    lacp mode active', 'interface 1/1/49', '    lag 1'],
    junos: [
      'set chassis aggregated-devices ethernet device-count 1',
      'set interfaces ae0 aggregated-ether-options lacp active',
      'set interfaces ge-0/0/49 ether-options 802.3ad ae0',
    ],
    cxLine: /^(?:interface\s+lag\s*\d+|lag\s+\d+|lacp\s+mode\b)/i,
    junosLine: /^(?:chassis\s+aggregated-devices\b|interfaces\s+ae\d+|ae\d+\s*\{)|802\.3ad\s+ae\d+/i,
  },
  {
    id: 'trunk',
    title: 'Trunk port',
    meaning: 'A port that carries several VLANs, tagged. The native VLAN goes untagged.',
    cx: ['vlan trunk native 1', 'vlan trunk allowed 10,20'],
    junos: [
      'set interfaces ge-0/0/1 unit 0 family ethernet-switching interface-mode trunk',
      'set interfaces ge-0/0/1 unit 0 family ethernet-switching vlan members [ users voice ]',
      'set interfaces ge-0/0/1 native-vlan-id 1',
    ],
    cxLine: /^vlan\s+trunk\b/i,
    junosLine: /interface-mode\s+trunk|native-vlan-id|vlan\s+members\s+\[/i,
  },
  {
    id: 'access',
    title: 'Access port',
    meaning: 'A port in one VLAN, untagged. Where a PC, printer or AP plugs in.',
    cx: ['interface 1/1/5', '    vlan access 20'],
    junos: [
      'set interfaces ge-0/0/5 unit 0 family ethernet-switching interface-mode access',
      'set interfaces ge-0/0/5 unit 0 family ethernet-switching vlan members users',
    ],
    cxLine: /^vlan\s+access\b/i,
    junosLine: /interface-mode\s+access|vlan\s+members\s+[^[\s]/i,
  },
  {
    id: 'vlan',
    title: 'VLAN',
    meaning: 'A separate group of ports with its own broadcast domain. Junos names VLANs; CX numbers them.',
    cx: ['vlan 20', '    name users'],
    junos: ['set vlans users vlan-id 20'],
    cxLine: /^vlan\s+\d+/i,
    junosLine: /^(?:vlans\s+\S+\s+vlan-id\b|vlan-id\s+\d+)/i,
  },
  {
    id: 'shutdown',
    title: 'Port off / on',
    meaning: 'Turns a port off ("shutdown", "disable") or back on ("no shutdown", deleting "disable").',
    cx: ['interface 1/1/5', '    shutdown', '    no shutdown'],
    junos: ['set interfaces ge-0/0/5 disable', 'delete interfaces ge-0/0/5 disable'],
    cxLine: /^(?:no\s+)?shutdown\b/i,
    junosLine: /^(?:interfaces\s+\S+\s+disable\b|disable;?$)/i,
  },
  {
    id: 'description',
    title: 'Description',
    meaning: 'A note on a port for people. It changes nothing on the network.',
    cx: ['interface 1/1/5', '    description uplink to core'],
    junos: ['set interfaces ge-0/0/5 description "uplink to core"'],
    cxLine: /^description\b/i,
    junosLine: /^(?:interfaces\s+\S+\s+description\b|description\s)/i,
  },
  {
    id: 'interface',
    title: 'Interface (port)',
    meaning: 'One physical port. CX counts member/slot/port (1/1/5); Junos counts FPC/PIC/port from 0 (ge-0/0/4).',
    cx: ['interface 1/1/5'],
    junos: ['set interfaces ge-0/0/4 unit 0 family ethernet-switching'],
    cxLine: /^interface\s+\d+\/\d+\/\d+/i,
    junosLine: /^(?:interfaces\s+)?(?:ge|xe|et|mge|ce)-\d+\/\d+\/\d+/i,
  },
  {
    id: 'hostname',
    title: 'Hostname',
    meaning: 'The name the switch shows in its prompt and sends to logging and SNMP.',
    cx: ['hostname core-sw1'],
    junos: ['set system host-name core-sw1'],
    cxLine: /^hostname\b/i,
    junosLine: /^(?:system\s+host-name\b|host-name\s)/i,
  },
  {
    id: 'static-route',
    title: 'Static route',
    meaning: 'Sends traffic for a network to a next hop you name. 0.0.0.0/0 is the default route.',
    cx: ['ip route 0.0.0.0/0 10.0.0.1'],
    junos: ['set routing-options static route 0.0.0.0/0 next-hop 10.0.0.1'],
    cxLine: /^ip\s+route\b/i,
    junosLine: /^(?:routing-options\s+static\s+route\b|route\s+\S+\s+next-hop\b)/i,
  },
  {
    id: 'ntp',
    title: 'NTP server',
    meaning: 'Where the switch gets its time. Logs and certificates need the right time.',
    cx: ['ntp server 10.1.1.1 iburst'],
    junos: ['set system ntp server 10.1.1.1'],
    cxLine: /^ntp\s+server\b/i,
    junosLine: /^system\s+ntp\s+server\b/i,
  },
  {
    id: 'dns',
    title: 'DNS server',
    meaning: 'Where the switch looks up names.',
    cx: ['ip dns server-address 10.1.1.53'],
    junos: ['set system name-server 10.1.1.53'],
    cxLine: /^ip\s+dns\s+server-address\b/i,
    junosLine: /^system\s+name-server\b/i,
  },
  {
    id: 'syslog',
    title: 'Syslog server',
    meaning: 'Sends the switch log to a log server.',
    cx: ['logging 10.1.1.20'],
    junos: ['set system syslog host 10.1.1.20 any any'],
    cxLine: /^logging\s+\d/i,
    junosLine: /^system\s+syslog\s+host\b/i,
  },
  {
    id: 'snmp-community',
    title: 'SNMP community',
    meaning: 'A shared password for SNMP v1/v2c polling. It goes over the wire in clear text.',
    cx: ['snmp-server community n0tPublic'],
    junos: ['set snmp community n0tPublic authorization read-only'],
    cxLine: /^snmp-server\s+community\b/i,
    junosLine: /^snmp\s+community\b/i,
  },
  {
    id: 'radius',
    title: 'RADIUS server',
    meaning: 'Where the switch checks logins (and 802.1X). The key must match on both sides.',
    cx: ['radius-server host 10.1.1.10 key plaintext <key>'],
    junos: ['set system radius-server 10.1.1.10 secret <key>'],
    cxLine: /^radius-server\s+host\b/i,
    junosLine: /^system\s+radius-server\b/i,
  },
  {
    id: 'user',
    title: 'Local user',
    meaning: 'A login on the switch itself, used when RADIUS/TACACS is down.',
    cx: ['user admin group administrators password plaintext <password>'],
    junos: ['set system login user admin class super-user authentication plain-text-password'],
    cxLine: /^user\s+\S+\s+group\b/i,
    junosLine: /^system\s+login\s+user\b/i,
  },
  {
    id: 'stp',
    title: 'Spanning tree',
    meaning: 'Stops loops by blocking extra paths between switches.',
    cx: ['spanning-tree', 'spanning-tree mode rpvst'],
    junos: ['set protocols rstp interface all'],
    cxLine: /^spanning-tree\b/i,
    junosLine: /^protocols\s+(?:rstp|mstp|vstp)\b/i,
  },
  {
    id: 'lldp',
    title: 'LLDP',
    meaning: 'Tells neighbors who this switch is and learns who they are. On by default on CX.',
    cx: ['lldp'],
    junos: ['set protocols lldp interface all'],
    cxLine: /^lldp\b/i,
    junosLine: /^protocols\s+lldp\b/i,
  },
  {
    id: 'poe',
    title: 'PoE',
    meaning: 'Power over the cable for phones, APs and cameras.',
    cx: ['interface 1/1/5', '    power-over-ethernet'],
    junos: ['set poe interface ge-0/0/4'],
    cxLine: /^(?:no\s+)?power-over-ethernet\b/i,
    junosLine: /^poe\s+interface\b/i,
  },
  {
    id: 'safe-change',
    title: 'Change with an automatic undo',
    meaning:
      'Applies the change but rolls it back by itself after N minutes unless you confirm. Use it when a change could cut you off.',
    cx: ['checkpoint auto 5', 'checkpoint auto confirm'],
    junos: ['commit confirmed 5', 'commit'],
    cxLine: /^checkpoint\s+auto\b/i,
    junosLine: /^commit\s+confirmed\b/i,
  },
  {
    id: 'save',
    title: 'Save / apply',
    meaning:
      'CX runs each line at once and "write memory" saves it for the next reboot. Junos does nothing until "commit", which applies and saves together.',
    cx: ['write memory'],
    junos: ['commit'],
    cxLine: /^(?:write\s+mem(?:ory)?|copy\s+running-config\s+startup-config)\b/i,
    junosLine: /^commit\b/i,
  },
  {
    id: 'rollback',
    title: 'Roll back',
    meaning: 'Puts back an earlier configuration.',
    cx: ['copy checkpoint <name> running-config'],
    junos: ['rollback 1', 'commit'],
    cxLine: /^copy\s+checkpoint\b/i,
    junosLine: /^rollback\b/i,
  },
  {
    id: 'show-config',
    title: 'Show the configuration',
    meaning: 'Prints the running configuration. On Junos, "| display set" shows it as set lines.',
    cx: ['show running-config'],
    junos: ['show configuration | display set'],
    cxLine: /^show\s+run(?:ning-config)?\b/i,
    junosLine: /^show\s+configuration\b/i,
  },
];

const CX_LANGUAGES = new Set(['aruba-cx']);
const JUNOS_LANGUAGES = new Set(['juniper-junos', 'mist']);

/** The languages that get hover cards. */
export const CARD_LANGUAGES = [...CX_LANGUAGES, ...JUNOS_LANGUAGES];

/** Junos set-style lines are matched without their verb. */
function junosBody(line: string): string {
  return line.replace(/^(?:set|delete|deactivate|activate|replace)\s+/i, '');
}

/** The card for one line of a config, if there is one. */
export function cardForLine(line: string, language: string): CommandCard | undefined {
  const text = line.trim();
  if (!text || /^[!#]|^\/\*/.test(text)) return undefined;
  if (CX_LANGUAGES.has(language)) return COMMAND_CARDS.find((card) => card.cxLine?.test(text));
  if (JUNOS_LANGUAGES.has(language)) {
    const body = junosBody(text);
    return COMMAND_CARDS.find((card) => card.junosLine?.test(body));
  }
  return undefined;
}

/** The hover text: the meaning, then this vendor's way, then the other's. */
export function cardMarkdown(card: CommandCard, language: string): string {
  const cx = { label: 'Aruba CX', fence: 'aruba-cx', lines: card.cx };
  const junos = { label: 'Junos', fence: 'juniper-junos', lines: card.junos };
  const [first, second] = JUNOS_LANGUAGES.has(language) ? [junos, cx] : [cx, junos];
  const block = (side: typeof cx) => `**${side.label}**\n\n\`\`\`${side.fence}\n${side.lines.join('\n')}\n\`\`\``;
  return [`**${card.title}**: ${card.meaning}`, block(first), block(second)].join('\n\n');
}
