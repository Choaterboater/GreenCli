import { describe, it, expect } from 'vitest';
import { pickAiSession } from './aiSession';
import type { ConnectionConfig, Session } from '../types';

const session = (id: string, protocol: ConnectionConfig['protocol'], connected = true): Session => ({
  sessionId: id,
  connected,
  config: { id, name: id, protocol, host: protocol === 'local' ? '' : id, deviceType: 'generic' } as ConnectionConfig,
});

describe('pickAiSession', () => {
  it('targets the active device tab, even while it is down', () => {
    const sw1 = session('sw1', 'ssh', false);
    const sw2 = session('sw2', 'ssh');
    expect(pickAiSession([sw1, sw2], 'sw1')).toBe(sw1);
  });

  it('uses a connected device when the active tab is local', () => {
    const claude = session('claude', 'local');
    const sw1 = session('sw1', 'ssh', false);
    const sw2 = session('sw2', 'telnet');
    expect(pickAiSession([claude, sw1, sw2], 'claude')).toBe(sw2);
  });

  it('never picks a local tab, even when nothing else is open', () => {
    const shell = session('shell', 'local');
    const casper = session('casper', 'local');
    expect(pickAiSession([shell, casper], 'casper')).toBeUndefined();
    expect(pickAiSession([shell], undefined)).toBeUndefined();
    expect(pickAiSession([], null)).toBeUndefined();
  });

  it('never falls back to a local tab when the only device is disconnected', () => {
    const shell = session('shell', 'local');
    const sw1 = session('sw1', 'ssh', false);
    expect(pickAiSession([shell, sw1], 'shell')).toBeUndefined();
  });
});
