import { describe, it, expect } from 'vitest';
import {
  ApiRequest,
  CSV_TEMPLATE,
  apiErrorText,
  candidateToConfig,
  centralDevicesToHosts,
  centralSwitchType,
  deviceTypeFromName,
  fetchCentralHosts,
  fetchMistHosts,
  findFolderId,
  importStatuses,
  mistDevicesToHosts,
  mistScopes,
  parseCsv,
  parseHostsCsv,
  parseSecureCrtFiles,
  parseSecureCrtIni,
  parseSecureCrtXml,
  sshConfigToHosts,
  targetFolder,
} from './importHosts';

describe('parseCsv', () => {
  it('handles quoted commas, escaped quotes, CRLF, a BOM and blank lines', () => {
    const text = '\uFEFFname,host\r\n"core, sw1",10.0.0.1\r\n\r\n"say ""hi""",sw2\r\n';
    expect(parseCsv(text)).toEqual([
      { line: 1, cells: ['name', 'host'] },
      { line: 2, cells: ['core, sw1', '10.0.0.1'] },
      { line: 4, cells: ['say "hi"', 'sw2'] },
    ]);
  });

  it('keeps a line break inside quotes and numbers later records correctly', () => {
    const rows = parseCsv('name,host\n"two\nlines",a\nlast,b');
    expect(rows[1]).toEqual({ line: 2, cells: ['two\nlines', 'a'] });
    expect(rows[2]).toEqual({ line: 4, cells: ['last', 'b'] });
  });

  it('detects semicolon and tab separators from the header', () => {
    expect(parseCsv('name;host\nsw1;10.0.0.1')[1].cells).toEqual(['sw1', '10.0.0.1']);
    expect(parseCsv('name\thost\nsw1\t10.0.0.1')[1].cells).toEqual(['sw1', '10.0.0.1']);
  });
});

describe('deviceTypeFromName', () => {
  it('maps friendly names', () => {
    expect(deviceTypeFromName('CX')).toBe('aruba-cx');
    expect(deviceTypeFromName('AOS-S')).toBe('aruba-aos-s');
    expect(deviceTypeFromName('aos8')).toBe('aruba-controller');
    expect(deviceTypeFromName('Controller')).toBe('aruba-controller');
    expect(deviceTypeFromName('IAP')).toBe('aruba-ap');
    expect(deviceTypeFromName('instant')).toBe('aruba-ap');
    expect(deviceTypeFromName('Juniper')).toBe('juniper-junos');
    expect(deviceTypeFromName('junos')).toBe('juniper-junos');
    expect(deviceTypeFromName('mist')).toBe('mist');
    expect(deviceTypeFromName('aruba-cx')).toBe('aruba-cx');
    expect(deviceTypeFromName('mobility controller')).toBe('aruba-controller');
  });

  it('treats blank as generic and unknown as undefined', () => {
    expect(deviceTypeFromName('')).toBe('generic');
    expect(deviceTypeFromName(undefined)).toBe('generic');
    expect(deviceTypeFromName('fortigate')).toBeUndefined();
  });
});

