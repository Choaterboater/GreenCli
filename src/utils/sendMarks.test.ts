import { describe, expect, it } from 'vitest';
import { prepareSendLines, type SendResult } from './configSafety';
import { sendMarkSummary, sendMarks } from './sendMarks';

// Five lines go out (the comment never does), on editor lines 1, 2, 4, 5, 6.
const lines = prepareSendLines('vlan 20\n    name users\n! a note\nvlan 30\n    nme voice\n    exit');
const states = (result: SendResult) => sendMarks(lines, result).map((m) => [m.lineNumber, m.state]);

describe('sendMarks', () => {
  it('marks every line sent when the send finished', () => {
    expect(states({ kind: 'done', sent: 5 })).toEqual([
      [1, 'ok'],
      [2, 'ok'],
      [4, 'ok'],
      [5, 'ok'],
      [6, 'ok'],
    ]);
  });

  it('marks the rejected line red, what went out after it amber, and the rest grey', () => {
    // A slow switch answered line 5's error only after line 6 had gone out.
    expect(states({ kind: 'device-error', sent: 5, failedIndex: 3, deviceText: '% Invalid input: nme' })).toEqual([
      [1, 'ok'],
      [2, 'ok'],
      [4, 'ok'],
      [5, 'rejected'],
      [6, 'after-error'],
    ]);
    expect(states({ kind: 'device-error', sent: 2, failedIndex: 1, deviceText: '% Invalid' }).map(([, s]) => s)).toEqual([
      'ok',
      'rejected',
      'not-sent',
      'not-sent',
      'not-sent',
    ]);
  });

  it('marks the line that got a question', () => {
    expect(states({ kind: 'question', sent: 3, failedIndex: 2, deviceText: 'Continue (y/n)?' }).map(([, s]) => s)).toEqual([
      'ok',
      'ok',
      'question',
      'not-sent',
      'not-sent',
    ]);
  });

  it('marks lines after a cancel or a dropped session as not sent', () => {
    expect(states({ kind: 'cancelled', sent: 2 }).map(([, s]) => s)).toEqual(['ok', 'ok', 'not-sent', 'not-sent', 'not-sent']);
    expect(states({ kind: 'send-failed', sent: 0, error: new Error('closed') }).map(([, s]) => s)).toEqual([
      'not-sent',
      'not-sent',
      'not-sent',
      'not-sent',
      'not-sent',
    ]);
  });
});

describe('sendMarkSummary', () => {
  it('counts in plain words, skipping zeros', () => {
    expect(sendMarkSummary(sendMarks(lines, { kind: 'device-error', sent: 5, failedIndex: 3, deviceText: '' }))).toBe(
      '3 sent · 1 rejected · 1 sent after the error'
    );
    expect(sendMarkSummary(sendMarks(lines, { kind: 'done', sent: 5 }))).toBe('5 sent');
  });
});
