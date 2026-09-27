import { describe, it, expect, afterEach, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import Toaster from './Toaster';
import { notify, useToastStore } from '../store/toastStore';

afterEach(() => {
  act(() => useToastStore.getState().clear());
  vi.useRealTimers();
});

describe('Toaster', () => {
  it('announces errors as alerts and the rest as status', () => {
    render(<Toaster />);
    act(() => {
      notify.error('Could not connect', 'timed out');
      notify.success('Saved');
    });
    expect(screen.getByRole('alert')).toHaveTextContent('Could not connect');
    expect(screen.getByRole('status')).toHaveTextContent('Saved');
  });

  it('runs an action and dismisses the card', () => {
    const run = vi.fn();
    render(<Toaster />);
    act(() => {
      notify.error('Session dropped', 'sw-01', { action: { label: 'Reconnect', run } });
    });
    fireEvent.click(screen.getByRole('button', { name: 'Reconnect' }));
    expect(run).toHaveBeenCalledOnce();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('keeps an error with an action until dismissed, but times out plain errors', () => {
    vi.useFakeTimers();
    render(<Toaster />);
    act(() => {
      notify.error('Plain failure');
      notify.error('Session dropped', 'sw-01', { action: { label: 'Reconnect', run: () => {} } });
    });
    act(() => vi.advanceTimersByTime(60_000));
    expect(screen.queryByText('Plain failure')).toBeNull();
    expect(screen.getByText('Session dropped')).toBeInTheDocument();
  });

  it('shows folded duplicates as one card with a count', () => {
    render(<Toaster />);
    act(() => {
      notify.info('Copied');
      notify.info('Copied');
      notify.info('Copied');
    });
    expect(screen.getAllByRole('status')).toHaveLength(1);
    expect(screen.getByText('×3')).toBeInTheDocument();
  });
});
