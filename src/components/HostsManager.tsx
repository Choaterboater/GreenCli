import { useCallback, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Trash2, ShieldCheck, RefreshCw, FileSpreadsheet, FolderOpen, Cloud, KeyRound, FlaskConical } from 'lucide-react';
import { useSessionStore } from '../store/sessionStore';
import { notify } from '../store/toastStore';
import type { ImportSource } from '../utils/importHosts';
import { isTauri, tauriSave } from '../utils/fileSystem';
import { copyText } from '../utils/clipboard';
import { buildLabExport, labImportCommand, LAB_EXPORT_FILE_NAME, type LabExport } from '../utils/labExport';

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

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

export default function HostsManager() {
  const [knownHosts, setKnownHosts] = useState<KnownHost[]>([]);
  const [labBusy, setLabBusy] = useState(false);
  const [labDone, setLabDone] = useState<(LabExport & { command: string }) | null>(null);

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
    try {
      // A damaged host keys file is moved aside first: say where it went.
      const notice = await invoke<string | null>('remove_known_host', { hostPort });
      notify.info('Host key forgotten', `${hostPort} will be re-trusted on next connect.`);
      if (notice) notify.warning('Host keys file was damaged', notice);
    } catch (e) {
      notify.warning("Couldn't forget host key", String(e));
    } finally {
      loadKnown();
    }
  };

  // The address of every host tagged "lab", as Casper's lab file. Same save flow as the MCP export:
  // a quick path check here, then Rust checks the real path again and writes it owner-only.
  const exportLab = async () => {
    if (labBusy) return;
    if (!isTauri) {
      notify.info('Export needs the desktop app');
      return;
    }
    const result = buildLabExport(useSessionStore.getState().folders);
    if (result.hosts.length === 0) {
      const why = result.skipped.slice(0, 3).map((s) => `${s.name}: ${s.reason}`);
      notify.warning('No lab hosts', ['Tag a host "lab" first: right-click it, then Tags…', ...why].join(' '));
      return;
    }
    setLabBusy(true);
    try {
      const path = await tauriSave(LAB_EXPORT_FILE_NAME, 'Export lab hosts for Casper');
      if (!path) return;
      const { refusedExportPath } = await import('../utils/mcpExport');
      const refused = refusedExportPath(path, 'your Documents folder');
      if (refused) {
        notify.error('Not saved', refused);
        return;
      }
      await invoke('mcp_export_write', { path, contents: result.text });
      setLabDone({ ...result, command: labImportCommand(path) });
      notify.success('Lab hosts exported', `${plural(result.hosts.length, 'host')} saved`);
    } catch (e) {
      notify.error('Could not export lab hosts', String(e));
    } finally {
      setLabBusy(false);
    }
  };

  const copyLabCommand = async (command: string) => {
    if (await copyText(command)) notify.success('Copied');
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

      {/* Lab hosts for Casper: addresses only, never names, logins or passwords */}
      <div className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--bg-inset)] p-3 mb-3">
        <p className="text-[13px] text-[var(--text-primary)]">Lab hosts for Casper</p>
        <p className="text-[11px] text-[var(--text-muted)]">
          Saves the address of every host tagged "lab" for Casper's /lab import. Casper matches by address. No names, logins or passwords.
        </p>
        <div className="mt-2.5 flex flex-wrap gap-1.5">
          <button
            onClick={exportLab}
            disabled={labBusy}
            className="flex items-center gap-1.5 px-3 h-8 text-[12px] rounded-md bg-[var(--bg-tertiary)] hover:bg-[var(--border-strong)] text-[var(--text-primary)] transition-colors disabled:opacity-50"
          >
            <FlaskConical size={13} />
            Export lab hosts for Casper…
          </button>
        </div>
        {labDone && (
          <div role="status" className="mt-2.5 space-y-1.5 text-[11px] text-[var(--text-secondary)] leading-relaxed">
            <div className="flex items-center gap-2">
              <p className="min-w-0 flex-1 break-all">
                In Casper, type: <code className="text-[var(--accent)]">{labDone.command}</code>
              </p>
              <button
                onClick={() => copyLabCommand(labDone.command)}
                className="px-2 h-6 text-[11px] rounded-md bg-[var(--bg-tertiary)] hover:bg-[var(--border-strong)] text-[var(--text-primary)]"
              >
                Copy
              </button>
            </div>
            <p className="break-all">
              Saved ({labDone.hosts.length}): {labDone.hosts.join(', ')}
            </p>
            {labDone.shortNames.map((name) => (
              <p key={name}>
                {name} is a one-word name: Casper treats any inventory host named {name} as lab.
              </p>
            ))}
            {labDone.skipped.length > 0 && (
              <>
                <p>Left out:</p>
                <ul className="list-disc pl-4">
                  {labDone.skipped.map((s, i) => (
                    <li key={i}>
                      {s.name}: {s.reason}
                    </li>
                  ))}
                </ul>
              </>
            )}
            <div className="flex justify-end">
              <button
                onClick={() => setLabDone(null)}
                className="px-3 h-7 text-[11px] rounded-md bg-[var(--bg-tertiary)] hover:bg-[var(--border-strong)] text-[var(--text-primary)]"
              >
                Done
              </button>
            </div>
          </div>
        )}
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
