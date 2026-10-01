// Ported from casper tests/secrets-files.test.ts: the text rules for secrets
// outside device config (KEY=VALUE, addresses, notes, typed commands). Casper
// runs these through scrubPlainSecrets; plain() below is the same passes in
// the same order, minus Casper's own environment values.
import { expect, test } from 'vitest';
import { isSecretName, scrubAssignments, scrubUrlPasswords } from './assignments';
import { scrubProseSecrets } from './prose';
import type { ScrubTextResult } from './scrub';

function plain(text: string): string {
  const passes: Array<(value: string) => ScrubTextResult> = [
    scrubUrlPasswords,
    (value) => scrubAssignments(value, false),
    scrubProseSecrets,
  ];
  return passes.reduce((out, pass) => pass(out).text, text);
}

test('secret name rules', () => {
  for (const name of ['MIST_APITOKEN', 'CENTRAL_CLIENT_SECRET', 'DB_PASSWORD', 'aws_secret_access_key', 'apiKey', 'wpa_passphrase', 'token', 'refresh_token', 'webhook_url']) {
    expect([name, isSecretName(name)]).toEqual([name, true]);
  }
  for (const name of ['MIST_HOST', 'TOKEN_URL', 'aws_access_key_id', 'next_token', 'max_tokens', 'PWD', 'key', 'password_file', 'LOG_LEVEL', 'webhook_enabled']) {
    expect([name, isSecretName(name)]).toEqual([name, false]);
  }
});

test('several pairs on one line are each checked', () => {
  expect(scrubAssignments('user=bob, password=hunter22, token=t0ken123', false).text).toBe('user=bob, password=<secret hidden>, token=<secret hidden>');
  expect(plain('Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.e30.abc')).toBe('Authorization: Bearer <secret hidden>');
});

test('the password part of an address is hidden, the rest stays', () => {
  expect(plain('origin\thttps://bot:ghp_abcdef012345@github.com/o/r.git (fetch)\norigin\tssh://git@github.com/o/r.git (push)')).toBe(
    'origin\thttps://bot:<secret hidden>@github.com/o/r.git (fetch)\norigin\tssh://git@github.com/o/r.git (push)'
  );
});

test('git diff output: a secret on a removed line is hidden like one on an added line', () => {
  const diff = '-API_KEY = "q8Zr2LmN7vXk4TpW"\n+API_KEY = "w3Kd9PqR1sTu6VxY"\n-db_password: hunter2hunter2\n+token = get_token()\n-x-flag = 1';
  const result = scrubAssignments(diff, false);
  expect(result.text).toBe('-API_KEY = "<secret hidden>"\n+API_KEY = "<secret hidden>"\n-db_password: <secret hidden>\n+token = get_token()\n-x-flag = 1');
  expect(result.hidden).toBe(3);
});

test('lab logins written as prose, markdown or a table are hidden; the words around them stay', () => {
  const doc = [
    '## BUILD-SERVER lab',
    'Proxmox: root / Example!Pass99',
    '**Password:** hunter22x',
    'Password: **Summer**',
    'pw: `abc123`',
    'the password is S3cret!x now',
    'password Winter2024',
    'login: admin / Adm1n!',
    'creds: netops / N3t0ps',
    'ssh admin:Sup3r@10.0.0.5',
    '| Host | User | Password |',
    '|---|---|---|',
    '| build-server | root | Example!Pass99 |',
  ].join('\n');
  expect(plain(doc).split('\n')).toEqual([
    '## BUILD-SERVER lab',
    'Proxmox: root / <secret hidden>',
    '**Password:** <secret hidden>',
    'Password: **<secret hidden>**',
    'pw: `<secret hidden>`',
    'the password is <secret hidden> now',
    'password <secret hidden>',
    'login: admin / <secret hidden>',
    'creds: netops / <secret hidden>',
    'ssh admin:<secret hidden>@10.0.0.5',
    '| Host | User | Password |',
    '|---|---|---|',
    '| build-server | root | <secret hidden> |',
  ]);
});

