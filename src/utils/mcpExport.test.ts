import { describe, expect, it } from 'vitest';
import type { McpServerDef } from '../types';
import type { McpExportPins } from './mcpTypes';
import {
  buildMcpExport,
  CASPER_MAX_SERVERS,
  exportServerName,
  exportSummary,
  hasReference,
  isCasperSecretName,
  isSecretFieldName,
  isSecretHeaderName,
  isSecretQueryName,
  looksLikeSecretValue,
  onlyReferences,
  refusedExportPath,
  toEnvName,
  type ExportedServer,
  type McpExportOptions,
} from './mcpExport';

function def(partial: Partial<McpServerDef> & { name: string }): McpServerDef {
  return {
    transport: 'stdio',
    command: 'uv',
    args: [],
    env: {},
    cwd: null,
    url: null,
    credentialsEnvVar: null,
    headers: {},
    enabled: true,
    // Writes on unless a test says otherwise, so the writes-off note doesn't show in every test.
    writes: 'on',
    ...partial,
  };
}

function http(name: string, url: string, headers: Record<string, string> = {}): McpServerDef {
  return def({ name, transport: 'http', command: '', url, headers });
}

function build(defs: McpServerDef[], options?: McpExportOptions) {
  return buildMcpExport(defs, options);
}

function stdioOf(server: ExportedServer | undefined) {
  if (!server || server.type !== 'stdio') throw new Error('not a stdio entry');
  return server;
}

function httpOf(server: ExportedServer | undefined) {
  if (!server || server.type !== 'http') throw new Error('not an http entry');
  return server;
}

/** Export one stdio server named "s" with these args. */
function argsOf(args: string[]): string[] {
  return stdioOf(build([def({ name: 's', command: 'uvx', args })]).file.mcpServers.s).args;
}

/** Export one stdio server named "s" with this env. */
function envOf(env: Record<string, string>) {
  const result = build([def({ name: 's', command: 'uvx', env })]);
  return { env: stdioOf(result.file.mcpServers.s).env ?? {}, result };
}

function variable(result: ReturnType<typeof build>, name: string) {
  return result.variables.find((v) => v.name === name);
}

describe('buildMcpExport: shapes', () => {
  it('writes a stdio entry with only type, command, args and env', () => {
    const r = build([def({ name: 's', command: '  uvx  ', args: ['pkg'], env: { LOG_LEVEL: 'info' } })]);
    expect(r.file.mcpServers.s).toEqual({ type: 'stdio', command: 'uvx', args: ['pkg'], env: { LOG_LEVEL: 'info' } });
    const bare = build([def({ name: 's', command: 'uvx' })]);
    expect(bare.file.mcpServers.s).toEqual({ type: 'stdio', command: 'uvx', args: [] });
    expect('env' in bare.file.mcpServers.s).toBe(false);
  });

  it('writes an http entry with only type and url when there are no headers', () => {
    const r = build([http('h', 'https://h.example/mcp')]);
    expect(r.file.mcpServers.h).toEqual({ type: 'http', url: 'https://h.example/mcp' });
    expect(Object.keys(r.file.mcpServers.h)).toEqual(['type', 'url']);
  });

  it('never writes type "sse", even for an /sse address', () => {
    const r = build([http('h', 'https://h.example/sse')]);
    expect(httpOf(r.file.mcpServers.h).type).toBe('http');
    expect(r.text).not.toContain('"sse"');
  });

  it('writes only the keys Claude Code and Casper share', () => {
    const r = build([
      def({ name: 'a', command: 'uvx', args: ['x'], env: { A: '1' }, cwd: '/p', enabled: false, credentialsEnvVar: 'C' }),
      http('b', 'https://b.example/mcp', { Accept: 'application/json' }),
    ]);
    for (const entry of Object.values(r.file.mcpServers)) {
      const keys = Object.keys(entry).sort();
      expect([['args', 'command', 'env', 'type'], ['headers', 'type', 'url']]).toContainEqual(keys);
    }
  });

  it('exports enabled:false the same as enabled:true, with no disabled key, and says so', () => {
    const on = build([def({ name: 's', command: 'uvx', enabled: true })]);
    const off = build([def({ name: 's', command: 'uvx', enabled: false })]);
    expect(off.text).toBe(on.text);
    expect(off.text).not.toContain('disabled');
    expect(on.notes).toEqual([]);
    expect(off.notes).toEqual([
      "s: it is turned off in GreenCLI, but Claude Code and Casper will offer to start it. Remove it from the file if you don't want it.",
    ]);
  });

  it('ends text with a newline and text parses back to file', () => {
    const r = build([def({ name: 's', command: 'uvx', env: { A: '1' } }), http('h', 'https://h/mcp')]);
    expect(r.text.endsWith('\n')).toBe(true);
    expect(JSON.parse(r.text)).toEqual(r.file);
  });

  it('gives the same text whatever order env keys were inserted in', () => {
    const a = build([def({ name: 's', command: 'uvx', env: { B: '2', A: '1', API_TOKEN: 'abcdefgh' } })]);
    const b = build([def({ name: 's', command: 'uvx', env: { API_TOKEN: 'abcdefgh', A: '1', B: '2' } })]);
    expect(a.text).toBe(b.text);
  });
});

describe('buildMcpExport: env', () => {
  it('turns secret env values into variables named after the key', () => {
    const { env, result } = envOf({
      HPE_MCP_API_KEY: 'k1',
      api_key: 'k2',
      tacacs_key: 'k3',
      MIST_KEY: 'k4',
      OPENAI_KEY: 'k5',
      PUBLIC_KEY: 'pk',
      LOG_LEVEL: 'debug',
      CREDS_PATH: '/x',
      HPE_MCP_READONLY: '1',
      EMPTY_TOKEN: '',
      X: 'Bearer abcdefgh123',
    });
    expect(env.HPE_MCP_API_KEY).toBe('${HPE_MCP_API_KEY}');
    expect(env.api_key).toBe('${API_KEY}');
    expect(env.tacacs_key).toBe('${TACACS_KEY_SECRET}');
    expect(env.MIST_KEY).toBe('${MIST_KEY_SECRET}');
    expect(env.OPENAI_KEY).toMatch(/^\$\{OPENAI_KEY[A-Z_]*\}$/);
    expect(env.PUBLIC_KEY).toBe('pk');
    expect(env.LOG_LEVEL).toBe('debug');
    expect(env.CREDS_PATH).toBe('/x');
    expect(env.HPE_MCP_READONLY).toBe('1');
    expect(env.EMPTY_TOKEN).toBe('');
    expect(result.variables.some((v) => v.name.startsWith('EMPTY'))).toBe(false);
    expect(env.X).toBe('Bearer ${X_SECRET}');
    expect(variable(result, 'X_SECRET')?.scheme).toBe('Bearer');
    expect(variable(result, 'HPE_MCP_API_KEY')).toMatchObject({ why: 'secret', places: [{ server: 's', where: 'env HPE_MCP_API_KEY' }] });
  });

  it('hides the password in addresses held in env values', () => {
    const { env } = envOf({
      DATABASE_URL: 'postgres://u:pw@h/db',
      REDIS_URL: 'redis://:pw@h:6379',
      AMQP: 'amqp://:pw@h',
      JDBC: 'jdbc:postgresql://u:pw@h/db',
    });
    expect(env.DATABASE_URL).toBe('postgres://u:${DATABASE_URL_PASSWORD}@h/db');
    expect(env.REDIS_URL).toBe('redis://:${REDIS_URL_PASSWORD}@h:6379');
    expect(env.AMQP).toBe('amqp://:${AMQP_PASSWORD}@h');
    expect(env.JDBC).toBe('jdbc:postgresql://u:${JDBC_PASSWORD}@h/db');
  });

  it('takes the whole password up to the last @', () => {
    // The sweep shows the variable holds the whole password: the same text elsewhere becomes the same name.
    const { env, result } = envOf({ DB: 'postgres://u:P@ssword1@db/app', NOTE: 'P@ssword1' });
    expect(env.DB).toBe('postgres://u:${DB_PASSWORD}@db/app');
    expect(env.NOTE).toBe('${DB_PASSWORD}');
    expect(result.text).not.toContain('@ssword1');
  });

  it('keeps a #fragment and takes only the query value', () => {
    const { env } = envOf({ HOOK: 'https://h/x?token=abcdef12#frag', OTHER: 'abcdef12' });
    expect(env.HOOK).toBe('https://h/x?token=${S_TOKEN}#frag');
    expect(env.OTHER).toBe('${S_TOKEN}');
  });
});

