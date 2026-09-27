import { describe, it, expect } from 'vitest';
import { placeInFocusedPane, removeFromPanes, setPaneAt, settleSplit } from './splitPanes';

describe('placeInFocusedPane', () => {
  it('only moves focus when the session already has a pane (no reordering)', () => {
    const panes = ['a', 'b', 'c'];
    expect(placeInFocusedPane(panes, 'a', 'c')).toBe(panes);
  });

  it('replaces the focused pane in place with a session that has none', () => {
    expect(placeInFocusedPane(['a', 'b', 'c'], 'b', 'x')).toEqual(['a', 'x', 'c']);
  });

  it('fills a free column while the layout has fewer than two panes', () => {
    expect(placeInFocusedPane(['a'], 'a', 'x')).toEqual(['a', 'x']);
    expect(placeInFocusedPane([], null, 'x')).toEqual(['x']);
  });

  it('leaves the layout alone when the focused session is not in it', () => {
    const panes = ['a', 'b'];
    expect(placeInFocusedPane(panes, 'z', 'x')).toBe(panes);
  });
});

describe('removeFromPanes', () => {
  it('keeps focus when a different pane closes', () => {
    expect(removeFromPanes(['a', 'b', 'c'], 'a', 'c')).toEqual({ panes: ['a', 'b'], focus: 'a' });
  });

  it('hands focus to the pane that takes the closed column', () => {
    expect(removeFromPanes(['a', 'b', 'c'], 'b', 'b')).toEqual({ panes: ['a', 'c'], focus: 'c' });
  });

  it('falls back to the previous column when the last one closes', () => {
    expect(removeFromPanes(['a', 'b', 'c'], 'c', 'c')).toEqual({ panes: ['a', 'b'], focus: 'b' });
  });

  it('is a no-op for a session without a pane', () => {
    const panes = ['a', 'b'];
    expect(removeFromPanes(panes, 'a', 'z')).toEqual({ panes, focus: 'a' });
  });
});

describe('setPaneAt', () => {
  it('swaps instead of showing a session twice', () => {
    expect(setPaneAt(['a', 'b', 'c'], 'a', 0, 'c')).toEqual({ panes: ['c', 'b', 'a'], focus: 'c' });
  });

  it('keeps focus on the pane when its session changes', () => {
    expect(setPaneAt(['a', 'b'], 'b', 1, 'x')).toEqual({ panes: ['a', 'x'], focus: 'x' });
    expect(setPaneAt(['a', 'b'], 'a', 1, 'x')).toEqual({ panes: ['a', 'x'], focus: 'a' });
  });

  it('ignores an out-of-range column', () => {
    const panes = ['a', 'b'];
    expect(setPaneAt(panes, 'a', 5, 'x')).toEqual({ panes, focus: 'a' });
  });
});

describe('settleSplit', () => {
  it('exits split view with fewer than two panes', () => {
    expect(settleSplit(['a'], true)).toEqual({ splitPanes: [], splitView: false });
    expect(settleSplit(['a', 'b'], true)).toEqual({ splitPanes: ['a', 'b'], splitView: true });
  });
});