test('Proxmox API tokens and token=<uuid> are hidden, in output and in the pveum token table', () => {
  const uuid = '0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b';
  expect(plain(`curl -k -H "Authorization: PVEAPIToken=root@pam!sampleapp=${uuid}" https://build-server:8006/api2/json/nodes`)).not.toContain(uuid);
  expect(plain(`TOKEN_ID=root@pam!sampleapp; echo root@pam!sampleapp=${uuid}`)).toBe('TOKEN_ID=root@pam!sampleapp; echo root@pam!sampleapp=<secret hidden>');
  expect(plain(`token=${uuid.replace(/-/g, '')}abcd`)).toBe('token=<secret hidden>');
  const table = `│ full-tokenid │ root@pam!sampleapp │\n│ value        │ ${uuid} │`;
  expect(plain(table)).toBe('│ full-tokenid │ root@pam!sampleapp │\n│ value        │ <secret hidden> │');
  // Ids that name something, not a login, stay.
  const ids = `site_id=${uuid} token_id=${uuid} org ${uuid}`;
  expect(plain(ids)).toBe(ids);
});

test('a login with its realm, a bold login and a token id followed by its secret are hidden too', () => {
  const uuid = '3f1c2a4e-9b7d-4e21-8c55-0a1b2c3d4e5f';
  for (const [text, want] of [
    ['Proxmox: https://198.51.100.20:8006 root@pam / Example-Pass1', 'Proxmox: https://198.51.100.20:8006 root@pam / <secret hidden>'],
    ['* **root** / **Example-Pass1**', '* **root** / **<secret hidden>**'],
    [`PVE token: root@pam!sampleapp ${uuid}`, 'PVE token: <secret hidden> <secret hidden>'],
    [`sampleapp token secret ${uuid}`, 'sampleapp token secret <secret hidden>'],
  ] as const) {
    expect(plain(text)).toBe(want);
  }
  for (const text of [`token id ${uuid}`, `vmid 101 uuid ${uuid}`, 'full-tokenid root@pam!sampleapp']) expect(plain(text)).toBe(text);
});

test('ordinary sentences about passwords and tokens stay readable', () => {
  for (const text of [
    'The password is stored on the switch. Set the secret for the RADIUS server first.',
    'Change the password on first login. The pass rate was 39 of 39 tests.',
    'Use a strong password (12+ chars). Store the API key in .env, see the token docs.',
    'git@github.com:org/repo.git and mailto:bob@example.com',
    'cd /root / tmp',
    'tests pass: 39 passed',
  ]) {
    expect(plain(text)).toBe(text);
  }
});

test('passwords typed into commands are hidden: sshpass, --password, curl -u, mysql -p, sudo -S, chpasswd', () => {
  const cases: Array<[string, string]> = [
    ["sshpass -p 'Example2024!' ssh root@198.51.100.20 uptime", "sshpass -p '<secret hidden>' ssh root@198.51.100.20 uptime"],
    ['sshpass -p Example2024 ssh root@10.0.0.5 id', 'sshpass -p <secret hidden> ssh root@10.0.0.5 id'],
    ['pvesh create /access/ticket --username root@pam --password Example2024!', 'pvesh create /access/ticket --username root@pam --password <secret hidden>'],
    ["wget --user=root --password='Example2024!' http://x", "wget --user=root --password='<secret hidden>' http://x"],
    ['curl -k -u root@pam:Example2024! https://10.0.0.5:8006/', 'curl -k -u root@pam:<secret hidden> https://10.0.0.5:8006/'],
    ['mysql -u root -pExample2024! sampleapp', 'mysql -u root -p<secret hidden> sampleapp'],
    ['ipmitool -I lanplus -H 10.0.0.9 -U admin -P Example2024! power status', 'ipmitool -I lanplus -H 10.0.0.9 -U admin -P <secret hidden> power status'],
    ['smbclient -U admin%Example2024! //nas/share', 'smbclient -U admin%<secret hidden> //nas/share'],
    ["echo 'Example2024!' | sudo -S systemctl restart sampleapp", "echo '<secret hidden>' | sudo -S systemctl restart sampleapp"],
    ['ssh build-server "echo svc:NewPass99 | chpasswd"', 'ssh build-server "echo svc:<secret hidden> | chpasswd"'],
    ['The root password for the lab is Example2024!', 'The root password for the lab is <secret hidden>'],
    ['user root pass Example2024!', 'user root pass <secret hidden>'],
    ['tokenid: root@pam!sampleapp\nvalue: 0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b', 'tokenid: root@pam!sampleapp\nvalue: <secret hidden>'],
  ];
  for (const [command, shown] of cases) expect(plain(command)).toBe(shown);
  for (const text of ['cmd --token-file /etc/x', 'ssh -p 22 host', 'mysql -p sampleapp', 'curl -u $USER:$PASS http://x', 'npm run build --pass-through',
    'You pass 3 args', 'The password for that account was changed', 'tar -cvpf x.tar .']) {
    expect(plain(text)).toBe(text);
  }
});
