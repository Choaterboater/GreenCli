import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import SnippetsMenu from './SnippetsMenu';
import { useSessionStore } from '../store/sessionStore';
import { useSnippetsStore } from '../store/snippetsStore';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn().mockResolvedValue('') }));

// jsdom has no layout: give the menu its real width.
const saved = new Map<string, PropertyDescriptor | undefined>();
const sizes = { offsetWidth: 288, offsetHeight: 200 } as const;

describe('SnippetsMenu', () => {
  beforeAll(() => {
    for (const [key, value] of Object.entries(sizes)) {
      saved.set(key, Object.getOwnPropertyDescriptor(HTMLElement.prototype, key));
      Object.defineProperty(HTMLElement.prototype, key, { configurable: true, get: () => value });
    }
  });

  afterAll(() => {
    for (const [key, desc] of saved) if (desc) Object.defineProperty(HTMLElement.prototype, key, desc);
  });

  beforeEach(() => {
    useSessionStore.setState({ sessions: [], activeSessionId: null });
    useSnippetsStore.setState({ snippets: [{ id: 'a', label: 'PoE', command: 'show power-over-ethernet' }] });
  });

  it('opens on screen outside the tab strip, and Escape closes it', () => {
    const { container } = render(<SnippetsMenu />);
    const button = screen.getByLabelText('Snippets');
    vi.spyOn(button, 'getBoundingClientRect').mockReturnValue({
      left: 10, right: 38, top: 0, bottom: 28, width: 28, height: 28, x: 10, y: 0, toJSON: () => ({}),
    } as DOMRect);
    fireEvent.click(button);
    const menu = screen.getByRole('menu');
    expect(container.contains(menu)).toBe(false);
    expect(menu.style.position).toBe('fixed');
    expect(menu.style.left).toBe('4px');
    expect(menu.className).toContain('z-40');
    expect(screen.getByRole('menuitem', { name: /PoE/ })).toBeTruthy();

    fireEvent.keyDown(menu, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(button);
  });
  it('focuses the first snippet on open, and the New snippet label when that form is still open', () => {
    useSessionStore.setState({
      sessions: [{ sessionId: 's1', connected: true, config: { id: 'sw1', name: 'sw1', protocol: 'ssh', host: '10.0.0.1' } }],
      activeSessionId: 's1',
    } as never);
    render(<SnippetsMenu />);
    const button = screen.getByLabelText('Snippets');
    const hiddenAtFocus: boolean[] = [];
    const realFocus = HTMLElement.prototype.focus;
    const spy = vi.spyOn(HTMLElement.prototype, 'focus').mockImplementation(function (this: HTMLElement, ...args) {
      const menu = this.closest('[role="menu"]') as HTMLElement | null;
      if (menu) hiddenAtFocus.push(menu.style.visibility === 'hidden');
      return realFocus.apply(this, args);
    });
    try {
      fireEvent.click(button);
      expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: /PoE/ }));
      fireEvent.click(screen.getByText(/New snippet/));
      fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'Escape' });
      expect(screen.queryByRole('menu')).toBeNull();
      fireEvent.click(button);
      expect(document.activeElement).toBe(screen.getByPlaceholderText(/^Label/));
      expect(hiddenAtFocus).not.toContain(true);
    } finally {
      spy.mockRestore();
    }
  });
});
