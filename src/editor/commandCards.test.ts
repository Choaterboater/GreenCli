import { describe, expect, it } from 'vitest';
import { COMMAND_CARDS, cardForLine, cardMarkdown } from './commandCards';

describe('command cards', () => {
  it('recognize their own examples, on both vendors', () => {
    // Header lines on a card ("interface 1/1/5" above "vlan access 20") are the
    // interface card's, and "commit" after "commit confirmed" is the save card's.
    const headers: Record<string, string> = { 'interface 1/1/5': 'interface', 'interface 1/1/49': 'interface', commit: 'save' };
    for (const card of COMMAND_CARDS) {
      for (const [language, lines] of [['aruba-cx', card.cx], ['juniper-junos', card.junos]] as const) {
        const ids = lines.map((line) => cardForLine(line, language)?.id);
        expect(ids, `${card.id} on ${language}`).toContain(card.id);
        lines.forEach((line, i) => {
          const allowed = [card.id, undefined, headers[line.trim()]];
          expect(allowed, `${card.id}: "${line}" on ${language} was ${ids[i]}`).toContain(ids[i]);
        });
      }
    }
  });

  it('reads Junos brace-style lines too', () => {
    expect(cardForLine('        vlan-id 20;', 'juniper-junos')?.id).toBe('vlan');
    expect(cardForLine('    host-name core-sw1;', 'juniper-junos')?.id).toBe('hostname');
    expect(cardForLine('                    interface-mode trunk;', 'mist')?.id).toBe('trunk');
    expect(cardForLine('    ae0 {', 'juniper-junos')?.id).toBe('lag');
  });

  it('tells a trunk member list from an access VLAN', () => {
    expect(cardForLine('set interfaces ge-0/0/1 unit 0 family ethernet-switching vlan members [ a b ]', 'juniper-junos')?.id).toBe('trunk');
    expect(cardForLine('set interfaces ge-0/0/5 unit 0 family ethernet-switching vlan members users', 'juniper-junos')?.id).toBe('access');
  });

  it('stays quiet on comments, unknown lines and other languages', () => {
    expect(cardForLine('! vlan 20', 'aruba-cx')).toBeUndefined();
    expect(cardForLine('# set vlans a vlan-id 1', 'juniper-junos')).toBeUndefined();
    expect(cardForLine('    name users', 'aruba-cx')).toBeUndefined();
    expect(cardForLine('vlan 20', 'aruba-aos-s')).toBeUndefined();
    expect(cardForLine('vlan 20', 'python')).toBeUndefined();
  });

  it("shows this vendor's way first, then the other's", () => {
    const card = cardForLine('vlan 20', 'aruba-cx')!;
    const cx = cardMarkdown(card, 'aruba-cx');
    expect(cx.indexOf('**Aruba CX**')).toBeLessThan(cx.indexOf('**Junos**'));
    expect(cx).toContain('set vlans users vlan-id 20');
    const junos = cardMarkdown(card, 'juniper-junos');
    expect(junos.indexOf('**Junos**')).toBeLessThan(junos.indexOf('**Aruba CX**'));
    expect(junos.startsWith('**VLAN**: ')).toBe(true);
  });
});
