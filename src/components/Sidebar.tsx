import { useMemo, useState } from 'react';
import {
  ChevronRight,
  ChevronDown,
  Folder,
  FolderOpen,
  Monitor,
  Server,
  Wifi,
  RadioTower,
  Cloud,
  Network,
  Plus,
  Trash2,
  Play,
  Edit3,
  Search,
  PanelLeftClose,
  FolderPlus,
  Tag,
  Bot,
  Check,
  Settings2,
  Pencil,
  Download,
  CopyPlus,
  KeyRound,
} from 'lucide-react';
import { invoke } from '@tauri-apps/api/tauri';
import { useSessionStore } from '../store/sessionStore';
import { useSettingsStore } from '../store/settingsStore';
import { useResizablePanel } from '../hooks/useResizablePanel';
import { ConnectionConfig, LoginProfile, deviceMeta, vendorColor } from '../types';
import { fuzzyMatch } from '../utils';
import { askPrompt, askConfirm } from '../store/dialogStore';
import { notify } from '../store/toastStore';
import { hostSummary } from '../utils/hosts';
import { savedHostId } from '../utils/tabs';
import { isMac } from '../utils/shortcuts';
import { effectiveLogin } from '../utils/logins';

// "⇧-double-click" on macOS, "Shift+double-click" elsewhere.
const shiftDoubleClick = isMac ? '⇧-double-click' : 'Shift+double-click';
const NO_LOGINS: LoginProfile[] = [];

const LUCIDE: Record<string, typeof Monitor> = {
  Network,
  Wifi,
  RadioTower,
  Server,
  Cloud,
  Monitor,
};

function DeviceIcon({ deviceType, size = 15 }: { deviceType: string; size?: number }) {
  const Ico = LUCIDE[deviceMeta(deviceType).icon] ?? Monitor;
  return <Ico size={size} style={{ color: vendorColor(deviceType) }} className="flex-shrink-0" />;
}

interface SidebarProps {
  /** Open a saved host: focuses its tab if it has one, unless `newTab`. */
  onConnect: (config: ConnectionConfig, opts?: { newTab?: boolean }) => void;
}

