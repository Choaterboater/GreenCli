import { useLayoutEffect, type RefObject } from 'react';
import { useSessionStore } from '../store/sessionStore';
import { SIDE_PANELS, SidePanelKey, useSidePanelStore } from '../store/sidePanelStore';
import { notify } from '../store/toastStore';
import { TERMINAL_MIN_WIDTH } from '../utils/panelFit';

const CLOSE: Record<SidePanelKey, () => void> = {
  editor: () => useSessionStore.getState().setShowConfigEditor(false),
  api: () => useSessionStore.getState().setShowApiExplorer(false),
  ai: () => useSessionStore.getState().setShowAiAssistant(false),
};

/**
 * Keeps the docked side panels from squeezing the terminal: measures the
 * terminal + panels row (`rowRef`) and re-fits the panels whenever it resizes
 * or a panel opens/closes. Layout effects, so a newly opened panel is fitted
 * before the first paint instead of flashing at full width.
 */
export function useSidePanelFit(rowRef: RefObject<HTMLElement>) {
  const showConfigEditor = useSessionStore((s) => s.showConfigEditor);
  const showApiExplorer = useSessionStore((s) => s.showApiExplorer);
  const showAiAssistant = useSessionStore((s) => s.showAiAssistant);
  // With no session open the editor fills the main area (ConfigEditor's
  // fullWidth mode) rather than docking beside the terminal.
  const editorFills = useSessionStore((s) => s.sessions.length === 0);

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
    const visible: SidePanelKey[] = [];
    if (showConfigEditor) visible.push('editor');
    if (showApiExplorer) visible.push('api');
    if (showAiAssistant) visible.push('ai');
    const dockable = visible.filter((k) => k !== 'editor' || !editorFills);
    const closed = useSidePanelStore.getState().syncOpen(visible, dockable);
    for (const key of closed) {
      CLOSE[key]();
      notify.info(
        `Closed the ${SIDE_PANELS[key].label} to make room`,
        `The terminal needs at least ${TERMINAL_MIN_WIDTH}px, so not every panel fits beside it. Widen the window or hide the sidebar to keep more panels open.`,
      );
    }
  }, [showConfigEditor, showApiExplorer, showAiAssistant, editorFills]);
}
