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
import { useSessionStore } from '../store/sessionStore';
import { ConnectionConfig } from '../types';

const deviceIcons: Record<string, React.ReactNode> = {
  'aruba-cx': <Server size={14} className="text-[#58a6ff]" />,
  'aruba-ap': <Wifi size={14} className="text-[#3fb950]" />,
  'aruba-controller': <Router size={14} className="text-[#d29922]" />,
  generic: <Monitor size={14} className="text-[#8b949e]" />,
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
    removeSessionFromFolder,
  } = useSessionStore();
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    sessionId: string;
    folderId: string;
  } | null>(null);

  if (!sidebarVisible) {
    return (
      <button
        onClick={toggleSidebar}
        className="fixed left-0 top-[40px] z-10 p-1.5 bg-[#161b22] border border-[#30363d] rounded-r hover:bg-[#21262d] text-[#8b949e] hover:text-[#c9d1d9] transition-colors"
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
    <div className="w-64 flex-shrink-0 flex flex-col bg-[#161b22] border-r border-[#21262d] overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between h-10 px-3 border-b border-[#21262d]">
        <span className="text-xs font-semibold text-[#8b949e] uppercase tracking-wider">
          Sessions
        </span>
        <div className="flex items-center gap-1">
          <button className="p-1 rounded hover:bg-[#21262d] text-[#8b949e] hover:text-[#c9d1d9]">
            <Plus size={14} />
          </button>
          <button
            onClick={toggleSidebar}
            className="p-1 rounded hover:bg-[#21262d] text-[#8b949e] hover:text-[#c9d1d9]"
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
              className="flex items-center gap-1.5 w-full px-3 py-1.5 text-left hover:bg-[#21262d] transition-colors"
            >
              {folder.expanded ? (
                <ChevronDown size={14} className="text-[#8b949e]" />
              ) : (
                <ChevronRight size={14} className="text-[#8b949e]" />
              )}
              {folder.expanded ? (
                <FolderOpen size={14} className="text-[#d29922]" />
              ) : (
                <Folder size={14} className="text-[#8b949e]" />
              )}
              <span className="text-sm text-[#c9d1d9]">{folder.name}</span>
              <span className="ml-auto text-xs text-[#484f58]">
                {folder.items.length}
              </span>
            </button>

            {/* Folder Items */}
            {folder.expanded && (
              <div className="ml-2">
                {folder.items.length === 0 && (
                  <div className="px-6 py-2 text-xs text-[#484f58]">
                    No sessions
                  </div>
                )}
                {folder.items.map((session) => (
                  <div
                    key={session.id}
                    onContextMenu={(e) =>
                      handleContextMenu(e, session.id, folder.id)
                    }
                    className="group flex items-center gap-2 px-6 py-1.5 cursor-pointer hover:bg-[#21262d] transition-colors"
                  >
                    {deviceIcons[session.deviceType] || deviceIcons.generic}
                    <span
                      className="flex-1 text-sm text-[#8b949e] group-hover:text-[#c9d1d9] truncate"
                      onClick={() => onConnect(session)}
                    >
                      {session.name}
                    </span>
                    <button
                      onClick={() => onConnect(session)}
                      className="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-[#30363d] text-[#3fb950]"
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
      <div className="px-3 py-2 border-t border-[#21262d]">
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
            className="fixed z-50 min-w-[140px] bg-[#161b22] border border-[#30363d] rounded-lg shadow-lg py-1"
            style={{ top: contextMenu.y, left: contextMenu.x }}
          >
            <button
              onClick={() => {
                // Find session and connect
                setContextMenu(null);
              }}
              className="flex items-center gap-2 w-full px-3 py-1.5 text-sm text-[#c9d1d9] hover:bg-[#21262d]"
            >
              <Play size={14} />
              Connect
            </button>
            <button className="flex items-center gap-2 w-full px-3 py-1.5 text-sm text-[#c9d1d9] hover:bg-[#21262d]">
              <Edit3 size={14} />
              Edit
            </button>
            <button
              onClick={() => {
                removeSessionFromFolder(
                  contextMenu.folderId,
                  contextMenu.sessionId
                );
                setContextMenu(null);
              }}
              className="flex items-center gap-2 w-full px-3 py-1.5 text-sm text-[#ff7b72] hover:bg-[#21262d]"
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
