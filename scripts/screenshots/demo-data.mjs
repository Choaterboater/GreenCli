// Demo data for the screenshots. Everything here is made up on purpose:
// host names like core-sw1, addresses only from the documentation ranges
// (192.0.2.0/24, 198.51.100.0/24, 203.0.113.0/24), MAC addresses from the
// documentation block 00:00:5e:00:53:xx, the user "netops", and passwords and
// keys that say FAKE or "NotAReal" in them. The photos show a Windows PC, so
// paths are Windows paths. The version is the one in package.json.

import { readFileSync } from 'node:fs';

export const appVersion = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version;

const host = (id, name, ip, deviceType, tags) => ({
  id,
  name,
  protocol: 'ssh',
  host: ip,
  port: 22,
  username: 'netops',
  authType: 'agent',
  deviceType,
  tags,
});

export const folders = [
  {
    id: 'f-core',
    name: 'Core',
    expanded: true,
    items: [
      host('h-core1', 'core-sw1', '192.0.2.11', 'aruba-cx', ['core', 'site-a']),
      host('h-core2', 'core-sw2', '192.0.2.12', 'aruba-cx', ['core', 'site-a']),
      host('h-edge1', 'edge-mx1', '198.51.100.1', 'juniper-junos', ['wan']),
      host('h-edge2', 'edge-srx1', '198.51.100.2', 'juniper-junos', ['wan', 'firewall']),
    ],
  },
  {
    id: 'f-campus',
    name: 'Campus - Building A',
    expanded: true,
    items: [
      host('h-acc1', 'access-sw1', '192.0.2.31', 'aruba-cx', ['access']),
      host('h-acc2', 'access-sw2', '192.0.2.32', 'aruba-cx', ['access']),
      host('h-acc3', 'access-sw3', '192.0.2.33', 'aruba-cx', ['access']),
      host('h-acc4', 'access-sw4', '192.0.2.34', 'aruba-aos-s', ['access', 'old']),
    ],
  },
  {
    id: 'f-wifi',
    name: 'Wireless',
    expanded: true,
    items: [
      host('h-mc1', 'mobility-gw1', '203.0.113.10', 'aruba-controller'),
      host('h-ap1', 'ap-lobby', '203.0.113.21', 'aruba-ap'),
    ],
  },
  {
    id: 'f-lab',
    name: 'Lab',
    expanded: false,
    items: [
      host('h-lab1', 'lab-cx1', '192.0.2.201', 'aruba-cx'),
      host('h-lab2', 'lab-ex1', '192.0.2.202', 'juniper-junos'),
    ],
  },
];

// ── What each device prints ──
// banner: shown when the tab connects (as if these commands were run
// already), then the prompt. commands: answers to lines sent later.

