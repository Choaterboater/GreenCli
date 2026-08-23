import { useState } from 'react';
import {
  Wrench,
  ChevronDown,
  Columns2,
  Waypoints,
  Target,
  HelpCircle,
  Radio,
  type LucideIcon,
} from 'lucide-react';
import { useSessionStore } from '../store/sessionStore';

interface WorkspaceMenuProps {
  splitView: boolean;
  onToggleSplit: () => void;
  broadcastMode: boolean;
  onToggleBroadcast: () => void;
}

interface MenuItem {
  key: string;
  icon: LucideIcon;
  label: string;
  title?: string;
  hint?: string;
  active: boolean;
  onClick: () => void;
}

// Title-bar dropdown replacing the icon-only workspace cluster (Split panes /
// SSH tunnels / Network intent / Help / Broadcast): labeled actions with
// shortcut hints; active states stay visible so toggles are not hidden.
export default function WorkspaceMenu({
  splitView,
  onToggleSplit,
  broadcastMode,
  onToggleBroadcast,
}: WorkspaceMenuProps) {
  const [open, setOpen] = useState(false);
  const { showTunnels, setShowTunnels, showIntent, setShowIntent, showHelp, setShowHelp } =
    useSessionStore();

  const items: MenuItem[] = [
    {
      key: 'split',
      icon: Columns2,
      label: 'Split view',
      title: 'Split into two synchronized panes',
      active: splitView,
      onClick: () => {
        onToggleSplit();
        setOpen(false);
      },
    },
    {
      key: 'tunnels',
      icon: Waypoints,
      label: 'SSH Tunnels',
      title: 'SSH tunnels / port forwarding',
      active: showTunnels,
      onClick: () => {
        setShowTunnels(true);
        setOpen(false);
      },
    },
    {
      key: 'intent',
      icon: Target,
      label: 'Network Intent',
      title: 'Network intent / desired-state assurance',
      active: showIntent,
      onClick: () => {
        setShowIntent(true);
        setOpen(false);
      },
    },
    {
      key: 'help',
      icon: HelpCircle,
      label: 'Help',
      title: 'Help & documentation',
      hint: 'F1',
      active: showHelp,
      onClick: () => {
        setShowHelp(true);
        setOpen(false);
      },
    },
    {
      key: 'broadcast',
      icon: Radio,
      label: 'Multi-send',
      title: 'Multi-send: run a command on multiple sessions',
      active: broadcastMode,
      onClick: () => {
        onToggleBroadcast();
        setOpen(false);
      },
    },
  ];

  return (
    <div className="relative">
      <button
        onClick={() => setOpen(!open)}
        className={`flex items-center gap-1.5 px-2 py-1 text-xs rounded transition-colors ${
          open
            ? 'text-[var(--accent)] bg-[var(--accent-soft)]'
            : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]'
        }`}
        title="Workspace tools"
      >
        <Wrench size={12} />
        <span>Tools</span>
        <ChevronDown size={10} />
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-20" onClick={() => setOpen(false)} />
          <div className="absolute top-full left-0 mt-1 z-30 w-56 bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg shadow-xl flex flex-col py-1">
            {items.map((item) => (
              <button
                key={item.key}
                onClick={item.onClick}
                title={item.title ?? item.label}
                className={`flex items-center gap-2.5 px-3 py-2 text-left transition-colors ${
                  item.active
                    ? 'text-[var(--accent)] bg-[var(--accent-soft)]'
                    : 'text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]'
                }`}
              >
                <item.icon
                  size={14}
                  className="flex-shrink-0"
                  style={{ color: item.active ? 'var(--accent)' : 'var(--text-secondary)' }}
                />
                <span className="flex-1 text-xs">{item.label}</span>
                {item.hint && (
                  <kbd className="px-1.5 py-0.5 rounded bg-[var(--bg-tertiary)] border border-[var(--border)] text-[var(--text-secondary)] font-mono text-[10px]">
                    {item.hint}
                  </kbd>
                )}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}