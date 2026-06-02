import { useEffect } from 'react';
import { CheckCircle2, XCircle, Info, AlertTriangle, X } from 'lucide-react';
import { useToastStore, Toast, ToastKind } from '../store/toastStore';

const KIND_META: Record<ToastKind, { icon: typeof Info; color: string; ring: string }> = {
  success: { icon: CheckCircle2, color: 'var(--accent-success)', ring: 'rgba(46,206,138,0.35)' },
  error: { icon: XCircle, color: 'var(--accent-danger)', ring: 'rgba(240,83,63,0.35)' },
  info: { icon: Info, color: 'var(--accent-info)', ring: 'rgba(74,168,255,0.35)' },
  warning: { icon: AlertTriangle, color: 'var(--accent-warning)', ring: 'rgba(240,168,60,0.35)' },
};

function ToastCard({ toast }: { toast: Toast }) {
  const dismiss = useToastStore((s) => s.dismiss);
  const meta = KIND_META[toast.kind];
  const Icon = meta.icon;

  useEffect(() => {
    if (!toast.duration) return;
    const t = setTimeout(() => dismiss(toast.id), toast.duration);
    return () => clearTimeout(t);
  }, [toast.id, toast.duration, dismiss]);

  return (
    <div
      className="glass animate-slide-in-right pointer-events-auto flex items-start gap-3 w-[340px] rounded-lg p-3 pr-2"
      style={{ boxShadow: `var(--elevation-3), 0 0 0 1px ${meta.ring}` }}
      role="status"
    >
      <Icon size={18} style={{ color: meta.color }} className="mt-0.5 flex-shrink-0" />
      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-semibold text-[var(--text-primary)] leading-tight">
          {toast.title}
        </p>
        {toast.message && (
          <p className="mt-0.5 text-[12px] text-[var(--text-secondary)] break-words leading-snug">
            {toast.message}
          </p>
        )}
      </div>
      <button
        onClick={() => dismiss(toast.id)}
        className="flex-shrink-0 p-1 rounded text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] transition-colors"
        aria-label="Dismiss"
      >
        <X size={14} />
      </button>
    </div>
  );
}

export default function Toaster() {
  const toasts = useToastStore((s) => s.toasts);
  if (toasts.length === 0) return null;
  return (
    <div className="fixed bottom-4 right-4 z-[100] flex flex-col gap-2 pointer-events-none">
      {toasts.map((t) => (
        <ToastCard key={t.id} toast={t} />
      ))}
    </div>
  );
}
