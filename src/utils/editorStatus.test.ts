import { describe, expect, it } from 'vitest';
import { ago, deviceName, sendTargetStatus, vendorMismatch } from './editorStatus';

const NOW = Date.UTC(2026, 9, 1, 12, 0, 0);
const session = (over: Partial<NonNullable<Parameters<typeof sendTargetStatus>[0]['session']>> = {}) => ({
  name: 'core-sw1',
  connected: true,
  configMode: false,
  deviceType: 'aruba-cx',
  ...over,
});

describe('vendorMismatch', () => {
  it('catches a tab for one CLI going to a device with another', () => {
    expect(vendorMismatch('juniper-junos', 'aruba-cx', 'core-sw1')).toBe('This tab is Junos, but core-sw1 is Aruba CX.');
    expect(vendorMismatch('aruba-cx', 'aruba-aos-s', 'edge-2930')).toBe('This tab is Aruba CX, but edge-2930 is Aruba AOS-S.');
  });

  it('treats Mist-managed switches as Junos', () => {
    expect(vendorMismatch('mist', 'juniper-junos', 'ex1')).toBeUndefined();
    expect(vendorMismatch('juniper-junos', 'mist', 'ex1')).toBeUndefined();
  });

  it('stays quiet when either side is unknown', () => {
    expect(vendorMismatch('plaintext', 'aruba-cx', 'sw')).toBeUndefined();
    expect(vendorMismatch('generic', 'aruba-cx', 'sw')).toBeUndefined();
    expect(vendorMismatch('python', 'juniper-junos', 'sw')).toBeUndefined();
    expect(vendorMismatch('aruba-cx', 'generic', 'sw')).toBeUndefined();
  });
});

describe('ago', () => {
  it('says how long ago in plain words', () => {
    expect(ago(NOW - 20_000, NOW)).toBe('just now');
    expect(ago(NOW - 12 * 60_000, NOW)).toBe('12 min ago');
    expect(ago(NOW - 3 * 3_600_000, NOW)).toBe('3 h ago');
    expect(ago(NOW - 26 * 3_600_000, NOW)).toBe('1 day ago');
    expect(ago(NOW - 72 * 3_600_000, NOW)).toBe('3 days ago');
    // A clock that moved back never reads as the future.
    expect(ago(NOW + 60_000, NOW)).toBe('just now');
  });
});

describe('sendTargetStatus', () => {
  it('names the device, its CLI, config mode and the last pull', () => {
    expect(
      sendTargetStatus({
        session: session({ configMode: true }),
        pulled: { at: NOW - 12 * 60_000, truncated: false },
        editorLanguage: 'aruba-cx',
        now: NOW,
      })
    ).toEqual({
      target: 'Send to: core-sw1',
      device: 'Aruba CX',
      configMode: true,
      pulled: 'pulled 12 min ago',
      mismatch: undefined,
      tone: 'normal',
    });
  });

  it('turns red when the tab is for another vendor', () => {
    const status = sendTargetStatus({ session: session(), editorLanguage: 'juniper-junos', now: NOW });
    expect(status.tone).toBe('danger');
    expect(status.mismatch).toBe('This tab is Junos, but core-sw1 is Aruba CX.');
    expect(status.pulled).toBe('not pulled yet');
  });

  it('says when the session is down, and drops a stale CONFIG flag', () => {
    const status = sendTargetStatus({
      session: session({ connected: false, configMode: true }),
      pulled: { at: NOW - 60 * 60_000, truncated: true },
      editorLanguage: 'aruba-cx',
      now: NOW,
    });
    expect(status).toMatchObject({
      target: 'Send to: core-sw1 (disconnected)',
      configMode: false,
      pulled: 'pulled 1 h ago, may be cut off',
      tone: 'muted',
    });
  });

  it('leaves out the CLI for a generic device', () => {
    expect(sendTargetStatus({ session: session({ deviceType: 'generic' }), editorLanguage: 'aruba-cx', now: NOW }).device).toBeUndefined();
    expect(deviceName('juniper-junos')).toBe('Junos');
  });

  it('says there is nowhere to send without a session', () => {
    expect(sendTargetStatus({ session: null, editorLanguage: 'aruba-cx', now: NOW })).toEqual({
      target: 'No session: open a device tab to send',
      configMode: false,
      tone: 'muted',
    });
  });
});