export default function Sidebar({ onConnect }: SidebarProps) {
  // Narrow per-field selectors — a whole-store subscription re-rendered the
  // sidebar on every unrelated session/UI state change.
  const folders = useSessionStore((s) => s.folders);
  const sidebarVisible = useSessionStore((s) => s.sidebarVisible);
  const sessions = useSessionStore((s) => s.sessions);
  const toggleSidebar = useSessionStore((s) => s.toggleSidebar);
  const updateFolder = useSessionStore((s) => s.updateFolder);
  const addFolder = useSessionStore((s) => s.addFolder);
  const removeFolder = useSessionStore((s) => s.removeFolder);
  const removeSessionFromFolder = useSessionStore((s) => s.removeSessionFromFolder);
  const moveSessionToFolder = useSessionStore((s) => s.moveSessionToFolder);
  const updateSavedHost = useSessionStore((s) => s.updateSavedHost);
  const openQuickConnect = useSessionStore((s) => s.openQuickConnect);
  const openImportHosts = useSessionStore((s) => s.openImportHosts);
  const aiAgents = useSettingsStore((s) => s.aiAgents) ?? [];
  const sessionAgents = useSettingsStore((s) => s.sessionAgents) ?? {};
  const setSessionAgent = useSettingsStore((s) => s.setSessionAgent);
  const loginProfiles = useSettingsStore((s) => s.loginProfiles) ?? NO_LOGINS;
  const sidebarWidth = useSettingsStore((s) => s.sidebarWidth) ?? 256;
  const setSidebarWidth = useSettingsStore((s) => s.setSidebarWidth);
  const {
    width: panelWidth,
    onDragStart: handleResizeStart,
    handleClass: resizeHandleClass,
  } = useResizablePanel(sidebarWidth, 170, 560, {
    edge: 'right',
    onCommit: setSidebarWidth,
  });
  const agentFor = (sessionId: string) => aiAgents.find((a) => a.id === sessionAgents[sessionId]);

  const [query, setQuery] = useState('');
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    sessionId: string;
    folderId: string;
  } | null>(null);
  // Agent picker popover (opened from the context menu's "Agent…" item).
  const [agentMenu, setAgentMenu] = useState<{ x: number; y: number; sessionId: string } | null>(null);
  // Folder right-click menu, and its "Default login…" picker.
  const [folderMenu, setFolderMenu] = useState<{ x: number; y: number; folderId: string } | null>(null);
  const [loginMenu, setLoginMenu] = useState<{ x: number; y: number; folderId: string } | null>(null);
  // Folder currently hovered while dragging a session (for the drop highlight).
  const [dragOverFolder, setDragOverFolder] = useState<string | null>(null);

  // Move a saved session into another folder (drag-and-drop) + persist.
  const handleMoveSession = (sessionId: string, fromFolderId: string, toFolderId: string) => {
    if (fromFolderId === toFolderId) return;
    moveSessionToFolder(sessionId, fromFolderId, toFolderId);
    invoke('move_session', { id: sessionId, folderId: toFolderId }).catch(() => {});
  };

  // Live connection state per saved host: how many of its tabs are connected
  // (a host can have several sessions open; tabs point back via savedId).
  const connectedCount = useMemo(() => {
    const counts = new Map<string, number>();
    for (const s of sessions) {
      if (!s.connected) continue;
      const id = savedHostId(s.config);
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    return counts;
  }, [sessions]);

  const q = query.trim();
  // Fuzzy match across name / host / user / tags (cencli-style, ignores -_ and case).
  const matches = (s: ConnectionConfig) =>
    !q ||
    fuzzyMatch(q, `${s.name} ${s.host ?? ''} ${s.username ?? ''} ${s.serialPort ?? ''} ${(s.tags ?? []).join(' ')}`);
  const savedCount = folders.reduce((n, f) => n + f.items.length, 0);
  // What Enter in the search box connects to: the first host shown.
  const topMatch = q ? folders.flatMap((f) => f.items).find(matches) : undefined;

  const handleSearchKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && topMatch) {
      e.preventDefault();
      onConnect(topMatch, { newTab: e.shiftKey });
    } else if (e.key === 'Escape' && query) {
      // Clear the filter first; a second Esc goes on to the app as usual.
      e.preventDefault();
      e.stopPropagation();
      setQuery('');
    }
  };

  // ── Folder actions (persisted to backend) ──
  const handleAddFolder = async () => {
    const name = await askPrompt({ title: 'New folder', placeholder: 'Folder name', defaultValue: 'New Folder' });
    if (!name) return;
    try {
      const id = await invoke<string>('create_folder', { name });
      addFolder({ id, name, items: [], expanded: true });
    } catch {
      addFolder({ id: `folder-${Date.now()}`, name, items: [], expanded: true });
    }
  };

  const toggleExpand = (folderId: string, expanded: boolean) => {
    updateFolder(folderId, { expanded });
    invoke('update_folder', { id: folderId, expanded }).catch(() => {});
  };

  const renameFolder = async (folderId: string, current: string) => {
    const name = await askPrompt({ title: 'Rename folder', defaultValue: current });
    if (!name) return;
    updateFolder(folderId, { name });
    invoke('update_folder', { id: folderId, name }).catch(() => {});
  };

  const deleteFolder = async (folderId: string, name: string, count: number) => {
    const ok = await askConfirm({
      title: `Delete "${name}"?`,
      message: count > 0 ? `This removes ${count} saved session${count > 1 ? 's' : ''}.` : undefined,
      danger: true,
    });
    if (!ok) return;
    removeFolder(folderId);
    invoke('delete_folder', { id: folderId }).catch(() => {});
    notify.success('Folder deleted', name);
  };

  // The shared login every host in the folder uses unless it picks its own.
  const setFolderLogin = (folderId: string, loginProfileId: string | undefined) => {
    setLoginMenu(null);
    updateFolder(folderId, { loginProfileId });
    invoke('update_folder', { id: folderId, loginProfileId: loginProfileId ?? '' }).catch((e) =>
      notify.warning('Could not save the folder\u2019s default login', String(e))
    );
  };

  const openManageLogins = () => {
    setLoginMenu(null);
    const s = useSessionStore.getState();
    s.setSettingsFocus('logins');
    s.setShowSettings(true);
  };

  // ── Session actions ──
  const ctxItem = () => {
    if (!contextMenu) return undefined;
    return folders
      .find((f) => f.id === contextMenu.folderId)
      ?.items.find((s) => s.id === contextMenu.sessionId);
  };

  const handleCtxConnect = () => {
    const item = ctxItem();
    setContextMenu(null);
    if (item) onConnect(item);
  };

  // A second (third…) shell to the same device, in its own tab.
  const handleCtxOpenNew = () => {
    const item = ctxItem();
    setContextMenu(null);
    if (item) onConnect(item, { newTab: true });
  };

  // Change address / user / port / jump host etc. in place — Quick Connect
  // saves it back under the same id instead of connecting.
  const handleCtxEditHost = () => {
    const item = ctxItem();
    const ctx = contextMenu;
    setContextMenu(null);
    if (!item || !ctx) return;
    openQuickConnect({ editing: { config: item, folderId: ctx.folderId } });
  };

  const handleCtxRename = async () => {
    const item = ctxItem();
    const ctx = contextMenu;
    setContextMenu(null);
    if (!item || !ctx) return;
    const name = await askPrompt({ title: 'Rename session', defaultValue: item.name });
    if (!name) return;
    // The sidebar item and its open tabs (a tab's own Rename still wins).
    updateSavedHost(item.id, { name });
    invoke('rename_session', { id: item.id, name }).catch(() => {});
  };

  const handleCtxTags = async () => {
    const item = ctxItem();
    const ctx = contextMenu;
    setContextMenu(null);
    if (!item || !ctx) return;
    const entered = await askPrompt({
      title: 'Tags',
      message: 'Comma-separated labels for filtering (e.g. core, site-a, prod).',
      defaultValue: (item.tags ?? []).join(', '),
      placeholder: 'core, site-a',
    });
    if (entered === null) return;
    const tags = entered
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);
    const folder = folders.find((f) => f.id === ctx.folderId);
    if (folder) {
      updateFolder(folder.id, {
        items: folder.items.map((s) => (s.id === item.id ? { ...s, tags } : s)),
      });
    }
    invoke('set_session_tags', { id: item.id, tags }).catch(() => {});
  };

  const handleCtxAgent = () => {
    const ctx = contextMenu;
    if (!ctx) return;
    setContextMenu(null);
    // Open the agent picker anchored near the context-menu position.
    setAgentMenu({ x: ctx.x, y: ctx.y, sessionId: ctx.sessionId });
  };

  const openManageAgents = () => {
    setAgentMenu(null);
    const s = useSessionStore.getState();
    s.setSettingsFocus('agents');
    s.setShowSettings(true);
  };

  const handleCtxDelete = async () => {
    const item = ctxItem();
    const ctx = contextMenu;
    setContextMenu(null);
    if (!item || !ctx) return;
    const ok = await askConfirm({ title: `Delete "${item.name}"?`, danger: true });
    if (!ok) return;
    removeSessionFromFolder(ctx.folderId, ctx.sessionId);
    invoke('delete_session', { id: ctx.sessionId }).catch(() => {});
    notify.success('Session deleted', item.name);
  };

  if (!sidebarVisible) {
    return (
      <button
        onClick={toggleSidebar}
        className="fixed left-0 top-[48px] z-10 p-1.5 bg-[var(--bg-secondary)] border border-[var(--border)] rounded-r-md hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors"
        title="Show sidebar (Ctrl+B)"
      >
        <PanelLeftClose size={16} />
      </button>
    );
  }

  const handleContextMenu = (e: React.MouseEvent, sessionId: string, folderId: string) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY, sessionId, folderId });
  };

  return (
    <div
      className="relative flex-shrink-0 flex flex-col bg-[var(--bg-secondary)] border-r border-[var(--border)] overflow-hidden"
      style={{ width: panelWidth }}
    >
      {/* Drag handle — right edge */}
      <div className={resizeHandleClass} onMouseDown={handleResizeStart} />
      {/* Header */}
      <div className="flex items-center justify-between h-10 px-3 border-b border-[var(--border)]">
        <span className="text-[11px] font-semibold text-[var(--text-secondary)] uppercase tracking-wider">
          Sessions
        </span>
        <div className="flex items-center gap-0.5">
          <button
            onClick={() => openImportHosts()}
            className="p-1.5 rounded-md hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors"
            title="Import hosts… (CSV, SecureCRT, Aruba Central, Juniper Mist, ~/.ssh/config)"
          >
            <Download size={15} />
          </button>
          <button
            onClick={handleAddFolder}
            className="p-1.5 rounded-md hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors"
            title="New folder"
          >
            <FolderPlus size={15} />
          </button>
          <button
            onClick={toggleSidebar}
            className="p-1.5 rounded-md hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors"
            title="Hide sidebar (Ctrl+B)"
          >
            <PanelLeftClose size={15} />
          </button>
        </div>
      </div>

      {/* Search */}
      <div className="px-2.5 py-2 border-b border-[var(--border)]">
        <div className="relative">
          <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--text-muted)]" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleSearchKey}
            placeholder="Search hosts…"
            title={`Enter connects to the top match · ${isMac ? '⇧↩' : 'Shift+Enter'} opens another session · Esc clears`}
            className="input-field w-full h-8 pl-8 pr-2 text-[12px]"
          />
        </div>
      </div>

      {/* Folders */}
      <div className="flex-1 overflow-y-auto py-1.5">
        {folders.map((folder) => {
          const visibleItems = folder.items.filter(matches);
          if (q && visibleItems.length === 0) return null;
          const expanded = folder.expanded || !!q;
          return (
            <div
              key={folder.id}
              className={`px-1.5 rounded-md transition-colors ${
                dragOverFolder === folder.id ? 'bg-[var(--accent-soft)] ring-1 ring-[var(--accent)]' : ''
              }`}
              onDragOver={(e) => {
                // Only react to a session drag.
                if (!e.dataTransfer.types.includes('application/x-session')) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                if (dragOverFolder !== folder.id) setDragOverFolder(folder.id);
              }}
              onDrop={(e) => {
                const raw = e.dataTransfer.getData('application/x-session');
                setDragOverFolder(null);
                if (!raw) return;
                e.preventDefault();
                try {
                  const { sessionId, fromFolderId } = JSON.parse(raw);
                  handleMoveSession(sessionId, fromFolderId, folder.id);
                } catch {
                  /* ignore malformed drag payload */
                }
              }}
            >
              {/* Folder header */}
              <div
                className="group/folder flex items-center gap-1.5 w-full px-1.5 py-1.5 rounded-md text-left hover:bg-[var(--bg-tertiary)] transition-colors cursor-pointer"
                // While searching, folders are force-expanded for the results —
                // toggling then would invisibly persist a collapse with zero
                // visual feedback, so make the header inert until the query clears.
                onClick={() => { if (!q) toggleExpand(folder.id, !expanded); }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setFolderMenu({ x: e.clientX, y: e.clientY, folderId: folder.id });
                }}
              >
                {expanded ? (
                  <ChevronDown size={14} className="text-[var(--text-muted)] flex-shrink-0" />
                ) : (
                  <ChevronRight size={14} className="text-[var(--text-muted)] flex-shrink-0" />
                )}
                {expanded ? (
                  <FolderOpen size={15} className="text-[var(--accent-2)] flex-shrink-0" />
                ) : (
                  <Folder size={15} className="text-[var(--text-secondary)] flex-shrink-0" />
                )}
                <span className="flex-1 text-[13px] font-medium text-[var(--text-primary)] truncate">
                  {folder.name}
                </span>
                {(() => {
                  const folderLogin = loginProfiles.find((p) => p.id === folder.loginProfileId);
                  return folderLogin ? (
                    <span title={`Default login: ${folderLogin.name}`} className="flex-shrink-0">
                      <KeyRound size={11} className="text-[var(--text-muted)]" />
                    </span>
                  ) : null;
                })()}
                <span className="text-[11px] text-[var(--text-muted)] tabular-nums group-hover/folder:hidden">
                  {folder.items.length}
                </span>
                <div className="hidden group-hover/folder:flex items-center gap-0.5">
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      renameFolder(folder.id, folder.name);
                    }}
                    className="p-0.5 rounded hover:bg-[var(--border-strong)] text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                    title="Rename folder"
                  >
                    <Edit3 size={12} />
                  </button>
                  {folder.id !== 'default' && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        deleteFolder(folder.id, folder.name, folder.items.length);
                      }}
                      className="p-0.5 rounded hover:bg-[var(--border-strong)] text-[var(--text-muted)] hover:text-[var(--accent-danger)]"
                      title="Delete folder"
                    >
                      <Trash2 size={12} />
                    </button>
                  )}
                </div>
              </div>

              {/* Items */}
              {expanded && (
                <div className="ml-3.5 border-l border-[var(--border)] pl-1.5">
                  {visibleItems.length === 0 && savedCount > 0 && (
                    <div className="px-2 py-1.5 text-[11px] text-[var(--text-muted)]">No sessions</div>
                  )}
                  {visibleItems.map((session) => {
                    const liveTabs = connectedCount.get(session.id) ?? 0;
                    const login = effectiveLogin(session, folder.loginProfileId, loginProfiles);
                    // A blank username is filled in by the shared login at connect.
                    const summary = hostSummary({
                      ...session,
                      username: session.username?.trim() || login?.profile.username,
                    });
                    const showSummary = !!summary && summary !== session.name;
                    return (
                      <div
                        key={session.id}
                        draggable
                        onDragStart={(e) => {
                          e.dataTransfer.setData(
                            'application/x-session',
                            JSON.stringify({ sessionId: session.id, fromFolderId: folder.id })
                          );
                          e.dataTransfer.effectAllowed = 'move';
                        }}
                        onDragEnd={() => setDragOverFolder(null)}
                        onContextMenu={(e) => handleContextMenu(e, session.id, folder.id)}
                        onDoubleClick={(e) => onConnect(session, { newTab: e.shiftKey })}
                        className={`group flex items-center gap-2 px-2 py-1.5 rounded-md cursor-pointer select-none hover:bg-[var(--bg-tertiary)] transition-colors ${
                          topMatch?.id === session.id ? 'bg-[var(--bg-tertiary)]' : ''
                        }`}
                        title={`${deviceMeta(session.deviceType).label} · drag to a folder · double-click to connect · ${shiftDoubleClick} opens another session`}
                      >
                        <DeviceIcon deviceType={session.deviceType} />
                        <div className="flex-1 min-w-0">
                          <span className="block text-[13px] text-[var(--text-secondary)] group-hover:text-[var(--text-primary)] truncate">
                            {session.name}
                          </span>
                          {/* Where it points, so same-named or renamed hosts can be told apart,
                              and which shared login it signs in with. */}
                          {(showSummary || login) && (
                            <span className="flex items-center gap-1.5 min-w-0 text-[11px] leading-tight text-[var(--text-muted)]">
                              {showSummary && <span className="truncate">{summary}</span>}
                              {login && (
                                <span
                                  className="flex items-center gap-0.5 min-w-0 flex-shrink-[2]"
                                  title={`Logs in with the "${login.profile.name}" login${
                                    login.fromFolder ? ' (folder default)' : ''
                                  }`}
                                >
                                  <KeyRound size={9} className="flex-shrink-0" />
                                  <span className="truncate">{login.profile.name}</span>
                                </span>
                              )}
                            </span>
                          )}
                          {(session.tags?.length ?? 0) > 0 && (
                            <span className="flex flex-wrap gap-1 mt-0.5">
                              {session.tags!.slice(0, 4).map((t) => (
                                <button
                                  key={t}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setQuery(t);
                                  }}
                                  className="px-1 py-px rounded text-[9px] leading-none bg-[var(--bg-tertiary)] text-[var(--text-muted)] hover:text-[var(--accent)] hover:bg-[var(--accent-soft)]"
                                  title={`Filter by "${t}"`}
                                >
                                  {t}
                                </button>
                              ))}
                            </span>
                          )}
                          {(() => {
                            const ag = agentFor(session.id);
                            if (!ag) return null;
                            return (
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setAgentMenu({ x: e.clientX, y: e.clientY, sessionId: session.id });
                                }}
                                className="flex items-center gap-1 mt-0.5 max-w-full"
                                title={`AI agent: ${ag.name} · click to change`}
                              >
                                <Bot size={10} style={{ color: ag.color }} className="flex-shrink-0" />
                                <span
                                  className="px-1 py-px rounded text-[9px] leading-none truncate"
                                  style={{ background: 'var(--bg-tertiary)', color: ag.color }}
                                >
                                  {ag.name}
                                </span>
                              </button>
                            );
                          })()}
                        </div>
                        {liveTabs > 0 && (
                          <span
                            className="flex items-center gap-0.5 flex-shrink-0 text-[10px] tabular-nums text-[var(--accent-success)]"
                            title={liveTabs === 1 ? 'Connected' : `${liveTabs} sessions connected`}
                          >
                            <span className="w-1.5 h-1.5 rounded-full" style={{ background: 'var(--accent-success)' }} />
                            {liveTabs > 1 && liveTabs}
                          </span>
                        )}
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            onConnect(session, { newTab: e.shiftKey });
                          }}
                          className="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-[var(--border-strong)] text-[var(--accent-success)] flex-shrink-0"
                          title={`Connect (${isMac ? '⇧-click' : 'Shift+click'} opens another session)`}
                        >
                          <Play size={12} />
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}

        {q && !topMatch && (
          <div className="px-3 py-2 text-[11px] text-[var(--text-muted)]">No hosts match “{q}”.</div>
        )}

        {/* Empty state: the two ways to get hosts in here */}
        {savedCount === 0 && !q && (
          <div className="mx-2.5 mt-2 p-3 rounded-[var(--radius)] border border-dashed border-[var(--border)] bg-[var(--bg-inset)]">
            <p className="text-[12px] font-medium text-[var(--text-primary)]">No saved hosts yet</p>
            <p className="mt-0.5 text-[11px] text-[var(--text-muted)]">
              Save the devices you log in to often, then double-click to connect.
            </p>
            <div className="mt-2.5 flex flex-col gap-1.5">
              <button
                onClick={() => openQuickConnect({ save: true })}
                className="flex items-center justify-center gap-1.5 h-8 text-[12px] rounded-md bg-[var(--bg-tertiary)] hover:bg-[var(--border-strong)] text-[var(--text-primary)] transition-colors"
              >
                <Plus size={13} />
                Add a host
              </button>
              <button
                onClick={() => openImportHosts()}
                className="flex items-center justify-center gap-1.5 h-8 text-[12px] rounded-md bg-[var(--bg-tertiary)] hover:bg-[var(--border-strong)] text-[var(--text-primary)] transition-colors"
              >
                <Download size={13} />
                Import hosts…
              </button>
            </div>
            <p className="mt-1.5 text-[10px] text-[var(--text-muted)]">
              From a CSV file, SecureCRT, Aruba Central, Juniper Mist or ~/.ssh/config.
            </p>
          </div>
        )}
      </div>

      {/* Quick Connect */}
      <div className="px-2.5 py-2.5 border-t border-[var(--border)]">
        <button
          onClick={() => useSessionStore.getState().setShowQuickConnect(true)}
          className="btn-accent flex items-center justify-center gap-2 w-full h-9 text-sm"
        >
          <Plus size={15} />
          Quick Connect
        </button>
      </div>

      {/* Context menu */}
      {contextMenu && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setContextMenu(null)} onContextMenu={(e) => { e.preventDefault(); setContextMenu(null); }} />
          <div
            className="surface-elevated fixed z-50 min-w-[150px] py-1 animate-scale-in"
            // Clamp so a right/bottom-edge click doesn't render the menu off-screen.
            style={{
              top: Math.max(4, Math.min(contextMenu.y, window.innerHeight - 260)),
              left: Math.max(4, Math.min(contextMenu.x, window.innerWidth - 170)),
            }}
          >
            <button
              onClick={handleCtxConnect}
              className="flex items-center gap-2.5 w-full px-3 py-1.5 text-[13px] text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]"
            >
              <Play size={14} className="text-[var(--accent-success)]" />
              Connect
            </button>
            <button
              onClick={handleCtxOpenNew}
              className="flex items-center gap-2.5 w-full px-3 py-1.5 text-[13px] text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]"
              title="Another session to this host in its own tab, even if one is open"
            >
              <CopyPlus size={14} />
              Open new session
            </button>
            <button
              onClick={handleCtxEditHost}
              className="flex items-center gap-2.5 w-full px-3 py-1.5 text-[13px] text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]"
            >
              <Pencil size={14} />
              Edit…
            </button>
            <button
              onClick={handleCtxRename}
              className="flex items-center gap-2.5 w-full px-3 py-1.5 text-[13px] text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]"
            >
              <Edit3 size={14} />
              Rename
            </button>
            <button
              onClick={handleCtxTags}
              className="flex items-center gap-2.5 w-full px-3 py-1.5 text-[13px] text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]"
            >
              <Tag size={14} />
              Tags…
            </button>
            <button
              onClick={handleCtxAgent}
              className="flex items-center gap-2.5 w-full px-3 py-1.5 text-[13px] text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]"
            >
              <Bot size={14} className="text-[var(--accent)]" />
              AI Agent…
            </button>
            <div className="my-1 h-px bg-[var(--border)]" />
            <button
              onClick={handleCtxDelete}
              className="flex items-center gap-2.5 w-full px-3 py-1.5 text-[13px] text-[var(--accent-danger)] hover:bg-[var(--bg-tertiary)]"
            >
              <Trash2 size={14} />
              Delete
            </button>
          </div>
        </>
      )}

      {/* Folder context menu */}
      {folderMenu && (() => {
        const folder = folders.find((f) => f.id === folderMenu.folderId);
        if (!folder) return null;
        const close = () => setFolderMenu(null);
        return (
          <>
            <div className="fixed inset-0 z-40" onClick={close} onContextMenu={(e) => { e.preventDefault(); close(); }} />
            <div
              className="surface-elevated fixed z-50 min-w-[170px] py-1 animate-scale-in"
              style={{
                top: Math.max(4, Math.min(folderMenu.y, window.innerHeight - 140)),
                left: Math.max(4, Math.min(folderMenu.x, window.innerWidth - 190)),
              }}
            >
              <button
                onClick={() => {
                  close();
                  setLoginMenu({ x: folderMenu.x, y: folderMenu.y, folderId: folder.id });
                }}
                className="flex items-center gap-2.5 w-full px-3 py-1.5 text-[13px] text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]"
              >
                <KeyRound size={14} className="text-[var(--accent)]" />
                Default login…
              </button>
              <button
                onClick={() => {
                  close();
                  void renameFolder(folder.id, folder.name);
                }}
                className="flex items-center gap-2.5 w-full px-3 py-1.5 text-[13px] text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]"
              >
                <Edit3 size={14} />
                Rename
              </button>
              {folder.id !== 'default' && (
                <>
                  <div className="my-1 h-px bg-[var(--border)]" />
                  <button
                    onClick={() => {
                      close();
                      void deleteFolder(folder.id, folder.name, folder.items.length);
                    }}
                    className="flex items-center gap-2.5 w-full px-3 py-1.5 text-[13px] text-[var(--accent-danger)] hover:bg-[var(--bg-tertiary)]"
                  >
                    <Trash2 size={14} />
                    Delete
                  </button>
                </>
              )}
            </div>
          </>
        );
      })()}

      {/* Default-login picker for a folder */}
      {loginMenu && (() => {
        const folder = folders.find((f) => f.id === loginMenu.folderId);
        if (!folder) return null;
        const current = folder.loginProfileId;
        const option = (id: string | undefined, label: string, hint?: string) => (
          <button
            key={id ?? 'none'}
            onClick={() => setFolderLogin(folder.id, id)}
            className="flex items-center gap-2 w-full px-3 py-1.5 text-[13px] text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] text-left"
          >
            <span className="w-3.5 flex-shrink-0 flex justify-center">
              {current === id && <Check size={13} className="text-[var(--accent)]" />}
            </span>
            <span className="min-w-0">
              <span className="block truncate">{label}</span>
              {hint && <span className="block text-[10px] text-[var(--text-muted)] truncate">{hint}</span>}
            </span>
          </button>
        );
        return (
          <>
            <div
              className="fixed inset-0 z-40"
              onClick={() => setLoginMenu(null)}
              onContextMenu={(e) => {
                e.preventDefault();
                setLoginMenu(null);
              }}
            />
            <div
              className="surface-elevated fixed z-50 min-w-[200px] max-w-[260px] py-1 animate-scale-in overflow-y-auto max-h-[60vh]"
              style={{
                top: Math.max(4, Math.min(loginMenu.y, window.innerHeight - 300)),
                left: Math.max(4, Math.min(loginMenu.x, window.innerWidth - 270)),
              }}
            >
              <div className="px-3 py-1 text-[10px] uppercase tracking-wider text-[var(--text-muted)] truncate">
                Default login for {folder.name}
              </div>
              {option(undefined, 'None', 'Each host uses its own password')}
              {loginProfiles.length > 0 && <div className="my-1 h-px bg-[var(--border)]" />}
              <div className="max-h-[240px] overflow-y-auto">
                {loginProfiles.map((p) => option(p.id, p.name, p.username))}
              </div>
              <div className="my-1 h-px bg-[var(--border)]" />
              <p className="px-3 py-1 text-[10px] text-[var(--text-muted)]">
                Hosts can pick another login in Edit…
              </p>
              <button
                onClick={openManageLogins}
                className="flex items-center gap-2.5 w-full px-3 py-1.5 text-[12px] text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]"
              >
                <Settings2 size={13} />
                {loginProfiles.length > 0 ? 'Manage logins…' : 'Create a login…'}
              </button>
            </div>
          </>
        );
      })()}

      {/* Agent picker */}
      {agentMenu && (
        <>
          <div
            className="fixed inset-0 z-40"
            onClick={() => setAgentMenu(null)}
            onContextMenu={(e) => {
              e.preventDefault();
              setAgentMenu(null);
            }}
          />
          <div
            className="surface-elevated fixed z-50 min-w-[180px] max-w-[240px] py-1 animate-scale-in overflow-y-auto max-h-[60vh]"
            // Clamp so a right/bottom-edge click doesn't render the picker off-screen.
            style={{
              top: Math.max(4, Math.min(agentMenu.y, window.innerHeight - 300)),
              left: Math.max(4, Math.min(agentMenu.x, window.innerWidth - 260)),
            }}
          >
            <div className="px-3 py-1 text-[10px] uppercase tracking-wider text-[var(--text-muted)]">
              AI agent for this session
            </div>
            <button
              onClick={() => {
                setSessionAgent(agentMenu.sessionId, null);
                setAgentMenu(null);
              }}
              className="flex items-center gap-2.5 w-full px-3 py-1.5 text-[13px] text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]"
            >
              <span className="w-3.5 flex-shrink-0 flex justify-center">
                {!sessionAgents[agentMenu.sessionId] && <Check size={13} className="text-[var(--accent)]" />}
              </span>
              None (default assistant)
            </button>
            {aiAgents.length > 0 && <div className="my-1 h-px bg-[var(--border)]" />}
            <div className="max-h-[260px] overflow-y-auto">
              {aiAgents.map((a) => {
                const selected = sessionAgents[agentMenu.sessionId] === a.id;
                return (
                  <button
                    key={a.id}
                    onClick={() => {
                      setSessionAgent(agentMenu.sessionId, a.id);
                      setAgentMenu(null);
                    }}
                    className="flex items-center gap-2 w-full px-3 py-1.5 text-[13px] text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]"
                  >
                    <span className="w-3.5 flex-shrink-0 flex justify-center">
                      {selected && <Check size={13} className="text-[var(--accent)]" />}
                    </span>
                    <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: a.color }} />
                    <span className="truncate">{a.name}</span>
                  </button>
                );
              })}
            </div>
            <div className="my-1 h-px bg-[var(--border)]" />
            <button
              onClick={openManageAgents}
              className="flex items-center gap-2.5 w-full px-3 py-1.5 text-[12px] text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]"
            >
              <Settings2 size={13} />
              Manage agents…
            </button>
          </div>
        </>
      )}
    </div>
  );
}
