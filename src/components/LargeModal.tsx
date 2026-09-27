import { useId, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import { X, Search, ChevronRight, type LucideIcon } from 'lucide-react';

// The large two-pane modal shared by Help and Settings: a header, a searchable
// rail of topics/sections on the left, content on the right. One frame, so
// the app's big modals look and behave alike.

interface LargeModalProps {
  title: string;
  icon: LucideIcon;
  onClose: () => void;
  /** Buttons shown before the close button (e.g. Help's "Ask the AI"). */
  actions?: ReactNode;
  children: ReactNode;
}

export default function LargeModal({ title, icon: Icon, onClose, actions, children }: LargeModalProps) {
  const titleId = useId();
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center modal-backdrop animate-fade-in"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="surface-elevated w-[840px] max-w-[95vw] h-[82vh] flex flex-col animate-scale-in"
      >
        <div className="flex items-center gap-2.5 px-5 py-4 border-b border-[var(--border)]">
          <div className="flex items-center justify-center w-7 h-7 rounded-md" style={{ background: 'var(--accent-soft)' }}>
            <Icon size={15} style={{ color: 'var(--accent)' }} />
          </div>
          <h2 id={titleId} className="text-[16px] font-semibold text-[var(--text-primary)]">
            {title}
          </h2>
          <span className="flex-1" />
          {actions}
          <button
            onClick={onClose}
            aria-label={`Close ${title}`}
            className="p-1.5 rounded-md text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]"
          >
            <X size={18} />
          </button>
        </div>
        <div className="flex flex-1 min-h-0">{children}</div>
      </div>
    </div>
  );
}

interface ModalRailProps {
  query: string;
  onQueryChange: (q: string) => void;
  placeholder: string;
  inputRef?: RefObject<HTMLInputElement>;
  /** Accessible name of the list below the search box. */
  listLabel: string;
  children: ReactNode;
}

/** Left rail: a search box over a scrolling list of RailItems. */
export function ModalRail({ query, onQueryChange, placeholder, inputRef, listLabel, children }: ModalRailProps) {
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    // First Escape clears the search; the next one closes the modal.
    if (e.key === 'Escape' && query) {
      e.stopPropagation();
      onQueryChange('');
    }
  };
  return (
    <div className="w-[260px] flex-shrink-0 border-r border-[var(--border)] flex flex-col">
      <div className="p-2.5">
        <div className="relative">
          <Search
            size={14}
            className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--text-muted)] pointer-events-none"
          />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={placeholder}
            aria-label={placeholder.replace(/…$/, '')}
            className="input-field w-full h-8 pl-8 pr-2.5 text-sm"
          />
        </div>
      </div>
      <nav aria-label={listLabel} className="flex-1 overflow-y-auto px-1.5 pb-2">
        {children}
      </nav>
    </div>
  );
}

interface RailItemProps {
  icon: LucideIcon;
  label: string;
  active: boolean;
  onClick: () => void;
  /** Search hits in this item (shown while searching). */
  count?: number;
  /** Nothing in it matches the search. */
  dimmed?: boolean;
}

export function RailItem({ icon: Icon, label, active, onClick, count, dimmed }: RailItemProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
      className={`w-full flex items-center gap-2.5 px-2.5 py-2 rounded-md text-left transition-colors ${
        active ? 'bg-[var(--accent-soft)]' : 'hover:bg-[var(--bg-tertiary)]'
      } ${dimmed ? 'opacity-50' : ''}`}
    >
      <Icon size={15} style={{ color: active ? 'var(--accent)' : 'var(--text-muted)' }} className="flex-shrink-0" />
      <span
        className={`min-w-0 flex-1 text-[13px] truncate ${
          active ? 'text-[var(--text-primary)] font-medium' : 'text-[var(--text-secondary)]'
        }`}
      >
        {label}
      </span>
      {count != null ? (
        <span className="ml-auto flex-shrink-0 min-w-[18px] px-1 rounded-full text-[10px] text-center tabular-nums bg-[var(--bg-tertiary)] text-[var(--text-secondary)]">
          {count}
        </span>
      ) : (
        active && <ChevronRight size={13} className="ml-auto flex-shrink-0 text-[var(--accent)]" />
      )}
    </button>
  );
}
