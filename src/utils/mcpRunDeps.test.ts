import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/tauri', () => ({ invoke: vi.fn(() => Promise.resolve(null)) }));

import { invoke } from '@tauri-apps/api/tauri';
import { cancelDialogs, useDialogStore } from '../store/dialogStore';
import { useMcpApprovalStore } from '../store/mcpApprovalStore';
import type { McpAskRequest } from './mcpRun';
import { cancelActiveMcpCalls, defaultMcpDeps, mcpChoices } from './mcpRunDeps';

const request = (extra: Partial<McpAskRequest> = {}): McpAskRequest => ({
  server: 'central',
  tool: 'get_device',
  label: 'external-action',
  notes: [],
  argsText: '{}',
  argsSummary: '1 line, 2 bytes',
  choices: ['no', 'once', 'session'],
  danger: false,
  ...extra,
});

beforeEach(() => {
  vi.mocked(invoke).mockClear();
  useDialogStore.setState({ current: null, queue: [] });
  useMcpApprovalStore.getState().clearAll();
});

describe('mcpChoices', () => {
  it('builds the buttons in order, in plain words', () => {
    expect(mcpChoices(request())).toEqual([
      { value: 'no', label: 'No', detail: 'Nothing runs', tone: 'plain' },
      { value: 'once', label: 'Yes, this once', detail: 'Runs this call only', tone: 'accent' },
      {
        value: 'session',
        label: 'Yes, for this session',
        detail: "get_device on central won't ask again until GreenCLI closes or the tool or server changes",
        tone: 'accent',
      },
    ]);
    const danger = mcpChoices(request({ choices: ['no', 'once'], danger: true }));
    expect(danger.map((c) => c.value)).toEqual(['no', 'once']);
    expect(danger[1].tone).toBe('danger');
  });
});

describe('defaultMcpDeps', () => {
  it('asks in the AI dialog group, and Stop answers null', async () => {
    const deps = defaultMcpDeps();
    const answer = deps.ask(request({ notes: ['note'] }));
    const shown = useDialogStore.getState().current!;
    expect(shown).toMatchObject({
      type: 'choice',
      group: 'ai',
      title: 'Run get_device on central?',
      notes: ['note'],
      details: '{}',
      detailsLabel: 'Arguments (1 line, 2 bytes)',
    });
    cancelDialogs('ai');
    await expect(answer).resolves.toBeNull();
  });

  it('maps the chosen button to an answer', async () => {
    const deps = defaultMcpDeps();
    const answer = deps.ask(request());
    useDialogStore.getState().current!.resolve('session');
    await expect(answer).resolves.toBe('session');
  });

  it('calls the backend with a call id, and Stop cancels the calls in flight', async () => {
    const deps = defaultMcpDeps();
    const id = deps.newCallId();
    expect(id).toMatch(/^mcp-[0-9a-z]+-\d+$/);
    expect(deps.newCallId()).not.toBe(id);
    await deps.call('central', 'get_device', { a: 1 }, id, false);
    expect(invoke).toHaveBeenCalledWith('mcp_call', {
      server: 'central',
      tool: 'get_device',
      args: { a: 1 },
      callId: id,
      readOnly: false,
    });
    const untrack = deps.trackCall(id);
    cancelActiveMcpCalls();
    expect(invoke).toHaveBeenCalledWith('mcp_cancel_call', { callId: id });
    vi.mocked(invoke).mockClear();
    untrack();
    cancelActiveMcpCalls();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('reads and stores session allowances', () => {
    const deps = defaultMcpDeps();
    deps.allow('central', 'get_device', 'fp');
    expect(deps.isAllowed('central', 'get_device', 'fp')).toBe(true);
    expect(deps.isAllowed('central', 'get_device', 'other')).toBe(false);
  });
});
