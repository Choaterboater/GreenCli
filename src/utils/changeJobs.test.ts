import { describe, it, expect, vi } from 'vitest';

vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }));
vi.mock('@tauri-apps/api/tauri', () => ({ invoke: vi.fn() }));

import {
  jobBlockFromEditor,
  parseCsv,
  toCsv,
  parseVariableTable,
  findVariables,
  substitute,
  deviceVariables,
  parseChecks,
  evaluateCheck,
  buildDevicePlan,
  resolveTargets,
  savedHostId,
  promptState,
  diffLines,
  diffHunks,
  runDevice,
  runJob,
  formatClock,
  DEFAULT_JOB_OPTIONS,
  type DeviceIO,
  type DeviceControl,
  type DevicePlan,
  type JobStep,
  type PlanInput,
  type JobRunResult,
} from './changeJobs';
import { runConfigSend, type SendIO } from './configSafety';
import type { ConnectionConfig, Session, SessionFolder } from '../types';

describe('parseCsv', () => {
  it('handles quotes, escaped quotes, commas and newlines inside quotes', () => {
    expect(parseCsv('device,desc\nsw1,"uplink, core"\nsw2,"say ""hi"""\nsw3,"two\nlines"')).toEqual([
      ['device', 'desc'],
      ['sw1', 'uplink, core'],
      ['sw2', 'say "hi"'],
      ['sw3', 'two\nlines'],
    ]);
  });

  it('reads tab-separated text pasted from a spreadsheet, and ; from European Excel', () => {
    expect(parseCsv('device\tvlan\r\nsw1\t10\r\n')).toEqual([
      ['device', 'vlan'],
      ['sw1', '10'],
    ]);
    expect(parseCsv('device;vlan\nsw1;10')).toEqual([
      ['device', 'vlan'],
      ['sw1', '10'],
    ]);
  });

  it('drops a BOM, trims unquoted cells, keeps quoted spaces, skips blank rows', () => {
    expect(parseCsv('\uFEFFdevice , vlan\n\n sw1 ," 10 "\n,\n')).toEqual([
      ['device', 'vlan'],
      ['sw1', ' 10 '],
    ]);
  });

  it('writes CSV that cannot run as a spreadsheet formula', () => {
    expect(toCsv([['device', 'output'], ['sw1', '=cmd()'], ['sw2', 'a "b"']])).toBe(
      '"device","output"\n"sw1","\'=cmd()"\n"sw2","a ""b"""'
    );
  });
});

describe('variables', () => {
  const table = parseVariableTable('device,vlan,Name\nsw1,10,MGMT\n10.0.0.2,20,USERS\nsw3,,EMPTY');

  it('keys rows by the first column and variables by the header', () => {
    expect(table.errors).toEqual([]);
    expect(table.keyColumn).toBe('device');
    expect(table.rows.get('sw1')).toEqual({ device: 'sw1', vlan: '10', name: 'MGMT' });
  });

  it('matches a device by name, then by host', () => {
    expect(deviceVariables(table, { name: 'SW1' }).row?.vlan).toBe('10');
    expect(deviceVariables(table, { name: 'access-2', host: '10.0.0.2' }).row?.vlan).toBe('20');
    expect(deviceVariables(table, { name: 'nope', host: '10.9.9.9' }).row).toBeNull();
    // Built-ins are always there; a column of the same name wins.
    expect(deviceVariables(null, { name: 'sw9', host: '10.0.0.9' }).values).toEqual({ name: 'sw9', host: '10.0.0.9' });
    expect(deviceVariables(table, { name: 'sw1' }).values.name).toBe('MGMT');
  });

  it('reports bad headers, duplicate devices and rows without a device', () => {
    const bad = parseVariableTable('device,mgmt ip,vlan,VLAN\nsw1,1,2,3\nsw1,4,5,6\n,7,8,9');
    expect(bad.errors).toEqual([
      'Column "mgmt ip" can\'t be a variable name — use letters, numbers, _ . or - (no spaces).',
      'Column "VLAN" appears twice in the header.',
      '"sw1" has more than one row.',
      'Row 4 has no device in the first column.',
    ]);
  });

  it('finds and fills placeholders case-insensitively; empty counts as missing', () => {
    expect(findVariables('vlan ${vlan}\n name ${Name}\n ${vlan} ${ x }')).toEqual(['vlan', 'Name', 'x']);
    expect(substitute('vlan ${VLAN} name ${name}', { vlan: '10', name: 'MGMT' })).toEqual({
      text: 'vlan 10 name MGMT',
      missing: [],
    });
    expect(substitute('vlan ${vlan} ${gw}', { vlan: '' })).toEqual({ text: 'vlan ${vlan} ${gw}', missing: ['vlan', 'gw'] });
  });
});

