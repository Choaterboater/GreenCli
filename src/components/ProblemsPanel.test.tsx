import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import ProblemsPanel from './ProblemsPanel';
import { buildProblems } from '../utils/configProblems';

const problems = buildProblems('reload\nvlan ${id}\nset vlans a vlan-id 1', 'juniper-junos');

describe('ProblemsPanel', () => {
  it('lists every problem with its place, and counts each kind', () => {
    render(<ProblemsPanel problems={problems} capped={false} disabled={false} onJump={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByText('1 error')).toBeTruthy();
    expect(screen.getByText('1 warning')).toBeTruthy();
    expect(screen.getByText('1 tip')).toBeTruthy();
    expect(screen.getByText('Ln 1, Col 1')).toBeTruthy();
    expect(screen.getByText('Ln 2, Col 6')).toBeTruthy();
    expect(screen.getByText(/Risky: this reboots the switch/)).toBeTruthy();
  });

  it("marks Casper's findings as Casper's, and GreenCLI's without a name", () => {
    const casper = { lineNumber: 2, startColumn: 1, endColumn: 5, severity: 'warning' as const, message: 'VLAN has no name.', code: 'casper', source: 'Casper' };
    render(<ProblemsPanel problems={[...problems, casper]} capped={false} disabled={false} onJump={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByText('Casper:').parentElement?.textContent).toBe('Casper: VLAN has no name.');
    expect(screen.getAllByText('Casper:')).toHaveLength(1);
  });

  it('jumps to a problem when its row is clicked, and stays open', () => {
    const onJump = vi.fn();
    const onClose = vi.fn();
    render(<ProblemsPanel problems={problems} capped={false} disabled={false} onJump={onJump} onClose={onClose} />);
    fireEvent.click(screen.getByText(/Fill in \$\{id\}/));
    expect(onJump).toHaveBeenCalledWith(expect.objectContaining({ lineNumber: 2, code: 'placeholder' }));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('hides a kind when its count is clicked', () => {
    render(<ProblemsPanel problems={problems} capped={false} disabled={false} onJump={vi.fn()} onClose={vi.fn()} />);
    fireEvent.click(screen.getByText('1 warning'));
    expect(screen.queryByText(/Risky: this reboots the switch/)).toBeNull();
    expect(screen.getByText(/Fill in \$\{id\}/)).toBeTruthy();
    fireEvent.click(screen.getByText('1 error'));
    fireEvent.click(screen.getByText('1 tip'));
    expect(screen.getByText('All problems are hidden by the filter above.')).toBeTruthy();
  });

  it('says so when the tab is clean, and when the list was cut', () => {
    const { rerender } = render(<ProblemsPanel problems={[]} capped={false} disabled={false} onJump={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByText('No problems in this tab.')).toBeTruthy();
    rerender(<ProblemsPanel problems={problems} capped disabled={false} onJump={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByText(/Showing the first 500/)).toBeTruthy();
  });

  it("can't jump while a diff is showing", () => {
    const onJump = vi.fn();
    render(<ProblemsPanel problems={problems} capped={false} disabled onJump={onJump} onClose={vi.fn()} />);
    fireEvent.click(screen.getByText(/Fill in \$\{id\}/));
    expect(onJump).not.toHaveBeenCalled();
  });

  it('closes from its X', () => {
    const onClose = vi.fn();
    render(<ProblemsPanel problems={problems} capped={false} disabled={false} onJump={vi.fn()} onClose={onClose} />);
    fireEvent.click(screen.getByLabelText('Close Problems'));
    expect(onClose).toHaveBeenCalled();
  });
});
