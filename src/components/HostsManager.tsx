import { useCallback, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/tauri';
import { Download, Trash2, ShieldCheck, RefreshCw, Loader2, CheckCircle2 } from 'lucide-react';
import { useSessionStore } from '../store/sessionStore';
import { ConnectionConfig } from '../types';
import { generateId } from '../utils';
import { notify } from '../store/toastStore';

interface ImportedHost {
  name: string;
  host: string;
  port: number;
  username?: string;
  identityFile?: string;
  jumpHost?: string;
}

interface KnownHost {
  hostPort: string;
  fingerprint: string;
}

// "user@host:port" -> parts (ssh_config ProxyJump form). IPv6 hosts use the
// bracketed form "[::1]:22" — a bare "2001:db8::1" has no port, and blindly
// splitting on the last ':' would eat its final hextet.
function parseJump(j?: string): { host?: string; user?: string; port?: number } {
  if (!j) return {};
  let rest = j;
  let user: string | undefined;
  const at = rest.indexOf('@');
  if (at >= 0) {
    user = rest.slice(0, at);
    rest = rest.slice(at + 1);
  }
  let port: number | undefined;
  const bracket = rest.match(/^\[([^\]]+)\](?::(\d+))?$/);
  if (bracket) {
    rest = bracket[1];
    const p = Number(bracket[2]);
    if (Number.isInteger(p) && p >= 1 && p <= 65535) port = p;
  } else if (!rest.includes(':') || rest.indexOf(':') === rest.lastIndexOf(':')) {
    // At most one ':' — hostname[:port]. Multiple colons = bare IPv6, no port.
    const colon = rest.lastIndexOf(':');
    if (colon >= 0) {
      const p = Number(rest.slice(colon + 1));
      if (Number.isInteger(p) && p >= 1 && p <= 65535) {
        port = p;
        rest = rest.slice(0, colon);
      }
    }
  }
  return { host: rest, user, port };
}

export default function HostsManager() {
  const { folders, addFolder, addSessionToFolder } = useSessionStore();
  const [imported, setImported] = useState<ImportedHost[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [importing, setImporting] = useState(false);
  const [knownHosts, setKnownHosts] = useState<KnownHost[]>([]);

  const loadKnown = useCallback(() => {
    invoke<KnownHost[]>('list_known_hosts')
      .then((h) => setKnownHosts(h || []))
      .catch(() => setKnownHosts([]));
  }, []);

  useEffect(() => {
    loadKnown();
  }, [loadKnown]);

  const scanConfig = async () => {
    setImporting(true);
    try {
      const hosts = await invoke<ImportedHost[]>('import_ssh_config');
      setImported(hosts);
      setSelected(new Set(hosts.map((h) => h.name)));
      if (hosts.length === 0) notify.info('No hosts found in ~/.ssh/config');
    } catch (e) {
      notify.error('Could not read ~/.ssh/config', String(e));
    } finally {
      setImporting(false);
    }
  };

  const doImport = async () => {
    if (!imported) return;
    const chosen = imported.filter((h) => selected.has(h.name));
    if (chosen.length === 0) return;

    // Put imported hosts in a dedicated folder (created once).
    const folder = folders.find((f) => f.name === 'SSH config');
    let folderId = folder?.id;
    if (!folderId) {
      folderId = await invoke<string>('create_folder', { name: 'SSH config' }).catch(
        () => `folder-${Date.now()}`
      );
      addFolder({ id: folderId, name: 'SSH config', items: [], expanded: true });
    }

    let ok = 0;
    for (const h of chosen) {
      const jump = parseJump(h.jumpHost);
      const cfg: ConnectionConfig = {
        id: generateId(),
        name: h.name,
        protocol: 'ssh',
        host: h.host,
        port: h.port,
        username: h.username,
        authType: h.identityFile ? 'key' : 'password',
        keyPath: h.identityFile,
        deviceType: 'generic',
        jumpHost: jump.host,
        jumpPort: jump.port,
        jumpUsername: jump.user,
      };
      const saved = await invoke('save_session', {
        config: {
          id: cfg.id,
          name: cfg.name,
          protocol: 'ssh',
          host: cfg.host,
          port: cfg.port,
          username: cfg.username,
          auth_type: cfg.authType,
          key_path: cfg.keyPath,
          device_type: 'generic',
          jump_host: cfg.jumpHost,
          jump_port: cfg.jumpPort,
          jump_username: cfg.jumpUsername,
        },
        folderId,
      })
        .then(() => true)
        .catch(() => false);
      if (saved) {
        addSessionToFolder(folderId, cfg);
        ok++;
      }
    }
    setImported(null);
    setSelected(new Set());
    notify.success('Imported from SSH config', `${ok} host${ok === 1 ? '' : 's'} added to "SSH config".`);
  };

  const forget = async (hostPort: string) => {
    await invoke('remove_known_host', { hostPort }).catch(() => {});
    notify.info('Host key forgotten', `${hostPort} will be re-trusted on next connect.`);
    loadKnown();
  };

  const toggle = (name: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });

  return (
    <section>
      <h3 className="text-sm font-semibold text-[var(--text-primary)] mb-3">SSH &amp; Host Keys</h3>

      {/* Import from ~/.ssh/config */}
      <div className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--bg-inset)] p-3 mb-3">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-[13px] text-[var(--text-primary)]">Import from <code className="text-[var(--accent)]">~/.ssh/config</code></p>
            <p className="text-[11px] text-[var(--text-muted)]">Adds your SSH hosts as saved sessions (HostName, User, Port, ProxyJump).</p>
          </div>
          <button
            onClick={scanConfig}
            disabled={importing}
            className="flex items-center gap-1.5 px-3 h-8 text-[12px] rounded-md bg-[var(--bg-tertiary)] hover:bg-[var(--border-strong)] text-[var(--text-primary)] transition-colors disabled:opacity-50"
          >
            {importing ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />}
            Scan
          </button>
        </div>

        {imported && imported.length > 0 && (
          <div className="mt-3 space-y-1">
            <div className="max-h-44 overflow-y-auto space-y-0.5">
              {imported.map((h) => (
                <label key={h.name} className="flex items-center gap-2 px-2 py-1 rounded hover:bg-[var(--bg-tertiary)] cursor-pointer">
                  <input type="checkbox" checked={selected.has(h.name)} onChange={() => toggle(h.name)} className="w-3.5 h-3.5" />
                  <span className="text-[12px] text-[var(--text-primary)] flex-1 truncate">
                    {h.name}
                    <span className="text-[var(--text-muted)] ml-1.5 font-mono text-[10px]">
                      {h.username ? `${h.username}@` : ''}{h.host}{h.port !== 22 ? `:${h.port}` : ''}{h.jumpHost ? ` ⇢ ${h.jumpHost}` : ''}
                    </span>
                  </span>
                </label>
              ))}
            </div>
            <div className="flex justify-end pt-1">
              <button onClick={doImport} className="btn-accent px-3.5 h-8 text-[12px] flex items-center gap-1.5">
                <CheckCircle2 size={13} />
                Import {selected.size}
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
