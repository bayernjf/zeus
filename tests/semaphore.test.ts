import { describe, expect, it } from 'vitest';
import { QueueFullError, Semaphore } from '../src/orchestrator/semaphore.js';

/** Resolve the pending acquire callbacks one microtask at a time. */
async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('E1.5 semaphore', () => {
  it('hands out at most max leases and wakes the oldest waiter on release', async () => {
    const gate = new Semaphore(2);
    const a = await gate.acquire();
    const b = await gate.acquire();
    expect(gate.active).toBe(2);

    let thirdStarted = false;
    const third = gate.acquire().then(release => {
      thirdStarted = true;
      return release;
    });
    await settle();
    expect(thirdStarted).toBe(false);

    a();
    await settle();
    expect(thirdStarted).toBe(true);
    expect(gate.active).toBe(2);
    expect(gate.waiting).toBe(0);
    const c = await third;
    b();
    c();
    expect(gate.active).toBe(0);
  });

  it('serves waiters in FIFO order', async () => {
    const gate = new Semaphore(1);
    const order: string[] = [];
    const held = await gate.acquire();
    // Each waiter hands the slot straight on, so the order is the wake order.
    const waits = ['x', 'y', 'z'].map(name => gate.acquire().then(release => {
      order.push(name);
      release();
    }));
    held();
    await Promise.all(waits);
    expect(order).toEqual(['x', 'y', 'z']);
    expect(gate.active).toBe(0);
  });

  it('releasing the same slot twice does not free extra capacity', async () => {
    const gate = new Semaphore(1);
    const release = await gate.acquire();
    release();
    release();
    expect(gate.active).toBe(0);
    const again = await gate.acquire();
    expect(gate.active).toBe(1);
    again();
  });

  it('refuses immediately once the wait line is full', async () => {
    const gate = new Semaphore(1, 1);
    const held = await gate.acquire();
    const queued = gate.acquire();
    await expect(gate.acquire()).rejects.toBeInstanceOf(QueueFullError);
    await expect(gate.acquire()).rejects.toThrow(/concurrency limit 1 reached with 1 queued/);

    // the queued waiter is unaffected by a refusal and still gets its slot
    held();
    const release = await queued;
    expect(gate.active).toBe(1);
    release();
  });

  it('rejects a nonsensical capacity instead of silently allowing everything', () => {
    expect(() => new Semaphore(0)).toThrow(/whole max/);
    expect(() => new Semaphore(1.5)).toThrow(/whole max/);
    expect(() => new Semaphore(-1)).toThrow(/whole max/);
  });
});
