import { describe, it, expect } from 'vitest';
import { nextFocus } from './mixer';
import type { FocusState } from './ducking';

const empty: FocusState = { voice: false, filmclip: false, music: false, foley: false };

describe('nextFocus', () => {
  it('tracks music/foley presence', () => {
    const a = nextFocus(empty, 'music', true);
    expect(a.music).toBe(true);
    const b = nextFocus(a, 'foley', true);
    expect(b.foley).toBe(true);
    expect(nextFocus(b, 'music', false).music).toBe(false);
  });

  it('voice and filmclip toggle focus', () => {
    expect(nextFocus(empty, 'voice', true).voice).toBe(true);
    expect(nextFocus(empty, 'filmclip', true).filmclip).toBe(true);
    expect(nextFocus({ ...empty, voice: true }, 'voice', false).voice).toBe(false);
  });
});
