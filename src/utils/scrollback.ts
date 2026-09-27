// Plain-text export of a terminal's buffer ("Save scrollback…").

/** The slice of xterm's IBuffer this reads (keeps it unit-testable). */
export interface BufferLike {
  length: number;
  getLine(y: number): { isWrapped: boolean; translateToString(trimRight?: boolean): string } | undefined;
}

/**
 * Whole buffer (scrollback + screen) as text. Soft-wrapped rows are joined
 * back into one line — the device printed one line, the terminal just wrapped
 * it — and trailing blank rows (the unused part of the screen) are dropped.
 */
export function bufferToText(buf: BufferLike): string {
  const lines: string[] = [];
  for (let y = 0; y < buf.length; y++) {
    const line = buf.getLine(y);
    if (!line) continue;
    // Keep trailing spaces on a row that continues on the next one: they are
    // part of the text, not padding.
    const continues = buf.getLine(y + 1)?.isWrapped === true;
    const text = line.translateToString(!continues);
    if (line.isWrapped && lines.length > 0) lines[lines.length - 1] += text;
    else lines.push(text);
  }
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
  return lines.join('\n') + (lines.length ? '\n' : '');
}

/** "core-sw1-2026-09-27-1405.txt" — a filesystem-safe default file name. */
export function scrollbackFileName(sessionName: string, now: Date = new Date()): string {
  const safe = sessionName.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'session';
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
  return `${safe}-${stamp}.txt`;
}
