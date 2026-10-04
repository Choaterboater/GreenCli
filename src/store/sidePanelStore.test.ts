import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SIDE_PANEL, sidePanelDragMax, useSidePanelStore } from './sidePanelStore';
import { useSessionStore } from './sessionStore';
import { PANEL_FIT_MIN_WIDTH, TERMINAL_MIN_WIDTH } from '../utils/panelFit';

const store = () => useSidePanelStore.getState();

beforeEach(() => {
  localStorage.clear();
  useSidePanelStore.setState({
    preferred: 480,
    fitted: 480,
    space: Infinity,
    tab: 'ai',
    maximized: false,
    status: {},
  });
  useSessionStore.setState({ showConfigEditor: false, showApiExplorer: false, showAiAssistant: false });
});

describe('sidePanelStore', () => {
  it('keeps its preferred width while the terminal has room', () => {
    store().setRowWidth(1400); // 920 px beside the terminal's minimum
    expect(store().fitted).toBe(480);
  });

  it('shrinks the panel so the terminal keeps its minimum, down to a floor', () => {
    store().setRowWidth(TERMINAL_MIN_WIDTH + 400);
    expect(store().fitted).toBe(400);
    // Never below the floor, even in a tiny window — the panel is not closed.
    store().setRowWidth(TERMINAL_MIN_WIDTH + 100);
    expect(store().fitted).toBe(PANEL_FIT_MIN_WIDTH);
    // Growing the window gives the preferred width back.
    store().setRowWidth(2000);
    expect(store().fitted).toBe(480);
  });

  it('saves a dragged width with no fixed upper limit', () => {
    store().setRowWidth(1600); // 1120 px beside the terminal's minimum
    store().commitWidth(610);
    expect(localStorage.getItem('greencli-side-panel-width')).toBe('610');
    expect(store().fitted).toBe(610);
    // Wider than the old 1000 px limit sticks.
    store().commitWidth(1100);
    expect(localStorage.getItem('greencli-side-panel-width')).toBe('1100');
    expect(store().preferred).toBe(1100);
    expect(store().fitted).toBe(1100);
    // Too wide for the row: kept as preferred, shown so the terminal keeps its minimum.
    store().commitWidth(5000);
    expect(store().preferred).toBe(5000);
    expect(store().fitted).toBe(1600 - TERMINAL_MIN_WIDTH);
    store().commitWidth(10);
    expect(store().preferred).toBe(SIDE_PANEL.min);
  });

  it('a wide width shrinks in a small window and comes back when it grows', () => {
    store().commitWidth(1400);
    store().setRowWidth(1200);
    expect(store().fitted).toBe(720);
    store().setRowWidth(2400);
    expect(store().fitted).toBe(1400);
  });

  it('an unmeasured row (width 0) leaves the panel at its preferred width', () => {
    store().commitWidth(900);
    store().setRowWidth(1600);
    store().setRowWidth(0);
    expect(store().space).toBe(Infinity);
    expect(store().fitted).toBe(900);
    expect(sidePanelDragMax(store().fitted, store().space)).toBe(Infinity);
  });

  it('restores a saved wide width without cutting it down', async () => {
    localStorage.setItem('greencli-side-panel-width', '1500');
    vi.resetModules();
    const fresh = await import('./sidePanelStore');
    expect(fresh.useSidePanelStore.getState().preferred).toBe(1500);
  });

  it('remembers the last tab across restarts', () => {
    store().setTab('editor');
    expect(store().tab).toBe('editor');
    expect(localStorage.getItem('greencli-side-panel-tab')).toBe('editor');
  });

  it('tracks per-tab status and clears it', () => {
    store().setStatus('ai', 'busy');
    store().setStatus('editor', 'dirty');
    expect(store().status).toEqual({ ai: 'busy', editor: 'dirty' });
    store().setStatus('ai', null);
    expect(store().status).toEqual({ editor: 'dirty' });
  });
});

describe('sidePanelDragMax', () => {
  it('lets the panel grow until the terminal is at its minimum', () => {
    expect(sidePanelDragMax(480, 1520)).toBe(1520);
  });

  it('never goes below the fitted width in a tiny window', () => {
    expect(sidePanelDragMax(320, 100)).toBe(320);
  });

  it('has no limit before the row is measured', () => {
    expect(sidePanelDragMax(480, Infinity)).toBe(Infinity);
  });
});

describe('side panel tabs (sessionStore)', () => {
  const open = () => {
    const s = useSessionStore.getState();
    return { editor: s.showConfigEditor, api: s.showApiExplorer, ai: s.showAiAssistant };
  };

  it('shows one tab at a time', () => {
    useSessionStore.getState().setShowAiAssistant(true);
    useSessionStore.getState().setShowConfigEditor(true);
    expect(open()).toEqual({ editor: true, api: false, ai: false });
    useSessionStore.getState().setShowApiExplorer(true);
    expect(open()).toEqual({ editor: false, api: true, ai: false });
  });

  it('a toggle switches to its tab, or closes the panel when that tab is showing', () => {
    useSessionStore.getState().toggleAiAssistant();
    expect(open()).toEqual({ editor: false, api: false, ai: true });
    useSessionStore.getState().toggleConfigEditor(); // switch, don't close
    expect(open()).toEqual({ editor: true, api: false, ai: false });
    useSessionStore.getState().toggleConfigEditor(); // already showing → close
    expect(open()).toEqual({ editor: false, api: false, ai: false });
  });

  it('hiding a tab that is not showing leaves the open one alone', () => {
    useSessionStore.getState().setShowApiExplorer(true);
    useSessionStore.getState().setShowAiAssistant(false);
    expect(open()).toEqual({ editor: false, api: true, ai: false });
  });
});
