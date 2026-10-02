// Config archive — frontend capture helpers (NW-16).
//
// The durable per-device history + golden baseline lives in
// `src-tauri/src/config_archive.rs` (see the `config_archive_*` commands). The
// capture itself happens HERE because pulling a running-config needs the live
// terminal channel + vendor paging control (same split as intent evaluation).

import { invoke } from '@tauri-apps/api/core';
import { Session } from '../types';
import { useSettingsStore } from '../store/settingsStore';
import { notify } from '../store/toastStore';
import { profileForSession } from './deviceProfiles';
import { pagedCommand, withPagingDisabled } from './paging';
import { hideSecretsInText } from './secrets/forCopy';
import { sendAndCapture } from './terminal';

/**
 * Version of the secret filter (src/utils/secrets) that made a hidden copy.
 * greencli-mcp serves a snapshot's config only from its hidden copy
 * (`<ts>.hidden.json`), and only when the copy has this version. Keep it equal
 * to HIDDEN_COPY_FILTER in src-tauri/greencli-mcp/src/lib.rs (a Rust test
 * checks). When the filter changes, bump both, so old copies are made again.
 */
export const HIDDEN_COPY_FILTER = 1;

/**
 * sha256 of the filter's source files under src/utils/secrets (tests left
 * out; sorted by path, LF newlines). hiddenFilterVersion.test.ts fails when
 * the filter changes without a bump.
 */
export const HIDDEN_COPY_FILTER_SOURCE = '42f0b17bb9343b571edd878f15f0e713186fea8fce11f34f9dc75825822cc15f';

/** One history row, mirroring `config_archive::ArchiveEntry` (camelCase). */
export interface ArchiveEntry {
  ts: number;
  source: string;
  golden: boolean;
  /** Secret filter version of the snapshot's hidden copy; absent when it has none. */
  hiddenFilter?: number;
}

/** What config_archive_capture stored. */
interface Captured {
  ts: number | null;
  /** Set when the hidden copy was not saved. */
  warning?: string;
}

/** Snapshots by hidden copy (config_archive_missing_hidden). */
export interface HiddenStatus {
  missing: number;
  stale: number;
  current: number;
  /** The missing and stale ones. */
  todo: { device: string; ts: number }[];
}

// The show command that prints each vendor's running config. Paging is handled
// by paging.ts (the same per-vendor toggles the editor's Pull uses); a
// profile's own runningConfigCommand wins, exactly like the editor's Pull.
const RUNNING_CONFIG_SHOW: Record<string, string> = {
  'juniper-junos': 'show configuration',
  mist: 'show configuration',
};

/** Stable archive key for a session: its name, else host, else session id. */
export function getDeviceId(session: Session): string {
  return session.config.name || session.config.host || session.sessionId;
}

/** True when the session type supports a device-running-config capture. Local
 *  shells and serial consoles are skipped (no device config to snapshot; serial
 *  may be mid-config on a console). */
export function captureSupported(session: Session): boolean {
  return session.config.protocol === 'ssh' || session.config.protocol === 'telnet';
}

/** History-row labels: auto on connect, the Capture-now button, and the
 *  snapshots a Change Job takes on each side of its change. */
export type CaptureSource = 'connect' | 'manual' | 'before-change' | 'after-change';

export interface CapturedConfig {
  content: string;
  /** The capture hit a limit and may be missing lines (see CaptureResult). */
  truncated: boolean;
  /** Snapshot ts, or null when identical to the newest one (nothing stored). */
  ts: number | null;
}

/**
 * Pull the running config NOW and store it in the device's archive history,
 * returning what was captured (null when the device printed nothing). Throws
 * when the session can't be read. `pagingOff`: the caller already turned
 * paging off around a longer sequence (Change Jobs' checks + capture).
 */
export async function captureRunningConfig(
  session: Session,
  source: CaptureSource,
  opts: { pagingOff?: boolean } = {}
): Promise<CapturedConfig | null> {
  const profile = profileForSession(session.config, useSettingsStore.getState().customDeviceProfiles);
  const show = pagedCommand(
    profile,
    profile.runningConfigCommand || RUNNING_CONFIG_SHOW[profile.deviceType] || 'show running-config'
  );
  const sid = session.sessionId;
  const pull = () => sendAndCapture(sid, show);
  const { output, truncated } = opts.pagingOff ? await pull() : await withPagingDisabled(sid, profile, pull);
  if (!output.trim()) return null;
  // The hidden copy for greencli-mcp. When the filter can't run, there is no
  // copy: greencli-mcp then refuses this snapshot instead of serving it raw.
  const hidden = await hideSecretsInText(output);
  const got = await invoke<Captured>('config_archive_capture', {
    device: getDeviceId(session),
    source,
    content: output,
    hidden: hidden.ok ? hidden.text : null,
    filter: HIDDEN_COPY_FILTER,
  });
  if (got.warning) console.warn(`[config-archive] ${got.warning}`);
  void refreshStaleHiddenCopies();
  return { content: output, truncated, ts: got.ts };
}

