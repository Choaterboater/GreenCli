// Live show commands: the webview's end of greencli-mcp's channel.
//
// A program on this computer (Casper, Claude Code, another AI tool running
// greencli-mcp) asks GreenCLI to run one show line on a device tab that is
// already connected. GreenCLI's Rust side (src-tauri/src/mcp_live.rs) checks
// the line and hands it here as `mcp_live_request` {id, pid, op, tab|device,
// show}; the answer goes back with the `mcp_live_reply` command.
//
// - Only a plain show line (isPlainShow), on exactly one connected network
//   device tab (never a Linux, Windows or local shell tab).
// - The tab must sit at its normal prompt with nothing typed after it: not in
//   config mode, not at a pager, nothing half-typed. Checked before the box
//   and again right before the line is typed.
// - It waits its turn behind every other capture on that tab (the in-app AI,
//   config snapshots, bulk runs): from that last check until the tab is back
//   at its prompt, nothing else that captures can type in it, and the 45 s
//   check below counts the wait.
// - GreenCLI asks in a box with three buttons: No, Yes this once, and Yes,
//   show commands on <device> until GreenCLI closes (in memory, per device).
//   The box names the caller only as "a program on this computer (pid N)",
//   and shows the exact line typed (with any | no-more GreenCLI adds).
// - Time: GreenCLI's channel waits 60 s (LIVE_WAIT). The box closes on its own
//   at 40 s as a No, and a line is never typed after 45 s, so a Yes always
//   has time to run and answer before the wait ends.
// - Turning the switch off forgets every per-device answer, and any request
//   already handed over, or handed over later until it is back on, is refused
//   before its box or its line.
// - Each box has its own dialog group, so `mcp_live_cancel` (the program hung
//   up, the wait ran out, or the switch went off) closes just that one.
// - Paging is turned off around the line (AOS-CX/AOS-S `no page`, AOS-8
//   `no paging`, then back on), and Junos gets `| no-more`, the same as intent
//   checks. If the output still stops at a pager, GreenCLI sends the key that
//   pager names (q, or Ctrl+C on AOS-S) and marks the output cut short.
// - Secrets are hidden with the AI's secret filter (as prepareToolResult does
//   for terminal output), then the output is cut to 16 KB keeping the start
//   (prepareToolResult would keep the last 12,000 characters), and returned
//   as text: whatever it says, nothing in it is run.

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { askChoice, cancelDialogs, type DialogChoice } from '../store/dialogStore';
import { useMcpApprovalStore } from '../store/mcpApprovalStore';
import { useSessionStore } from '../store/sessionStore';
import { useSettingsStore } from '../store/settingsStore';
import type { DeviceType, Session } from '../types';
import { getDeviceId } from './configArchive';
import { profileForSession } from './deviceProfiles';
import { parseDevicePrompt, trailingLine } from './devicePrompt';
import { isPlainShow } from './mcpPresets';
import { endsAtPager, pagedCommand, pagerQuitKey, pagingCommands, withPagingDisabled } from './paging';
import { MAX_SCRUB_CHARS, WITHHELD_TEXT } from './secrets/forAi';
import { secretFilterSupported } from './secrets/support';
import { CAPTURE_MAX_MS, captureInTurn, sleep, withCaptureTurn } from './terminal';

/** The approval store key for answer 3 (with the device). */
export const LIVE_SERVER = 'greencli-mcp';
export const LIVE_TOOL = 'device_show';
/** The most output sent back, in bytes (GreenCLI's Rust side cuts there too). */
export const MAX_LIVE_OUTPUT = 16 * 1024;

/** How long GreenCLI's channel and greencli-mcp wait (LIVE_WAIT in greencli-mcp/src/lib.rs). */
export const LIVE_WAIT_MS = 60_000;
/** The box closes on its own after this, answered as No. */
export const LIVE_BOX_WAIT_MS = 40_000;
/** A line is never typed later than this after the request came in. */
export const LIVE_TYPE_BY_MS = 45_000;
/** Paging off and back on (withPagingDisabled's waits). */
const PAGING_MS = 300 + 150;
/** backAtPrompt: this many looks, this far apart. */
const PROMPT_LOOKS = 5;
const PROMPT_LOOK_MS = 200;
/** The longest a run takes once it starts typing: paging, the capture, back at the prompt, and
 *  room for the secret filter and the calls in between. */
export const LIVE_RUN_MAX_MS = PAGING_MS + CAPTURE_MAX_MS + PROMPT_LOOKS * PROMPT_LOOK_MS + 1_500;

/** Device types show commands may run on: switches, routers, gateways and APs. */
const NETWORK_TYPES: ReadonlySet<DeviceType> = new Set<DeviceType>([
  'aruba-cx',
  'aruba-aos-s',
  'aruba-ap',
  'aruba-controller',
  'juniper-junos',
  'mist',
]);

