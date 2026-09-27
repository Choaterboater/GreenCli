import { describe, it, expect, afterEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import DialogHost from './DialogHost';
import { askConfirm, askPrompt, useDialogStore } from '../store/dialogStore';

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
});
