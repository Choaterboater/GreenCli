// Per-vendor terminal paging control, shared by every path that captures
// command output through the live terminal (intent evaluation, Bulk Runner).
// Without it sendAndCapture returns page 1 only: the device sits at its pager
// prompt, the buffer stops growing, and the capture "settles" on a fragment.

import { invoke } from '@tauri-apps/api/tauri';
import { DeviceProfile } from '../types';
import { sleep } from './terminal';

// AOS-CX/AOS-S use `no page` (NOT `no paging`); ArubaOS 8 controllers use
// `no paging`; Junos/Mist have no session toggle, so show commands get
// `| no-more` piped instead (see pagedCommand). Mirrors ConfigEditor's
// VENDOR_PAGING; a profile's own pagingDisableCommand/pagingRestoreCommand wins.
const VENDOR_PAGING: Record<string, { disable?: string; restore?: string }> = {
  'aruba-cx': { disable: 'no page', restore: 'page' },
  'aruba-aos-s': { disable: 'no page', restore: 'page' },
  'aruba-controller': { disable: 'no paging', restore: 'paging' },
};

export interface PagingCommands {
  disable?: string;
  restore?: string;
}

/** Session-level paging off/on commands for a profile (either may be absent). */
export function pagingCommands(profile: DeviceProfile): PagingCommands {
  const base = VENDOR_PAGING[profile.deviceType] ?? {};
  return {
    disable: profile.pagingDisableCommand ?? base.disable,
    restore: profile.pagingRestoreCommand ?? base.restore,
  };
}

/** Rewrite `command` so its output isn't paged where the vendor needs it per
 *  command: Junos/Mist `show …` gets `| no-more` (unless already piped). */
export function pagedCommand(profile: DeviceProfile, command: string): string {
  if (
    (profile.deviceType === 'juniper-junos' || profile.deviceType === 'mist') &&
    /^\s*show\b/i.test(command) &&
    !/\|\s*no-more\b/i.test(command)
  ) {
    return `${command} | no-more`;
  }
  return command;
}

/**
 * Run `fn` with paging turned off on `sessionId`, restoring it afterward so
 * the live session isn't left changed. The restore runs even when `fn` throws
 * (best effort — the session may be the thing that failed).
 */
export async function withPagingDisabled<T>(
  sessionId: string,
  profile: DeviceProfile,
  fn: () => Promise<T>
): Promise<T> {
  const { disable, restore } = pagingCommands(profile);
  if (disable) {
    await invoke('send_data', { sessionId, data: disable + '\r' });
    await sleep(300);
  }
  try {
    return await fn();
  } finally {
    if (restore) {
      await invoke('send_data', { sessionId, data: restore + '\r' }).catch(() => undefined);
      await sleep(150);
    }
  }
}

// AOS-S/CX `-- MORE --, next page: Space…`, Junos `---(more 42%)---`,
// AOS-8 `--More-- (q) quit…`.
const PAGER_PROMPT = /(-{2,}\s*more|---\(more|--More--)/i;

/** True when captured output stopped at a pager prompt (checks the tail only,
 *  so a `--more` inside the output body doesn't count). */
export function endsAtPager(output: string): boolean {
  return PAGER_PROMPT.test(output.slice(-80));
}

/** Keystroke that quits the pager in `output`'s trailing prompt: Ctrl+C where
 *  the prompt says so (AOS-S "quit: Control-C"), otherwise `q` (Junos, AOS-8,
 *  AOS-CX). Space would only advance a page. */
export function pagerQuitKey(output: string): string {
  return /(control|ctrl)-?c|\^c/i.test(output.slice(-120)) ? '\x03' : 'q';
}