export interface LiveRequest {
  id: string;
  pid: number | null;
  op: 'sessions' | 'show';
  tab?: string;
  device?: string;
  show?: string;
}

export interface LiveDevice {
  tabId: string;
  name: string;
  type: string;
}

export type LiveReply =
  | { ok: true; devices: LiveDevice[] }
  | { ok: true; output: string; truncated: boolean }
  | { ok: false; error: string };

const no = (error: string): LiveReply => ({ ok: false, error });

const NOT_PLAIN =
  'Only a plain show line can run: one line that starts with show, with only filters such as include, exclude, begin, section or count after |.';
const NOT_NETWORK =
  'That tab is not a network device. Show commands run only on switch, router, gateway and access point tabs, never on a computer or shell tab.';
const CONFIG_MODE = 'That tab is in config mode. Leave config mode in GreenCLI, then try again.';
const NOT_IDLE =
  "That tab isn't at its prompt, or something is typed in it. Finish or clear it in GreenCLI, then try again.";
const UNKNOWN = "GreenCLI doesn't know that request. Update GreenCLI and greencli-mcp.";
const SAID_NO = 'You said no in GreenCLI. Nothing ran.';
const STOPPED = 'The request ended before it ran. Nothing ran.';
const BOX_TIMED_OUT = 'No answer in GreenCLI in time; nothing ran.';
const TOO_LATE = 'Too late to run it before the AI tool stops waiting. Nothing ran. Try again.';
const TURNED_OFF = 'Show commands were turned off in GreenCLI.';

/** Connected network device tabs. */
function liveTabs(sessions: Session[]): Session[] {
  return sessions.filter((s) => s.connected && isNetworkTab(s));
}

function isNetworkTab(s: Session): boolean {
  return s.config.protocol !== 'local' && NETWORK_TYPES.has(s.config.deviceType);
}

/** What list_connected_devices returns: tabId, name and type only. */
export function liveDevices(sessions: Session[]): LiveDevice[] {
  return liveTabs(sessions).map((s) => ({ tabId: s.sessionId, name: getDeviceId(s), type: s.config.deviceType }));
}

/** The one tab a request means, or why there isn't exactly one. */
function findTab(sessions: Session[], req: LiveRequest): Session | string {
  const byTab = req.tab !== undefined;
  const target = (byTab ? req.tab : req.device)?.trim() ?? '';
  const same = (s: Session) =>
    byTab ? s.sessionId === target : getDeviceId(s).toLowerCase() === target.toLowerCase();
  const matches = sessions.filter(same);
  const live = liveTabs(matches);
  if (live.length === 1) return live[0];
  if (live.length > 1) {
    return `Two tabs or more are connected to ${target}. Use a tabId from list_connected_devices.`;
  }
  if (matches.some((s) => s.connected)) return NOT_NETWORK;
  if (matches.length) return `That tab isn't connected. Connect it in GreenCLI, then try again.`;
  return byTab
    ? 'No open tab has that tabId. Use list_connected_devices to see the tabs.'
    : `No tab is connected to ${target}. Connect to it in GreenCLI, then try again.`;
}

/** Null when the tab sits at its normal prompt with nothing typed after it. */
async function idleProblem(session: Session): Promise<string | null> {
  if (session.configMode) return CONFIG_MODE;
  const buffer = await invoke<string>('get_terminal_output', { sessionId: session.sessionId });
  const prompt = parseDevicePrompt(trailingLine(buffer ?? ''));
  if (!prompt) return NOT_IDLE;
  return prompt.configMode ? CONFIG_MODE : null;
}

/** Wait a little for the tab to be back at its prompt (after a pager quit or
 *  the paging restore), so the next request finds it idle. */
async function backAtPrompt(sessionId: string): Promise<void> {
  for (let i = 0; i < PROMPT_LOOKS; i++) {
    const buffer = await invoke<string>('get_terminal_output', { sessionId }).catch(() => '');
    if (parseDevicePrompt(trailingLine(buffer ?? ''))) return;
    await sleep(PROMPT_LOOK_MS);
  }
}

/** Room kept under MAX_LIVE_OUTPUT for the notes and greencli-mcp's JSON escapes. */
const LIVE_ROOM = 2 * 1024;
const CUT_NOTE = '[cut at 16 KB: this is the start of the output]';

/** The device echoes the line first; output without the echo may start inside
 *  a config block, so the filter is told its head may be cut. */
function startsWithEcho(output: string, command: string): boolean {
  const firstLine = output.trimStart().split('\n', 1)[0] ?? '';
  return firstLine.includes(command.trim());
}

