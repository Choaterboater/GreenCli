import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/tauri';
import { open as openDialog, save as saveDialog } from '@tauri-apps/api/dialog';
import {
  X,
  Download,
  FileSpreadsheet,
  FolderOpen,
  FileCode,
  Cloud,
  KeyRound,
  Loader2,
  CheckCircle2,
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Settings2,
} from 'lucide-react';
import { useSessionStore } from '../store/sessionStore';
import { useSettingsStore } from '../store/settingsStore';
import { useDialogStore } from '../store/dialogStore';
import { notify } from '../store/toastStore';
import { ConnectionConfig, DEVICE_TYPES, DeviceType, deviceMeta } from '../types';
import { generateId } from '../utils';
import { saveSessionPayload } from '../utils/deviceProfiles';
import { scanSshConfig } from '../utils/sshImport';
import {
  ApiRequest,
  CSV_TEMPLATE,
  FolderMode,
  ImportCandidate,
  ImportParse,
  ImportProblem,
  ImportSource,
  RowStatus,
  SOURCE_FOLDER,
  candidateToConfig,
  fetchCentralHosts,
  fetchMistHosts,
  findFolderId,
  importStatuses,
  parseHostsCsv,
  parseSecureCrtFiles,
  parseSecureCrtXml,
  sshConfigToHosts,
  targetFolder,
} from '../utils/importHosts';

const SOURCES: { id: ImportSource; label: string; icon: typeof Cloud }[] = [
  { id: 'csv', label: 'CSV file', icon: FileSpreadsheet },
  { id: 'securecrt', label: 'SecureCRT', icon: FolderOpen },
  { id: 'central', label: 'Aruba Central', icon: Cloud },
  { id: 'mist', label: 'Juniper Mist', icon: Cloud },
  { id: 'ssh', label: '~/.ssh/config', icon: KeyRound },
];

/** read_securecrt_sessions reply. */
interface SessionScan {
  files: { path: string; text: string }[];
  skipped: string[];
  truncated: boolean;
}

interface Loaded extends ImportParse {
  source: ImportSource;
  /** What was read — a file / folder name or the cloud — for the preview heading. */
  label: string;
}

const baseName = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p;
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

const btn =
  'flex items-center gap-1.5 px-3 h-8 text-[12px] rounded-md bg-[var(--bg-tertiary)] hover:bg-[var(--border-strong)] text-[var(--text-primary)] transition-colors disabled:opacity-50';

/** Where a host points: address[:port] or the serial port and speed. */
function whereText(c: ImportCandidate): string {
  if (c.protocol === 'serial') return `${c.serialPort ?? ''} · ${c.baudRate ?? 9600} baud`;
  return c.host ?? '';
}

interface PreviewTableProps {
  hosts: ImportCandidate[];
  statuses: RowStatus[];
  folders: string[];
  selected: Set<number>;
  onToggle: (i: number) => void;
  onToggleAll: () => void;
}