describe('buildMcpExport: headers', () => {
  const headersOf = (headers: Record<string, string>) => {
    const result = build([http('hpe', 'https://hpe.example/mcp', headers)]);
    return { headers: httpOf(result.file.mcpServers.hpe).headers ?? {}, result };
  };

  it('hides every header but the safe list, keeping the scheme', () => {
    const { headers, result } = headersOf({
      Authorization: 'Bearer tok',
      'X-API-Key': 'k',
      Cookie: 'c=1',
      'x-functions-key': 'f',
      'Ocp-Apim-Subscription-Key': 'o',
      'X-Org-Key': 'g',
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'Anthropic-Api-Key': 'a',
    });
    expect(headers.Authorization).toBe('Bearer ${HPE_AUTHORIZATION_SECRET}');
    expect(variable(result, 'HPE_AUTHORIZATION_SECRET')).toMatchObject({ scheme: 'Bearer', places: [{ origin: 'https://hpe.example' }] });
    expect(headers['X-API-Key']).toBe('${HPE_X_API_KEY}');
    for (const name of ['Cookie', 'x-functions-key', 'Ocp-Apim-Subscription-Key', 'X-Org-Key']) {
      expect(headers[name]).toMatch(/^\$\{HPE_[A-Z_]+\}$/);
    }
    expect(headers.Accept).toBe('application/json');
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers['Anthropic-Api-Key']).toBe('${HPE_ANTHROPIC_API_KEY}');
    expect(result.text).not.toContain('${ANTHROPIC_API_KEY}');
  });

  it('replaces a header with no scheme whole', () => {
    expect(headersOf({ Authorization: 'tok' }).headers.Authorization).toBe('${HPE_AUTHORIZATION_SECRET}');
  });

  it('catches a token in a safe header', () => {
    const { headers, result } = headersOf({ 'User-Agent': 'sk-ant-api03-AbCdEf0123456789GhIjKlMnOpQr' });
    expect(headers['User-Agent']).toMatch(/^\$\{HPE_USER_AGENT_SECRET\}$/);
    expect(result.notes.some((n) => n.includes('header User-Agent looked like a secret'))).toBe(true);
  });
});

describe('buildMcpExport: args', () => {
  it('hides the value after a secret flag', () => {
    expect(argsOf(['--token', 'abc'])).toEqual(['--token', '${S_TOKEN}']);
    expect(argsOf(['--token=abc'])).toEqual(['--token=${S_TOKEN}']);
    expect(argsOf(['--token abc'])).toEqual(['--token ${S_TOKEN}']);
    expect(argsOf(['--password', '-p@ss!'])).toEqual(['--password', '${S_PASSWORD}']);
    expect(argsOf(['--password', '--verbose'])).toEqual(['--password', '--verbose']);
  });

  it('hides NAME=value args with secret names, keeping a scheme', () => {
    expect(argsOf(['api_key=xyz'])).toEqual(['api_key=${S_API_KEY}']);
    expect(argsOf(['Authorization=Bearer abc'])).toEqual(['Authorization=Bearer ${S_AUTHORIZATION_SECRET}']);
  });

  it('leaves file flags, no- and -stdin flags and a last flag alone', () => {
    for (const args of [['--token-file', '/x'], ['--token'], ['--no-token', 'run'], ['--password-stdin', 'x']]) {
      expect(argsOf(args)).toEqual(args);
    }
  });

  it('hides header args (mcp-remote --header)', () => {
    expect(argsOf(['--header', 'Authorization: Bearer abc'])).toEqual(['--header', 'Authorization: Bearer ${S_AUTHORIZATION_SECRET}']);
    expect(argsOf(['--header=Authorization: Bearer abc'])).toEqual(['--header=Authorization: Bearer ${S_AUTHORIZATION_SECRET}']);
    expect(argsOf(['--header', 'Authorization:Bearer abc'])).toEqual(['--header', 'Authorization:Bearer ${S_AUTHORIZATION_SECRET}']);
    expect(argsOf(['-H', 'X-Org-Key: abc'])).toEqual(['-H', 'X-Org-Key: ${S_X_ORG_KEY_SECRET}']);
  });

  it('leaves host:port and Windows paths alone', () => {
    expect(argsOf(['localhost:8080', 'C:\\tools\\server.exe'])).toEqual(['localhost:8080', 'C:\\tools\\server.exe']);
  });

  it('hides logins and secret query values in addresses', () => {
    expect(argsOf(['https://h/mcp?token=abc&x=1'])).toEqual(['https://h/mcp?token=${S_TOKEN}&x=1']);
    expect(argsOf(['postgres://u:pw@db/app'])).toEqual(['postgres://u:${S_URL_PASSWORD}@db/app']);
    expect(argsOf(['https://ghp_x@github.com/o/r'])).toEqual(['https://${S_URL_TOKEN}@github.com/o/r']);
    expect(argsOf(['postgres://postgres@h/db'])).toEqual(['postgres://postgres@h/db']);
  });

  it('guesses a token-shaped arg and says so', () => {
    const r = build([def({ name: 's', command: 'uvx', args: ['pkg', 'ghp_abcdefghijklmnopqrstuvwxyz0123456789'] })]);
    expect(stdioOf(r.file.mcpServers.s).args).toEqual(['pkg', '${S_ARG_2_SECRET}']);
    expect(r.notes).toContain('s: argument 2 looked like a secret, so it is now ${S_ARG_2_SECRET}.');
  });

  it('leaves package names and versions alone', () => {
    const args = ['hpe-networking-mcp==0.4.2', 'mcp-server-filesystem-v2.3.1', '@modelcontextprotocol/server-github'];
    expect(argsOf(args)).toEqual(args);
  });
});

