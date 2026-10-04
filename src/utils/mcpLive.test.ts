import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }));
vi.mock('./terminal', async (importOriginal) => {
  const real = await importOriginal<typeof import('./terminal')>();
  return { ...real, sendAndCapture: vi.fn() };
});

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { useDialogStore } from '../store/dialogStore';
import { useMcpApprovalStore } from '../store/mcpApprovalStore';
import { useSessionStore } from '../store/sessionStore';
import type { DeviceType, Protocol, Session } from '../types';
import {
  cancelLiveRequest,
  handleLiveRequest,
  liveDevices,
  startMcpLive,
  type LiveRequest,
} from './mcpLive';
import { sendAndCapture } from './terminal';

const invokeMock = vi.mocked(invoke);
const captureMock = vi.mocked(sendAndCapture);

function tab(
  id: string,
  name: string,
  opts: { deviceType?: DeviceType; protocol?: Protocol; connected?: boolean; host?: string } = {},
): Session {
  const connected = opts.connected ?? true;
  return {
    sessionId: id,
    connected,
    connectionStatus: connected ? 'connected' : 'disconnected',
    config: {
      id,
      name,
      protocol: opts.protocol ?? 'ssh',
      host: opts.host ?? `${name}.example.test`,
      deviceType: opts.deviceType ?? 'aruba-cx',
    },
  };
}

/** What each tab's terminal shows at the end of its buffer. */
let buffers: Record<string, string> = {};

beforeEach(() => {
  buffers = {};
  invokeMock.mockReset();
  invokeMock.mockImplementation(async (cmd: string, args?: unknown) => {
    const a = args as { sessionId?: string } | undefined;
    if (cmd === 'get_terminal_output') return buffers[a?.sessionId ?? ''] ?? '';
    return undefined;
  });
  captureMock.mockReset();
  captureMock.mockImplementation(async (_id, command) => ({
    output: `${command}\nVLAN  Name\n1     DEFAULT_VLAN\nsw-a#`,
    truncated: false,
  }));
  useDialogStore.setState({ current: null, queue: [] });
  useMcpApprovalStore.getState().clearAll();
  useSessionStore.setState({
    sessions: [
      tab('t1', 'sw-a'),
      tab('t2', 'edge-b', { deviceType: 'juniper-junos' }),
      tab('t3', 'shell', { deviceType: 'generic', protocol: 'local' }),
      tab('t4', 'old-sw', { connected: false }),
    ],
  });
  buffers.t1 = 'Last login\nsw-a# ';
  buffers.t2 = 'Last login\nadmin@edge-b> ';
  buffers.t3 = 'me@laptop ~ % ';
});

afterEach(() => {
  useDialogStore.setState({ current: null, queue: [] });
});

const show = (target: Partial<LiveRequest>, line = 'show vlan'): LiveRequest => ({
  id: 'live-1',
  pid: 4242,
  op: 'show',
  show: line,
  ...target,
});

/** Wait until the box shows, then press one of its buttons. */
async function answer(value: string | null) {
  await vi.waitFor(() => expect(useDialogStore.getState().current).not.toBeNull());
  const box = useDialogStore.getState().current!;
  useDialogStore.getState().close();
  box.resolve(value);
  return box;
}

const sent = () => invokeMock.mock.calls.filter(([cmd]) => cmd === 'send_data');
/** Keys sent outside a capture (paging commands, pager quit), without the paging pair. */
const keys = () =>
  sent()
    .map(([, a]) => (a as { data: string }).data)
    .filter((d) => !['no page\r', 'page\r', 'no paging\r', 'paging\r'].includes(d));

describe('list_connected_devices', () => {
  it('lists connected network device tabs only', async () => {
    expect(liveDevices(useSessionStore.getState().sessions)).toEqual([
      { tabId: 't1', name: 'sw-a', type: 'aruba-cx' },
      { tabId: 't2', name: 'edge-b', type: 'juniper-junos' },
    ]);
    const reply = await handleLiveRequest({ id: 'live-9', pid: 1, op: 'sessions' });
    expect(reply).toEqual({ ok: true, devices: liveDevices(useSessionStore.getState().sessions) });
  });
});

