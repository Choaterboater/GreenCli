// Network intent / desired-state — types + evaluation engine.
// The Rust side persists intents (intents.json); evaluation runs here because we
// have the live terminal channel. Results are written back via intent_set_result.

import { invoke } from '@tauri-apps/api/tauri';
import { Session, DeviceProfile } from '../types';
import { sendAndCapture, sleep } from './terminal';
import { profileForSession } from './deviceProfiles';

export type MatcherKind = 'contains' | 'notContains' | 'regex' | 'regexAbsent';
export type IntentStatus = 'ok' | 'violation' | 'unknown';

export interface Matcher {
  kind: MatcherKind;
  value: string;
  /** Regex matchers compile case-insensitive ('im') by default; set true for
   *  case-sensitive ('m'). Ignored by contains/notContains (already case-folded). */
  caseSensitive?: boolean;
}
export interface Scope {
  all: boolean;
  tags: string[];
  deviceTypes: string[];
}
export interface DeviceResult {
  device: string;
  status: IntentStatus;
  detail: string;
}
export interface IntentResult {
  status: IntentStatus;
  detail: string;
  at: number;
  perDevice: DeviceResult[];
}
export interface Intent {
  id: string;
  name: string;
  kind: 'config' | 'operational';
  description?: string;
  command: string;
  matcher: Matcher;
  severity: 'critical' | 'warning' | 'info';
  scope: Scope;
  lastResult?: IntentResult;
}

/** Regex flags for a matcher: multiline always; case-insensitive unless the
 *  author opted into case-sensitive matching. */
const reFlags = (m: Matcher): string => (m.caseSensitive ? 'm' : 'im');

export function describeMatcher(m: Matcher): string {
  switch (m.kind) {
    case 'contains':
      return `output contains "${m.value}"`;
    case 'notContains':
      return `output does NOT contain "${m.value}"`;
    case 'regex':
      return `output matches /${m.value}/${reFlags(m)}`;
    case 'regexAbsent':
      return `output does NOT match /${m.value}/${reFlags(m)}`;
  }
}

export function inScope(scope: Scope, s: Session): boolean {
  if (scope.all) return true;
  const tags = s.config.tags ?? [];
  if (scope.tags?.length && scope.tags.some((t) => tags.includes(t))) return true;
  if (scope.deviceTypes?.length && scope.deviceTypes.includes(s.config.deviceType)) return true;
  return false;
}

/** Legacy boolean matcher. Prefer {@link matchOutcome}, which distinguishes
 *  "no evidence" and "bad pattern" from a genuine pass/fail. */
export function evalMatcher(m: Matcher, output: string): boolean {
  try {
    switch (m.kind) {
      case 'contains':
        return output.toLowerCase().includes(m.value.toLowerCase());
      case 'notContains':
        return !output.toLowerCase().includes(m.value.toLowerCase());
      case 'regex':
        return new RegExp(m.value, reFlags(m)).test(output);
      case 'regexAbsent':
        return !new RegExp(m.value, reFlags(m)).test(output);
    }
  } catch {
    return false;
  }
}

/**
 * Judge captured output, fail-SAFE. Empty output is `unknown` ("no evidence"),
 * NOT a pass — otherwise a `notContains`/`regexAbsent` intent would silently go
 * green when the device returned nothing. A bad regex is `unknown` (a definition
 * error), not a fabricated violation.
 */