describe('parseHostsCsv', () => {
  it('parses the template without problems', () => {
    const r = parseHostsCsv(CSV_TEMPLATE);
    expect(r.problems).toEqual([]);
    expect(r.hosts).toHaveLength(5);
    expect(r.hosts[0]).toMatchObject({
      name: 'core-sw-01',
      host: '10.0.0.1',
      port: 22,
      username: 'admin',
      deviceType: 'aruba-cx',
      folder: 'HQ / Core',
      tags: ['core', 'hq'],
      protocol: 'ssh',
    });
    expect(r.hosts[3]).toMatchObject({ jumpHost: 'bastion.example.com', jumpUsername: 'netops', jumpPort: undefined });
    expect(r.hosts[4]).toMatchObject({ name: 'lab-sw, rack 4', port: 2222, username: undefined, folder: 'Lab', tags: [] });
  });

  it('matches headers case-insensitively, in any order, with aliases', () => {
    const r = parseHostsCsv('Folder,IP Address,Username,Name\nSite A,10.1.1.1,ops,sw1\n');
    expect(r.hosts[0]).toMatchObject({ name: 'sw1', host: '10.1.1.1', username: 'ops', folder: 'Site A', port: 22 });
  });

  it('reports missing host and bad ports per line and keeps the good rows', () => {
    const csv = 'name,host,port\nsw1,,22\nsw2,10.0.0.2,99999\nsw3,10.0.0.3,ssh\nsw4,10.0.0.4,\n';
    const r = parseHostsCsv(csv);
    expect(r.hosts.map((h) => h.name)).toEqual(['sw4']);
    expect(r.problems).toEqual([
      { where: 'Line 2', message: 'Missing host.' },
      { where: 'Line 3', message: 'Bad port "99999" (use 1–65535).' },
      { where: 'Line 4', message: 'Bad port "ssh" (use 1–65535).' },
    ]);
  });

  it('uses user@host:port from the host cell unless the columns say otherwise', () => {
    const r = parseHostsCsv('host,user,port\nadmin@10.0.0.1:2222,,\nadmin@10.0.0.2:2222,ops,830\n');
    expect(r.hosts[0]).toMatchObject({ host: '10.0.0.1', username: 'admin', port: 2222, name: '10.0.0.1' });
    expect(r.hosts[1]).toMatchObject({ host: '10.0.0.2', username: 'ops', port: 830 });
  });

  it('needs a header with a host column', () => {
    const r = parseHostsCsv('sw1,10.0.0.1\n');
    expect(r.hosts).toEqual([]);
    expect(r.problems[0].message).toMatch(/No "host" column/);
  });

  it('notes an unknown type, supports telnet and ignores a password column', () => {
    const r = parseHostsCsv('host,type,protocol,password\n10.0.0.1,fortigate,telnet,secret\n10.0.0.2,,rlogin,\n');
    expect(r.hosts).toHaveLength(1);
    expect(r.hosts[0]).toMatchObject({ protocol: 'telnet', port: 23, deviceType: 'generic' });
    expect(r.hosts[0].notes[0]).toMatch(/Unknown type "fortigate"/);
    expect(JSON.stringify(r.hosts[0])).not.toContain('secret');
    expect(r.problems.map((p) => p.where)).toEqual(['Header', 'Line 3']);
  });

  it('ignores a jump host on telnet rows', () => {
    const r = parseHostsCsv('host,protocol,jump\n10.0.0.1,telnet,bastion\n');
    expect(r.hosts[0].jumpHost).toBeUndefined();
    expect(r.hosts[0].notes[0]).toMatch(/Jump host only applies to SSH/);
  });

  it('says so when the file is empty or has only a header', () => {
    expect(parseHostsCsv('').problems[0].message).toBe('The file is empty.');
    expect(parseHostsCsv('name,host\n').problems[0].message).toMatch(/Only a header row/);
  });
});

const SSH2_INI = [
  'S:"Username"=admin',
  'S:"Password V2"=02:abcdef0123',
  'Z:"Description"=00000001',
  ' core switch in MDF',
  'D:"[SSH2] Port"=00000016',
  'S:"Hostname"=10.1.1.1',
  'S:"Firewall Name"=None',
  'S:"Protocol Name"=SSH2',
  'B:"Normal Font v2"=00000004',
  ' 01 02 03 04',
].join('\r\n');

describe('parseSecureCrtIni', () => {
  it('reads strings and hex DWORDs and skips multi-line blocks', () => {
    const s = parseSecureCrtIni(SSH2_INI);
    expect(s.strings.hostname).toBe('10.1.1.1');
    expect(s.strings.username).toBe('admin');
    expect(s.dwords['[ssh2] port']).toBe(22);
    expect(s.strings.description).toBeUndefined();
  });
});