const coreSw1History = `
core-sw1# show vlan

-------------------------------------------------------------------------------------------
VLAN  Name                    Status  Reason          Type      Interfaces
-------------------------------------------------------------------------------------------
1     DEFAULT_VLAN_1          down    no_member_port  default
10    MGMT                    up      ok              static    1/1/49-1/1/50,lag1
20    USERS                   up      ok              static    1/1/1-1/1/24,lag1
30    VOICE                   up      ok              static    1/1/1-1/1/24,lag1
40    PRINTERS                up      ok              static    1/1/25-1/1/30,lag1
99    GUEST                   up      ok              static    lag1

core-sw1# show interface brief
--------------------------------------------------------------------------------------------
Port      Native  Mode    Type     Enabled Status  Reason                Speed   Description
          VLAN                                                           (Mb/s)
--------------------------------------------------------------------------------------------
1/1/1     20      access  1GbT     yes     up                            1000    desk-2-14
1/1/2     20      access  1GbT     yes     up                            1000    desk-2-15
1/1/3     20      access  1GbT     yes     down    Waiting for link      --      desk-2-16
1/1/4     40      access  1GbT     yes     up                            1000    printer-2f
1/1/5     20      access  1GbT     no      down    Administratively down --      --
1/1/6     30      access  1GbT     yes     up                            1000    phone-2-01
1/1/49    10      trunk   SFP+DAC  yes     up                            10000   to core-sw2
1/1/50    10      trunk   SFP+DAC  yes     up                            10000   to core-sw2
1/1/51    --      routed  SFP+SR   yes     up                            10000   to edge-mx1
lag1      1       trunk   --       yes     up                            20000   to access-sw1

core-sw1# show lldp neighbor-info

LLDP Neighbor Information
=========================

Total Neighbor Entries          : 4
Total Neighbor Entries Deleted  : 0

LOCAL-PORT  CHASSIS-ID         PORT-ID     PORT-DESC          TTL   SYS-NAME
--------------------------------------------------------------------------------
1/1/49      00:00:5e:00:53:12  1/1/49      to core-sw1        120   core-sw2
1/1/50      00:00:5e:00:53:12  1/1/50      to core-sw1        120   core-sw2
1/1/51      00:00:5e:00:53:01  ge-0/0/1    to core-sw1        120   edge-mx1
1/1/52      00:00:5e:00:53:31  1/1/52      uplink             120   access-sw1

core-sw1# show ip route

Displaying ipv4 routes selected for forwarding

'[x/y]' denotes [distance/metric]

0.0.0.0/0, vrf default
	via  198.51.100.1,  [110/10],  ospf
192.0.2.0/26, vrf default
	via  vlan10,  [0/0],  connected
192.0.2.64/26, vrf default
	via  vlan20,  [0/0],  connected
198.51.100.0/30, vrf default
	via  1/1/51,  [0/0],  connected
203.0.113.0/24, vrf default
	via  192.0.2.12,  [110/20],  ospf

`;

const coreSw1Commands = {
  'show running-config | include radius|snmp': `radius-server host 192.0.2.50 key ciphertext AQBapFAKEdemoKeyNotRealAAAAAAAAAAAAAAAA= vrf mgmt
radius-server host 192.0.2.51 key ciphertext AQBapFAKEdemoKeyNotRealBBBBBBBBBBBBBBBB= vrf mgmt
aaa group server radius NETOPS
    server 192.0.2.50 vrf mgmt
    server 192.0.2.51 vrf mgmt
snmp-server vrf mgmt
snmp-server community FAKE-demo-community
snmpv3 user netops auth sha auth-pass plaintext FakeAuth1 priv aes priv-pass plaintext FakePriv1`,
  'show radius-server': `
Unreachable servers are preceded by *

******* Global RADIUS Configuration *******

Shared-Secret            : None
Timeout                  : 5
Retries                  : 1
Number of Servers        : 2

-----------------------------------------------------------------------------
SERVER NAME            |TLS|PORT |VRF   |STATUS   |SERVER GROUP
-----------------------------------------------------------------------------
192.0.2.50             |   |1812 |mgmt  |up       |NETOPS
*192.0.2.51            |   |1812 |mgmt  |down     |NETOPS`,
};

const edgeMx1History = `
--- JUNOS 23.4R1 built 2024-01-01 00:00:00 UTC
netops@edge-mx1> show interfaces terse | match "ge-0/0/[0-3]"
ge-0/0/0                up    up
ge-0/0/0.0              up    up   inet     203.0.113.2/30
ge-0/0/1                up    up
ge-0/0/1.0              up    up   inet     198.51.100.1/30
ge-0/0/2                up    down
ge-0/0/3                up    up
ge-0/0/3.0              up    up   inet     203.0.113.6/30

netops@edge-mx1> show bgp neighbor | match "^Peer|State:"
Peer: 203.0.113.1+179 AS 64500 Local: 203.0.113.2+51312 AS 64496
  Type: External    State: Established    Flags: <Sync>
Peer: 203.0.113.5+179 AS 64501 Local: 203.0.113.6+50211 AS 64496
  Type: External    State: Established    Flags: <Sync>

netops@edge-mx1> show system uptime | match booted
System booted: 2026-09-11 02:15:44 UTC (3w0d 07:25 ago)

`;