describe('checks', () => {
  it('parses optional expectations', () => {
    expect(parseChecks('show vlan 10 => MGMT\n! comment\nshow int 1/1/1 !=> down\nshow version')).toEqual([
      { command: 'show vlan 10', expect: { text: 'MGMT', absent: false } },
      { command: 'show int 1/1/1', expect: { text: 'down', absent: true } },
      { command: 'show version' },
    ]);
  });

  it('judges output without the echoed command or the prompt', () => {
    const out = 'show vlan 10\n 10  MGMT  up\nsw1# ';
    expect(evaluateCheck({ command: 'show vlan 10' }, out)).toEqual({ ok: true });
    expect(evaluateCheck({ command: 'show vlan 10', expect: { text: 'mgmt', absent: false } }, out).ok).toBe(true);
    expect(evaluateCheck({ command: 'show vlan 10', expect: { text: 'up', absent: true } }, out)).toEqual({
      ok: false,
      reason: '"up" is in the output',
    });
    // The expectation text in the echo doesn't count as found.
    expect(evaluateCheck({ command: 'show vlan 10 | include MGMT', expect: { text: 'MGMT', absent: false } }, 'show vlan 10 | include MGMT\nsw1# ').ok).toBe(false);
  });

  it('fails on device errors, silence and paged output', () => {
    expect(evaluateCheck({ command: 'show vlna' }, 'show vlna\nInvalid input: vlna\nsw1# ')).toEqual({
      ok: false,
      reason: 'the device rejected it: Invalid input: vlna',
    });
    expect(evaluateCheck({ command: 'show x' }, '')).toEqual({ ok: false, reason: 'no response' });
    expect(evaluateCheck({ command: 'show x', expect: { text: 'y', absent: true } }, 'show x\nline\n-- MORE --, next page: Space').ok).toBe(false);
  });
});

const input = (over: Partial<PlanInput> & { deviceType?: PlanInput['device']['deviceType'] } = {}): PlanInput => ({
  block: 'vlan ${vlan}\n  name ${vname}',
  preChecks: '',
  postChecks: '',
  device: { name: 'sw1', host: '10.0.0.1', deviceType: over.deviceType ?? 'aruba-cx' },
  table: parseVariableTable('device,vlan,vname\nsw1,10,MGMT'),
  options: DEFAULT_JOB_OPTIONS,
  ...over,
});
const texts = (p: DevicePlan, k: 'change' | 'confirm' | 'save') => p[k].map((l) => l.text);

