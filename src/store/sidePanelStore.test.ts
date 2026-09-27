import { describe, it, expect, beforeEach } from 'vitest';
import { useSidePanelStore } from './sidePanelStore';

const store = () => useSidePanelStore.getState();

beforeEach(() => {
  localStorage.clear();
  useSidePanelStore.setState({
    preferred: { editor: 520, api: 420, ai: 420 },
    fitted: { editor: 520, api: 420, ai: 420 },
    open: [],
    docked: [],
    space: Infinity,
    lastSync: '',
  });
});

describe('sidePanelStore', () => {
  it('closes the least recently opened panel when a third will not fit', () => {
    store().setRowWidth(1300); // 820 px for panels
    expect(store().syncOpen(['ai'], ['ai'])).toEqual([]);
    expect(store().syncOpen(['editor', 'ai'], ['editor', 'ai'])).toEqual([]);
    // Both shrunk to share 820 px.
    expect(store().fitted.editor + store().fitted.ai).toBeLessThanOrEqual(820);
    // A third panel's floor doesn't fit alongside two others → the AI panel
    // (opened first) goes, not the editor or the API panel just opened.
    expect(store().syncOpen(['editor', 'api', 'ai'], ['editor', 'api', 'ai'])).toEqual(['ai']);
    expect(store().open).toEqual(['editor', 'api']);
  });

  it('treats a repeated sync as a no-op', () => {
    store().setRowWidth(1000);
    store().syncOpen(['editor', 'ai'], ['editor', 'ai']);
    expect(store().syncOpen(['editor', 'ai'], ['editor', 'ai'])).toEqual([]);
  });

  it('does not close panels when the window narrows', () => {
    store().setRowWidth(2000);
    store().syncOpen(['editor', 'api', 'ai'], ['editor', 'api', 'ai']);
    store().setRowWidth(900);
    expect(store().open).toEqual(['editor', 'api', 'ai']);
    expect(store().fitted).toEqual({ editor: 320, api: 320, ai: 320 });
  });

  it('ignores the editor when it fills the area instead of docking', () => {
    store().setRowWidth(1000); // 520 px for panels
    store().syncOpen(['editor', 'ai'], ['ai']);
    expect(store().fitted.ai).toBe(420);
  });

  it('saves a dragged width per panel and restores it clamped', () => {
    store().setRowWidth(1400);
    store().syncOpen(['ai'], ['ai']);
    store().commitWidth('ai', 610);
    expect(localStorage.getItem('atp-panel-width-ai')).toBe('610');
    expect(store().fitted.ai).toBe(610);
    // Out-of-range drags are clamped to the panel's limits.
    store().commitWidth('ai', 5000);
    expect(store().preferred.ai).toBe(800);
  });
});