const accessSw3History = `
access-sw3# show interface 1/1/12

Interface 1/1/12 is up
 Admin state is up
 Link state: up for 3 days (since Mon Sep 29 08:14:02 UTC 2026)
 Description: desk-3-12
 Hardware: Ethernet, MAC Address: 00:00:5e:00:53:33
 MTU 1500
 Speed 1000 Mb/s
 Auto-negotiation is on
 VLAN Mode: access
 Access VLAN: 20

access-sw3# show power-over-ethernet 1/1/12

  Status                      : Searching
  Power Drawn                 : 0.0 W
  Fault Status                : Overload (over current)
  Priority                    : low

`;

// A shorter, narrower core-sw1 history for shots where the terminal is narrow.
export const coreSw1Narrow = `
core-sw1# show lldp neighbor-info 1/1/7

Port                           : 1/1/7
Neighbor Entries               : 1
Neighbor Chassis-Name          : camera-lobby-1
Neighbor Chassis-ID            : 00:00:5e:00:53:a7
Neighbor Management-Address    : 192.0.2.140
Neighbor Port-ID               : eth0
TTL                            : 120

core-sw1# show running-config interface 1/1/9
interface 1/1/9
    description guest-ap-old
    no shutdown
    vlan access 99
    exit

core-sw1# show vlan 99

-------------------------------------------------------------
VLAN  Name      Status  Reason  Type     Interfaces
-------------------------------------------------------------
99    GUEST     up      ok      static   1/1/9,lag1

core-sw1# ping 192.0.2.10 repetitions 3
PING 192.0.2.10 (192.0.2.10) 100(128) bytes of data.
108 bytes from 192.0.2.10: icmp_seq=1 ttl=64 time=0.41 ms
108 bytes from 192.0.2.10: icmp_seq=2 ttl=64 time=0.38 ms
108 bytes from 192.0.2.10: icmp_seq=3 ttl=64 time=0.39 ms

--- 192.0.2.10 ping statistics ---
3 packets transmitted, 3 received, 0% packet loss, time 2003ms

`;

export const devices = {
  '192.0.2.11': { banner: coreSw1History, prompt: 'core-sw1# ', commands: coreSw1Commands },
  '192.0.2.12': { banner: '\n', prompt: 'core-sw2# ', commands: {} },
  '198.51.100.1': { banner: edgeMx1History, prompt: 'netops@edge-mx1> ', commands: {} },
  '192.0.2.33': { banner: accessSw3History, prompt: 'access-sw3# ', commands: {} },
  default: { banner: '\n', prompt: 'netops@demo# ', commands: {} },
};

// ── Config Editor files ──

const camerasCfg = `! core-sw1: VLAN 50 for the lobby cameras
! Change CHG-1042, netops
!
vlan 50
    name CAMERAS
    description Lobby and loading dock cameras
no vlan 99
!
interface 1/1/7
    description camera-lobby-1
    no shutdown
    vlan access 50
interface 1/1/8
    description camera-dock-2
    no shutdown
    vlan access 50
interface 1/1/9
    description spare
    shutdown
!
interface vlan 50
    ip address 192.0.2.129/26
    ip helper-address <DHCP-SERVER-IP>
!
radius-server host 192.0.2.50 key plaintext FAKE-demo-radius-key vrf mgmt
user netops group administrators password plaintext NotARealPassword1
!
ntp server 192.0.2.5 iburst
logging 192.0.2.60 severity warning
`;

