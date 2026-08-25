import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@tauri-apps/api/tauri', () => ({ invoke: vi.fn() }));

import { invoke } from '@tauri-apps/api/tauri';
import { sendAndCapture } from './terminal';

const mockInvoke = vi.mocked(invoke);

beforeEach(() => {
  mockInvoke.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('sendAndCapture', () => {
  it('serializes concurrent captures on the SAME session (per-session mutex)', async () => {
    const events: string[] = [];
    let buf = '';
    mockInvoke.mockImplementation((cmd: string, args?: unknown) => {
      if (cmd === 'get_terminal_output') {
        events.push('read');
        return Promise.resolve(buf);
      }
      if (cmd === 'send_data') {
        const data = (args as { data: string }).data;
        events.push(`send:${data.trim()}`);
        buf += `output-of-${data}`;
        return Promise.resolve(undefined);
      }
      return Promise.resolve(undefined);
    });

    const [r1, r2] = await Promise.all([
      sendAndCapture('sess-mutex', 'cmd1'),
      sendAndCapture('sess-mutex', 'cmd2'),
    ]);

    // Fully interleave-free: capture 2's first read must come AFTER capture 1
    // finished polling (2 consecutive stable reads => break).
    expect(events).toEqual([
      'read', // capture 1 baseline
      'send:cmd1',
      'read', // grew
      'read', // stable 1
      'read', // stable 2 -> done
      'read', // capture 2 baseline
      'send:cmd2',
      'read',
      'read',
      'read',
    ]);
    expect(r1.output).toBe('output-of-cmd1');
    expect(r2.output).toBe('output-of-cmd2');
    expect(r1.truncated).toBe(false);
    expect(r2.truncated).toBe(false);
  }, 15000);

  it('captures only the NEW output since the command was sent', async () => {
    let buf = 'switch# old-output\r\n';
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'get_terminal_output') return Promise.resolve(buf);
      if (cmd === 'send_data') {
        buf += 'new-output\r\nswitch# ';
        return Promise.resolve(undefined);
      }
      return Promise.resolve(undefined);
    });

    const res = await sendAndCapture('sess-delta', 'show version');
    expect(res.output).toBe('new-output\nswitch#');
    expect(res.truncated).toBe(false);
  }, 15000);

  it('flags the capture as truncated when output never settles (6s cap)', async () => {
    vi.useFakeTimers();
    let buf = 'switch# ';
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'get_terminal_output') {
        buf += 'x'.repeat(500); // device still streaming on every poll
        return Promise.resolve(buf);
      }
      return Promise.resolve(undefined);
    });

    const p = sendAndCapture('sess-trunc', 'show tech-support');
    await vi.advanceTimersByTimeAsync(15 * 400 + 1000);
    const res = await p;
    expect(res.truncated).toBe(true);
    expect(res.output.length).toBeGreaterThan(0);
  });
});
