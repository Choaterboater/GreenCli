import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import FolderPane from './FolderPane';
import { MAX_OPEN_BYTES, type FolderListing } from '../utils/folderTree';

const listing: FolderListing = {
  root: '/configs',
  entries: [
    { path: 'core.cfg', isDir: false, size: 100 },
    { path: 'big.log', isDir: false, size: MAX_OPEN_BYTES + 1 },
  ],
  truncated: false,
};

describe('FolderPane', () => {
  it("lets a file that can't open be clicked, so the editor can say why", () => {
    const onOpen = vi.fn();
    render(
      <FolderPane
        listing={listing}
        activePath={null}
        loading={false}
        onOpen={onOpen}
        onPickFolder={() => {}}
        onRefresh={() => {}}
        onClose={() => {}}
      />
    );
    const big = screen.getByTitle('Too big for the editor (over 5 MB)');
    expect(big).toHaveAttribute('aria-disabled', 'true');
    expect(big).not.toBeDisabled();
    fireEvent.click(big);
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ path: 'big.log' }));
    expect(screen.getByTitle('core.cfg')).not.toHaveAttribute('aria-disabled');
  });
});