describe('buildDevicePlan', () => {
  it('AOS-CX: checkpoint auto before the change, confirm after, then save', () => {
    const p = buildDevicePlan(input());
    expect(p.errors).toEqual([]);
    expect(p.wrapper).toBe('checkpoint');
    expect(texts(p, 'change')).toEqual(['checkpoint auto 5', 'configure terminal', 'vlan 10', 'name MGMT', 'end']);
    expect(p.armIndex).toBe(0);
    expect(texts(p, 'confirm')).toEqual(['checkpoint auto confirm']);
    expect(texts(p, 'save')).toEqual(['write memory']);
    expect(p.change.map((l) => l.fromBlock)).toEqual([false, false, true, true, false]);
  });

  it('Junos: commit confirmed N, then a confirming commit', () => {
    const p = buildDevicePlan(
      input({ deviceType: 'juniper-junos', block: 'set vlans V${vlan} vlan-id ${vlan}', options: { ...DEFAULT_JOB_OPTIONS, confirmMinutes: 7 } })
    );
    expect(p.errors).toEqual([]);
    expect(texts(p, 'change')).toEqual([
      'configure exclusive',
      'set vlans V10 vlan-id 10',
      'commit confirmed 7 comment "GreenCLI change job"',
      'exit configuration-mode',
    ]);
    expect(p.armIndex).toBe(2);
    expect(texts(p, 'confirm')).toEqual([
      'configure exclusive',
      'commit comment "GreenCLI change job (confirmed)"',
      'exit configuration-mode',
    ]);
    expect(p.save).toEqual([]);
    expect(p.abort).toEqual(['top', 'rollback 0', 'exit configuration-mode']);
  });

  it('no rollback timer when turned off, or where the vendor has none', () => {
    const off = { ...DEFAULT_JOB_OPTIONS, safetyWrapper: false };
    const junos = buildDevicePlan(input({ deviceType: 'juniper-junos', block: 'set system host-name x', options: off }));
    expect(texts(junos, 'change')).toEqual([
      'configure exclusive',
      'set system host-name x',
      'commit comment "GreenCLI change job"',
      'exit configuration-mode',
    ]);
    expect(junos.armIndex).toBe(-1);
    expect(junos.confirm).toEqual([]);

    const aoss = buildDevicePlan(input({ deviceType: 'aruba-aos-s' }));
    expect(aoss.wrapper).toBe('none');
    expect(texts(aoss, 'change')).toEqual(['configure terminal', 'vlan 10', 'name MGMT', 'end']);
    expect(texts(aoss, 'save')).toEqual(['write memory']);

    const ap = buildDevicePlan(input({ deviceType: 'aruba-ap', block: 'ntp-server 10.0.0.5' }));
    expect(texts(ap, 'change')).toEqual(['configure terminal', 'ntp-server 10.0.0.5', 'end', 'commit apply']);
    expect(ap.save).toEqual([]);

    const noSave = buildDevicePlan(input({ options: { ...DEFAULT_JOB_OPTIONS, save: false } }));
    expect(noSave.save).toEqual([]);
  });

  it('clamps the rollback minutes to 1–60', () => {
    expect(texts(buildDevicePlan(input({ options: { ...DEFAULT_JOB_OPTIONS, confirmMinutes: 500 } })), 'change')[0]).toBe('checkpoint auto 60');
    expect(texts(buildDevicePlan(input({ options: { ...DEFAULT_JOB_OPTIONS, confirmMinutes: 0 } })), 'change')[0]).toBe('checkpoint auto 1');
  });

  it('a normal device gets the block exactly as written', () => {
    const p = buildDevicePlan(input({ deviceType: 'generic', block: 'conf t\nhostname x\nend', table: null }));
    expect(texts(p, 'change')).toEqual(['conf t', 'hostname x', 'end']);
    expect(p.warnings.some((w) => w.startsWith('Normal device'))).toBe(true);
  });

  it('takes out a leading configure and trailing end, and says so', () => {
    const p = buildDevicePlan(input({ block: 'configure terminal\nvlan ${vlan}\nend' }));
    expect(texts(p, 'change')).toEqual(['checkpoint auto 5', 'configure terminal', 'vlan 10', 'end']);
    expect(p.warnings).toHaveLength(2);
  });

  it('reports missing variables per device', () => {
    expect(buildDevicePlan(input({ device: { name: 'sw9', deviceType: 'aruba-cx' } })).errors).toEqual([
      'No row for this device in the variables table (the first column must be "sw9").',
    ]);
    expect(buildDevicePlan(input({ table: null })).errors).toEqual(['Uses ${vlan}, ${vname} but there is no variables table.']);
    const partial = buildDevicePlan(input({ table: parseVariableTable('device,vlan\nsw1,') }));
    expect(partial.errors).toEqual(['No value for ${vlan}.', '${vname} is not a column in the variables table.']);
    // ${name} / ${host} need no table.
    expect(buildDevicePlan(input({ block: 'hostname ${name}', table: null })).errors).toEqual([]);
  });

  it('flags risky and dangerous block lines, never the job-added ones', () => {
    const p = buildDevicePlan(input({ block: 'interface 1/1/1\n  no shutdown\n  shutdown', table: null }));
    const flags = p.change.map((l) => [l.text, l.risky, l.dangerous]);
    expect(flags).toEqual([
      ['checkpoint auto 5', false, false],
      ['configure terminal', false, false],
      ['interface 1/1/1', false, false],
      ['no shutdown', true, false],
      ['shutdown', true, true],
      ['end', false, false],
    ]);
  });

  it('refuses blocks that fight the wrapper, and checks that change things', () => {
    expect(buildDevicePlan(input({ deviceType: 'juniper-junos', block: 'set a b\ncommit', table: null })).errors[0]).toMatch(/Take out the "commit" line/);
    expect(buildDevicePlan(input({ block: 'checkpoint auto 10\nvlan 5', table: null })).errors[0]).toMatch(/checkpoint auto/);
    expect(buildDevicePlan(input({ block: 'vlan 5', table: null, postChecks: 'clear counters' })).errors).toEqual([
      'Checks must only read: "clear counters" changes the device.',
    ]);
    expect(buildDevicePlan(input({ block: '! just a comment', table: null })).errors).toEqual(['The config block is empty.']);
  });
});

