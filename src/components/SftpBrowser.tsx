import { useState, useEffect, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/tauri';
import { save, open } from '@tauri-apps/api/dialog';

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

export default function SftpBrowser({ sessionId, onClose }: Props) {
  const [cwd, setCwd] = useState('/');
  const [entries, setEntries] = useState<SftpEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');

  const listDir = useCallback(async (path: string) => {
    setLoading(true);
    setError('');
    try {
      const result = await invoke<SftpEntry[]>('sftp_list_dir', {
        sessionId,
        path,
      });
      setEntries(result);
      setCwd(path);
    } catch (e: any) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    listDir('/');
  }, [listDir]);

  const navigate = (entry: SftpEntry) => {
    if (!entry.is_dir) return;
    const next = cwd === '/' ? `/${entry.name}` : `${cwd}/${entry.name}`;
    listDir(next);
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
    setStatus(`Downloading ${entry.name}...`);
    try {
      const remotePath = cwd === '/' ? `/${entry.name}` : `${cwd}/${entry.name}`;
      await invoke('sftp_download', { sessionId, remotePath, localPath });
      setStatus(`Downloaded ${entry.name} ✓`);
    } catch (e: any) {
      setStatus(`Error: ${e}`);
    }
  };

  const handleUpload = async () => {
    const localPath = await open({ multiple: false });
    if (!localPath || Array.isArray(localPath)) return;
    const fileName = localPath.split('/').pop() || 'file';
    const remotePath = cwd === '/' ? `/${fileName}` : `${cwd}/${fileName}`;
    setStatus(`Uploading ${fileName}...`);
    try {
      await invoke('sftp_upload', { sessionId, localPath, remotePath });
      setStatus(`Uploaded ${fileName} ✓`);
      listDir(cwd);
    } catch (e: any) {
      setStatus(`Error: ${e}`);
    }
  };

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9000,
    }} onClick={onClose}>
      <div onClick={e => e.stopPropagation()} style={{
        background: 'var(--bg-secondary)', border: '1px solid var(--border)',
        borderRadius: 8, width: 560, maxHeight: '70vh', display: 'flex', flexDirection: 'column',
      }}>
        {/* Header */}
        <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontWeight: 600, color: 'var(--text-primary)' }}>SFTP — {sessionId}</span>
          <span style={{ flex: 1 }} />
          <button onClick={handleUpload} style={btnStyle}>⬆ Upload</button>
          <button onClick={onClose} style={btnStyle}>✕</button>
        </div>

        {/* Path bar */}
        <div style={{ padding: '8px 16px', display: 'flex', alignItems: 'center', gap: 8, borderBottom: '1px solid var(--border)' }}>
          <button onClick={goUp} disabled={cwd === '/'} style={btnStyle}>⬆ Up</button>
          <code style={{ color: 'var(--text-secondary)', fontSize: 13 }}>{cwd}</code>
          <button onClick={() => listDir(cwd)} style={btnStyle}>⟳</button>
        </div>

        {/* File list */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '4px 0' }}>
          {loading && <div style={{ padding: 16, color: 'var(--text-muted)' }}>Loading...</div>}
          {error && <div style={{ padding: 16, color: '#f87171' }}>{error}</div>}
          {!loading && !error && entries.length === 0 && (
            <div style={{ padding: 16, color: 'var(--text-muted)' }}>Empty directory</div>
          )}
          {entries.map(entry => (
            <div
              key={entry.name}
              onDoubleClick={() => navigate(entry)}
              style={{
                display: 'flex', alignItems: 'center', padding: '6px 16px', gap: 10,
                cursor: entry.is_dir ? 'pointer' : 'default',
                borderBottom: '1px solid var(--border)',
              }}
              onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-tertiary)')}
              onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
            >
              <span style={{ width: 20, textAlign: 'center' }}>{entry.is_dir ? '📁' : '📄'}</span>
              <span style={{ flex: 1, color: 'var(--text-primary)', fontSize: 13 }}>{entry.name}</span>
              <span style={{ color: 'var(--text-muted)', fontSize: 12, width: 70, textAlign: 'right' }}>
                {entry.is_dir ? '' : formatSize(entry.size)}
              </span>
              {!entry.is_dir && (
                <button onClick={() => handleDownload(entry)} style={{ ...btnStyle, fontSize: 11 }}>⬇</button>
              )}
            </div>
          ))}
        </div>

        {/* Status */}
        {status && (
          <div style={{ padding: '8px 16px', borderTop: '1px solid var(--border)', color: 'var(--text-muted)', fontSize: 12 }}>
            {status}
          </div>
        )}
      </div>
    </div>
  );
}

const btnStyle: React.CSSProperties = {
  background: 'var(--bg-tertiary)', border: '1px solid var(--border)',
  borderRadius: 4, padding: '4px 10px', color: 'var(--text-primary)',
  cursor: 'pointer', fontSize: 12,
};