export function matchOutcome(m: Matcher, output: string): { status: IntentStatus; detail: string } {
  if (output.trim() === '') {
    return { status: 'unknown', detail: 'no output captured' };
  }
  // A trailing pager prompt (`-- MORE --`, `---(more)---`, `--More--`) means the
  // capture stopped at page 1. Judging it risks a false "compliant" for
  // notContains/regexAbsent when the offending content is on a later page — so
  // treat truncated output as indeterminate, not a pass.
  if (/(-{2,}\s*more|---\(more|--More--)/i.test(output.slice(-80))) {
    return { status: 'unknown', detail: 'output truncated at pager prompt' };
  }
  let present: boolean;
  if (m.kind === 'regex' || m.kind === 'regexAbsent') {
    let re: RegExp;
    try {
      re = new RegExp(m.value, reFlags(m));
    } catch (e) {
      return { status: 'unknown', detail: `invalid regex /${m.value}/: ${e instanceof Error ? e.message : String(e)}` };
    }
    present = re.test(output);
  } else {
    present = output.toLowerCase().includes(m.value.toLowerCase());
  }
  const ok = m.kind === 'contains' || m.kind === 'regex' ? present : !present;
  return { status: ok ? 'ok' : 'violation', detail: ok ? 'compliant' : `expected ${describeMatcher(m)}` };
}

/** Evaluate one intent against connected, in-scope sessions; persist + return the result. */
export async function evaluateIntent(
  intent: Intent,
  sessions: Session[],
  shouldCancel?: () => boolean,
  customProfiles: DeviceProfile[] = []
): Promise<IntentResult> {
  const targets = sessions.filter(
    (s) => s.connected && s.config.protocol !== 'local' && inScope(intent.scope, s)
  );
  const perDevice: DeviceResult[] = [];
  let cancelled = false;
  for (const s of targets) {
    if (shouldCancel?.()) {
      cancelled = true;
      break;
    }
    const device = s.config.name || s.config.host || s.sessionId;
    try {
      // Disable device paging around the capture, mirroring ConfigEditor.pullCommand.
      // Without this, sendAndCapture returns only page 1 (the device pauses at a
      // pager prompt) and a violation on a later page silently reads as compliant.
      const profile = profileForSession(s.config, customProfiles);
      let cmd = intent.command;
      // Junos/Mist have no session paging toggle — pipe `| no-more` on show commands.
      if (
        (profile.deviceType === 'juniper-junos' || profile.deviceType === 'mist') &&
        /^\s*show\b/i.test(cmd) &&
        !/\|\s*no-more\b/i.test(cmd)
      ) {
        cmd = `${cmd} | no-more`;
      }
      if (profile.pagingDisableCommand) {
        await invoke('send_data', { sessionId: s.sessionId, data: profile.pagingDisableCommand + '\r' });
        await sleep(300);
      }
      const out = (await sendAndCapture(s.sessionId, cmd)) || '';
      if (profile.pagingRestoreCommand) {
        await invoke('send_data', { sessionId: s.sessionId, data: profile.pagingRestoreCommand + '\r' });
        await sleep(150);
      }
      const oc = matchOutcome(intent.matcher, out);
      perDevice.push({ device, status: oc.status, detail: oc.detail });
    } catch (e) {
      perDevice.push({ device, status: 'unknown', detail: String(e) });
    }
  }
  const hasViolation = perDevice.some((d) => d.status === 'violation');
  const hasUnknown = perDevice.some((d) => d.status === 'unknown');
  const status: IntentStatus = hasViolation
    ? 'violation'
    : perDevice.length === 0
    ? 'unknown'
    : hasUnknown
    ? 'unknown'
    : 'ok';
  const compliant = perDevice.filter((d) => d.status === 'ok').length;
  const unknown = perDevice.filter((d) => d.status === 'unknown').length;
  let detail: string;
  if (!targets.length) {
    detail = 'no in-scope connected device';
  } else {
    // Keep the badge and the count in agreement: surface the indeterminate devices
    // so an UNKNOWN badge isn't paired with a "N/N compliant" line.
    detail = `${compliant}/${targets.length} device${targets.length > 1 ? 's' : ''} compliant`;
    if (unknown) detail += `, ${unknown} unknown`;
  }
  const result: IntentResult = { status, detail, at: Date.now(), perDevice };
  // Don't persist a partial sweep the user already cancelled.
  if (!cancelled) {
    await invoke('intent_set_result', { id: intent.id, result }).catch(() => {});
  }
  return result;
}

/** Evaluate every intent; returns the intents with fresh results attached. */
export async function evaluateAll(
  intents: Intent[],
  sessions: Session[],
  shouldCancel?: () => boolean,
  customProfiles: DeviceProfile[] = []
): Promise<Intent[]> {
  const out: Intent[] = [];
  for (const intent of intents) {
    if (shouldCancel?.()) break;
    const lastResult = await evaluateIntent(intent, sessions, shouldCancel, customProfiles);
    out.push({ ...intent, lastResult });
  }
  return out;
}

/** Compact compliance report for the AI tool. */
export function summarize(intents: Intent[]): string {
  if (!intents.length) return 'No intents defined.';
  const lines = intents.map((i) => {
    const r = i.lastResult;
    const badge = r?.status === 'ok' ? 'OK' : r?.status === 'violation' ? 'VIOLATION' : 'UNKNOWN';
    const offenders = (r?.perDevice || [])
      .filter((d) => d.status !== 'ok')
      .map((d) => `${d.device}: ${d.detail}`)
      .join('; ');
    return `[${badge}] (${i.severity}/${i.kind}) ${i.name} — ${r?.detail || 'not evaluated'}${offenders ? ` :: ${offenders}` : ''}`;
  });
  const v = intents.filter((i) => i.lastResult?.status === 'violation').length;
  return `${v} violation(s) of ${intents.length} intents.\n${lines.join('\n')}`;
}
