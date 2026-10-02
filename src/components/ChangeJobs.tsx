import { useEffect, useMemo, useRef, useState } from 'react';
import {
  X,
  Play,
  Square,
  CheckSquare,
  Loader2,
  CheckCircle2,
  AlertCircle,
  Clock,
  KeyRound,
  RotateCcw,
  MinusCircle,
  Hand,
  ChevronDown,
  ChevronRight,
  Download,
  Upload,
  FlaskConical,
  ArrowLeft,
  ShieldCheck,
  ShieldOff,
  Search,
} from 'lucide-react';
import { invoke } from '@tauri-apps/api/tauri';
import { useSessionStore } from '../store/sessionStore';
import { useSettingsStore } from '../store/settingsStore';
import { askConfirm, useDialogStore } from '../store/dialogStore';
import { notify, useToastStore } from '../store/toastStore';
import { profileForSession } from '../utils/deviceProfiles';
import { sendAndCapture, sleep, stripAnsi } from '../utils/terminal';
import { endsAtPager, pagedCommand, pagerQuitKey, withPagingDisabled } from '../utils/paging';
import { runConfigSend, watchSessionOutput } from '../utils/configSafety';
import { captureRunningConfig } from '../utils/configArchive';
import { listNames } from '../utils/commandRisk';
import { formatChord } from '../utils/shortcuts';
import { hostSummary } from '../utils/hosts';
import { browserOpen, isTauri, tauriOpen, tauriReadText } from '../utils/fileSystem';
import type { ConnectOutcome } from '../utils/connect';
import {
  BUILTIN_VARIABLES,
  DEFAULT_JOB_OPTIONS,
  buildDevicePlan,
  clampMinutes,
  diffHunks,
  diffLines,
  findVariables,
  formatClock,
  parseVariableTable,
  promptState,
  resolveTargets,
  runDevice,
  savedHostId,
  deviceIdentity,
  runJob,
  toCsv,
  vendorSteps,
  type DeviceIO,
  type DevicePlan,
  type HoldDecision,
  type JobOptions,
  type JobRunResult,
  type JobStep,
  type JobTarget,
  type RowStatus,
  type SafetyWrapper,
  type SkipCause,
  type TargetPick,
} from '../utils/changeJobs';
import type { ConnectionConfig, DeviceProfile } from '../types';

interface ChangeJobsProps {
  /** App's connect path in non-interactive mode: never opens a login dialog. */
  onConnect: (config: ConnectionConfig) => Promise<ConnectOutcome>;
}

type Step = 'compose' | 'dry-run' | 'run';

interface PlannedDevice {
  target: JobTarget;
  plan: DevicePlan;
}

interface Row {
  key: string;
  name: string;
  host: string;
  vendor: string;
  wrapper: SafetyWrapper;
  canary: boolean;
  status: RowStatus;
  detail: string;
  steps: JobStep[];
  startedAt: number | null;
  endedAt: number | null;
  before: string | null;
  after: string | null;
  /** Rollback timer deadline while armed and not confirmed. */
  revertsAt: number | null;
}

interface Pause {
  key: string;
  name: string;
  armedUntil: number | null;
  others: number;
  wrapper: SafetyWrapper;
  saves: boolean;
}

// A saved host has this long to come up, then this long to show a prompt.
const CONNECT_TIMEOUT_MS = 45_000;
const PROMPT_TIMEOUT_MS = 25_000;

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const clockTime = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

const STATUS: Record<RowStatus, { label: string; color: string; icon: typeof Clock; spin?: boolean }> = {
  queued: { label: 'Queued', color: 'var(--text-muted)', icon: Clock },
  connecting: { label: 'Connecting…', color: 'var(--accent)', icon: Loader2, spin: true },
  running: { label: 'Running…', color: 'var(--accent)', icon: Loader2, spin: true },
  waiting: { label: 'Waiting for your OK', color: 'var(--accent-warning)', icon: Hand },
  ok: { label: 'OK', color: 'var(--accent-success)', icon: CheckCircle2 },
  error: { label: 'Error', color: 'var(--accent-danger)', icon: AlertCircle },
  skipped: { label: 'Skipped', color: 'var(--text-muted)', icon: MinusCircle },
  'needs-login': { label: 'Needs login', color: 'var(--accent-warning)', icon: KeyRound },
  'rolled-back': { label: 'Rolled back', color: 'var(--accent-warning)', icon: RotateCcw },
};

const PHASE_LABEL: Record<JobStep['phase'], string> = {
  'pre-check': 'Pre-check',
  capture: 'Capture',
  change: 'Change',
  'post-check': 'Post-check',
  confirm: 'Confirm',
  save: 'Save',
  cleanup: 'Cleanup',
};

function wrapperText(w: SafetyWrapper, minutes: number): string {
  if (w === 'checkpoint') return `checkpoint auto ${minutes} min`;
  if (w === 'commit-confirmed') return `commit confirmed ${minutes} min`;
  return 'no rollback timer';
}

const inputCls =
  'w-full px-3 py-2 bg-[var(--bg-primary)] border border-[var(--border)] rounded-lg text-xs text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:border-[var(--accent)] font-mono resize-y';
const btnCls =
  'flex items-center gap-1.5 px-3 h-8 text-xs rounded-lg transition-colors whitespace-nowrap disabled:opacity-40 disabled:cursor-not-allowed';
const btnPrimary = `${btnCls} bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-[var(--accent-fg)]`;
const btnSecondary = `${btnCls} bg-[var(--bg-tertiary)] hover:bg-[var(--border)] text-[var(--text-primary)]`;
const btnDanger = `${btnCls} border border-[var(--accent-danger)] text-[var(--accent-danger)] hover:bg-[var(--bg-tertiary)]`;

function Tick({ on, onClick, children, title }: { on: boolean; onClick: () => void; children: React.ReactNode; title?: string }) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={`w-full flex items-center gap-2 px-2 py-1 text-xs rounded text-left transition-colors ${
        on ? 'bg-[var(--accent-soft)] text-[var(--text-primary)]' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]'
      }`}
    >
      {on ? <CheckSquare size={12} className="flex-shrink-0 text-[var(--accent)]" /> : <Square size={12} className="flex-shrink-0" />}
      {children}
    </button>
  );
}

function SectionTitle({ children, hint }: { children: React.ReactNode; hint?: React.ReactNode }) {
  return (
    <div className="mb-1.5">
      <div className="text-[11px] font-semibold uppercase tracking-wide text-[var(--text-secondary)]">{children}</div>
      {hint && <div className="text-[10px] text-[var(--text-muted)] mt-0.5 leading-relaxed">{hint}</div>}
    </div>
  );
}

/** Before → after running-config diff, only the changed lines with context. */
function DiffView({ before, after }: { before: string | null; after: string | null }) {
  const diff = useMemo(() => (before != null && after != null ? diffLines(before, after) : null), [before, after]);
  const hunks = useMemo(() => (diff ? diffHunks(diff) : []), [diff]);
  if (!diff) {
    return (
      <p className="text-[11px] text-[var(--text-muted)]">
        No diff — the running config wasn&apos;t captured both before and after the change.
      </p>
    );
  }
  if (!diff.added && !diff.removed) {
    return <p className="text-[11px] text-[var(--text-muted)]">No difference in the running config.</p>;
  }
  return (
    <div>
      <div className="text-[11px] text-[var(--text-secondary)] mb-1">
        Running config: <span className="text-[var(--accent-success)]">+{diff.added}</span> /{' '}
        <span className="text-[var(--accent-danger)]">-{diff.removed}</span> lines
      </div>
      <pre className="max-h-64 overflow-auto rounded border border-[var(--border)] bg-[var(--bg-primary)] px-2 py-1 text-[11px] font-mono leading-snug">
        {hunks.map((l, i) =>
          l === null ? (
            <div key={i} className="text-[var(--text-muted)]">
              ⋯
            </div>
          ) : (
            <div
              key={i}
              className={
                l.kind === 'add'
                  ? 'text-[var(--accent-success)]'
                  : l.kind === 'del'
                    ? 'text-[var(--accent-danger)]'
                    : 'text-[var(--text-muted)]'
              }
            >
              {l.kind === 'add' ? '+ ' : l.kind === 'del' ? '- ' : '  '}
              {l.text}
            </div>
          )
        )}
      </pre>
    </div>
  );
}

