import { describe, expect, it } from 'vitest';
import { DEFAULT_COMMUNITY_HINT, MAX_LINE_CHARS, defaultCommunityHint, scrubForAi, scrubJsonForAi } from './engine';

const HIDDEN = '<secret hidden>';

describe('scrubForAi', () => {
  it('runs the device, address, KEY=VALUE and prose rules in one pass', () => {
    const text = [
      'radius-server host 10.1.1.10 key plaintext RadKeyCX vrf mgmt',
      'syslog: https://bot:Hunter22x@logs.example.com/in',
      'DB_PASSWORD=hunter2hunter2',
      'lab login: admin / Adm1n!x',
    ].join('\n');
    const result = scrubForAi(text);
    for (const secret of ['RadKeyCX', 'Hunter22x', 'hunter2hunter2', 'Adm1n!x']) expect(result.text).not.toContain(secret);
    expect(result.hidden).toBe(4);
  });

  it('leaves text without secrets as it is', () => {
    const text = 'Interface 1/1/1 is up\nVLAN 10 name users\n';
    expect(scrubForAi(text)).toEqual({ text, hidden: 0, kinds: [] });
  });

  it('hides a line too long to check, whole, and quickly', () => {
    const line = 'tokentoken'.repeat(MAX_LINE_CHARS);
    const started = performance.now();
    const result = scrubForAi(`hostname sw1\n${line}\nvlan 10`);
    expect(performance.now() - started).toBeLessThan(200);
    expect(result.text).toBe('hostname sw1\n<line hidden: secret>\nvlan 10');
    expect(result.hidden).toBe(1);
  });

  it('checks the line after a pager prompt the device erased with backspaces', () => {
    for (const prompt of [
      '--More-- (q) quit (u) pageup (/) search (n) repeat',
      '-- MORE --, next page: Space, next line: Enter, quit: Control-C',
      '---(more 42%)---',
    ]) {
      const result = scrubForAi(`${prompt}          mgmt-user admin root 2f8e3a1bc0de9a8f7e6d5c4b3a291807`);
      expect([prompt, result.text.includes('2f8e3a1bc0de9a8f7e6d5c4b3a291807')]).toEqual([prompt, false]);
    }
  });

  describe('text that starts inside a block (cutHead)', () => {
    it('hides a RADIUS key whose aaa authentication-server line was cut off', () => {
      const page = '   host 10.1.1.20\n   key RadKeyAOS8\n!\nhostname ctrl1';
      expect(scrubForAi(page).text).toContain('RadKeyAOS8'); // why cutHead exists
      const result = scrubForAi(page, { cutHead: true });
      expect(result.text).toBe(`   host 10.1.1.20\n   key ${HIDDEN}\n!\nhostname ctrl1`);
      expect(result.hidden).toBe(1);
    });

    it('hides a Junos community inside a cut-off snmp { }, and stops at the end of that block', () => {
      const page = [
        '        authorization read-only;',
        '    }',
        '    community s3cretComm {',
        '        authorization read-only;',
        '    }',
        '}',
        'policy-options {',
        '    community MY-BGP members 65000:100;',
        '}',
      ].join('\n');
      const text = scrubForAi(page, { cutHead: true }).text;
      expect(text).toContain(`    community ${HIDDEN} {`);
      expect(text).toContain('    community MY-BGP members 65000:100;');
    });

    it('hides the body of a private key whose BEGIN line was cut off', () => {
      const page = 'b3BlbnNzaC1rZXktdjEAAAA\nAAAABG5vbmUAAAAEbm9uZQ\n-----END OPENSSH PRIVATE KEY-----\nsw1# ';
      expect(scrubForAi(page).text).toContain('b3BlbnNzaC1rZXktdjEAAAA'); // why cutHead exists
      const result = scrubForAi(page, { cutHead: true });
      expect(result.text).toBe(`${HIDDEN}\n${HIDDEN}\n-----END OPENSSH PRIVATE KEY-----\nsw1# `);
      expect(result.kinds).toEqual(['private-key']);
    });

    it('returns the text unchanged when nothing was hidden', () => {
      const page = '    no shutdown\n    vlan access 10\nexit';
      expect(scrubForAi(page, { cutHead: true }).text).toBe(page);
    });
  });
});

describe('scrubJsonForAi', () => {
  it('hides AOS-CX REST secrets by key name and keeps the rest', () => {
    const result = scrubJsonForAi({
      'radius_servers': { '10.1.1.10,1812': { passkey: 'AQBapRadius==', port: 1812 } },
      snmp_communities: ['public', 'Priv@te-rw'],
      hostname: 'core-cx',
    });
    expect(result.value).toEqual({
      'radius_servers': { '10.1.1.10,1812': { passkey: HIDDEN, port: 1812 } },
      snmp_communities: [HIDDEN, HIDDEN],
      hostname: 'core-cx',
    });
    expect(result.hidden).toBe(3);
  });
});

describe('defaultCommunityHint', () => {
  it('says when public or private is set, never which one', () => {
    for (const line of ['snmp-server community public', 'snmp-server community "private" unrestricted', 'set snmp community public authorization read-only', '    community public {']) {
      expect([line, defaultCommunityHint(line)]).toEqual([line, DEFAULT_COMMUNITY_HINT]);
    }
    for (const line of ['snmp-server community N0tDefault', 'snmp-server community publicity', 'show snmp community']) {
      expect([line, defaultCommunityHint(line)]).toEqual([line, undefined]);
    }
  });
});
