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
// - GreenCLI asks: 1 No, 2 Yes this once, 3 Yes, show commands on this device
//   until GreenCLI closes (in memory, per device). The box names the caller
//   only as "a program on this computer (pid N)".
// - Each box has its own dialog group, so `mcp_live_cancel` (the program hung
//   up, the wait ran out, or the switch went off) closes just that one.
// - Junos gets `| no-more`. If the output still stops at a pager, GreenCLI
//   sends q so the tab isn't left stuck, and marks the output cut short.
// - The output goes through prepareToolResult (secrets hidden, capped) and is
//   returned as text: whatever it says, nothing in it is run.

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { askChoice, cancelDialogs, type DialogChoice } from '../store/dialogStore';
import { useMcpApprovalStore } from '../store/mcpApprovalStore';
import { useSessionStore } from '../store/sessionStore';
import type { DeviceType, Session } from '../types';
import { getDeviceId } from './configArchive';
import { parseDevicePrompt, trailingLine } from './devicePrompt';
import { isPlainShow } from './mcpPresets';
import { endsAtPager } from './paging';
import { prepareToolResult, rawTerminal } from './secrets/forAi';
import { sendAndCapture } from './terminal';

/** The approval store key for answer 3 (with the device). */
export const LIVE_SERVER = 'greencli-mcp';
export const LIVE_TOOL = 'device_show';
/** The most output sent back, in bytes (GreenCLI's Rust side cuts there too). */
export const MAX_LIVE_OUTPUT = 16 * 1024;

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

/** Junos pages show output unless `| no-more` is on the line. */
function withoutPager(session: Session, line: string): string {
  const junos = session.config.deviceType === 'juniper-junos' || session.config.deviceType === 'mist';
  return junos && !/\|\s*no-more\b/.test(line) ? `${line} | no-more` : line;
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

async function ask(req: LiveRequest, name: string, line: string): Promise<'once' | 'device' | null> {
  const who = req.pid != null ? `a program on this computer (pid ${req.pid})` : 'a program on this computer';
  const value = await askChoice({
    group: boxGroup(req.id),
    title: `Run a show command on ${name}?`,
    message: `Asked by ${who}. GreenCLI types this line in your open tab and sends the output back with secrets hidden.`,
    details: line,
    detailsLabel: 'Show line',
    choices: choices(name),
  });
  return value === 'once' || value === 'device' ? value : null;
}

async function runShow(req: LiveRequest): Promise<LiveReply> {
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

  const approvals = useMcpApprovalStore.getState();
  if (!approvals.isDeviceAllowed(LIVE_SERVER, LIVE_TOOL, name)) {
    const answer = await ask(req, name, line);
    if (cancelled.has(req.id)) return no(STOPPED);
    if (!answer) return no(SAID_NO);
    if (answer === 'device') useMcpApprovalStore.getState().allowDevice(LIVE_SERVER, LIVE_TOOL, name);
  }

  // The box may have been open a while: the tab must still be idle and connected.
  const now = useSessionStore.getState().sessions.find((s) => s.sessionId === session.sessionId);
  if (!now?.connected) return no(`That tab isn't connected any more. Nothing ran.`);
  const after = await idleProblem(now);
  if (after) return no(after);
  if (cancelled.has(req.id)) return no(STOPPED);

  const command = withoutPager(now, line);
  const capture = await sendAndCapture(now.sessionId, command);
  const pager = endsAtPager(capture.output);
  // Leave the pager so the next key you press isn't eaten by it.
  if (pager) await invoke('send_data', { sessionId: now.sessionId, data: 'q' }).catch(() => undefined);
  const prepared = await prepareToolResult(rawTerminal(capture.output, command, capture.truncated || pager));
  if (prepared.isError) return no(prepared.text);
  const [output, cut] = capBytes(prepared.text, MAX_LIVE_OUTPUT);
  const capped = prepared.text.startsWith('…(truncated)…') || prepared.text.includes('\n…(truncated)…\n');
  return { ok: true, output, truncated: capture.truncated || pager || capped || cut };
}

/** Answer one request from greencli-mcp. Never throws. */
export async function handleLiveRequest(req: LiveRequest): Promise<LiveReply> {
  active.add(req.id);
  try {
    if (req.op === 'sessions') return { ok: true, devices: liveDevices(useSessionStore.getState().sessions) };
    if (req.op === 'show') return await runShow(req);
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
