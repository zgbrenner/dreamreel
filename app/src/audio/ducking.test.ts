import { describe, it, expect } from 'vitest';
import { busGainsDb } from './ducking';

describe('busGainsDb', () => {
  it('no focus: foley and bed gently trimmed, music at unity', () => {
    const g = busGainsDb({ voice: false, filmclip: false, music: true, foley: true });
    expect(g.music).toBe(0);
    expect(g.foley).toBe(-3);
    expect(g.bed).toBe(-5);
  });

  it('voice focus ducks music/foley/bed harder', () => {
    const g = busGainsDb({ voice: true, filmclip: false, music: true, foley: true });
    expect(g.voice).toBe(0);
    expect(g.music).toBe(-9);
    expect(g.foley).toBe(-6);
    expect(g.bed).toBe(-10);
  });

  it('film-clip audio is a focus source too (same ducking as voice)', () => {
    const g = busGainsDb({ voice: false, filmclip: true, music: true, foley: false });
    expect(g.filmclip).toBe(0);
    expect(g.music).toBe(-9);
    expect(g.bed).toBe(-10);
  });

  it('monotonic: bed is never quieter with focus absent than present', () => {
    const present = busGainsDb({ voice: true, filmclip: false, music: true, foley: true }).bed;
    const absent = busGainsDb({ voice: false, filmclip: false, music: true, foley: true }).bed;
    expect(present).toBeLessThan(absent);
  });
});
