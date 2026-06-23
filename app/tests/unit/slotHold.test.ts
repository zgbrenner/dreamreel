import { describe, it, expect } from 'vitest';
import { pickSwapSlot } from '../../src/dream/slotHold';

describe('pickSwapSlot', () => {
  it('round-robins when nothing is held', () => {
    const held = [0, 0, 0, 0];
    const a = pickSwapSlot(0, held, 5, 4);
    expect(a).toEqual({ slot: 0, nextCursor: 1 });
    const b = pickSwapSlot(a.nextCursor, held, 5, 4);
    expect(b).toEqual({ slot: 1, nextCursor: 2 });
  });

  it('skips a slot whose hold has not expired', () => {
    const held = [10, 0, 0, 0]; // slot 0 held until t=10
    const r = pickSwapSlot(0, held, 5, 4); // clock 5 < 10 -> skip 0
    expect(r.slot).toBe(1);
    expect(r.nextCursor).toBe(2);
  });

  it('does not skip a slot whose hold has expired', () => {
    const held = [3, 0, 0, 0]; // expired at t=3
    const r = pickSwapSlot(0, held, 5, 4); // clock 5 > 3 -> slot 0 usable
    expect(r.slot).toBe(0);
  });

  it('never deadlocks: if every slot is held, returns the cursor slot', () => {
    const held = [100, 100, 100, 100];
    const r = pickSwapSlot(2, held, 5, 4);
    expect(r.slot).toBe(2);
    expect(r.nextCursor).toBe(3);
  });

  it('wraps around the ring', () => {
    const held = [0, 0, 0, 0];
    const r = pickSwapSlot(3, held, 5, 4);
    expect(r.slot).toBe(3);
    const next = pickSwapSlot(r.nextCursor, held, 5, 4);
    expect(next.slot).toBe(0); // 4 % 4
  });
});
