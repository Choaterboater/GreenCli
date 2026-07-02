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
} from 'lucide-react';
import { invoke } from '@tauri-apps/api/tauri';
import { useSessionStore } from '../store/sessionStore';
import { useSettingsStore } from '../store/settingsStore';
import { useResizablePanel } from '../hooks/useResizablePanel';
import { ConnectionConfig, deviceMeta, vendorColor } from '../types';
import { fuzzyMatch } from '../utils';
import { askPrompt, askConfirm } from '../store/dialogStore';
import { notify } from '../store/toastStore';

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
  onConnect: (config: ConnectionConfig) => void;
}

export default function Sidebar({ onConnect }: SidebarProps) {
  const {
    folders,
    sidebarVisible,
    sessions,
    toggleSidebar,
    updateFolder,
    addFolder,
    removeFolder,
    removeSessionFromFolder,
    moveSessionToFolder,
  } = useSessionStore();
  const aiAgents = useSettingsStore((s) => s.aiAgents) ?? [];
  const sessionAgents = useSettingsStore((s) => s.sessionAgents) ?? {};
  const setSessionAgent = useSettingsStore((s) => s.setSessionAgent);
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
  // Folder currently hovered while dragging a session (for the drop highlight).
  const [dragOverFolder, setDragOverFolder] = useState<string | null>(null);

  // Move a saved session into another folder (drag-and-drop) + persist.
  const handleMoveSession = (sessionId: string, fromFolderId: string, toFolderId: string) => {
    if (fromFolderId === toFolderId) return;
    moveSessionToFolder(sessionId, fromFolderId, toFolderId);
    invoke('move_session', { id: sessionId, folderId: toFolderId }).catch(() => {});
  };

  // Live connection state: a saved session whose id matches a connected tab.
  const connectedIds = useMemo(
    () => new Set(sessions.filter((s) => s.connected).map((s) => s.sessionId)),
    [sessions]
  );

  const q = query.trim();
  // Fuzzy match across name / host / user / tags (cencli-style, ignores -_ and case).
  const matches = (s: ConnectionConfig) =>
    !q || fuzzyMatch(q, `${s.name} ${s.host ?? ''} ${s.username ?? ''} ${(s.tags ?? []).join(' ')}`);

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

  const handleCtxEdit = async () => {
    const item = ctxItem();
    const ctx = contextMenu;
    setContextMenu(null);
    if (!item || !ctx) return;
    const name = await askPrompt({ title: 'Rename session', defaultValue: item.name });
    if (!name) return;
    const folder = folders.find((f) => f.id === ctx.folderId);
    if (folder) {
      updateFolder(folder.id, {
        items: folder.items.map((s) => (s.id === item.id ? { ...s, name } : s)),
      });
    }
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
            placeholder="Search hosts…"
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
                  {visibleItems.length === 0 && (
                    <div className="px-2 py-1.5 text-[11px] text-[var(--text-muted)]">No sessions</div>
                  )}
                  {visibleItems.map((session) => {
                    const isConnected = connectedIds.has(session.id);
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
                        onDoubleClick={() => onConnect(session)}
                        className="group flex items-center gap-2 px-2 py-1.5 rounded-md cursor-pointer hover:bg-[var(--bg-tertiary)] transition-colors"
                        title={`${deviceMeta(session.deviceType).label} · drag to a folder · double-click to connect`}
                      >
                        <DeviceIcon deviceType={session.deviceType} />
                        <div className="flex-1 min-w-0">
                          <span className="block text-[13px] text-[var(--text-secondary)] group-hover:text-[var(--text-primary)] truncate">
                            {session.name}
                          </span>
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
                        {isConnected && (
                          <span
                            className="w-1.5 h-1.5 rounded-full flex-shrink-0"
                            style={{ background: 'var(--accent-success)' }}
                            title="Connected"
                          />
                        )}
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            onConnect(session);
                          }}
                          className="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-[var(--border-strong)] text-[var(--accent-success)] flex-shrink-0"
                          title="Connect"
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
              top: Math.max(4, Math.min(contextMenu.y, window.innerHeight - 220)),
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
              onClick={handleCtxEdit}
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
