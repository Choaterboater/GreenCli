import { describe, expect, it } from 'vitest';
import { configSymbols } from './configSymbols';

const list = (text: string, language: string) => configSymbols(text, language).map((s) => [s.name, s.kind, s.line, s.endLine]);

describe('configSymbols', () => {
  it('lists Aruba CX blocks with the lines they span', () => {
    const text = [
      'hostname core-sw1',
      '! uplinks',
      'vlan 20',
      '    name users',
      'interface lag 1',
      '    lacp mode active',
      'interface 1/1/1',
      '    description uplink',
      '    lag 1',
      'interface vlan 20',
      '    ip address 10.20.0.1/24',
      'router ospf 1',
      '    area 0',
      'ip route 0.0.0.0/0 10.0.0.1',
    ].join('\n');
    expect(list(text, 'aruba-cx')).toEqual([
      ['vlan 20', 'vlan', 3, 4],
      ['interface lag 1', 'lag', 5, 6],
      ['interface 1/1/1', 'interface', 7, 9],
      ['interface vlan 20', 'vlan', 10, 11],
      ['router ospf 1', 'routing', 12, 13],
    ]);
  });

  it('keeps a bare "vlan 30" and an AOS-S block ending in exit', () => {
    expect(list('vlan 30\nvlan 40\n   name "voice"\n   exit\n', 'aruba-aos-s')).toEqual([
      ['vlan 30', 'vlan', 1, 1],
      ['vlan 40', 'vlan', 2, 4],
    ]);
  });

  it('groups Junos set lines by interface, VLAN and section', () => {
    const text = [
      'set system host-name ex1',
      'set interfaces ge-0/0/1 description uplink',
      'set vlans users vlan-id 20',
      'set interfaces ge-0/0/1 unit 0 family ethernet-switching interface-mode trunk',
      'set interfaces ae0 aggregated-ether-options lacp active',
      'set protocols rstp interface all',
      'set system ntp server 10.1.1.1',
    ].join('\n');
    expect(list(text, 'juniper-junos')).toEqual([
      ['system', 'section', 1, 7],
      ['interfaces ge-0/0/1', 'interface', 2, 4],
      ['vlans users', 'vlan', 3, 3],
      ['interfaces ae0', 'lag', 5, 5],
      ['protocols rstp', 'routing', 6, 6],
    ]);
  });

  it('reads Junos brace style to each closing brace', () => {
    const text = [
      'system {',
      '    host-name ex1;',
      '}',
      'interfaces {',
      '    ge-0/0/1 {',
      '        unit 0 {',
      '            family ethernet-switching;',
      '        }',
      '    }',
      '    /* lab */',
      '    irb {',
      '        unit 20;',
      '    }',
      '}',
      'vlans {',
      '    users {',
      '        vlan-id 20;',
      '    }',
      '}',
    ].join('\n');
    expect(list(text, 'mist')).toEqual([
      ['system', 'section', 1, 3],
      ['interfaces', 'interface', 4, 14],
      ['interfaces ge-0/0/1', 'interface', 5, 9],
      ['interfaces irb', 'vlan', 11, 13],
      ['vlans', 'vlan', 15, 19],
      ['vlans users', 'vlan', 16, 18],
    ]);
  });

  it('finds nothing in an empty tab', () => {
    expect(configSymbols('', 'aruba-cx')).toEqual([]);
  });
});