describe('device_show: which tab', () => {
  it('refuses when two connected tabs match the device', async () => {
    useSessionStore.setState({
      sessions: [tab('t1', 'sw-a'), tab('t5', 'sw-a')],
    });
    buffers.t5 = 'sw-a# ';
    const reply = await handleLiveRequest(show({ device: 'sw-a' }));
    expect(reply).toMatchObject({ ok: false });
    expect((reply as { error: string }).error).toMatch(/two tabs/i);
    expect(useDialogStore.getState().current).toBeNull();
    expect(captureMock).not.toHaveBeenCalled();
  });

  it('refuses a device with no connected tab, and a tab that is not connected', async () => {
    const none = await handleLiveRequest(show({ device: 'nope' }));
    expect(none).toMatchObject({ ok: false });
    const off = await handleLiveRequest(show({ tab: 't4' }));
    expect((off as { error: string }).error).toMatch(/isn't connected/);
    expect(captureMock).not.toHaveBeenCalled();
  });

  it('never runs on a host tab (Linux, Windows, a local shell)', async () => {
    const reply = await handleLiveRequest(show({ tab: 't3' }));
    expect((reply as { error: string }).error).toMatch(/network device/);
    expect(useDialogStore.getState().current).toBeNull();
    expect(captureMock).not.toHaveBeenCalled();
  });

  it('refuses a line that is not a plain show line, before any box', async () => {
    const reply = await handleLiveRequest(show({ tab: 't1' }, 'show run\nconf t'));
    expect(reply).toMatchObject({ ok: false });
    expect(useDialogStore.getState().current).toBeNull();
  });
});

describe('device_show: the tab must be idle', () => {
  it('refuses when something is half-typed after the prompt', async () => {
    buffers.t1 = 'sw-a# reload';
    const reply = await handleLiveRequest(show({ tab: 't1' }));
    expect((reply as { error: string }).error).toMatch(/typed/);
    expect(useDialogStore.getState().current).toBeNull();
    expect(captureMock).not.toHaveBeenCalled();
  });

  it('refuses in config mode and at a pager', async () => {
    buffers.t1 = 'sw-a(config)# ';
    expect(((await handleLiveRequest(show({ tab: 't1' }))) as { error: string }).error).toMatch(/config mode/);
    buffers.t2 = '[edit]\nadmin@edge-b# ';
    expect(((await handleLiveRequest(show({ tab: 't2' }))) as { error: string }).error).toMatch(/config mode/);
    buffers.t1 = 'line\n--More--';
    expect(await handleLiveRequest(show({ tab: 't1' }))).toMatchObject({ ok: false });
    expect(captureMock).not.toHaveBeenCalled();
  });

  it('checks again after the box: typing while it was open stops the run', async () => {
    const run = handleLiveRequest(show({ tab: 't1' }));
    await vi.waitFor(() => expect(useDialogStore.getState().current).not.toBeNull());
    buffers.t1 = 'sw-a# copy';
    await answer('once');
    expect(await run).toMatchObject({ ok: false });
    expect(captureMock).not.toHaveBeenCalled();
  });
});

describe('device_show: the box', () => {
  it('shows the pid, not a program name, and the exact line', async () => {
    const run = handleLiveRequest(show({ tab: 't1' }, 'show vlan | include 10'));
    const box = await answer('no');
    expect(box.group).toBe('mcp-live:live-1');
    expect(box.message).toContain('a program on this computer (pid 4242)');
    expect(box.details).toBe('show vlan | include 10');
    expect(box.choices?.map((c) => c.value)).toEqual(['no', 'once', 'device']);
    expect(box.choices?.[2].label).toContain('sw-a');
    expect(await run).toEqual({ ok: false, error: 'You said no in GreenCLI. Nothing ran.' });
    expect(captureMock).not.toHaveBeenCalled();
  });

  it('choice 2 runs this once, then asks again', async () => {
    const first = handleLiveRequest(show({ tab: 't1' }));
    await answer('once');
    expect(await first).toMatchObject({ ok: true });
    const second = handleLiveRequest(show({ id: 'live-2', tab: 't1' }));
    await answer('no');
    expect(await second).toMatchObject({ ok: false });
    expect(captureMock).toHaveBeenCalledTimes(1);
  });

  it('choice 3 is remembered for that device only', async () => {
    const first = handleLiveRequest(show({ device: 'sw-a' }));
    await answer('device');
    expect(await first).toMatchObject({ ok: true });
    // Same device, by tab this time: no box.
    expect(await handleLiveRequest(show({ id: 'live-2', tab: 't1' }))).toMatchObject({ ok: true });
    expect(useDialogStore.getState().current).toBeNull();
    // Another device still asks.
    const other = handleLiveRequest(show({ id: 'live-3', tab: 't2' }));
    await answer('no');
    expect(await other).toMatchObject({ ok: false });
    expect(captureMock).toHaveBeenCalledTimes(2);
  });

  it('a cancel closes only its own box, and nothing runs', async () => {
    const mine = handleLiveRequest(show({ id: 'live-1', tab: 't1' }));
    const other = handleLiveRequest(show({ id: 'live-2', tab: 't2' }));
    await vi.waitFor(() => expect(useDialogStore.getState().queue).toHaveLength(1));
    cancelLiveRequest('live-1');
    expect(await mine).toMatchObject({ ok: false });
    expect(useDialogStore.getState().current?.group).toBe('mcp-live:live-2');
    await answer('no');
    await other;
    expect(captureMock).not.toHaveBeenCalled();
  });

  it('a cancel that comes before the box means no box at all', async () => {
    let release: (v: string) => void = () => {};
    invokeMock.mockImplementationOnce(() => new Promise((r) => (release = r as (v: string) => void)));
    const run = handleLiveRequest(show({ tab: 't1' }));
    cancelLiveRequest('live-1');
    release('sw-a# ');
    expect(await run).toMatchObject({ ok: false });
    expect(useDialogStore.getState().current).toBeNull();
    expect(captureMock).not.toHaveBeenCalled();
  });
});

describe('device_show: running it', () => {
  it('adds | no-more on Junos', async () => {
    useMcpApprovalStore.getState().allowDevice('greencli-mcp', 'device_show', 'edge-b');
    await handleLiveRequest(show({ tab: 't2' }, 'show interfaces terse'));
    expect(captureMock).toHaveBeenCalledWith('t2', 'show interfaces terse | no-more');
    await handleLiveRequest(show({ id: 'live-2', tab: 't2' }, 'show route | no-more'));
    expect(captureMock).toHaveBeenLastCalledWith('t2', 'show route | no-more');
  });

  it('turns paging off around the line on AOS-CX, AOS-S and AOS-8, and back on after', async () => {
    const order: string[] = [];
    invokeMock.mockImplementation(async (cmd: string, args?: unknown) => {
      const a = args as { sessionId?: string; data?: string } | undefined;
      if (cmd === 'get_terminal_output') return buffers[a?.sessionId ?? ''] ?? '';
      if (cmd === 'send_data') order.push(`${a?.sessionId} send ${a?.data}`);
      return undefined;
    });
    captureMock.mockImplementation(async (id, command) => {
      order.push(`${id} capture ${command}`);
      return { output: `${command}\nhostname x\nx#`, truncated: false };
    });
    useSessionStore.setState({
      sessions: [tab('t1', 'sw-a'), tab('t6', 'sw-s', { deviceType: 'aruba-aos-s' }), tab('t7', 'mc-1', { deviceType: 'aruba-controller' })],
    });
    buffers.t6 = 'sw-s# ';
    buffers.t7 = '(mc-1) #';
    for (const name of ['sw-a', 'sw-s', 'mc-1']) useMcpApprovalStore.getState().allowDevice('greencli-mcp', 'device_show', name);
    await handleLiveRequest(show({ tab: 't1' }, 'show running-config'));
    await handleLiveRequest(show({ id: 'live-2', tab: 't6' }, 'show running-config'));
    await handleLiveRequest(show({ id: 'live-3', tab: 't7' }, 'show running-config'));
    expect(order).toEqual([
      't1 send no page\r',
      't1 capture show running-config',
      't1 send page\r',
      't6 send no page\r',
      't6 capture show running-config',
      't6 send page\r',
      't7 send no paging\r',
      't7 capture show running-config',
      't7 send paging\r',
    ]);
  });

  it('quits a pager with the key the pager names, and marks the output cut short', async () => {
    useMcpApprovalStore.getState().allowDevice('greencli-mcp', 'device_show', 'sw-a');
    captureMock.mockResolvedValueOnce({ output: 'show tech\nline 1\nline 2\n-- MORE --, next page: Space', truncated: false });
    const reply = await handleLiveRequest(show({ tab: 't1' }, 'show tech'));
    expect(reply).toMatchObject({ ok: true, truncated: true });
    expect(keys()).toEqual(['q']);

    // AOS-S: q doesn't close its pager, Ctrl+C does.
    invokeMock.mockClear();
    useSessionStore.setState({ sessions: [tab('t6', 'sw-s', { deviceType: 'aruba-aos-s' })] });
    buffers.t6 = 'sw-s# ';
    useMcpApprovalStore.getState().allowDevice('greencli-mcp', 'device_show', 'sw-s');
    captureMock.mockResolvedValueOnce({
      output: 'show tech\nline 1\n-- MORE --, next page: Space, next line: Enter, quit: Control-C',
      truncated: false,
    });
    expect(await handleLiveRequest(show({ id: 'live-2', tab: 't6' }, 'show tech'))).toMatchObject({ ok: true, truncated: true });
    expect(keys()).toEqual(['\x03']);
  });

  it('runs one request per tab at a time, and checks the prompt again right before typing', async () => {
    useMcpApprovalStore.getState().allowDevice('greencli-mcp', 'device_show', 'sw-a');
    let finish: (v: { output: string; truncated: boolean }) => void = () => {};
    captureMock.mockImplementationOnce(() => new Promise((r) => (finish = r)));
    const first = handleLiveRequest(show({ id: 'live-1', tab: 't1' }, 'show running-config'));
    const second = handleLiveRequest(show({ id: 'live-2', tab: 't1' }, 'show  version'));
    await vi.waitFor(() => expect(captureMock).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 50));
    // The second line waits: nothing is typed while the first is still on screen.
    expect(captureMock).toHaveBeenCalledTimes(1);
    // The first left the tab at a pager that would eat the start of the next line.
    buffers.t1 = 'line 1\n-- MORE --, next page: Space';
    finish({ output: 'show running-config\nline 1\n-- MORE --, next page: Space', truncated: false });
    expect(await first).toMatchObject({ ok: true, truncated: true });
    expect((await second) as { error: string }).toMatchObject({ ok: false });
    expect(captureMock).toHaveBeenCalledTimes(1);
  });

  it('returns the output as data and hides secrets', async () => {
    useMcpApprovalStore.getState().allowDevice('greencli-mcp', 'device_show', 'sw-a');
    captureMock.mockResolvedValueOnce({
      output:
        'show running-config\nhostname sw-a\nradius-server host 192.0.2.10 key plaintext FakeKey123 vrf mgmt\nbanner motd "conf t"\nsw-a#',
      truncated: false,
    });
    const reply = await handleLiveRequest(show({ tab: 't1' }, 'show running-config'));
    expect(reply).toMatchObject({ ok: true, truncated: false });
    const output = (reply as { output: string }).output;
    expect(output).not.toContain('FakeKey123');
    expect(output).toContain('<secret hidden>');
    expect(output).toContain('conf t');
    // Only the show line itself went to the device: the "conf t" in the output never ran.
    expect(captureMock).toHaveBeenCalledTimes(1);
    expect(keys()).toEqual([]);
  });

  it('keeps the result under 16 KB and says so when it was cut', async () => {
    useMcpApprovalStore.getState().allowDevice('greencli-mcp', 'device_show', 'sw-a');
    const big = Array.from({ length: 3000 }, (_, i) => `interface 1/1/${i} up`).join('\n');
    captureMock.mockResolvedValueOnce({ output: `show interface brief\n${big}\nsw-a#`, truncated: false });
    const reply = await handleLiveRequest(show({ tab: 't1' }, 'show interface brief'));
    expect(reply).toMatchObject({ ok: true, truncated: true });
    expect(new TextEncoder().encode((reply as { output: string }).output).length).toBeLessThanOrEqual(16 * 1024);
  });

  it('keeps the start of a long config, up to 16 KB', async () => {
    useMcpApprovalStore.getState().allowDevice('greencli-mcp', 'device_show', 'sw-a');
    const body = Array.from({ length: 1400 }, (_, i) => `interface 1/1/${i}\n    no shutdown`).join('\n');
    const config = `hostname sw-a\nvlan 10\n${body}`;
    expect(config.length).toBeGreaterThan(40_000);
    captureMock.mockResolvedValueOnce({ output: `show running-config\n${config}\nsw-a#`, truncated: false });
    const reply = await handleLiveRequest(show({ tab: 't1' }, 'show running-config'));
    expect(reply).toMatchObject({ ok: true, truncated: true });
    const output = (reply as { output: string }).output;
    expect(output.slice(0, 200)).toContain('hostname sw-a');
    const bytes = new TextEncoder().encode(output).length;
    expect(bytes).toBeGreaterThan(12_000);
    expect(bytes).toBeLessThanOrEqual(16 * 1024);
  });
});

