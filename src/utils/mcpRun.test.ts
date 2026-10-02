import { describe, expect, it } from 'vitest';
import { toolFingerprint, type McpAnswer } from './mcpGate';
import {
  CHANGED,
  GONE,
  runMcpTool,
  SAID_NO,
  STOPPED,
  STOPPED_IN_FLIGHT,
  TOO_LONG,
  type McpAskRequest,
  type McpRunDeps,
} from './mcpRun';
import type { McpToolInfo } from './mcpTypes';
import { HIDDEN_SECRET_REFUSAL } from './secrets/gate';
import type { RawToolOutcome } from './secrets/forAi';

function tool(name: string, extra: Partial<McpToolInfo> = {}): McpToolInfo {
  return { server: 'srv', name, description: '', inputSchema: { type: 'object' }, ...extra };
}

interface Fake {
  deps: McpRunDeps;
  asks: McpAskRequest[];
  calls: Array<{ tool: string; callId: string; readOnly: boolean }>;
  allowed: Array<[string, string, string]>;
  isAllowedSeen: string[];
  infoCalls: number;
  untracked: string[];
}

/** Fake deps that record what runMcpTool did. `infos` are returned in order (the last repeats). */
function fake(opts: {
  infos: Array<McpToolInfo | null>;
  answer?: McpAnswer | null;
  onAsk?: () => void;
  callResult?: () => Promise<string>;
  allowedFingerprint?: string;
}): Fake {
  const f: Fake = { asks: [], calls: [], allowed: [], isAllowedSeen: [], infoCalls: 0, untracked: [], deps: null! };
  let seq = 0;
  f.deps = {
    toolInfo: async () => opts.infos[Math.min(f.infoCalls++, opts.infos.length - 1)] ?? null,
    call: async (_server, toolName, _args, callId, readOnly) => {
      f.calls.push({ tool: toolName, callId, readOnly });
      return opts.callResult ? opts.callResult() : '{"ok":true}';
    },
    ask: async (request) => {
      f.asks.push(request);
      opts.onAsk?.();
      return opts.answer === undefined ? 'once' : opts.answer;
    },
    isAllowed: (_server, _tool, fingerprint) => {
      f.isAllowedSeen.push(fingerprint);
      return fingerprint === opts.allowedFingerprint;
    },
    allow: (server, toolName, fingerprint) => f.allowed.push([server, toolName, fingerprint]),
    newCallId: () => `id-${++seq}`,
    trackCall: (callId) => () => f.untracked.push(callId),
  };
  return f;
}

const ctx = (shouldCancel: () => boolean = () => false) => ({ readOnlyAgent: false, shouldCancel });

function text(outcome: RawToolOutcome): string {
  if (outcome.kind !== 'text') throw new Error(`expected text, got ${outcome.kind}`);
  return outcome.text;
}

