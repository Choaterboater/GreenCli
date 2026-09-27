// Fitting docked side panels next to the terminal. Written when the Config
// Editor, API Explorer and AI Assistant were three panels that could all be
// open at once, squeezing the terminal to nothing; they are now tabs of one
// panel (sidePanelStore), which uses the same shrink-to-a-floor rule.

/** The terminal (or whatever fills the main area) keeps at least this much. */
export const TERMINAL_MIN_WIDTH = 480;
/** Squeezed panels stop shrinking here (or at their own width, if narrower). */
export const PANEL_FIT_MIN_WIDTH = 320;

export interface FitPanel<K extends string = string> {
  key: K;
  /** The width the user last chose for this panel. */
  preferred: number;
}

export interface FitResult<K extends string = string> {
  widths: Partial<Record<K, number>>;
  /** Panels closed to make room, least recently opened first. */
  closed: K[];
}

/**
 * Fit open panels into `space` (the row width minus the terminal minimum).
 * `panels` is ordered least → most recently opened.
 *
 * If the preferred widths don't fit, shrink every panel in proportion, but
 * none below its floor (PANEL_FIT_MIN_WIDTH, or its preferred width if that is
 * already narrower). If even the floors don't fit and `allowClose` is set,
 * close the least recently opened panels until they do — never the newest,
 * so the panel the user just opened always appears. Without `allowClose`
 * (window resizes) panels bottom out at their floors instead: closing a panel
 * because the window was dragged narrower would be a surprise.
 */
export function fitSidePanels<K extends string>(
  panels: FitPanel<K>[],
  space: number,
  allowClose: boolean,
  floorWidth = PANEL_FIT_MIN_WIDTH,
): FitResult<K> {
  const floorOf = (p: FitPanel<K>) => Math.min(floorWidth, p.preferred);
  const sum = (list: FitPanel<K>[], f: (p: FitPanel<K>) => number) =>
    list.reduce((n, p) => n + f(p), 0);

  let open = panels;
  const closed: K[] = [];
  while (allowClose && open.length > 1 && sum(open, floorOf) > space) {
    closed.push(open[0].key);
    open = open.slice(1);
  }

  const widths: Partial<Record<K, number>> = {};
  if (sum(open, (p) => p.preferred) <= space) {
    for (const p of open) widths[p.key] = p.preferred;
    return { widths, closed };
  }

  // Proportional shrink with floors: a panel whose share would fall below its
  // floor is pinned there, and the rest re-share what is left.
  const pinned = new Set<K>();
  let room = 0;
  let want = 0;
  const share = (p: FitPanel<K>) => (want > 0 ? Math.floor((p.preferred * room) / want) : 0);
  for (;;) {
    const free = open.filter((p) => !pinned.has(p.key));
    room = Math.max(0, space - sum(open.filter((p) => pinned.has(p.key)), floorOf));
    want = sum(free, (p) => p.preferred);
    const newlyPinned = free.filter((p) => share(p) < floorOf(p));
    if (newlyPinned.length === 0) break;
    for (const p of newlyPinned) pinned.add(p.key);
  }
  for (const p of open) widths[p.key] = pinned.has(p.key) ? floorOf(p) : share(p);
  return { widths, closed };
}
