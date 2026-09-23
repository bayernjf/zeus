import { describe, expect, it } from 'vitest';
import { ProgressHub, type ProgressEvent } from '../src/orchestrator/progress.js';

function finished(intentId: string): ProgressEvent {
  return { type: 'intent-finished', intentId, runId: 'run-1', status: 'completed', at: 't' };
}

describe('ProgressHub', () => {
  it('delivers events to matching subscribers only', () => {
    const hub = new ProgressHub();
    const gotA: ProgressEvent[] = [];
    const gotB: ProgressEvent[] = [];
    hub.subscribe('a', e => gotA.push(e));
    hub.subscribe('b', e => gotB.push(e));
    hub.publish(finished('a'));
    expect(gotA).toHaveLength(1);
    expect(gotB).toHaveLength(0);
  });

  it('stops delivering after unsubscribe', () => {
    const hub = new ProgressHub();
    const got: ProgressEvent[] = [];
    const unsubscribe = hub.subscribe('a', e => got.push(e));
    unsubscribe();
    hub.publish(finished('a'));
    expect(got).toHaveLength(0);
  });
});
