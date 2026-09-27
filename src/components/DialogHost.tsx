import { useEffect, useRef, useState } from 'react';
import { useDialogStore } from '../store/dialogStore';

export default function DialogHost() {
  const current = useDialogStore((s) => s.current);
  const close = useDialogStore((s) => s.close);
  const [value, setValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (current) {
      setValue(current.defaultValue ?? '');
      // Focus + select after mount, so Enter/Escape act on the dialog instead
      // of the terminal behind it. Danger confirms (reset, delete, disconnect)
      // focus Cancel: a stray Enter meant for the terminal must not confirm.
      setTimeout(() => {
        if (current.type === 'prompt') {
          inputRef.current?.focus();
          inputRef.current?.select();
        } else if (current.danger) {
          cancelRef.current?.focus();
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
        role="dialog"
        aria-modal="true"
        aria-label={current.title}
        onKeyDown={(e) => {
          // App's capture-phase key handler pulls focus into the terminal on
          // any key that isn't typed into a text field. Put it back, or the
          // next key (Enter after a Shift, say) goes to the device instead.
          if (e.target instanceof HTMLElement && document.activeElement !== e.target) {
            e.target.focus();
          }
          if (e.key === 'Enter') {
            e.preventDefault();
            e.stopPropagation();
            // Enter activates the focused button (Cancel cancels, confirm
            // confirms) — done here, not natively, because the native click
            // follows the (possibly moved) focus. Enter in the prompt submits.
            if (e.target instanceof HTMLButtonElement) e.target.click();
            else onConfirm();
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
            ref={cancelRef}
            onClick={() => finish(null)}
            className="px-3.5 h-9 text-[13px] rounded-[var(--radius)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] transition-colors"
          >
            {current.cancelLabel ?? 'Cancel'}
          </button>
          <button
            ref={confirmRef}
            onClick={onConfirm}
            className="px-4 h-9 text-[13px] font-semibold rounded-[var(--radius)] transition-colors"
            style={{
              background: current.danger ? 'var(--danger-solid)' : 'var(--accent)',
              color: current.danger ? 'var(--danger-solid-fg)' : 'var(--accent-fg)',
            }}
          >
            {current.confirmLabel ?? (current.danger ? 'Delete' : 'OK')}
          </button>
        </div>
      </div>
    </div>
  );
}
