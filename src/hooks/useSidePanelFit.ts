import { useLayoutEffect, type RefObject } from 'react';
import { useSessionStore } from '../store/sessionStore';
import { SidePanelKey, useSidePanelStore } from '../store/sidePanelStore';

/** The side-panel tab showing right now, or null while the panel is closed. */
export function useOpenSidePanel(): SidePanelKey | null {
  return useSessionStore((s) =>
    s.showConfigEditor ? 'editor' : s.showApiExplorer ? 'api' : s.showAiAssistant ? 'ai' : null,
  );
}

/**
 * With no session open, the Editor tab fills the whole work area (a plain
 * text editor) instead of docking beside the empty-state screen.
 */
export function useEditorFills(): boolean {
  const open = useOpenSidePanel();
  const noSessions = useSessionStore((s) => s.sessions.length === 0);
  return open === 'editor' && noSessions;
}

/**
 * Keeps the side panel from squeezing the terminal: measures the terminal +
 * panel row (`rowRef`) and re-fits the panel whenever it resizes. A layout
 * effect, so an opened panel is fitted before the first paint instead of
 * flashing at full width. Also remembers the tab last shown, and drops
 * maximize when the panel closes (so it doesn't reopen covering the terminal).
 */
export function useSidePanelFit(rowRef: RefObject<HTMLElement>) {
  const open = useOpenSidePanel();

  useLayoutEffect(() => {
    const el = rowRef.current;
    if (!el) return;
    const measure = () => useSidePanelStore.getState().setRowWidth(el.clientWidth);
    measure();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure);
      return () => window.removeEventListener('resize', measure);
    }
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [rowRef]);

  useLayoutEffect(() => {
    const st = useSidePanelStore.getState();
    if (open) st.setTab(open);
    else if (st.maximized) st.setMaximized(false);
  }, [open]);
}
