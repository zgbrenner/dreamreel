// app/tests/unit/videoPool.test.ts
import { describe, it, expect, vi } from 'vitest';
import * as THREE from 'three';
import { VideoPool } from '../../src/render/VideoPool';

interface FakeVideo {
  currentTime: number;
  paused: boolean;
  play: ReturnType<typeof vi.fn>;
  pause: ReturnType<typeof vi.fn>;
  removeAttribute: ReturnType<typeof vi.fn>;
  load: ReturnType<typeof vi.fn>;
}

function fakeVideo(): FakeVideo {
  const v: FakeVideo = {
    currentTime: 1,
    paused: true,
    play: vi.fn(() => { v.paused = false; return Promise.resolve(); }),
    pause: vi.fn(() => { v.paused = true; }),
    removeAttribute: vi.fn(),
    load: vi.fn(),
  };
  return v;
}

function okLoader(reducedPaused = false) {
  return async () => {
    const v = fakeVideo();
    const tex = new THREE.Texture();
    tex.userData.video = v;
    if (!reducedPaused) v.play();
    return { ok: true as const, texture: tex };
  };
}

describe('VideoPool', () => {
  it('acquire seeks to 0 and plays', async () => {
    const pool = new VideoPool({ cap: 2, reducedMotion: () => false, load: okLoader() });
    const res = await pool.acquire('u');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const v = res.texture.userData.video as FakeVideo;
    expect(v.currentTime).toBe(0);
    expect(v.play).toHaveBeenCalled();
  });

  it('pauses the oldest playing video beyond cap', async () => {
    const pool = new VideoPool({ cap: 1, reducedMotion: () => false, load: okLoader() });
    const a = await pool.acquire('a');
    const b = await pool.acquire('b');
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect((a.texture.userData.video as FakeVideo).paused).toBe(true);   // evicted -> frozen still
    expect((b.texture.userData.video as FakeVideo).paused).toBe(false);  // newest keeps decoding
  });

  it('frees the element when the texture is disposed', async () => {
    const pool = new VideoPool({ cap: 2, reducedMotion: () => false, load: okLoader() });
    const res = await pool.acquire('u');
    if (!res.ok) return;
    const v = res.texture.userData.video as FakeVideo;
    res.texture.dispose(); // LayerStack/compositor recycle path emits 'dispose'
    expect(v.pause).toHaveBeenCalled();
    expect(v.removeAttribute).toHaveBeenCalledWith('src');
  });

  it('does not play under reduced motion', async () => {
    const pool = new VideoPool({ cap: 2, reducedMotion: () => true, load: okLoader(true) });
    const res = await pool.acquire('u');
    if (!res.ok) return;
    expect((res.texture.userData.video as FakeVideo).play).not.toHaveBeenCalled();
  });
});
