import { useCallback, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/tauri';
import {
  X,
  Network,
  Server,
  Loader2,
  RefreshCw,
  Copy,
  Check,
  Layers,
  ChevronRight,
} from 'lucide-react';
import { useSessionStore } from '../store/sessionStore';
import { copyText } from '../utils/clipboard';

// A friendly Apstra blueprint browser: blueprint → spine/leaf nodes → rendered
// Junos config + device context. Uses the apstra_request backend command (the
// controller is configured in Settings → Juniper Apstra).

interface Blueprint {
  id: string;
  label?: string;
  design?: string;
  status?: string;
}

interface ApNode {
  id: string;
  label?: string;
  hostname?: string;
  role?: string;
  system_id?: string;
  deploy_mode?: string;
  management_ip?: string;
  mgmt_ipv4?: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function apstra<T = any>(path: string): Promise<T> {
  const res = await invoke<{ status: number; body: unknown }>('apstra_request', {
    method: 'GET',
    path,
    body: null,
  });
  if (res.status >= 400) throw new Error(`HTTP ${res.status}`);
  return res.body as T;
}

const ROLE_ORDER: Record<string, number> = { superspine: 0, spine: 1, leaf: 2, access: 3 };

export default function ApstraBrowser() {
  const { showApstra, setShowApstra } = useSessionStore();
  const [blueprints, setBlueprints] = useState<Blueprint[]>([]);
  const [bpId, setBpId] = useState<string | null>(null);
  const [nodes, setNodes] = useState<ApNode[]>([]);
  const [nodeId, setNodeId] = useState<string | null>(null);
  const [config, setConfig] = useState('');
  const [loading, setLoading] = useState<'bp' | 'nodes' | 'config' | null>(null);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);

  const loadBlueprints = useCallback(async () => {
    setLoading('bp');
    setError('');
    // Reset selection so a stale node/config isn't left showing after a refresh.
    setBpId(null);
    setNodes([]);
    setNodeId(null);
    setConfig('');
    try {
      const data = await apstra<{ items: Blueprint[] }>('/api/blueprints');
      setBlueprints(data.items || []);
      if (!data.items?.length) setError('No blueprints returned.');
    } catch (e) {
      setError(`Could not list blueprints: ${e}. Configure the controller in Settings → Juniper Apstra.`);
    } finally {
      setLoading(null);
    }
  }, []);

  useEffect(() => {
    if (showApstra) loadBlueprints();
  }, [showApstra, loadBlueprints]);

  const openBlueprint = async (id: string) => {
    setBpId(id);
    setNodes([]);
    setNodeId(null);
    setConfig('');
    setLoading('nodes');
    setError('');
    try {
      const data = await apstra<{ nodes: Record<string, ApNode> }>(
        `/api/blueprints/${id}/nodes?node_type=system`
      );
      const list = Object.values(data.nodes || {})
        .filter((n) => n.role && ROLE_ORDER[n.role] !== undefined)
        .sort(
          (a, b) =>
            (ROLE_ORDER[a.role || ''] ?? 9) - (ROLE_ORDER[b.role || ''] ?? 9) ||
            (a.hostname || a.label || '').localeCompare(b.hostname || b.label || '')
        );
      setNodes(list);
      if (!list.length) setError('No spine/leaf systems found in this blueprint.');
    } catch (e) {
      setError(`Could not load nodes: ${e}`);
    } finally {
      setLoading(null);
    }
  };

  const openNode = async (n: ApNode) => {
    setNodeId(n.id);
    setConfig('');
    setLoading('config');
    setError('');
    try {
      const data = await apstra<{ config?: string }>(
        `/api/blueprints/${bpId}/nodes/${n.id}/config-rendering`
      );
      setConfig(data.config || '(no rendered config returned)');
    } catch (e) {
      setError(`Could not render config: ${e}`);
    } finally {
      setLoading(null);
    }
  };

  const copyConfig = () => {
    copyText(config).then((ok) => {
      if (!ok) return;
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  if (!showApstra) return null;

  const activeBp = blueprints.find((b) => b.id === bpId);
  const activeNode = nodes.find((n) => n.id === nodeId);
  const mgmt = activeNode?.management_ip || activeNode?.mgmt_ipv4;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center modal-backdrop animate-fade-in"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) setShowApstra(false);
      }}
    >
      <div className="surface-elevated w-[1000px] max-w-[96vw] h-[84vh] flex flex-col animate-scale-in">
        {/* Header */}
        <div className="flex items-center gap-2.5 px-5 py-4 border-b border-[var(--border)]">
          <div className="flex items-center justify-center w-7 h-7 rounded-md" style={{ background: 'var(--accent-soft)' }}>
            <Network size={15} style={{ color: 'var(--accent)' }} />
          </div>
          <h2 className="text-[16px] font-semibold text-[var(--text-primary)]">Apstra Blueprints</h2>
          {activeBp && (
            <span className="text-[11px] text-[var(--text-muted)] truncate max-w-[360px]">
              / {activeBp.label || activeBp.id}
            </span>
          )}
          <span className="flex-1" />
          <button onClick={loadBlueprints} className="p-1.5 rounded-md text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]" title="Refresh">
            <RefreshCw size={14} className={loading === 'bp' ? 'animate-spin' : ''} />
          </button>
          <button onClick={() => setShowApstra(false)} className="p-1.5 rounded-md text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]">
            <X size={18} />
          </button>
        </div>

        {error && (
          <div className="px-5 py-2 text-[11px] text-[var(--accent-danger)] bg-[rgba(240,83,63,0.08)] border-b border-[var(--border)]">{error}</div>
        )}

        <div className="flex flex-1 min-h-0">
          {/* Blueprints + nodes rail */}
          <div className="w-[280px] flex-shrink-0 border-r border-[var(--border)] flex flex-col overflow-y-auto">
            <div className="px-3 py-2 text-[10px] uppercase tracking-wider text-[var(--text-muted)] flex items-center gap-1.5">
              <Layers size={11} /> Blueprints
            </div>
            {loading === 'bp' && <div className="px-3 py-2 text-[12px] text-[var(--text-muted)]"><Loader2 size={13} className="animate-spin inline mr-1.5" />loading…</div>}
            {blueprints.map((b) => (
              <div key={b.id}>
                <button
                  onClick={() => openBlueprint(b.id)}
                  className={`w-full flex items-center gap-2 px-3 py-2 text-left text-[13px] transition-colors ${
                    bpId === b.id ? 'bg-[var(--accent-soft)] text-[var(--text-primary)]' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]'
                  }`}
                >
                  <Network size={14} className="flex-shrink-0" style={{ color: bpId === b.id ? 'var(--accent)' : 'var(--text-muted)' }} />
                  <span className="truncate flex-1">{b.label || b.id}</span>
                  <ChevronRight size={13} className={bpId === b.id ? 'text-[var(--accent)]' : 'text-[var(--text-muted)]'} />
                </button>
                {/* nodes under the open blueprint */}
                {bpId === b.id && (
                  <div className="bg-[var(--bg-inset)] border-y border-[var(--border)]">
                    {loading === 'nodes' && <div className="px-3 py-2 text-[12px] text-[var(--text-muted)]"><Loader2 size={12} className="animate-spin inline mr-1.5" />nodes…</div>}
                    {nodes.map((n) => (
                      <button
                        key={n.id}
                        onClick={() => openNode(n)}
                        className={`w-full flex items-center gap-2 pl-7 pr-3 py-1.5 text-left text-[12px] transition-colors ${
                          nodeId === n.id ? 'bg-[var(--accent-soft)] text-[var(--text-primary)]' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]'
                        }`}
                      >
                        <Server size={12} className="flex-shrink-0 text-[var(--text-muted)]" />
                        <span className="truncate flex-1">{n.hostname || n.label || n.id}</span>
                        <span className="text-[9px] px-1 rounded bg-[var(--bg-tertiary)] text-[var(--text-muted)] uppercase">{n.role}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>

          {/* Device context + rendered config */}
          <div className="flex-1 flex flex-col min-w-0">
            {activeNode ? (
              <>
                <div className="px-5 py-3 border-b border-[var(--border)] grid grid-cols-2 gap-x-6 gap-y-1.5 text-[12px]">
                  <Field label="Hostname" value={activeNode.hostname || activeNode.label} />
                  <Field label="Role" value={activeNode.role} />
                  <Field label="Serial (S/N)" value={activeNode.system_id} />
                  <Field label="Deploy mode" value={activeNode.deploy_mode} />
                  {mgmt && <Field label="Management IP" value={mgmt} />}
                  <Field label="OS" value="Junos" />
                </div>
                <div className="flex items-center justify-between px-5 py-2 border-b border-[var(--border)]">
                  <span className="text-[11px] uppercase tracking-wider text-[var(--text-muted)]">Rendered config</span>
                  <button onClick={copyConfig} disabled={!config} className="flex items-center gap-1.5 h-7 px-2.5 text-[11px] rounded-md bg-[var(--bg-tertiary)] hover:bg-[var(--border-strong)] text-[var(--text-primary)] disabled:opacity-40">
                    {copied ? <Check size={12} /> : <Copy size={12} />} {copied ? 'Copied' : 'Copy'}
                  </button>
                </div>
                <div className="flex-1 overflow-auto bg-[var(--bg-primary)]">
                  {loading === 'config' ? (
                    <div className="p-5 text-[12px] text-[var(--text-muted)]"><Loader2 size={13} className="animate-spin inline mr-1.5" />rendering…</div>
                  ) : (
                    <pre className="text-[12px] font-mono text-[var(--text-primary)] whitespace-pre p-4 leading-relaxed">{config}</pre>
                  )}
                </div>
              </>
            ) : (
              <div className="flex-1 flex flex-col items-center justify-center text-center px-6 text-[var(--text-muted)]">
                <Network size={28} className="mb-3 opacity-40" />
                <p className="text-sm text-[var(--text-secondary)]">Select a blueprint, then a node</p>
                <p className="text-[11px] mt-1">See each spine/leaf's rendered Junos config + device context — the Apstra Staged → Physical view, in-app.</p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function Field({ label, value }: { label: string; value?: string }) {
  return (
    <div className="flex items-baseline gap-2 min-w-0">
      <span className="text-[var(--text-muted)] flex-shrink-0">{label}:</span>
      <span className="text-[var(--text-primary)] font-mono truncate">{value || '—'}</span>
    </div>
  );
}
