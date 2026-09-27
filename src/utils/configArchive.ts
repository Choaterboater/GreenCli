// Config archive — frontend capture helpers (NW-16).
//
// The durable per-device history + golden baseline lives in
// `src-tauri/src/config_archive.rs` (see the `config_archive_*` commands). The
// capture itself happens HERE because pulling a running-config needs the live
// terminal channel + vendor paging control (same split as intent evaluation).

import { invoke } from '@tauri-apps/api/tauri';
import { Session } from '../types';
import { useSettingsStore } from '../store/settingsStore';
import { notify } from '../store/toastStore';
import { profileForSession } from './deviceProfiles';
import { pagedCommand, withPagingDisabled } from './paging';
import { sendAndCapture } from './terminal';

/** One history row, mirroring `config_archive::ArchiveEntry` (camelCase). */
export interface ArchiveEntry {
  ts: number;
  source: string;
  golden: boolean;
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
  const ts = await invoke<number | null>('config_archive_capture', {
    device: getDeviceId(session),
    source,
    content: output,
  });
  return { content: output, truncated, ts };
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
