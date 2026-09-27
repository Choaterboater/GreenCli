import { useState, useRef, useEffect } from 'react';

/**
 * Shared drag-resize logic for side panels. Right-side panels (ConfigEditor,
 * ApiExplorer, AiAssistant) drag their LEFT edge; the session Sidebar drags its
 * RIGHT edge. Returns the current panel width, a CSS class for the drag handle,
 * and a mousedown handler to attach to the handle.
 *
 * The width follows `initial` whenever no drag is in progress, so callers
 * store the committed width (onCommit) and pass it back in. That lets the
 * side panels pass their fitted width, which shrinks when another panel opens
 * or the window narrows.
 */
export function useResizablePanel(
  initial: number,
  min = 280,
  max = 900,
  opts: {
    /** Which edge of the panel carries the drag handle. Default 'left'. */
    edge?: 'left' | 'right';
    /** Called once with the final width when a drag ends (for persistence). */
    onCommit?: (width: number) => void;
  } = {},
) {
  const { edge = 'left', onCommit } = opts;
  const [width, setWidth] = useState(initial);
  const [dragging, setDragging] = useState(false);
  const startX = useRef(0);
  const startW = useRef(0);
  const widthRef = useRef(initial);

  // Skipped mid-drag so a re-fit can't yank the edge out from under the
  // pointer; re-applied when the drag ends (onCommit has updated `initial`).
  useEffect(() => {
    if (dragging) return;
    widthRef.current = initial;
    setWidth(initial);
  }, [initial, dragging]);

  const onDragStart = (e: React.MouseEvent) => {
    setDragging(true);
    startX.current = e.clientX;
    startW.current = width;
    e.preventDefault();
  };

  useEffect(() => {
    if (!dragging) return;
    const move = (e: MouseEvent) => {
      const delta =
        edge === 'left' ? startX.current - e.clientX : e.clientX - startX.current;
      const next = Math.max(min, Math.min(max, startW.current + delta));
      widthRef.current = next;
      setWidth(next);
    };
    const up = () => {
      setDragging(false);
      onCommit?.(widthRef.current);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    return () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
  }, [dragging, min, max, edge, onCommit]);

  const handleClass = `absolute ${edge === 'left' ? 'left-0' : 'right-0'} top-0 bottom-0 w-1 cursor-col-resize z-10 transition-colors ${
    dragging ? 'bg-[var(--accent)]' : 'bg-transparent hover:bg-[var(--accent-ring)]'
  }`;

  return { width, dragging, onDragStart, handleClass };
}