describe('resolveTargets', () => {
  const host = (id: string, h: string, extra: Partial<ConnectionConfig> = {}): ConnectionConfig => ({
    id,
    name: id,
    protocol: 'ssh',
    host: h,
    deviceType: 'aruba-cx',
    ...extra,
  });
  const folders: SessionFolder[] = [
    { id: 'core', name: 'Core', expanded: true, items: [host('c1', '10.0.0.1', { tags: ['site-a'] }), host('c2', '10.0.0.2')] },
    {
      id: 'edge',
      name: 'Edge',
      expanded: true,
      items: [host('e1', '10.0.1.1', { tags: ['site-a'] }), host('con', '', { protocol: 'serial', serialPort: 'COM3' })],
    },
  ];
  const session = (id: string, config: ConnectionConfig): Session => ({ sessionId: id, config, connected: true });
  const pick = { folders: [], tags: [], hosts: [], sessions: [] };

  it('unions folders, tags, hosts and open tabs without duplicates', () => {
    const t = resolveTargets(folders, [], { ...pick, folders: ['core'], tags: ['site-a'] });
    expect(t.map((x) => x.key)).toEqual(['c1', 'c2', 'e1']);
    expect(t.every((x) => x.sessionId === null)).toBe(true);
  });

  it('never sweeps a serial console in by folder, but allows it by hand', () => {
    expect(resolveTargets(folders, [], { ...pick, folders: ['edge'] }).map((x) => x.key)).toEqual(['e1']);
    expect(resolveTargets(folders, [], { ...pick, hosts: ['con'] }).map((x) => x.key)).toEqual(['con']);
  });

  it('uses an open tab to the same device instead of a second connection', () => {
    const adhoc = session('tab-9', host('tab-9', '10.0.0.2', { name: 'quick' }));
    const t = resolveTargets(folders, [adhoc], { ...pick, folders: ['core'], sessions: ['tab-9'] });
    expect(t.map((x) => [x.key, x.sessionId])).toEqual([
      ['c1', null],
      ['tab-9', 'tab-9'],
    ]);
    // A saved host can have several tabs: each has its own id and points
    // back with savedId. The connected one is used, and only once.
    const tabA = { ...session('t-1', host('t-1', '10.0.0.1', { savedId: 'c1' })), connected: false };
    const tabB = session('t-2', host('t-2', '10.0.0.1', { savedId: 'c1' }));
    const multi = resolveTargets(folders, [tabA, tabB], { ...pick, hosts: ['c1'], sessions: ['t-1', 't-2'] });
    expect(multi.map((x) => [x.key, x.sessionId])).toEqual([['t-2', 't-2']]);
    expect(savedHostId(tabB.config)).toBe('c1');
    expect(savedHostId(host('c2', '10.0.0.2'))).toBe('c2');
    const local = session('sh', { id: 'sh', name: 'Local', protocol: 'local', deviceType: 'generic' });
    expect(resolveTargets(folders, [local], { ...pick, sessions: ['sh'] })).toEqual([]);
  });

  it('never runs a saved host on a tab still logged in to its old address', () => {
    // c1 was edited to a new address while its tab stayed on the old device.
    const moved: SessionFolder[] = [{ ...folders[0], items: [host('c1', '10.0.0.9'), host('c2', '10.0.0.2')] }];
    const stale = session('t-1', host('t-1', '10.0.0.1', { savedId: 'c1' }));
    const t = resolveTargets(moved, [stale], { ...pick, hosts: ['c1'] });
    expect(t.map((x) => [x.key, x.sessionId])).toEqual([['c1', null]]);
  });
});

