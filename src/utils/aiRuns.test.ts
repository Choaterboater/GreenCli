import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@tauri-apps/api/tauri', () => ({
  invoke: vi.fn(async () => undefined),
}));

import { invoke } from '@tauri-apps/api/tauri';
import { activeStreamIds, cancelActiveAiStreams, nextStreamId, runStoppable } from './aiRuns';

const invokeMock = vi.mocked(invoke);

describe('Stop for AI runs', () => {
  beforeEach(() => {
    invokeMock.mockClear();
  });

  it('gives each run a new id', () => {
    const a = nextStreamId();
    const b = nextStreamId();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^aistream-[a-z0-9]+-\d+$/);
  });

  it('reaches a CLI run in flight with its own id', async () => {
    let finish: (v: string) => void = () => {};
    let seenId = '';
    const run = runStoppable((runId) => {
      seenId = runId;
      return new Promise<string>((resolve) => {
        finish = resolve;
      });
    });
    expect(activeStreamIds.has(seenId)).toBe(true);

    cancelActiveAiStreams();
    expect(invokeMock).toHaveBeenCalledWith('ai_cancel_stream', { streamId: seenId });

    finish('done');
    await expect(run).resolves.toBe('done');
    expect(activeStreamIds.has(seenId)).toBe(false);
  });

  it('forgets the id when the run fails', async () => {
    let seenId = '';
    await expect(
      runStoppable(async (runId) => {
        seenId = runId;
        throw new Error('Stopped.');
      })
    ).rejects.toThrow('Stopped.');
    expect(activeStreamIds.has(seenId)).toBe(false);
    cancelActiveAiStreams();
    expect(invokeMock).not.toHaveBeenCalledWith('ai_cancel_stream', { streamId: seenId });
  });
});
