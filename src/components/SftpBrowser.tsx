import { useState, useEffect, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/tauri';
import { save, open } from '@tauri-apps/api/dialog';
import { listen } from '@tauri-apps/api/event';
import {
  X,
  Upload,
  CornerLeftUp,
  RotateCw,
  FolderPlus,
  Download,
  Trash2,
  PencilLine,
  Folder,
  File as FileIcon,
  Loader2,
} from 'lucide-react';
import { askPrompt, askConfirm } from '../store/dialogStore';
import { notify } from '../store/toastStore';

interface SftpEntry {
  name: string;
  is_dir: boolean;
  size: number;
}

interface Props {
  sessionId: string;
  onClose: () => void;
}

function formatSize(bytes: number): string {
  if (bytes === 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

const basename = (p: string) => p.split(/[\\/]/).pop() || 'file';

export default function SftpBrowser({ sessionId, onClose }: Props) {
  const [cwd, setCwd] = useState('/');
  const [entries, setEntries] = useState<SftpEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);

  const join = (path: string, name: string) => (path === '/' ? `/${name}` : `${path}/${name}`);

  const listDir = useCallback(
    async (path: string) => {
      setLoading(true);
      setError('');
      try {
        const result = await invoke<SftpEntry[]>('sftp_list_dir', { sessionId, path });
        setEntries(result);
        setCwd(path);
      } catch (e) {
        setError(String(e));
      } finally {
        setLoading(false);
      }
    },
    [sessionId]
  );

  useEffect(() => {
    listDir('/');
  }, [listDir]);

  const uploadPath = useCallback(
    async (localPath: string) => {
      const fileName = basename(localPath);
      const remotePath = join(cwd, fileName);
      setBusy(true);
      try {
        try {
          // Try without overwriting; the backend returns EEXIST if it would clobber.
          await invoke('sftp_upload', { sessionId, localPath, remotePath, overwrite: false });
        } catch (e) {
          if (!String(e).includes('EEXIST')) throw e;
          const ok = await askConfirm({
            title: `Overwrite "${fileName}"?`,
            message: `${fileName} already exists in ${cwd}. Replacing it can clobber a device config/firmware file.`,
            confirmLabel: 'Overwrite',
            danger: true,
          });
          if (!ok) return;
          await invoke('sftp_upload', { sessionId, localPath, remotePath, overwrite: true });
        }
        notify.success('Uploaded', fileName);
        listDir(cwd);
      } catch (e) {
        notify.error('Upload failed', String(e));
      } finally {
        setBusy(false);
      }
    },
    [cwd, sessionId, listDir]
  );

  // Native (Tauri) file-drop → upload to the current directory. Tauri's file-drop
  // is window-global (fires for a drop ANYWHERE in the app), so confirm the target
  // before uploading rather than silently pushing files to a remote device.
  useEffect(() => {
    const unlisteners: Array<() => void> = [];
    Promise.all([
      listen<string[]>('tauri://file-drop', async (e) => {
        setDragging(false);
        const paths = e.payload || [];
        if (!paths.length) return;
        const names = paths.map(basename).join(', ');
        const ok = await askConfirm({
          title: paths.length === 1 ? `Upload "${names}"?` : `Upload ${paths.length} files?`,
          message: `Upload to ${cwd} on the remote device?\n${names}`,
          confirmLabel: 'Upload',
        });
        if (!ok) return;
        for (const p of paths) await uploadPath(p);
      }),
      listen('tauri://file-drop-hover', () => setDragging(true)),
      listen('tauri://file-drop-cancelled', () => setDragging(false)),
    ])
      .then((uns) => uns.forEach((u) => unlisteners.push(u)))
      .catch(() => {});
    return () => unlisteners.forEach((u) => u());
  }, [uploadPath]);

  const navigate = (entry: SftpEntry) => {
    if (entry.is_dir) listDir(join(cwd, entry.name));
  };

  const goUp = () => {
    if (cwd === '/') return;
    const parts = cwd.split('/').filter(Boolean);
    parts.pop();
    listDir('/' + parts.join('/'));
  };

  const handleDownload = async (entry: SftpEntry) => {
    const localPath = await save({ defaultPath: entry.name });
    if (!localPath) return;
    setBusy(true);
    try {
      await invoke('sftp_download', { sessionId, remotePath: join(cwd, entry.name), localPath });
      notify.success('Downloaded', entry.name);
    } catch (e) {
      notify.error('Download failed', String(e));
    } finally {
      setBusy(false);
    }
  };

  const handleUploadPick = async () => {
    const localPath = await open({ multiple: false });
    if (!localPath || Array.isArray(localPath)) return;
    uploadPath(localPath);
  };

  const handleMkdir = async () => {
    const name = await askPrompt({ title: 'New folder', placeholder: 'folder name' });
    if (!name) return;
    try {
      await invoke('sftp_mkdir_cmd', { sessionId, path: join(cwd, name) });
      listDir(cwd);
    } catch (e) {
      notify.error('Could not create folder', String(e));
    }
  };

  const handleRename = async (entry: SftpEntry) => {
    const name = await askPrompt({ title: `Rename "${entry.name}"`, defaultValue: entry.name });
    if (!name || name === entry.name) return;
    try {
      await invoke('sftp_rename_cmd', { sessionId, from: join(cwd, entry.name), to: join(cwd, name) });
      listDir(cwd);
    } catch (e) {
      notify.error('Rename failed', String(e));
    }
  };

  const handleDelete = async (entry: SftpEntry) => {
    const ok = await askConfirm({
      title: `Delete "${entry.name}"?`,
      message: entry.is_dir ? 'The directory must be empty.' : undefined,
      danger: true,
    });
    if (!ok) return;
    try {
      await invoke('sftp_delete', { sessionId, path: join(cwd, entry.name), isDir: entry.is_dir });
      listDir(cwd);
    } catch (e) {
      notify.error('Delete failed', String(e));
    }
  };

  const iconBtn =
    'p-1 rounded text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] transition-colors';

  return (
    <div
      className="fixed inset-0 z-[90] flex items-center justify-center modal-backdrop animate-fade-in"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="surface-elevated w-[620px] max-w-[94vw] h-[72vh] flex flex-col animate-scale-in relative">
        {/* Header */}
        <div className="flex items-center gap-2 px-4 py-3 border-b border-[var(--border)]">
          <Upload size={15} style={{ color: 'var(--accent)' }} />
          <span className="text-[14px] font-semibold text-[var(--text-primary)]">SFTP</span>
          <span className="flex-1" />
          <button onClick={handleMkdir} className="flex items-center gap-1.5 px-2.5 h-8 text-[12px] rounded-md bg-[var(--bg-tertiary)] hover:bg-[var(--border-strong)] text-[var(--text-primary)]">
            <FolderPlus size={13} /> New folder
          </button>
          <button onClick={handleUploadPick} className="btn-accent flex items-center gap-1.5 px-2.5 h-8 text-[12px]">
            <Upload size={13} /> Upload
          </button>
          <button onClick={onClose} className={iconBtn}>
            <X size={16} />
          </button>
        </div>

        {/* Path bar */}
        <div className="flex items-center gap-2 px-4 py-2 border-b border-[var(--border)]">
          <button onClick={goUp} disabled={cwd === '/'} className={`${iconBtn} disabled:opacity-40`} title="Up">
            <CornerLeftUp size={15} />
          </button>
          <code className="flex-1 text-[12px] text-[var(--text-secondary)] truncate font-mono">{cwd}</code>
          {busy && <Loader2 size={13} className="animate-spin text-[var(--accent)]" />}
          <button onClick={() => listDir(cwd)} className={iconBtn} title="Refresh">
            <RotateCw size={14} />
          </button>
        </div>

        {/* File list */}
        <div className="flex-1 overflow-y-auto">
          {loading && <div className="px-4 py-4 text-[12px] text-[var(--text-muted)]">Loading…</div>}
          {error && <div className="px-4 py-4 text-[12px] text-[var(--accent-danger)]">{error}</div>}
          {!loading && !error && entries.length === 0 && (
            <div className="px-4 py-4 text-[12px] text-[var(--text-muted)]">Empty directory</div>
          )}
          {entries.map((entry) => (
            <div
              key={entry.name}
              onDoubleClick={() => navigate(entry)}
              className="group flex items-center gap-2.5 px-4 py-1.5 border-b border-[var(--border)] hover:bg-[var(--bg-tertiary)] transition-colors"
              style={{ cursor: entry.is_dir ? 'pointer' : 'default' }}
            >
              {entry.is_dir ? (
                <Folder size={15} className="text-[var(--accent-2)] flex-shrink-0" />
              ) : (
                <FileIcon size={15} className="text-[var(--text-muted)] flex-shrink-0" />
              )}
              <span className="flex-1 text-[13px] text-[var(--text-primary)] truncate">{entry.name}</span>
              <span className="text-[11px] text-[var(--text-muted)] w-16 text-right tabular-nums">
                {entry.is_dir ? '' : formatSize(entry.size)}
              </span>
              <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100">
                {!entry.is_dir && (
                  <button onClick={() => handleDownload(entry)} className={iconBtn} title="Download">
                    <Download size={13} />
                  </button>
                )}
                <button onClick={() => handleRename(entry)} className={iconBtn} title="Rename">
                  <PencilLine size={13} />
                </button>
                <button onClick={() => handleDelete(entry)} className={`${iconBtn} hover:!text-[var(--accent-danger)]`} title="Delete">
                  <Trash2 size={13} />
                </button>
              </div>
            </div>
          ))}
        </div>

        {/* Drag-drop overlay */}
        {dragging && (
          <div className="absolute inset-0 z-10 flex items-center justify-center rounded-[var(--radius-lg)] border-2 border-dashed border-[var(--accent)] bg-[var(--accent-soft)] backdrop-blur-sm pointer-events-none">
            <div className="flex flex-col items-center gap-2 text-[var(--accent)]">
              <Upload size={28} />
              <span className="text-sm font-medium">Drop to upload to {cwd}</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