describe('startMcpLive', () => {
  it('answers each request with mcp_live_reply and closes the box on mcp_live_cancel', async () => {
    const handlers: Record<string, (e: { payload: unknown }) => void> = {};
    vi.mocked(listen).mockImplementation(async (name, handler) => {
      handlers[name] = handler as (e: { payload: unknown }) => void;
      return () => {};
    });
    const stop = startMcpLive();
    await vi.waitFor(() => expect(Object.keys(handlers)).toHaveLength(2));

    handlers.mcp_live_request({ payload: { id: 'live-7', pid: 9, op: 'sessions' } });
    await vi.waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith('mcp_live_reply', {
        id: 'live-7',
        reply: { ok: true, devices: liveDevices(useSessionStore.getState().sessions) },
      }),
    );

    handlers.mcp_live_request({ payload: { id: 'live-8', pid: 9, op: 'show', tab: 't1', show: 'show vlan' } });
    await vi.waitFor(() => expect(useDialogStore.getState().current?.group).toBe('mcp-live:live-8'));
    handlers.mcp_live_cancel({ payload: { id: 'live-8' } });
    expect(useDialogStore.getState().current).toBeNull();
    await vi.waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith('mcp_live_reply', expect.objectContaining({ id: 'live-8' })),
    );
    expect(captureMock).not.toHaveBeenCalled();
    stop();
  });

  it('answers a request it cannot read with a plain no', async () => {
    const handlers: Record<string, (e: { payload: unknown }) => void> = {};
    vi.mocked(listen).mockImplementation(async (name, handler) => {
      handlers[name] = handler as (e: { payload: unknown }) => void;
      return () => {};
    });
    const stop = startMcpLive();
    await vi.waitFor(() => expect(Object.keys(handlers)).toHaveLength(2));
    handlers.mcp_live_request({ payload: { id: 'live-3', op: 'reboot' } });
    await vi.waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith('mcp_live_reply', {
        id: 'live-3',
        reply: expect.objectContaining({ ok: false }),
      }),
    );
    stop();
  });
});
