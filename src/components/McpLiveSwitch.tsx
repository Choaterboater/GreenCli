import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { isTauri } from '../utils/fileSystem';
import { notify } from '../store/toastStore';

/** mcp_live_status: show commands from AI tools outside GreenCLI (greencli-mcp's device_show). */
export interface LiveStatus {
  /** The switch (on by default). */
  on: boolean;
  /** GreenCLI is listening right now. */
  listening: boolean;
  /** macOS and Linux. */
  supported: boolean;
  /** Why it isn't listening although the switch is on, in plain words. */
  problem: string | null;
}

function asStatus(v: unknown): LiveStatus | null {
  if (!v || typeof v !== 'object') return null;
  const s = v as Record<string, unknown>;
  if (typeof s.on !== 'boolean' || typeof s.listening !== 'boolean' || typeof s.supported !== 'boolean') return null;
  return {
    on: s.on,
    listening: s.listening,
    supported: s.supported,
    problem: typeof s.problem === 'string' && s.problem ? s.problem : null,
  };
}

/** The switch and its state, or null when it can't be read (no desktop app). */
export async function readLiveStatus(): Promise<LiveStatus | null> {
  if (!isTauri) return null;
  return asStatus(await invoke('mcp_live_status').catch(() => null));
}

export const LIVE_SWITCH_LABEL = 'Let AI tools outside GreenCLI ask to run show commands (asks you each time)';

/** One switch in MCP Servers: on by default; off means GreenCLI doesn't listen at all. */
export default function McpLiveSwitch() {
  const [status, setStatus] = useState<LiveStatus | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void readLiveStatus().then((s) => {
      if (!cancelled) setStatus(s);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!status) return null;

  const box =
    'mb-3 p-3 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--bg-inset)] text-[11px] text-[var(--text-secondary)] space-y-1.5 leading-relaxed';

  if (!status.supported) {
    return (
      <div className={box}>
        <p>Show commands for AI tools outside GreenCLI aren't on Windows yet.</p>
      </div>
    );
  }

  const set = async (on: boolean) => {
    setBusy(true);
    try {
      const next = asStatus(await invoke('mcp_live_set', { on }));
      if (next) setStatus(next);
    } catch (e) {
      notify.error('Show commands', String(e));
      // Rust keeps the choice even when it can't open: show what it has now.
      const now = await readLiveStatus();
      if (now) setStatus(now);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={box}>
      <label className="flex items-center gap-2 text-[var(--text-primary)] cursor-pointer select-none">
        <input
          type="checkbox"
          checked={status.on}
          disabled={busy}
          onChange={(e) => void set(e.target.checked)}
          className="accent-[var(--accent)]"
        />
        {LIVE_SWITCH_LABEL}
      </label>
      <p>
        Casper or Claude Code can run a <code>show</code> line on a device tab you have connected, through
        greencli-mcp. Casper asks first, then GreenCLI asks: No, Yes this once, or Yes on this device until GreenCLI
        closes.
      </p>
      {status.on && !status.listening && (
        <p className="text-[var(--accent-warning)]">{status.problem ?? 'Not open right now.'}</p>
      )}
    </div>
  );
}
