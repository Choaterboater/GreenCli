// Side-panel actions shared by the panel itself, the activity bar, the
// command palette and the app shortcuts. Kept apart from SidePanel.tsx so
// those callers don't pull in the editor, API explorer and AI panel.
import { FileCode, Globe, Sparkles, type LucideIcon } from 'lucide-react';
import { useSessionStore } from '../store/sessionStore';
import { useSidePanelStore, type SidePanelKey } from '../store/sidePanelStore';

export const SIDE_PANEL_ICONS: Record<SidePanelKey, { icon: LucideIcon; color: string }> = {
  editor: { icon: FileCode, color: 'var(--accent-2)' },
  api: { icon: Globe, color: 'var(--accent-info)' },
  ai: { icon: Sparkles, color: 'var(--vendor-mist)' },
};

/** Show a side-panel tab (switching the panel to it). */
export function showSidePanel(tab: SidePanelKey) {
  const st = useSessionStore.getState();
  if (tab === 'editor') st.setShowConfigEditor(true);
  else if (tab === 'api') st.setShowApiExplorer(true);
  else st.setShowAiAssistant(true);
}

/** Close the side panel, whichever tab is showing. */
export function closeSidePanel() {
  const st = useSessionStore.getState();
  st.setShowConfigEditor(false);
  st.setShowApiExplorer(false);
  st.setShowAiAssistant(false);
}

/**
 * Sessions sidebar toggle (activity bar, Ctrl/⌘+B, palette). From a maximized
 * side panel it brings the sidebar — and the terminal — back instead of
 * toggling a sidebar that is hidden anyway.
 */
export function toggleSessionsSidebar() {
  const panel = useSidePanelStore.getState();
  if (panel.maximized) {
    panel.setMaximized(false);
    useSessionStore.getState().setSidebarVisible(true);
  } else {
    useSessionStore.getState().toggleSidebar();
  }
}
