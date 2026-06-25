// app/tests/unit/compositorVideo.test.ts
import { describe, it, expect, vi } from 'vitest';
import * as THREE from 'three';
import { Compositor } from '../../src/render/Compositor';

describe('Compositor.showVideo', () => {
  it('routes through the video pool and applies grade', async () => {
    const comp = new Compositor();
    const tex = new THREE.Texture();
    const fakePool = { acquire: vi.fn(async () => ({ ok: true as const, texture: tex })), dispose: vi.fn() };
    // inject the stub pool
    (comp as unknown as { videoPool: typeof fakePool }).videoPool = fakePool;

    const res = await comp.showVideo('http://x/film.mp4', 'sepia 0.4');
    expect(fakePool.acquire).toHaveBeenCalledWith('http://x/film.mp4', undefined);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.texture.userData.grade).toBe('sepia 0.4');
  });

  it('threads a shot window through to the pool', async () => {
    const comp = new Compositor();
    const tex = new THREE.Texture();
    const fakePool = { acquire: vi.fn(async () => ({ ok: true as const, texture: tex })), dispose: vi.fn() };
    (comp as unknown as { videoPool: typeof fakePool }).videoPool = fakePool;
    await comp.showVideo('http://x/film.mp4', undefined, { start: 12, end: 18 });
    expect(fakePool.acquire).toHaveBeenCalledWith('http://x/film.mp4', { start: 12, end: 18 });
  });

  it('passes through a fail result unchanged', async () => {
    const comp = new Compositor();
    const fakePool = { acquire: vi.fn(async () => ({ ok: false as const, reason: 'error' as const })), dispose: vi.fn() };
    (comp as unknown as { videoPool: typeof fakePool }).videoPool = fakePool;
    const res = await comp.showVideo('http://x/film.mp4');
    expect(res.ok).toBe(false);
  });
});
