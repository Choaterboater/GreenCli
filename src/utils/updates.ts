// Automatic updates: the app side of src-tauri/src/updater.rs.
//
// Checking downloads a newer version and checks its signature, but never
// installs it. Installing happens only from restartToUpdate(), which the user
// starts by tapping "Restart to update" (Settings or the toast) and confirms.

import { invoke } from '@tauri-apps/api/core';
import { isTauri } from './tauri';
import { askConfirm } from '../store/dialogStore';
import { notify } from '../store/toastStore';
import { useSessionStore } from '../store/sessionStore';
import { useSidePanelStore } from '../store/sidePanelStore';
import { exitHolds, runBeforeExit } from './beforeExit';

/** Why updates are off: a dev build, a system with no release build, or the
 * updater didn't start. */
export type UpdateOffReason = 'dev' | 'platform' | 'setup';
export type InstallPlace = 'normal' | 'translocated' | 'diskImage';

/** update_status (Rust UpdateStatus). */
export interface UpdateStatus {
  version: string;
  enabled: boolean;
  reason: UpdateOffReason | null;
  place: InstallPlace;
  /** A downloaded update's version, ready for "Restart to update". */
  ready: string | null;
}

export const UPDATE_TEXT = {
  how: 'Updates come from GreenCLI releases on GitHub and are checked before they install.',
  latest: 'You have the latest version.',
  ready: (version: string) => `GreenCLI ${version} is ready.`,
  restart: 'Restart to update',
  checkFailed: "Couldn't check for updates. Check your internet connection.",
  off: 'Updates are off in this build. Get new versions from the GitHub Releases page.',
  offDev: 'Updates are off in development builds.',
  moveFirst: 'Move GreenCLI to Applications first.',
  notReady: 'Check for updates first.',
  windows: 'Close Claude Code and Casper before updating.',
  dirtyEditor: 'The config editor has unsaved edits. They will be lost.',
  aiBusy: 'The AI assistant is still answering. It will stop.',
} as const;

/** Windows, checked when asked (not when the module loads) so tests can stub it. */
export const onWindows = (): boolean =>
  typeof navigator !== 'undefined' && /Windows/i.test(navigator.userAgent);

export const DAY_MS = 24 * 60 * 60 * 1000;
const LAST_CHECK_KEY = 'greencli-update-last-check';
const DAILY_KEY = 'greencli-update-daily';

/** Why updates are off, in words; null when they are on. */
export function offText(status: UpdateStatus | null): string | null {
  if (status?.enabled) return null;
  return status?.reason === 'dev' ? UPDATE_TEXT.offDev : UPDATE_TEXT.off;
}

/** The app's update status; null outside the app. */
export async function getUpdateStatus(): Promise<UpdateStatus | null> {
  if (!isTauri) return null;
  return invoke<UpdateStatus>('update_status');
}

/**
 * Look for a newer version, download it and check its signature. Resolves to
 * the new version, or null when this is the latest. Never installs.
 */
export async function checkForUpdate(): Promise<string | null> {
  const version = await invoke<string | null>('update_check');
  recordCheck();
  return version;
}

/** The text to show for a failed check or install. */
export function updateErrorText(e: unknown): string {
  // The Rust side only returns short, URL-free sentences.
  return typeof e === 'string' && e.length > 0 && e.length < 200 ? e : UPDATE_TEXT.checkFailed;
}

