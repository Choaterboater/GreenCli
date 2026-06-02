import { Grammar } from '../types';

// Juniper Junos OS grammar — covers operational-mode (show/ping/request) and
// configuration-mode (set/delete/edit hierarchy) syntax used across EX/QFX/SRX/
// MX/ACX. Mist-managed Juniper gear still drops to a Junos CLI, so this also
// backs the 'mist' device type for switch/AP shells.
export const junosGrammar: Grammar = {
  name: 'junos',
  commands: [
    // operational mode
    'show', 'ping', 'traceroute', 'monitor', 'clear', 'request', 'restart',
    'test', 'op', 'start', 'ssh', 'telnet', 'file', 'set', 'configure',
    'edit', 'run', 'load', 'save', 'commit', 'rollback', 'delete', 'deactivate',
    'activate', 'annotate', 'copy', 'rename', 'insert', 'wildcard', 'replace',
    'help', 'quit', 'exit', 'top', 'up', 'status', 'mtrace',
  ],
  subcommands: [
    'interfaces', 'interface', 'version', 'route', 'bgp', 'ospf', 'ospf3',
    'isis', 'rip', 'ldp', 'rsvp', 'mpls', 'configuration', 'chassis',
    'system', 'security', 'policies', 'policy', 'firewall', 'filter',
    'vlans', 'vlan', 'ethernet-switching', 'ethernet-switching-options',
    'lacp', 'lldp', 'lldp-med', 'protocols', 'routing-instances',
    'routing-options', 'groups', 'apply-groups', 'services', 'snmp',
    'syslog', 'unit', 'family', 'inet', 'inet6', 'address', 'arp',
    'zones', 'zone', 'nat', 'screen', 'ike', 'ipsec', 'flow', 'session',
    'spanning-tree', 'rstp', 'mstp', 'vstp', 'poe', 'class-of-service',
    'forwarding-options', 'switch-options', 'virtual-chassis', 'aggregated-ether-options',
    'gigether-options', 'native-vlan-id', 'members', 'port-mode', 'access',
    'trunk', 'description', 'mtu', 'disable', 'enable', 'vlan-id', 'irb',
    'router-id', 'autonomous-system', 'neighbor', 'group', 'peer-as',
    'local-address', 'export', 'import', 'community', 'as-path', 'term',
    'from', 'then', 'accept', 'reject', 'discard', 'next', 'log', 'count',
    'source-address', 'destination-address', 'protocol', 'port', 'pool',
    'compare', 'rescue', 'statistics', 'detail', 'extensive', 'brief',
    'terse', 'summary',
  ],
  keywords: [
    'on', 'off', 'up', 'down', 'inet', 'inet6', 'unit', 'all', 'none',
    'permit', 'deny', 'reject', 'accept', 'discard', 'enable', 'disable',
    'primary', 'secondary', 'preferred', 'passive', 'active', 'point-to-point',
    'apply-groups', 'apply-path', 'no-readvertise', 'reject', 'static',
    'aggregate', 'direct', 'local', 'access', 'trunk', 'tagged', 'untagged',
    'master', 'backup', 'candidate', 'committed', 'true', 'false', 'yes', 'no',
  ],
  operators: ['|', 'match', 'except', 'count', 'display', 'last', 'no-more', 'find', 'trim', '>', '>>', '&&', '||', ';'],
  flags: ['detail', 'extensive', 'brief', 'terse', '| display set', '| display xml', '| match', '| no-more'],
  values: {
    ipAddress: /\b(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)(?:\/(?:[0-9]|[1-2][0-9]|3[0-2]))?\b/,
    macAddress: /\b(?:[0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}\b/,
    vlanId: /\bvlan-id\s+(?:[1-9][0-9]{0,3}|409[0-5])\b/,
    // Junos interface names: ge-0/0/0, xe-0/1/0.0, ae0, irb.100, lo0.0, et-0/0/0
    interfaceName: /\b(?:ge|xe|et|fe|em|me|fxp|ae|irb|lo|reth|st|gr|ip|vt|fab|vcp|sxe|fti|pp)-?\d+(?:\/\d+){0,2}(?:\.\d+)?\b/,
    number: /\b\d+\b/,
  },
  // Junos prompts: user@host>  (operational)  user@host#  (config edit)
  promptPattern: /^(?:\{[^}]*\}\s*)?[\w.-]+@[\w.-]+[>#]\s?|^\[edit[^\]]*\]\s?/,
};