describe('buildMcpExport: the server url', () => {
  it('hides secret query values and keeps the other bytes', () => {
    const r = build([http('h', 'https://h/mcp?api_key=abc&q=a%20b')]);
    expect(httpOf(r.file.mcpServers.h).url).toBe('https://h/mcp?api_key=${H_API_KEY}&q=a%20b');
    expect(r.notes.some((n) => n.startsWith('h: the address has a ${...} variable.'))).toBe(true);
    expect(httpOf(build([http('h', 'https://h/mcp?key=abc')]).file.mcpServers.h).url).toBe('https://h/mcp?key=${H_KEY_SECRET}');
    expect(httpOf(build([http('h', 'https://h/mcp?code=abc')]).file.mcpServers.h).url).toBe('https://h/mcp?code=${H_CODE_SECRET}');
    expect(httpOf(build([http('h', 'https://h/mcp?page_token=x')]).file.mcpServers.h).url).toBe('https://h/mcp?page_token=x');
  });

  it('moves a login to a Basic Authorization header', () => {
    const r = build([http('h', 'https://user:pass1@h/mcp'), def({ name: 's', command: 'uvx', env: { NOTE: 'user:pass1' } })]);
    const h = httpOf(r.file.mcpServers.h);
    expect(h.url).toBe('https://h/mcp');
    expect(h.headers).toEqual({ Authorization: 'Basic ${H_AUTHORIZATION_SECRET}' });
    expect(variable(r, 'H_AUTHORIZATION_SECRET')?.why).toBe('basic-auth');
    // H_AUTHORIZATION_SECRET is set to the base64 form, so the plain login elsewhere gets its own variable.
    expect(stdioOf(r.file.mcpServers.s).env?.NOTE).toBe('${H_LOGIN_SECRET}');
    expect(variable(r, 'H_LOGIN_SECRET')).toMatchObject({ why: 'secret', places: [{ server: 's', where: 'env NOTE' }] });
    expect(r.notes.some((n) => n.startsWith('h: the login in the address was moved to an Authorization header'))).toBe(true);
  });

  it('drops a login when an Authorization header is set', () => {
    const r = build([http('h', 'https://u:p@h/mcp', { authorization: 'Bearer t' })]);
    expect(httpOf(r.file.mcpServers.h).url).toBe('https://h/mcp');
    expect(r.notes.some((n) => n.startsWith('h: the address had a login in it, and you also set an Authorization header.'))).toBe(true);
  });

  it('adds a colon to a token-only login and decodes the password', () => {
    const token = build([http('h', 'https://tok123456@h/mcp'), def({ name: 's', command: 'uvx', env: { NOTE: 'tok123456:' } })]);
    expect(stdioOf(token.file.mcpServers.s).env?.NOTE).toBe('${H_LOGIN_SECRET}');
    const at = build([http('h', 'https://admin:P@ssw0rd@host/mcp'), def({ name: 's', command: 'uvx', env: { NOTE: 'admin:P@ssw0rd' } })]);
    expect(httpOf(at.file.mcpServers.h).url).toBe('https://host/mcp');
    expect(stdioOf(at.file.mcpServers.s).env?.NOTE).toBe('${H_LOGIN_SECRET}');
  });

  it('keeps the host GreenCLI connected to when the address has a backslash', () => {
    const r = build([http('h', 'https://host\\@evil.com/mcp')]);
    const url = httpOf(r.file.mcpServers.h).url;
    expect(url).toBe('https://host/@evil.com/mcp');
    expect(new URL(url).origin).toBe('https://host');
    expect(new URL(url).hostname).not.toBe('evil.com');
  });

  it('drops the #fragment', () => {
    expect(httpOf(build([http('h', 'https://h/mcp#x')]).file.mcpServers.h).url).toBe('https://h/mcp');
  });

  it('guesses a token-shaped path segment', () => {
    const r = build([http('h', 'https://h/mcp/AbCdEf0123456789GhIjKl/x')]);
    expect(httpOf(r.file.mcpServers.h).url).toBe('https://h/mcp/${H_URL_PATH_SECRET}/x');
    expect(r.notes).toContain('h: address path looked like a secret, so it is now ${H_URL_PATH_SECRET}.');
  });

  it('notes that Casper skips plain http outside this computer', () => {
    const note = (url: string) => build([http('h', url)]).notes.some((n) => n.includes('Casper only connects to https://'));
    expect(note('http://10.0.0.5/mcp')).toBe(true);
    for (const url of ['http://localhost:8010/mcp', 'http://127.0.0.1/mcp', 'http://[::1]:8010/mcp', 'https://10.0.0.5/mcp']) {
      expect(note(url)).toBe(false);
    }
  });
});

describe('buildMcpExport: ${NAME} the user wrote', () => {
  it('keeps references and lists them with plain-text wording', () => {
    const r = build([def({ name: 's', command: 'uvx', env: { TOKEN: '${TOKEN}' } })]);
    expect(stdioOf(r.file.mcpServers.s).env?.TOKEN).toBe('${TOKEN}');
    expect(variable(r, 'TOKEN')).toMatchObject({ why: 'already-a-reference', places: [{ server: 's', where: 'env TOKEN' }] });
    const text = exportSummary(r, '/p/.mcp.json').variables.find((v) => v.name === 'TOKEN')?.text;
    expect(text).toContain('GreenCLI sent it as plain text');
  });

  it('renames a header reference and says which origin it is sent to', () => {
    const r = build([http('h', 'https://h/mcp', { Authorization: 'Bearer ${MY_TOKEN}' })]);
    expect(httpOf(r.file.mcpServers.h).headers?.Authorization).toBe('Bearer ${H_MY_TOKEN}');
    expect(variable(r, 'MY_TOKEN')).toBeUndefined();
    expect(variable(r, 'H_MY_TOKEN')).toMatchObject({
      why: 'renamed-reference',
      from: 'MY_TOKEN',
      places: [{ server: 'h', where: 'header Authorization', origin: 'https://h' }],
    });
    expect(exportSummary(r, '/x').variables[0].text).toContain('sent to https://h');
  });

  it('leaves referenced flag values alone and skips ${HOME} in a stdio server', () => {
    expect(argsOf(['--token=${T}'])).toEqual(['--token=${T}']);
    expect(argsOf(['--token', '${T}'])).toEqual(['--token', '${T}']);
    const r = build([def({ name: 's', command: 'uvx', args: ['${HOME}/x'] })]);
    expect(r.variables).toEqual([]);
  });

  it('removes defaults that may be secrets', () => {
    const r = build([
      def({ name: 's', command: 'uvx', env: { MIST_API_TOKEN: '${MIST_API_TOKEN:-a1b2c3d4}', LEVEL: '${LEVEL:-info}' } }),
      http('h', 'https://h/mcp', { Authorization: 'Bearer ${T:-eyJabc}' }),
    ]);
    const env = stdioOf(r.file.mcpServers.s).env;
    expect(env?.MIST_API_TOKEN).toBe('${MIST_API_TOKEN}');
    expect(env?.LEVEL).toBe('${LEVEL:-info}');
    expect(httpOf(r.file.mcpServers.h).headers?.Authorization).toBe('Bearer ${H_T}');
    expect(r.notes).toContain('s: the default value in ${MIST_API_TOKEN:-…} was removed, because it may be a secret. Set MIST_API_TOKEN yourself.');
    expect(r.text).not.toContain('a1b2c3d4');
    expect(r.text).not.toContain('eyJabc');
  });

  it('removes the literal part of values that mix text and references', () => {
    const r = build([
      def({ name: 's', command: 'uvx', args: ['--token=${PREFIX}abc123'], env: { DB: 'postgres://${DB_USER}:hunter2@h/db' } }),
      http('h', 'https://h/mcp?env=${ENV}&token=litval', { Cookie: 'a=${A}; session=litcookie' }),
      http('g', 'https://g/mcp?token=abcdef&region=${REGION}'),
    ]);
    const s = stdioOf(r.file.mcpServers.s);
    expect(s.env?.DB).toBe('postgres://${DB_USER}:${DB_PASSWORD}@h/db');
    expect(s.args).toEqual(['--token=${S_TOKEN}']);
    expect(httpOf(r.file.mcpServers.h).url).toBe('https://h/mcp?env=${H_ENV}&token=${H_TOKEN}');
    expect(httpOf(r.file.mcpServers.h).headers?.Cookie).toBe('${H_COOKIE_SECRET}');
    expect(httpOf(r.file.mcpServers.g).url).toBe('https://g/mcp?token=${G_TOKEN}&region=${G_REGION}');
    for (const secret of ['hunter2', 'abc123', 'litval', 'litcookie', 'abcdef&']) expect(r.text).not.toContain(secret);
    expect(variable(r, 'DB_USER')?.why).toBe('already-a-reference');
    for (const name of ['H_ENV', 'G_REGION']) expect(variable(r, name)?.why).toBe('renamed-reference');
  });
});

