import { useRef, type KeyboardEvent } from 'react';
import { Maximize2, Minimize2, X, Loader2 } from 'lucide-react';
import {
  SIDE_PANEL_TABS,
  SidePanelKey,
  useSidePanelStore,
  useSidePanelWidth,
} from '../store/sidePanelStore';
import { useEditorFills, useOpenSidePanel } from '../hooks/useSidePanelFit';
import { useResizablePanel } from '../hooks/useResizablePanel';
import { withShortcut } from '../utils/shortcuts';
import { SIDE_PANEL_ICONS, closeSidePanel, showSidePanel } from './sidePanelActions';
import ConfigEditor from './ConfigEditor';
import ApiExplorer from './ApiExplorer';
import AiAssistant from './AiAssistant';

/**
 * The one right-side panel: Editor, API and AI as tabs. Every tab's body stays
 * MOUNTED (hidden via CSS) so editor buffers, a half-built request and the
 * chat survive switching tabs or closing the panel. One width is shared by
 * all tabs (sidePanelStore) so switching never makes the terminal jump.
 */
export default function SidePanel() {
  const open = useOpenSidePanel();
  const fills = useEditorFills();
  const maximized = useSidePanelStore((s) => s.maximized);
  const status = useSidePanelStore((s) => s.status);
  const size = useSidePanelWidth();
  const { width, onDragStart, handleClass } = useResizablePanel(size.width, size.min, size.max, {
    onCommit: size.commit,
  });
  const tabRefs = useRef<Partial<Record<SidePanelKey, HTMLButtonElement | null>>>({});

  // Maximized, or the editor standing in for the empty terminal area: take
  // the whole row instead of a fixed width.
  const wide = maximized || fills;

  // Arrow keys move between tabs (WAI-ARIA tabs pattern, automatic activation).
  const onTabKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!open || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
    e.preventDefault();
    const keys = SIDE_PANEL_TABS.map((t) => t.key);
    const i = keys.indexOf(open);
    const next =
      e.key === 'Home'
        ? keys[0]
        : e.key === 'End'
          ? keys[keys.length - 1]
          : keys[(i + (e.key === 'ArrowRight' ? 1 : -1) + keys.length) % keys.length];
    showSidePanel(next);
    tabRefs.current[next]?.focus();
  };

  return (
    <aside
      aria-label="Side panel"
      className={`${open ? '' : 'hidden '}${
        wide ? 'flex-1 min-w-0' : 'flex-shrink-0 border-l border-[var(--border)]'
      } relative flex flex-col bg-[var(--bg-primary)] overflow-hidden`}
      style={wide ? undefined : { width }}
    >
      {!wide && (
        <div
          className={handleClass}
          onMouseDown={onDragStart}
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize the side panel"
        />
      )}

      {/* Tab strip — same height as the terminal tab strip it lines up with. */}
      <div className="flex items-center h-10 px-1.5 gap-1 border-b border-[var(--border)] bg-[var(--bg-secondary)] flex-shrink-0">
        <div role="tablist" aria-label="Side panel" className="flex items-center gap-0.5" onKeyDown={onTabKeyDown}>
          {SIDE_PANEL_TABS.map(({ key, label, title }) => {
            const { icon: Icon, color } = SIDE_PANEL_ICONS[key];
            const active = open === key;
            const tabStatus = status[key];
            return (
              <button
                key={key}
                ref={(el) => {
                  tabRefs.current[key] = el;
                }}
                id={`side-tab-${key}`}
                role="tab"
                aria-selected={active}
                aria-controls={`side-panel-${key}`}
                tabIndex={active ? 0 : -1}
                onClick={() => showSidePanel(key)}
                title={withShortcut(title, key)}
                className={`relative flex items-center gap-1.5 h-7 px-2.5 rounded-md text-xs transition-colors ${
                  active
                    ? 'bg-[var(--bg-primary)] text-[var(--text-primary)] font-medium'
                    : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]'
                }`}
                style={active ? { boxShadow: 'var(--elevation-1), inset 0 0 0 1px var(--border-strong)' } : undefined}
              >
                <Icon size={13} style={active ? { color } : undefined} className="flex-shrink-0" />
                <span>{label}</span>
                {tabStatus === 'busy' && (
                  <Loader2 size={11} className="animate-spin flex-shrink-0" style={{ color }} aria-label="Working" />
                )}
                {tabStatus === 'dirty' && (
                  <span
                    className="w-1.5 h-1.5 rounded-full flex-shrink-0 bg-[var(--accent-warning)]"
                    title="Unsaved changes"
                    aria-label="Unsaved changes"
                  />
                )}
              </button>
            );
          })}
        </div>
        <span className="flex-1" />
        <button
          onClick={() => useSidePanelStore.getState().setMaximized(!maximized)}
          className="p-1.5 rounded-md text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] transition-colors"
          title={maximized ? 'Restore the panel beside the terminal' : 'Maximize the panel'}
          aria-label={maximized ? 'Restore side panel' : 'Maximize side panel'}
          aria-pressed={maximized}
        >
          {maximized ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
        </button>
        <button
          onClick={closeSidePanel}
          className="p-1.5 rounded-md text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] transition-colors"
          title={open ? withShortcut('Close the panel', open) : 'Close the panel'}
          aria-label="Close side panel"
        >
          <X size={14} />
        </button>
      </div>

      <div className="relative flex-1 min-h-0">
        <ConfigEditor />
        <ApiExplorer />
        <AiAssistant />
      </div>
    </aside>
  );
}
