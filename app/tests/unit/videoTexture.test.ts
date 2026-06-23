// app/tests/unit/videoTexture.test.ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import * as THREE from 'three';
import { loadVideoTexture } from '../../src/render/videoTexture';

interface FakeVideo {
  muted: boolean; loop: boolean; playsInline: boolean; preload: string; crossOrigin: string;
  src: string; currentTime: number; paused: boolean;
  oncanplay: null | (() => void); onerror: null | (() => void);
  setAttribute: ReturnType<typeof vi.fn>; removeAttribute: ReturnType<typeof vi.fn>; load: ReturnType<typeof vi.fn>;
  play: ReturnType<typeof vi.fn>; pause: ReturnType<typeof vi.fn>;
}

function fakeVideo(): FakeVideo {
  const v: FakeVideo = {
    muted: false, loop: false, playsInline: false, preload: '', crossOrigin: '',
    src: '', currentTime: 0, paused: true,
    oncanplay: null, onerror: null,
    setAttribute: vi.fn(), removeAttribute: vi.fn(), load: vi.fn(),
    play: vi.fn(() => { v.paused = false; return Promise.resolve(); }),
    pause: vi.fn(() => { v.paused = true; }),
  };
  return v;
}

describe('loadVideoTexture', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves ok on canplay, autoplays, and tags userData', async () => {
    const v = fakeVideo();
    const p = loadVideoTexture('http://x/film.mp4', {
      createVideo: () => v as unknown as HTMLVideoElement,
      makeTexture: () => new THREE.Texture(),
    });
    v.oncanplay?.();
    const res = await p;
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(v.muted).toBe(true);
    expect(v.loop).toBe(true);
    expect(v.play).toHaveBeenCalled();
    expect(res.texture.userData.ownedByCompositor).toBe(true);
    expect(res.texture.userData.kind).toBe('video');
    expect(res.texture.userData.video).toBe(v);
  });

  it('does not autoplay when paused (reduced motion)', async () => {
    const v = fakeVideo();
    const p = loadVideoTexture('http://x/film.mp4', {
      paused: true,
      createVideo: () => v as unknown as HTMLVideoElement,
      makeTexture: () => new THREE.Texture(),
    });
    v.oncanplay?.();
    const res = await p;
    expect(res.ok).toBe(true);
    expect(v.play).not.toHaveBeenCalled();
  });

  it('resolves fail on error', async () => {
    const v = fakeVideo();
    const p = loadVideoTexture('http://x/film.mp4', {
      createVideo: () => v as unknown as HTMLVideoElement,
      makeTexture: () => new THREE.Texture(),
    });
    v.onerror?.();
    const res = await p;
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe('error');
  });

  it('resolves fail timeout', async () => {
    vi.useFakeTimers();
    const v = fakeVideo();
    const p = loadVideoTexture('http://x/film.mp4', {
      timeoutMs: 10,
      createVideo: () => v as unknown as HTMLVideoElement,
      makeTexture: () => new THREE.Texture(),
    });
    vi.advanceTimersByTime(11);
    const res = await p;
    vi.useRealTimers();
    expect(res.ok).toBe(false);
  });
});