const edgeMx1Txt = `set system host-name edge-mx1
set system time-zone UTC
set system ntp server 192.0.2.5
set system services ssh protocol-version v2
set system services ssh root-login deny
set system syslog host 192.0.2.60 any warning
set system login user netops class super-user
set interfaces ge-0/0/0 description "upstream A (203.0.113.1)"
set interfaces ge-0/0/0 unit 0 family inet address 203.0.113.2/30
set interfaces ge-0/0/1 description "to core-sw1"
set interfaces ge-0/0/1 unit 0 family inet address 198.51.100.1/30
set interfaces ge-0/0/3 description "upstream B (203.0.113.5)"
set interfaces ge-0/0/3 unit 0 family inet address 203.0.113.6/30
set routing-options autonomous-system 64496
set protocols bgp group upstream type external
set protocols bgp group upstream import from-upstream
set protocols bgp group upstream export to-upstream
set protocols bgp group upstream neighbor 203.0.113.1 peer-as 64500
set protocols bgp group upstream neighbor 203.0.113.5 peer-as 64501
set protocols ospf area 0.0.0.0 interface ge-0/0/1.0
set policy-options prefix-list mgmt 192.0.2.0/26
set policy-options policy-statement to-upstream term ours from route-filter 198.51.100.0/24 orlonger
set policy-options policy-statement to-upstream term ours then accept
set policy-options policy-statement to-upstream term rest then reject
set firewall filter protect-re term ssh from source-prefix-list mgmt
set firewall filter protect-re term ssh from protocol tcp destination-port ssh
set firewall filter protect-re term ssh then accept
set firewall filter protect-re term bgp from protocol tcp port bgp
set firewall filter protect-re term bgp then accept
set interfaces lo0 unit 0 family inet filter input protect-re
`;

const accessTemplate = `! Access switch base config (template)
hostname \${name}
!
ntp server 192.0.2.5 iburst
logging 192.0.2.60 severity warning
!
vlan 20
    name USERS
vlan 30
    name VOICE
!
interface 1/1/1-1/1/48
    no shutdown
    vlan access 20
    vlan trunk native 20
    spanning-tree bpdu-guard
    spanning-tree port-type admin-edge
`;

export const files = {
  'core-sw1-cameras.cfg': camerasCfg,
  'edge-mx1.txt': edgeMx1Txt,
  'access-base.cfg': accessTemplate,
  'access-sw3.cfg': accessTemplate.replace('${name}', 'access-sw3'),
  'README.md': '# Network configs\n\nOne folder per site. Changes go through Change Jobs.\n',
};

export const folder = {
  root: 'C:\\Users\\netops\\network-configs',
  truncated: false,
  entries: [
    { path: 'core', isDir: true, size: 0 },
    { path: 'core/core-sw1-cameras.cfg', isDir: false, size: 812 },
    { path: 'core/core-sw2.cfg', isDir: false, size: 9120 },
    { path: 'edge', isDir: true, size: 0 },
    { path: 'edge/edge-mx1.txt', isDir: false, size: 702 },
    { path: 'edge/edge-srx1.txt', isDir: false, size: 1340 },
    { path: 'campus-a', isDir: true, size: 0 },
    { path: 'campus-a/access-base.cfg', isDir: false, size: 420 },
    { path: 'campus-a/access-sw1.cfg', isDir: false, size: 6200 },
    { path: 'campus-a/access-sw2.cfg', isDir: false, size: 6190 },
    { path: 'campus-a/access-sw3.cfg', isDir: false, size: 6233 },
    { path: 'campus-a/access-sw4.cfg', isDir: false, size: 5102 },
    { path: 'templates', isDir: true, size: 0 },
    { path: 'templates/snmpv3.cfg', isDir: false, size: 310 },
    { path: 'templates/radius.cfg', isDir: false, size: 288 },
    { path: 'README.md', isDir: false, size: 74 },
  ],
};

// ── The scripted AI ──
// Each entry answers a question that matches `match`. With `tool`, the AI
// first calls that tool and gives `text` after it sees the result.

