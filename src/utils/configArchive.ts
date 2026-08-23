// Config archive — frontend capture helpers (NW-16).
//
// The durable per-device history + golden baseline lives in
// `src-tauri/src/config_archive.rs` (see the `config_archive_*` commands). The
// capture itself happens HERE because pulling a running-config needs the live
// terminal channel + vendor paging control (same split as intent evaluation).

import { invoke } from '@tauri-apps/api/tauri';
import { Session } from '../types';
import { useSettingsStore } from '../store/settingsStore';
import { profileForSession } from './deviceProfiles';
import { sendAndCapture, sleep } from './terminal';

/** One history row, mirroring `config_archive::ArchiveEntry` (camelCase). */
export interface ArchiveEntry {
  ts: number;
  source: string;
  golden: boolean;
}

// Mirrors ConfigEditor's VENDOR_PAGING so a connect-time capture can disable
// paging, pull, and restore it without importing the editor. Profile-level
// overrides (pagingDisableCommand / pagingRestoreCommand / runningConfigCommand)
// take precedence, exactly like the editor's Pull button.
const VENDOR_PAGING: Record<string, { disable?: string; restore?: string; show: string }> = {
  'aruba-cx': { disable: 'no page', restore: 'page', show: 'show running-config' },
  'aruba-aos-s': { disable: 'no page', restore: 'page', show: 'show running-config' },
  'aruba-controller': { disable: 'no paging', restore: 'paging', show: 'show running-config' },
  'aruba-ap': { show: 'show running-config' },
  'juniper-junos': { show: 'show configuration | no-more' },
  mist: { show: 'show configuration | no-more' },
  generic: { show: 'show running-config' },
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

/** Pull the running config NOW and store it under the device's archive key.
 *  Returns the snapshot ts, or null when nothing was stored (deduped repeat).
 *  `source` labels the history row: 'connect' (auto on ssh/telnet connect) vs
 *  'manual' (Capture-now button). */
export async function captureNow(session: Session, source: 'connect' | 'manual'): Promise<number | null> {
  if (!captureSupported(session)) return null;
  if (!session.connected) return null;
  const profile = profileForSession(session.config, useSettingsStore.getState().customDeviceProfiles);
  const base = VENDOR_PAGING[profile.deviceType] ?? VENDOR_PAGING.generic;
  const disable = profile.pagingDisableCommand ?? base.disable;
  const restore = profile.pagingRestoreCommand ?? base.restore;
  let show = profile.runningConfigCommand || base.show;
  if (
    (profile.deviceType === 'juniper-junos' || profile.deviceType === 'mist') &&
    /^show\b/i.test(show) &&
    !/\|\s*no-more\b/i.test(show)
  ) {
    show = `${show} | no-more`;
  }
  const sid = session.sessionId;
  try {
    if (disable) {
      await invoke('send_data', { sessionId: sid, data: disable + '\r' });
      await sleep(300);
    }
    const out = await sendAndCapture(sid, show);
    if (restore) {
      await invoke('send_data', { sessionId: sid, data: restore + '\r' });
      await sleep(150);
    }
    if (!out?.trim()) return null;
    const ts = await invoke<number | null>('config_archive_capture', {
      device: getDeviceId(session),
      source,
      content: out,
    });
    return ts;
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