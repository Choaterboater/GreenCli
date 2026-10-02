import { describe, expect, it } from 'vitest';
import { classifyUrl, isLocalHost, plainHttpWarning } from './urlSafety';

// The local and remote cases from src-tauri/src/api/mod.rs (is_loopback_host), plus more.
describe('classifyUrl', () => {
  it.each([
    'http://localhost:11434',
    'http://127.0.0.1:8010/mcp',
    'http://127.9.9.9',
    'http://127.1',
    'http://[::1]:8000',
    'HTTP://LOCALHOST',
    'http://localhost:8080/hook',
    ' http://127.0.0.1/hook ',
    'http://[0:0:0:0:0:0:0:1]/',
  ])('%s is this computer', (url) => {
    expect(classifyUrl(url)).toBe('http-local');
  });

  it.each([
    'http://10.0.0.5:8010/mcp',
    'http://127.0.0.1.nip.io/mcp',
    'http://127.evil.example',
    'http://localhost.evil.example',
    'http://10.0.0.5/hook',
    'http://[::ffff:127.0.0.1]/',
    'http://192.168.1.20:11434',
  ])('%s is another computer', (url) => {
    expect(classifyUrl(url)).toBe('http-remote');
  });

  it('https, other schemes and junk', () => {
    expect(classifyUrl('https://api.mist.com/mcp')).toBe('https');
    expect(classifyUrl('https://10.0.0.5/mcp')).toBe('https');
    expect(classifyUrl('ftp://10.0.0.5/')).toBe('other');
    expect(classifyUrl('not a url')).toBe('invalid');
    expect(classifyUrl('')).toBe('invalid');
  });
});

describe('isLocalHost', () => {
  it('accepts only localhost, 127/8 and ::1', () => {
    expect(isLocalHost('[::1]')).toBe(true);
    expect(isLocalHost('LocalHost')).toBe(true);
    expect(isLocalHost('127.255.0.1')).toBe(true);
    expect(isLocalHost('127.0.0.1.nip.io')).toBe(false);
    expect(isLocalHost('128.0.0.1')).toBe(false);
    expect(isLocalHost('')).toBe(false);
  });
});

describe('plainHttpWarning', () => {
  it('warns only for plain http to another computer', () => {
    expect(plainHttpWarning('http://10.0.0.5:8010/mcp', 'mcp')).toMatch(/^Plain http:\/\/ to another computer: anyone/);
    expect(plainHttpWarning('http://10.0.0.5:11434', 'ollama')).toMatch(/run Ollama on this computer\.$/);
    expect(plainHttpWarning('http://localhost:11434', 'ollama')).toBeUndefined();
    expect(plainHttpWarning('https://central.example.com/mcp', 'mcp')).toBeUndefined();
    expect(plainHttpWarning('not a url', 'mcp')).toBeUndefined();
    expect(plainHttpWarning('', 'mcp')).toBeUndefined();
  });
});