// Memoized: progress updates during a long import re-render the dialog, and
// re-rendering a few thousand rows each time would stall the save loop.
const PreviewTable = memo(function PreviewTable({ hosts, statuses, folders, selected, onToggle, onToggleAll }: PreviewTableProps) {
  const newCount = statuses.filter((s) => s === 'new').length;
  const allOn = newCount > 0 && selected.size === newCount;
  return (
    <table className="w-full text-[12px] border-collapse">
      <thead className="sticky top-0 z-10 bg-[var(--bg-elevated)]">
        <tr className="text-left text-[10px] uppercase tracking-wider text-[var(--text-muted)]">
          <th className="w-8 px-2 py-1.5">
            <input
              type="checkbox"
              checked={allOn}
              disabled={newCount === 0}
              onChange={onToggleAll}
              className="w-3.5 h-3.5 align-middle"
              title={allOn ? 'Select none' : 'Select all new hosts'}
            />
          </th>
          <th className="px-2 py-1.5 font-semibold">Name</th>
          <th className="px-2 py-1.5 font-semibold">Host</th>
          <th className="px-2 py-1.5 font-semibold">Port</th>
          <th className="px-2 py-1.5 font-semibold">User</th>
          <th className="px-2 py-1.5 font-semibold">Type</th>
          <th className="px-2 py-1.5 font-semibold">Folder</th>
          <th className="px-2 py-1.5 font-semibold">Tags</th>
        </tr>
      </thead>
      <tbody>
        {hosts.map((h, i) => {
          const status = statuses[i];
          const fresh = status === 'new';
          return (
            <tr
              key={i}
              onClick={() => fresh && onToggle(i)}
              className={`border-t border-[var(--border)] ${fresh ? 'cursor-pointer hover:bg-[var(--bg-tertiary)]' : 'opacity-45'}`}
            >
              <td className="px-2 py-1">
                <input
                  type="checkbox"
                  checked={fresh && selected.has(i)}
                  disabled={!fresh}
                  onChange={() => onToggle(i)}
                  onClick={(e) => e.stopPropagation()}
                  className="w-3.5 h-3.5 align-middle"
                />
              </td>
              <td className="px-2 py-1 max-w-[220px]">
                <span className="flex items-center gap-1.5 min-w-0">
                  <span className="truncate text-[var(--text-primary)]" title={h.name}>
                    {h.name}
                  </span>
                  {h.notes.length > 0 && (
                    <span title={h.notes.join('\n')} className="flex-shrink-0">
                      <AlertTriangle size={12} className="text-[var(--accent-warning)]" />
                    </span>
                  )}
                  {status === 'saved' && (
                    <span className="flex-shrink-0 text-[10px] text-[var(--text-muted)]">already saved</span>
                  )}
                  {status === 'duplicate' && (
                    <span className="flex-shrink-0 text-[10px] text-[var(--text-muted)]">listed twice</span>
                  )}
                </span>
              </td>
              <td className="px-2 py-1 font-mono text-[11px] text-[var(--text-secondary)] max-w-[200px] truncate" title={whereText(h)}>
                {whereText(h)}
                {h.protocol === 'telnet' && <span className="ml-1 text-[var(--text-muted)]">(telnet)</span>}
                {h.jumpHost && <span className="ml-1 text-[var(--text-muted)]">⇢ {h.jumpHost}</span>}
              </td>
              <td className="px-2 py-1 font-mono text-[11px] text-[var(--text-secondary)]">
                {h.protocol === 'serial' ? '—' : h.port}
              </td>
              <td className="px-2 py-1 text-[var(--text-secondary)] max-w-[110px] truncate">{h.username ?? ''}</td>
              <td className="px-2 py-1 text-[var(--text-secondary)] whitespace-nowrap" title={deviceMeta(h.deviceType).label}>
                {deviceMeta(h.deviceType).short}
              </td>
              <td className="px-2 py-1 text-[var(--text-secondary)] max-w-[180px] truncate" title={folders[i]}>
                {folders[i]}
              </td>
              <td className="px-2 py-1 text-[var(--text-muted)] max-w-[160px] truncate" title={h.tags.join(', ')}>
                {h.tags.join(', ')}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
});

function ProblemList({ problems, open, onToggle }: { problems: ImportProblem[]; open: boolean; onToggle: () => void }) {
  if (problems.length === 0) return null;
  const shown = problems.slice(0, 300);
  return (
    <div className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--bg-inset)]">
      <button onClick={onToggle} className="flex items-center gap-1.5 w-full px-3 py-2 text-left text-[12px] text-[var(--text-secondary)]">
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        <AlertTriangle size={13} className="text-[var(--accent-warning)]" />
        Not imported — {plural(problems.length, 'note')}
      </button>
      {open && (
        <ul className="px-3 pb-2 max-h-40 overflow-y-auto space-y-0.5">
          {shown.map((p, i) => (
            <li key={i} className="text-[11px] text-[var(--text-secondary)]">
              <span className="font-mono text-[var(--text-muted)]">{p.where}</span> — {p.message}
            </li>
          ))}
          {problems.length > shown.length && (
            <li className="text-[11px] text-[var(--text-muted)]">…and {problems.length - shown.length} more</li>
          )}
        </ul>
      )}
    </div>
  );
}

/**
 * Import hosts from a CSV file, SecureCRT, Aruba Central, Juniper Mist or
 * ~/.ssh/config. Every source lands in the same preview: pick rows (hosts
 * already saved are greyed out), choose folders, import.
 */
export default function ImportHosts() {
  const show = useSessionStore((s) => s.showImportHosts);
  const source = useSessionStore((s) => s.importHostsSource);
  const openImportHosts = useSessionStore((s) => s.openImportHosts);
  const setShow = useSessionStore((s) => s.setShowImportHosts);
  const folders = useSessionStore((s) => s.folders);
  const mistToken = useSettingsStore((s) => s.mistToken);

  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [folderMode, setFolderMode] = useState<FolderMode>('source');
  const [singleFolder, setSingleFolder] = useState('');
  const [includeAps, setIncludeAps] = useState(false);
  const [centralReady, setCentralReady] = useState<boolean | null>(null);
  const [problemsOpen, setProblemsOpen] = useState(false);

  // The preview belongs to the source it was loaded from; other tabs start empty.
  const current = loaded && loaded.source === source ? loaded : null;

  const savedHosts = useMemo(() => folders.flatMap((f) => f.items), [folders]);
  const statuses = useMemo(
    () => (current ? importStatuses(current.hosts, savedHosts) : []),
    [current, savedHosts],
  );
  const rowFolders = useMemo(
    () => (current ? current.hosts.map((h) => targetFolder(h, folderMode, current.source, singleFolder)) : []),
    [current, folderMode, singleFolder],
  );

  const newIndexes = useMemo(() => statuses.flatMap((s, i) => (s === 'new' ? [i] : [])), [statuses]);
  const toggle = useCallback(
    (i: number) =>
      setSelected((prev) => {
        const next = new Set(prev);
        if (next.has(i)) next.delete(i);
        else next.add(i);
        return next;
      }),
    [],
  );
  const toggleAll = useCallback(
    () => setSelected((prev) => (prev.size === newIndexes.length ? new Set() : new Set(newIndexes))),
    [newIndexes],
  );

  useEffect(() => {
    if (!show || source !== 'central') return;
    setCentralReady(null);
    invoke<boolean>('central_is_configured')
      .then((ok) => setCentralReady(!!ok))
      .catch(() => setCentralReady(false));
  }, [show, source]);

  // Close on Escape — unless a confirm dialog is stacked on top, or hosts are
  // being saved (closing mid-import would hide how far it got).
  useEffect(() => {
    if (!show) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || useDialogStore.getState().current || progress) return;
      setShow(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [show, progress, setShow]);

  if (!show) return null;

  const present = (next: Loaded) => {
    setLoaded(next);
    const st = importStatuses(next.hosts, useSessionStore.getState().folders.flatMap((f) => f.items));
    setSelected(new Set(st.flatMap((s, i) => (s === 'new' ? [i] : []))));
    setProblemsOpen(next.hosts.length === 0);
    if (next.hosts.length === 0 && next.problems.length === 0) notify.info('No hosts found', next.label);
  };

  // Run a loader with the busy spinner; its errors become a toast.
  const run = async (label: string, fn: () => Promise<void>) => {
    if (busy || progress) return;
    setBusy(label);
    try {
      await fn();
    } catch (e) {
      notify.error('Import failed', errText(e));
    } finally {
      setBusy(null);
    }
  };

  const loadCsv = () =>
    run('Reading CSV…', async () => {
      const path = await openDialog({
        title: 'Choose a CSV file of hosts',
        filters: [{ name: 'CSV', extensions: ['csv', 'txt'] }],
        multiple: false,
      });
      if (typeof path !== 'string') return;
      const text = await invoke<string>('read_file_text', { path });
      present({ source: 'csv', label: baseName(path), ...parseHostsCsv(text) });
    });

  const saveTemplate = () =>
    run('Saving template…', async () => {
      const path = await saveDialog({
        title: 'Save CSV template',
        defaultPath: 'greencli-hosts.csv',
        filters: [{ name: 'CSV', extensions: ['csv'] }],
      });
      if (!path) return;
      await invoke('write_file_text', { path, contents: CSV_TEMPLATE });
      notify.success('Template saved', path);
    });

  const loadSecureCrtFolder = () =>
    run('Reading SecureCRT sessions…', async () => {
      const start = await invoke<string | null>('securecrt_default_dir').catch(() => null);
      const path = await openDialog({
        title: 'Choose your SecureCRT Sessions folder',
        directory: true,
        multiple: false,
        defaultPath: start ?? undefined,
      });
      if (typeof path !== 'string') return;
      const scan = await invoke<SessionScan>('read_securecrt_sessions', { path });
      const parsed = parseSecureCrtFiles(scan.files);
      const problems = [...parsed.problems, ...scan.skipped.map((s) => ({ where: 'File', message: s }))];
      if (scan.truncated) {
        problems.unshift({ where: 'Folder', message: `Only the first ${scan.files.length} sessions were read.` });
      }
      if (scan.files.length === 0) {
        problems.unshift({
          where: baseName(path),
          message: 'No session files here. Pick the folder named "Sessions" inside SecureCRT\'s Config folder.',
        });
      }
      present({ source: 'securecrt', label: baseName(path), hosts: parsed.hosts, problems });
    });

  const loadSecureCrtXml = () =>
    run('Reading SecureCRT export…', async () => {
      const path = await openDialog({
        title: 'Choose a SecureCRT settings export (XML)',
        filters: [{ name: 'SecureCRT export', extensions: ['xml'] }],
        multiple: false,
      });
      if (typeof path !== 'string') return;
      const text = await invoke<string>('read_file_text', { path });
      present({ source: 'securecrt', label: baseName(path), ...parseSecureCrtXml(text) });
    });

  const loadCentral = () =>
    run('Loading devices from Aruba Central…', async () => {
      const request: ApiRequest = (method, path) => invoke('central_request', { method, path, body: null });
      present({ source: 'central', label: 'Aruba Central', ...(await fetchCentralHosts(request)) });
    });

  const loadMist = (withAps: boolean) =>
    run('Loading devices from Juniper Mist…', async () => {
      const request: ApiRequest = (method, path) => invoke('mist_request', { method, path, body: null });
      present({ source: 'mist', label: 'Juniper Mist', ...(await fetchMistHosts(request, { includeAps: withAps })) });
    });

  const loadSshConfig = () =>
    run('Reading ~/.ssh/config…', async () => {
      present({ source: 'ssh', label: '~/.ssh/config', ...sshConfigToHosts(await scanSshConfig()) });
    });

  const openCloudSettings = (focus: 'central' | 'mist') => {
    const s = useSessionStore.getState();
    s.setShowImportHosts(false);
    s.setSettingsFocus(focus);
    s.setShowSettings(true);
  };

  // SecureCRT and CSV files often have no device type — set it for a batch.
  const setTypeOfSelected = (deviceType: DeviceType) => {
    if (!current) return;
    setLoaded({ ...current, hosts: current.hosts.map((h, i) => (selected.has(i) ? { ...h, deviceType } : h)) });
  };

  const doImport = async () => {
    if (!current || busy || progress) return;
    const chosen = current.hosts
      .map((h, i) => ({ host: h, folder: rowFolders[i] }))
      .filter((_, i) => selected.has(i) && statuses[i] === 'new');
    if (chosen.length === 0) return;
    setProgress({ done: 0, total: chosen.length });

    // Folders first: reuse one with the same name (any case), create each
    // missing one once.
    const folderKey = (name: string) => name.trim().toLowerCase();
    const folderIds = new Map<string, string>();
    const names = [...new Map(chosen.map((c) => [folderKey(c.folder), c.folder])).values()];
    const missing = names.filter((n) => !findFolderId(useSessionStore.getState().folders, n));
    // Many new folders (a SecureCRT tree, Central sites) start collapsed so
    // the sidebar stays scannable.
    const expanded = missing.length <= 3;
    let folderErrors = 0;
    for (const name of names) {
      const existing = findFolderId(useSessionStore.getState().folders, name);
      if (existing) {
        folderIds.set(folderKey(name), existing);
        continue;
      }
      try {
        const id = await invoke<string>('create_folder', { name });
        if (!expanded) await invoke('update_folder', { id, expanded: false }).catch(() => {});
        useSessionStore.getState().addFolder({ id, name, items: [], expanded });
        folderIds.set(folderKey(name), id);
      } catch {
        folderErrors++;
      }
    }

    // Saved one by one through save_session; the sidebar is updated once per
    // folder at the end rather than re-rendering after every host.
    const added = new Map<string, ConnectionConfig[]>();
    let failed = 0;
    let done = 0;
    try {
      for (const { host, folder } of chosen) {
        const folderId = folderIds.get(folderKey(folder));
        const config = candidateToConfig(host, generateId());
        const ok =
          !!folderId &&
          (await invoke('save_session', { config: saveSessionPayload(config), folderId })
            .then(() => true)
            .catch(() => false));
        if (ok && folderId) added.set(folderId, [...(added.get(folderId) ?? []), config]);
        else failed++;
        done++;
        if (done % 25 === 0) setProgress({ done, total: chosen.length });
      }
    } finally {
      const store = useSessionStore.getState();
      for (const [folderId, configs] of added) {
        const folder = store.folders.find((f) => f.id === folderId);
        if (folder) store.updateFolder(folderId, { items: [...folder.items, ...configs] });
      }
      setProgress(null);
    }

    const addedCount = done - failed;
    const alreadySaved = statuses.filter((s) => s === 'saved').length;
    const parts = [`${plural(addedCount, 'host')} added to ${plural(added.size, 'folder')}.`];
    if (alreadySaved > 0) parts.push(`${alreadySaved} already saved, skipped.`);
    if (failed > 0) parts.push(`${failed} could not be saved${folderErrors > 0 ? ' (folder could not be created)' : ''}.`);
    if (failed > 0 && addedCount === 0) notify.error('Import failed', parts.join(' '));
    else notify.success(`Imported from ${current.label}`, parts.join(' '));
    if (addedCount > 0) {
      setLoaded(null);
      setSelected(new Set());
      setShow(false);
    }
  };

  const selectedCount = newIndexes.filter((i) => selected.has(i)).length;
  const savedCount = statuses.filter((s) => s !== 'new').length;
  const folderCount = current ? new Set(newIndexes.filter((i) => selected.has(i)).map((i) => rowFolders[i])).size : 0;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center modal-backdrop animate-fade-in"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !progress) setShow(false);
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Import hosts"
        className="surface-elevated w-[980px] max-w-[96vw] h-[86vh] flex flex-col animate-scale-in"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--border)]">
          <div className="flex items-center gap-2.5">
            <div className="flex items-center justify-center w-7 h-7 rounded-md" style={{ background: 'var(--accent-soft)' }}>
              <Download size={15} style={{ color: 'var(--accent)' }} />
            </div>
            <h2 className="text-[16px] font-semibold text-[var(--text-primary)]">Import hosts</h2>
          </div>
          <button
            onClick={() => setShow(false)}
            disabled={!!progress}
            className="p-1.5 rounded-md hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] disabled:opacity-40"
            title="Close (Esc)"
          >
            <X size={18} />
          </button>
        </div>

        {/* Source picker + what that source needs */}
        <div className="px-5 pt-4 pb-3 space-y-3 border-b border-[var(--border)]">
          <div className="segmented">
            {SOURCES.map(({ id, label, icon: Icon }) => (
              <button key={id} data-active={source === id} onClick={() => openImportHosts(id)} disabled={!!progress}>
                <Icon size={13} />
                {label}
              </button>
            ))}
          </div>

          {source === 'csv' && (
            <div className="flex items-start justify-between gap-4">
              <div className="text-[12px] text-[var(--text-secondary)] space-y-1">
                <p>
                  One host per row. The first row names the columns:{' '}
                  <code className="text-[var(--accent)]">name, host, port, user, type, folder, tags, jump</code>. Only{' '}
                  <code>host</code> is required; separate tags with <code>;</code>. <code>type</code> can be cx, aos-s, aos8,
                  instant, junos, mist or generic. An optional <code>protocol</code> column takes ssh or telnet.
                </p>
                <p className="text-[11px] text-[var(--text-muted)]">
                  There is no password column — passwords are never imported. You&apos;re asked the first time you connect.
                </p>
              </div>
              <div className="flex flex-col gap-1.5 flex-shrink-0">
                <button onClick={loadCsv} disabled={!!busy} className={btn}>
                  <FileSpreadsheet size={13} />
                  Choose CSV file…
                </button>
                <button onClick={saveTemplate} disabled={!!busy} className={btn}>
                  <Download size={13} />
                  Download template CSV
                </button>
              </div>
            </div>
          )}

          {source === 'securecrt' && (
            <div className="flex items-start justify-between gap-4">
              <div className="text-[12px] text-[var(--text-secondary)] space-y-1">
                <p>
                  Choose SecureCRT&apos;s <strong>Sessions</strong> folder. Each session becomes a saved host (SSH, Telnet
                  and Serial) and keeps its folder — nested folders read like &quot;Lab / Core&quot;.
                </p>
                <p className="text-[11px] text-[var(--text-muted)]">
                  macOS: <code>~/Library/Application Support/VanDyke/SecureCRT/Config/Sessions</code> · Windows:{' '}
                  <code>%APPDATA%\VanDyke\Config\Sessions</code> (SecureCRT shows it under Options ▸ Global Options ▸
                  Configuration Paths). Passwords and firewall / jump settings are not imported.
                </p>
              </div>
              <div className="flex flex-col gap-1.5 flex-shrink-0">
                <button onClick={loadSecureCrtFolder} disabled={!!busy} className={btn}>
                  <FolderOpen size={13} />
                  Choose Sessions folder…
                </button>
                <button onClick={loadSecureCrtXml} disabled={!!busy} className={btn} title="File ▸ Export Settings in SecureCRT">
                  <FileCode size={13} />
                  Use an XML export…
                </button>
              </div>
            </div>
          )}

          {source === 'central' &&
            (centralReady === false ? (
              <div className="flex items-center justify-between gap-4 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--bg-inset)] px-3 py-2.5">
                <p className="text-[12px] text-[var(--text-secondary)]">
                  Aruba Central isn&apos;t connected yet. Add your API gateway and token in Settings → Integrations, then come back.
                </p>
                <button onClick={() => openCloudSettings('central')} className={`${btn} flex-shrink-0`}>
                  <Settings2 size={13} />
                  Open Settings → Integrations
                </button>
              </div>
            ) : (
              <div className="flex items-start justify-between gap-4">
                <p className="text-[12px] text-[var(--text-secondary)]">
                  Loads your switches, access points and gateways with their IP addresses. The site becomes the folder;
                  the group and labels become tags. AOS-CX and AOS-S switches are told apart; gateways are saved as
                  controllers. Devices without an IP (offline) are left out.
                </p>
                <button onClick={loadCentral} disabled={!!busy || centralReady === null} className={`${btn} flex-shrink-0`}>
                  <Cloud size={13} />
                  Load devices
                </button>
              </div>
            ))}

          {source === 'mist' &&
            (!mistToken ? (
              <div className="flex items-center justify-between gap-4 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--bg-inset)] px-3 py-2.5">
                <p className="text-[12px] text-[var(--text-secondary)]">
                  Juniper Mist isn&apos;t connected yet. Add your API token in Settings → Integrations, then come back.
                </p>
                <button onClick={() => openCloudSettings('mist')} className={`${btn} flex-shrink-0`}>
                  <Settings2 size={13} />
                  Open Settings → Integrations
                </button>
              </div>
            ) : (
              <div className="flex items-start justify-between gap-4">
                <div className="text-[12px] text-[var(--text-secondary)] space-y-1.5">
                  <p>
                    Loads switches (EX / QFX) and gateways (SRX) from every organization and site your token can see, using
                    each device&apos;s management IP. The site becomes the folder. Devices without an IP are left out.
                  </p>
                  <label className="flex items-center gap-2 cursor-pointer text-[11px]">
                    <input
                      type="checkbox"
                      checked={includeAps}
                      onChange={(e) => {
                        setIncludeAps(e.target.checked);
                        if (current) void loadMist(e.target.checked);
                      }}
                      className="w-3.5 h-3.5"
                    />
                    Include access points (Mist APs have no CLI to log in to)
                  </label>
                </div>
                <button onClick={() => loadMist(includeAps)} disabled={!!busy} className={`${btn} flex-shrink-0`}>
                  <Cloud size={13} />
                  Load devices
                </button>
              </div>
            ))}

          {source === 'ssh' && (
            <div className="flex items-start justify-between gap-4">
              <p className="text-[12px] text-[var(--text-secondary)]">
                Adds the hosts in <code className="text-[var(--accent)]">~/.ssh/config</code> — HostName, User, Port,
                IdentityFile (key file) and ProxyJump. Wildcard entries like <code>Host *</code> are skipped.
              </p>
              <button onClick={loadSshConfig} disabled={!!busy} className={`${btn} flex-shrink-0`}>
                <KeyRound size={13} />
                Read ~/.ssh/config
              </button>
            </div>
          )}
        </div>

        {/* Preview */}
        <div className="flex-1 min-h-0 flex flex-col px-5 py-3 gap-2.5">
          {busy ? (
            <div className="flex-1 flex items-center justify-center gap-2 text-[12px] text-[var(--text-secondary)]">
              <Loader2 size={15} className="animate-spin" />
              {busy}
            </div>
          ) : !current ? (
            <div className="flex-1 flex items-center justify-center text-[12px] text-[var(--text-muted)] text-center px-8">
              Nothing loaded yet. Hosts to add show up here first — nothing is saved until you press Import.
            </div>
          ) : (
            <>
              <div className="flex items-center justify-between gap-3">
                <p className="text-[12px] text-[var(--text-secondary)] truncate">
                  <span className="font-medium text-[var(--text-primary)]">{current.label}</span>
                  {' · '}
                  {plural(current.hosts.length, 'host')}
                  {savedCount > 0 && ` · ${savedCount} already saved`}
                </p>
                {current.hosts.length > 0 && (
                  <select
                    value=""
                    disabled={selectedCount === 0}
                    onChange={(e) => e.target.value && setTypeOfSelected(e.target.value as DeviceType)}
                    className="input-field h-7 px-2 text-[11px] flex-shrink-0"
                    title="Change the device type of the selected hosts"
                  >
                    <option value="">Set type of selected…</option>
                    {DEVICE_TYPES.map((d) => (
                      <option key={d.value} value={d.value}>
                        {d.label}
                      </option>
                    ))}
                  </select>
                )}
              </div>
              {current.hosts.length > 0 && (
                <div className="flex-1 min-h-0 overflow-auto rounded-[var(--radius)] border border-[var(--border)]">
                  <PreviewTable
                    hosts={current.hosts}
                    statuses={statuses}
                    folders={rowFolders}
                    selected={selected}
                    onToggle={toggle}
                    onToggleAll={toggleAll}
                  />
                </div>
              )}
              <ProblemList problems={current.problems} open={problemsOpen} onToggle={() => setProblemsOpen((o) => !o)} />
            </>
          )}
        </div>

        {/* Folder choice + import */}
        <div className="flex items-center justify-between gap-4 px-5 py-3 border-t border-[var(--border)]">
          <div className="flex items-center gap-3 text-[12px] text-[var(--text-secondary)] min-w-0">
            <span className="text-[var(--text-muted)]">Folders:</span>
            <label className="flex items-center gap-1.5 cursor-pointer whitespace-nowrap">
              <input type="radio" checked={folderMode === 'source'} onChange={() => setFolderMode('source')} />
              Keep source folders
            </label>
            <label className="flex items-center gap-1.5 cursor-pointer whitespace-nowrap">
              <input type="radio" checked={folderMode === 'single'} onChange={() => setFolderMode('single')} />
              All in one folder
            </label>
            {folderMode === 'single' && (
              <>
                <input
                  value={singleFolder}
                  onChange={(e) => setSingleFolder(e.target.value)}
                  placeholder={SOURCE_FOLDER[source]}
                  list="import-hosts-folders"
                  className="input-field h-7 px-2 text-[12px] w-44"
                  title="An existing folder, or a new one"
                />
                <datalist id="import-hosts-folders">
                  {folders.map((f) => (
                    <option key={f.id} value={f.name} />
                  ))}
                </datalist>
              </>
            )}
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            {progress && (
              <span className="flex items-center gap-1.5 text-[12px] text-[var(--text-secondary)]">
                <Loader2 size={13} className="animate-spin" />
                Saving {progress.done} / {progress.total}…
              </span>
            )}
            <button
              onClick={() => setShow(false)}
              disabled={!!progress}
              className="px-3.5 h-8 text-[12px] rounded-md text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] disabled:opacity-40"
            >
              Cancel
            </button>
            <button
              onClick={() => void doImport()}
              disabled={selectedCount === 0 || !!busy || !!progress}
              className="btn-accent px-3.5 h-8 text-[12px] flex items-center gap-1.5 disabled:opacity-50"
              title={selectedCount > 0 ? `Into ${plural(folderCount, 'folder')}` : 'Select hosts to import'}
            >
              <CheckCircle2 size={13} />
              Import {selectedCount > 0 ? plural(selectedCount, 'host') : ''}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