describe('buildMcpExport: passwords under short names', () => {
  it('hides *_PW and *_PWD env values, but not PWD itself', () => {
    const { env, result } = envOf({ SWITCH_PW: 'Aruba!Passw0rd', CX_ADMIN_PWD: 'Aruba!Passw0rd2', ARUBA_PASS: 'p1', PWD: '/Users/me/proj' });
    expect(env.SWITCH_PW).toMatch(/^\$\{SWITCH_PW[A-Z_]*\}$/);
    expect(env.CX_ADMIN_PWD).toMatch(/^\$\{CX_ADMIN_PWD[A-Z_]*\}$/);
    expect(env.ARUBA_PASS).toMatch(/^\$\{ARUBA_PASS[A-Z_]*\}$/);
    expect(env.PWD).toBe('/Users/me/proj');
    expect(result.text).not.toMatch(/Aruba!Passw0rd/);
  });

  it('hides --pw, --pwd, --passwd and --pw=x', () => {
    expect(argsOf(['--pw', 'hunter2pass', '--pwd', 'b', '--passwd', 'c'])).toEqual([
      '--pw',
      '${S_PW_SECRET}',
      '--pwd',
      '${S_PWD}',
      '--passwd',
      '${S_PASSWD}',
    ]);
    expect(argsOf(['--pw=Aruba!Passw0rd'])).toEqual(['--pw=${S_PW_SECRET}']);
    expect(argsOf(['--pw Aruba!Passw0rd'])).toEqual(['--pw ${S_PW_SECRET}']);
  });

  it('hides -p and -P, but not a port, a version or a package runner own -p', () => {
    const r = build([def({ name: 's', command: 'uvx', args: ['aos-mcp', '--host', '10.0.0.1', '-u', 'admin', '-p', 'Aruba123!'] })]);
    expect(stdioOf(r.file.mcpServers.s).args).toEqual(['aos-mcp', '--host', '10.0.0.1', '-u', 'admin', '-p', '${S_P_SECRET}']);
    expect(r.text).not.toContain('Aruba123!');
    expect(argsOf(['tool', '-P', 'secret1'])).toEqual(['tool', '-P', '${S_P_SECRET}']);
    expect(argsOf(['tool', '-p=secret1'])).toEqual(['tool', '-p=${S_P_SECRET}']);
    expect(argsOf(['tool', '-p 22'])).toEqual(['tool', '-p 22']);
    expect(argsOf(['tool', '-p', '8443'])).toEqual(['tool', '-p', '8443']);
    expect(argsOf(['-p', '3.12', 'tool'])).toEqual(['-p', '3.12', 'tool']);
    const npx = build([def({ name: 's', command: 'npx', args: ['-y', '-p', '@scope/pkg', 'pkg-cli', '-p', 'Secret!1'] })]);
    expect(stdioOf(npx.file.mcpServers.s).args).toEqual(['-y', '-p', '@scope/pkg', 'pkg-cli', '-p', '${S_P_SECRET}']);
    expect(argsOf(['tool', '-p', '127.0.0.1:8080:80/tcp'])).toEqual(['tool', '-p', '127.0.0.1:8080:80/tcp']);
    const docker = ['run', '-i', '--rm', '-P', 'ghcr.io/org/mcp:1', '-p', '8080:80'];
    expect(stdioOf(build([def({ name: 's', command: 'docker', args: docker })]).file.mcpServers.s).args).toEqual(docker);
  });

  it('hides a secret flag value that starts with "-", but not a real next flag', () => {
    expect(argsOf(['--token', '-abcdef123'])).toEqual(['--token', '${S_TOKEN}']);
    expect(argsOf(['--password', '--weird--'])).toEqual(['--password', '${S_PASSWORD}']);
    expect(argsOf(['--password', '--verbose'])).toEqual(['--password', '--verbose']);
    expect(argsOf(['--password', '-v'])).toEqual(['--password', '-v']);
    expect(argsOf(['--password', '--log=debug'])).toEqual(['--password', '--log=debug']);
  });

  it('keeps the scheme of a secret-named env value', () => {
    const { env, result } = envOf({ API_KEY: 'Bearer abcdefgh' });
    expect(env.API_KEY).toBe('Bearer ${API_KEY}');
    expect(variable(result, 'API_KEY')?.scheme).toBe('Bearer');
    expect(exportSummary(result, '/x').variables[0].text).toBe('the secret that was in s (env API_KEY). Set just the token, without "Bearer".');
  });
});

describe('buildMcpExport: keys in addresses', () => {
  const urlOf = (url: string) => {
    const result = build([http('h', url)]);
    return { url: httpOf(result.file.mcpServers.h).url, result };
  };

  it('hides a key-shaped query value whatever its name, and a bare ?key', () => {
    const named = urlOf('https://mcp.example.com/mcp?k=ghp_Ab12Cd34Ef56Gh78Ij90Kl12&x=1');
    expect(named.url).toBe('https://mcp.example.com/mcp?k=${H_K_SECRET}&x=1');
    expect(named.result.notes).toContain('h: address ?k= looked like a secret, so it is now ${H_K_SECRET}.');
    expect(urlOf('https://mcp.example.com/mcp?ghp_Ab12Cd34Ef56Gh78Ij90Kl12').url).toBe('https://mcp.example.com/mcp?${H_QUERY_SECRET}');
    expect(urlOf('https://mcp.example.com/mcp?profile=sk-ant-api03-Ab12Cd34Ef56Gh78Ij90').url).toBe(
      'https://mcp.example.com/mcp?profile=${H_PROFILE_SECRET}',
    );
    expect(urlOf('https://h/mcp?id=550e8400-e29b-41d4-a716-446655440000').url).toBe('https://h/mcp?id=${H_ID_SECRET}');
    expect(urlOf('https://h/mcp?region=us-east-1&verbose').url).toBe('https://h/mcp?region=us-east-1&verbose');
  });

  it('hides UUID and long hex path segments', () => {
    expect(urlOf('https://h.example/mcp/550e8400-e29b-41d4-a716-446655440000').url).toBe('https://h.example/mcp/${H_URL_PATH_SECRET}');
    expect(urlOf('https://h.example/mcp/0123456789abcdef0123456789abcdef/x').url).toBe('https://h.example/mcp/${H_URL_PATH_SECRET}/x');
    expect(urlOf('https://h.example/v1/mcp/abc123').url).toBe('https://h.example/v1/mcp/abc123');
  });

  it('hides key-like path segments and query values in addresses in args and env', () => {
    const r = build([
      def({
        name: 's',
        command: 'npx',
        args: ['mcp-remote', 'https://mcp.example.com/s/Ab12Cd34Ef56Gh78Ij90Kl12/mcp', 'https://h/x?k=ghp_Ab12Cd34Ef56Gh78Ij90Kl12'],
        env: { HOOK: 'https://hooks.example.com/550e8400-e29b-41d4-a716-446655440000' },
      }),
    ]);
    const s = stdioOf(r.file.mcpServers.s);
    expect(s.args).toEqual(['mcp-remote', 'https://mcp.example.com/s/${S_URL_PATH_SECRET}/mcp', 'https://h/x?k=${S_K_SECRET}']);
    expect(s.env?.HOOK).toBe('https://hooks.example.com/${HOOK_PATH_SECRET}');
    expect(r.notes).toContain('s: address path in argument 2 looked like a secret, so it is now ${S_URL_PATH_SECRET}.');
    expect(r.text).not.toMatch(/Ab12Cd34|550e8400/);
  });

  it('asks for a percent-encoded value where the address had one', () => {
    const r = build([
      http('f', 'https://fn.azurewebsites.net/api/mcp?code=Ab3%2Bx9%2FQz%3D%3D'),
      def({ name: 'd', command: 'uvx', args: ['postgres://u:p%40ss%2Fw0rd@db/x'], env: { NOTE: 'p@ss/w0rd' } }),
    ]);
    expect(httpOf(r.file.mcpServers.f).url).toBe('https://fn.azurewebsites.net/api/mcp?code=${F_CODE_SECRET}');
    expect(variable(r, 'F_CODE_SECRET')?.urlEncoded).toBe(true);
    const d = stdioOf(r.file.mcpServers.d);
    expect(d.args).toEqual(['postgres://u:${D_URL_PASSWORD}@db/x']);
    expect(variable(r, 'D_URL_PASSWORD')?.urlEncoded).toBe(true);
    // The plain password elsewhere gets its own variable, set without encoding.
    expect(d.env?.NOTE).toBe('${D_URL_PASSWORD_PLAIN}');
    expect(variable(r, 'D_URL_PASSWORD_PLAIN')?.urlEncoded).toBeUndefined();
    const lines = Object.fromEntries(exportSummary(r, '/x').variables.map((v) => [v.name, v.text]));
    expect(lines.F_CODE_SECRET).toContain('set it URL-encoded');
    expect(lines.D_URL_PASSWORD).toContain('set it URL-encoded');
    expect(lines.D_URL_PASSWORD_PLAIN).not.toContain('URL-encoded');
    expect(r.text).not.toMatch(/p%40ss|p@ss|Ab3%2B/);
  });

  it('does not mark a value that needed no encoding', () => {
    const r = build([http('h', 'https://h/mcp?token=abc123')]);
    expect(variable(r, 'H_TOKEN')?.urlEncoded).toBeUndefined();
  });
});

