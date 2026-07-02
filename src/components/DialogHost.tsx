import { useEffect, useRef, useState } from 'react';
import { useDialogStore } from '../store/dialogStore';

export default function DialogHost() {
  const current = useDialogStore((s) => s.current);
  const close = useDialogStore((s) => s.close);
  const [value, setValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (current) {
      setValue(current.defaultValue ?? '');
      // Focus + select after mount. Confirm dialogs focus the confirm button so
      // Enter/Escape act on the dialog instead of the terminal behind it.
      setTimeout(() => {
        if (current.type === 'prompt') {
          inputRef.current?.focus();
          inputRef.current?.select();
        } else {
          confirmRef.current?.focus();
        }
      }, 30);
    }
  }, [current]);

  if (!current) return null;

  const finish = (result: string | null) => {
    current.resolve(result);
    close();
  };

  const onConfirm = () => {
    if (current.type === 'prompt') {
      // Resolve the value as typed — an empty submit is a deliberate "clear"
      // (e.g. removing a session's tags), distinct from Cancel (null).
      finish(value);
    } else {
      finish('');
    }
  };

  return (
    <div
      className="fixed inset-0 z-[110] flex items-center justify-center modal-backdrop animate-fade-in"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) finish(null);
      }}
    >
      <div
        className="surface-elevated animate-scale-in w-[420px] max-w-[90vw] p-5"
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            // Let a focused button other than confirm (e.g. Cancel) handle Enter natively.
            if (e.target instanceof HTMLButtonElement && e.target !== confirmRef.current) return;
            e.preventDefault();
            e.stopPropagation();
            onConfirm();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            finish(null);
          }
        }}
      >
        <h3 className="text-[15px] font-semibold text-[var(--text-primary)]">{current.title}</h3>
        {current.message && (
          <p className="mt-1.5 text-[13px] text-[var(--text-secondary)] leading-relaxed">
            {current.message}
          </p>
        )}

        {current.type === 'prompt' && (
          <input
            ref={inputRef}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={current.placeholder}
            className="input-field mt-4 w-full h-10 px-3 text-sm"
          />
        )}

        <div className="mt-5 flex items-center justify-end gap-2">
          <button
            onClick={() => finish(null)}
            className="px-3.5 h-9 text-[13px] rounded-[var(--radius)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] transition-colors"
          >
            {current.cancelLabel ?? 'Cancel'}
          </button>
          <button
            ref={confirmRef}
            onClick={onConfirm}
            className="px-4 h-9 text-[13px] font-semibold rounded-[var(--radius)] text-white transition-colors"
            style={{
              background: current.danger ? 'var(--accent-danger)' : 'var(--accent)',
              color: current.danger ? '#fff' : 'var(--accent-fg)',
            }}
          >
            {current.confirmLabel ?? (current.danger ? 'Delete' : 'OK')}
          </button>
        </div>
      </div>
    </div>
  );
}
