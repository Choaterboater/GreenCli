import { describe, it, expect } from 'vitest';
import { fitSidePanels, PANEL_FIT_MIN_WIDTH } from './panelFit';

const p = (key: string, preferred: number) => ({ key, preferred });
const total = (w: Partial<Record<string, number>>) =>
  Object.values(w).reduce<number>((n, x) => n + (x ?? 0), 0);

describe('fitSidePanels', () => {
  it('uses preferred widths when they fit', () => {
    const r = fitSidePanels([p('editor', 520), p('ai', 420)], 1000, true);
    expect(r.widths).toEqual({ editor: 520, ai: 420 });
    expect(r.closed).toEqual([]);
  });

  it('shrinks panels in proportion to fit the space', () => {
    // 1200 px row − 480 terminal = 720 for 520 + 420 = 940 preferred.
    const r = fitSidePanels([p('editor', 520), p('ai', 420)], 720, true);
    expect(r.closed).toEqual([]);
    expect(total(r.widths)).toBeLessThanOrEqual(720);
    expect(r.widths.editor).toBe(Math.floor((520 * 720) / 940));
    expect(r.widths.ai).toBe(Math.floor((420 * 720) / 940));
  });

  it('pins a panel at the floor and shares the rest among the others', () => {
    // Proportional share would put `api` (350) below 320; it stops there.
    const r = fitSidePanels([p('editor', 900), p('api', 350)], 1000, true);
    expect(r.widths.api).toBe(PANEL_FIT_MIN_WIDTH);
    expect(r.widths.editor).toBe(1000 - PANEL_FIT_MIN_WIDTH);
  });

  it('never grows a panel that is already narrower than the floor', () => {
    const r = fitSidePanels([p('api', 250), p('ai', 800)], 700, true);
    expect(r.widths.api).toBe(250);
    expect(r.widths.ai).toBe(450);
  });

  it('closes the least recently opened panel when even the floors do not fit', () => {
    const r = fitSidePanels([p('editor', 520), p('api', 420), p('ai', 420)], 700, true);
    expect(r.closed).toEqual(['editor']);
    expect(Object.keys(r.widths)).toEqual(['api', 'ai']);
    expect(total(r.widths)).toBeLessThanOrEqual(700);
  });

  it('never closes the newest panel, even in a tiny window', () => {
    const r = fitSidePanels([p('editor', 520), p('ai', 420)], 100, true);
    expect(r.closed).toEqual(['editor']);
    expect(r.widths).toEqual({ ai: PANEL_FIT_MIN_WIDTH });
  });

  it('only shrinks to the floors (no closing) when closing is not allowed', () => {
    const r = fitSidePanels([p('editor', 520), p('api', 420), p('ai', 420)], 700, false);
    expect(r.closed).toEqual([]);
    expect(r.widths).toEqual({ editor: 320, api: 320, ai: 320 });
  });

  it('handles no panels and negative space', () => {
    expect(fitSidePanels([], 500, true)).toEqual({ widths: {}, closed: [] });
    expect(fitSidePanels([p('ai', 420)], -200, true).widths).toEqual({ ai: PANEL_FIT_MIN_WIDTH });
  });
});
