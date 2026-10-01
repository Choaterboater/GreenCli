import { describe, expect, it } from 'vitest';
import { MAX_PROBLEMS, buildProblems, problemSummary, rejectedLineProblem, sendProblemNote } from './configProblems';

describe('buildProblems', () => {
  it('underlines a risky line with what it does, from its first word to its end', () => {
    const text = 'interface 1/1/1\n    shutdown\nreload';
    const problems = buildProblems(text, 'aruba-cx');
    expect(problems.map((p) => [p.lineNumber, p.startColumn, p.endColumn, p.severity, p.code])).toEqual([
      [2, 5, 13, 'warning', 'danger'],
      [3, 1, 7, 'warning', 'danger'],
    ]);
    expect(problems[0].message).toBe('Risky: this shuts it down. Check it before you send.');
    expect(problems[1].message).toBe('Risky: this reboots the switch. Check it before you send.');
  });

  it('never flags comment lines, which are not sent', () => {
    const text = '! reload after the window\n# shutdown later\n/* erase\n reload */\ninterface 1/1/1';
    expect(buildProblems(text, 'aruba-cx')).toEqual([]);
  });

  it('leaves no shutdown and descriptions alone', () => {
    expect(buildProblems('interface 1/1/1\n    no shutdown\n    description shutdown after cutover', 'aruba-cx')).toEqual([]);
  });

  it('marks each placeholder as an error, at its own columns', () => {
    const text = 'interface ${interface}\n    vlan access ${vlan_id}\n    description <replace-me>';
    const problems = buildProblems(text, 'aruba-cx');
    expect(problems.map((p) => [p.lineNumber, p.startColumn, p.endColumn, p.code])).toEqual([
      [1, 11, 23, 'placeholder'],
      [2, 17, 27, 'placeholder'],
      [3, 17, 29, 'placeholder'],
    ]);
    expect(problems.every((p) => p.severity === 'error')).toBe(true);
    expect(problems[0].message).toContain('${interface}');
  });

  it('says plainly when a line holds a hidden-secret marker from the AI', () => {
    const [problem] = buildProblems('radius-server host 10.1.1.10 key plaintext <secret hidden>', 'aruba-cx');
    expect(problem.code).toBe('secret-marker');
    expect(problem.message).toContain('hidden-secret marker');
  });

  it('flags terminal escape codes, on any language', () => {
    const problems = buildProblems('ok\nsw1# \x1b[32mshow vlan\x1b[0m', 'python');
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({ lineNumber: 2, startColumn: 6, code: 'ansi', severity: 'warning' });
  });

  it('gives code files no device checks', () => {
    expect(buildProblems('os.system("reload")\nname = "${x}"', 'python')).toEqual([]);
    expect(buildProblems('<div class="${x}">', 'html')).toEqual([]);
  });

  it('checks plain text like a device config (a paste before the language is picked)', () => {
    expect(buildProblems('write erase', 'plaintext')[0].message).toContain('erases the saved config');
  });

  it('tips a Junos edit with no commit, on its last edit line', () => {
    const text = 'set vlans users vlan-id 10\n  set interfaces ge-0/0/1 unit 0 family ethernet-switching vlan members users\n';
    const problems = buildProblems(text, 'juniper-junos');
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({ lineNumber: 2, startColumn: 3, severity: 'info', code: 'junos-commit' });
    expect(buildProblems(`${text}commit confirmed 5\n`, 'juniper-junos')).toEqual([]);
    expect(buildProblems(text, 'aruba-cx')).toEqual([]);
    // A commit in a comment doesn't count.
    expect(buildProblems(`${text}/* commit confirmed 5 */\n`, 'mist')).toHaveLength(1);
  });

  it('stops at the cap', () => {
    const text = Array.from({ length: MAX_PROBLEMS + 50 }, () => 'reload').join('\n');
    expect(buildProblems(text, 'aruba-cx')).toHaveLength(MAX_PROBLEMS);
  });

  it('keeps a long config fast', () => {
    const config = Array.from({ length: 20_000 }, (_, i) => `interface 1/1/${i % 48}\n    description port ${i}\n    no shutdown`).join('\n');
    const started = performance.now();
    buildProblems(config, 'aruba-cx');
    expect(performance.now() - started).toBeLessThan(1000);
  });
});

describe('rejectedLineProblem', () => {
  it('quotes the switch and underlines the line', () => {
    const problem = rejectedLineProblem('vlan 10\n  nme users\n', 2, '  nme users\n% Invalid input: nme\nsw1(config-vlan-10)# ');
    expect(problem).toMatchObject({ lineNumber: 2, startColumn: 3, endColumn: 12, severity: 'error', code: 'rejected' });
    expect(problem?.message).toBe('The switch rejected this line: nme users % Invalid input: nme');
  });

  it('gives nothing for a line that is gone or blank', () => {
    expect(rejectedLineProblem('vlan 10', 5, '% Invalid input')).toBeUndefined();
    expect(rejectedLineProblem('vlan 10\n\n', 2, '% Invalid input')).toBeUndefined();
  });
});

describe('problemSummary', () => {
  it('counts in plain words', () => {
    const problems = buildProblems('reload\nshutdown\nvlan ${id}\nset vlans a vlan-id 1', 'juniper-junos');
    expect(problemSummary(problems)).toBe('1 error, 2 warnings, 1 tip');
    expect(problemSummary([])).toBe('');
  });
});

describe('sendProblemNote', () => {
  it('counts, then lists errors first with their lines', () => {
    const problems = buildProblems('reload\nvlan ${id}\nset vlans a vlan-id 1', 'juniper-junos');
    expect(sendProblemNote(problems)).toBe(
      [
        '1 error, 1 warning, 1 tip:',
        'Error, line 2: Fill in ${id} before sending: the switch would get this text as it is.',
        'Warning, line 1: Risky: this reboots the switch. Check it before you send.',
        'Tip, line 3: Junos changes do nothing until a commit. Add "commit confirmed 5" so the box rolls back if you lose access.',
      ].join('\n')
    );
  });

  it('shows the first few and points to the panel for the rest', () => {
    const problems = buildProblems(Array.from({ length: 8 }, () => 'reload').join('\n'), 'aruba-cx');
    const note = sendProblemNote(problems, 3).split('\n');
    expect(note).toHaveLength(5);
    expect(note[0]).toBe('8 warnings:');
    expect(note[4]).toBe('…and 5 more in the Problems panel.');
  });

  it('is empty with nothing to report', () => {
    expect(sendProblemNote([])).toBe('');
  });
});