describe('parseSecureCrtFiles', () => {
  it('maps SSH2, Telnet and Serial sessions with folders from the path', () => {
    const r = parseSecureCrtFiles([
      { path: 'HQ/Core/core-sw1.ini', text: SSH2_INI },
      {
        path: 'Branch 12/old-2530.ini',
        text: 'S:"Protocol Name"=Telnet\nS:"Hostname"=10.12.0.5\nD:"Port"=00000017\n',
      },
      {
        path: 'console-lab.ini',
        text: 'S:"Protocol Name"=Serial\nS:"Com Port"=COM3\nD:"Baud Rate"=0001c200\nD:"Data Bits"=00000008\nD:"Parity"=00000002\nD:"Stop Bits"=00000002\n',
      },
    ]);
    expect(r.problems).toEqual([]);
    expect(r.hosts[0]).toMatchObject({
      name: 'core-sw1',
      folder: 'HQ / Core',
      protocol: 'ssh',
      host: '10.1.1.1',
      port: 22,
      username: 'admin',
      deviceType: 'generic',
      notes: [],
    });
    expect(JSON.stringify(r.hosts[0])).not.toContain('abcdef');
    expect(r.hosts[1]).toMatchObject({ name: 'old-2530', folder: 'Branch 12', protocol: 'telnet', port: 23 });
    expect(r.hosts[2]).toMatchObject({
      name: 'console-lab',
      folder: undefined,
      protocol: 'serial',
      serialPort: 'COM3',
      baudRate: 115200,
      dataBits: 8,
      parity: 'even',
      stopBits: 2,
    });
  });

  it('reads non-default hex ports and Windows paths', () => {
    const r = parseSecureCrtFiles([
      { path: 'Lab\\sw9.ini', text: 'S:"Protocol Name"=SSH2\nS:"Hostname"=lab-sw9\nD:"[SSH2] Port"=000008ae\n' },
    ]);
    expect(r.hosts[0]).toMatchObject({ name: 'sw9', folder: 'Lab', port: 2222 });
  });

  it('notes a firewall / jump session and defaults a missing protocol to SSH2', () => {
    const r = parseSecureCrtFiles([
      { path: 'dmz-fw.ini', text: 'S:"Hostname"=172.16.0.1\nS:"Firewall Name"=Session:Jump/bastion01\n' },
    ]);
    expect(r.hosts[0]).toMatchObject({ protocol: 'ssh', port: 22 });
    expect(r.hosts[0].jumpHost).toBeUndefined();
    expect(r.hosts[0].notes[0]).toMatch(/firewall \/ jump "Session:Jump\/bastion01"/);
  });

  it('reports unsupported protocols and sessions without a hostname', () => {
    const r = parseSecureCrtFiles([
      { path: 'A/rlogin-box.ini', text: 'S:"Protocol Name"=RLogin\nS:"Hostname"=old\n' },
      { path: 'A/empty.ini', text: 'S:"Protocol Name"=SSH2\nS:"Hostname"=\n' },
    ]);
    expect(r.hosts).toEqual([]);
    expect(r.problems).toEqual([
      { where: 'A/rlogin-box.ini', message: "RLogin sessions aren't supported." },
      { where: 'A/empty.ini', message: 'No hostname.' },
    ]);
  });
});

describe('parseSecureCrtXml', () => {
  const XML = `<?xml version="1.0" encoding="UTF-8"?>
<VanDyke version="3.0">
  <key name="Sessions">
    <key name="Default">
      <string name="Hostname"></string>
      <string name="Protocol Name">SSH2</string>
    </key>
    <key name="HQ">
      <key name="__FolderData__"><string name="Folder List"></string></key>
      <key name="Core">
        <key name="core-sw1">
          <dword name="[SSH2] Port">22</dword>
          <string name="Hostname">10.1.1.1</string>
          <string name="Protocol Name">SSH2</string>
          <string name="Username">admin</string>
        </key>
      </key>
      <key name="edge-rtr">
        <dword name="Port">2323</dword>
        <string name="Hostname">10.1.1.254</string>
        <string name="Protocol Name">Telnet</string>
      </key>
    </key>
    <key name="lab-console">
      <string name="Protocol Name">Serial</string>
      <string name="Com Port">/dev/cu.usbserial-A10K</string>
      <dword name="Baud Rate">115200</dword>
    </key>
  </key>
</VanDyke>`;

  it('walks folders, skips Default and folder data, reads decimal DWORDs', () => {
    const r = parseSecureCrtXml(XML);
    expect(r.problems).toEqual([]);
    expect(r.hosts.map((h) => [h.name, h.folder, h.protocol, h.host ?? h.serialPort, h.port ?? h.baudRate])).toEqual([
      ['core-sw1', 'HQ / Core', 'ssh', '10.1.1.1', 22],
      ['edge-rtr', 'HQ', 'telnet', '10.1.1.254', 2323],
      ['lab-console', undefined, 'serial', '/dev/cu.usbserial-A10K', 115200],
    ]);
  });

  it('rejects files that are not a SecureCRT export', () => {
    expect(parseSecureCrtXml('<not xml').problems[0].message).toBe('Not a valid XML file.');
    expect(parseSecureCrtXml('<VanDyke version="3.0"><key name="Global"/></VanDyke>').problems[0].message).toMatch(
      /No sessions/,
    );
  });
});

