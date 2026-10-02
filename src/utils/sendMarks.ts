// After a Send, how far each editor line got: the bars the Config Editor draws
// beside the line numbers. Pure, so it is unit-tested; the editor turns each
// mark into a Monaco line decoration.

import type { SendLine, SendResult } from './configSafety';

export type SendMarkState = 'ok' | 'rejected' | 'question' | 'after-error' | 'not-sent';

export interface SendMark {
  lineNumber: number;
  state: SendMarkState;
}

/** The tooltip on each bar. */
export const SEND_MARK_TEXT: Record<SendMarkState, string> = {
  ok: 'Sent. The switch gave no error for this line.',
  rejected: 'The switch rejected this line.',
  question: 'The switch asked a question here. Answer it in the terminal.',
  'after-error': 'Sent after the rejected line, before the error came back. Check it on the switch.',
  'not-sent': 'Not sent: the send stopped before this line.',
};

/** One mark per line that was meant to go out (comments never get one). */
export function sendMarks(lines: readonly SendLine[], result: SendResult): SendMark[] {
  const failed = result.kind === 'device-error' || result.kind === 'question' ? result.failedIndex : -1;
  return lines.map((line, index) => {
    let state: SendMarkState;
    if (index === failed) state = result.kind === 'question' ? 'question' : 'rejected';
    else if (index >= result.sent) state = 'not-sent';
    else if (failed >= 0 && index > failed) state = 'after-error';
    else state = 'ok';
    return { lineNumber: line.lineNumber, state };
  });
}

const SUMMARY_WORDS: Array<[SendMarkState, string]> = [
  ['ok', 'sent'],
  ['rejected', 'rejected'],
  ['question', 'stopped at a question'],
  ['after-error', 'sent after the error'],
  ['not-sent', 'not sent'],
];

/** How many lines ended in each state, in reading order, zeros left out. */
export function sendMarkCounts(marks: readonly SendMark[]): Array<{ state: SendMarkState; count: number; words: string }> {
  return SUMMARY_WORDS.map(([state, words]) => ({ state, words, count: marks.filter((mark) => mark.state === state).length })).filter(
    (entry) => entry.count > 0
  );
}

/** "12 sent · 1 rejected · 3 not sent". */
export function sendMarkSummary(marks: readonly SendMark[]): string {
  return sendMarkCounts(marks)
    .map(({ count, words }) => `${count} ${words}`)
    .join(' · ');
}
