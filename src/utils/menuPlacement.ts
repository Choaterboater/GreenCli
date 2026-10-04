// Where a dropdown menu goes on screen, given its trigger button. Pure, so it
// can be tested without layout. The menu opens below the trigger, flips above
// when there is more room there, and is always kept inside the window; a menu
// taller than the room it gets scrolls (maxHeight).

export interface AnchorRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface MenuPlacement {
  left: number;
  top: number;
  maxHeight: number;
}

/** Below this much room on either side, the menu uses the whole window height. */
const MIN_ROOM = 120;

export function placeMenu(
  anchor: AnchorRect,
  menu: { width: number; height: number },
  viewport: { width: number; height: number },
  align: 'start' | 'end',
  margin = 4
): MenuPlacement {
  const wanted = align === 'end' ? anchor.right - menu.width : anchor.left;
  const left = Math.max(margin, Math.min(wanted, viewport.width - menu.width - margin));

  const below = viewport.height - anchor.bottom - margin * 2;
  const above = anchor.top - margin * 2;
  if (menu.height <= below) return { left, top: anchor.bottom + margin, maxHeight: below };
  if (Math.max(above, below) < Math.min(menu.height, MIN_ROOM)) {
    // No room either way: cover the trigger rather than cut the menu off.
    const maxHeight = Math.max(0, viewport.height - margin * 2);
    const top = Math.max(margin, Math.min(anchor.bottom + margin, viewport.height - margin - Math.min(menu.height, maxHeight)));
    return { left, top, maxHeight };
  }
  if (above > below) {
    return { left, top: anchor.top - margin - Math.min(menu.height, above), maxHeight: above };
  }
  return { left, top: anchor.bottom + margin, maxHeight: below };
}