describe('sshConfigToHosts', () => {
  it('keeps the key file and the ProxyJump', () => {
    const r = sshConfigToHosts([
      { name: 'core', host: '10.0.0.1', port: 22, username: 'admin', identityFile: '/home/me/.ssh/id_ed25519', jumpHost: 'ops@bastion:2222' },
    ]);
    expect(r.hosts[0]).toMatchObject({ keyPath: '/home/me/.ssh/id_ed25519', jumpHost: 'bastion', jumpPort: 2222, jumpUsername: 'ops' });
    expect(candidateToConfig(r.hosts[0], 'id1')).toMatchObject({ authType: 'key', keyPath: '/home/me/.ssh/id_ed25519' });
  });
});

// Trimmed from real /monitoring/v1/switches, /monitoring/v2/aps and
// /monitoring/v1/gateways replies.
const CENTRAL_SWITCHES = {
  count: 3,
  total: 3,
  switches: [
    {
      name: 'MDF-6300-1',
      ip_address: '10.20.0.2',
      macaddr: '88:3a:30:aa:bb:01',
      model: 'Aruba 6300M 48G CL4 PoE 4SFP56 Swch (JL661A)',
      serial: 'SG0ZKMX001',
      site: 'HQ',
      group_name: 'CX-Core',
      labels: ['core', 'mdf'],
      status: 'Up',
      switch_type: 'AOS-CX',
    },
    {
      name: 'IDF2-2930F',
      ip_address: '10.20.2.10',
      model: 'Aruba2930F-48G-PoE+-4SFP+ Switch(JL256A)',
      serial: 'CN0ABC1234',
      site: 'HQ',
      group_name: 'AOS-S-Access',
      labels: [],
      status: 'Up',
      switch_type: 'AOS-S',
    },
    { name: 'spare-6100', ip_address: '', model: 'Aruba 6100 24G 4SFP+ Switch (JL678A)', site: '', status: 'Down', switch_type: 'AOS-CX' },
  ],
};
const CENTRAL_APS = {
  count: 1,
  total: 1,
  aps: [
    {
      name: 'AP-Lobby',
      ip_address: '10.30.0.12',
      macaddr: '20:4c:03:00:00:01',
      model: '535',
      serial: 'CNHXK0001',
      site: 'HQ',
      group_name: 'Campus-APs',
      labels: [{ label_id: 1, label_name: 'lobby' }],
      status: 'Up',
    },
  ],
};
const CENTRAL_GATEWAYS = {
  count: 1,
  total: 1,
  gateways: [{ name: 'GW-Branch12', ip_address: '10.112.0.1', model: 'A9004', site: 'Branch 12', group_name: 'Branch-GW', labels: [], status: 'Up' }],
};

