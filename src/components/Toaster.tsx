import { useEffect } from 'react';
import { CheckCircle2, XCircle, Info, AlertTriangle, X } from 'lucide-react';
import { useToastStore, Toast, ToastKind } from '../store/toastStore';

const KIND_META: Record<ToastKind, { icon: typeof Info; color: string }> = {
  success: { icon: CheckCircle2, color: 'var(--accent-success)' },
  error: { icon: XCircle, color: 'var(--accent-danger)' },
  info: { icon: Info, color: 'var(--accent-info)' },
  warning: { icon: AlertTriangle, color: 'var(--accent-warning)' },
};

function ToastCard({ toast }: { toast: Toast }) {
  const dismiss = useToastStore((s) => s.dismiss);
  const meta = KIND_META[toast.kind];
  const Icon = meta.icon;

  // bumpedAt restarts the timer when a duplicate folds into this card.
  useEffect(() => {
    if (!toast.duration) return;
    const t = setTimeout(() => dismiss(toast.id), toast.duration);
    return () => clearTimeout(t);
  }, [toast.id, toast.duration, toast.bumpedAt, dismiss]);

  return (
    <div
      className="glass animate-slide-in-right pointer-events-auto flex items-start gap-3 w-[340px] max-w-full rounded-lg p-3 pr-2"
      style={{
        // Ring tinted from the theme token, so light mode gets its darker hues.
        boxShadow: `var(--elevation-3), 0 0 0 1px color-mix(in srgb, ${meta.color} 35%, transparent)`,
      }}
      // Errors interrupt (assertive); everything else is announced politely.
      role={toast.kind === 'error' ? 'alert' : 'status'}
    >
      <Icon size={18} style={{ color: meta.color }} className="mt-0.5 flex-shrink-0" />
      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-semibold text-[var(--text-primary)] leading-tight">
          {toast.title}
          {toast.count > 1 && (
            <span className="ml-1.5 px-1.5 rounded-full text-[11px] font-medium align-middle bg-[var(--bg-tertiary)] text-[var(--text-secondary)]">
              ×{toast.count}
            </span>
          )}
        </p>
        {toast.message && (
          <p className="mt-0.5 text-[12px] text-[var(--text-secondary)] break-words leading-snug">
            {toast.message}
          </p>
        )}
        {toast.action && (
          <button
            onClick={() => {
              // Dismiss first: a throwing action must not strand a sticky card.
              dismiss(toast.id);
              toast.action?.run();
            }}
            className="mt-2 h-7 px-2.5 text-[12px] font-semibold rounded-[var(--radius-sm)] border border-[var(--border-strong)] text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] transition-colors"
          >
            {toast.action.label}
          </button>
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
  // Top-right, just under the 44px (h-11) title bar: bottom-right sat on top of
  // the AI panel's Send button and the status bar. Newest first, nearest the
  // title bar.
  return (
    <div className="fixed top-[52px] right-4 z-[100] flex flex-col gap-2 max-w-[calc(100vw-2rem)] pointer-events-none">
      {[...toasts].reverse().map((t) => (
        <ToastCard key={t.id} toast={t} />
      ))}
    </div>
  );
}
