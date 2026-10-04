import { useCallback, type KeyboardEvent as ReactKeyboardEvent, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { placeMenu, type MenuPlacement } from '../utils/menuPlacement';

// A dropdown for a toolbar button. It is drawn on document.body, so a panel
// with overflow hidden (the side panel, the editor) cannot cut it off, and it
// is placed on screen next to its button (see placeMenu). Focus moves into it
// when it opens (arrows, Home and End move between items), so keys pressed
// with a menu open never reach the terminal. Escape closes it and puts focus
// back on the button. z-40 keeps it under modals (z-50 and up).
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

const menuItems = (panel: HTMLElement) =>
  [...panel.querySelectorAll<HTMLElement>('[role="menuitem"]')].filter((el) => !(el as HTMLButtonElement).disabled);

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

  // Placed before the first paint; see-through until then, so it never jumps.
  // Not visibility:hidden: a browser will not focus anything inside that, so
  // the Language filter (autoFocus) lost focus and its keys went to the device.
  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    place();
  }, [open, place]);

  // Once placed, move focus in, unless something inside already has it (an
  // autoFocus field): the first text field, else the first item, else the panel.
  const placed = !!pos;
  useEffect(() => {
    const panel = panelRef.current;
    if (!open || !placed || !panel || panel.contains(document.activeElement)) return;
    const target =
      panel.querySelector<HTMLElement>('input:not([disabled]), textarea:not([disabled])') ??
      menuItems(panel)[0] ??
      panel;
    target.focus();
  }, [open, placed]);

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

  const onPanelKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const panel = panelRef.current;
    if (!panel) return;
    const inText = e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLInputElement;
    // Text fields keep Home/End, and a textarea keeps its arrows.
    if (e.target instanceof HTMLTextAreaElement) return;
    if (inText && e.key !== 'ArrowDown') return;
    const items = menuItems(panel);
    if (!items.length) return;
    const at = items.indexOf(document.activeElement as HTMLElement);
    let next: number;
    if (e.key === 'ArrowDown') next = at < 0 ? 0 : (at + 1) % items.length;
    else if (e.key === 'ArrowUp') next = at < 0 ? items.length - 1 : (at - 1 + items.length) % items.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = items.length - 1;
    else return;
    e.preventDefault();
    items[next].focus();
  };

  if (!open) return null;
  return createPortal(
    <>
      <div className="fixed inset-0 z-30" onClick={onClose} />
      <div
        ref={panelRef}
        role="menu"
        aria-label={label}
        tabIndex={-1}
        onKeyDown={onPanelKey}
        className={`z-40 overflow-y-auto bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg shadow-xl ${className}`}
        style={{
          position: 'fixed',
          left: pos?.left ?? 0,
          top: pos?.top ?? 0,
          maxHeight: pos?.maxHeight,
          opacity: pos ? undefined : 0,
          pointerEvents: pos ? undefined : 'none',
        }}
      >
        {children}
      </div>
    </>,
    document.body
  );
}
