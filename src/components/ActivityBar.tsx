import { useEffect, useRef, useState, type ReactNode } from 'react';
import { invoke } from '@tauri-apps/api/tauri';
import {
  Server,
  Layers,
  GitPullRequestArrow,
  History,
  Target,
  Waypoints,
  HardDrive,
  Import,
  HelpCircle,
  Settings,
  type LucideIcon,
} from 'lucide-react';
import { useSessionStore } from '../store/sessionStore';
import { SIDE_PANEL_TABS, useSidePanelStore, type SidePanelKey } from '../store/sidePanelStore';
import { useOpenSidePanel } from '../hooks/useSidePanelFit';
import { shortcutLabel, type ShortcutId } from '../utils/shortcuts';
import type { Intent } from '../utils/intent';
import { SIDE_PANEL_ICONS, toggleSessionsSidebar } from './sidePanelActions';

// VS Code-style activity bar: the app's places (Sessions sidebar, the Editor /
// API / AI side-panel tabs) and its tools, each one labelled in a tooltip with
// its OS-correct shortcut. It replaced the title bar's Tools menu and its row
// of unlabelled icon buttons.

type Badge = { kind: 'count'; value: number; tone: 'danger' } | { kind: 'dot'; tone: 'busy' | 'dirty' | 'danger' };

interface Item {
  key: string;
  icon: LucideIcon;
  label: string;
  /** Extra line in the tooltip (what the badge means, why it's disabled…). */
  detail?: string;
  shortcut?: ShortcutId;
  active?: boolean;
  /** A show/hide toggle (announced as pressed / not pressed). */
  toggle?: boolean;
  /** Tint for the icon while active (a side-panel tab's own colour). */
  activeColor?: string;
  disabled?: boolean;
  badge?: Badge | null;
  onClick: () => void;
}