describe('promptState', () => {
  it('tells an exec prompt from config mode, questions, pagers and logins', () => {
    expect(promptState('banner\nsw1# ')).toBe('exec');
    expect(promptState('banner\nuser@ex4300> ')).toBe('exec');
    expect(promptState('x\n(ArubaMC) [mynode] #')).toBe('exec');
    expect(promptState('x\nsw1(config)# ')).toBe('config');
    expect(promptState('x\nsw1(config-if)# ')).toBe('config');
    expect(promptState('x\nHP-2930F(vlan-10)# ')).toBe('config');
    expect(promptState('x\n\n[edit interfaces]\nadmin@ex# ')).toBe('config');
    expect(promptState('x\nDo you want to continue (y/n)? ')).toBe('question');
    expect(promptState('x\n-- MORE --, next page: Space, next line: Enter, quit: Control-C')).toBe('pager');
    expect(promptState('Username: ')).toBe('login');
    expect(promptState('HPE Networking\nPress any key to continue\n')).toBe('press-key');
    expect(promptState('still printing output')).toBe('unknown');
  });
});

describe('diff', () => {
  it('finds added and removed lines', () => {
    const d = diffLines('a\nb\nc\nd', 'a\nc\nd\ne');
    expect(d.added).toBe(1);
    expect(d.removed).toBe(1);
    expect(d.lines.map((l) => `${l.kind[0]}${l.text}`)).toEqual(['sa', 'db', 'sc', 'sd', 'ae']);
  });

  it('shows only changes with context, gaps as null', () => {
    const before = Array.from({ length: 20 }, (_, i) => `l${i}`).join('\n');
    const after = before.replace('l2\n', 'l2\nNEW\n').replace('l17', 'L17');
    const h = diffHunks(diffLines(before, after), 1);
    expect(h.map((l) => (l ? `${l.kind[0]}${l.text}` : '…'))).toEqual(['sl2', 'aNEW', 'sl3', '…', 'sl16', 'dl17', 'aL17', 'sl18']);
    expect(diffHunks(diffLines('same', 'same'))).toEqual([]);
  });
});

// ─── The device runner, over a fake switch driven by the real send loop ───

interface FakeSwitch {
  io: DeviceIO;
  sent: string[];
  commands: string[];
  steps: JobStep[];
  armed: (number | null)[];
  ctl: (over?: Partial<DeviceControl>) => DeviceControl;
  advance: (ms: number) => void;
}

/**
 * A switch that echoes each line and answers with a prompt, or an error for
 * lines matching `reject`. `sendLines` goes through the real runConfigSend,
 * so stop-at-first-error is the same detection the Config Editor uses.
 */
function fakeSwitch(opts: { reject?: RegExp; checkOutput?: (cmd: string) => string } = {}): FakeSwitch {
  let clock = 1_000_000;
  const sent: string[] = [];
  const commands: string[] = [];
  const steps: JobStep[] = [];
  const armed: (number | null)[] = [];
  const io: DeviceIO = {
    sendLines: async (lines) => {
      let out = '';
      const sio: SendIO = {
        send: async (data) => {
          const line = data.replace(/\r$/, '');
          sent.push(line);
          out += `${line}\r\n${opts.reject?.test(line) ? 'Invalid input: ' + line + '\r\n' : ''}sw1# `;
        },
        output: () => out,
        sleep: async (ms) => {
          clock += ms;
        },
        cancelled: () => false,
        now: () => clock,
      };
      const result = await runConfigSend(lines.map((text, i) => ({ text, lineNumber: i + 1 })), sio);
      return { result, output: out };
    },
    runCommand: async (command) => {
      commands.push(command);
      return { output: `${command}\n${opts.checkOutput?.(command) ?? 'ok'}\nsw1# `, truncated: false, sent: command };
    },
    captureConfig: async (when) => ({ content: `hostname sw1\n${when === 'after' ? 'vlan 10\n' : ''}`, truncated: false }),
    withPagingOff: (fn) => fn(),
    now: () => clock,
  };
  return {
    io,
    sent,
    commands,
    steps,
    armed,
    advance: (ms) => {
      clock += ms;
    },
    ctl: (over = {}) => ({
      stopRequested: () => false,
      rollbackRequested: () => false,
      onStep: (s) => steps.push(s),
      onArmed: (d) => armed.push(d),
      ...over,
    }),
  };
}

