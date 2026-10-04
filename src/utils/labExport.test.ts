import { describe, it, expect } from 'vitest';
import { isIP } from 'node:net';
import { buildLabExport, labEntryFor, LAB_EXPORT_FILE_NAME } from './labExport';
import type { ConnectionConfig, SessionFolder } from '../types';

// ─── Casper's rules, ported for the test only ───
// A copy of Casper src/network/spec.ts labEntry/parseLabSettings and src/network/lab-import.ts parseLabFile.
// Keep in step with Casper: every file GreenCLI writes must pass these, or Casper refuses the whole file.
const CASPER_HOSTNAME = /^[a-z0-9_]([a-z0-9_.-]{0,252})$/i;
function casperLabEntry(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('expected a hostname, an IP address or a range');
  const text = value.trim();
  const slash = text.indexOf('/');
  if (slash >= 0) {
    const address = text.slice(0, slash);
    const bits = text.slice(slash + 1);
    const family = isIP(address);
    const max = family === 4 ? 32 : 128;
    if (!family || !/^\d{1,3}$/.test(bits) || Number(bits) > max) throw new Error(`${text} is not an IP range`);
    return text.toLowerCase();
  }
  if (isIP(text)) return text.toLowerCase();
  if (/[*?[\]]/.test(text)) throw new Error(`${text}: no wildcards`);
  if (!CASPER_HOSTNAME.test(text)) throw new Error(`${text} is not a hostname, an IP address or an IP range`);
  return text.toLowerCase();
}
function casperParseLabFile(text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{')) throw new Error('GreenCLI always writes JSON');
  const hosts = (JSON.parse(trimmed) as { hosts?: unknown }).hosts;
  if (!Array.isArray(hosts)) throw new Error('expected {"hosts": [...]}');
  if (hosts.length > 1024) throw new Error('at most 1024 entries');
  const out = [...new Set(hosts.map(casperLabEntry))];
  if (!out.length) throw new Error('the file lists no hosts');
  return out;
}

let n = 0;
function host(over: Partial<ConnectionConfig>): ConnectionConfig {
  n += 1;
  return { id: `h${n}`, name: `host${n}`, protocol: 'ssh', deviceType: 'generic', tags: ['lab'], ...over } as ConnectionConfig;
}
const folder = (items: ConnectionConfig[], id = 'f1'): SessionFolder => ({ id, name: id, items, expanded: true });

describe('labEntryFor (Casper labEntry rules)', () => {
  // Parity table: cases from Casper tests/lab-import.test.ts and spec.ts labEntry.
  // Ranges (10.99.0.0/24) are n/a: a saved host is one address.
  const accepted: [string, string][] = [
    ['lab-sw1', 'lab-sw1'],
    ['10.99.0.11', '10.99.0.11'],
    ['2001:db8::1', '2001:db8::1'],
    ['[2001:DB8::1]', '2001:db8::1'],
    ['SW1.Example.COM.', 'sw1.example.com'],
    ['  core-sw01.lab  ', 'core-sw01.lab'],
    // Casper takes these as names (isIP says no, the hostname rule says yes). Harmless, kept as Casper does.
    ['010.1.1.1', '010.1.1.1'],
    ['10.99.0.256', '10.99.0.256'],
  ];
  it.each(accepted)('%s is exported as %s, and Casper accepts it', (input, entry) => {
    const r = labEntryFor(input);
    expect(r).toMatchObject({ entry });
    expect(casperLabEntry(entry)).toBe(entry);
  });

  const skipped: [string, RegExp][] = [
    ['lab sw1 with spaces', /not an address or name/],
    ['sw?', /wildcard/],
    ['sw*', /wildcard/],
    ['fe80::1%en0', /zone/],
    ['admin@sw1', /not an address or name/],
    ['10.99.0.11:22', /not an address or name/],
    ['', /no address/],
    ['   ', /no address/],
    ['::1]/x[', /wildcard/], // not taken as IPv6 through the URL check
  ];
  it.each(skipped)('%j is skipped (%s)', (input, reason) => {
    const r = labEntryFor(input);
    expect(r).toHaveProperty('skip');
    expect((r as { skip: string }).skip).toMatch(reason);
  });

  it('flags one-word names, not dotted names or IPs', () => {
    expect(labEntryFor('core1')).toMatchObject({ entry: 'core1', shortName: true });
    expect(labEntryFor('sw1.lab.example.com')).toMatchObject({ shortName: false });
    expect(labEntryFor('10.99.0.11')).toMatchObject({ shortName: false });
    expect(labEntryFor('2001:db8::1')).toMatchObject({ shortName: false });
  });
});

describe('buildLabExport', () => {
  it('exports only hosts tagged lab, in any spelling', () => {
    const r = buildLabExport([
      folder([
        host({ host: '10.0.0.1', tags: ['lab'] }),
        host({ host: '10.0.0.2', tags: ['Lab'] }),
        host({ host: '10.0.0.3', tags: [' LAB ', 'core'] }),
        host({ host: '10.0.0.4', tags: ['core'] }),
        host({ host: '10.0.0.5', tags: [] }),
        host({ host: '10.0.0.6', tags: undefined }),
        host({ host: '10.0.0.7', tags: ['laboratory'] }),
      ]),
    ]);
    expect(r.hosts).toEqual(['10.0.0.1', '10.0.0.2', '10.0.0.3']);
  });

  it('uses the address, never the name', () => {
    const r = buildLabExport([folder([host({ name: 'lab-sw, rack 4', host: '10.99.0.11' })])]);
    expect(r.hosts).toEqual(['10.99.0.11']);
    expect(r.text).not.toContain('rack 4');
  });

  it('writes exactly {"hosts": [...]} that Casper reads as JSON', () => {
    const r = buildLabExport([folder([host({ host: '10.99.0.11' }), host({ host: 'lab-sw1.example.com' })])]);
    expect(r.text).toBe('{\n  "hosts": [\n    "10.99.0.11",\n    "lab-sw1.example.com"\n  ]\n}\n');
    expect(LAB_EXPORT_FILE_NAME).toBe('casper-lab.json');
  });

  it('removes brackets, trailing dots and repeats across folders', () => {
    const r = buildLabExport([
      folder([host({ host: '[2001:db8::1]' }), host({ host: 'SW1.Example.COM.' })], 'a'),
      folder([host({ host: '2001:DB8::1' }), host({ host: 'sw1.example.com' })], 'b'),
    ]);
    expect(r.hosts).toEqual(['2001:db8::1', 'sw1.example.com']);
  });

  it('skips what Casper would refuse, with plain reasons, and never writes it', () => {
    const r = buildLabExport([
      folder([
        host({ name: 'zone', host: 'fe80::1%en0' }),
        host({ name: 'spaced', host: 'lab sw1' }),
        host({ name: 'login', host: 'admin@sw1' }),
        host({ name: 'wild', host: 'sw*' }),
        host({ name: 'blank', host: '' }),
        host({ name: 'unset' }),
        host({ name: 'lab-console', protocol: 'serial', serialPort: '/dev/tty.usb' }),
        host({ name: 'shell', protocol: 'local', host: 'localhost' }),
        host({ name: 'legacy', host: '10.99.0.11:22' }),
        host({ name: 'ok', host: '10.99.0.12' }),
      ]),
    ]);
    expect(r.hosts).toEqual(['10.99.0.12']);
    const reasons = Object.fromEntries(r.skipped.map((s) => [s.name, s.reason]));
    expect(reasons['zone']).toMatch(/zone/);
    expect(reasons['wild']).toMatch(/wildcard/);
    expect(reasons['lab-console']).toMatch(/serial, no network address/);
    expect(reasons['shell']).toMatch(/no network address/);
    expect(reasons['blank']).toMatch(/no address/);
    expect(Object.keys(reasons).sort()).toEqual(
      ['blank', 'lab-console', 'legacy', 'login', 'shell', 'spaced', 'unset', 'wild', 'zone'].sort(),
    );
    for (const bad of ['fe80', 'lab sw1', 'admin', 'sw*', '10.99.0.11:22', 'tty', 'localhost']) expect(r.text).not.toContain(bad);
  });

  it('never writes a login, password, key, port or jump host', () => {
    const r = buildLabExport([
      folder([
        host({
          host: '10.99.0.11',
          port: 2222,
          username: 'netadmin',
          password: 'pw-SECRET-1',
          privateKey: '-----BEGIN KEY-----',
          keyPath: '/Users/me/.ssh/id_lab',
          keyPassphrase: 'pp-SECRET-2',
          jumpHost: 'bastion.example.com',
          jumpPort: 2200,
          jumpUsername: 'jumper',
          jumpPassword: 'jp-SECRET-3',
        }),
      ]),
    ]);
    for (const v of ['2222', 'netadmin', 'SECRET', 'BEGIN', 'id_lab', 'bastion', '2200', 'jumper']) expect(r.text).not.toContain(v);
  });

  it('stops at 1024, as Casper does, and reports the rest', () => {
    const items = Array.from({ length: 1030 }, (_, i) => host({ name: `sw${i}`, host: `10.1.${Math.floor(i / 256)}.${i % 256}` }));
    const r = buildLabExport([folder(items)]);
    expect(r.hosts).toHaveLength(1024);
    expect(r.skipped).toHaveLength(6);
    expect(r.skipped[0].reason).toMatch(/at most 1024/);
  });

  it('lists one-word names so the person sees them', () => {
    const r = buildLabExport([folder([host({ host: 'core1' }), host({ host: 'sw1.lab.example.com' }), host({ host: '10.0.0.1' })])]);
    expect(r.hosts).toEqual(['core1', 'sw1.lab.example.com', '10.0.0.1']);
    expect(r.shortNames).toEqual(['core1']);
  });

  it('round trip: every exported file passes Casper\'s lab file rules unchanged', () => {
    const inputs = [
      'lab-sw1', '10.99.0.11', '2001:db8::1', '[2001:DB8::2]', 'SW1.Example.COM.', '010.1.1.1', '10.99.0.256', 'core1',
      'fe80::1%en0', 'lab sw1', 'admin@sw1', 'sw*', 'sw?', 'a[1]', '10.99.0.11:22', '', 'x'.repeat(300), '-lead', '::1]/x[',
      'under_score.lab', 'Mixed.Case.', '::ffff:10.0.0.1',
    ];
    const r = buildLabExport([folder(inputs.map((h) => host({ host: h })))]);
    expect(r.hosts.length).toBeGreaterThan(0);
    expect(casperParseLabFile(r.text)).toEqual(r.hosts);
  });

  it('with no lab hosts, the list is empty', () => {
    const r = buildLabExport([folder([host({ host: '10.0.0.1', tags: ['core'] })])]);
    expect(r.hosts).toEqual([]);
  });
});
