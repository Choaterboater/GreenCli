import { render, screen, fireEvent, act } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createRef } from 'react';
import ToolbarMenu from './ToolbarMenu';

const rect = (left: number, top: number) =>
  ({ left, right: left + 20, top, bottom: top + 20, width: 20, height: 20, x: left, y: top, toJSON: () => ({}) }) as DOMRect;

function setup() {
  const anchorRef = createRef<HTMLButtonElement>();
  const onClose = vi.fn();
  render(
    <div data-testid="holder">
      <button ref={anchorRef}>Open</button>
      <ToolbarMenu open anchorRef={anchorRef} onClose={onClose} label="Things">
        <button role="menuitem">One</button>
      </ToolbarMenu>
    </div>
  );
  return { anchor: anchorRef.current as HTMLButtonElement, onClose, menu: screen.getByRole('menu') };
}

describe('ToolbarMenu', () => {
  afterEach(() => vi.restoreAllMocks());

  it('moves with its button when the window is resized', () => {
    vi.spyOn(HTMLButtonElement.prototype, 'getBoundingClientRect').mockReturnValue(rect(100, 50));
    const { anchor, menu } = setup();
    const before = { left: menu.style.left, top: menu.style.top };
    expect(before).toEqual({ left: '100px', top: expect.any(String) });
    vi.spyOn(anchor, 'getBoundingClientRect').mockReturnValue(rect(300, 200));
    act(() => {
      window.dispatchEvent(new Event('resize'));
    });
    expect(menu.style.left).toBe('300px');
    expect(menu.style.top).not.toBe(before.top);
  });

  it('closes when what holds its button scrolls, not when the menu itself scrolls', () => {
    const { onClose, menu } = setup();
    fireEvent.scroll(menu);
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.scroll(screen.getByTestId('holder'));
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.scroll(document);
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