const cxPlan = (over: Parameters<typeof input>[0] = {}) =>
  buildDevicePlan(input({ block: 'vlan 10\n  name MGMT', table: null, preChecks: 'show version', postChecks: 'show vlan 10 => MGMT', ...over }));

describe('runDevice', () => {
  it('reports a save that throws after the confirm as an error, not a rollback', async () => {
    const sw = fakeSwitch({ checkOutput: (c) => (c.startsWith('show vlan') ? '10 MGMT up' : 'ArubaOS-CX') });
    const sendLines = sw.io.sendLines;
    sw.io.sendLines = async (lines) => {
      if (lines[0] === 'write memory') throw new Error('session closed');
      return sendLines(lines);
    };
    const out = await runDevice(cxPlan(), sw.io, sw.ctl());
    expect(sw.sent).toContain('checkpoint auto confirm');
    expect(out.status).toBe('error');
    expect(out.detail).not.toMatch(/rolls back/);
  });

  it('runs checks, arms, changes, confirms and saves in order', async () => {
    const sw = fakeSwitch({ checkOutput: (c) => (c.startsWith('show vlan') ? '10 MGMT up' : 'ArubaOS-CX') });
    const out = await runDevice(cxPlan(), sw.io, sw.ctl());
    expect(out.status).toBe('ok');
    expect(out.detail).toBe('Changed and confirmed, saved.');
    expect(sw.sent).toEqual([
      'checkpoint auto 5',
      'configure terminal',
      'vlan 10',
      'name MGMT',
      'end',
      'checkpoint auto confirm',
      'write memory',
    ]);
    expect(sw.commands).toEqual(['show version', 'show vlan 10']);
    expect(sw.steps.map((s) => s.phase)).toEqual(['pre-check', 'capture', 'change', 'post-check', 'capture', 'confirm', 'save']);
    expect(out.before).toContain('hostname sw1');
    expect(out.after).toContain('vlan 10');
    expect(out.revertsAt).toBeNull();
    expect(sw.armed[0]).toBeGreaterThan(0);
    expect(sw.armed[sw.armed.length - 1]).toBeNull();
  });

  it('a failed pre-check changes nothing', async () => {
    const sw = fakeSwitch({ checkOutput: () => 'Invalid input: version' });
    const out = await runDevice(cxPlan(), sw.io, sw.ctl());
    expect(out).toMatchObject({ status: 'error', touched: false });
    expect(out.detail).toMatch(/^Pre-check failed — nothing was changed/);
    expect(sw.sent).toEqual([]);
  });

  it('a failed post-check leaves the rollback timer to undo the change', async () => {
    const sw = fakeSwitch({ checkOutput: (c) => (c.startsWith('show vlan') ? 'no such vlan' : 'ok') });
    const out = await runDevice(cxPlan(), sw.io, sw.ctl());
    expect(out.status).toBe('rolled-back');
    expect(out.detail).toMatch(/"MGMT" is not in the output.*rolls back on its own/);
    expect(sw.sent).not.toContain('checkpoint auto confirm');
    expect(sw.sent).not.toContain('write memory');
    expect(out.revertsAt).toBeGreaterThan(0);
  });

  it('without a rollback timer, a failed post-check is an error and nothing is saved', async () => {
    const sw = fakeSwitch({ checkOutput: (c) => (c.startsWith('show vlan') ? 'nothing' : 'ok') });
    const out = await runDevice(cxPlan({ deviceType: 'aruba-aos-s' }), sw.io, sw.ctl());
    expect(out.status).toBe('error');
    expect(out.detail).toMatch(/The change is live on the device and was not saved\.$/);
    expect(sw.sent).not.toContain('write memory');
  });

  it('stops at the first rejected line and leaves config mode', async () => {
    const sw = fakeSwitch({ reject: /^name / });
    const out = await runDevice(cxPlan({ deviceType: 'aruba-aos-s', block: 'vlan 10\nname MGMT\nvlan 20' }), sw.io, sw.ctl());
    expect(out.status).toBe('error');
    expect(out.detail).toMatch(/rejected "name MGMT".*The 1 line before it are live/);
    expect(sw.sent).toEqual(['configure terminal', 'vlan 10', 'name MGMT', 'end']);
    expect(sw.steps.map((s) => s.phase)).toContain('cleanup');
  });

  it('Junos: a rejected line before the commit means nothing was committed', async () => {
    const sw = fakeSwitch({ reject: /^set bad/ });
    const plan = cxPlan({ deviceType: 'juniper-junos', block: 'set good 1\nset bad 2', postChecks: '' });
    const out = await runDevice(plan, sw.io, sw.ctl());
    expect(out.status).toBe('error');
    expect(out.detail).toMatch(/Nothing was committed\.$/);
    expect(sw.sent).toEqual(['configure exclusive', 'set good 1', 'set bad 2', 'top', 'rollback 0', 'exit configuration-mode']);
    expect(sw.sent.some((l) => l.startsWith('commit'))).toBe(false);
  });

  it('AOS-CX: a rejected line after the checkpoint is left to roll back', async () => {
    const sw = fakeSwitch({ reject: /^name / });
    const out = await runDevice(cxPlan(), sw.io, sw.ctl());
    expect(out.status).toBe('rolled-back');
    expect(sw.sent).not.toContain('checkpoint auto confirm');
  });

  it('the canary holds before confirming; "drop" never confirms', async () => {
    const sw = fakeSwitch({ checkOutput: () => 'MGMT' });
    const hold = vi.fn(async () => 'drop' as const);
    const out = await runDevice(cxPlan(), sw.io, sw.ctl({ hold }));
    expect(hold).toHaveBeenCalledWith(expect.any(Number));
    expect(out.status).toBe('rolled-back');
    expect(sw.sent).not.toContain('checkpoint auto confirm');

    const sw2 = fakeSwitch({ checkOutput: () => 'MGMT' });
    const kept = await runDevice(cxPlan(), sw2.io, sw2.ctl({ hold: async () => 'keep' }));
    expect(kept.status).toBe('ok');
    expect(sw2.sent).toContain('checkpoint auto confirm');
  });

  it('does not confirm once the timer has (nearly) run out, or after Roll back / Stop', async () => {
    const sw = fakeSwitch({ checkOutput: () => 'MGMT' });
    const late = await runDevice(
      cxPlan(),
      sw.io,
      sw.ctl({
        hold: async () => {
          sw.advance(5 * 60_000);
          return 'keep';
        },
      })
    );
    expect(late.status).toBe('rolled-back');
    expect(late.detail).toMatch(/Too late to confirm/);
    expect(sw.sent).not.toContain('checkpoint auto confirm');

    const sw2 = fakeSwitch({ checkOutput: () => 'MGMT' });
    const rb = await runDevice(cxPlan(), sw2.io, sw2.ctl({ rollbackRequested: () => true }));
    expect(rb.status).toBe('rolled-back');
    expect(sw2.sent).not.toContain('checkpoint auto confirm');
  });

  it('skips the change when the job was stopped before it started', async () => {
    const sw = fakeSwitch();
    const out = await runDevice(cxPlan({ postChecks: '' }), sw.io, sw.ctl({ stopRequested: () => true }));
    expect(out).toMatchObject({ status: 'skipped', touched: false });
    expect(sw.sent).toEqual([]);
  });
});

