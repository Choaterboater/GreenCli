// Scheduled intent evaluation + drift alerting (NW-15).
//
// The eval engine itself lives in `intent.ts` (frontend, has the live terminal
// channel). This module arms a background interval that re-runs the same
// evaluate-all sweep and watches for NEW-violation transitions: a sweep where
// an intent goes ok/unknown -> violation. Unchanged violations are never
// re-alerted — transition detection keys off the PERSISTED lastResult, so the
// "previous state" survives restarts and manual runs.

import { invoke } from '@tauri-apps/api/tauri';
import { useSettingsStore } from '../store/settingsStore';
import { useSessionStore } from '../store/sessionStore';
import { notify } from '../store/toastStore';
import { Intent, IntentStatus, evaluateAll } from './intent';

/** intent id -> status from the last persisted evaluation (undefined = never
 *  evaluated, or a result that pre-dates statuses). */
export type StatusMap = Map<string, IntentStatus | undefined>;

/** Snapshot the prior status of every intent, from its persisted lastResult. */
export function collectPriorStatuses(intents: Intent[]): StatusMap {
  const map: StatusMap = new Map();
  for (const i of intents) map.set(i.id, i.lastResult?.status);
  return map;
}

/** Intents that VIOLATE now but did NOT violate before. "Before" here is
 *  strictly *not* a violation — ok/unknown/never-evaluated all count as a
 *  transition into violation. Violation->violation is unchanged: no re-alert. */
export function newViolations(prior: StatusMap, updated: Intent[]): Intent[] {
  return updated.filter(
    (i) => prior.get(i.id) !== 'violation' && i.lastResult?.status === 'violation'
  );
}

/** Webhook payload for a drift alert — exactly the transitions fired in this
 *  sweep, nothing else. The local-listener acceptance case asserts this shape. */
export function driftWebhookPayload(at: number, violations: Intent[]): Record<string, unknown> {
  return {
    event: 'intent.violation',
    at,
    count: violations.length,
    violations: violations.map((i) => ({
      id: i.id,
      name: i.name,
      severity: i.severity,
      status: 'violation',
      detail: i.lastResult?.detail ?? '',
      perDevice: i.lastResult?.perDevice ?? [],
    })),
  };
}

/** One evaluation pass: fresh intent list -> prior statuses -> evaluate all ->
 *  the newly-violated intents (transitions only). Pure-ish: evaluates via the
 *  live terminal channel and persists results (intent_set_result), same as the
 *  manual "Evaluate all" button. */
export async function runSweep(): Promise<Intent[]> {
  const sessions = useSessionStore.getState().sessions;
  if (!sessions.some((s) => s.connected)) return [];
  const intents = await invoke<Intent[]>('intent_list').catch(() => [] as Intent[]);
  if (!intents.length) return [];
  const prior = collectPriorStatuses(intents);
  const updated = await evaluateAll(intents, sessions);
  return newViolations(prior, updated);
}

let timer: ReturnType<typeof setInterval> | null = null;
let sweeping = false;

/** Re-arm the interval. Returns a cleanup that disarms. */
export function armIntentScheduler(enabled: boolean, minutes: number): () => void {
  disarmIntentScheduler();
  if (!enabled) return () => undefined;
  // Clamp here too (belt & braces with the store setter): a corrupt settings
  // value must not busy-loop the terminal.
  const ms = Math.min(1440, Math.max(1, Math.round(minutes))) * 60_000;
  timer = setInterval(() => void sweepOnce(), ms);
  return disarmIntentScheduler;
}

export function disarmIntentScheduler(): void {
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
}

/** Interval tick: exact one sweep at a time; never overlaps itself. */
export async function sweepOnce(): Promise<void> {
  if (sweeping) return;
  sweeping = true;
  try {
    const violations = await runSweep();
    if (!violations.length) return;
    // One toast per sweep; each newly-violated intent named once.
    const names = violations.map((i) => i.name).join(', ');
    notify.warning(
      'Intent drift detected',
      `${violations.length} intent${violations.length > 1 ? 's' : ''} newly non-compliant: ${names}`
    );
    const url = useSettingsStore.getState().intentWebhookUrl.trim();
    if (url) {
      await invoke('intent_webhook_notify', {
        url,
        payload: driftWebhookPayload(Date.now(), violations),
      }).catch(() => undefined); // never crash the sweep on a webhook failure
    }
  } finally {
    sweeping = false;
  }
}