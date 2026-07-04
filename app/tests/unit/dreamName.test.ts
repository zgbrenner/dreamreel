import { describe, it, expect } from 'vitest';
import {
  deriveDreamName,
  dreamNameFor,
  registerForSeed,
  vocabularyForRegister,
  nameVocabulary,
  REGISTER_BANKS,
  AXIS_FLAVORS,
  TEMPLATES,
  type NameRegister,
} from '../../src/dream/dreamName';
import { MOOD_AXES } from '../../src/manifest/types';

const REGISTERS: NameRegister[] = ['gentle', 'neutral', 'nightmare'];

describe('deriveDreamName — determinism', () => {
  it('gives the same seed the same title, every time', () => {
    for (const seed of ['alpha', 'k3j9zx1ab', 'velvet-owl', 'Seed_42']) {
      expect(deriveDreamName(seed)).toBe(deriveDreamName(seed));
    }
  });

  it('dreamNameFor wraps the same pure title', () => {
    expect(dreamNameFor('alpha')).toEqual({ title: deriveDreamName('alpha') });
  });

  it('varies across seeds', () => {
    const names = new Set<string>();
    for (let i = 0; i < 200; i++) names.add(deriveDreamName(`seed-${i}`));
    // A bounded grammar can't be all-unique, but it must be richly varied, not a handful.
    expect(names.size).toBeGreaterThan(60);
  });
});

describe('deriveDreamName — shape & vocabulary', () => {
  const templateSlotCounts = new Set(TEMPLATES.map((t) => t.slots.length));

  it('produces a non-empty 2–5 word title for 200 seeds, drawn only from the authored vocabulary', () => {
    const vocab = nameVocabulary();
    for (let i = 0; i < 200; i++) {
      const name = deriveDreamName(`corpus-${i}`);
      expect(name.trim().length).toBeGreaterThan(0);
      const words = name.split(/\s+/);
      expect(words.length).toBeGreaterThanOrEqual(2);
      expect(words.length).toBeLessThanOrEqual(5);
      // Word count matches one of the templates' slot counts.
      expect(templateSlotCounts.has(words.length)).toBe(true);
      // Every token is authored — no stray/generated words.
      for (const w of words) expect(vocab.has(w)).toBe(true);
    }
  });

  it('every bank word and axis flavor is a single whitespace-free token', () => {
    for (const register of REGISTERS) {
      const b = REGISTER_BANKS[register];
      for (const w of [...b.nouns, ...b.adjectives, ...b.verbs]) expect(w).not.toMatch(/\s/);
    }
    for (const axis of MOOD_AXES) for (const w of AXIS_FLAVORS[axis]) expect(w).not.toMatch(/\s/);
  });

  it('covers all 12 mood axes with flavor words', () => {
    for (const axis of MOOD_AXES) expect(AXIS_FLAVORS[axis].length).toBeGreaterThan(0);
  });

  it('never repeats a noun within a "<noun> and <noun>" style title', () => {
    // Scan many seeds; whenever a 3-word "X and Y" title turns up, X !== Y.
    let sawAnd = false;
    for (let i = 0; i < 500; i++) {
      const words = deriveDreamName(`and-${i}`).split(/\s+/);
      const at = words.indexOf('and');
      if (at > 0 && at < words.length - 1) {
        sawAnd = true;
        expect(words[at - 1]).not.toBe(words[at + 1]);
      }
    }
    expect(sawAnd).toBe(true); // the template does get exercised
  });
});

describe('deriveDreamName — mood register steers the word bank', () => {
  it('registerForSeed mirrors the mood identity class', () => {
    for (let i = 0; i < 50; i++) {
      const seed = `reg-${i}`;
      expect(REGISTERS).toContain(registerForSeed(seed));
    }
  });

  it("a title only ever uses its own register's vocabulary", () => {
    for (let i = 0; i < 400; i++) {
      const seed = `bank-${i}`;
      const register = registerForSeed(seed);
      const vocab = vocabularyForRegister(register);
      for (const w of deriveDreamName(seed).split(/\s+/)) expect(vocab.has(w)).toBe(true);
    }
  });

  it('never leaks a register-exclusive word into another register (gentle vs nightmare)', () => {
    // Words unique to one register (not shared, not an axis flavor, not a connective).
    const shared = new Set<string>([...vocabularyForRegister('neutral')]);
    for (const axis of MOOD_AXES) for (const w of AXIS_FLAVORS[axis]) shared.add(w);
    for (const t of TEMPLATES) for (const s of t.slots) if ('lit' in s) shared.add(s.lit);

    const bankWords = (r: NameRegister) =>
      new Set([...REGISTER_BANKS[r].nouns, ...REGISTER_BANKS[r].adjectives, ...REGISTER_BANKS[r].verbs]);
    const gentle = bankWords('gentle');
    const nightmare = bankWords('nightmare');

    const gentleOnly = [...gentle].filter((w) => !nightmare.has(w) && !isAxisOrLit(w));
    const nightmareOnly = [...nightmare].filter((w) => !gentle.has(w) && !isAxisOrLit(w));
    // Both registers keep a distinctive private vocabulary...
    expect(gentleOnly.length).toBeGreaterThan(0);
    expect(nightmareOnly.length).toBeGreaterThan(0);

    // ...and those private words never appear in the other register's titles.
    const gentleOnlySet = new Set(gentleOnly);
    const nightmareOnlySet = new Set(nightmareOnly);
    for (let i = 0; i < 600; i++) {
      const seed = `leak-${i}`;
      const register = registerForSeed(seed);
      const words = deriveDreamName(seed).split(/\s+/);
      if (register === 'gentle') {
        for (const w of words) expect(nightmareOnlySet.has(w)).toBe(false);
      } else if (register === 'nightmare') {
        for (const w of words) expect(gentleOnlySet.has(w)).toBe(false);
      }
    }
  });
});

/** True if a token is an axis flavor or a template connective (shared, register-agnostic). */
function isAxisOrLit(word: string): boolean {
  for (const axis of MOOD_AXES) if (AXIS_FLAVORS[axis].includes(word)) return true;
  for (const t of TEMPLATES) for (const s of t.slots) if ('lit' in s && s.lit === word) return true;
  return false;
}
