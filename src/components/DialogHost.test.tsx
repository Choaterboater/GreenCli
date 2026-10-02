import { describe, it, expect, afterEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import DialogHost from './DialogHost';
import { askChoice, askConfirm, askPrompt, cancelDialogs, useDialogStore } from '../store/dialogStore';

afterEach(() => useDialogStore.setState({ current: null, queue: [] }));

describe('DialogHost', () => {
  it('focuses Cancel on danger confirms, so Enter cancels', async () => {
    render(<DialogHost />);
    let result: Promise<boolean> = Promise.resolve(true);
    act(() => {
      result = askConfirm({ title: 'Reset all settings?', confirmLabel: 'Reset', danger: true });
    });
    const cancel = screen.getByRole('button', { name: 'Cancel' });
    await waitFor(() => expect(cancel).toHaveFocus());
    fireEvent.keyDown(cancel, { key: 'Enter' });
    await expect(result).resolves.toBe(false);
  });

  it('still focuses the confirm button on ordinary confirms', async () => {
    render(<DialogHost />);
    let result: Promise<boolean> = Promise.resolve(false);
    act(() => {
      result = askConfirm({ title: 'Send 3 lines?', confirmLabel: 'Send' });
    });
    const send = screen.getByRole('button', { name: 'Send' });
    await waitFor(() => expect(send).toHaveFocus());
    fireEvent.keyDown(send, { key: 'Enter' });
    await expect(result).resolves.toBe(true);
  });

  it('submits a prompt with Enter from the input', async () => {
    render(<DialogHost />);
    let result: Promise<string | null> = Promise.resolve(null);
    act(() => {
      result = askPrompt({ title: 'Rename', defaultValue: 'sw-01' });
    });
    const input = screen.getByRole('textbox');
    await waitFor(() => expect(input).toHaveFocus());
    fireEvent.change(input, { target: { value: 'sw-core-01' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await expect(result).resolves.toBe('sw-core-01');
  });

  it('puts focus back on the dialog if something outside grabs it mid-keypress', async () => {
    const outside = document.createElement('textarea');
    document.body.appendChild(outside);
    // Stand-in for App's capture-phase handler that refocuses the terminal.
    const steal = () => outside.focus();
    window.addEventListener('keydown', steal, true);
    try {
      render(<DialogHost />);
      act(() => {
        void askConfirm({ title: 'Delete "core"?', danger: true });
      });
      const cancel = screen.getByRole('button', { name: 'Cancel' });
      await waitFor(() => expect(cancel).toHaveFocus());
      fireEvent.keyDown(cancel, { key: 'Shift' });
      expect(cancel).toHaveFocus();
    } finally {
      window.removeEventListener('keydown', steal, true);
      outside.remove();
    }
  });

  describe('choice dialogs', () => {
    const choices = [
      { value: 'no', label: 'No', detail: 'Nothing runs', tone: 'plain' as const },
      { value: 'once', label: 'Yes, this once', detail: 'Runs this call only', tone: 'danger' as const },
    ];

    it('focuses No, so Enter runs nothing', async () => {
      render(<DialogHost />);
      let result: Promise<string | null> = Promise.resolve('x');
      act(() => {
        result = askChoice({
          title: 'Run set_ssid on central?',
          notes: ['This tool can change settings'],
          details: JSON.stringify({ ssid: 'guest' }, null, 2),
          detailsLabel: 'Arguments (3 lines, 21 bytes)',
          choices,
        });
      });
      expect(screen.getByText('This tool can change settings')).toBeInTheDocument();
      expect(screen.getByText('Arguments (3 lines, 21 bytes)')).toBeInTheDocument();
      const no = screen.getByRole('button', { name: /^No/ });
      await waitFor(() => expect(no).toHaveFocus());
      fireEvent.keyDown(no, { key: 'Enter' });
      await expect(result).resolves.toBe('no');
    });

    it('resolves the clicked choice', async () => {
      render(<DialogHost />);
      let result: Promise<string | null> = Promise.resolve(null);
      act(() => {
        result = askChoice({ title: 'Run x?', choices });
      });
      fireEvent.click(screen.getByRole('button', { name: /Yes, this once/ }));
      await expect(result).resolves.toBe('once');
    });

    it('resolves null on Escape', async () => {
      render(<DialogHost />);
      let result: Promise<string | null> = Promise.resolve('x');
      act(() => {
        result = askChoice({ title: 'Run x?', choices });
      });
      const no = screen.getByRole('button', { name: /^No/ });
      await waitFor(() => expect(no).toHaveFocus());
      fireEvent.keyDown(no, { key: 'Escape' });
      await expect(result).resolves.toBeNull();
    });

    it('shows text as text, never as HTML', () => {
      render(<DialogHost />);
      act(() => {
        void askChoice({ title: 'Run <b>x</b>?', notes: ['<img src=x onerror=alert(1)>'], choices });
      });
      expect(screen.getByText('Run <b>x</b>?')).toBeInTheDocument();
      expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeInTheDocument();
      expect(document.querySelector('img')).toBeNull();
    });

    it('cancelDialogs settles the AI dialogs and leaves the others', async () => {
      render(<DialogHost />);
      let first: Promise<string | null> = Promise.resolve('x');
      let other: Promise<boolean> = Promise.resolve(true);
      let queued: Promise<boolean> = Promise.resolve(true);
      act(() => {
        first = askChoice({ title: 'Run a?', choices, group: 'ai' });
        other = askConfirm({ title: 'Delete server?', danger: true });
        queued = askConfirm({ title: 'Run on sw1?', group: 'ai' });
      });
      act(() => cancelDialogs('ai'));
      await expect(first).resolves.toBeNull();
      await expect(queued).resolves.toBe(false);
      expect(screen.getByText('Delete server?')).toBeInTheDocument();
      expect(useDialogStore.getState().queue).toHaveLength(0);
      fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
      await expect(other).resolves.toBe(true);
    });
  });
});