export function lastCheckAt(): number | null {
  try {
    const n = Number(localStorage.getItem(LAST_CHECK_KEY));
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

export function recordCheck(now = Date.now()): void {
  try {
    localStorage.setItem(LAST_CHECK_KEY, String(now));
  } catch {
    // Private mode or storage off: the next start checks again.
  }
}

/** "Check once a day" (on unless turned off). */
export function dailyCheckOn(): boolean {
  try {
    return localStorage.getItem(DAILY_KEY) !== 'off';
  } catch {
    return true;
  }
}

export function setDailyCheck(on: boolean): void {
  try {
    localStorage.setItem(DAILY_KEY, on ? 'on' : 'off');
  } catch {
    // Not saved; the setting stays as it was.
  }
}

/** A day since the last check (or never checked, or the clock went back). */
export function dailyCheckDue(now: number, last: number | null): boolean {
  return last === null || last > now || now - last >= DAY_MS;
}

/** The sticky "GreenCLI X is ready." toast with its Restart to update button. */
export function showUpdateReady(version: string): void {
  notify.info(UPDATE_TEXT.ready(version), undefined, {
    duration: 0,
    action: {
      label: UPDATE_TEXT.restart,
      // The Toaster closes the card before this runs. When nothing installed
      // (Not now, Cancel, a failed install), bring it back, so the button the
      // "Not now" message refers to is still there.
      run: () => void restartToUpdate(version).then((installed) => showAgain(installed, version)),
    },
  });
}

/** The ready toast again, for the update still waiting (if any). */
async function showAgain(installed: boolean, version: string): Promise<void> {
  if (installed) return;
  const status = await getUpdateStatus().catch(() => null);
  const ready = status ? status.ready : version;
  if (ready) showUpdateReady(ready);
}

/**
 * The quiet daily check: only when updates are on, "Check once a day" is on,
 * the app can update itself where it is (not run from the disk image or a
 * moved copy macOS opened in a temporary place), and the last check was a
 * day ago or more. Errors are only logged.
 */
export async function dailyUpdateCheck(now = Date.now()): Promise<void> {
  try {
    if (!isTauri || !dailyCheckOn() || !dailyCheckDue(now, lastCheckAt())) return;
    const status = await getUpdateStatus();
    if (!status?.enabled || status.place !== 'normal') return;
    // Counted when it starts, so a failing check waits a day like a good one.
    recordCheck(now);
    const version = await invoke<string | null>('update_check');
    if (version) showUpdateReady(version);
  } catch (e) {
    console.warn('Daily update check failed:', e);
  }
}

/**
 * Install the downloaded update and restart, after the user confirms. Not
 * while a Change Job, bulk run or Config Editor send is going (they hold the
 * exit). `version` is what the toast or button showed; the confirm names the
 * update waiting now. Resolves false when nothing was installed (refused,
 * nothing waiting, cancelled or failed).
 */
export async function restartToUpdate(version: string): Promise<boolean> {
  const busy = () => {
    const holds = exitHolds();
    if (holds.length === 0) return false;
    notify.warning('Not now', `${holds.join(' ')} Restart to update when it ends.`);
    return true;
  };
  if (busy()) return false;

  // From the disk image (or a copy macOS runs from a temporary place) the
  // install can't work: say so before asking, not after the saves.
  const status = await getUpdateStatus().catch(() => null);
  if (status && status.place !== 'normal') {
    notify.warning('Not now', UPDATE_TEXT.moveFirst);
    return false;
  }
  // The update waiting now: a check since the toast or button appeared may
  // have replaced it with a newer one, or dropped it (its release withdrawn).
  const ready = status ? status.ready : version;
  if (!ready) {
    notify.warning('Not now', UPDATE_TEXT.notReady);
    return false;
  }

  const open = useSessionStore.getState().sessions.length;
  const panel = useSidePanelStore.getState().status;
  const dirty = panel.editor === 'dirty';
  const lines = [
    `GreenCLI ${ready} installs, then opens again.`,
    open > 0 ? `${open} open session${open === 1 ? '' : 's'} will close.` : '',
    // A running greencli-mcp.exe (from Claude Code or Casper) blocks the
    // installer, which only checks for GreenCLI.exe itself.
    onWindows() ? UPDATE_TEXT.windows : '',
    dirty ? UPDATE_TEXT.dirtyEditor : '',
    // An answer cut off is only lost, so it is a warning, not a hold.
    panel.ai === 'busy' ? UPDATE_TEXT.aiBusy : '',
  ].filter(Boolean);
  const ok = await askConfirm({
    title: 'Restart now?',
    message: lines.join(' '),
    confirmLabel: UPDATE_TEXT.restart,
    danger: dirty,
  });
  if (!ok || busy()) return false;

  // Save what is still waiting to be saved (the vault) before the app closes.
  await runBeforeExit();
  try {
    await invoke('update_install');
    return true;
  } catch (e) {
    notify.error("Couldn't update", updateErrorText(e));
    return false;
  }
}
