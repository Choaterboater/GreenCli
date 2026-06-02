import { useCallback, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/tauri';
import { X, Waypoints, Plus, Trash2, ArrowRight, Globe } from 'lucide-react';
import { useSessionStore } from '../store/sessionStore';
import { notify } from '../store/toastStore';

interface ForwardMeta {
  id: string;
  sessionId: string;
  kind: string;
  localPort: number;
  remoteHost?: string;
  remotePort?: number;
}

export default function TunnelsManager() {
  const { showTunnels, setShowTunnels, sessions, activeSessionId } = useSessionStore();
  const [forwards, setForwards] = useState<ForwardMeta[]>([]);
  const [kind, setKind] = useState<'local' | 'dynamic'>('local');
  const [localPort, setLocalPort] = useState('8080');
  const [remoteHost, setRemoteHost] = useState('');
  const [remotePort, setRemotePort] = useState('80');
  const [busy, setBusy] = useState(false);

  const sshSessions = sessions.filter((s) => s.config.protocol === 'ssh' && s.connected);
  const [sessionId, setSessionId] = useState<string>('');

  const refresh = useCallback(() => {
    invoke<ForwardMeta[]>('ssh_list_forwards')
      .then((f) => setForwards(f || []))
      .catch(() => setForwards([]));
  }, []);

  useEffect(() => {
    if (showTunnels) {
      refresh();
      // Default to the active SSH session.
      const def = sshSessions.find((s) => s.sessionId === activeSessionId) ?? sshSessions[0];
      setSessionId(def?.sessionId ?? '');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showTunnels]);

  if (!showTunnels) return null;

  const add = async () => {
    if (!sessionId) {
      notify.warning('No SSH session', 'Connect an SSH session to open a tunnel.');
      return;
    }
    const lp = Number(localPort);
    if (!lp) {
      notify.warning('Local port required');
      return;
    }
    setBusy(true);
    try {
      await invoke<ForwardMeta>('ssh_start_forward', {
        sessionId,
        kind,
        localPort: lp,
        remoteHost: kind === 'local' ? remoteHost.trim() || null : null,
        remotePort: kind === 'local' ? Number(remotePort) || null : null,
      });
      notify.success(
        'Tunnel started',
        kind === 'local'
          ? `localhost:${lp} → ${remoteHost}:${remotePort}`
          : `SOCKS5 proxy on localhost:${lp}`
      );
      refresh();
    } catch (e) {
      notify.error('Could not start tunnel', String(e));
    } finally {
      setBusy(false);
    }
  };

  const stop = async (id: string) => {
    await invoke('ssh_stop_forward', { id }).catch(() => {});
    refresh();
  };

  const inputCls = 'input-field h-9 px-2.5 text-sm';
  const sessName = (id: string) => {
    const s = sessions.find((x) => x.sessionId === id);
    return s?.config.name || s?.config.host || 'session';
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center modal-backdrop animate-fade-in"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) setShowTunnels(false);
      }}
    >
      <div className="surface-elevated w-[560px] max-w-[94vw] animate-scale-in">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--border)]">
          <div className="flex items-center gap-2.5">
            <div className="flex items-center justify-center w-7 h-7 rounded-md" style={{ background: 'var(--accent-soft)' }}>
              <Waypoints size={15} style={{ color: 'var(--accent)' }} />
            </div>
            <h2 className="text-[16px] font-semibold text-[var(--text-primary)]">SSH Tunnels</h2>
          </div>
          <button onClick={() => setShowTunnels(false)} className="p-1.5 rounded-md hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]">
            <X size={18} />
          </button>
        </div>

        <div className="px-5 py-4 space-y-4">
          {/* New tunnel form */}
          <div className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--bg-inset)] p-3 space-y-3">
            <div className="flex items-center gap-2">
              <div className="segmented">
                <button data-active={kind === 'local'} onClick={() => setKind('local')}>Local (-L)</button>
                <button data-active={kind === 'dynamic'} onClick={() => setKind('dynamic')}>SOCKS (-D)</button>
              </div>
              <select value={sessionId} onChange={(e) => setSessionId(e.target.value)} className={`${inputCls} flex-1`}>
                {sshSessions.length === 0 && <option value="">No connected SSH session</option>}
                {sshSessions.map((s) => (
                  <option key={s.sessionId} value={s.sessionId}>
                    via {s.config.name || s.config.host}
                  </option>
                ))}
              </select>
            </div>

            <div className="flex items-end gap-2">
              <div className="w-28">
                <label className="block text-[10px] uppercase tracking-wide text-[var(--text-secondary)] mb-1">Local port</label>
                <input value={localPort} onChange={(e) => setLocalPort(e.target.value)} className={`${inputCls} w-full font-mono`} placeholder="8080" />
              </div>
              {kind === 'local' && (
                <>
                  <ArrowRight size={16} className="text-[var(--text-muted)] mb-2.5" />
                  <div className="flex-1">
                    <label className="block text-[10px] uppercase tracking-wide text-[var(--text-secondary)] mb-1">Remote host</label>
                    <input value={remoteHost} onChange={(e) => setRemoteHost(e.target.value)} className={`${inputCls} w-full font-mono`} placeholder="10.0.0.5" />
                  </div>
                  <div className="w-24">
                    <label className="block text-[10px] uppercase tracking-wide text-[var(--text-secondary)] mb-1">Port</label>
                    <input value={remotePort} onChange={(e) => setRemotePort(e.target.value)} className={`${inputCls} w-full font-mono`} placeholder="80" />
                  </div>
                </>
              )}
              <button onClick={add} disabled={busy} className="btn-accent h-9 px-3.5 text-sm flex items-center gap-1.5 disabled:opacity-50">
                <Plus size={14} />
                Open
              </button>
            </div>
            <p className="text-[10px] text-[var(--text-muted)]">
              {kind === 'local'
                ? 'Forward a local port to a host reachable from the SSH server (e.g. an internal web UI).'
                : 'Run a SOCKS5 proxy on the local port — point a browser at it to reach anything the SSH server can.'}
            </p>
          </div>

          {/* Active tunnels */}
          <div>
            <p className="text-[12px] font-medium text-[var(--text-secondary)] mb-1.5">Active tunnels ({forwards.length})</p>
            <div className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--bg-inset)] divide-y divide-[var(--border)] max-h-52 overflow-y-auto">
              {forwards.length === 0 ? (
                <div className="px-3 py-3 text-[11px] text-[var(--text-muted)] text-center">No active tunnels.</div>
              ) : (
                forwards.map((f) => (
                  <div key={f.id} className="flex items-center gap-2 px-3 py-2">
                    <Globe size={14} className="text-[var(--accent)] flex-shrink-0" />
                    <div className="min-w-0 flex-1">
                      <p className="text-[12px] text-[var(--text-primary)] font-mono truncate">
                        {f.kind === 'local'
                          ? `localhost:${f.localPort} → ${f.remoteHost}:${f.remotePort}`
                          : `SOCKS5 localhost:${f.localPort}`}
                      </p>
                      <p className="text-[10px] text-[var(--text-muted)] truncate">via {sessName(f.sessionId)}</p>
                    </div>
                    <button onClick={() => stop(f.id)} className="p-1 rounded text-[var(--text-muted)] hover:text-[var(--accent-danger)] hover:bg-[var(--bg-tertiary)]" title="Stop tunnel">
                      <Trash2 size={13} />
                    </button>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
