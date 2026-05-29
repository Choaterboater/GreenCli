import { useState } from 'react';
import {
  ChevronRight,
  ChevronDown,
  Folder,
  FolderOpen,
  Monitor,
  Server,
  Wifi,
  Router,
  Plus,
  Trash2,
  Play,
  Edit3,
  PanelLeftClose,
} from 'lucide-react';
import { invoke } from '@tauri-apps/api/tauri';
import { useSessionStore } from '../store/sessionStore';
import { ConnectionConfig } from '../types';

const deviceIcons: Record<string, React.ReactNode> = {
  'aruba-cx': <Server size={14} className="text-[#58a6ff]" />,
  'aruba-ap': <Wifi size={14} className="text-[#3fb950]" />,
  'aruba-controller': <Router size={14} className="text-[#d29922]" />,
  generic: <Monitor size={14} className="text-[var(--text-secondary)]" />,
};

interface SidebarProps {
  onConnect: (config: ConnectionConfig) => void;
}

export default function Sidebar({ onConnect }: SidebarProps) {
  const {
    folders,
    sidebarVisible,
    toggleSidebar,
    updateFolder,
    addFolder,
    removeSessionFromFolder,
  } = useSessionStore();
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    sessionId: string;
    folderId: string;
  } | null>(null);

  // Add a folder (persisted via the backend when available).
  const handleAddFolder = () => {
    const name = window.prompt('Folder name:', 'New Folder');
    if (!name) return;
    invoke<string>('create_folder', { name })
      .then((id) => addFolder({ id, name, items: [], expanded: true }))
      .catch(() => addFolder({ id: `folder-${Date.now()}`, name, items: [], expanded: true }));
  };

  // Resolve the session a context-menu action targets.
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

  const handleCtxEdit = () => {
    const item = ctxItem();
    if (!item || !contextMenu) return;
    const name = window.prompt('Rename session:', item.name);
    if (name) {
      const folder = folders.find((f) => f.id === contextMenu.folderId);
      if (folder) {
        updateFolder(folder.id, {
          items: folder.items.map((s) => (s.id === item.id ? { ...s, name } : s)),
        });
      }
    }
    setContextMenu(null);
  };

  if (!sidebarVisible) {
    return (
      <button
        onClick={toggleSidebar}
        className="fixed left-0 top-[40px] z-10 p-1.5 bg-[var(--bg-secondary)] border border-[var(--border)] rounded-r hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors"
      >
        <PanelLeftClose size={16} />
      </button>
    );
  }

  const handleContextMenu = (
    e: React.MouseEvent,
    sessionId: string,
    folderId: string
  ) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY, sessionId, folderId });
  };

  return (
    <div className="w-64 flex-shrink-0 flex flex-col bg-[var(--bg-secondary)] border-r border-[var(--bg-tertiary)] overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between h-10 px-3 border-b border-[var(--bg-tertiary)]">
        <span className="text-xs font-semibold text-[var(--text-secondary)] uppercase tracking-wider">
          Sessions
        </span>
        <div className="flex items-center gap-1">
          <button
            onClick={handleAddFolder}
            className="p-1 rounded hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
            title="Add folder"
          >
            <Plus size={14} />
          </button>
          <button
            onClick={toggleSidebar}
            className="p-1 rounded hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
          >
            <PanelLeftClose size={14} />
          </button>
        </div>
      </div>

      {/* Folders */}
      <div className="flex-1 overflow-y-auto py-1">
        {folders.map((folder) => (
          <div key={folder.id}>
            {/* Folder Header */}
            <button
              onClick={() =>
                updateFolder(folder.id, { expanded: !folder.expanded })
              }
              className="flex items-center gap-1.5 w-full px-3 py-1.5 text-left hover:bg-[var(--bg-tertiary)] transition-colors"
            >
              {folder.expanded ? (
                <ChevronDown size={14} className="text-[var(--text-secondary)]" />
              ) : (
                <ChevronRight size={14} className="text-[var(--text-secondary)]" />
              )}
              {folder.expanded ? (
                <FolderOpen size={14} className="text-[#d29922]" />
              ) : (
                <Folder size={14} className="text-[var(--text-secondary)]" />
              )}
              <span className="text-sm text-[var(--text-primary)]">{folder.name}</span>
              <span className="ml-auto text-xs text-[var(--text-muted)]">
                {folder.items.length}
              </span>
            </button>

            {/* Folder Items */}
            {folder.expanded && (
              <div className="ml-2">
                {folder.items.length === 0 && (
                  <div className="px-6 py-2 text-xs text-[var(--text-muted)]">
                    No sessions
                  </div>
                )}
                {folder.items.map((session) => (
                  <div
                    key={session.id}
                    onContextMenu={(e) =>
                      handleContextMenu(e, session.id, folder.id)
                    }
                    className="group flex items-center gap-2 px-6 py-1.5 cursor-pointer hover:bg-[var(--bg-tertiary)] transition-colors"
                  >
                    {deviceIcons[session.deviceType] || deviceIcons.generic}
                    <span
                      className="flex-1 text-sm text-[var(--text-secondary)] group-hover:text-[var(--text-primary)] truncate"
                      onClick={() => onConnect(session)}
                    >
                      {session.name}
                    </span>
                    <button
                      onClick={() => onConnect(session)}
                      className="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-[var(--border)] text-[#3fb950]"
                    >
                      <Play size={12} />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Quick Connect Bar */}
      <div className="px-3 py-2 border-t border-[var(--bg-tertiary)]">
        <button
          onClick={() => useSessionStore.getState().setShowQuickConnect(true)}
          className="flex items-center justify-center gap-2 w-full h-8 text-sm bg-[#238636] hover:bg-[#2ea043] text-white rounded transition-colors"
        >
          <Plus size={14} />
          Quick Connect
        </button>
      </div>

      {/* Context Menu */}
      {contextMenu && (
        <>
          <div
            className="fixed inset-0 z-40"
            onClick={() => setContextMenu(null)}
          />
          <div
            className="fixed z-50 min-w-[140px] bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg shadow-lg py-1"
            style={{ top: contextMenu.y, left: contextMenu.x }}
          >
            <button
              onClick={handleCtxConnect}
              className="flex items-center gap-2 w-full px-3 py-1.5 text-sm text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]"
            >
              <Play size={14} />
              Connect
            </button>
            <button
              onClick={handleCtxEdit}
              className="flex items-center gap-2 w-full px-3 py-1.5 text-sm text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]"
            >
              <Edit3 size={14} />
              Rename
            </button>
            <button
              onClick={() => {
                removeSessionFromFolder(
                  contextMenu.folderId,
                  contextMenu.sessionId
                );
                setContextMenu(null);
              }}
              className="flex items-center gap-2 w-full px-3 py-1.5 text-sm text-[#ff7b72] hover:bg-[var(--bg-tertiary)]"
            >
              <Trash2 size={14} />
              Delete
            </button>
          </div>
        </>
      )}
    </div>
  );
}