export const ai = [
  {
    match: '^Fix the problems',
    fix: [
      ['<DHCP-SERVER-IP>', '192.0.2.10'],
      ['no vlan 99\n', '! VLAN 99 stays: lag1 still carries it\n'],
      [
        'interface vlan 50\n',
        'interface lag 1\n    vlan trunk allowed 10,20,30,40,50,99\n!\ninterface vlan 50\n',
      ],
    ],
    text:
      'Three changes:\n\n' +
      '1. **DHCP helper**: `192.0.2.10` is the DHCP server the other VLANs use.\n' +
      '2. **VLAN 99**: kept. `lag1` still carries it, so removing it would cut guest Wi-Fi.\n' +
      '3. **Uplink**: VLAN 50 is added to `lag 1`, or the cameras could not reach the core.\n\n' +
      '{code}\n\nThe spare port 1/1/9 stays shut down on purpose.',
  },
  {
    match: 'RADIUS',
    before: 'I will read the RADIUS and SNMP lines from the running config.',
    tool: { name: 'send_terminal_command', input: { command: 'show running-config | include radius|snmp' } },
    text:
      'Here is what **core-sw1** has:\n\n' +
      '- **RADIUS**: two servers, `192.0.2.50` and `192.0.2.51`, both in VRF `mgmt`, in the group `NETOPS`. ' +
      'Their keys show as `<secret hidden>`: GreenCLI hid them before I saw the output.\n' +
      '- **SNMP v2c**: a community is still set (`<secret hidden>`). v2c sends it in clear text.\n' +
      '- **SNMPv3**: user `netops` with SHA and AES. Good.\n\n' +
      '**What I would change**\n\n' +
      '1. Check that `192.0.2.51` answers: run `show radius-server`.\n' +
      '2. Remove the v2c community once your poller uses SNMPv3.',
  },
  {
    match: 'PoE',
    before: 'Port 1/1/12 shows a PoE overload fault. I will bounce the port with the lab-tools server.',
    tool: {
      name: 'bounce_port',
      input: {
        device: 'access-sw3',
        interface: '1/1/12',
        poe_reset: true,
        down_seconds: 5,
        reason: 'desk-3-12 phone stuck in PoE fault',
        confirm: true,
      },
    },
    text: 'Done. Port 1/1/12 came back up and the phone draws 4.2 W again.',
  },
];

export const aiFallback = { text: 'I can help with that. Which device should I look at?' };

// ── MCP servers (Settings → MCP Servers, and the AI's MCP tools) ──