/** One device's dry run: exactly what will be sent, phase by phase. */
function PlanCard({
  d,
  canary,
  open,
  onToggle,
  onMakeCanary,
  onLeaveOut,
}: {
  d: PlannedDevice;
  canary: boolean;
  open: boolean;
  onToggle: () => void;
  onMakeCanary: () => void;
  onLeaveOut: () => void;
}) {
  const { plan, target } = d;
  const risky = plan.change.filter((l) => l.fromBlock && (l.risky || l.dangerous)).length;
  const lineList = (lines: { text: string; fromBlock?: boolean; risky?: boolean; dangerous?: boolean }[]) => (
    <div className="font-mono text-[11px] leading-snug">
      {lines.map((l, i) => (
        <div key={i} className="flex items-baseline gap-2">
          <span className="w-6 text-right text-[var(--text-muted)] select-none">{i + 1}</span>
          <span
            className={
              l.dangerous
                ? 'text-[var(--accent-danger)]'
                : l.risky
                  ? 'text-[var(--accent-warning)]'
                  : l.fromBlock === false
                    ? 'text-[var(--text-muted)]'
                    : 'text-[var(--text-primary)]'
            }
          >
            {l.text}
          </span>
          {l.fromBlock === false && <span className="text-[9px] text-[var(--text-muted)]">added by the job</span>}
          {l.dangerous ? (
            <span className="text-[9px] uppercase text-[var(--accent-danger)]">dangerous</span>
          ) : l.risky ? (
            <span className="text-[9px] uppercase text-[var(--accent-warning)]">changes state</span>
          ) : null}
        </div>
      ))}
    </div>
  );
  const phase = (title: string, body: React.ReactNode) => (
    <div className="mt-2">
      <div className="text-[10px] uppercase tracking-wide text-[var(--text-secondary)] mb-0.5">{title}</div>
      {body}
    </div>
  );
  const checks = (list: DevicePlan['preChecks']) =>
    list.length ? (
      lineList(
        list.map((c) => ({ text: c.command + (c.expect ? `   ${c.expect.absent ? '!=>' : '=>'} ${c.expect.text}` : '') }))
      )
    ) : (
      <div className="text-[11px] text-[var(--text-muted)]">none</div>
    );
  return (
    <div
      className={`rounded-lg border ${
        plan.errors.length ? 'border-[var(--accent-danger)]' : canary ? 'border-[var(--accent)]' : 'border-[var(--border)]'
      }`}
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-3 py-2 bg-[var(--bg-primary)] rounded-t-lg">
        <button onClick={onToggle} className="text-[var(--text-secondary)] hover:text-[var(--text-primary)]">
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </button>
        <span className="text-xs font-medium text-[var(--text-primary)]">{target.name}</span>
        <span className="text-[10px] text-[var(--text-muted)]">{hostSummary(target.config)}</span>
        <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--bg-tertiary)] text-[var(--text-secondary)]">
          {plan.vendor.label}
        </span>
        <span
          className="flex items-center gap-1 text-[10px]"
          style={{ color: plan.wrapper === 'none' ? 'var(--text-muted)' : 'var(--accent-success)' }}
        >
          {plan.wrapper === 'none' ? <ShieldOff size={11} /> : <ShieldCheck size={11} />}
          {wrapperText(plan.wrapper, plan.confirmMinutes)}
        </span>
        {!target.sessionId && <span className="text-[10px] text-[var(--text-muted)]">· connects when its turn comes</span>}
        <span className="flex-1" />
        {plan.errors.length > 0 && (
          <span className="text-[10px] text-[var(--accent-danger)]">{plural(plan.errors.length, 'error')}</span>
        )}
        {risky > 0 && <span className="text-[10px] text-[var(--accent-warning)]">{plural(risky, 'risky line')}</span>}
        {canary ? (
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--accent)] text-[var(--accent-fg)]">Canary</span>
        ) : (
          <button
            onClick={onMakeCanary}
            disabled={plan.errors.length > 0}
            className="text-[10px] text-[var(--accent)] hover:underline disabled:opacity-40"
          >
            Use as canary
          </button>
        )}
        <button onClick={onLeaveOut} className="text-[10px] text-[var(--text-secondary)] hover:text-[var(--text-primary)]">
          Leave out
        </button>
      </div>
      {(open || plan.errors.length > 0) && (
        <div className="px-3 py-2">
          {plan.errors.map((e, i) => (
            <div key={i} className="text-[11px] text-[var(--accent-danger)]">
              ✕ {e}
            </div>
          ))}
          {plan.warnings.map((w, i) => (
            <div key={i} className="text-[11px] text-[var(--accent-warning)]">
              ! {w}
            </div>
          ))}
          {open && (
            <>
              {phase('1 · Pre-checks (must pass, or nothing is changed)', checks(plan.preChecks))}
              {phase(
                '2 · Capture the running config',
                <div className="text-[11px] text-[var(--text-muted)]">Saved to the config archive as “before-change”.</div>
              )}
              {phase('3 · Change — sent line by line, stopping at the first line the device rejects', lineList(plan.change))}
              {phase('4 · Post-checks', checks(plan.postChecks))}
              {phase(
                '5 · Capture the running config again',
                <div className="text-[11px] text-[var(--text-muted)]">Saved as “after-change”; the results show the diff.</div>
              )}
              {plan.confirm.length > 0 &&
                phase(
                  `6 · Confirm — only if every post-check passed (otherwise it rolls back on its own after ${plan.confirmMinutes} min)`,
                  lineList(plan.confirm)
                )}
              {plan.save.length > 0 &&
                phase(`${plan.confirm.length ? '7' : '6'} · Save — only if every post-check passed`, lineList(plan.save))}
              {plan.abort.length > 0 &&
                phase('If the device rejects a line', lineList(plan.abort.map((text) => ({ text, fromBlock: false }))))}
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ─── The live terminal side of a job (module-level: no component state) ───

/** Send lines through the Config Editor's stop-at-first-error loop. */
async function sendLinesTo(sessionId: string, lines: string[]) {
  const watcher = await watchSessionOutput(sessionId);
  try {
    const result = await runConfigSend(
      lines.map((text, i) => ({ text, lineNumber: i + 1 })),
      {
        send: (data) => invoke('send_data', { sessionId, data }),
        output: watcher.output,
        sleep,
        // A device is never stopped mid-block: a half-sent change is the
        // worst outcome. Stop takes effect between devices (and blocks confirms).
        cancelled: () => false,
        now: () => Date.now(),
      }
    );
    return { result, output: stripAnsi(watcher.output()).trim() };
  } finally {
    watcher.dispose();
  }
}

type Ready = { ok: true; sessionId: string } | { ok: false; status: 'needs-login' | 'error'; detail: string };

/** Wait until the session shows a plain exec prompt — never type into a
 *  banner, a question, a pager, a login or someone's open config session. */
async function waitForPrompt(sessionId: string, fresh: boolean): Promise<Ready> {
  const started = Date.now();
  let lastLen = -1;
  let stableSince = started;
  let nudged = false;
  let keyPresses = 0;
  const send = (data: string) => invoke('send_data', { sessionId, data }).catch(() => undefined);
  while (Date.now() - started < PROMPT_TIMEOUT_MS) {
    const raw = await invoke<string>('get_terminal_output', { sessionId }).catch(() => '');
    if (raw.length !== lastLen) {
      lastLen = raw.length;
      stableSince = Date.now();
    }
    // A fresh login prints a banner and may run startup commands: let it settle.
    const settled = Date.now() - stableSince >= (fresh ? 1500 : 400);
    const state = promptState(stripAnsi(raw.slice(-4000)));
    if (settled) {
      if (state === 'exec') return { ok: true, sessionId };
      if (state === 'config')
        return { ok: false, status: 'error', detail: 'The session is in config mode — leave it (end / exit) and run again.' };
      if (state === 'question')
        return { ok: false, status: 'error', detail: 'The session is waiting for an answer to a question — check its terminal.' };
      if (state === 'pager')
        return { ok: false, status: 'error', detail: 'The session is sitting at a --More-- prompt — quit it and run again.' };
      if (state === 'login') return { ok: false, status: 'needs-login', detail: 'The device is asking for a login in its terminal.' };
      if (state === 'press-key' && keyPresses < 2) {
        // AOS-S "Press any key to continue" after the banner.
        keyPresses++;
        await send('\r');
        stableSince = Date.now();
      } else if (state === 'unknown' && !nudged && (!fresh || Date.now() - started > 8000)) {
        // Ask for a fresh prompt once.
        nudged = true;
        await send('\r');
        stableSince = Date.now();
      }
    }
    await sleep(400);
  }
  return { ok: false, status: 'error', detail: 'No CLI prompt showed up (timed out).' };
}

/** The target's session, connected and at a prompt — connecting it through
 *  the app's normal connect path when needed. */
async function ensureSession(
  t: JobTarget,
  onConnect: (config: ConnectionConfig) => Promise<ConnectOutcome>
): Promise<Ready> {
  const all = () => useSessionStore.getState().sessions;
  // The tab picked at dry-run time; for a saved host that wasn't open then, a
  // tab of it opened since (connected first) — else connect it now.
  const tab = t.sessionId
    ? all().find((s) => s.sessionId === t.sessionId)
    : (() => {
        // Same saved host AND same address — see resolveTargets.
        const mine = all().filter(
          (s) => savedHostId(s.config) === t.config.id && deviceIdentity(s.config) === deviceIdentity(t.config)
        );
        return mine.find((s) => s.connected) ?? mine[0];
      })();
  let sessionId = tab?.sessionId ?? '';
  const fresh = !tab?.connected;
  if (fresh) {
    const outcome = await onConnect(tab?.config ?? t.config);
    if (outcome.status === 'needs-login') return { ok: false, status: 'needs-login', detail: outcome.reason };
    if (outcome.status === 'failed') return { ok: false, status: 'error', detail: `Could not connect: ${outcome.reason}` };
    // The connect decides which tab it used — don't assume it's the saved id.
    sessionId = outcome.sessionId;
    const find = () => all().find((s) => s.sessionId === sessionId);
    const started = Date.now();
    while (!find()?.connected) {
      if (Date.now() - started > CONNECT_TIMEOUT_MS)
        return { ok: false, status: 'needs-login', detail: 'Did not connect in time — it may be waiting for a login or the vault.' };
      await sleep(250);
    }
  }
  return waitForPrompt(sessionId, fresh);
}

/** The device runner's view of one live session. */
function sessionIO(sid: string, profile: DeviceProfile): DeviceIO {
  const session = () => useSessionStore.getState().sessions.find((s) => s.sessionId === sid);
  return {
    sendLines: (lines) => sendLinesTo(sid, lines),
    runCommand: async (command) => {
      const sent = pagedCommand(profile, command);
      const r = await sendAndCapture(sid, sent);
      if (endsAtPager(r.output)) {
        // Paging still on (unknown device type): quit the pager so the next
        // line doesn't land on --More--.
        await invoke('send_data', { sessionId: sid, data: pagerQuitKey(r.output) });
        await sleep(400);
      }
      return { ...r, sent };
    },
    captureConfig: async (when) => {
      const s = session();
      if (!s) return null;
      const got = await captureRunningConfig(s, when === 'before' ? 'before-change' : 'after-change', { pagingOff: true });
      return got && { content: got.content, truncated: got.truncated };
    },
    withPagingOff: (fn) => withPagingDisabled(sid, profile, fn),
    now: () => Date.now(),
  };
}

interface TargetRunContext {
  onConnect: (config: ConnectionConfig) => Promise<ConnectOutcome>;
  customProfiles: DeviceProfile[];
  setRow: (key: string, patch: Partial<Row>) => void;
  patchRow: (key: string, fn: (r: Row) => Row) => void;
  stopped: () => boolean;
  rollbackAsked: (key: string) => boolean;
  /** Canary only: the pause for the user's OK. */
  hold: (armedUntil: number | null) => Promise<HoldDecision>;
  /** Canary only: the user said to go on to the other devices. */
  proceed: () => boolean;
  /** Expand a row in the results. */
  reveal: (key: string) => void;
}

/** Connect (if needed), then run one device and keep its results row current. */
async function runTarget(d: PlannedDevice, isCanary: boolean, ctx: TargetRunContext): Promise<JobRunResult> {
  const key = d.target.key;
  ctx.setRow(key, { status: 'connecting', startedAt: Date.now() });
  const ready = await ensureSession(d.target, ctx.onConnect);
  if (!ready.ok) {
    ctx.setRow(key, { status: ready.status, detail: ready.detail, endedAt: Date.now() });
    if (isCanary) ctx.reveal(key);
    return { status: ready.status, touched: false };
  }
  if (ctx.stopped()) {
    ctx.setRow(key, { status: 'skipped', detail: 'The job was stopped before this device was changed.', endedAt: Date.now() });
    return { status: 'skipped', touched: false };
  }
  const sid = ready.sessionId;
  ctx.setRow(key, { status: 'running' });
  const live = useSessionStore.getState().sessions.find((s) => s.sessionId === sid);
  const profile = profileForSession(live?.config ?? d.target.config, ctx.customProfiles);
  const outcome = await runDevice(d.plan, sessionIO(sid, profile), {
    stopRequested: ctx.stopped,
    rollbackRequested: () => ctx.rollbackAsked(key),
    hold: isCanary ? ctx.hold : undefined,
    onStep: (st) => ctx.patchRow(key, (r) => ({ ...r, steps: [...r.steps, st] })),
    onArmed: (deadline) => ctx.setRow(key, { revertsAt: deadline }),
  });
  ctx.setRow(key, {
    status: outcome.status,
    detail: outcome.detail,
    before: outcome.before,
    after: outcome.after,
    revertsAt: outcome.revertsAt,
    endedAt: Date.now(),
  });
  if (isCanary && outcome.status !== 'ok') ctx.reveal(key);
  return { status: outcome.status, touched: outcome.touched, proceed: isCanary ? ctx.proceed() : undefined };
}

// Push one config change to many devices: compose → dry run → canary →
// (your OK) → the rest, stopping at the first failure.
export default function ChangeJobs({ onConnect }: ChangeJobsProps) {
  const showChangeJobs = useSessionStore((s) => s.showChangeJobs);
  const setShowChangeJobs = useSessionStore((s) => s.setShowChangeJobs);
  const folders = useSessionStore((s) => s.folders);
  const sessions = useSessionStore((s) => s.sessions);
  const customProfiles = useSettingsStore((s) => s.customDeviceProfiles);

  const [step, setStep] = useState<Step>('compose');
  // Compose
  const [block, setBlock] = useState('');
  const [preChecks, setPreChecks] = useState('');
  const [postChecks, setPostChecks] = useState('');
  const [varsText, setVarsText] = useState('');
  const [options, setOptions] = useState<JobOptions>(DEFAULT_JOB_OPTIONS);
  const [concurrency, setConcurrency] = useState(1);
  const [stopOnError, setStopOnError] = useState(true);
  // Targets
  const [pick, setPick] = useState<TargetPick>({ folders: [], tags: [], hosts: [], sessions: [] });
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [hostFilter, setHostFilter] = useState('');
  // Dry run
  const [dry, setDry] = useState<{ devices: PlannedDevice[]; tableErrors: string[] } | null>(null);
  const [canaryKey, setCanaryKey] = useState<string | null>(null);
  const [openPlans, setOpenPlans] = useState<Set<string>>(new Set());
  // Run
  const [rows, setRows] = useState<Row[]>([]);
  const [running, setRunning] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [summary, setSummary] = useState<string | null>(null);
  const [pause, setPause] = useState<Pause | null>(null);
  const [openRows, setOpenRows] = useState<Set<string>>(new Set());
  const [now, setNow] = useState(() => Date.now());
  const pauseResolve = useRef<((d: HoldDecision) => void) | null>(null);
  const pauseKeyRef = useRef<string | null>(null);
  const pauseToastRef = useRef<string | null>(null);
  const proceedRef = useRef(false);
  /** What the user chose at the canary pause (null: not asked yet). */
  const decisionRef = useRef<'continue' | 'keep-stop' | 'drop' | null>(null);
  const stopRef = useRef(false);
  const rollbackRef = useRef<Set<string>>(new Set());
  // Set from the Run click (before its confirm dialog) until the job ends, so
  // a double click can't start two jobs.
  const runLockRef = useRef(false);

  // Close on Escape — unless a confirm dialog is stacked above us. A running
  // job keeps going while the window is closed.
  useEffect(() => {
    if (!showChangeJobs) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || useDialogStore.getState().current) return;
      setShowChangeJobs(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [showChangeJobs, setShowChangeJobs]);

  // "Send safely" from the Config Editor: its block and device, ready for a
  // dry run. A running job is never replaced.
  const changeJobDraft = useSessionStore((s) => s.changeJobDraft);
  useEffect(() => {
    if (!showChangeJobs || !changeJobDraft) return;
    useSessionStore.getState().clearChangeJobDraft();
    if (running) {
      notify.info('A change job is running', 'Let it finish, then use Send safely again.');
      return;
    }
    setBlock(changeJobDraft.block);
    setPick({ folders: [], tags: [], hosts: [], sessions: [changeJobDraft.sessionId] });
    setExcluded(new Set());
    setDry(null);
    setSummary(null);
    setStep('compose');
    if (changeJobDraft.removed.length) {
      notify.info(
        'Left out lines the job adds itself',
        `${changeJobDraft.removed.join(', ')}. The job arms the rollback timer and commits for you.`
      );
    }
  }, [showChangeJobs, changeJobDraft, running]);

  // A canary pause nobody can see (window closed): a sticky toast leads back
  // to it; reopening the window clears it.
  useEffect(() => {
    if (showChangeJobs || !pause) {
      if (pauseToastRef.current) useToastStore.getState().dismiss(pauseToastRef.current);
      pauseToastRef.current = null;
      return;
    }
    if (pauseToastRef.current) return;
    pauseToastRef.current = notify.info(
      'Change job: your OK is needed',
      `${pause.name} (the canary) passed its checks.${pause.armedUntil ? ' If you do nothing, it rolls back on its own.' : ''}`,
      { duration: 0, action: { label: 'Review', run: () => useSessionStore.getState().setShowChangeJobs(true) } }
    );
  }, [showChangeJobs, pause]);

  // Countdowns and live durations.
  // `now` may be stale when idle; a stale (earlier) value only restarts the tick.
  const ticking = running || rows.some((r) => r.revertsAt != null && r.revertsAt > now);
  useEffect(() => {
    if (!showChangeJobs || !ticking) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [showChangeJobs, ticking]);

  const savedHosts = useMemo(
    () => folders.flatMap((f) => f.items).filter((h) => h.protocol !== 'local'),
    [folders]
  );
  const allTags = useMemo(
    () => [...new Set(savedHosts.flatMap((h) => h.tags ?? []))].sort((a, b) => a.localeCompare(b)),
    [savedHosts]
  );
  const openSessions = sessions.filter((s) => s.config.protocol !== 'local');
  const picked = useMemo(() => resolveTargets(folders, sessions, pick), [folders, sessions, pick]);
  const targets = useMemo(() => picked.filter((t) => !excluded.has(t.key)), [picked, excluded]);
  const deviceTypeOf = (t: JobTarget) => profileForSession(t.config, customProfiles).deviceType;
  // "3 AOS-CX, 2 Junos", and which of those vendors have no rollback timer.
  const { vendorMix, noTimer } = useMemo(() => {
    const counts = new Map<string, number>();
    const unprotected = new Set<string>();
    for (const t of targets) {
      const v = vendorSteps(profileForSession(t.config, customProfiles).deviceType);
      counts.set(v.label, (counts.get(v.label) ?? 0) + 1);
      if (v.wrapper === 'none') unprotected.add(v.label);
    }
    return {
      vendorMix: [...counts.entries()].map(([label, n]) => `${n} ${label}`).join(', '),
      noTimer: [...unprotected],
    };
  }, [targets, customProfiles]);
  const table = useMemo(() => (varsText.trim() ? parseVariableTable(varsText) : null), [varsText]);
  const usedVars = useMemo(
    () => findVariables([block, preChecks, postChecks].join('\n')).filter((v) => !BUILTIN_VARIABLES.includes(v.toLowerCase())),
    [block, preChecks, postChecks]
  );

  if (!showChangeJobs) return null;

  const toggleIn = (field: keyof TargetPick, id: string) =>
    setPick((p) => ({ ...p, [field]: p[field].includes(id) ? p[field].filter((x) => x !== id) : [...p[field], id] }));

  const hostMatches = (h: ConnectionConfig) => {
    const q = hostFilter.trim().toLowerCase();
    if (!q) return true;
    return [h.name, h.host ?? '', ...(h.tags ?? [])].some((v) => v.toLowerCase().includes(q));
  };

  const loadCsv = async () => {
    try {
      if (isTauri) {
        const path = await tauriOpen();
        if (path) setVarsText(await tauriReadText(path));
      } else {
        const f = await browserOpen();
        if (f) setVarsText(f.content);
      }
    } catch (e) {
      notify.error('Could not load the file', String(e));
    }
  };

  // ─── Dry run ───

  const dryRun = () => {
    if (!targets.length || !block.trim()) return;
    const devices = targets.map((target) => ({
      target,
      plan: buildDevicePlan({
        block,
        preChecks,
        postChecks,
        device: { name: target.name, host: target.config.host, deviceType: deviceTypeOf(target) },
        table,
        options,
      }),
    }));
    setDry({ devices, tableErrors: table?.errors ?? [] });
    const firstOk = devices.find((d) => !d.plan.errors.length) ?? devices[0];
    const keepCanary = devices.find((d) => d.target.key === canaryKey && !d.plan.errors.length);
    setCanaryKey((keepCanary ?? firstOk)?.target.key ?? null);
    // Small jobs: show every device's plan; big ones: just the canary's.
    setOpenPlans(new Set(devices.length <= 4 ? devices.map((d) => d.target.key) : [(keepCanary ?? firstOk).target.key]));
    setStep('dry-run');
  };

  const dryDevices = (dry?.devices ?? []).filter((d) => !excluded.has(d.target.key));
  const canary = dryDevices.find((d) => d.target.key === canaryKey) ?? dryDevices[0];
  const withErrors = dryDevices.filter((d) => d.plan.errors.length);
  const blockers = [
    ...(dry?.tableErrors.length ? ['Fix the variables table.'] : []),
    ...(withErrors.length ? [`Fix or leave out the ${plural(withErrors.length, 'device')} with errors.`] : []),
    ...(dryDevices.length === 0 ? ['No devices left in the job.'] : []),
  ];

  // ─── Running ───

  const patchRow = (key: string, fn: (r: Row) => Row) => setRows((prev) => prev.map((r) => (r.key === key ? fn(r) : r)));
  const setRow = (key: string, patch: Partial<Row>) => patchRow(key, (r) => ({ ...r, ...patch }));

  const holdForCanary = (d: PlannedDevice, armedUntil: number | null, others: number) =>
    new Promise<HoldDecision>((resolve) => {
      pauseResolve.current = resolve;
      pauseKeyRef.current = d.target.key;
      setRow(d.target.key, { status: 'waiting' });
      setOpenRows((prev) => new Set(prev).add(d.target.key));
      setPause({
        key: d.target.key,
        name: d.target.name,
        armedUntil,
        others,
        wrapper: d.plan.wrapper,
        saves: d.plan.save.length > 0,
      });
    });

  /** The canary pause buttons. */
  const decide = (choice: 'continue' | 'keep-stop' | 'drop') => {
    const resolve = pauseResolve.current;
    const key = pauseKeyRef.current;
    if (!resolve || !key) return;
    pauseResolve.current = null;
    pauseKeyRef.current = null;
    proceedRef.current = choice === 'continue';
    decisionRef.current = choice;
    setRow(key, { status: 'running' });
    setPause(null);
    resolve(choice === 'drop' ? 'drop' : 'keep');
  };

  const runOne = (d: PlannedDevice, isCanary: boolean, others: number) =>
    runTarget(d, isCanary, {
      onConnect,
      customProfiles,
      setRow,
      patchRow,
      stopped: () => stopRef.current,
      rollbackAsked: (key) => rollbackRef.current.has(key),
      hold: (armedUntil) => holdForCanary(d, armedUntil, others),
      proceed: () => proceedRef.current,
      reveal: (key) => setOpenRows((prev) => new Set(prev).add(key)),
    });

  const skipText = (cause: SkipCause, by?: PlannedDevice) =>
    cause === 'canary-failed'
      ? decisionRef.current === 'drop'
        ? 'Not run — you stopped the job at the canary.'
        : `Not run — the canary (${by?.target.name}) did not pass.`
      : cause === 'canary-stop'
        ? 'Not run — you stopped the job after the canary.'
        : cause === 'halted'
          ? `Not run — the job stopped after ${by?.target.name} failed.`
          : 'Not run — the job was stopped.';

  const run = async () => {
    if (runLockRef.current || running || blockers.length || !canary) return;
    runLockRef.current = true;
    try {
      await runLocked(canary);
    } finally {
      runLockRef.current = false;
    }
  };

  const runLocked = async (canary: PlannedDevice) => {
    // Snapshot exactly what the dry run showed.
    const order = [canary, ...dryDevices.filter((d) => d !== canary)];
    const blockOf = (pred: (l: DevicePlan['change'][number]) => boolean) => [
      ...new Set(order.flatMap((d) => d.plan.change.filter((l) => l.fromBlock && pred(l)).map((l) => l.text))),
    ];
    const risky = blockOf((l) => l.risky || l.dangerous);
    const dangerous = blockOf((l) => l.dangerous);
    const unprotected = order.filter((d) => d.plan.wrapper === 'none').map((d) => d.target.name);
    const n = order.length;
    const ok = await askConfirm({
      title: `Start the change job on ${plural(n, 'device')}?`,
      message: [
        `The canary, ${canary.target.name}, runs first and alone; then the job waits for your OK${n > 1 ? ` before touching the other ${n - 1}` : ''}.`,
        n > 1 ? `Devices: ${listNames(order.map((d) => d.target.name))}.` : '',
        dangerous.length ? `Dangerous lines: ${listNames(dangerous, 4)}.` : '',
        risky.length ? `Lines that change device state: ${listNames(risky, 4)}.` : '',
        unprotected.length ? `No rollback timer on: ${listNames(unprotected, 4)}.` : '',
      ]
        .filter(Boolean)
        .join(' '),
      confirmLabel: `Run on ${canary.target.name} first`,
      danger: risky.length > 0,
    });
    if (!ok) return;

    stopRef.current = false;
    proceedRef.current = false;
    decisionRef.current = null;
    rollbackRef.current = new Set();
    setStopping(false);
    setSummary(null);
    setPause(null);
    setOpenRows(new Set());
    setRows(
      order.map((d) => ({
        key: d.target.key,
        name: d.target.name,
        host: hostSummary(d.target.config),
        vendor: d.plan.vendor.label,
        wrapper: d.plan.wrapper,
        canary: d === canary,
        status: 'queued',
        detail: '',
        steps: [],
        startedAt: null,
        endedAt: null,
        before: null,
        after: null,
        revertsAt: null,
      }))
    );
    setStep('run');
    setRunning(true);
    let text = '';
    try {
      const result = await runJob({
        targets: order,
        concurrency,
        stopOnError,
        isStopped: () => stopRef.current,
        run: (d, isCanary) => runOne(d, isCanary, n - 1),
        skip: (d, cause, by) => setRow(d.target.key, { status: 'skipped', detail: skipText(cause, by) }),
      });
      text =
        result.end === 'canary-failed'
          ? decisionRef.current === 'drop'
            ? `You stopped at the canary (${canary.target.name}) without keeping its change — nothing else was touched.`
            : `The canary (${canary.target.name}) did not pass — nothing else was touched.`
          : result.end === 'halted'
            ? `Stopped after ${result.haltedBy?.target.name} failed.`
            : result.end === 'stopped'
              ? 'The job was stopped.'
              : 'The job finished.';
    } catch (e) {
      text = `The job stopped unexpectedly: ${String(e)}`;
    } finally {
      pauseResolve.current = null;
      pauseKeyRef.current = null;
      setPause(null);
      setRunning(false);
      setStopping(false);
    }
    setSummary(text);
    if (!useSessionStore.getState().showChangeJobs) {
      notify.info('Change job', text, {
        action: { label: 'Show results', run: () => useSessionStore.getState().setShowChangeJobs(true) },
      });
    }
  };

  const stopJob = () => {
    stopRef.current = true;
    setStopping(true);
    // Stopping at the canary pause means: don't keep it.
    if (pauseResolve.current) decide('drop');
  };

  const requestRollback = (key: string) => {
    rollbackRef.current.add(key);
    setRows((prev) => [...prev]);
  };

  const exportCsv = () => {
    const out = [['device', 'host', 'vendor', 'canary', 'status', 'duration_s', 'detail', 'config_diff', 'output']];
    for (const r of rows) {
      const diff =
        r.before != null && r.after != null
          ? diffLines(r.before, r.after)
              .lines.filter((l) => l.kind !== 'same')
              .map((l) => `${l.kind === 'add' ? '+' : '-'} ${l.text}`)
              .join('\n')
          : '';
      const output = r.steps
        .map(
          (st) =>
            `### ${PHASE_LABEL[st.phase]}: ${st.label}${st.ok ? '' : ' [FAILED]'}${st.note ? ` (${st.note})` : ''}\n${st.output}`
        )
        .join('\n\n');
      const secs = r.startedAt && r.endedAt ? ((r.endedAt - r.startedAt) / 1000).toFixed(1) : '';
      out.push([r.name, r.host, r.vendor, r.canary ? 'yes' : '', STATUS[r.status].label, secs, r.detail, diff, output]);
    }
    const blob = new Blob([toCsv(out)], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `change-job-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const countdown = (r: Row): string | null => {
    if (!r.revertsAt) return null;
    const left = r.revertsAt - now;
    if (left > 0) {
      return r.status === 'rolled-back' || r.status === 'error'
        ? `reverts in ${formatClock(left)}`
        : `rolls back in ${formatClock(left)} unless confirmed`;
    }
    return r.status === 'rolled-back' || r.status === 'error' ? `reverted on its own at ${clockTime(r.revertsAt)}` : null;
  };

  const done = rows.filter((r) => !['queued', 'connecting', 'running', 'waiting'].includes(r.status)).length;
  const modKey = formatChord('Mod+Enter');

  // ─── Views ───

  const composeView = (
    <div className="flex-1 grid grid-cols-[300px_1fr] gap-4 min-h-0">
      {/* Targets */}
      <div className="flex flex-col gap-3 min-h-0 overflow-y-auto pr-1">
        <div>
          <SectionTitle hint="Tabs already open — a disconnected one is reconnected when its turn comes.">
            Open sessions
          </SectionTitle>
          {openSessions.length === 0 ? (
            <p className="text-[11px] text-[var(--text-muted)]">None open.</p>
          ) : (
            openSessions.map((s) => (
              <Tick key={s.sessionId} on={pick.sessions.includes(s.sessionId)} onClick={() => toggleIn('sessions', s.sessionId)}>
                <span
                  className="w-1.5 h-1.5 rounded-full flex-shrink-0"
                  style={{ background: s.connected ? 'var(--accent-success)' : 'var(--text-muted)' }}
                />
                <span className="truncate">{s.config.name || s.config.host || 'Session'}</span>
                {s.config.protocol !== 'ssh' && s.config.protocol !== 'telnet' && (
                  <span className="text-[10px] text-[var(--text-muted)]">({s.config.protocol})</span>
                )}
              </Tick>
            ))
          )}
        </div>
        <div>
          <SectionTitle hint="Every SSH/Telnet host in the folder (serial consoles only when ticked by hand).">Folders</SectionTitle>
          {folders.map((f) => (
            <Tick key={f.id} on={pick.folders.includes(f.id)} onClick={() => toggleIn('folders', f.id)}>
              <span className="truncate">{f.name}</span>
              <span className="text-[10px] text-[var(--text-muted)]">({f.items.length})</span>
            </Tick>
          ))}
        </div>
        {allTags.length > 0 && (
          <div>
            <SectionTitle>Tags</SectionTitle>
            <div className="flex flex-wrap gap-1">
              {allTags.map((t) => {
                const on = pick.tags.includes(t);
                return (
                  <button
                    key={t}
                    onClick={() => toggleIn('tags', t)}
                    className={`px-2 py-0.5 text-[11px] rounded-full border transition-colors ${
                      on
                        ? 'bg-[var(--accent-soft)] border-[var(--accent)] text-[var(--text-primary)]'
                        : 'border-[var(--border)] text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]'
                    }`}
                  >
                    {t}
                  </button>
                );
              })}
            </div>
          </div>
        )}
        <div className="min-h-0">
          <SectionTitle>Saved hosts</SectionTitle>
          <div className="relative mb-1">
            <Search size={11} className="absolute left-2 top-1/2 -translate-y-1/2 text-[var(--text-muted)]" />
            <input
              value={hostFilter}
              onChange={(e) => setHostFilter(e.target.value)}
              placeholder="Filter by name, address or tag"
              className="w-full pl-6 pr-2 py-1 bg-[var(--bg-primary)] border border-[var(--border)] rounded text-[11px] text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:border-[var(--accent)]"
            />
          </div>
          <div className="max-h-56 overflow-y-auto">
            {savedHosts.filter(hostMatches).map((h) => (
              <Tick key={h.id} on={pick.hosts.includes(h.id)} onClick={() => toggleIn('hosts', h.id)}>
                <span className="truncate">{h.name || h.host}</span>
                <span className="text-[10px] text-[var(--text-muted)] truncate">{hostSummary(h)}</span>
              </Tick>
            ))}
            {savedHosts.length === 0 && <p className="text-[11px] text-[var(--text-muted)]">No saved hosts.</p>}
          </div>
        </div>
        <div className="mt-auto pt-2 border-t border-[var(--border)] text-[11px] text-[var(--text-secondary)]">
          <div className="font-medium text-[var(--text-primary)]">{plural(targets.length, 'device')} in this job</div>
          {vendorMix && <div>{vendorMix}</div>}
          {excluded.size > 0 && (
            <button onClick={() => setExcluded(new Set())} className="text-[var(--accent)] hover:underline">
              {plural(excluded.size, 'device')} left out — put back
            </button>
          )}
        </div>
      </div>

      {/* Compose */}
      <div className="flex flex-col gap-3 min-h-0 overflow-y-auto pr-1">
        <div>
          <SectionTitle
            hint={
              <>
                The lines to configure, as you would type them in config mode. The job enters config mode, commits or
                saves, and adds the rollback timer — the dry run shows every line. Use <code>{'${vlan}'}</code>-style
                placeholders filled per device from the variables table; <code>{'${name}'}</code> and{' '}
                <code>{'${host}'}</code> always work.
              </>
            }
          >
            Config change
          </SectionTitle>
          <textarea
            value={block}
            onChange={(e) => setBlock(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                dryRun();
              }
            }}
            rows={9}
            spellCheck={false}
            placeholder={'vlan ${vlan}\n  name ${vlan_name}\ninterface 1/1/1\n  vlan trunk allowed ${vlan}'}
            className={inputCls}
          />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <SectionTitle hint="Run before any change; if one fails, the device is left alone.">Pre-checks</SectionTitle>
            <textarea
              value={preChecks}
              onChange={(e) => setPreChecks(e.target.value)}
              rows={3}
              spellCheck={false}
              placeholder={'show version => 10.13'}
              className={inputCls}
            />
          </div>
          <div>
            <SectionTitle hint="Run after the change; if one fails, the change is not kept.">Post-checks</SectionTitle>
            <textarea
              value={postChecks}
              onChange={(e) => setPostChecks(e.target.value)}
              rows={3}
              spellCheck={false}
              placeholder={'show vlan ${vlan} => ${vlan_name}\nshow interface 1/1/1 !=> down'}
              className={inputCls}
            />
          </div>
          <p className="col-span-2 -mt-1 text-[10px] text-[var(--text-muted)]">
            Show commands, one per line. Add <code>=&gt; text</code> to require that text in the output, or{' '}
            <code>!=&gt; text</code> to require it is absent. A check also fails when the device rejects the command.
          </p>
        </div>
        <div>
          <SectionTitle
            hint="Paste CSV (or cells straight from a spreadsheet). First column: the device's name or address. Header row: the variable names."
          >
            Variables
          </SectionTitle>
          <div className="flex items-start gap-2">
            <textarea
              value={varsText}
              onChange={(e) => setVarsText(e.target.value)}
              rows={4}
              spellCheck={false}
              placeholder={'device,vlan,vlan_name\ncore-sw1,120,CAMERAS\n10.1.1.12,120,CAMERAS'}
              className={inputCls}
            />
            <button onClick={() => void loadCsv()} className={btnSecondary} title="Load a .csv file">
              <Upload size={12} />
              Load CSV…
            </button>
          </div>
          <div className="mt-1 text-[10px] text-[var(--text-muted)]">
            {table && (
              <span>
                {plural(table.rows.size, 'device')} · columns: {table.columns.join(', ') || '—'}
                {' · '}
              </span>
            )}
            {usedVars.length > 0 && (
              <span>
                The change uses:{' '}
                {usedVars.map((v, i) => {
                  const have = !!table?.columns.some((c) => c.toLowerCase() === v.toLowerCase());
                  return (
                    <span key={v} style={{ color: have ? 'var(--accent-success)' : 'var(--accent-warning)' }}>
                      {i > 0 && ', '}
                      {'${'}
                      {v}
                      {'}'}
                    </span>
                  );
                })}
              </span>
            )}
            {table?.errors.map((e, i) => (
              <div key={i} className="text-[var(--accent-danger)]">
                {e}
              </div>
            ))}
          </div>
        </div>
        <div className="rounded-lg border border-[var(--border)] p-3 space-y-2.5">
          <SectionTitle>Safety</SectionTitle>
          <label className="flex items-start gap-2 text-xs text-[var(--text-primary)]">
            <input
              type="checkbox"
              checked={options.safetyWrapper}
              onChange={(e) => setOptions((o) => ({ ...o, safetyWrapper: e.target.checked }))}
              className="mt-0.5"
            />
            <span>
              Use a rollback timer where the device has one:{' '}
              <input
                type="number"
                min={1}
                max={60}
                value={options.confirmMinutes}
                onChange={(e) => setOptions((o) => ({ ...o, confirmMinutes: clampMinutes(Number(e.target.value)) }))}
                className="w-12 px-1 py-0.5 bg-[var(--bg-primary)] border border-[var(--border)] rounded text-xs"
              />{' '}
              minutes
              <span className="block text-[10px] text-[var(--text-muted)] leading-relaxed">
                AOS-CX: <code>checkpoint auto</code> before the change, <code>checkpoint auto confirm</code> once the
                post-checks pass. Junos: <code>commit confirmed</code>, then a confirming <code>commit</code>. If a check
                fails, the job is stopped, or you click Roll back, the change is not confirmed and the device reverts on
                its own.
              </span>
              <span
                className="block text-[10px] leading-relaxed"
                style={{ color: noTimer.length ? 'var(--accent-warning)' : 'var(--text-muted)' }}
              >
                {noTimer.length
                  ? `No rollback timer on ${noTimer.join(', ')} in this job — changes there are live line by line.`
                  : 'AOS-S, ArubaOS 8, Instant APs and normal devices have no rollback timer — changes there are live line by line.'}
              </span>
            </span>
          </label>
          <label className="flex items-start gap-2 text-xs text-[var(--text-primary)]">
            <input
              type="checkbox"
              checked={options.save}
              onChange={(e) => setOptions((o) => ({ ...o, save: e.target.checked }))}
              className="mt-0.5"
            />
            <span>
              Save the config (<code>write memory</code>) once a device passes its checks
              <span className="block text-[10px] text-[var(--text-muted)]">
                AOS-CX, AOS-S and ArubaOS 8. A Junos commit is already saved; Instant APs apply with{' '}
                <code>commit apply</code>.
              </span>
            </span>
          </label>
          <div className="flex items-center gap-2 text-xs text-[var(--text-primary)]">
            After the canary, run the rest
            <select
              value={concurrency}
              onChange={(e) => setConcurrency(Number(e.target.value))}
              className="px-1.5 py-0.5 bg-[var(--bg-primary)] border border-[var(--border)] rounded text-xs"
            >
              <option value={1}>one at a time</option>
              <option value={2}>2 at once</option>
              <option value={4}>4 at once</option>
              <option value={6}>6 at once</option>
            </select>
          </div>
          <div className="text-xs text-[var(--text-primary)]">
            If a device&apos;s change fails:
            <label className="ml-2 inline-flex items-center gap-1">
              <input type="radio" checked={stopOnError} onChange={() => setStopOnError(true)} />
              stop the job
            </label>
            <label className="ml-3 inline-flex items-center gap-1">
              <input type="radio" checked={!stopOnError} onChange={() => setStopOnError(false)} />
              skip that device and keep going
            </label>
            <span className="block text-[10px] text-[var(--text-muted)]">
              Devices that can&apos;t be reached, need a login, or fail a pre-check are skipped either way — nothing was
              sent to them.
            </span>
          </div>
        </div>
      </div>
    </div>
  );

  const dryView = (
    <div className="flex-1 flex flex-col gap-2 min-h-0 overflow-y-auto pr-1">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-[var(--text-secondary)]">
        <span className="text-[var(--text-primary)] font-medium">Dry run — nothing has been sent.</span>
        <span>{plural(dryDevices.length, 'device')}</span>
        {canary && <span>Canary: {canary.target.name}</span>}
        {withErrors.length > 0 && (
          <>
            <span className="text-[var(--accent-danger)]">{plural(withErrors.length, 'device')} with errors</span>
            <button
              onClick={() => setExcluded((prev) => new Set([...prev, ...withErrors.map((d) => d.target.key)]))}
              className="text-[var(--accent)] hover:underline"
            >
              Leave those out
            </button>
          </>
        )}
      </div>
      <p className="text-[11px] text-[var(--text-muted)]">
        The canary runs first, alone. The job then waits for your OK before it touches any other device.
      </p>
      {dry?.tableErrors.map((e, i) => (
        <div key={i} className="text-[11px] text-[var(--accent-danger)]">
          Variables table: {e}
        </div>
      ))}
      {dryDevices.map((d) => (
        <PlanCard
          key={d.target.key}
          d={d}
          canary={d === canary}
          open={openPlans.has(d.target.key)}
          onToggle={() =>
            setOpenPlans((prev) => {
              const next = new Set(prev);
              if (next.has(d.target.key)) next.delete(d.target.key);
              else next.add(d.target.key);
              return next;
            })
          }
          onMakeCanary={() => setCanaryKey(d.target.key)}
          onLeaveOut={() => setExcluded((prev) => new Set(prev).add(d.target.key))}
        />
      ))}
    </div>
  );

  const pauseOver = pause?.armedUntil != null && pause.armedUntil - now <= 0;
  const pauseBanner = pause && (
    <div className="rounded-lg border-2 border-[var(--accent-warning)] bg-[var(--bg-primary)] px-4 py-3">
      <div className="text-sm font-medium text-[var(--text-primary)]">
        The canary, {pause.name}, passed its checks. Review its output and diff below.
      </div>
      <div className="text-xs text-[var(--text-secondary)] mt-0.5">
        {pauseOver
          ? 'The rollback timer ran out — the canary reverted on its own.'
          : pause.armedUntil
            ? `If you do nothing, it rolls back on its own in ${formatClock(pause.armedUntil - now)}.`
            : pause.saves
              ? 'The change is live but not saved yet.'
              : 'The change is live.'}
        {pause.others > 0 && ` The other ${plural(pause.others, 'device')} are waiting.`}
      </div>
      <div className="flex flex-wrap gap-2 mt-2">
        <button onClick={() => decide('continue')} disabled={pauseOver} className={btnPrimary}>
          <Play size={12} />
          {pause.wrapper !== 'none'
            ? pause.others > 0
              ? `Confirm and continue with the other ${pause.others}`
              : 'Confirm the change'
            : pause.saves
              ? pause.others > 0
                ? `Save and continue with the other ${pause.others}`
                : 'Save the change'
              : pause.others > 0
                ? `Continue with the other ${pause.others}`
                : 'Finish'}
        </button>
        {pause.others > 0 && (pause.wrapper !== 'none' || pause.saves) && (
          <button onClick={() => decide('keep-stop')} disabled={pauseOver} className={btnSecondary}>
            {pause.wrapper !== 'none' ? 'Confirm, but stop here' : 'Save, but stop here'}
          </button>
        )}
        {(pause.wrapper !== 'none' || pause.saves || pause.others > 0) && (
          <button onClick={() => decide('drop')} className={btnDanger}>
            {pause.wrapper !== 'none'
              ? pause.others > 0
                ? 'Roll back and stop'
                : 'Roll back'
              : pause.saves
                ? pause.others > 0
                  ? 'Stop without saving'
                  : "Don't save"
                : 'Stop'}
          </button>
        )}
      </div>
    </div>
  );

  const runView = (
    <div className="flex-1 flex flex-col gap-2 min-h-0 overflow-y-auto pr-1">
      {pauseBanner}
      {!pause && (running || summary) && (
        <div className="text-xs text-[var(--text-secondary)]">
          {running ? (
            <span className="flex items-center gap-1.5">
              <Loader2 size={12} className="animate-spin text-[var(--accent)]" />
              {stopping ? 'Stopping — devices already mid-change finish first…' : `Running — ${done} of ${rows.length} done.`}{' '}
              Closing this window doesn&apos;t stop the job.
            </span>
          ) : (
            <span className="text-[var(--text-primary)]">
              {summary}{' '}
              {(['ok', 'error', 'rolled-back', 'needs-login', 'skipped'] as RowStatus[])
                .map((s) => [s, rows.filter((r) => r.status === s).length] as const)
                .filter(([, n]) => n > 0)
                .map(([s, n]) => `${n} ${STATUS[s].label.toLowerCase()}`)
                .join(' · ')}
            </span>
          )}
        </div>
      )}
      <div className="rounded-lg border border-[var(--border)] overflow-hidden">
        <div className="grid grid-cols-[150px_1fr_110px_70px_minmax(0,2fr)_110px] gap-2 px-3 py-1.5 bg-[var(--bg-tertiary)] text-[10px] uppercase tracking-wide text-[var(--text-secondary)]">
          <span>Status</span>
          <span>Device</span>
          <span>Vendor</span>
          <span>Time</span>
          <span>Result</span>
          <span />
        </div>
        {rows.map((r) => {
          const meta = STATUS[r.status];
          const Icon = meta.icon;
          const open = openRows.has(r.key);
          const cd = countdown(r);
          const secs = r.startedAt ? ((r.endedAt ?? now) - r.startedAt) / 1000 : null;
          const canRollBack =
            r.revertsAt != null && r.revertsAt > now && (r.status === 'running' || r.status === 'waiting');
          const rbAsked = rollbackRef.current.has(r.key);
          return (
            <div key={r.key} className="border-t border-[var(--border)]">
              <div
                className="grid grid-cols-[150px_1fr_110px_70px_minmax(0,2fr)_110px] gap-2 px-3 py-1.5 items-center text-xs cursor-pointer hover:bg-[var(--bg-tertiary)]"
                onClick={() =>
                  setOpenRows((prev) => {
                    const next = new Set(prev);
                    if (next.has(r.key)) next.delete(r.key);
                    else next.add(r.key);
                    return next;
                  })
                }
              >
                <span className="flex items-center gap-1.5" style={{ color: meta.color }}>
                  {open ? <ChevronDown size={12} className="text-[var(--text-muted)]" /> : <ChevronRight size={12} className="text-[var(--text-muted)]" />}
                  <Icon size={12} className={meta.spin ? 'animate-spin' : ''} />
                  {meta.label}
                </span>
                <span className="truncate text-[var(--text-primary)]">
                  {r.name}
                  {r.canary && (
                    <span className="ml-1.5 text-[9px] px-1 py-0.5 rounded bg-[var(--accent)] text-[var(--accent-fg)]">canary</span>
                  )}
                </span>
                <span className="text-[var(--text-secondary)] truncate">{r.vendor}</span>
                <span className="text-[var(--text-secondary)] font-mono text-[11px]">
                  {secs != null ? formatClock(secs * 1000) : '—'}
                </span>
                <span className="text-[var(--text-secondary)] truncate" title={r.detail}>
                  {cd && <span className="text-[var(--accent-warning)] mr-1.5">{cd}</span>}
                  {r.detail}
                </span>
                <span className="text-right">
                  {canRollBack && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        if (r.status === 'waiting') decide('drop');
                        else requestRollback(r.key);
                      }}
                      disabled={rbAsked}
                      className="text-[11px] text-[var(--accent-danger)] hover:underline disabled:opacity-60"
                    >
                      {rbAsked ? 'Won’t confirm' : 'Roll back'}
                    </button>
                  )}
                </span>
              </div>
              {open && (
                <div className="px-3 pb-3 pt-1 space-y-2 bg-[var(--bg-secondary)]">
                  {r.host && <div className="text-[10px] text-[var(--text-muted)]">{r.host}</div>}
                  {r.detail && <div className="text-xs text-[var(--text-primary)]">{r.detail}</div>}
                  {r.steps.map((st, i) => (
                    <div key={i}>
                      <div className="flex items-center gap-2 text-[11px]">
                        <span className="text-[9px] uppercase tracking-wide px-1 py-0.5 rounded bg-[var(--bg-tertiary)] text-[var(--text-secondary)]">
                          {PHASE_LABEL[st.phase]}
                        </span>
                        <span className="font-mono text-[var(--text-primary)]">{st.label}</span>
                        {st.ok ? (
                          <CheckCircle2 size={11} className="text-[var(--accent-success)]" />
                        ) : (
                          <AlertCircle size={11} className="text-[var(--accent-danger)]" />
                        )}
                        {st.note && <span className="text-[var(--accent-warning)]">{st.note}</span>}
                      </div>
                      {st.output && (
                        <pre className="mt-0.5 max-h-40 overflow-auto rounded bg-[var(--bg-primary)] border border-[var(--border)] px-2 py-1 text-[11px] font-mono whitespace-pre-wrap break-all text-[var(--text-secondary)]">
                          {st.output}
                        </pre>
                      )}
                    </div>
                  ))}
                  {(r.before != null || r.after != null || ['ok', 'rolled-back'].includes(r.status)) && (
                    <DiffView before={r.before} after={r.after} />
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );

  const stepPill = (s: Step, n: number, label: string) => (
    <span
      className={`flex items-center gap-1.5 text-xs ${step === s ? 'text-[var(--accent)] font-medium' : 'text-[var(--text-muted)]'}`}
    >
      <span
        className={`w-4 h-4 rounded-full flex items-center justify-center text-[10px] ${
          step === s ? 'bg-[var(--accent)] text-[var(--accent-fg)]' : 'bg-[var(--bg-tertiary)]'
        }`}
      >
        {n}
      </span>
      {label}
    </span>
  );

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-[var(--scrim)] backdrop-blur-sm"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) setShowChangeJobs(false);
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Change Jobs"
        className="w-[1180px] max-w-[96vw] h-[88vh] bg-[var(--bg-secondary)] border border-[var(--border)] rounded-xl shadow-2xl flex flex-col"
      >
        <div className="flex items-center gap-4 px-5 py-3 border-b border-[var(--bg-tertiary)]">
          <div className="flex-1 min-w-0">
            <h2 className="text-lg font-semibold text-[var(--text-primary)]">Change Jobs</h2>
            <p className="text-[11px] text-[var(--text-muted)]">
              Push one config change to many devices: dry run first, one canary device, then the rest — stopping at the
              first failure.
            </p>
          </div>
          <div className="flex items-center gap-3">
            {stepPill('compose', 1, 'Compose')}
            <span className="text-[var(--text-muted)]">›</span>
            {stepPill('dry-run', 2, 'Dry run')}
            <span className="text-[var(--text-muted)]">›</span>
            {stepPill('run', 3, 'Run')}
          </div>
          <button
            onClick={() => setShowChangeJobs(false)}
            className="p-1 rounded hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
            title={running ? 'Close (the job keeps running)' : 'Close'}
          >
            <X size={18} />
          </button>
        </div>

        <div className="flex-1 min-h-0 flex flex-col px-5 py-3">
          {step === 'compose' ? composeView : step === 'dry-run' ? dryView : runView}
        </div>

        <div className="flex items-center gap-2 px-5 py-3 border-t border-[var(--bg-tertiary)]">
          {step === 'compose' && (
            <>
              <span className="text-[10px] text-[var(--text-muted)]">
                {modKey} in the config box runs the dry run · nothing is sent until you click Run
              </span>
              <span className="flex-1" />
              {rows.length > 0 && (
                <button onClick={() => setStep('run')} className={btnSecondary}>
                  Last results
                </button>
              )}
              <button onClick={dryRun} disabled={!targets.length || !block.trim()} className={btnPrimary}>
                <FlaskConical size={12} />
                Dry run
              </button>
            </>
          )}
          {step === 'dry-run' && (
            <>
              <button onClick={() => setStep('compose')} className={btnSecondary}>
                <ArrowLeft size={12} />
                Edit
              </button>
              <span className="flex-1 text-right text-[11px] text-[var(--accent-danger)]">{blockers.join(' ')}</span>
              <button
                onClick={() => void run()}
                disabled={running || blockers.length > 0 || !canary}
                className={btnPrimary}
                title="Runs on the canary first, then waits for your OK"
              >
                <Play size={12} />
                {canary ? `Run — ${canary.target.name} first` : 'Run'}
              </button>
            </>
          )}
          {step === 'run' && (
            <>
              <button onClick={() => setStep('compose')} disabled={running} className={btnSecondary}>
                <ArrowLeft size={12} />
                Edit and run again
              </button>
              <span className="flex-1" />
              {rows.length > 0 && (
                <button onClick={exportCsv} className={btnSecondary} title="Export the results as CSV">
                  <Download size={12} />
                  Export CSV
                </button>
              )}
              {running && (
                <button onClick={stopJob} disabled={stopping} className={btnDanger} title="No more devices start">
                  <Square size={12} />
                  {stopping ? 'Stopping…' : 'Stop job'}
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