describe('Aruba Central mapping', () => {
  it('maps switches by switch_type, site to folder, group + labels to tags; skips rows without an IP', () => {
    const r = centralDevicesToHosts('switch', CENTRAL_SWITCHES.switches);
    expect(r.hosts).toEqual([
      { name: 'MDF-6300-1', protocol: 'ssh', host: '10.20.0.2', port: 22, deviceType: 'aruba-cx', folder: 'HQ', tags: ['CX-Core', 'core', 'mdf'], notes: [] },
      { name: 'IDF2-2930F', protocol: 'ssh', host: '10.20.2.10', port: 22, deviceType: 'aruba-aos-s', folder: 'HQ', tags: ['AOS-S-Access'], notes: [] },
    ]);
    expect(r.problems).toEqual([{ where: 'Switch spare-6100', message: 'No IP address in Central (offline?) — skipped.' }]);
  });

  it('falls back to the model when switch_type is missing', () => {
    expect(centralSwitchType({ model: 'Aruba 6300M 48G CL4 PoE 4SFP56 Swch (JL661A)' })).toBe('aruba-cx');
    expect(centralSwitchType({ model: 'Aruba 8325-48Y8C (JL635A)' })).toBe('aruba-cx');
    expect(centralSwitchType({ model: 'Aruba2930F-24G-PoE+-4SFP+ Switch(JL261A)' })).toBe('aruba-aos-s');
    expect(centralSwitchType({ model: 'HP 5406zl' })).toBe('aruba-aos-s');
    expect(centralSwitchType({ model: 'Mystery' })).toBe('generic');
  });

  it('maps APs to Instant and gateways to controllers, with label objects', () => {
    expect(centralDevicesToHosts('ap', CENTRAL_APS.aps).hosts[0]).toMatchObject({
      deviceType: 'aruba-ap',
      tags: ['Campus-APs', 'lobby'],
    });
    expect(centralDevicesToHosts('gateway', CENTRAL_GATEWAYS.gateways).hosts[0]).toMatchObject({
      deviceType: 'aruba-controller',
      folder: 'Branch 12',
    });
  });

  it('fetches all three lists with limit/offset paging', async () => {
    const calls: string[] = [];
    const many = Array.from({ length: 1000 }, (_, i) => ({ name: `sw${i}`, ip_address: `10.0.${i >> 8}.${i & 255}`, switch_type: 'AOS-CX' }));
    const request: ApiRequest = async (_m, path) => {
      calls.push(path);
      if (path.startsWith('/monitoring/v1/switches?limit=1000&offset=0')) return { status: 200, body: { total: 1002, switches: many } };
      if (path.startsWith('/monitoring/v1/switches')) return { status: 200, body: { total: 1002, switches: CENTRAL_SWITCHES.switches } };
      if (path.startsWith('/monitoring/v2/aps')) return { status: 200, body: CENTRAL_APS };
      return { status: 403, body: { error: 'forbidden', error_description: 'No gateway access' } };
    };
    const r = await fetchCentralHosts(request);
    expect(calls).toEqual([
      '/monitoring/v1/switches?limit=1000&offset=0',
      '/monitoring/v1/switches?limit=1000&offset=1000',
      '/monitoring/v2/aps?limit=1000&offset=0',
      '/monitoring/v1/gateways?limit=1000&offset=0',
    ]);
    expect(r.hosts).toHaveLength(1000 + 2 + 1);
    expect(r.problems).toContainEqual({ where: 'Gateway list', message: 'Not allowed for this account (HTTP 403). No gateway access' });
  });

  it('fails as a whole when every list fails (bad token)', async () => {
    const request: ApiRequest = async () => ({ status: 401, body: { error: 'invalid_token', error_description: 'Invalid access token' } });
    await expect(fetchCentralHosts(request)).rejects.toThrow(/HTTP 401/);
  });
});

