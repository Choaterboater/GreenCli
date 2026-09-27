import { useCallback, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/tauri';
import { Trash2, ShieldCheck, RefreshCw, FileSpreadsheet, FolderOpen, Cloud, KeyRound } from 'lucide-react';
import { useSessionStore } from '../store/sessionStore';
import { notify } from '../store/toastStore';
import type { ImportSource } from '../utils/importHosts';

interface KnownHost {
  hostPort: string;
  fingerprint: string;
}

const IMPORT_SOURCES: { id: ImportSource; label: string; icon: typeof Cloud }[] = [
  { id: 'csv', label: 'CSV file', icon: FileSpreadsheet },
  { id: 'securecrt', label: 'SecureCRT', icon: FolderOpen },
  { id: 'central', label: 'Aruba Central', icon: Cloud },
  { id: 'mist', label: 'Juniper Mist', icon: Cloud },
  { id: 'ssh', label: '~/.ssh/config', icon: KeyRound },
];

export default function HostsManager() {
  const [knownHosts, setKnownHosts] = useState<KnownHost[]>([]);

  const loadKnown = useCallback(() => {
    invoke<KnownHost[]>('list_known_hosts')
      .then((h) => setKnownHosts(h || []))
      .catch(() => setKnownHosts([]));
  }, []);

  useEffect(() => {
    loadKnown();
  }, [loadKnown]);

  // Settings closes first: the import dialog is its own modal, and the two
  // stacked would both answer Escape.
  const openImport = (source: ImportSource) => {
    const s = useSessionStore.getState();
    s.setShowSettings(false);
    s.openImportHosts(source);
  };

  const forget = async (hostPort: string) => {
    await invoke('remove_known_host', { hostPort }).catch(() => {});
    notify.info('Host key forgotten', `${hostPort} will be re-trusted on next connect.`);
    loadKnown();
  };

  return (
    <section>
      <h3 className="text-sm font-semibold text-[var(--text-primary)] mb-3">Host Import &amp; SSH Host Keys</h3>

      {/* Every host import lives in one dialog; each button opens its tab. */}
      <div id="set-import" className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--bg-inset)] p-3 mb-3">
        <p className="text-[13px] text-[var(--text-primary)]">Import hosts</p>
        <p className="text-[11px] text-[var(--text-muted)]">
          Add saved hosts in bulk. You see a preview first; hosts you already have are skipped and passwords are never imported.
        </p>
        <div className="mt-2.5 flex flex-wrap gap-1.5">
          {IMPORT_SOURCES.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => openImport(id)}
              className="flex items-center gap-1.5 px-3 h-8 text-[12px] rounded-md bg-[var(--bg-tertiary)] hover:bg-[var(--border-strong)] text-[var(--text-primary)] transition-colors"
            >
              <Icon size={13} />
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* Known host keys */}
      <div className="flex items-center justify-between mb-1.5">
        <p className="text-[12px] font-medium text-[var(--text-secondary)] flex items-center gap-1.5">
          <ShieldCheck size={13} className="text-[var(--accent-success)]" />
          Trusted host keys ({knownHosts.length})
        </p>
        <button onClick={loadKnown} className="p-1 rounded text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]" title="Refresh">
          <RefreshCw size={12} />
        </button>
      </div>
      <div className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--bg-inset)] divide-y divide-[var(--border)] max-h-44 overflow-y-auto">
        {knownHosts.length === 0 ? (
          <div className="px-3 py-3 text-[11px] text-[var(--text-muted)] text-center">No trusted host keys yet (recorded on first SSH connect).</div>
        ) : (
          knownHosts.map((k) => (
            <div key={k.hostPort} className="flex items-center gap-2 px-3 py-1.5">
              <div className="min-w-0 flex-1">
                <p className="text-[12px] text-[var(--text-primary)] truncate">{k.hostPort}</p>
                <p className="text-[10px] text-[var(--text-muted)] font-mono truncate">{k.fingerprint}</p>
              </div>
              <button
                onClick={() => forget(k.hostPort)}
                className="p-1 rounded text-[var(--text-muted)] hover:text-[var(--accent-danger)] hover:bg-[var(--bg-tertiary)]"
                title="Forget (re-trust on next connect)"
              >
                <Trash2 size={13} />
              </button>
            </div>
          ))
        )}
      </div>
    </section>
  );
}
