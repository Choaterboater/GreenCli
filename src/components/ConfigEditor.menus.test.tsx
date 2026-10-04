import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import ConfigEditor from './ConfigEditor';
import { useSessionStore } from '../store/sessionStore';
import { useEditorInbox } from '../store/editorInboxStore';
import type { Session } from '../types';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn().mockResolvedValue('') }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn().mockResolvedValue(() => undefined) }));
vi.mock('@monaco-editor/react', () => ({ default: () => null, DiffEditor: () => null }));
vi.mock('../editor/setup', () => ({ setupMonaco: vi.fn() }));

const session: Session = {
  sessionId: 's1',
  connected: true,
  config: { id: 'sw1', name: 'sw1', protocol: 'ssh', host: '10.0.0.1', deviceType: 'aruba-cx' },
};

// jsdom has no layout: give every element the Send menu's real size.
const sizes = { offsetWidth: 288, offsetHeight: 80 } as const;
const saved = new Map<string, PropertyDescriptor | undefined>();

async function renderEditor() {
  render(<ConfigEditor />);
  act(() => {
    useEditorInbox.getState().send({ name: 'vlans', content: 'vlan 10\n  name users\n', language: 'aruba-cx' });
  });
  const send = await screen.findByTitle('Send lines to terminal');
  await waitFor(() => expect((send as HTMLButtonElement).disabled).toBe(false));
}

const triggers: Record<string, () => HTMLElement> = {
  language: () => screen.getByTitle('Change language mode'),
  templates: () => screen.getByRole('button', { name: /^Templates/ }),
  snippets: () => screen.getByTitle('Insert common network config snippets'),
  pull: () => screen.getByLabelText('Pull other command output'),
  diff: () => screen.getByTitle('Compare the editor with what you pulled, or with a file'),
  ask: () => screen.getByTitle('Ask the AI about this tab'),
  send: () => screen.getByLabelText('More ways to send'),
};

describe('ConfigEditor toolbar menus', () => {
  beforeAll(() => {
    Element.prototype.scrollIntoView ??= vi.fn();
    for (const [key, value] of Object.entries(sizes)) {
      saved.set(key, Object.getOwnPropertyDescriptor(HTMLElement.prototype, key));
      Object.defineProperty(HTMLElement.prototype, key, { configurable: true, get: () => value });
    }
  });

  afterAll(() => {
    for (const [key, desc] of saved) if (desc) Object.defineProperty(HTMLElement.prototype, key, desc);
  });

  beforeEach(() => {
    useSessionStore.setState({ showConfigEditor: true, sessions: [session], activeSessionId: 's1' });
    useEditorInbox.setState({ pending: [] });
  });

  it('opens the Send menu fully on screen, outside the clipped editor panel', async () => {
    await renderEditor();
    const chevron = triggers.send();
    vi.spyOn(chevron, 'getBoundingClientRect').mockReturnValue({
      left: 20, right: 40, top: 300, bottom: 320, width: 20, height: 20, x: 20, y: 300, toJSON: () => ({}),
    } as DOMRect);
    expect(chevron.getAttribute('aria-haspopup')).toBe('menu');
    expect(chevron.getAttribute('aria-expanded')).toBe('false');

    fireEvent.click(chevron);
    const menu = screen.getByRole('menu');
    expect(chevron.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('tabpanel', { hidden: true }).contains(menu)).toBe(false);
    expect(menu.style.position).toBe('fixed');
    // Right-aligned to a chevron 40 px from the left, a 288 px menu would start at -248.
    expect(menu.style.left).toBe('4px');
    expect(menu.style.visibility).not.toBe('hidden');
    // Below modals (LargeModal is z-50), above the editor.
    expect(menu.className).toContain('z-40');
    expect(screen.getByRole('menuitem', { name: /Send selected lines/ })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: /Send safely as a Change Job/ })).toBeTruthy();
  });

  it('closes on Escape and puts focus back on the button', async () => {
    await renderEditor();
    fireEvent.click(triggers.send());
    const item = screen.getByRole('menuitem', { name: /Send safely as a Change Job/ });
    item.focus();
    fireEvent.keyDown(item, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(triggers.send());
  });

  it('closes on a click outside', async () => {
    await renderEditor();
    fireEvent.click(triggers.pull());
    const menu = screen.getByRole('menu');
    fireEvent.click(menu.previousElementSibling as HTMLElement);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('opens each toolbar menu outside the panel, and only one at a time', async () => {
    await renderEditor();
    const panel = screen.getByRole('tabpanel', { hidden: true });
    for (const [name, trigger] of Object.entries(triggers)) {
      fireEvent.click(trigger());
      const menus = screen.getAllByRole('menu');
      expect(menus, name).toHaveLength(1);
      expect(panel.contains(menus[0]), name).toBe(false);
      expect(trigger().getAttribute('aria-expanded'), name).toBe('true');
    }
  });

  it('keeps the Language filter focused and working', async () => {
    await renderEditor();
    fireEvent.click(triggers.language());
    const filter = screen.getByPlaceholderText('Filter…');
    expect(document.activeElement).toBe(filter);
    fireEvent.change(filter, { target: { value: 'junos' } });
    const items = screen.getAllByRole('menuitem');
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((b) => /junos/i.test(b.textContent ?? ''))).toBe(true);
    fireEvent.keyDown(filter, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('opens a template in its own tab, in the template\'s language', async () => {
    await renderEditor();
    fireEvent.click(triggers.templates());
    fireEvent.click(screen.getByRole('menuitem', { name: 'Mist/Junos: access switch baseline' }));
    await waitFor(() => expect(triggers.language().textContent).toContain('Juniper Mist / Junos'));
    fireEvent.click(triggers.templates());
    expect(screen.queryByRole('menuitem', { name: /^Aruba:/ })).toBeNull();
    fireEvent.click(screen.getByRole('menuitem', { name: 'AOS-S: VLAN + tagged uplink' }));
    await waitFor(() => expect(triggers.language().textContent).toContain('AOS-S'));
  });

  it('lists the tab\'s vendor first in the Snippets menu', async () => {
    await renderEditor();
    fireEvent.click(triggers.snippets());
    const items = screen.getAllByRole('menuitem');
    expect(items[0].textContent).toMatch(/^AOS-CX:/);
    expect(items.some((b) => /^Junos:/.test(b.textContent ?? ''))).toBe(true);
    expect(screen.getByRole('separator')).toBeTruthy();
  });

  it('removes an open menu when the editor is hidden', async () => {
    await renderEditor();
    fireEvent.click(triggers.snippets());
    expect(screen.getByRole('menu')).toBeTruthy();
    act(() => useSessionStore.setState({ showConfigEditor: false }));
    expect(screen.queryByRole('menu')).toBeNull();
    act(() => useSessionStore.setState({ showConfigEditor: true }));
    expect(screen.queryByRole('menu')).toBeNull();
  });
});