describe('buildMcpExport: a login in the server url used elsewhere', () => {
  it('gives the plain login its own variable, not the base64 one', () => {
    const r = build([
      http('h', 'https://admin:Secret99@mcp.example.com/mcp'),
      def({ name: 'b', command: 'uvx', args: ['--login', 'admin:Secret99', '--note', 'Secret99'], env: { SWITCH_USERPASS: 'admin:Secret99' } }),
    ]);
    const b = stdioOf(r.file.mcpServers.b);
    // --login is a login flag, so its value gets a variable of its own before the sweep.
    expect(b.args).toEqual(['--login', '${B_LOGIN_SECRET}', '--note', '${H_PASSWORD}']);
    expect(b.env?.SWITCH_USERPASS).toBe('${H_LOGIN_SECRET}');
    expect(variable(r, 'H_AUTHORIZATION_SECRET')?.places).toEqual([
      { server: 'h', where: 'header Authorization', origin: 'https://mcp.example.com' },
    ]);
    expect(variable(r, 'H_LOGIN_SECRET')?.why).toBe('secret');
    expect(r.text).not.toContain('Secret99');
  });

  it('lists no sweep variable that nothing uses', () => {
    const r = build([http('h', 'https://admin:Secret99@mcp.example.com/mcp')]);
    expect(r.variables.map((v) => v.name)).toEqual(['H_AUTHORIZATION_SECRET']);
  });
});

describe('buildMcpExport: ${NAME} sent to a remote server', () => {
  it('renames a reference in an http address so an existing key is not sent', () => {
    const r = build([http('x', 'https://evil.example/mcp?x=${ANTHROPIC_API_KEY}', { Accept: '${GITHUB_TOKEN}' })]);
    const x = httpOf(r.file.mcpServers.x);
    expect(x.url).toBe('https://evil.example/mcp?x=${X_ANTHROPIC_API_KEY}');
    expect(x.headers?.Accept).toBe('${X_GITHUB_TOKEN}');
    expect(r.text).not.toMatch(/\$\{ANTHROPIC_API_KEY\}|\$\{GITHUB_TOKEN\}/);
    expect(variable(r, 'X_ANTHROPIC_API_KEY')).toMatchObject({ why: 'renamed-reference', from: 'ANTHROPIC_API_KEY' });
    expect(r.notes).toContain(
      'x: address used ${ANTHROPIC_API_KEY}, which looks like one of your own keys. It is now ${X_ANTHROPIC_API_KEY}, so a key already set in your shell is not sent to https://evil.example by mistake. Set X_ANTHROPIC_API_KEY only if you trust that server.',
    );
  });

  it('gives the same name to the same reference twice in one server, and a new one per server', () => {
    const r = build([
      http('a', 'https://a/mcp?t=${TOKEN}', { Authorization: 'Bearer ${TOKEN}' }),
      http('b', 'https://b/mcp?t=${TOKEN}'),
    ]);
    expect(httpOf(r.file.mcpServers.a).url).toBe('https://a/mcp?t=${A_TOKEN}');
    expect(httpOf(r.file.mcpServers.a).headers?.Authorization).toBe('Bearer ${A_TOKEN}');
    expect(httpOf(r.file.mcpServers.b).url).toBe('https://b/mcp?t=${B_TOKEN}');
    expect(variable(r, 'A_TOKEN')?.places.map((p) => p.where).sort()).toEqual(['address', 'header Authorization']);
  });

  it('does not clash with a name the user wrote elsewhere', () => {
    const r = build([def({ name: 's', env: { X: '${A_TOKEN}' } }), http('a', 'https://a/mcp', { 'X-Key': '${TOKEN}' })]);
    expect(httpOf(r.file.mcpServers.a).headers?.['X-Key']).toBe('${A_TOKEN_2}');
    expect(stdioOf(r.file.mcpServers.s).env?.X).toBe('${A_TOKEN}');
  });

  it('renames references in stdio addresses and -H headers, but keeps the server env keys and HOME', () => {
    const r = build([
      def({
        name: 'remote',
        command: 'npx',
        args: [
          'mcp-remote',
          'https://evil.example/mcp?k=${AWS_SECRET_ACCESS_KEY}',
          '--header',
          'Authorization:${AUTH_HEADER}',
          '-H',
          'X-Extra: ${GITHUB_TOKEN}',
          '--config=${HOME}/c.json',
        ],
        env: { AUTH_HEADER: 'Bearer abcdefgh123' },
      }),
    ]);
    const args = stdioOf(r.file.mcpServers.remote).args;
    expect(args[1]).toBe('https://evil.example/mcp?k=${REMOTE_AWS_SECRET_ACCESS_KEY}');
    expect(args[3]).toBe('Authorization:${AUTH_HEADER}');
    expect(args[5]).toBe('X-Extra: ${REMOTE_GITHUB_TOKEN}');
    expect(args[6]).toBe('--config=${HOME}/c.json');
    expect(variable(r, 'REMOTE_GITHUB_TOKEN')?.places).toEqual([{ server: 'remote', where: 'argument 6', origin: 'https://evil.example' }]);
    expect(variable(r, 'AWS_SECRET_ACCESS_KEY')).toBeUndefined();
  });

  it('keeps a default when it renames', () => {
    const r = build([http('h', 'https://h/mcp?region=${REGION:-us}')]);
    expect(httpOf(r.file.mcpServers.h).url).toBe('https://h/mcp?region=${H_REGION:-us}');
  });

  it('warns that a reference left in a stdio server is filled in from the shell', () => {
    const r = build([def({ name: 's', command: 'uvx', env: { TOKEN: '${TOKEN}' } })]);
    expect(exportSummary(r, '/x').variables[0].text).toContain('If it is already set in your shell, this server gets it.');
  });
});

