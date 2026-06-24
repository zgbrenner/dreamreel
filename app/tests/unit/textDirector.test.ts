import { describe, it, expect } from 'vitest';
import { whisperStyle, titleCardPalette } from '../../src/dream/textDirector';
import { blankMood } from '../../src/dream/mood';
import { MOOD_AXES, type MoodAxis } from '../../src/manifest/types';

function moodPeaking(axis: MoodAxis, peak = 0.95, base = 0.1): Record<MoodAxis, number> {
  const m = blankMood();
  for (const a of MOOD_AXES) m[a] = a === axis ? peak : base;
  return m;
}

describe('textDirector', () => {
  it('neutral mood yields readable whisper opacity and a lamp-leaning warm tint', () => {
    const w = whisperStyle(blankMood());
    expect(w.opacity).toBeGreaterThanOrEqual(0.55);
    expect(w.opacity).toBeLessThanOrEqual(1);
    expect(w.color).toMatch(/^rgb\(/);
  });

  it('loss dims the whisper; joy/love warm the title card', () => {
    const loss = whisperStyle(moodPeaking('loss'));
    const neutral = whisperStyle(blankMood());
    expect(loss.opacity).toBeLessThan(neutral.opacity);

    const joyful = titleCardPalette(moodPeaking('joy'));
    const flat = titleCardPalette(blankMood());
    expect(joyful.text).not.toBe(flat.text);
    expect(joyful.frame).not.toBe(flat.frame);
  });

  it('is deterministic and finite for every axis', () => {
    for (const axis of MOOD_AXES) {
      const m = moodPeaking(axis);
      const w1 = whisperStyle(m);
      const w2 = whisperStyle(m);
      expect(w1).toEqual(w2);
      expect(Number.isFinite(w1.opacity)).toBe(true);
      expect(titleCardPalette(m).ink).toBe('#0E0B08');
    }
  });
});