// Trimmed from /api/v1/self and /api/v1/orgs/:org_id/stats/devices?type=all.
const MIST_SELF = {
  email: 'neteng@example.com',
  privileges: [
    { scope: 'org', org_id: 'org-1', name: 'Example Corp', role: 'admin' },
    { scope: 'site', site_id: 'site-9', org_id: 'org-1', name: 'Covered Site', role: 'write' },
    { scope: 'site', site_id: 'site-x', org_id: 'org-2', name: 'Partner Lab', role: 'read' },
  ],
};
const MIST_SITES = [
  { id: 'site-hq', name: 'HQ', org_id: 'org-1' },
  { id: 'site-b12', name: 'Branch 12', org_id: 'org-1' },
];
const MIST_DEVICES = [
  {
    mac: '5c5b35000001',
    name: 'hq-ex4100-1',
    type: 'switch',
    model: 'EX4100-48P',
    site_id: 'site-hq',
    status: 'connected',
    ip: '10.10.1.21',
    ip_stat: { ip: '10.10.1.21', netmask: '255.255.255.0', gateway: '10.10.1.1' },
  },
  { mac: '5c5b35000002', name: '', hostname: 'b12-ex2300', type: 'switch', model: 'EX2300-24P', site_id: 'site-b12', ip_stat: { ip: '10.112.1.2' } },
  { mac: '5c5b35000003', name: 'b12-srx', type: 'gateway', model: 'SRX320', site_id: 'site-b12', ip: '10.112.0.1' },
  { mac: '5c5b35000004', name: 'hq-ssr', type: 'gateway', model: 'SSR120', site_id: 'site-hq', ip: '10.10.0.1' },
  { mac: '5c5b35000005', name: 'hq-ap-01', type: 'ap', model: 'AP45', site_id: 'site-hq', ip: '10.10.20.5' },
  { mac: '5c5b35000006', name: 'new-ex', type: 'switch', model: 'EX4400-24T', site_id: 'site-hq', status: 'disconnected' },
];

describe('Juniper Mist mapping', () => {
  it('reads org and site scopes from /self, dropping sites an org already covers', () => {
    expect(mistScopes(MIST_SELF)).toEqual({
      orgs: [{ id: 'org-1', name: 'Example Corp' }],
      sites: [{ id: 'site-x', name: 'Partner Lab' }],
    });
    expect(mistScopes({})).toEqual({ orgs: [], sites: [] });
  });

  it('maps switches and SRX to Junos, SSR to generic, skips APs and devices without an IP', () => {
    const names = { 'site-hq': 'HQ', 'site-b12': 'Branch 12' };
    const r = mistDevicesToHosts(MIST_DEVICES, names, { includeAps: false });
    expect(r.hosts.map((h) => [h.name, h.host, h.deviceType, h.folder])).toEqual([
      ['hq-ex4100-1', '10.10.1.21', 'juniper-junos', 'HQ'],
      ['b12-ex2300', '10.112.1.2', 'juniper-junos', 'Branch 12'],
      ['b12-srx', '10.112.0.1', 'juniper-junos', 'Branch 12'],
      ['hq-ssr', '10.10.0.1', 'generic', 'HQ'],
    ]);
    expect(r.problems).toEqual([
      { where: 'Switch new-ex', message: 'No management IP reported by Mist (offline?) — skipped.' },
      { where: 'Access points', message: '1 left out — Mist APs have no CLI. Tick "Include access points" to list them.' },
    ]);
  });

  it('lists APs when asked', () => {
    const r = mistDevicesToHosts(MIST_DEVICES, {}, { includeAps: true });
    const ap = r.hosts.find((h) => h.name === 'hq-ap-01');
    expect(ap).toMatchObject({ deviceType: 'mist', folder: undefined });
    expect(ap?.notes[0]).toMatch(/no CLI/);
  });

  it('fetches org devices with site names, and site-only scopes per site', async () => {
    const calls: string[] = [];
    const request: ApiRequest = async (_m, path) => {
      calls.push(path);
      if (path === '/api/v1/self') return { status: 200, body: MIST_SELF };
      if (path.startsWith('/api/v1/orgs/org-1/sites')) return { status: 200, body: MIST_SITES };
      if (path.startsWith('/api/v1/orgs/org-1/stats/devices')) return { status: 200, body: MIST_DEVICES };
      if (path.startsWith('/api/v1/sites/site-x/stats/devices')) {
        return { status: 200, body: [{ name: 'lab-ex', type: 'switch', model: 'EX2300-C', site_id: 'site-x', ip: '192.168.50.2' }] };
      }
      return { status: 404, body: { detail: 'not found' } };
    };
    const r = await fetchMistHosts(request, { includeAps: false });
    expect(calls).toEqual([
      '/api/v1/self',
      '/api/v1/orgs/org-1/sites?limit=1000',
      '/api/v1/orgs/org-1/stats/devices?type=all&limit=1000&page=1',
      '/api/v1/sites/site-x/stats/devices?type=all&limit=1000&page=1',
    ]);
    expect(r.hosts.map((h) => h.name)).toEqual(['hq-ex4100-1', 'b12-ex2300', 'b12-srx', 'hq-ssr', 'lab-ex']);
    expect(r.hosts[4].folder).toBe('Partner Lab');
  });

  it('explains a token without access', async () => {
    await expect(fetchMistHosts(async () => ({ status: 200, body: { privileges: [] } }), { includeAps: false })).rejects.toThrow(
      /no organization or site access/,
    );
    await expect(fetchMistHosts(async () => ({ status: 401, body: { detail: 'Invalid token.' } }), { includeAps: false })).rejects.toThrow(
      'Sign-in rejected (HTTP 401) — the token may have expired. Invalid token.',
    );
  });
});