describe('buildMcpExport: variable names', () => {
  it('prefixes header names with the server, so two servers do not share one', () => {
    const r = build([http('a', 'https://a/mcp', { Authorization: 'x1' }), http('b', 'https://b/mcp', { Authorization: 'x2' })]);
    expect(httpOf(r.file.mcpServers.a).headers?.Authorization).toBe('${A_AUTHORIZATION_SECRET}');
    expect(httpOf(r.file.mcpServers.b).headers?.Authorization).toBe('${B_AUTHORIZATION_SECRET}');
  });

  it('shares a name only for the same value', () => {
    const differ = build([def({ name: 'a', env: { TOKEN: 'one' } }), def({ name: 'b', env: { TOKEN: 'two' } })]);
    expect(stdioOf(differ.file.mcpServers.a).env?.TOKEN).toBe('${TOKEN}');
    expect(stdioOf(differ.file.mcpServers.b).env?.TOKEN).toBe('${TOKEN_2}');
    const same = build([def({ name: 'a', env: { TOKEN: 'one' } }), def({ name: 'b', env: { TOKEN: 'one' } })]);
    expect(stdioOf(same.file.mcpServers.b).env?.TOKEN).toBe('${TOKEN}');
    expect(variable(same, 'TOKEN')?.places.map((p) => p.server)).toEqual(['a', 'b']);
  });

  it('never reuses a name the user wrote, ignoring case', () => {
    const r = build([def({ name: 'a', env: { TOKEN: '${TOKEN}' } }), def({ name: 'b', env: { TOKEN: 'lit' } })]);
    expect(stdioOf(r.file.mcpServers.b).env?.TOKEN).toBe('${TOKEN_2}');
    const lower = build([def({ name: 'a', env: { FOO: '${token}' } }), def({ name: 'b', env: { TOKEN: 'lit' } })]);
    expect(stdioOf(lower.file.mcpServers.b).env?.TOKEN).toBe('${TOKEN_2}');
  });

  it('makes every new secret name one Casper hides', () => {
    const r = build([
      def({
        name: 'srv',
        args: ['--key', 'a', '--sig=b', 'pkg', 'AbCdEf0123456789GhIjKlMn', 'https://u:p@h/x?code=c'],
        env: { tacacs_key: 'x', X: 'Bearer abcdefgh123', SSH_KEY: 'k', DB: 'postgres://u:p@h/db' },
      }),
      http('h', 'https://u:p@h/mcp/AbCdEf0123456789GhIjKlMn?sig=s', { 'X-Org-Key': 'k', Cookie: 'c' }),
    ]);
    const made = r.variables.filter((v) => v.why === 'secret' || v.why === 'basic-auth');
    expect(made.length).toBeGreaterThan(8);
    for (const v of made) expect(isCasperSecretName(v.name)).toBe(true);
  });

  it('turns names into env names', () => {
    expect(toEnvName('X-API-Key')).toBe('X_API_KEY');
    expect(toEnvName('apiKey')).toBe('API_KEY');
    expect(toEnvName('--token')).toBe('TOKEN');
    expect(toEnvName('1st')).toBe('_1ST');
    expect(toEnvName('')).toBe('SECRET');
    expect(toEnvName('---')).toBe('SECRET');
    expect(toEnvName('MIST_APITOKEN')).toBe('MIST_APITOKEN');
  });
});

describe('buildMcpExport: saved credentials', () => {
  const withCredentials = (...names: string[]) => ({ withCredentials: new Set(names) });

  it('points the credentials variable at a file the user makes', () => {
    const r = build([def({ name: 's', env: { CREDS_PATH: '/old' } })], withCredentials('s'));
    expect(stdioOf(r.file.mcpServers.s).env).toEqual({ CREDS_PATH: '${S_CREDS_PATH}' });
    expect(variable(r, 'S_CREDS_PATH')).toMatchObject({ why: 'credentials-file', greencliName: 's' });
  });

  it('uses a custom variable and ignores a reference typed there', () => {
    const custom = build([def({ name: 's', credentialsEnvVar: 'CENTRAL_CREDS' })], withCredentials('s'));
    expect(stdioOf(custom.file.mcpServers.s).env).toEqual({ CENTRAL_CREDS: '${S_CENTRAL_CREDS}' });
    const typed = build([def({ name: 's', env: { CREDS_PATH: '${X}' } })], withCredentials('s'));
    expect(variable(typed, 'X')).toBeUndefined();
  });

  it('gives two servers two names, and skips servers without saved credentials and http servers', () => {
    const r = build(
      [def({ name: 's' }), def({ name: 't' }), def({ name: 'u' }), http('h', 'https://h/mcp')],
      withCredentials('s', 't', 'h'),
    );
    expect(stdioOf(r.file.mcpServers.s).env?.CREDS_PATH).toBe('${S_CREDS_PATH}');
    expect(stdioOf(r.file.mcpServers.t).env?.CREDS_PATH).toBe('${T_CREDS_PATH}');
    expect(stdioOf(r.file.mcpServers.u).env).toBeUndefined();
    expect(r.file.mcpServers.h).toEqual({ type: 'http', url: 'https://h/mcp' });
  });
});

describe('buildMcpExport: start folder', () => {
  it('leaves out cwd and says how to replace it', () => {
    const r = build([def({ name: 's', command: 'uv', args: ['run', 'srv'], cwd: '/p/centralmcp' })]);
    expect(r.text).not.toContain('cwd');
    const note = r.notes.find((n) => n.startsWith('s: its working folder'));
    expect(note).toContain('/p/centralmcp');
    expect(note).toContain('--directory /p/centralmcp');
  });

  it('warns when a server depends on the folder it starts in', () => {
    const warned = (command: string, args: string[]) =>
      build([def({ name: 's', command, args })]).notes.some((n) => n.includes('start this in the project folder you open'));
    expect(warned('python', ['-m', 'pkg'])).toBe(true);
    expect(warned('npx', ['pkg'])).toBe(true);
    expect(warned('uv', ['run', 'x'])).toBe(true);
    expect(warned('node', ['./server.js'])).toBe(true);
    expect(warned('./bin/server', [])).toBe(true);
    expect(warned('uvx', ['pkg'])).toBe(false);
    expect(warned('/abs/bin', [])).toBe(false);
    expect(warned('uv', ['--directory', '/p', 'run', 'x'])).toBe(false);
  });
});

describe('buildMcpExport: skipped servers and names', () => {
  it('leaves out servers that cannot run', () => {
    const r = build([
      def({ name: 'blank', command: '  ', args: ['${X}'] }),
      def({ name: 'b', command: 'bash' }),
      def({ name: 'z', command: '/bin/zsh' }),
      def({ name: 'p', command: 'C:\\Windows\\PowerShell.exe' }),
      http('nourl', ''),
      http('bad', 'not a url'),
      http('ftp', 'ftp://x'),
      def({ name: 'ok', command: 'uvx' }),
    ]);
    expect(r.count).toBe(1);
    expect(Object.keys(r.file.mcpServers)).toEqual(['ok']);
    expect(r.notes).toEqual([
      '"blank" was left out: it has no command.',
      '"b" was left out: GreenCLI does not start shell programs (like bash or PowerShell) as MCP servers.',
      '"z" was left out: GreenCLI does not start shell programs (like bash or PowerShell) as MCP servers.',
      '"p" was left out: GreenCLI does not start shell programs (like bash or PowerShell) as MCP servers.',
      '"nourl" was left out: it has no server URL.',
      '"bad" was left out: its server URL is not valid.',
      '"ftp" was left out: its server URL is not valid.',
    ]);
    expect(variable(r, 'X')).toBeUndefined();
  });

  it('renames servers to names both tools accept', () => {
    const r = build([
      def({ name: 'Aruba Central' }),
      def({ name: 'a.b' }),
      def({ name: 'x y' }),
      def({ name: 'x-y' }),
      def({ name: 'n'.repeat(70) }),
      def({ name: '!!!' }),
    ]);
    expect(Object.keys(r.file.mcpServers)).toEqual(['Aruba-Central', 'a-b', 'x-y-2', 'x-y', 'n'.repeat(64), 'server']);
    expect(r.notes).toContain('"Aruba Central" is saved as "Aruba-Central". Names can only use letters, numbers, - and _.');
    expect(r.notes).toContain('"x y" is saved as "x-y-2", because another server already uses "x-y".');
    expect(r.notes.some((n) => n.includes('"x-y" is saved'))).toBe(false);
    expect(exportServerName('  a  b ')).toBe('a-b');
  });

  it('keeps __proto__ and constructor as real keys', () => {
    const r = build([def({ name: '__proto__', env: { constructor: '1' } }), def({ name: 'b' })]);
    expect(Object.keys(r.file.mcpServers)).toEqual(['__proto__', 'b']);
    expect(r.count).toBe(Object.keys(r.file.mcpServers).length);
    expect(Object.keys(JSON.parse(r.text).mcpServers)).toEqual(['__proto__', 'b']);
    const server = Object.getOwnPropertyDescriptor(r.file.mcpServers, '__proto__')?.value as ExportedServer;
    expect(Object.keys(stdioOf(server).env ?? {})).toEqual(['constructor']);
  });

  it('notes when there are more servers than Casper uses', () => {
    const many = Array.from({ length: CASPER_MAX_SERVERS + 1 }, (_, i) => def({ name: `s${i}`, command: 'uvx' }));
    const r = build(many);
    expect(r.count).toBe(65);
    expect(r.notes).toContain('Casper uses at most 64 servers in total, from all its files together. This file alone has 65.');
    expect(build(many.slice(0, 64)).notes).toEqual([]);
  });
});

