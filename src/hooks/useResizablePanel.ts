import { useState, useRef, useEffect } from 'react';

/**
 * Shared drag-resize logic for the right-side panels (ConfigEditor, ApiExplorer,
 * AiAssistant). Returns the current panel width, a CSS class for the drag handle,
 * and a mousedown handler to attach to the left edge drag handle.
 */
export function useResizablePanel(
  initial: number,
  min = 280,
  max = 900,
) {
  const [width, setWidth] = useState(initial);
  const [dragging, setDragging] = useState(false);
  const startX = useRef(0);
  const startW = useRef(0);

  const onDragStart = (e: React.MouseEvent) => {
    setDragging(true);
    startX.current = e.clientX;
    startW.current = width;
    e.preventDefault();
  };

  useEffect(() => {
    if (!dragging) return;
    const move = (e: MouseEvent) =>
      setWidth(Math.max(min, Math.min(max, startW.current + (startX.current - e.clientX))));
    const up = () => setDragging(false);
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    return () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
  }, [dragging, min, max]);

  const handleClass = `absolute left-0 top-0 bottom-0 w-1 cursor-col-resize z-10 transition-colors ${
    dragging ? 'bg-[#58a6ff]' : 'bg-transparent hover:bg-[#58a6ff60]'
  }`;

  return { width, dragging, onDragStart, handleClass };
}