describe('runMcpTool', () => {
  it('runs a read-only tool without asking', async () => {
    const f = fake({ infos: [tool('get_device', { annotations: { readOnlyHint: true } })] });
    const out = await runMcpTool('srv', 'get_device', { id: 1 }, ctx(), f.deps);
    expect(out).toEqual({ kind: 'json', value: '{"ok":true}' });
    expect(f.asks).toHaveLength(0);
    expect(f.calls).toEqual([{ tool: 'get_device', callId: 'id-1', readOnly: false }]);
    expect(f.untracked).toEqual(['id-1']);
  });

  it('never calls when the user says no', async () => {
    const f = fake({ infos: [tool('set_ssid')], answer: 'no' });
    expect(text(await runMcpTool('srv', 'set_ssid', {}, ctx(), f.deps))).toBe(SAID_NO);
    expect(f.calls).toHaveLength(0);
    const closed = fake({ infos: [tool('set_ssid')], answer: null });
    expect(text(await runMcpTool('srv', 'set_ssid', {}, ctx(), closed.deps))).toBe(SAID_NO);
    expect(closed.calls).toHaveLength(0);
  });

  it('shows the box with cleaned text', async () => {
    const f = fake({ infos: [tool('set_ssid')], answer: 'no' });
    await runMcpTool('srv', 'set_ssid', { ssid: 'guest' }, ctx(), f.deps);
    expect(f.asks[0]).toMatchObject({
      server: 'srv',
      tool: 'set_ssid',
      label: 'write',
      choices: ['no', 'once'],
      danger: true,
      argsText: '{\n  "ssid": "guest"\n}',
      argsSummary: '3 lines, 21 bytes',
    });
    expect(f.asks[0].notes).toContain('This tool can change settings');
  });

  it("doesn't call when Stop comes while the box is open, even after a Yes", async () => {
    let stopped = false;
    const f = fake({ infos: [tool('set_ssid')], answer: 'once', onAsk: () => (stopped = true) });
    expect(text(await runMcpTool('srv', 'set_ssid', {}, ctx(() => stopped), f.deps))).toBe(STOPPED);
    expect(f.calls).toHaveLength(0);
  });

  it('refuses a hidden-secret marker before any lookup or box', async () => {
    const f = fake({ infos: [tool('set_ssid')] });
    const out = await runMcpTool('srv', 'set_ssid', { psk: { value: ['<secret hidden>'] } }, ctx(), f.deps);
    expect(text(out)).toBe(HIDDEN_SECRET_REFUSAL);
    expect(f.infoCalls).toBe(0);
    expect(f.asks).toHaveLength(0);
  });

  it('refuses a tool that is gone', async () => {
    const f = fake({ infos: [null] });
    expect(text(await runMcpTool('srv', 'set_ssid', {}, ctx(), f.deps))).toBe(GONE('srv', 'set_ssid'));
    expect(f.asks).toHaveLength(0);
    const throws = fake({ infos: [] });
    throws.deps.toolInfo = async () => {
      throw new Error('no backend');
    };
    expect(text(await runMcpTool('srv', 'x', {}, ctx(), throws.deps))).toBe(GONE('srv', 'x'));
  });

  it('refuses a tool the backend blocks', async () => {
    const f = fake({ infos: [tool('set_ssid', { blocked: 'srv writes are off.' })] });
    expect(text(await runMcpTool('srv', 'set_ssid', {}, ctx(), f.deps))).toBe('Not run: srv writes are off.');
    expect(f.asks).toHaveLength(0);
  });

  it('refuses when the tool changed while the user was deciding', async () => {
    const f = fake({ infos: [tool('set_ssid'), tool('set_ssid', { description: 'and reboots' })] });
    expect(text(await runMcpTool('srv', 'set_ssid', {}, ctx(), f.deps))).toBe(CHANGED('srv', 'set_ssid'));
    expect(f.calls).toHaveLength(0);
  });

  it('refuses when the tool is gone after the Yes', async () => {
    const f = fake({ infos: [tool('set_ssid'), null] });
    expect(text(await runMcpTool('srv', 'set_ssid', {}, ctx(), f.deps))).toBe(GONE('srv', 'set_ssid'));
    expect(f.calls).toHaveLength(0);
  });

  it('remembers "Yes, for this session" with the fingerprint', async () => {
    const live = tool('get_device');
    const f = fake({ infos: [live], answer: 'session' });
    await runMcpTool('srv', 'get_device', {}, ctx(), f.deps);
    expect(f.allowed).toEqual([['srv', 'get_device', toolFingerprint(live)]]);
    expect(f.calls).toHaveLength(1);
    // Allowed now: no box.
    const again = fake({ infos: [live], allowedFingerprint: toolFingerprint(live) });
    await runMcpTool('srv', 'get_device', {}, ctx(), again.deps);
    expect(again.asks).toHaveLength(0);
    expect(again.calls).toHaveLength(1);
  });

  it('asks again once the tool is redefined', async () => {
    const old = tool('get_device');
    const redefined = tool('get_device', { description: 'new' });
    const f = fake({ infos: [redefined], allowedFingerprint: toolFingerprint(old), answer: 'no' });
    await runMcpTool('srv', 'get_device', {}, ctx(), f.deps);
    expect(f.isAllowedSeen).toEqual([toolFingerprint(redefined)]);
    expect(f.asks).toHaveLength(1);
  });

  it('never stores the session for a write, since it is not offered', async () => {
    const f = fake({ infos: [tool('set_ssid')], answer: 'session' });
    await runMcpTool('srv', 'set_ssid', {}, ctx(), f.deps);
    expect(f.asks[0].choices).toEqual(['no', 'once']);
    expect(f.allowed).toHaveLength(0);
  });

  it('reports a call stopped in flight', async () => {
    let stopped = false;
    const f = fake({
      infos: [tool('get_device', { annotations: { readOnlyHint: true } })],
      callResult: async () => {
        stopped = true;
        throw 'API Error: connection reset';
      },
    });
    expect(text(await runMcpTool('srv', 'get_device', {}, ctx(() => stopped), f.deps))).toBe(STOPPED_IN_FLIGHT);
  });

  it("passes Rust's own Stop and refusal texts through as they are", async () => {
    const readTool = tool('get_device', { annotations: { readOnlyHint: true } });
    let stopped = false;
    const notSent = fake({
      infos: [readTool],
      callResult: async () => {
        stopped = true;
        throw 'Stopped. The call was not sent.';
      },
    });
    expect(text(await runMcpTool('srv', 'get_device', {}, ctx(() => stopped), notSent.deps))).toBe(
      'Stopped. The call was not sent.'
    );
    const refused = fake({
      infos: [readTool],
      callResult: async () => {
        throw 'Not run: x writes are off. Only the user can turn them on, in Settings → MCP Servers.';
      },
    });
    expect(text(await runMcpTool('srv', 'get_device', {}, ctx(), refused.deps))).toBe(
      'Not run: x writes are off. Only the user can turn them on, in Settings → MCP Servers.'
    );
    const failed = fake({ infos: [readTool], callResult: async () => Promise.reject('API Error: boom') });
    expect(text(await runMcpTool('srv', 'get_device', {}, ctx(), failed.deps))).toBe(
      'MCP tool srv/get_device failed: API Error: boom'
    );
  });

  it('untracks the call even when it throws', async () => {
    const f = fake({
      infos: [tool('get_device', { annotations: { readOnlyHint: true } })],
      callResult: async () => Promise.reject(new Error('boom')),
    });
    await runMcpTool('srv', 'get_device', {}, ctx(), f.deps);
    expect(f.untracked).toEqual(['id-1']);
  });

  it('refuses arguments too long to show', async () => {
    const f = fake({ infos: [tool('set_ssid')] });
    expect(text(await runMcpTool('srv', 'set_ssid', { blob: 'x'.repeat(20_000) }, ctx(), f.deps))).toBe(TOO_LONG);
    expect(f.asks).toHaveLength(0);
    expect(f.infoCalls).toBe(0);
  });

  it('does nothing once Stop was pressed', async () => {
    const f = fake({ infos: [tool('get_device', { annotations: { readOnlyHint: true } })] });
    expect(text(await runMcpTool('srv', 'get_device', {}, ctx(() => true), f.deps))).toBe(STOPPED);
    expect(f.infoCalls).toBe(0);
    expect(f.calls).toHaveLength(0);
  });

  it('refuses a blocked tool with no box and no call', async () => {
    const blocked = 'srv writes are off. Only the user can turn them on, in Settings → MCP Servers.';
    const f = fake({ infos: [tool('set_ssid', { blocked })] });
    expect(text(await runMcpTool('srv', 'set_ssid', {}, ctx(), f.deps))).toBe(`Not run: ${blocked}`);
    expect(f.asks).toHaveLength(0);
    expect(f.calls).toHaveLength(0);
  });

  it('refuses when writes go off while the box is open', async () => {
    const blocked = 'srv writes are off. Only the user can turn them on, in Settings → MCP Servers.';
    const f = fake({ infos: [tool('execute_command'), tool('execute_command', { blocked })], answer: 'once' });
    expect(text(await runMcpTool('srv', 'execute_command', {}, ctx(), f.deps))).toBe(`Not run: ${blocked}`);
    expect(f.asks).toHaveLength(1);
    expect(f.calls).toHaveLength(0);
  });

  it('passes the Read-only Auditor flag to the backend', async () => {
    const f = fake({ infos: [tool('get_device', { annotations: { readOnlyHint: true } })] });
    await runMcpTool('srv', 'get_device', {}, { readOnlyAgent: true, shouldCancel: () => false }, f.deps);
    expect(f.calls).toEqual([{ tool: 'get_device', callId: 'id-1', readOnly: true }]);
  });
});
