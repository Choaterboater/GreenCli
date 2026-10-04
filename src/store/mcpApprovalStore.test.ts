import { afterEach, describe, expect, it } from 'vitest';
import { allowanceKey, useMcpApprovalStore } from './mcpApprovalStore';

const store = () => useMcpApprovalStore.getState();

afterEach(() => store().clearAll());

describe('mcpApprovalStore', () => {
  it('allows a tool only with the same fingerprint', () => {
    store().allow('srx', 'get_device', 'fp1');
    expect(store().isAllowed('srx', 'get_device', 'fp1')).toBe(true);
    expect(store().isAllowed('srx', 'get_device', 'fp2')).toBe(false);
    expect(store().isAllowed('srx', 'get_other', 'fp1')).toBe(false);
    expect(store().isAllowed('other', 'get_device', 'fp1')).toBe(false);
  });

  it('clears one server and leaves the others', () => {
    store().allow('a', 'get_x', 'f');
    store().allow('ab', 'get_x', 'f');
    store().allow('b', 'get_y', 'f');
    store().clearServer('a');
    expect(store().isAllowed('a', 'get_x', 'f')).toBe(false);
    expect(store().isAllowed('ab', 'get_x', 'f')).toBe(true);
    expect(store().isAllowed('b', 'get_y', 'f')).toBe(true);
  });

  it('clears everything', () => {
    store().allow('a', 'get_x', 'f');
    store().clearAll();
    expect(store().allowed).toEqual({});
  });

  it('remembers show commands per device (server + tool + device)', () => {
    store().allowDevice('greencli-mcp', 'device_show', 'sw-a');
    expect(store().isDeviceAllowed('greencli-mcp', 'device_show', 'sw-a')).toBe(true);
    expect(store().isDeviceAllowed('greencli-mcp', 'device_show', 'sw-b')).toBe(false);
    expect(store().isDeviceAllowed('greencli-mcp', 'other_tool', 'sw-a')).toBe(false);
    expect(store().isDeviceAllowed('other', 'device_show', 'sw-a')).toBe(false);
    // A device answer is not a tool answer, and the other way round.
    expect(store().isAllowed('greencli-mcp', 'device_show', 'sw-a')).toBe(false);
    store().allow('greencli-mcp', 'device_show', 'fp');
    expect(store().isDeviceAllowed('greencli-mcp', 'device_show', 'fp')).toBe(false);
    expect(store().isDeviceAllowed('__proto__', '', '')).toBe(false);
  });

  it('clearServer and clearAll drop device answers too', () => {
    store().allowDevice('a', 'device_show', 'sw-a');
    store().allowDevice('b', 'device_show', 'sw-a');
    store().clearServer('a');
    expect(store().isDeviceAllowed('a', 'device_show', 'sw-a')).toBe(false);
    expect(store().isDeviceAllowed('b', 'device_show', 'sw-a')).toBe(true);
    store().clearAll();
    expect(store().devices).toEqual({});
  });

  it("doesn't mistake an inherited key for an allowance", () => {
    expect(store().isAllowed('__proto__', '', '')).toBe(false);
    expect(allowanceKey('a', 'b')).toBe('a\u0000b');
  });
});
