import { describe, it, expect } from 'vitest';
import {
  collectPriorStatuses,
  newViolations,
  driftWebhookPayload,
} from './intentScheduler';
import { Intent } from './intent';

const intent = (id: string, name: string, status?: 'ok' | 'violation' | 'unknown'): Intent => ({
  id,
  name,
  kind: 'config',
  command: 'show running-config',
  matcher: { kind: 'contains', value: 'x' },
  severity: 'warning',
  scope: { all: true, tags: [], deviceTypes: [] },
  lastResult: status
    ? { status, detail: 'd', at: 1, perDevice: [{ device: 'sw-1', status, detail: 'd' }] }
    : undefined,
});

describe('intentScheduler drift detection', () => {
  it('flags ok -> violation as a new violation', () => {
    const prior = collectPriorStatuses([intent('a', 'A', 'ok')]);
    const updated = [intent('a', 'A', 'violation')];
    expect(newViolations(prior, updated).map((i) => i.id)).toEqual(['a']);
  });

  it('flags unknown -> violation and never-evaluated -> violation', () => {
    const prior = collectPriorStatuses([intent('u', 'U', 'unknown'), intent('n', 'N')]);
    const updated = [intent('u', 'U', 'violation'), intent('n', 'N', 'violation')];
    expect(newViolations(prior, updated).map((i) => i.id).sort()).toEqual(['n', 'u']);
  });

  it('never re-alerts an unchanged violation (violation -> violation)', () => {
    const prior = collectPriorStatuses([intent('a', 'A', 'violation')]);
    const updated = [intent('a', 'A', 'violation')];
    expect(newViolations(prior, updated)).toHaveLength(0);
  });

  it('does not alert recovery (violation -> ok)', () => {
    const prior = collectPriorStatuses([intent('a', 'A', 'violation')]);
    const updated = [intent('a', 'A', 'ok')];
    expect(newViolations(prior, updated)).toHaveLength(0);
  });

  it('recovers then re-violates = a NEW transition, alerts again', () => {
    const prior = collectPriorStatuses([intent('a', 'A', 'ok')]);
    const updated = [intent('a', 'A', 'violation')];
    expect(newViolations(prior, updated)).toHaveLength(1);
  });

  it('reports only the newly-violated subset of a mixed sweep', () => {
    const prior = collectPriorStatuses([
      intent('new', 'New', 'ok'),
      intent('old', 'Old', 'violation'),
      intent('fine', 'Fine', 'ok'),
    ]);
    const updated = [
      intent('new', 'New', 'violation'),
      intent('old', 'Old', 'violation'),
      intent('fine', 'Fine', 'ok'),
    ];
    expect(newViolations(prior, updated).map((i) => i.id)).toEqual(['new']);
  });
});

describe('NW4 webhook payload', () => {
  it('contains exactly the transition set with device detail', () => {
    const v = intent('a', 'A', 'violation');
    const payload = driftWebhookPayload(1234, [v]);
    expect(payload).toEqual({
      event: 'intent.violation',
      at: 1234,
      count: 1,
      violations: [
        {
          id: 'a',
          name: 'A',
          severity: 'warning',
          status: 'violation',
          detail: 'd',
          perDevice: [{ device: 'sw-1', status: 'violation', detail: 'd' }],
        },
      ],
    });
  });
});