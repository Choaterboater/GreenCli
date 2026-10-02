// A link in an AI answer opens in the system browser. A plain click on the
// bare <a> react-markdown makes would load the website in place of GreenCLI.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createEvent, fireEvent, render, screen } from '@testing-library/react';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('../utils/tauri', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../utils/tauri')>()),
  isTauri: true,
}));

import { invoke } from '@tauri-apps/api/core';
import { MessageItem } from './AiAssistant';

function answer(content: string) {
  render(
    <MessageItem msg={{ id: 'm1', role: 'assistant', content, timestamp: 0 }} editTarget={null} />
  );
}

/** Click the link; true when the click was let through to the webview. */
function click(link: HTMLElement): boolean {
  const event = createEvent.click(link, { button: 0 });
  fireEvent(link, event);
  return !event.defaultPrevented;
}

beforeEach(() => {
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockResolvedValue(undefined);
});

describe('links in an AI answer', () => {
  it.each([
    ['a bare URL', 'See https://www.arubanetworks.com/techdocs/ for more.', 'https://www.arubanetworks.com/techdocs/', 'https://www.arubanetworks.com/techdocs/'],
    ['a markdown link', 'See [Juniper docs](https://www.juniper.net/documentation/).', 'Juniper docs', 'https://www.juniper.net/documentation/'],
  ])('%s opens in the browser, not in place of the app', (_name, content, text, url) => {
    answer(content);
    const link = screen.getByRole('link', { name: text });
    expect(click(link)).toBe(false);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith('open_url', { url });
  });

  it('a link that is not a web link stays in the app (open_url says why)', () => {
    answer('Mail <support@example.com>');
    const link = screen.getByRole('link', { name: 'support@example.com' });
    expect(click(link)).toBe(false);
    expect(invoke).toHaveBeenCalledWith('open_url', { url: 'mailto:support@example.com' });
  });

  it("a footnote's link still jumps within the answer", () => {
    answer('Use LACP.[^1]\n\n[^1]: Both ends.');
    const link = screen.getByRole('link', { name: '1' });
    expect(link.getAttribute('href')).toMatch(/^#/);
    expect(click(link)).toBe(true);
    expect(invoke).not.toHaveBeenCalled();
  });
});
