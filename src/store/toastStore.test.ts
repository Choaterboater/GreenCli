import { describe, it, expect, beforeEach } from 'vitest';
import {
  addToast,
  defaultToastDuration,
  joinToastParts,
  MAX_TOASTS,
  notify,
  Toast,
  useToastStore,
} from './toastStore';

const push = (toasts: Toast[], input: Parameters<typeof addToast>[1], id = 'new', now = 1000) =>
  addToast(toasts, input, id, now);

describe('defaultToastDuration', () => {
  it('keeps errors up longer, and errors with an action until dismissed', () => {
    expect(defaultToastDuration('success', false)).toBe(4000);
    expect(defaultToastDuration('info', false)).toBe(4000);
    expect(defaultToastDuration('error', false)).toBe(10_000);
    expect(defaultToastDuration('error', true)).toBe(0);
    expect(defaultToastDuration('warning', true)).toBe(8000);
  });
});

describe('addToast', () => {
  it('folds an identical toast into the one on screen with a count', () => {
    const first = push([], { kind: 'error', title: 'Send failed', message: 'timeout' }, 'a', 1000);
    const second = push(first.toasts, { kind: 'error', title: 'Send failed', message: 'timeout' }, 'b', 2500);
    expect(second.toasts).toHaveLength(1);
    expect(second.id).toBe('a');
    expect(second.toasts[0].count).toBe(2);
    // Bumped, so the card restarts its dismiss timer.
    expect(second.toasts[0].bumpedAt).toBe(2500);
  });

  it('keeps toasts that differ in kind, title or message apart', () => {
    let list = push([], { kind: 'error', title: 'A', message: 'x' }, '1').toasts;
    list = push(list, { kind: 'warning', title: 'A', message: 'x' }, '2').toasts;
    list = push(list, { kind: 'error', title: 'B', message: 'x' }, '3').toasts;
    list = push(list, { kind: 'error', title: 'A', message: 'y' }, '4').toasts;
    expect(list.map((t) => t.count)).toEqual([1, 1, 1, 1]);
  });

  it('does not fold into a toast that was already dismissed', () => {
    const first = push([], { kind: 'info', title: 'Saved' }, 'a');
    const afterDismiss = first.toasts.filter((t) => t.id !== 'a');
    const again = push(afterDismiss, { kind: 'info', title: 'Saved' }, 'b');
    expect(again.id).toBe('b');
    expect(again.toasts[0].count).toBe(1);
  });

  it('lists the distinct messages of a group in one card', () => {
    let r = push([], { kind: 'success', title: 'Connected', message: 'sw-01', group: 'connected' }, 'a');
    r = push(r.toasts, { kind: 'success', title: 'Connected', message: 'sw-02', group: 'connected' }, 'b');
    r = push(r.toasts, { kind: 'success', title: 'Connected', message: 'sw-02', group: 'connected' }, 'c');
    expect(r.toasts).toHaveLength(1);
    expect(r.toasts[0].message).toBe('sw-01, sw-02');
    expect(r.toasts[0].count).toBe(3);
  });

  it('lets the newest push decide action and lifetime', () => {
    const run = () => {};
    let r = push([], { kind: 'error', title: 'Dropped', message: 'sw-01' }, 'a');
    expect(r.toasts[0].duration).toBe(10_000);
    r = push(r.toasts, { kind: 'error', title: 'Dropped', message: 'sw-01', action: { label: 'Reconnect', run } }, 'b');
    expect(r.toasts[0].action?.label).toBe('Reconnect');
    expect(r.toasts[0].duration).toBe(0);
  });

  it(`keeps only the newest ${MAX_TOASTS}`, () => {
    let list: Toast[] = [];
    for (let i = 0; i < MAX_TOASTS + 2; i++) list = push(list, { kind: 'info', title: `t${i}` }, `id${i}`).toasts;
    expect(list).toHaveLength(MAX_TOASTS);
    expect(list[0].title).toBe('t2');
  });
});

describe('joinToastParts', () => {
  it('summarises long lists', () => {
    expect(joinToastParts(['a'])).toBe('a');
    expect(joinToastParts(['a', 'b', 'c'])).toBe('a, b, c');
    expect(joinToastParts(['a', 'b', 'c', 'd', 'e'])).toBe('a, b, c and 2 more');
  });
});

describe('notify', () => {
  beforeEach(() => useToastStore.getState().clear());

  it('passes options through to the store', () => {
    const run = () => {};
    const id = notify.error('Session dropped', 'sw-01', { action: { label: 'Reconnect', run } });
    const [toast] = useToastStore.getState().toasts;
    expect(toast.id).toBe(id);
    expect(toast.action?.run).toBe(run);
    expect(toast.duration).toBe(0);
  });

  it('returns the existing id when a duplicate folds in', () => {
    const a = notify.info('Copied');
    const b = notify.info('Copied');
    expect(b).toBe(a);
    expect(useToastStore.getState().toasts[0].count).toBe(2);
  });
});
