// The Config Editor's folder view, like VS Code's Explorer: the files of a
// folder you opened (Ansible playbooks, scripts, a config backup folder), as a
// tree. A click opens the file in a tab (or goes to its tab). Read-only: the
// backend only lists the folder; files are opened and saved like any other.

import { useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, File, Folder, FolderOpen, RefreshCw, X } from 'lucide-react';
import { cannotOpen, visibleRows, type FolderEntry, type FolderListing } from '../utils/folderTree';

interface Props {
  listing: FolderListing;
  /** The path (from the folder) of the file in the active tab, to highlight it. */
  activePath: string | null;
  loading: boolean;
  onOpen: (entry: FolderEntry) => void;
  onPickFolder: () => void;
  onRefresh: () => void;
  onClose: () => void;
}

const folderName = (root: string) => root.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || root;

export default function FolderPane({ listing, activePath, loading, onOpen, onPickFolder, onRefresh, onClose }: Props) {
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const [filter, setFilter] = useState('');
  const rows = useMemo(() => visibleRows(listing.entries, open, filter), [listing.entries, open, filter]);
  const files = useMemo(() => listing.entries.filter((e) => !e.isDir).length, [listing.entries]);

  const toggle = (path: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  return (
    <nav aria-label="Folder" className="flex flex-col w-56 flex-shrink-0 border-r border-[var(--bg-tertiary)] bg-[var(--bg-secondary)] min-h-0">
      <div className="flex items-center gap-1 h-7 px-2 border-b border-[var(--bg-tertiary)] flex-shrink-0">
        <button
          onClick={onPickFolder}
          className="flex-1 min-w-0 flex items-center gap-1 text-left text-[10px] font-semibold tracking-wide uppercase text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
          title={`${listing.root}\nClick to open another folder`}
        >
          <FolderOpen size={11} className="flex-shrink-0" />
          <span className="truncate">{folderName(listing.root)}</span>
        </button>
        <button
          onClick={onRefresh}
          className="p-0.5 rounded text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]"
          title="Refresh"
          aria-label="Refresh the folder"
        >
          <RefreshCw size={11} className={loading ? 'animate-spin' : ''} />
        </button>
        <button
          onClick={onClose}
          className="p-0.5 rounded text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]"
          title="Hide the folder"
          aria-label="Hide the folder"
        >
          <X size={11} />
        </button>
      </div>
      <div className="px-2 py-1.5 border-b border-[var(--bg-tertiary)] flex-shrink-0">
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder={`Find in ${files} file${files === 1 ? '' : 's'}`}
          aria-label="Find a file"
          className="w-full px-2 py-1 text-[11px] rounded bg-[var(--bg-primary)] border border-[var(--border)] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] outline-none focus:border-[var(--accent)]"
        />
      </div>
      <ul role="tree" className="flex-1 overflow-auto py-1 text-[11px]">
        {rows.map((row) => {
          const why = cannotOpen(row);
          const isOpen = row.isDir && (open.has(row.path) || !!filter.trim());
          return (
            <li key={row.path} role="treeitem" aria-expanded={row.isDir ? isOpen : undefined} aria-selected={row.path === activePath}>
              <button
                onClick={() => (row.isDir ? toggle(row.path) : onOpen(row))}
                disabled={!!why}
                title={why ?? row.path}
                style={{ paddingLeft: 8 + row.depth * 12 }}
                className={`flex items-center gap-1 w-full pr-2 py-0.5 text-left truncate disabled:opacity-40 ${
                  row.path === activePath
                    ? 'bg-[var(--accent-soft)] text-[var(--text-primary)]'
                    : 'text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]'
                }`}
              >
                {row.isDir ? (
                  <>
                    {isOpen ? <ChevronDown size={10} className="flex-shrink-0" /> : <ChevronRight size={10} className="flex-shrink-0" />}
                    <Folder size={11} className="flex-shrink-0 text-[var(--accent-warning)]" />
                  </>
                ) : (
                  <File size={11} className="flex-shrink-0 ml-[14px] text-[var(--text-muted)]" />
                )}
                <span className="truncate">{row.name}</span>
              </button>
            </li>
          );
        })}
        {rows.length === 0 && (
          <li className="px-3 py-2 text-[var(--text-muted)]">{filter.trim() ? 'No file matches.' : 'This folder is empty.'}</li>
        )}
      </ul>
      {listing.truncated && (
        <p className="px-2 py-1 border-t border-[var(--bg-tertiary)] text-[10px] text-[var(--accent-warning)] flex-shrink-0">
          Big folder: only the first {listing.entries.length} items are listed.
        </p>
      )}
    </nav>
  );
}
