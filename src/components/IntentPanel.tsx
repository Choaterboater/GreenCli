import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/tauri';
import {
  X,
  Target,
  Plus,
  Trash2,
  Play,
  CheckCircle2,
  XCircle,
  HelpCircle,
  Loader2,
  ChevronDown,
  ChevronRight,
  PencilLine,
  LayoutTemplate,
} from 'lucide-react';
import { useSessionStore } from '../store/sessionStore';
import { askConfirm } from '../store/dialogStore';
import { notify } from '../store/toastStore';
import { generateId } from '../utils';
import { Intent, IntentStatus, MatcherKind, evaluateIntent, evaluateAll } from '../utils/intent';
import { INTENT_PACKS, IntentPack } from '../data/intentPacks';

const blank = (): Intent => ({
  id: '',
  name: '',
  kind: 'operational',
  command: '',
  matcher: { kind: 'contains', value: '' },
  severity: 'warning',
  scope: { all: true, tags: [], deviceTypes: [] },
});

const statusMeta: Record<IntentStatus, { icon: typeof CheckCircle2; color: string }> = {
  ok: { icon: CheckCircle2, color: 'var(--accent-success)' },
  violation: { icon: XCircle, color: 'var(--accent-danger)' },
  unknown: { icon: HelpCircle, color: 'var(--text-muted)' },
};

