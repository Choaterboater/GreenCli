import { describe, expect, it } from 'vitest';
import { MAX_PROBLEMS, buildProblems, problemBadge, problemSummary, rejectedLineProblem, sendProblemNote } from './configProblems';

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

describe('plain-text secrets', () => {
  it('marks the value of a plaintext password, key or pass phrase as a tip', () => {
    const text = [
      'user admin group administrators password plaintext Sup3r!',
      'radius-server host 10.1.1.10 key plaintext "Rad Key" vrf mgmt',
      'snmpv3 user ops auth sha auth-pass plaintext A1 priv aes priv-pass plaintext P2',
    ].join('\n');
    const tips = buildProblems(text, 'aruba-cx').filter((p) => p.code === 'plaintext-secret');
    expect(tips.map((p) => [p.lineNumber, text.split('\n')[p.lineNumber - 1].slice(p.startColumn - 1, p.endColumn - 1)])).toEqual([
      [1, 'Sup3r!'],
      [2, '"Rad Key"'],
      [3, 'A1'],
      [3, 'P2'],
    ]);
    expect(tips.every((p) => p.severity === 'info')).toBe(true);
    expect(tips[0].message).toContain('Copy with secrets hidden');
  });

  it('leaves hashes, blanks, markers, comments and other words alone', () => {
    const text = [
      'user admin password ciphertext AQBapZ1x',
      'radius-server host 10.1.1.10 key plaintext ${radius_key}',
      'radius-server host 10.1.1.11 key plaintext <secret hidden>',
      '! password plaintext example',
      'description plaintext cutover notes',
      'set system root-authentication plain-text-password',
    ].join('\n');
    expect(buildProblems(text, 'aruba-cx').filter((p) => p.code === 'plaintext-secret')).toEqual([]);
  });

  it('only checks device configs', () => {
    expect(buildProblems('password = "plaintext hunter2"', 'python').filter((p) => p.code === 'plaintext-secret')).toEqual([]);
  });
});

describe('secrets written into code and data files', () => {
  const values = (text: string, language: string) =>
    buildProblems(text, language)
      .filter((p) => p.code === 'code-secret')
      .map((p) => text.split('\n')[p.lineNumber - 1].slice(p.startColumn - 1, p.endColumn - 1));

  it('finds them in YAML, .env, JSON, Python, shell, PowerShell and Terraform', () => {
    expect(values('ansible_password: Hunter22\nradius_key: "R4d!us"\nsnmp_community: n0tPublic # lab', 'yaml')).toEqual([
      'Hunter22',
      'R4d!us',
      'n0tPublic',
    ]);
    expect(values('DB_PASSWORD=s3cr3t\nexport API_KEY="abc123def"', 'ini')).toEqual(['s3cr3t', 'abc123def']);
    expect(values('{\n  "client_secret": "q9Zx81",\n  "user": "admin"\n}', 'json')).toEqual(['q9Zx81']);
    expect(values("password = 'Sup3r!'\ntoken = get_token()", 'python')).toEqual(['Sup3r!']);
    expect(values('MIST_API_TOKEN=Abc123Def456', 'shell')).toEqual(['Abc123Def456']);
    expect(values('$password = "Pa55word"', 'powershell')).toEqual(['Pa55word']);
    expect(values('  password = "Hunter22"\n  password = var.db_password', 'hcl')).toEqual(['Hunter22']);
  });

  it('marks the value as a warning', () => {
    const [problem] = buildProblems('api_key: abc123def', 'yaml');
    expect(problem).toMatchObject({ severity: 'warning', code: 'code-secret', startColumn: 10, endColumn: 19 });
  });

  it('leaves variables, vault lookups, placeholders, labels and other names alone', () => {
    const yaml = [
      'password: "{{ vault_ansible_password }}"',
      'become_password: !vault |',
      'password_file: /etc/creds',
      'token_url: https://example.com/oauth',
      'tokenizer: bert',
      'passwordless: true',
      'password:',
      'secret: ${SECRET_FROM_ENV}',
      '# password: old-one',
      'api_key: "<your key here>"',
      'password: "***"',
    ].join('\n');
    expect(values(yaml, 'yaml')).toEqual([]);
    expect(values('password = os.environ["PW"]\nif password == "x": pass', 'python')).toEqual([]);
    expect(values('const label = { password: "Enter your password" };\n// token: "abc123"', 'typescript')).toEqual([]);
  });

  it('only checks code and data files', () => {
    expect(values('password: Hunter22', 'markdown')).toEqual([]);
    expect(buildProblems('password: Hunter22', 'aruba-cx').some((p) => p.code === 'code-secret')).toBe(false);
  });
});

describe('problemBadge', () => {
  const badge = (text: string, language: string) => problemBadge(buildProblems(text, language), language, text);

  it('says clean for a device config with nothing found', () => {
    expect(badge('vlan 10\n  name users\n', 'aruba-cx')).toBe('clean');
    expect(badge('set vlans users vlan-id 10\ncommit\n', 'juniper-junos')).toBe('clean');
    expect(badge('hostname sw1\n', 'generic')).toBe('clean');
  });

  it('shows counts when there is a problem, in any language', () => {
    expect(badge('reload\n', 'aruba-cx')).toBe('counts');
    expect(badge('api_key = "abc123def456"\n', 'python')).toBe('counts');
  });

  it('shows nothing for an empty tab', () => {
    expect(badge('', 'aruba-cx')).toBe('none');
    expect(badge('  \n', 'aruba-cx')).toBe('none');
  });

  it('shows nothing for clean code, data and plain text', () => {
    expect(badge('print("hi")\n', 'python')).toBe('none');
    expect(badge('name: users\n', 'yaml')).toBe('none');
    expect(badge('notes from the call\n', 'plaintext')).toBe('none');
  });

  it('shows counts for a line the switch rejected, even on clean text', () => {
    const text = 'vlan 10\n  name users\n';
    const rejected = rejectedLineProblem(text, 2, '% Invalid input');
    expect(rejected).toBeDefined();
    expect(problemBadge([rejected!], 'aruba-cx', text)).toBe('counts');
  });
});