/** The output with secrets hidden and cut to fit, keeping the start; null
 *  when the secret filter can't run here (then nothing is sent back). */
async function hideAndCut(
  output: string,
  command: string,
): Promise<{ text: string; cut: boolean } | null> {
  if (!output) return { text: `\`${command}\` was sent, but no output came back.`, cut: false };
  try {
    if (!secretFilterSupported()) return null;
    const engine = await import('./secrets/engine');
    // Never reached in practice (the terminal keeps far less), but a cap keeps the filter quick.
    const sliced = output.length > MAX_SCRUB_CHARS;
    const input = sliced ? output.slice(0, MAX_SCRUB_CHARS) : output;
    const result = engine.scrubForAi(input, { cutHead: !startsWithEcho(input, command) });
    const hint = result.hidden ? engine.defaultCommunityHint(input) : undefined;
    const room = MAX_LIVE_OUTPUT - LIVE_ROOM - (hint ? hint.length + 1 : 0);
    const [head, cut] = capBytes(result.text, room);
    const body = cut || sliced ? `${CUT_NOTE}\n${head}` : head;
    return { text: hint ? `${body}\n${hint}` : body, cut: cut || sliced };
  } catch {
    return null;
  }
}

/** Cut to at most `max` UTF-8 bytes, on a character boundary. */
function capBytes(text: string, max: number): [string, boolean] {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= max) return [text, false];
  let cut = new TextDecoder().decode(bytes.slice(0, max));
  // A character split at the cut decodes as U+FFFD: drop it.
  if (cut.endsWith('�')) cut = cut.slice(0, -1);
  return [cut, true];
}

// Requests in flight, and the ones whose program stopped waiting.
const active = new Set<string>();
const cancelled = new Set<string>();

const boxGroup = (id: string) => `mcp-live:${id}`;

/** The program stopped waiting for `id`: close its box and run nothing. */
export function cancelLiveRequest(id: string): void {
  if (active.has(id)) cancelled.add(id);
  cancelDialogs(boxGroup(id));
}

// The switch went off: requests are refused until it is turned back on.
let switchedOff = false;

/** The switch went off: forget every "Yes, show commands on <device>" answer, and refuse every
 *  request already handed over (its box closes; a line not typed yet never is) or handed over
 *  later, until resumeLiveRequests. */
export function stopLiveRequests(): void {
  switchedOff = true;
  useMcpApprovalStore.getState().clearDevices();
  for (const id of [...active]) cancelLiveRequest(id);
}

/** The switch is on again: take requests as usual. */
export function resumeLiveRequests(): void {
  switchedOff = false;
}

/** True while requests are refused because the switch went off. */
export function liveRequestsStopped(): boolean {
  return switchedOff;
}

function choices(name: string): DialogChoice[] {
  return [
    { value: 'no', label: 'No', detail: 'Nothing runs', tone: 'plain' },
    { value: 'once', label: 'Yes, this once', detail: 'Runs this line only', tone: 'accent' },
    {
      value: 'device',
      label: `Yes, show commands on ${name} until GreenCLI closes`,
      detail: "Won't ask again for show lines on this device",
      tone: 'accent',
    },
  ];
}

/** The answer, or 'late' when the box closed on its own at LIVE_BOX_WAIT_MS. */
async function ask(
  req: LiveRequest,
  name: string,
  command: string,
  paging: { disable?: string; restore?: string },
): Promise<'once' | 'device' | 'late' | null> {
  const who = req.pid != null ? `a program on this computer (pid ${req.pid})` : 'a program on this computer';
  const parts = [
    paging.disable && `\`${paging.disable}\` before it`,
    paging.restore && `\`${paging.restore}\` after`,
  ].filter(Boolean);
  const around = parts.length ? ` It also types ${parts.join(' and ')}.` : '';
  let late = false;
  const timer = setTimeout(() => {
    late = true;
    cancelDialogs(boxGroup(req.id));
  }, LIVE_BOX_WAIT_MS);
  try {
    const value = await askChoice({
      group: boxGroup(req.id),
      title: `Run a show command on ${name}?`,
      message: `Asked by ${who}. GreenCLI types this line in your open tab and sends the output back with secrets hidden.${around}`,
      details: command,
      detailsLabel: 'Show line',
      choices: choices(name),
    });
    if (late) return 'late';
    return value === 'once' || value === 'device' ? value : null;
  } finally {
    clearTimeout(timer);
  }
}