export default function IntentPanel() {
  const { showIntent, setShowIntent, sessions } = useSessionStore();
  const [intents, setIntents] = useState<Intent[]>([]);
  const [form, setForm] = useState<Intent | null>(null);
  const [tagsText, setTagsText] = useState('');
  const [dtText, setDtText] = useState('');
  const [running, setRunning] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [showPacks, setShowPacks] = useState(false);
  // Cancel an in-flight sweep when the panel closes. Closing only makes the
  // component return null (line below) — it's never unmounted — so without a
  // cancel signal the async evaluate loop keeps issuing show-commands on live
  // sessions and still fires completion toasts over a hidden panel.
  const cancelRef = useRef(false);

  const refresh = useCallback(() => {
    invoke<Intent[]>('intent_list')
      .then((loaded) =>
        // Keep a just-computed result if the store copy lacks one (e.g. a persist
        // that silently failed), so refreshing after an unrelated save/delete
        // doesn't drop fresh evaluation results.
        setIntents((prev) => {
          const byId = new Map(prev.map((p) => [p.id, p]));
          return (loaded || []).map((d) =>
            d.lastResult ? d : { ...d, lastResult: byId.get(d.id)?.lastResult }
          );
        })
      )
      .catch(() => setIntents([]));
  }, []);

  useEffect(() => {
    if (showIntent) refresh();
  }, [showIntent, refresh]);

  // One choke point for every close path (backdrop, X button, programmatic).
  useEffect(() => {
    if (!showIntent) cancelRef.current = true;
  }, [showIntent]);

  if (!showIntent) return null;

  const connectedCount = sessions.filter((s) => s.connected && s.config.protocol !== 'local').length;

  const startAdd = () => {
    setForm(blank());
    setTagsText('');
    setDtText('');
  };
  const startEdit = (i: Intent) => {
    setForm(i);
    setTagsText((i.scope.tags || []).join(', '));
    setDtText((i.scope.deviceTypes || []).join(', '));
  };

  const save = async () => {
    if (!form) return;
    if (!form.name.trim() || !form.command.trim() || !form.matcher.value.trim()) {
      notify.warning('Name, command and matcher value are required');
      return;
    }
    // Don't round-trip lastResult through the edit form — undefined is dropped from
    // the IPC payload, so the Rust store keeps the existing result and a rename can't
    // revert a fresh eval.
    const intent: Intent = {
      ...form,
      id: form.id || generateId(),
      lastResult: undefined,
      scope: {
        all: form.scope.all,
        tags: tagsText.split(',').map((t) => t.trim()).filter(Boolean),
        deviceTypes: dtText.split(',').map((t) => t.trim()).filter(Boolean),
      },
    };
    try {
      await invoke('intent_save', { intent });
      setForm(null);
      refresh();
    } catch (e) {
      // Keep the form open with the user's data when the save fails.
      notify.error('Could not save intent', String(e));
    }
  };

  const remove = async (intent: Intent) => {
    // The trash icon sits right next to Edit/Evaluate — confirm before deleting.
    const ok = await askConfirm({
      title: `Delete "${intent.name}"?`,
      message: 'This removes the intent and its last evaluation results.',
      danger: true,
    });
    if (!ok) return;
    await invoke('intent_delete', { id: intent.id }).catch(() => {});
    refresh();
  };

  // Add a curated assurance pack (Juniper Validated Design / Aruba) as editable intents.
  const addPack = async (pack: IntentPack) => {
    for (const t of pack.templates) {
      const intent: Intent = {
        id: generateId(),
        name: t.name,
        kind: t.kind,
        description: t.description,
        command: t.command,
        matcher: t.matcher,
        severity: t.severity,
        scope: { all: pack.deviceTypes.length === 0, tags: [], deviceTypes: [...pack.deviceTypes] },
      };
      await invoke('intent_save', { intent }).catch(() => {});
    }
    setShowPacks(false);
    notify.success(`Added "${pack.name}"`, `${pack.templates.length} intents — review and adjust commands/matchers for your platform.`);
    refresh();
  };

  const runOne = async (intent: Intent) => {
    cancelRef.current = false;
    setRunning(intent.id);
    try {
      const result = await evaluateIntent(intent, sessions, () => cancelRef.current);
      if (!cancelRef.current) setIntents((prev) => prev.map((i) => (i.id === intent.id ? { ...i, lastResult: result } : i)));
    } finally {
      setRunning(null);
    }
  };

  const runAll = async () => {
    if (connectedCount === 0) {
      notify.warning('No connected devices', 'Connect a session to evaluate intents.');
      return;
    }
    cancelRef.current = false;
    setRunning('*');
    try {
      const updated = await evaluateAll(intents, sessions, () => cancelRef.current);
      if (cancelRef.current) return; // panel closed mid-sweep — suppress toast + state write
      setIntents(updated);
      const v = updated.filter((i) => i.lastResult?.status === 'violation').length;
      if (v) notify.warning('Intent violations', `${v} intent${v > 1 ? 's' : ''} not met.`);
      else notify.success('Network compliant', 'All evaluated intents are met.');
    } finally {
      setRunning(null);
    }
  };

  const toggleExp = (id: string) =>
    setExpanded((p) => {
      const n = new Set(p);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const violations = intents.filter((i) => i.lastResult?.status === 'violation').length;
  const inputCls = 'input-field w-full h-9 px-2.5 text-sm';

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center modal-backdrop animate-fade-in"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) setShowIntent(false);
      }}
    >
      <div className="surface-elevated w-[680px] max-w-[95vw] h-[80vh] flex flex-col animate-scale-in">
        {/* Header */}
        <div className="flex items-center gap-2.5 px-5 py-4 border-b border-[var(--border)]">
          <div className="flex items-center justify-center w-7 h-7 rounded-md" style={{ background: 'var(--accent-soft)' }}>
            <Target size={15} style={{ color: 'var(--accent)' }} />
          </div>
          <h2 className="text-[16px] font-semibold text-[var(--text-primary)]">Network Intent</h2>
          {violations > 0 && (
            <span className="text-[11px] px-2 py-0.5 rounded-full" style={{ background: 'rgba(240,83,63,0.14)', color: 'var(--accent-danger)' }}>
              {violations} violation{violations > 1 ? 's' : ''}
            </span>
          )}
          <span className="flex-1" />
          <span className="text-[11px] text-[var(--text-muted)]">{connectedCount} connected</span>
          <button onClick={runAll} disabled={running !== null} className="btn-accent flex items-center gap-1.5 h-8 px-3 text-[12px] disabled:opacity-50">
            {running === '*' ? <Loader2 size={13} className="animate-spin" /> : <Play size={13} />}
            Evaluate all
          </button>
          <button onClick={() => setShowPacks((v) => !v)} className="flex items-center gap-1.5 h-8 px-2.5 text-[12px] rounded-md bg-[var(--bg-tertiary)] hover:bg-[var(--border-strong)] text-[var(--text-primary)]" title="Add a validated-design assurance pack">
            <LayoutTemplate size={13} /> Templates
          </button>
          <button onClick={startAdd} className="flex items-center gap-1.5 h-8 px-2.5 text-[12px] rounded-md bg-[var(--bg-tertiary)] hover:bg-[var(--border-strong)] text-[var(--text-primary)]">
            <Plus size={13} /> Add
          </button>
          <button onClick={() => setShowIntent(false)} className="p-1.5 rounded-md text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]">
            <X size={18} />
          </button>
        </div>

        {/* Assurance pack picker (Juniper Validated Designs + Aruba) */}
        {showPacks && (
          <div className="px-5 py-3 border-b border-[var(--border)] bg-[var(--bg-inset)]">
            <p className="text-[11px] text-[var(--text-muted)] mb-2.5">
              Add a starter set of checks from a validated design. They're editable — adjust commands/matchers for your platform + software.
            </p>
            <div className="space-y-2">
              {INTENT_PACKS.map((pack) => (
                <div key={pack.id} className="flex items-center gap-2.5 px-3 py-2 rounded-md border border-[var(--border)] bg-[var(--bg-secondary)]">
                  <span className="vendor-dot flex-shrink-0" style={{ background: pack.vendor === 'juniper' ? 'var(--vendor-juniper, #84B135)' : 'var(--accent-2, #FF8300)' }} />
                  <div className="min-w-0 flex-1">
                    <div className="text-[13px] font-medium text-[var(--text-primary)] truncate">{pack.name}</div>
                    <div className="text-[10px] text-[var(--text-muted)] truncate">{pack.description} · {pack.templates.length} checks</div>
                  </div>
                  <button onClick={() => addPack(pack)} className="btn-accent h-7 px-3 text-[11px] flex-shrink-0">Add pack</button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Add / edit form */}
        {form && (
          <div className="px-5 py-3 border-b border-[var(--border)] bg-[var(--bg-inset)] space-y-2.5">
            <div className="grid grid-cols-3 gap-2">
              <input className={`${inputCls} col-span-2`} placeholder="Intent name (e.g. Uplinks up)" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
              <div className="segmented w-full">
                <button data-active={form.kind === 'operational'} onClick={() => setForm({ ...form, kind: 'operational' })} className="flex-1 justify-center">Operational</button>
                <button data-active={form.kind === 'config'} onClick={() => setForm({ ...form, kind: 'config' })} className="flex-1 justify-center">Config</button>
              </div>
            </div>
            <input className={`${inputCls} font-mono`} placeholder="Command to run (e.g. show interfaces terse | match ge-0/0/0)" value={form.command} onChange={(e) => setForm({ ...form, command: e.target.value })} />
            <div className="grid grid-cols-3 gap-2">
              <select className={inputCls} value={form.matcher.kind} onChange={(e) => setForm({ ...form, matcher: { ...form.matcher, kind: e.target.value as MatcherKind } })}>
                <option value="contains">output contains</option>
                <option value="notContains">does NOT contain</option>
                <option value="regex">matches regex</option>
                <option value="regexAbsent">does NOT match regex</option>
              </select>
              <input className={`${inputCls} col-span-2 font-mono`} placeholder='expected value, e.g. "up" or "Estab"' value={form.matcher.value} onChange={(e) => setForm({ ...form, matcher: { ...form.matcher, value: e.target.value } })} />
            </div>
            <div className="grid grid-cols-3 gap-2 items-center">
              <select className={inputCls} value={form.severity} onChange={(e) => setForm({ ...form, severity: e.target.value as Intent['severity'] })}>
                <option value="critical">Critical</option>
                <option value="warning">Warning</option>
                <option value="info">Info</option>
              </select>
              <label className="flex items-center gap-2 text-[12px] text-[var(--text-secondary)] cursor-pointer">
                <input type="checkbox" checked={form.scope.all} onChange={(e) => setForm({ ...form, scope: { ...form.scope, all: e.target.checked } })} className="w-4 h-4" />
                All devices
              </label>
              {!form.scope.all && (
                <input className={`${inputCls} font-mono`} placeholder="tags (comma)" value={tagsText} onChange={(e) => setTagsText(e.target.value)} />
              )}
              {!form.scope.all && (
                <input className={`${inputCls} font-mono col-span-3`} placeholder="device types (comma) e.g. juniper-junos, aruba-cx" value={dtText} onChange={(e) => setDtText(e.target.value)} />
              )}
            </div>
            <div className="flex justify-end gap-2">
              <button onClick={() => setForm(null)} className="px-3 h-8 text-[12px] rounded-md text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]">Cancel</button>
              <button onClick={save} className="btn-accent px-4 h-8 text-[12px]">Save intent</button>
            </div>
          </div>
        )}

        {/* Intent list */}
        <div className="flex-1 overflow-y-auto">
          {intents.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-center px-6 text-[var(--text-muted)]">
              <Target size={28} className="mb-3 opacity-40" />
              <p className="text-sm text-[var(--text-secondary)]">No intents yet</p>
              <p className="text-[11px] mt-1">Define the desired state of your network — config that must be present, or operational expectations (links up, BGP established, reachability).</p>
            </div>
          ) : (
            intents.map((i) => {
              const st = i.lastResult?.status || 'unknown';
              const Meta = statusMeta[st].icon;
              const open = expanded.has(i.id);
              return (
                <div key={i.id} className="border-b border-[var(--border)]">
                  <div className="flex items-center gap-2.5 px-5 py-2.5 hover:bg-[var(--bg-tertiary)] transition-colors">
                    <Meta size={16} style={{ color: statusMeta[st].color }} className="flex-shrink-0" />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-[13px] font-medium text-[var(--text-primary)] truncate">{i.name}</span>
                        <span className="text-[9px] px-1 rounded bg-[var(--bg-tertiary)] text-[var(--text-muted)] uppercase">{i.kind}</span>
                        <span className="text-[9px] px-1 rounded" style={{ color: i.severity === 'critical' ? 'var(--accent-danger)' : i.severity === 'warning' ? 'var(--accent-warning)' : 'var(--text-muted)' }}>{i.severity}</span>
                      </div>
                      <div className="text-[10px] text-[var(--text-muted)] font-mono truncate">{i.command}</div>
                      {i.lastResult && <div className="text-[10px]" style={{ color: statusMeta[st].color }}>{i.lastResult.detail}</div>}
                    </div>
                    {i.lastResult?.perDevice?.length ? (
                      <button onClick={() => toggleExp(i.id)} className="p-1 rounded text-[var(--text-muted)] hover:text-[var(--text-primary)]">
                        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                      </button>
                    ) : null}
                    <button onClick={() => runOne(i)} disabled={running !== null} className="p-1 rounded text-[var(--accent)] hover:bg-[var(--bg-tertiary)] disabled:opacity-40" title="Evaluate now">
                      {running === i.id ? <Loader2 size={13} className="animate-spin" /> : <Play size={13} />}
                    </button>
                    <button onClick={() => startEdit(i)} className="p-1 rounded text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]" title="Edit">
                      <PencilLine size={13} />
                    </button>
                    <button onClick={() => remove(i)} className="p-1 rounded text-[var(--text-muted)] hover:text-[var(--accent-danger)] hover:bg-[var(--bg-tertiary)]" title="Delete">
                      <Trash2 size={13} />
                    </button>
                  </div>
                  {open && i.lastResult?.perDevice && (
                    <div className="px-5 pb-2 pl-12 space-y-0.5">
                      {i.lastResult.perDevice.map((d) => {
                        const DM = statusMeta[d.status].icon;
                        return (
                          <div key={d.device} className="flex items-center gap-2 text-[11px]">
                            <DM size={11} style={{ color: statusMeta[d.status].color }} />
                            <span className="text-[var(--text-primary)]">{d.device}</span>
                            <span className="text-[var(--text-muted)]">— {d.detail}</span>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