describe('runJob', () => {
  const make = (results: Record<string, JobRunResult>, opts: { concurrency?: number; stopOnError?: boolean } = {}) => {
    const ran: string[] = [];
    const skipped: [string, string][] = [];
    let stopped = false;
    const job = {
      targets: Object.keys(results),
      concurrency: opts.concurrency ?? 1,
      stopOnError: opts.stopOnError ?? true,
      isStopped: () => stopped,
      run: async (t: string) => {
        ran.push(t);
        if (t === 'stopper') stopped = true;
        return results[t];
      },
      skip: (t: string, cause: string) => skipped.push([t, cause]),
    };
    return { job, ran, skipped };
  };
  const ok: JobRunResult = { status: 'ok', touched: true };

  it('runs the rest only when the canary passed and the user said go on', async () => {
    const go = make({ c: { ...ok, proceed: true }, a: ok, b: ok });
    expect(await runJob(go.job)).toEqual({ end: 'finished' });
    expect(go.ran).toEqual(['c', 'a', 'b']);

    const hold = make({ c: { ...ok, proceed: false }, a: ok });
    expect((await runJob(hold.job)).end).toBe('stopped');
    expect(hold.ran).toEqual(['c']);
    expect(hold.skipped).toEqual([['a', 'canary-stop']]);

    const bad = make({ c: { status: 'rolled-back', touched: true }, a: ok });
    expect((await runJob(bad.job)).end).toBe('canary-failed');
    expect(bad.skipped).toEqual([['a', 'canary-failed']]);
  });

  it('stops at the first failed change, but not for unreachable devices', async () => {
    const r = make({
      c: { ...ok, proceed: true },
      unreachable: { status: 'needs-login', touched: false },
      precheck: { status: 'error', touched: false },
      broken: { status: 'error', touched: true },
      never: ok,
    });
    expect(await runJob(r.job)).toEqual({ end: 'halted', haltedBy: 'broken' });
    expect(r.ran).toEqual(['c', 'unreachable', 'precheck', 'broken']);
    expect(r.skipped).toEqual([['never', 'halted']]);
  });

  it('keeps going past a failure when told to skip it', async () => {
    const r = make({ c: { ...ok, proceed: true }, broken: { status: 'error', touched: true }, next: ok }, { stopOnError: false });
    expect((await runJob(r.job)).end).toBe('finished');
    expect(r.ran).toEqual(['c', 'broken', 'next']);
  });

  it('a stop lets running devices finish and starts no new ones', async () => {
    const r = make({ c: { ...ok, proceed: true }, stopper: ok, after: ok });
    expect((await runJob(r.job)).end).toBe('stopped');
    expect(r.skipped).toEqual([['after', 'stopped']]);
  });

  it('runs up to `concurrency` devices at once', async () => {
    let active = 0;
    let peak = 0;
    const targets = ['c', 'a', 'b', 'd', 'e'];
    await runJob({
      targets,
      concurrency: 2,
      stopOnError: true,
      isStopped: () => false,
      skip: () => undefined,
      run: async (t) => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 5));
        active--;
        return t === 'c' ? { ...ok, proceed: true } : ok;
      },
    });
    expect(peak).toBe(2);
  });
});

