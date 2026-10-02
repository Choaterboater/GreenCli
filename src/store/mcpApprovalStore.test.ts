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

  it("doesn't mistake an inherited key for an allowance", () => {
    expect(store().isAllowed('__proto__', '', '')).toBe(false);
    expect(allowanceKey('a', 'b')).toBe('a\u0000b');
  });
});