describe('buildMcpExport: writes off', () => {
  it("adds the read-only settings GreenCLI sends while writes are off", () => {
    const central = def({
      name: 'central',
      command: 'uv',
      args: ['run', 'centralmcp'],
      env: { centralmcp_readonly: '0', OTHER: 'x' },
      writes: 'off',
    });
    const grafana = def({ name: 'grafana', command: 'mcp-grafana', args: [], writes: undefined });
    const pins = new Map<string, McpExportPins>([
      ['central', { kind: 'pinned', args: ['run', 'centralmcp'], env: [['CENTRALMCP_READONLY', '1']], shown: ['CENTRALMCP_READONLY=1'] }],
      ['grafana', { kind: 'pinned', args: ['--disable-write'], env: [], shown: ['--disable-write'] }],
    ]);
    const r = build([central, grafana], { pins });
    expect(stdioOf(r.file.mcpServers.central).env).toEqual({ CENTRALMCP_READONLY: '1', OTHER: 'x' });
    expect(stdioOf(r.file.mcpServers.grafana).args).toEqual(['--disable-write']);
    expect(r.notes.filter((n) => /writes/i.test(n))).toEqual([
      'central: writes are off in GreenCLI, so its read-only settings are in the file too (CENTRALMCP_READONLY=1).',
      'grafana: writes are off in GreenCLI, so its read-only settings are in the file too (--disable-write).',
    ]);
  });

  it("says when the file can't keep writes off", () => {
    const pins = new Map<string, McpExportPins>([['junos', { kind: 'cannot-pin', reason: 'it has no read-only setting' }]]);
    const r = build(
      [
        def({ name: 'junos', command: 'python3', args: ['jmcp.py'], writes: 'off' }),
        http('mist', 'https://mist.example/mcp'),
        def({ name: 'other', command: 'uvx', writes: undefined }),
      ].map((d) => (d.name === 'mist' ? { ...d, writes: 'off' as const } : d)),
      { pins },
    );
    expect(r.notes.filter((n) => /writes/i.test(n))).toEqual([
      "Writes are off in GreenCLI for junos, mist and other, but the file can't keep that. Claude Code will offer their tools that change things. Casper starts every server with writes off.",
    ]);
    expect(build([def({ name: 's', command: 'uvx', writes: 'off' })]).notes).toEqual([
      "Writes are off in GreenCLI for s, but the file can't keep that. Claude Code will offer its tools that change things. Casper starts every server with writes off.",
    ]);
  });
});

describe('buildMcpExport: no secret leaks', () => {
  it('writes none of the secrets', () => {
    const r = build(
      [
        def({
          name: 's',
          command: 'uvx',
          args: [
            '--token', 'S3CRET-04',
            '--password=S3CRET-05',
            '--api-key S3CRET-06',
            '--header', 'Authorization: Bearer S3CRET-07',
            '--header=X-Api-Key: S3CRET-08',
            'client_secret=S3CRET-09',
            'https://h/x?access_token=S3CRET-10',
            'postgres://u:S3CRET-12@db/x',
            'ghp_S3CRET19abcdefghijklmnopqrstuvwxyz0123',
            '-p', 'S3CRET-20',
            '--pw', '-S3CRET-24',
            'https://h/s/S3CRET25abcdefghijklmnop/x?q=ghp_S3CRET26abcdefghijklmnop0123',
          ],
          env: {
            API_TOKEN: 'S3CRET-01-envtoken',
            NOTE: 'copy of S3CRET-01-envtoken',
            REDIS_URL: 'redis://:S3CRET-13@cache:6379/0',
            MIST_KEY: 'S3CRET-14',
            CONFIG: '{"client_secret":"S3CRET-17"}',
            JDBC_URL: 'jdbc:postgresql://u:S3CRET-18@h/db',
            SWITCH_PW: 'S3CRET-21',
          },
        }),
        http('h', 'https://user:S3CRET-11@h.example/mcp/S3CRET22abcdefghijklmnop?sig=S3CRET-16&k=ghp_S3CRET23abcdefghijklmnop0123', {
          Authorization: 'Bearer S3CRET-02-hdr',
          'x-functions-key': 'S3CRET-15',
          'User-Agent': 'sk-ant-api03-S3CRET03xYz0123456789AbCdEfGhIj',
        }),
      ],
      { withCredentials: new Set(['s']) },
    );
    expect(r.text).not.toMatch(/S3CRET/);
    expect(r.count).toBe(2);
  });
});

describe('name and value checks', () => {
  it('sorts header names', () => {
    for (const name of ['Authorization', 'X-Org-Key', 'x-functions-key']) expect(isSecretHeaderName(name)).toBe(true);
    for (const name of ['Accept', 'Content-Type', 'MCP-Protocol-Version']) expect(isSecretHeaderName(name)).toBe(false);
  });

  it('sorts field and query names', () => {
    expect(isSecretFieldName('PUBLIC_KEY')).toBe(false);
    expect(isSecretFieldName('SSH_PUBLIC_KEY')).toBe(false);
    expect(isSecretFieldName('MIST_KEY')).toBe(true);
    expect(isSecretFieldName('GITHUB_PAT')).toBe(true);
    expect(isSecretFieldName('token-file')).toBe(false);
    expect(isSecretQueryName('code')).toBe(true);
    expect(isSecretQueryName('page_token')).toBe(false);
  });

  it('finds references', () => {
    expect(hasReference('a ${X} b')).toBe(true);
    expect(hasReference('$X')).toBe(false);
    expect(onlyReferences(' ${A}${B:-x} ')).toBe(true);
    expect(onlyReferences('${A}b')).toBe(false);
    expect(onlyReferences('')).toBe(false);
  });

  it('spots values that look like secrets', () => {
    for (const value of [
      'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
      '{"client_secret":"x12345678"}',
      'aB3dE5gH7jK9mN1pQ3sT5vW7yZ9bC1dF3hJ5kL7',
      'AKIAIOSFODNN7EXAMPLE',
    ]) {
      expect(looksLikeSecretValue(value)).toBe(true);
    }
    for (const value of ['centralmcp', '/Users/me/creds.json', '@modelcontextprotocol/server-filesystem', 'info', '${TOKEN}', 'aruba_tool_router_2025_v3']) {
      expect(looksLikeSecretValue(value)).toBe(false);
    }
  });
});

describe('refusedExportPath', () => {
  it("refuses other apps' settings files", () => {
    for (const path of [
      '/Users/me/.claude.json',
      'C:\\Users\\me\\.claude.json',
      '/x/claude_desktop_config.json',
      '/p/.claude/settings.json',
      '/Users/me/.casper/mcp.json',
      '/p/.vscode/mcp.json',
      '/Users/me/.cursor/mcp.json',
      '/Users/me/.codeium/windsurf/mcp_config.json',
      '/Users/me/Library/Application Support/Code/User/mcp.json',
      'C:\\Users\\me\\AppData\\Roaming\\Code - Insiders\\User\\mcp.json',
      '/Users/me/Library/Application Support/com.choatelabs.greencli/mcp_servers.json',
    ]) {
      expect(refusedExportPath(path)).toBe(
        "GreenCLI does not write other apps' own settings files. Pick another place, for example .mcp.json in a project folder.",
      );
    }
  });

  it('allows .mcp.json in a project or home folder', () => {
    for (const path of ['/Users/me/.mcp.json', '/p/.mcp.json', 'C:\\proj\\.mcp.json', '/p/mcp.json']) {
      expect(refusedExportPath(path)).toBeNull();
    }
  });
});