export const mcp = {
  servers: [
    {
      name: 'centralmcp',
      transport: 'stdio',
      command: 'uv',
      args: ['run', '--directory', 'C:\\Users\\netops\\mcp\\centralmcp', 'aruba-tool-router'],
      env: {},
      cwd: null,
      url: null,
      credentialsEnvVar: 'CREDS_PATH',
      headers: {},
      enabled: true,
      writes: 'off',
    },
    {
      name: 'junos',
      transport: 'stdio',
      command: 'uv',
      args: ['run', 'junos-mcp-server', '-f', 'C:\\Users\\netops\\mcp\\devices.json'],
      env: {},
      cwd: null,
      url: null,
      credentialsEnvVar: null,
      headers: {},
      enabled: true,
      writes: 'off',
      showOptIn: true,
    },
    {
      name: 'lab-tools',
      transport: 'http',
      command: '',
      args: [],
      env: {},
      cwd: null,
      url: 'https://192.0.2.80:8443/mcp',
      credentialsEnvVar: null,
      headers: { Authorization: 'Bearer FAKE-demo-token' },
      enabled: true,
      writes: 'on',
    },
  ],
  status: [
    {
      name: 'centralmcp',
      enabled: true,
      connected: true,
      toolCount: 18,
      hiddenToolCount: 9,
      preset: { id: 'centralmcp', label: 'centralmcp' },
      presetBy: 'definition',
      writes: 'off',
      writesSet: true,
      pins: { kind: 'pinned', shown: ['CENTRALMCP_READONLY=1'], confirmed: true },
      access: 'read-write',
    },
    {
      name: 'junos',
      enabled: true,
      connected: true,
      toolCount: 6,
      hiddenToolCount: 2,
      preset: { id: 'junos-mcp-server', label: 'Junos MCP server' },
      presetBy: 'definition',
      writes: 'off',
      writesSet: true,
      pins: { kind: 'cannot-pin', reason: 'it has no read-only setting' },
    },
    {
      name: 'lab-tools',
      enabled: true,
      connected: true,
      toolCount: 7,
      hiddenToolCount: 0,
      preset: null,
      writes: 'on',
      writesSet: true,
      pins: { kind: 'none' },
    },
  ],
  tools: [
    {
      server: 'lab-tools',
      name: 'bounce_port',
      description: 'Turn a switch port off and on again, with an optional PoE reset.',
      inputSchema: {
        type: 'object',
        properties: {
          device: { type: 'string' },
          interface: { type: 'string' },
          poe_reset: { type: 'boolean' },
          down_seconds: { type: 'integer' },
          reason: { type: 'string' },
          confirm: { type: 'boolean' },
        },
        required: ['device', 'interface'],
      },
      annotations: { destructiveHint: true, readOnlyHint: false },
      writes: 'on',
      label: 'destructive',
    },
    {
      server: 'lab-tools',
      name: 'get_port_status',
      description: 'Read the state of a switch port.',
      inputSchema: { type: 'object', properties: { device: { type: 'string' }, interface: { type: 'string' } } },
      annotations: { readOnlyHint: true },
      writes: 'on',
      label: 'read',
    },
  ],
  exportPins: {
    centralmcp: { kind: 'pinned', args: [], env: [['CENTRALMCP_READONLY', '1']], shown: ['CENTRALMCP_READONLY=1'] },
    junos: { kind: 'cannot-pin', reason: 'it has no read-only setting' },
  },
  greencli: {
    path: 'C:\\Program Files\\GreenCLI\\greencli-mcp.exe',
    exists: true,
    place: 'normal',
  },
};

// ── Network Intent ──

