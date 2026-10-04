import { describe, expect, it } from 'vitest';
import { CONFIG_TEMPLATES, templateByLabel } from './templates';
import { buildProblems, NETWORK_LANGUAGES } from '../utils/configProblems';
import { prepareSendLines } from '../utils/configSafety';
import {
  buildDevicePlan,
  DEFAULT_JOB_OPTIONS,
  findVariables,
  jobBlockFromEditor,
  parseVariableTable,
  toCsv,
  vendorSteps,
} from '../utils/changeJobs';
import type { DeviceType } from '../types';

const JUNOS = ['juniper-junos', 'mist'];
const sendLines = (body: string) => prepareSendLines(body).map((l) => l.text);
const blanks = (body: string) => findVariables(body);
/** Every blank filled with a value that looks like what goes there. */
const dummy = (name: string) => (/asn/.test(name) ? '65010' : /ip|id$|lo0/.test(name) ? '10.9.9.9' : `x-${name}`);
const filled = (body: string) => body.replace(/\$\{([^}]+)\}/g, (_, name: string) => dummy(name));

describe('config templates', () => {
  it('each opens in a device config language', () => {
    for (const t of CONFIG_TEMPLATES) expect([t.label, NETWORK_LANGUAGES.has(t.language)]).toEqual([t.label, true]);
  });

  it('opens each vendor in its own language (no guessing from the name)', () => {
    const language = (start: string) => [...new Set(CONFIG_TEMPLATES.filter((t) => t.label.startsWith(start)).map((t) => t.language))];
    expect(language('AOS-CX:')).toEqual(['aruba-cx']);
    expect(language('AOS-S:')).toEqual(['aruba-aos-s']);
    expect(language('Aruba AP:')).toEqual(['aruba-ap']);
    expect(language('AOS8:')).toEqual(['aruba-controller']);
    expect(language('Junos:')).toEqual(['juniper-junos']);
    expect(language('JVD:')).toEqual(['juniper-junos']);
    expect(language('Mist')).toEqual(['mist']);
    expect(CONFIG_TEMPLATES.some((t) => t.label.startsWith('Aruba:'))).toBe(false);
  });

  it('has unique labels, found by label', () => {
    expect(new Set(CONFIG_TEMPLATES.map((t) => t.label)).size).toBe(CONFIG_TEMPLATES.length);
    expect(templateByLabel('Junos: OSPF')?.language).toBe('juniper-junos');
    expect(templateByLabel('nope')).toBeUndefined();
  });

  it('uses only ${name} blanks: no <name> style and no made-up secret', () => {
    for (const t of CONFIG_TEMPLATES) {
      expect([t.label, /<[^<>\n]{2,}>/.test(t.body.replace(/\/\*[\s\S]*?\*\//g, ''))]).toEqual([t.label, false]);
      expect([t.label, /MySecret|replace-me/i.test(t.body)]).toEqual([t.label, false]);
    }
  });

  it('flags its blanks in Problems until they are filled', () => {
    for (const t of CONFIG_TEMPLATES) {
      if (!blanks(t.body).length) continue;
      const codes = buildProblems(t.body, t.language).map((p) => p.code);
      expect([t.label, codes.includes('placeholder')]).toEqual([t.label, true]);
    }
  });

  it('once filled, has nothing risky and no blank left (a plaintext key or the Junos commit tip are fine)', () => {
    for (const t of CONFIG_TEMPLATES) {
      const codes = buildProblems(filled(t.body), t.language).map((p) => p.code);
      const unexpected = codes.filter((c) => c !== 'plaintext-secret' && c !== 'junos-commit');
      expect([t.label, unexpected]).toEqual([t.label, []]);
    }
  });

  it('never saves or commits by itself: Send safely or a comment says how', () => {
    for (const t of CONFIG_TEMPLATES) {
      const lines = sendLines(t.body);
      expect([t.label, lines.some((l) => /^write\s+mem/i.test(l))]).toEqual([t.label, false]);
      if (JUNOS.includes(t.language)) {
        expect([t.label, lines.some((l) => /^commit\b/i.test(l))]).toEqual([t.label, false]);
        expect([t.label, t.body]).toEqual([t.label, expect.stringContaining('Send safely')]);
      }
      if (t.language === 'aruba-cx') {
        expect([t.label, t.body]).toEqual([t.label, expect.stringContaining('! Use Send safely (rollback timer, saves after confirm).')]);
      }
      if (t.language === 'aruba-aos-s') {
        expect([t.label, t.body]).toEqual([t.label, expect.stringContaining('! AOS-S has no rollback timer')]);
      }
      if (t.language === 'aruba-ap') {
        expect([t.label, lines.some((l) => /^commit\s+apply/i.test(l))]).toEqual([t.label, false]);
        expect([t.label, t.body]).toEqual([t.label, expect.stringContaining('! Plain Send: finish with commit apply')]);
      }
    }
  });

  it('turns each blank into a per-device value in Send safely, and plans cleanly once filled', () => {
    for (const t of CONFIG_TEMPLATES) {
      const deviceType = t.language as DeviceType;
      const { block } = jobBlockFromEditor(t.body, deviceType);
      const names = blanks(block);
      const device = { name: 'sw1', host: '10.0.0.1', deviceType };
      const base = { block, preChecks: '', postChecks: '', device, options: DEFAULT_JOB_OPTIONS };

      if (names.length) {
        const empty = parseVariableTable(toCsv([['device', 'unrelated'], ['sw1', 'x']]));
        const errors = buildDevicePlan({ ...base, table: empty }).errors.join('\n');
        for (const name of names) expect([t.label, errors]).toEqual([t.label, expect.stringContaining(`\${${name}}`)]);
      }

      const table = names.length ? parseVariableTable(toCsv([['device', ...names], ['sw1', ...names.map(dummy)]])) : null;
      const plan = buildDevicePlan({ ...base, table });
      expect([t.label, plan.errors]).toEqual([t.label, []]);
      expect([t.label, plan.change.some((l) => l.fromBlock && l.dangerous)]).toEqual([t.label, false]);
    }
  });

  it('promises a rollback timer only where Send safely has one', () => {
    for (const t of CONFIG_TEMPLATES) {
      if (vendorSteps(t.language as DeviceType).wrapper !== 'none') continue;
      const promised = t.body.replace(/no rollback timer/gi, '').match(/rollback timer/i);
      expect([t.label, promised]).toEqual([t.label, null]);
    }
  });

  it('RADIUS login: test a second SSH login before confirming or saving (Send safely cannot catch it)', () => {
    const body = templateByLabel('AOS-CX: AAA / RADIUS')!.body;
    expect(body).not.toMatch(/Send safely: a wrong key/);
    expect(body).toMatch(/open a second SSH login/);
  });

  describe('fixes that must not come back', () => {
    const junos = CONFIG_TEMPLATES.filter((t) => JUNOS.includes(t.language));

    it('puts no routing on AOS-CX ports that carry VLANs', () => {
      for (const t of CONFIG_TEMPLATES.filter((x) => x.language === 'aruba-cx' && /vlan (?:access|trunk)/.test(x.body))) {
        expect([t.label, /^\s+no routing$/m.test(t.body)]).toEqual([t.label, true]);
      }
    });

    it('AOS-CX OSPF runs on a routed uplink and a loopback, not the management VLAN', () => {
      const body = templateByLabel('AOS-CX: OSPF')!.body;
      expect(body).not.toMatch(/interface vlan/);
      expect(body).toMatch(/interface \$\{uplink\}\n\s+no shutdown\n\s+routing\n/);
      expect(body).toMatch(/interface loopback 0/);
    });

    it('AOS-CX RADIUS is one-line, uses a VRF and has no command authorization', () => {
      const body = templateByLabel('AOS-CX: AAA / RADIUS')!.body;
      expect(body).toContain('radius-server host ${radius_ip} key plaintext ${radius_key} vrf ${vrf}');
      expect(body).not.toMatch(/aaa authorization commands/);
      expect(body).toMatch(/can lock you out/);
    });

    it('AOS8 WLAN has a passphrase, a node and an AP group', () => {
      const body = templateByLabel('AOS8: AP group WLAN')!.body;
      expect(body).toContain('cd ${node_path}');
      expect(body).toContain('wpa-passphrase ${wpa_passphrase}');
      expect(body).toMatch(/ap-group \$\{ap_group\}\n\s+virtual-ap Example-VAP/);
    });

    it('Junos OSPF has a router id and runs on a routed interface', () => {
      const body = templateByLabel('Junos: OSPF')!.body;
      expect(body).toContain('set routing-options router-id ${router_id}');
      expect(body).toContain('set interfaces ${uplink} unit 0 family inet address ${p2p_ip_cidr}');
      expect(body).not.toMatch(/irb\.10/);
    });

    it('Junos BGP sets a router id', () => {
      expect(templateByLabel('Junos: BGP peer')!.body).toContain('set routing-options router-id ${router_id}');
    });

    it('no cluster in an external BGP group', () => {
      for (const t of junos) {
        const external = [...t.body.matchAll(/group (\S+) type external/g)].map((m) => m[1]);
        for (const group of external) expect([t.label, t.body.includes(`group ${group} cluster`)]).toEqual([t.label, false]);
      }
    });

    it('every export names a policy that is defined', () => {
      for (const t of junos) {
        for (const [, policy] of t.body.matchAll(/ export (\S+)/g)) {
          expect([t.label, t.body.includes(`policy-statement ${policy} `)]).toEqual([t.label, true]);
        }
      }
    });

    it('a VTEP has a route distinguisher, a VRF target, a loopback, the VNI list and an AS', () => {
      for (const t of junos.filter((x) => x.body.includes('vtep-source-interface'))) {
        for (const needed of [
          'set switch-options route-distinguisher',
          'set switch-options vrf-target',
          'set interfaces lo0 unit 0 family inet address',
          'set protocols evpn extended-vni-list all',
          'set routing-options autonomous-system',
        ]) {
          expect([t.label, t.body.includes(needed)]).toEqual([t.label, true]);
        }
      }
    });

    it('an EVPN template without an IRB is called a bridged overlay and has no gateway lines', () => {
      for (const t of junos.filter((x) => x.body.includes('vtep-source-interface') && !/interfaces irb /.test(x.body))) {
        expect([t.label, /ERB|edge-routed/i.test(t.label + t.body)]).toEqual([t.label, false]);
        expect([t.label, t.body.includes('default-gateway')]).toEqual([t.label, false]);
      }
      expect(templateByLabel('JVD: EVPN-VXLAN leaf (bridged overlay)')).toBeTruthy();
    });

    it('a BGP template has an AS for its groups', () => {
      for (const t of junos.filter((x) => x.body.includes('protocols bgp'))) {
        expect([t.label, /set routing-options autonomous-system|local-as/.test(t.body)]).toEqual([t.label, true]);
      }
    });

    it('the spine overlay keeps next hops (multihop no-nexthop-change)', () => {
      const body = templateByLabel('JVD: EVPN-VXLAN spine (eBGP)')!.body;
      expect(body).toContain('set protocols bgp group OVERLAY multihop no-nexthop-change');
      expect(body).toContain('set protocols bgp group UNDERLAY export LO0');
    });

    it('a LAG has members, LACP and an aggregated-devices count', () => {
      for (const t of junos.filter((x) => /interfaces ae\d/.test(x.body))) {
        expect([t.label, /ether-options 802\.3ad ae\d/.test(t.body)]).toEqual([t.label, true]);
        expect([t.label, /aggregated-ether-options lacp active/.test(t.body)]).toEqual([t.label, true]);
        expect([t.label, /chassis aggregated-devices ethernet device-count/.test(t.body)]).toEqual([t.label, true]);
      }
    });

    it('RoCE PFC is keyed on DSCP and ECN sits on a scheduler that is applied', () => {
      const body = templateByLabel('JVD: AI fabric RoCE QoS (PFC+ECN)')!.body;
      expect(body).toContain('congestion-notification-profile CNP input dscp code-point 011010 pfc');
      expect(body).not.toMatch(/ieee-802\.1/);
      expect(body).not.toMatch(/forwarding-classes class NO-LOSS explicit-congestion-notification/);
      expect(body).toContain('set class-of-service schedulers SCH-NOLOSS explicit-congestion-notification');
      expect(body).toContain('drop-profile ECN-DP');
      expect(body).toMatch(/interfaces \$\{interface\} scheduler-map SM-AI/);
    });

    it('the Mist baseline says Mist overwrites local changes', () => {
      expect(templateByLabel('Mist/Junos: access switch baseline')!.body).toMatch(/Mist overwrites/);
    });

    it('JVD RoCE QoS schedules every class it uses, so RoCE cannot starve BGP', () => {
      const body = templateByLabel('JVD: AI fabric RoCE QoS (PFC+ECN)')!.body;
      for (const fc of ['NO-LOSS', 'best-effort', 'network-control']) {
        const m = body.match(new RegExp(`scheduler-maps SM-AI forwarding-class ${fc} scheduler (\\S+)`));
        expect([fc, !!m]).toEqual([fc, true]);
        expect([fc, body]).toEqual([fc, expect.stringMatching(new RegExp(`schedulers ${m![1]} transmit-rate `))]);
        expect([fc, body]).toEqual([fc, expect.stringMatching(new RegExp(`schedulers ${m![1]} buffer-size `))]);
      }
      // BGP (DSCP 48) still lands in network-control under the custom classifier.
      expect(body).toContain('classifiers dscp ROCE forwarding-class network-control loss-priority low code-points 110000');
    });
  });
});
