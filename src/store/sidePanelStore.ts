import { useCallback } from 'react';
import { create } from 'zustand';
import { fitSidePanels, TERMINAL_MIN_WIDTH } from '../utils/panelFit';

export type SidePanelKey = 'editor' | 'api' | 'ai';

/** Default width and drag limits for each docked side panel. */
export const SIDE_PANELS: Record<SidePanelKey, { label: string; width: number; min: number; max: number }> = {
  editor: { label: 'Config Editor', width: 520, min: 300, max: 900 },
  api: { label: 'API Explorer', width: 420, min: 200, max: 800 },
  ai: { label: 'AI Assistant', width: 420, min: 300, max: 800 },
};

const KEYS = Object.keys(SIDE_PANELS) as SidePanelKey[];
const storageKey = (key: SidePanelKey) => `atp-panel-width-${key}`;

const clampWidth = (key: SidePanelKey, w: number) =>
  Math.round(Math.max(SIDE_PANELS[key].min, Math.min(SIDE_PANELS[key].max, w)));

function loadPreferred(): Record<SidePanelKey, number> {
  const out = {} as Record<SidePanelKey, number>;
  for (const key of KEYS) {
    let w = SIDE_PANELS[key].width;
    try {
      const saved = Number(localStorage.getItem(storageKey(key)));
      if (Number.isFinite(saved) && saved > 0) w = saved;
    } catch {
      /* storage unavailable — use the default */
    }
    out[key] = clampWidth(key, w);
  }
  return out;
}

interface SidePanelState {
  /** Width the user last dragged each panel to (persisted per panel). */
  preferred: Record<SidePanelKey, number>;
  /** Width each panel renders at: its preferred width, shrunk to fit. */
  fitted: Record<SidePanelKey, number>;
  /** Showing panels, least recently opened first. */
  open: SidePanelKey[];
  /** The subset of `open` docked beside the terminal (same order). */
  docked: SidePanelKey[];
  /** Room for docked panels once the terminal has its minimum (Infinity until measured). */
  space: number;
  /** Last syncOpen input, so a repeated call (StrictMode, re-render) is a no-op. */
  lastSync: string;
  setRowWidth: (width: number) => void;
  syncOpen: (visible: SidePanelKey[], dockable: SidePanelKey[]) => SidePanelKey[];
  commitWidth: (key: SidePanelKey, width: number) => void;
}

/** Recompute fitted widths; panels not docked keep their preferred width for when they reopen. */
function refit(
  preferred: Record<SidePanelKey, number>,
  docked: SidePanelKey[],
  space: number,
  allowClose: boolean,
) {
  const fitted = { ...preferred };
  if (!Number.isFinite(space)) return { fitted, closed: [] as SidePanelKey[] };
  const { widths, closed } = fitSidePanels(
    docked.map((key) => ({ key, preferred: preferred[key] })),
    space,
    allowClose,
  );
  return { fitted: { ...fitted, ...widths }, closed };
}

export const useSidePanelStore = create<SidePanelState>()((set, get) => {
  const preferred = loadPreferred();
  return {
    preferred,
    fitted: { ...preferred },
    open: [],
    docked: [],
    space: Infinity,
    lastSync: '',

    // The terminal + panels row resized (window, sidebar): shrink or grow the
    // docked panels, but never close one for it.
    setRowWidth: (width) => {
      const s = get();
      const space = width > 0 ? width - TERMINAL_MIN_WIDTH : Infinity;
      if (space === s.space) return;
      set({ space, fitted: refit(s.preferred, s.docked, space, false).fitted });
    },

    /**
     * Panels opened or closed. `visible` = every showing panel; `dockable` =
     * those that would sit beside the terminal (the editor fills the whole
     * area instead when no session is open). Returns panels that had to close
     * to make room — the caller hides them and tells the user.
     */
    syncOpen: (visible, dockable) => {
      const s = get();
      const signature = `${visible.join(',')}|${dockable.join(',')}`;
      if (signature === s.lastSync) return [];
      const kept = s.open.filter((k) => visible.includes(k));
      const opened = visible.filter((k) => !s.open.includes(k));
      const order = [...kept, ...opened];
      const docked = order.filter((k) => dockable.includes(k));
      // Only the user opening a docked panel may close another one.
      const allowClose = opened.some((k) => dockable.includes(k));
      const { fitted, closed } = refit(s.preferred, docked, s.space, allowClose);
      set({
        open: order.filter((k) => !closed.includes(k)),
        docked: docked.filter((k) => !closed.includes(k)),
        fitted,
        lastSync: signature,
      });
      return closed;
    },

    commitWidth: (key, width) => {
      const s = get();
      const w = clampWidth(key, width);
      try {
        localStorage.setItem(storageKey(key), String(w));
      } catch {
        /* not persisted this time; the width still applies */
      }
      const preferred = { ...s.preferred, [key]: w };
      set({ preferred, fitted: refit(preferred, s.docked, s.space, false).fitted });
    },
  };
});

/**
 * What a side panel needs to render and resize itself: its fitted width,
 * drag limits (the max leaves the terminal its minimum), and the commit
 * callback that saves a dragged width.
 */
export function useSidePanelWidth(key: SidePanelKey) {
  const width = useSidePanelStore((s) => s.fitted[key]);
  const max = useSidePanelStore((s) => {
    const others = s.docked.filter((k) => k !== key).reduce((n, k) => n + s.fitted[k], 0);
    const room = Number.isFinite(s.space) ? s.space - others : SIDE_PANELS[key].max;
    return Math.max(s.fitted[key], Math.min(SIDE_PANELS[key].max, room));
  });
  const commitWidth = useSidePanelStore((s) => s.commitWidth);
  const commit = useCallback((w: number) => commitWidth(key, w), [commitWidth, key]);
  return { width, min: SIDE_PANELS[key].min, max, commit };
}