describe('formatClock', () => {
  it('formats countdowns', () => {
    expect(formatClock(0)).toBe('0:00');
    expect(formatClock(65_000)).toBe('1:05');
    expect(formatClock(3_725_000)).toBe('1:02:05');
    expect(formatClock(-5)).toBe('0:00');
  });
});

describe('jobBlockFromEditor', () => {
  it('takes out the Junos commit lines the job adds itself', () => {
    const text = 'set vlans users vlan-id 20\ncommit confirmed 5\n';
    expect(jobBlockFromEditor(text, 'juniper-junos')).toEqual({ block: 'set vlans users vlan-id 20\n', removed: ['commit confirmed 5'] });
    expect(jobBlockFromEditor('set system ntp server 10.1.1.1\n  commit and-quit', 'mist').removed).toEqual(['commit and-quit']);
  });

  it('takes out an AOS-CX checkpoint auto line, but not other vendors\' lines', () => {
    expect(jobBlockFromEditor('checkpoint auto 5\nvlan 20\n    name users', 'aruba-cx')).toEqual({
      block: 'vlan 20\n    name users',
      removed: ['checkpoint auto 5'],
    });
    expect(jobBlockFromEditor('vlan 20\ncommit', 'aruba-aos-s')).toEqual({ block: 'vlan 20\ncommit', removed: [] });
  });

  it('gives a block that plans without errors', () => {
    const { block } = jobBlockFromEditor('set vlans users vlan-id 20\ncommit confirmed 5', 'juniper-junos');
    const plan = buildDevicePlan({
      block,
      preChecks: '',
      postChecks: '',
      device: { name: 'ex1', deviceType: 'juniper-junos' },
      table: null,
      options: DEFAULT_JOB_OPTIONS,
    });
    expect(plan.errors).toEqual([]);
  });
});
