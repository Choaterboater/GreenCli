import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { placeMenu, type MenuPlacement } from '../utils/menuPlacement';

// A dropdown for a toolbar button. It is drawn on document.body, so a panel
// with overflow hidden (the side panel, the editor) cannot cut it off, and it
// is placed on screen next to its button (see placeMenu). Escape closes it and
// puts focus back on the button. z-40 keeps it under modals (z-50 and up).
// Shown only while `open`: the caller turns it off when its panel hides.

interface ToolbarMenuProps {
  open: boolean;
  anchorRef: RefObject<HTMLElement | null>;
  onClose: () => void;
  /** 'start': left edges line up; 'end': right edges line up. */
  align?: 'start' | 'end';
  /** Width and padding of the menu panel. */
  className?: string;
  label?: string;
  children: ReactNode;
}

const same = (a: MenuPlacement | null, b: MenuPlacement) =>
  !!a && a.left === b.left && a.top === b.top && a.maxHeight === b.maxHeight;

export default function ToolbarMenu({ open, anchorRef, onClose, align = 'start', className = '', label, children }: ToolbarMenuProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<MenuPlacement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const place = useCallback(() => {
    const anchor = anchorRef.current;
    const panel = panelRef.current;
    if (!anchor || !panel) return;
    const next = placeMenu(
      anchor.getBoundingClientRect(),
      { width: panel.offsetWidth, height: Math.max(panel.offsetHeight, panel.scrollHeight) },
      { width: window.innerWidth, height: window.innerHeight },
      align
    );
    setPos((prev) => (same(prev, next) ? prev : next));
  }, [anchorRef, align]);

  // Placed before the first paint; hidden until then, so it never jumps.
  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    place();
  }, [open, place]);

  useEffect(() => {
    if (!open) return;
    const close = () => onCloseRef.current();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      close();
      anchorRef.current?.focus();
    };
    // Scrolling what holds the button moves it away from the menu: close.
    // Scrolls elsewhere (inside the menu, inside Monaco) are left alone.
    const onScroll = (e: Event) => {
      const target = e.target;
      const anchor = anchorRef.current;
      if (target === document || (target instanceof Node && anchor && target.contains(anchor))) close();
    };
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(place);
    if (panelRef.current) observer?.observe(panelRef.current);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', onScroll, true);
    document.addEventListener('keydown', onKey);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', onScroll, true);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, place, anchorRef]);

  if (!open) return null;
  return createPortal(
    <>
      <div className="fixed inset-0 z-30" onClick={onClose} />
      <div
        ref={panelRef}
        role="menu"
        aria-label={label}
        className={`z-40 overflow-y-auto bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg shadow-xl ${className}`}
        style={{
          position: 'fixed',
          left: pos?.left ?? 0,
          top: pos?.top ?? 0,
          maxHeight: pos?.maxHeight,
          visibility: pos ? undefined : 'hidden',
        }}
      >
        {children}
      </div>
    </>,
    document.body
  );
}
