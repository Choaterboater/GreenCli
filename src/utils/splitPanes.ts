// Split-view pane list helpers (pure; used by sessionStore).
//
// `panes` is every pane's session id in column order. The FOCUSED pane is the
// store's activeSessionId — so Close / Find / snippets / logging / file drop,
// which all act on the active session, follow whichever pane you clicked.
// Moving focus never reorders the columns.

export const MAX_PANES = 4;

/**
 * Show `id` in the focused pane. A session that already has a pane keeps it
 * (focus just moves there). Otherwise it replaces the focused pane's session
 * in place — like the tab strip, where picking a tab shows it where you are
 * working. While the layout still has a free column (fewer than two panes)
 * it takes that column instead.
 */
export function placeInFocusedPane(panes: string[], focusedId: string | null, id: string): string[] {
  if (panes.includes(id)) return panes;
  if (panes.length < 2) return [...panes, id];
  const slot = focusedId ? panes.indexOf(focusedId) : -1;
  if (slot < 0) return panes;
  const next = panes.slice();
  next[slot] = id;
  return next;
}

/**
 * Drop `id` from the layout. When it was the focused pane, focus the pane
 * that slides into its column (or the one before it, for the last column).
 * `focus` is the pane that should be focused afterwards (null = none left).
 */
export function removeFromPanes(
  panes: string[],
  focusedId: string | null,
  id: string,
): { panes: string[]; focus: string | null } {
  const idx = panes.indexOf(id);
  if (idx < 0) return { panes, focus: focusedId };
  const rest = panes.filter((p) => p !== id);
  if (id !== focusedId) return { panes: rest, focus: focusedId };
  return { panes: rest, focus: rest[Math.min(idx, rest.length - 1)] ?? null };
}

/**
 * Put `id` into column `index`. If it already sits in another column the two
 * swap, so a session never shows twice. Returns the new focused id too: the
 * pane keeps focus if it had it.
 */
export function setPaneAt(
  panes: string[],
  focusedId: string | null,
  index: number,
  id: string,
): { panes: string[]; focus: string | null } {
  if (index < 0 || index >= panes.length) return { panes, focus: focusedId };
  const next = panes.slice();
  const prev = next[index];
  const other = next.indexOf(id);
  if (other >= 0 && other !== index) next[other] = prev;
  next[index] = id;
  return { panes: next, focus: prev === focusedId ? id : focusedId };
}

/** Split view needs two columns; with fewer it falls back to a single terminal. */
export function settleSplit(panes: string[], splitView: boolean): { splitPanes: string[]; splitView: boolean } {
  return panes.length >= 2 ? { splitPanes: panes, splitView } : { splitPanes: [], splitView: false };
}
