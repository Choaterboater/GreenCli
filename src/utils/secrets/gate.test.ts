import { describe, expect, it } from 'vitest';
import { HIDDEN_SECRET_REFUSAL, hiddenSecretGate } from './gate';
import { LINE_MARKER, SECRET_MARKER } from './markers';
import * as scrub from './scrub';

describe('hiddenSecretGate', () => {
  it('refuses a terminal command that sends the marker back', () => {
    expect(hiddenSecretGate({ command: `radius-server host 10.1.1.10 key plaintext ${SECRET_MARKER}` })).toBe(HIDDEN_SECRET_REFUSAL);
    expect(hiddenSecretGate({ command: `configure\n${LINE_MARKER}` })).toBe(HIDDEN_SECRET_REFUSAL);
  });

  it('refuses a REST body that carries it', () => {
    expect(hiddenSecretGate({ method: 'PUT', path: '/rest/v10.09/system/vrfs/mgmt/radius_servers/10.1.1.10,1812', body: `{"passkey":"${SECRET_MARKER}"}` })).toBe(
      HIDDEN_SECRET_REFUSAL
    );
  });

  it('finds it in nested MCP arguments, in keys too, and in other spacing or case', () => {
    expect(hiddenSecretGate({ device: 'sw1', changes: [{ lines: ['set snmp community x', { value: SECRET_MARKER }] }] })).toBe(HIDDEN_SECRET_REFUSAL);
    expect(hiddenSecretGate({ [SECRET_MARKER]: 'x' })).toBe(HIDDEN_SECRET_REFUSAL);
    expect(hiddenSecretGate({ command: 'username admin password <Secret  Hidden>' })).toBe(HIDDEN_SECRET_REFUSAL);
    expect(hiddenSecretGate({ command: '< line hidden : secret >' })).toBe(HIDDEN_SECRET_REFUSAL);
  });

  it('refuses arguments nested too deep to check', () => {
    let deep: unknown = 'show version';
    for (let i = 0; i < 80; i++) deep = { next: deep };
    expect(hiddenSecretGate(deep)).toBe(HIDDEN_SECRET_REFUSAL);
  });

  it('lets ordinary calls through', () => {
    expect(hiddenSecretGate({ command: 'show running-config' })).toBeUndefined();
    expect(hiddenSecretGate({ method: 'GET', path: '/rest/v10.09/system', n: 3, ok: true, none: null })).toBeUndefined();
    expect(hiddenSecretGate({ command: 'show secret hidden-ssid' })).toBeUndefined();
    expect(hiddenSecretGate(undefined)).toBeUndefined();
  });
});

describe('markers', () => {
  it('match the markers the copied scrubber writes', () => {
    expect(SECRET_MARKER).toBe(scrub.SECRET_MARKER);
    expect(LINE_MARKER).toBe(scrub.LINE_MARKER);
  });
});
