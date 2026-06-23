import { describe, it, expect } from 'vitest';
import { AudioPool, type PooledAudio } from './AudioPool';

function fake(url: string): PooledAudio {
  let paused = false;
  return {
    url,
    play() { paused = false; },
    pause() { paused = true; },
    get paused() { return paused; },
    dispose() { paused = true; },
  };
}

async function poolOf(cap: number) {
  const created: PooledAudio[] = [];
  const pool = new AudioPool({
    cap,
    load: async (url) => { const a = fake(url); created.push(a); return a; },
  });
  return { pool, created };
}

describe('AudioPool', () => {
  it('keeps at most `cap` sources playing; older ones pause', async () => {
    const { pool, created } = await poolOf(2);
    await pool.acquire('a');
    await pool.acquire('b');
    await pool.acquire('c'); // exceeds cap -> oldest (a) paused
    expect(created[0].paused).toBe(true);
    expect(created[1].paused).toBe(false);
    expect(created[2].paused).toBe(false);
  });

  it('pauseAll then resumeAll re-enforces the cap', async () => {
    const { pool, created } = await poolOf(2);
    await pool.acquire('a');
    await pool.acquire('b');
    pool.pauseAll();
    expect(created.every((c) => c.paused)).toBe(true);
    pool.resumeAll();
    expect(created.filter((c) => !c.paused).length).toBe(2);
  });

  it('dispose tears down every source', async () => {
    const { pool, created } = await poolOf(3);
    await pool.acquire('a');
    await pool.acquire('b');
    pool.dispose();
    expect(created.every((c) => c.paused)).toBe(true);
  });
});