const at = Date.UTC(2026, 9, 2, 8, 30);
export const intents = [
  {
    id: 'i-ntp',
    name: 'NTP points at 192.0.2.5',
    kind: 'config',
    description: 'Every switch uses the site time server.',
    command: 'show running-config | include ntp',
    matcher: { kind: 'contains', value: 'ntp server 192.0.2.5' },
    severity: 'warning',
    scope: { all: false, tags: ['core', 'access'], deviceTypes: [] },
    lastResult: {
      status: 'ok',
      detail: '5 of 5 devices match',
      at,
      perDevice: [
        { device: 'core-sw1', status: 'ok', detail: 'matched' },
        { device: 'core-sw2', status: 'ok', detail: 'matched' },
        { device: 'access-sw1', status: 'ok', detail: 'matched' },
        { device: 'access-sw2', status: 'ok', detail: 'matched' },
        { device: 'access-sw3', status: 'ok', detail: 'matched' },
      ],
    },
  },
  {
    id: 'i-snmp',
    name: 'No SNMP v2c communities',
    kind: 'config',
    description: 'Only SNMPv3. v2c sends the community in clear text.',
    command: 'show running-config | include snmp-server community',
    matcher: { kind: 'notContains', value: 'snmp-server community' },
    severity: 'critical',
    scope: { all: false, tags: [], deviceTypes: ['aruba-cx'] },
    lastResult: {
      status: 'violation',
      detail: '2 of 5 devices still have a v2c community',
      at,
      perDevice: [
        { device: 'core-sw1', status: 'violation', detail: 'found "snmp-server community"' },
        { device: 'core-sw2', status: 'ok', detail: 'not found' },
        { device: 'access-sw1', status: 'ok', detail: 'not found' },
        { device: 'access-sw2', status: 'violation', detail: 'found "snmp-server community"' },
        { device: 'access-sw3', status: 'ok', detail: 'not found' },
      ],
    },
  },
  {
    id: 'i-uplinks',
    name: 'Uplinks are up',
    kind: 'operational',
    description: 'Both core links and the WAN link.',
    command: 'show interface brief',
    matcher: { kind: 'regexAbsent', value: '^1/1/(49|50|51)\\s.*\\bdown\\b' },
    severity: 'critical',
    scope: { all: false, tags: ['core'], deviceTypes: [] },
    lastResult: {
      status: 'ok',
      detail: '2 of 2 devices match',
      at,
      perDevice: [
        { device: 'core-sw1', status: 'ok', detail: 'no match' },
        { device: 'core-sw2', status: 'ok', detail: 'no match' },
      ],
    },
  },
  {
    id: 'i-bgp',
    name: 'BGP peers established',
    kind: 'operational',
    description: 'Both upstream peers on the edge router.',
    command: 'show bgp summary',
    matcher: { kind: 'regexAbsent', value: '(Active|Connect|Idle)$' },
    severity: 'critical',
    scope: { all: false, tags: ['wan'], deviceTypes: [] },
    lastResult: {
      status: 'ok',
      detail: '1 of 1 devices match',
      at,
      perDevice: [{ device: 'edge-mx1', status: 'ok', detail: 'no match' }],
    },
  },
  {
    id: 'i-bpdu',
    name: 'Edge ports have BPDU guard',
    kind: 'config',
    description: 'Access ports must not take part in spanning tree.',
    command: 'show running-config interface 1/1/1',
    matcher: { kind: 'contains', value: 'spanning-tree bpdu-guard' },
    severity: 'warning',
    scope: { all: false, tags: ['access'], deviceTypes: [] },
    lastResult: {
      status: 'unknown',
      detail: '1 device was not connected',
      at,
      perDevice: [
        { device: 'access-sw1', status: 'ok', detail: 'matched' },
        { device: 'access-sw2', status: 'ok', detail: 'matched' },
        { device: 'access-sw3', status: 'ok', detail: 'matched' },
        { device: 'access-sw4', status: 'unknown', detail: 'not connected' },
      ],
    },
  },
];

export const demo = {
  folders,
  devices,
  files,
  folder,
  openFile: 'C:\\Users\\netops\\network-configs\\core\\core-sw1-cameras.cfg',
  saveFile: 'C:\\Users\\netops\\.mcp.json',
  ai,
  aiFallback,
  mcp,
  update: { version: appVersion, enabled: true, reason: null, place: 'normal', ready: null },
  answers: {
    intent_list: intents,
    intent_list_strict: intents,
    config_archive_missing_hidden: { missing: 0, stale: 0 },
    config_archive_devices: [],
    config_archive_list: [],
    list_known_hosts: [],
    ssh_list_forwards: [],
    mcp_export_write: null,
    session_log_path: null,
    vault_delete: null,
    vault_store: null,
    vault_retrieve: null,
    central_clear: null,
    mist_clear: null,
    resize_terminal: null,
    disconnect: null,
    intent_save: null,
    intent_set_result: null,
    list_serial_ports: [],
  },
};

// Runs in the page before the app loads (addInitScript): settings and
// one-time flags, so every shot starts from the same clean, dark app.
// `extra` is { settings: {...}, local: { key: value } } from the shot.
export function seedStorage(extra) {
  try {
    localStorage.clear();
    localStorage.setItem('greencli-help-seen-v1', '1');
    const settings = Object.assign(
      { theme: 'dark', fontSize: 13, cursorBlink: false, aiProvider: 'anthropic' },
      extra.settings || {}
    );
    localStorage.setItem('atp-settings', JSON.stringify({ state: settings, version: 0 }));
    for (const [k, v] of Object.entries(extra.local || {})) {
      localStorage.setItem(k, typeof v === 'string' ? v : JSON.stringify(v));
    }
  } catch {
    /* storage blocked: the app still opens, just with defaults */
  }
}
