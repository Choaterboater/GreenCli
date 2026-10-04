import { describe, it, expect } from 'vitest';
import { placeMenu } from './menuPlacement';

const rect = (left: number, top: number, width: number, height: number) => ({
  left,
  top,
  right: left + width,
  bottom: top + height,
});
const viewport = { width: 1000, height: 800 };
const menu = { width: 288, height: 80 };

describe('placeMenu', () => {
  it('places the menu below the anchor, aligned to its left edge', () => {
    expect(placeMenu(rect(100, 50, 60, 20), menu, viewport, 'start')).toEqual({
      left: 100,
      top: 74,
      maxHeight: 800 - 74 - 4,
    });
  });

  it('aligns the right edges with align end', () => {
    expect(placeMenu(rect(600, 50, 20, 20), menu, viewport, 'end').left).toBe(620 - 288);
  });

  it('keeps an end-aligned menu on screen when the anchor is far left', () => {
    // The Send chevron wrapped to the panel's left edge: the menu ran off the left.
    expect(placeMenu(rect(20, 300, 20, 20), menu, viewport, 'end').left).toBe(4);
  });

  it('keeps a start-aligned menu on screen when the anchor is near the right', () => {
    const { left } = placeMenu(rect(950, 50, 40, 20), menu, viewport, 'start');
    expect(left).toBe(1000 - 288 - 4);
  });

  it('opens above the anchor when there is more room there', () => {
    const p = placeMenu(rect(100, 700, 60, 20), { width: 200, height: 300 }, viewport, 'start');
    expect(p.top).toBe(700 - 4 - 300);
    expect(p.maxHeight).toBe(700 - 4 - 4);
  });

  it('stays below when it fits there, even near the bottom', () => {
    const p = placeMenu(rect(100, 600, 60, 20), menu, viewport, 'start');
    expect(p.top).toBe(624);
  });

  it('uses the whole window height when there is no room above or below', () => {
    const p = placeMenu(rect(100, 90, 60, 20), { width: 200, height: 300 }, { width: 1000, height: 200 }, 'start');
    expect(p.top).toBe(4);
    expect(p.maxHeight).toBe(200 - 8);
  });

  it('pins a menu wider than the window to the left margin', () => {
    expect(placeMenu(rect(10, 10, 20, 20), menu, { width: 200, height: 800 }, 'end').left).toBe(4);
  });
});