describe('apiErrorText', () => {
  it('uses whatever detail field the API sent', () => {
    expect(apiErrorText(500, { message: 'boom' })).toBe('HTTP 500: boom');
    expect(apiErrorText(404, 'Not Found')).toBe('HTTP 404: Not Found');
    expect(apiErrorText(502, null)).toBe('HTTP 502');
  });
});

describe('preview helpers', () => {
  it('marks already-saved hosts and repeats within the batch', () => {
    const candidates = parseHostsCsv('name,host,user\na,Core-SW,admin\nb,10.0.0.2,\nc,10.0.0.2,\nd,10.0.0.2,ops\n').hosts;
    const saved = [{ protocol: 'ssh' as const, host: 'core-sw', port: 22, username: 'admin' }];
    expect(importStatuses(candidates, saved)).toEqual(['saved', 'new', 'duplicate', 'new']);
  });

  it('dedupes serial consoles by port and speed', () => {
    const serial = parseSecureCrtFiles([
      { path: 'a.ini', text: 'S:"Protocol Name"=Serial\nS:"Com Port"=COM3\nD:"Baud Rate"=00002580\n' },
      { path: 'b.ini', text: 'S:"Protocol Name"=Serial\nS:"Com Port"=COM3\nD:"Baud Rate"=0001c200\n' },
    ]).hosts;
    const saved = [{ protocol: 'serial' as const, serialPort: 'com3', baudRate: 9600 }];
    expect(importStatuses(serial, saved)).toEqual(['saved', 'new']);
  });

  it('picks the target folder by mode and reuses folders by name', () => {
    expect(targetFolder({ folder: 'HQ / Core' }, 'source', 'securecrt', '')).toBe('HQ / Core');
    expect(targetFolder({ folder: '' }, 'source', 'securecrt', '')).toBe('SecureCRT');
    expect(targetFolder({ folder: 'HQ' }, 'single', 'central', '  Campus ')).toBe('Campus');
    expect(targetFolder({ folder: 'HQ' }, 'single', 'central', '')).toBe('Aruba Central');
    expect(findFolderId([{ id: 'f1', name: 'Aruba Central' }], 'aruba central ')).toBe('f1');
    expect(findFolderId([{ id: 'f1', name: 'Aruba Central' }], 'Mist')).toBeUndefined();
  });

  it('builds a saved host with no password and only protocol-relevant fields', () => {
    const [serial] = parseSecureCrtFiles([
      { path: 'c.ini', text: 'S:"Protocol Name"=Serial\nS:"Com Port"=COM4\nD:"Baud Rate"=00002580\n' },
    ]).hosts;
    const cfg = candidateToConfig(serial, 'id-1');
    expect(cfg).toMatchObject({ id: 'id-1', protocol: 'serial', serialPort: 'COM4', baudRate: 9600, host: undefined, authType: 'password' });
    expect(cfg.password).toBeUndefined();

    const [ssh] = parseHostsCsv('host,tags,jump\n10.0.0.1,a;b; a ,ops@jump:2200\n').hosts;
    expect(candidateToConfig(ssh, 'id-2')).toMatchObject({ tags: ['a', 'b'], jumpHost: 'jump', jumpPort: 2200, jumpUsername: 'ops' });
  });
});