async function runShow(req: LiveRequest, started: number): Promise<LiveReply> {
  const line = req.show ?? '';
  if (!isPlainShow(line)) return no(NOT_PLAIN);
  if ((req.tab === undefined) === (req.device === undefined)) {
    return no('A show command needs one tab or one device.');
  }
  const found = findTab(useSessionStore.getState().sessions, req);
  if (typeof found === 'string') return no(found);
  const session = found;
  const name = getDeviceId(session);

  const before = await idleProblem(session);
  if (before) return no(before);
  if (cancelled.has(req.id)) return no(STOPPED);

  // The exact line typed (Junos gets | no-more): what the box shows is what runs.
  const profile = profileForSession(session.config, useSettingsStore.getState().customDeviceProfiles);
  const command = pagedCommand(profile, line);

  const approvals = useMcpApprovalStore.getState();
  if (!approvals.isDeviceAllowed(LIVE_SERVER, LIVE_TOOL, name)) {
    const answer = await ask(req, name, command, pagingCommands(profile));
    if (answer === 'late') return no(BOX_TIMED_OUT);
    if (cancelled.has(req.id)) return no(STOPPED);
    if (!answer) return no(SAID_NO);
    if (answer === 'device') useMcpApprovalStore.getState().allowDevice(LIVE_SERVER, LIVE_TOOL, name);
  }

  // Behind every other capture on this tab (the in-app AI, config snapshots,
  // other live requests), so nothing is typed into their output.
  const ran = await withCaptureTurn(session.sessionId, async () => {
    // The box may have been open a while, and another capture may just have
    // used this tab: it must still be idle and connected right before typing.
    const now = useSessionStore.getState().sessions.find((s) => s.sessionId === session.sessionId);
    if (!now?.connected) return `That tab isn't connected any more. Nothing ran.`;
    const after = await idleProblem(now);
    if (after) return after;
    if (cancelled.has(req.id)) return STOPPED;
    // Too late to finish before the program stops waiting: never start typing.
    if (Date.now() - started > LIVE_TYPE_BY_MS) return TOO_LATE;

    const capture = await withPagingDisabled(now.sessionId, profile, async () => {
      const c = await captureInTurn(now.sessionId, command);
      // Leave a pager so the next key isn't eaten by it.
      if (endsAtPager(c.output)) {
        await invoke('send_data', { sessionId: now.sessionId, data: pagerQuitKey(c.output) }).catch(() => undefined);
      }
      return c;
    });
    await backAtPrompt(now.sessionId);
    return { capture };
  });
  if (typeof ran === 'string') return no(ran);

  const { capture } = ran;
  const pager = endsAtPager(capture.output);
  const hidden = await hideAndCut(capture.output, command);
  if (!hidden) return no(WITHHELD_TEXT);
  const [output, cut] = capBytes(hidden.text, MAX_LIVE_OUTPUT);
  return { ok: true, output, truncated: capture.truncated || pager || hidden.cut || cut };
}

/** Answer one request from greencli-mcp. Never throws. */
export async function handleLiveRequest(req: LiveRequest): Promise<LiveReply> {
  const started = Date.now();
  active.add(req.id);
  try {
    if (req.op === 'sessions') return { ok: true, devices: liveDevices(useSessionStore.getState().sessions) };
    if (req.op === 'show') return switchedOff ? no(TURNED_OFF) : await runShow(req, started);
    return no(UNKNOWN);
  } catch (e) {
    return no(`GreenCLI couldn't run it: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    active.delete(req.id);
    cancelled.delete(req.id);
  }
}

/** Only the fields a request may have, each with the right type. */
function readRequest(payload: unknown): LiveRequest | null {
  if (!payload || typeof payload !== 'object') return null;
  const p = payload as Record<string, unknown>;
  if (typeof p.id !== 'string' || (p.op !== 'sessions' && p.op !== 'show')) return null;
  const text = (v: unknown) => (typeof v === 'string' ? v : undefined);
  return {
    id: p.id,
    pid: typeof p.pid === 'number' ? p.pid : null,
    op: p.op,
    tab: text(p.tab),
    device: text(p.device),
    show: text(p.show),
  };
}

/** Listen for requests from greencli-mcp (main window only). Returns stop. */
export function startMcpLive(): () => void {
  const onRequest = listen<unknown>('mcp_live_request', (e) => {
    const req = readRequest(e.payload);
    const id = (e.payload as { id?: unknown } | null)?.id;
    if (typeof id !== 'string') return;
    const reply = req ? handleLiveRequest(req) : Promise.resolve(no(UNKNOWN));
    void reply.then((answer) => invoke('mcp_live_reply', { id, reply: answer })).catch(() => undefined);
  }).catch(() => () => {}); // outside the app: nothing to stop
  const onCancel = listen<{ id?: unknown }>('mcp_live_cancel', (e) => {
    if (typeof e.payload?.id === 'string') cancelLiveRequest(e.payload.id);
  }).catch(() => () => {});
  return () => {
    void onRequest.then((f) => f());
    void onCancel.then((f) => f());
  };
}
