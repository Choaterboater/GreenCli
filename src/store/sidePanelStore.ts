import { useCallback } from 'react';
import { create } from 'zustand';
import { fitSidePanels, TERMINAL_MIN_WIDTH } from '../utils/panelFit';

export type SidePanelKey = 'editor' | 'api' | 'ai';

/** The tabs of the one right-side panel, in tab-strip order. */
export const SIDE_PANEL_TABS: { key: SidePanelKey; label: string; title: string }[] = [
  { key: 'editor', label: 'Editor', title: 'Config Editor' },
  { key: 'api', label: 'API', title: 'API Explorer' },
  { key: 'ai', label: 'AI', title: 'AI Assistant' },
];

/** Default width and drag limits of the side panel (shared by every tab, so
 *  switching tabs never makes the terminal jump). */
export const SIDE_PANEL = { width: 480, min: 300, max: 1000 };

const WIDTH_KEY = 'greencli-side-panel-width';
const TAB_KEY = 'greencli-side-panel-tab';
// Widths saved per panel before the panels became tabs of one panel. The
// first one found seeds the shared width, so an upgrade keeps a dragged size.
const LEGACY_WIDTH_KEYS = ['atp-panel-width-ai', 'atp-panel-width-editor', 'atp-panel-width-api'];

const clampWidth = (w: number) => Math.round(Math.max(SIDE_PANEL.min, Math.min(SIDE_PANEL.max, w)));

function readNumber(key: string): number | null {
  try {
    const n = Number(localStorage.getItem(key));
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null; // storage unavailable
  }
}

function loadPreferred(): number {
  for (const key of [WIDTH_KEY, ...LEGACY_WIDTH_KEYS]) {
    const saved = readNumber(key);
    if (saved != null) return clampWidth(saved);
  }
  return SIDE_PANEL.width;
}

function loadTab(): SidePanelKey {
  try {
    const saved = localStorage.getItem(TAB_KEY);
    if (SIDE_PANEL_TABS.some((t) => t.key === saved)) return saved as SidePanelKey;
  } catch {
    /* storage unavailable — use the default */
  }
  return 'ai';
}

/** Tab status shown on the panel's tab and the activity bar. */
export type SidePanelStatus = 'busy' | 'dirty';

interface SidePanelState {
  /** Width the user last dragged the panel to (persisted). */
  preferred: number;
  /** Width the panel renders at: the preferred width, shrunk so the terminal
   *  keeps TERMINAL_MIN_WIDTH. */
  fitted: number;
  /** Room for the panel once the terminal has its minimum (Infinity until measured). */
  space: number;
  /** The tab shown last (persisted) — reopening the panel comes back to it. */
  tab: SidePanelKey;
  /** The panel takes over the window (sidebar and terminal hidden, still mounted). */
  maximized: boolean;
  /** Per-tab status reported by the panel bodies (AI thinking, unsaved editor…). */
  status: Partial<Record<SidePanelKey, SidePanelStatus>>;
  setRowWidth: (width: number) => void;
  commitWidth: (width: number) => void;
  setTab: (tab: SidePanelKey) => void;
  setMaximized: (maximized: boolean) => void;
  setStatus: (tab: SidePanelKey, status: SidePanelStatus | null) => void;
}

/** The panel's width for the available space: never closes it (it is the
 *  only one), only shrinks it towards PANEL_FIT_MIN_WIDTH. */
function fit(preferred: number, space: number): number {
  if (!Number.isFinite(space)) return preferred;
  return fitSidePanels([{ key: 'panel', preferred }], space, false).widths.panel ?? preferred;
}

export const useSidePanelStore = create<SidePanelState>()((set, get) => {
  const preferred = loadPreferred();
  return {
    preferred,
    fitted: preferred,
    space: Infinity,
    tab: loadTab(),
    maximized: false,
    status: {},

    // The terminal + panel row resized (window, sidebar): shrink or grow the panel.
    setRowWidth: (width) => {
      const s = get();
      const space = width > 0 ? width - TERMINAL_MIN_WIDTH : Infinity;
      if (space === s.space) return;
      set({ space, fitted: fit(s.preferred, space) });
    },

    commitWidth: (width) => {
      const w = clampWidth(width);
      try {
        localStorage.setItem(WIDTH_KEY, String(w));
      } catch {
        /* not persisted this time; the width still applies */
      }
      set({ preferred: w, fitted: fit(w, get().space) });
    },

    setTab: (tab) => {
      if (get().tab === tab) return;
      try {
        localStorage.setItem(TAB_KEY, tab);
      } catch {
        /* remembered for this run only */
      }
      set({ tab });
    },

    setMaximized: (maximized) => set({ maximized }),

    setStatus: (tab, status) => {
      if ((get().status[tab] ?? null) === status) return;
      const next = { ...get().status };
      if (status) next[tab] = status;
      else delete next[tab];
      set({ status: next });
    },
  };
});

/**
 * What the side panel needs to render and resize itself: its fitted width,
 * drag limits (the max leaves the terminal its minimum), and the commit
 * callback that saves a dragged width.
 */
export function useSidePanelWidth() {
  const width = useSidePanelStore((s) => s.fitted);
  const max = useSidePanelStore((s) =>
    Math.max(s.fitted, Math.min(SIDE_PANEL.max, Number.isFinite(s.space) ? s.space : SIDE_PANEL.max)),
  );
  const commitWidth = useSidePanelStore((s) => s.commitWidth);
  const commit = useCallback((w: number) => commitWidth(w), [commitWidth]);
  return { width, min: SIDE_PANEL.min, max, commit };
}