/** Pull the running config NOW and store it under the device's archive key.
 *  Returns the snapshot ts, or null when nothing was stored (deduped repeat).
 *  `source` labels the history row: 'connect' (auto on ssh/telnet connect) vs
 *  'manual' (Capture-now button). */
export async function captureNow(session: Session, source: 'connect' | 'manual'): Promise<number | null> {
  if (!captureSupported(session)) return null;
  if (!session.connected) return null;
  try {
    const got = await captureRunningConfig(session, source);
    if (!got) return null;
    if (got.truncated) {
      // The capture hit its settle cap / the backend tail-trimmed mid-pull, so
      // the baseline just stored may be missing lines — say so.
      console.warn(`[config-archive] capture for ${getDeviceId(session)} may be truncated`);
      notify.warning(
        'Config archive',
        'The captured running-config may be truncated — the baseline stored for this device could be incomplete.'
      );
    }
    return got.ts;
  } catch {
    return null; // capture failures are silent — never disturb the session
  }
}

/** Fire-and-forget connect-time capture (NW-16 acceptance: connect -> history). */
export function captureOnConnect(session: Session): void {
  void captureNow(session, 'connect').catch(() => undefined);
}

export async function archiveDevices(): Promise<string[]> {
  return invoke<string[]>('config_archive_devices');
}

export async function archiveHistory(device: string): Promise<ArchiveEntry[]> {
  return invoke<ArchiveEntry[]>('config_archive_list', { device });
}

export async function archiveSnapshot(device: string, ts: number): Promise<string> {
  return invoke<string>('config_archive_get', { device, ts });
}

export async function archiveSetGolden(device: string, ts: number): Promise<void> {
  await invoke('config_archive_set_golden', { device, ts });
}

export async function archiveHiddenStatus(): Promise<HiddenStatus> {
  return invoke<HiddenStatus>('config_archive_missing_hidden');
}

export interface HiddenCopiesResult {
  made: number;
  failed: number;
  /** Left for next time (over the limit). */
  left: number;
}

/**
 * Make hidden copies for snapshots that have none, or one from an older secret
 * filter: read the raw snapshot, hide its secrets, save the copy. A snapshot
 * that fails (too big for the filter, or the filter can't run) is skipped and
 * counted; it keeps no copy, so greencli-mcp keeps refusing it.
 */
export async function makeHiddenCopies(opts: { limit?: number } = {}): Promise<HiddenCopiesResult> {
  const { todo } = await archiveHiddenStatus();
  const limit = opts.limit ?? Infinity;
  const batch = todo.slice(0, limit);
  let made = 0;
  let failed = 0;
  for (const { device, ts } of batch) {
    try {
      const raw = await archiveSnapshot(device, ts);
      const hidden = await hideSecretsInText(raw);
      if (!hidden.ok) {
        failed++;
        continue;
      }
      await invoke('config_archive_set_hidden', { device, ts, hidden: hidden.text, filter: HIDDEN_COPY_FILTER });
      made++;
    } catch {
      failed++;
    }
  }
  return { made, failed, left: todo.length - batch.length };
}

/** Most snapshots the background refresh redoes in one run. */
export const BACKGROUND_REFRESH_LIMIT = 500;

let refreshRun: Promise<void> | null = null;

/**
 * Once per app run, in the background: after the secret filter changed (some
 * hidden copies are stale), make the copies again. Capped and logged; the
 * "Make hidden copies" button in Config archive does the rest. Every call
 * returns the same promise, which ends when the run is done (it never fails),
 * so a caller can read the hidden copy count again after it.
 */
export function refreshStaleHiddenCopies(): Promise<void> {
  refreshRun ??= (async () => {
    const status = await archiveHiddenStatus();
    if (status.stale === 0) return;
    const result = await makeHiddenCopies({ limit: BACKGROUND_REFRESH_LIMIT });
    console.info(
      `[config-archive] hidden copies refreshed after a secret filter change: ${result.made} made, ${result.failed} failed, ${result.left} left`
    );
  })().catch((e) => console.warn('[config-archive] hidden copy refresh failed', e));
  return refreshRun;
}

/** Tests only: let refreshStaleHiddenCopies run again. */
export function resetHiddenRefreshForTests(): void {
  refreshRun = null;
}
