import { useState, useRef, useEffect } from 'react';

/**
 * Shared drag-resize logic for side panels. Right-side panels (ConfigEditor,
 * ApiExplorer, AiAssistant) drag their LEFT edge; the session Sidebar drags its
 * RIGHT edge. Returns the current panel width, a CSS class for the drag handle,
 * and a mousedown handler to attach to the handle.
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
    dragging ? 'bg-[#58a6ff]' : 'bg-transparent hover:bg-[#58a6ff60]'
  }`;

  return { width, dragging, onDragStart, handleClass };
}