/** Intents whose last evaluation (manual or scheduled) found a violation. */
function useIntentViolations(): number {
  const showIntent = useSessionStore((s) => s.showIntent);
  const [count, setCount] = useState(0);
  useEffect(() => {
    // Re-read when the Intent panel closes (it may have just evaluated) and
    // once a minute (the background schedule persists its results too).
    if (showIntent) return;
    let cancelled = false;
    const load = () =>
      invoke<Intent[]>('intent_list')
        .then((list) => {
          if (!cancelled) setCount((list ?? []).filter((i) => i.lastResult?.status === 'violation').length);
        })
        .catch(() => {});
    load();
    const t = setInterval(load, 60_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [showIntent]);
  return count;
}

function BadgeMark({ badge }: { badge: Badge }) {
  if (badge.kind === 'count') {
    return (
      <span
        className="absolute -top-0.5 -right-0.5 min-w-[15px] h-[15px] px-1 rounded-full text-[9px] font-semibold leading-[15px] text-center tabular-nums"
        style={{
          background: 'var(--danger-solid)',
          color: 'var(--danger-solid-fg)',
          boxShadow: '0 0 0 2px var(--bg-secondary)',
        }}
      >
        {badge.value > 99 ? '99+' : badge.value}
      </span>
    );
  }
  const color =
    badge.tone === 'dirty' ? 'var(--accent-warning)' : badge.tone === 'danger' ? 'var(--accent-danger)' : 'var(--accent)';
  return (
    <span
      className={`absolute top-1 right-1 w-2 h-2 rounded-full ${badge.tone === 'busy' ? 'animate-pulse' : ''}`}
      style={{ background: color, boxShadow: '0 0 0 2px var(--bg-secondary)' }}
    />
  );
}

export default function ActivityBar() {
  const sidebarVisible = useSessionStore((s) => s.sidebarVisible);
  const droppedCount = useSessionStore(
    (s) => s.sessions.filter((x) => !x.connected && (x.connectionStatus ?? 'disconnected') === 'disconnected').length,
  );
  const hasActiveSession = useSessionStore((s) => s.activeSessionId != null);
  const showBulkRunner = useSessionStore((s) => s.showBulkRunner);
  const showChangeJobs = useSessionStore((s) => s.showChangeJobs);
  const showArchive = useSessionStore((s) => s.showArchive);
  const showIntent = useSessionStore((s) => s.showIntent);
  const showTunnels = useSessionStore((s) => s.showTunnels);
  const showSftp = useSessionStore((s) => s.showSftp);
  const showImportHosts = useSessionStore((s) => s.showImportHosts);
  const showHelp = useSessionStore((s) => s.showHelp);
  const showSettings = useSessionStore((s) => s.showSettings);
  const openPanel = useOpenSidePanel();
  const panelStatus = useSidePanelStore((s) => s.status);
  const panelMaximized = useSidePanelStore((s) => s.maximized);
  // A maximized side panel hides the sidebar, whatever its own setting.
  const sessionsShown = sidebarVisible && !panelMaximized;
  const violations = useIntentViolations();

  // One tooltip, positioned from the hovered button. `fixed` so the scrolling
  // tools group can't clip it. Hover waits a moment (sweeping the pointer
  // across the bar shouldn't flash every label) unless one is already up;
  // keyboard focus shows it at once.
  const [tip, setTip] = useState<{ key: string; top: number } | null>(null);
  const tipTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // When a tooltip last closed: moving straight on to the next icon is "warm".
  const tipHiddenAt = useRef(0);
  const clearTipTimer = () => {
    if (tipTimer.current) clearTimeout(tipTimer.current);
    tipTimer.current = null;
  };
  useEffect(() => clearTipTimer, []);
  const tipShown = useRef(false);
  useEffect(() => {
    if (tip) tipShown.current = true;
    else if (tipShown.current) {
      tipShown.current = false;
      tipHiddenAt.current = Date.now();
    }
  }, [tip]);

  const st = () => useSessionStore.getState();

  const panelItem = (key: SidePanelKey): Item => {
    const tab = SIDE_PANEL_TABS.find((t) => t.key === key)!;
    const status = panelStatus[key];
    return {
      key,
      icon: SIDE_PANEL_ICONS[key].icon,
      label: tab.title,
      detail:
        status === 'busy'
          ? key === 'ai'
            ? 'Working on an answer…'
            : 'Request in progress…'
          : status === 'dirty'
            ? 'Unsaved changes'
            : undefined,
      shortcut: key,
      active: openPanel === key,
      toggle: true,
      activeColor: SIDE_PANEL_ICONS[key].color,
      badge: status ? { kind: 'dot', tone: status } : null,
      onClick: () => {
        const s = st();
        if (key === 'editor') s.toggleConfigEditor();
        else if (key === 'api') s.toggleApiExplorer();
        else s.toggleAiAssistant();
      },
    };
  };

  const places: Item[] = [
    {
      key: 'sessions',
      icon: Server,
      label: 'Sessions',
      detail: droppedCount
        ? `${droppedCount} tab${droppedCount === 1 ? '' : 's'} disconnected`
        : sessionsShown
          ? 'Hide the sessions sidebar'
          : 'Show the sessions sidebar',
      shortcut: 'sidebar',
      active: sessionsShown,
      toggle: true,
      badge: droppedCount ? { kind: 'count', value: droppedCount, tone: 'danger' } : null,
      onClick: toggleSessionsSidebar,
    },
    panelItem('editor'),
    panelItem('api'),
    panelItem('ai'),
  ];

  const tools: Item[] = [
    {
      key: 'bulk',
      icon: Layers,
      label: 'Bulk Runner',
      detail: 'Run a command on many sessions and collect the output',
      active: showBulkRunner,
      onClick: () => st().setShowBulkRunner(true),
    },
    {
      key: 'change-jobs',
      icon: GitPullRequestArrow,
      label: 'Change Jobs',
      detail: 'Push a config change to many devices: dry run, canary first',
      active: showChangeJobs,
      onClick: () => st().setShowChangeJobs(true),
    },
    {
      key: 'archive',
      icon: History,
      label: 'Config Archive',
      detail: 'Config history per device, and diffs against a golden config',
      active: openPanel === 'editor' && showArchive,
      onClick: () => {
        st().setShowConfigEditor(true);
        st().setShowArchive(true);
      },
    },
    {
      key: 'intent',
      icon: Target,
      label: 'Network Intent',
      detail: violations
        ? `${violations} intent${violations === 1 ? '' : 's'} not met at the last check`
        : 'Check devices against the state you expect',
      active: showIntent,
      badge: violations ? { kind: 'count', value: violations, tone: 'danger' } : null,
      onClick: () => st().setShowIntent(true),
    },
    {
      key: 'tunnels',
      icon: Waypoints,
      label: 'SSH Tunnels',
      detail: 'Port forwarding through a connected session',
      active: showTunnels,
      onClick: () => st().setShowTunnels(true),
    },
    {
      key: 'sftp',
      icon: HardDrive,
      label: 'SFTP',
      detail: hasActiveSession ? 'Transfer files with the active session' : 'Open a session first',
      active: showSftp,
      disabled: !hasActiveSession,
      onClick: () => st().setShowSftp(true),
    },
    {
      key: 'import',
      icon: Import,
      label: 'Import Hosts',
      detail: 'From CSV, SecureCRT, SSH config, Aruba Central or Mist',
      active: showImportHosts,
      onClick: () => st().openImportHosts(),
    },
  ];

  const footer: Item[] = [
    {
      key: 'help',
      icon: HelpCircle,
      label: 'Help',
      shortcut: 'help',
      active: showHelp,
      onClick: () => st().setShowHelp(!st().showHelp),
    },
    {
      key: 'settings',
      icon: Settings,
      label: 'Settings',
      shortcut: 'settings',
      active: showSettings,
      onClick: () => st().setShowSettings(true),
    },
  ];

  const renderItem = (item: Item): ReactNode => {
    const showTip = (el: HTMLElement, delay: number) => {
      clearTipTimer();
      const r = el.getBoundingClientRect();
      const next = { key: item.key, top: r.top + r.height / 2 };
      if (delay === 0) setTip(next);
      else tipTimer.current = setTimeout(() => setTip(next), delay);
    };
    const hideTip = () => {
      clearTipTimer();
      setTip(null);
    };
    const Icon = item.icon;
    return (
      <button
        key={item.key}
        type="button"
        onClick={() => {
          hideTip();
          item.onClick();
        }}
        disabled={item.disabled}
        aria-label={item.label}
        aria-pressed={item.toggle ? !!item.active : undefined}
        aria-describedby={tip?.key === item.key ? 'activity-tip' : undefined}
        onMouseEnter={(e) => showTip(e.currentTarget, Date.now() - tipHiddenAt.current < 300 ? 0 : 450)}
        onMouseLeave={hideTip}
        onFocus={(e) => showTip(e.currentTarget, 0)}
        onBlur={hideTip}
        className={`relative flex items-center justify-center w-9 h-9 rounded-md transition-colors flex-shrink-0 disabled:opacity-40 disabled:cursor-default ${
          item.active
            ? 'text-[var(--text-primary)] bg-[var(--bg-tertiary)]'
            : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] disabled:hover:bg-transparent disabled:hover:text-[var(--text-secondary)]'
        }`}
      >
        {/* Active marker on the window edge, like VS Code's. */}
        {item.active && (
          <span
            className="absolute -left-1 top-2 bottom-2 w-[2px] rounded-full"
            style={{ background: item.activeColor ?? 'var(--accent)' }}
          />
        )}
        <Icon size={18} strokeWidth={1.75} style={item.active && item.activeColor ? { color: item.activeColor } : undefined} />
        {item.badge && <BadgeMark badge={item.badge} />}
      </button>
    );
  };

  // Read at render, so a badge that changes under the pointer updates the text.
  const tipItem = tip ? [...places, ...tools, ...footer].find((i) => i.key === tip.key) : undefined;
  const tipShortcut = tipItem?.shortcut ? shortcutLabel(tipItem.shortcut) : '';

  return (
    <nav
      aria-label="Activity bar"
      className="w-11 flex-shrink-0 flex flex-col items-center py-1.5 gap-1 bg-[var(--bg-secondary)] border-r border-[var(--border)] select-none"
    >
      {places.map(renderItem)}
      <div className="w-6 h-px my-1 bg-[var(--border)] flex-shrink-0" role="separator" />
      <div className="flex-1 min-h-0 w-full flex flex-col items-center gap-1 overflow-y-auto scrollbar-none" aria-label="Tools">
        {tools.map(renderItem)}
      </div>
      <div className="w-6 h-px my-1 bg-[var(--border)] flex-shrink-0" role="separator" />
      {footer.map(renderItem)}

      {tip && tipItem && (
        <div
          id="activity-tip"
          role="tooltip"
          className="fixed z-[70] pointer-events-none -translate-y-1/2 animate-fade-in"
          style={{ left: 50, top: tip.top }}
        >
          <div className="flex flex-col gap-0.5 max-w-[260px] px-2.5 py-1.5 rounded-md border border-[var(--border-strong)] bg-[var(--bg-elevated)] shadow-elevation-2">
            <div className="flex items-center gap-2 whitespace-nowrap">
              <span className="text-xs font-medium text-[var(--text-primary)]">{tipItem.label}</span>
              {tipShortcut && (
                <kbd className="px-1 rounded border border-[var(--border)] bg-[var(--bg-tertiary)] font-mono text-[10px] text-[var(--text-secondary)]">
                  {tipShortcut}
                </kbd>
              )}
            </div>
            {tipItem.detail && (
              <span className="text-[11px] leading-snug text-[var(--text-muted)]">{tipItem.detail}</span>
            )}
          </div>
        </div>
      )}
    </nav>
  );
}