describe('buildMcpExport: network logins', () => {
  it('hides short passwords under network login names and shapes', () => {
    const r = build([
      def({
        name: 's',
        command: 'uvx',
        args: ['junos-mcp', '-ppassw0rd', '--login', 'admin:Hunter22', 'snmp://public@10.0.0.1', '-port', '-p8080', '--enable', 'true'],
        env: {
          DEVICE_LOGIN: 'admin:Hunter22',
          ARUBA_CREDS: 'admin/Hunter22',
          SNMP_V3_PRIV: 'privpass1',
          RADIUS: 'radsecret',
          ENABLE: 'enablepw',
          TACACS: 'tacsecret',
          SNMP_COMMUNITY_RO: 'public',
          NOTE: 'netops:Lab2024!',
          FEATURE_ENABLE: 'true',
          CACHE: 'redis:alpine',
          PY: 'python:3.12',
          HOST: 'switch1:830',
        },
      }),
    ]);
    for (const secret of ['passw0rd', 'Hunter22', 'privpass1', 'radsecret', 'enablepw', 'tacsecret', 'public', 'Lab2024']) {
      expect(r.text).not.toContain(secret);
    }
    const s = stdioOf(r.file.mcpServers.s);
    expect(s.args[1]).toMatch(/^-p\$\{[A-Z_]+\}$/);
    expect(s.args.slice(5)).toEqual(['-port', '-p8080', '--enable', 'true']);
    expect(s.env?.FEATURE_ENABLE).toBe('true');
    expect(s.env?.CACHE).toBe('redis:alpine');
    expect(s.env?.PY).toBe('python:3.12');
    expect(s.env?.HOST).toBe('switch1:830');
  });

  it('keeps image tags and package references plain, but still hides user:password', () => {
    const plain = {
      IMAGE: 'node:20-alpine',
      DB_IMAGE: 'postgres:16-alpine',
      WEB: 'nginx:1.25-alpine',
      LTS: 'node:lts-alpine',
      PYTHON: 'python:3.12-slim-bookworm',
      REDIS: 'redis:7.2.4-alpine3.19',
      GHCR: 'ghcr.io/x/y:1.2',
      DB: 'db.example.com:5432',
      PORT: 'localhost:8080',
    };
    const hidden = { LOGIN: 'admin:Hunter22', OPS: 'ops:hunter22', SVC: 'svc:2024-Spring', U: 'user:pass1' };
    const r = build([def({ name: 's', command: 'uvx', args: ['x'], env: { ...plain, ...hidden } })]);
    const s = stdioOf(r.file.mcpServers.s);
    for (const [key, value] of Object.entries(plain)) expect([key, s.env?.[key]]).toEqual([key, value]);
    for (const [key, value] of Object.entries(hidden)) {
      expect(s.env?.[key]).toMatch(/^\$\{[A-Z_]+\}$/);
      expect(r.text).not.toContain(value);
    }
    expect(r.notes.join('\n')).not.toContain('env IMAGE');
  });

  it('hides a password made of a tag word and digits, but keeps dated and jdk tags plain', () => {
    const plain = { DEB: 'debian:bookworm-20240110', JAVA: 'eclipse-temurin:21-jdk-jammy', MQ: 'rabbitmq:3-management' };
    const hidden = {
      A: 'admin:alpha123',
      B: 'root:dev2024',
      C: 'admin:edge2023',
      D: 'admin:beta1',
      E: 'admin:lts2024',
      F: 'netops:stable-2024',
      G: 'svc:v12345',
    };
    const r = build([def({ name: 's', command: 'uvx', args: ['x'], env: { ...plain, ...hidden } })]);
    const s = stdioOf(r.file.mcpServers.s);
    for (const [key, value] of Object.entries(plain)) expect([key, s.env?.[key]]).toEqual([key, value]);
    for (const [key, value] of Object.entries(hidden)) {
      expect([key, s.env?.[key]]).toEqual([key, expect.stringMatching(/^\$\{[A-Z_]+\}$/)]);
      expect(r.text).not.toContain(value);
    }
  });
});

describe('exportSummary', () => {
  it('counts servers in the title', () => {
    expect(exportSummary(build([def({ name: 'a' })]), '/p/.mcp.json').title).toBe('Saved 1 server to /p/.mcp.json');
    expect(exportSummary(build([def({ name: 'a' }), def({ name: 'b' })]), '/p/.mcp.json').title).toBe('Saved 2 servers to /p/.mcp.json');
  });

  it('explains how to set variables only when there are some', () => {
    const none = exportSummary(build([def({ name: 'a' })]), '/x');
    expect(none.variablesIntro).toBe('GreenCLI found no passwords or tokens, so there is nothing to set.');
    expect(none.variables).toEqual([]);
    const some = exportSummary(build([def({ name: 'a', env: { TOKEN: 'abc' } })]), '/x');
    expect(some.variablesIntro).toContain("export NAME='value'");
    expect(some.variablesIntro).toContain("Don't put them in ~/.zshrc: every program you start would see them");
    expect(some.variablesIntro).toContain('shell history');
    expect(some.variablesIntro).toContain("the AI's own shell commands");
    // It no longer promises that nothing secret is left.
    expect(some.variablesIntro).not.toContain('Secrets are not in the file');
    expect(some.variablesIntro).not.toMatch(/add (them|it) to ~\/\.zshrc/i);
  });

  it('writes one line per kind of variable', () => {
    const r = build(
      [
        http('h', 'https://u:p@h/mcp', {}),
        http('g', 'https://g/mcp', { Authorization: 'Bearer abc', 'X-Ref': '${MINE}' }),
        def({ name: 'Aruba Central' }),
      ],
      { withCredentials: new Set(['Aruba Central']) },
    );
    const lines = Object.fromEntries(exportSummary(r, '/x').variables.map((v) => [v.name, v.text]));
    expect(lines.G_AUTHORIZATION_SECRET).toBe(
      'the secret that was in g (header Authorization, sent to https://g). Set just the token, without "Bearer".',
    );
    expect(lines.H_AUTHORIZATION_SECRET).toContain('the login that was in the address of h (header Authorization, sent to https://h)');
    expect(lines.H_AUTHORIZATION_SECRET).toContain('base64');
    expect(lines.H_AUTHORIZATION_SECRET).toContain('Control-D');
    expect(lines.H_AUTHORIZATION_SECRET).not.toContain('printf');
    expect(lines.ARUBA_CENTRAL_CREDS_PATH).toContain('a credentials file for Aruba Central');
    expect(lines.ARUBA_CENTRAL_CREDS_PATH).toContain('chmod 600');
    expect(lines.G_MINE).toBe(
      'written as ${MINE} in g (header X-Ref, sent to https://g). GreenCLI sent that text as it is, but Claude Code fills it in and sends it to the server. So it has a new name, and a MINE already set in your shell is not sent there by mistake. Set it only if you trust that server.',
    );
  });

  it('says where the file goes and to check it', () => {
    const summary = exportSummary(build([def({ name: 'a' })]), '/x');
    expect(summary.whereToPut).toBe(
      'Claude Code reads .mcp.json in the folder you start it in. Casper reads .mcp.json in your project folder, and ~/.mcp.json in your home folder. ' +
        'In Casper, type /mcp connect NAME once for each server. ' +
        "GreenCLI's approval box doesn't go with the file: Claude Code and Casper ask in their own way. " +
        'If a file was already there, it was replaced, not merged. On a Mac, Finder hides names that start with a dot; press Command-Shift-. to see them.',
    );
    expect(summary.check).toBe('Values that look like passwords, keys or tokens were replaced, but check the file before you share it.');
  });
});
