// app/src/dream/dreamName.ts
//
// The dream names itself. Every seed yields a short, evocative, DETERMINISTIC poetic title in
// DREAMREEL's voice — shown on the Gate title screen and burned into the shareable poster and loop.
// It is display-only: never a control, never serialized (the seed alone carries the dream, and the
// name is a pure function of it, so `?seed=` still reproduces everything).
//
// The grammar composes a 2–5 word title from bounded, hand-authored word banks flavored by the
// dream's emotional identity: `deriveMoodIdentity(seed)` (moodBias.ts) gives the seed's register
// (gentle / neutral / nightmare) and, via its baseline, a dominant mood axis. The register selects
// a word bank (gentle → "The Warm Orchard", "A Field of Slow Light"; nightmare → "The Corridor That
// Repeats", "Salt and Undertow"; uncanny/strange → "The Guest Without a Face"); the dominant axis
// injects a little extra flavor. A grammar template and its words are drawn from a dedicated `:name`
// prng stream, so the title is reproducible per seed and independent of the walk's rng.

import { MOOD_AXES, type MoodAxis } from '../manifest/types';
import { dominantAxes } from './mood';
import { deriveMoodIdentity, type MoodIdentity } from './moodBias';
import { makeRng, type Rng } from './prng';

/** The emotional register that selects a word bank — mirrors the mood identity's class. */
export type NameRegister = MoodIdentity['kind'];

export interface WordBank {
  /** Concrete dream objects/places (single tokens, already title-cased). */
  readonly nouns: readonly string[];
  /** Descriptors (single tokens, already title-cased). */
  readonly adjectives: readonly string[];
  /** Present-tense verbs for the "The <noun> That <verb>" template (single tokens). */
  readonly verbs: readonly string[];
}

// Register banks. Every entry is a single whitespace-free token, so a template's word count is
// exactly its slot count — keeping every title inside the 2–5 word bound. Some words are shared
// across registers; each register also keeps words the others never use, so the register genuinely
// steers the title (asserted in the tests).
export const REGISTER_BANKS: Record<NameRegister, WordBank> = {
  // Warm / nostalgic / tender — the gentle baseline most dreams inhabit.
  gentle: {
    nouns: [
      'Hour',
      'Light',
      'Field',
      'Meadow',
      'Window',
      'Lantern',
      'Orchard',
      'Harbor',
      'Garden',
      'Letter',
      'Ribbon',
      'Threshold',
      'Afternoon',
      'Tide',
      'Hearth',
      'Doorway',
      'Lullaby',
      'Reverie',
    ],
    adjectives: [
      'Warm',
      'Slow',
      'Golden',
      'Quiet',
      'Amber',
      'Soft',
      'Distant',
      'Gentle',
      'Luminous',
      'Sunlit',
      'Familiar',
      'Half-Remembered',
    ],
    verbs: [
      'Remembers',
      'Returns',
      'Waits',
      'Blooms',
      'Lingers',
      'Softens',
      'Glows',
      'Drifts',
      'Forgives',
      'Opens',
    ],
  },
  // Uncanny / mechanical / recurring — a cooler, stranger neutral.
  neutral: {
    nouns: [
      'Corridor',
      'Machine',
      'Clock',
      'Mirror',
      'Station',
      'Signal',
      'Engine',
      'Museum',
      'Archive',
      'Procession',
      'Aperture',
      'Interval',
      'Meridian',
      'Ledger',
      'Compass',
      'Passage',
      'Face',
    ],
    adjectives: [
      'Slow',
      'Distant',
      'Quiet',
      'Grey',
      'Recurring',
      'Half-Lit',
      'Familiar',
      'Vacant',
      'Numbered',
      'Patient',
      'Provisional',
    ],
    verbs: [
      'Repeats',
      'Waits',
      'Turns',
      'Watches',
      'Forgets',
      'Circles',
      'Counts',
      'Drifts',
      'Continues',
    ],
  },
  // Fear / ominous / loss — the deliberate minority; the dream that turned.
  nightmare: {
    nouns: [
      'Corridor',
      'Static',
      'Salt',
      'Teeth',
      'Hollow',
      'Undertow',
      'Ash',
      'Vault',
      'Descent',
      'Silence',
      'Threshold',
      'Furnace',
      'Drowning',
      'Wound',
      'Cellar',
      'Fog',
      'Nightfall',
    ],
    adjectives: [
      'Cold',
      'Endless',
      'Drowned',
      'Hollow',
      'Sharp',
      'Vast',
      'Faceless',
      'Nameless',
      'Sunken',
      'Wrong',
      'Unlit',
      'Rusted',
    ],
    verbs: [
      'Repeats',
      'Waits',
      'Follows',
      'Devours',
      'Watches',
      'Unravels',
      'Closes',
      'Drowns',
      'Remembers',
    ],
  },
};

// Per-axis flavor nouns — a small injection of the dream's dominant emotion into the noun pool
// (single tokens). Frozen to the 12-axis taxonomy so every axis is covered.
export const AXIS_FLAVORS: Record<MoodAxis, readonly string[]> = {
  melancholy: ['Rain', 'Elegy', 'Dusk'],
  uncanny: ['Guest', 'Stranger', 'Reflection'],
  nostalgic: ['Photograph', 'Childhood', 'Homecoming'],
  ominous: ['Omen', 'Shadow', 'Warning'],
  tender: ['Embrace', 'Kindness', 'Cradle'],
  mechanical: ['Gear', 'Turbine', 'Apparatus'],
  love: ['Beloved', 'Vow', 'Heartbeat'],
  loss: ['Absence', 'Grief', 'Vacancy'],
  joy: ['Carnival', 'Laughter', 'Sunburst'],
  fear: ['Predator', 'Panic', 'Abyss'],
  absurdity: ['Carousel', 'Circus', 'Riddle'],
  strange: ['Anomaly', 'Comet', 'Threshold'],
};

/** A slot is either a fixed connective/article token, or a word drawn from a bank pool. */
export type NameSlot = { readonly lit: string } | { readonly pick: 'noun' | 'adjective' | 'verb' };

export interface NameTemplate {
  readonly id: string;
  readonly slots: readonly NameSlot[];
}

const NOUN: NameSlot = { pick: 'noun' };
const ADJ: NameSlot = { pick: 'adjective' };
const VERB: NameSlot = { pick: 'verb' };

// Grammar templates. Each produces 2–5 whitespace-free words. Distinct-noun draws are guaranteed
// by drawing nouns without replacement (see below), so "<noun> and <noun>" never repeats a word.
export const TEMPLATES: readonly NameTemplate[] = [
  { id: 'adj-noun', slots: [ADJ, NOUN] }, // "Slow Light"
  { id: 'the-adj-noun', slots: [{ lit: 'The' }, ADJ, NOUN] }, // "The Warm Hour"
  { id: 'noun-and-noun', slots: [NOUN, { lit: 'and' }, NOUN] }, // "Salt and Static"
  { id: 'the-noun-of-noun', slots: [{ lit: 'The' }, NOUN, { lit: 'of' }, NOUN] }, // "The Hour of Salt"
  { id: 'the-noun-that-verb', slots: [{ lit: 'The' }, NOUN, { lit: 'That' }, VERB] }, // "The Corridor That Repeats"
  { id: 'a-noun-of-adj-noun', slots: [{ lit: 'A' }, NOUN, { lit: 'of' }, ADJ, NOUN] }, // "A Field of Slow Light"
  {
    id: 'the-noun-without-a-noun',
    slots: [{ lit: 'The' }, NOUN, { lit: 'Without' }, { lit: 'a' }, NOUN],
  }, // "The Guest Without a Face"
];

// Words that begin with a consonant letter but a vowel sound, so they take "an" not "a".
const SILENT_H = new Set(['Hour']);

/** Whether `word` takes the "an"/"An" article (vowel sound), used to keep the grammar clean. */
function startsWithVowelSound(word: string): boolean {
  if (SILENT_H.has(word)) return true;
  return /^[aeiou]/i.test(word);
}

/** Fix "a"/"A" → "an"/"An" before a vowel-sound word, in place. Pure over its argument. */
function fixArticles(words: string[]): void {
  for (let i = 0; i < words.length - 1; i++) {
    if (!startsWithVowelSound(words[i + 1])) continue;
    if (words[i] === 'a') words[i] = 'an';
    else if (words[i] === 'A') words[i] = 'An';
  }
}

/** Fisher–Yates shuffle of a copy of `arr`, driven by `rng` (pure; leaves `arr` untouched). */
function shuffle<T>(rng: Rng, arr: readonly T[]): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = rng.int(i + 1);
    const t = a[i];
    a[i] = a[j];
    a[j] = t;
  }
  return a;
}

/** The register (word bank class) a seed's title is drawn from — its mood identity's class. */
export function registerForSeed(seed: string): NameRegister {
  return deriveMoodIdentity(seed).kind;
}

/** The full authored vocabulary a title of the given register can draw from (words + connectives). */
export function vocabularyForRegister(register: NameRegister): Set<string> {
  const s = new Set<string>();
  const bank = REGISTER_BANKS[register];
  for (const w of [...bank.nouns, ...bank.adjectives, ...bank.verbs]) s.add(w);
  for (const axis of MOOD_AXES) for (const w of AXIS_FLAVORS[axis]) s.add(w);
  for (const t of TEMPLATES) for (const slot of t.slots) if ('lit' in slot) s.add(slot.lit);
  // Articles agree with the following word (a → an), so both forms are possible tokens.
  if (s.has('a')) s.add('an');
  if (s.has('A')) s.add('An');
  return s;
}

/** Every token any title can ever contain — the union over all registers. */
export function nameVocabulary(): Set<string> {
  const s = new Set<string>();
  for (const register of Object.keys(REGISTER_BANKS) as NameRegister[]) {
    for (const w of vocabularyForRegister(register)) s.add(w);
  }
  return s;
}

/**
 * The dream's poetic title, derived purely and deterministically from its seed. Same seed →
 * identical title. 2–5 words, drawn only from the authored banks/templates above, flavored by the
 * seed's mood register + dominant axis.
 */
export function deriveDreamName(seed: string): string {
  const identity = deriveMoodIdentity(seed);
  const rng = makeRng(`${seed}:name`);
  const register = identity.kind;
  const axis = dominantAxes(identity.baseline, 1)[0]?.axis ?? MOOD_AXES[0];
  const bank = REGISTER_BANKS[register];

  // Draw without replacement so distinct-noun templates never repeat a word.
  const nouns = shuffle(rng, [...bank.nouns, ...AXIS_FLAVORS[axis]]);
  const adjectives = shuffle(rng, bank.adjectives);
  const verbs = shuffle(rng, bank.verbs);

  const template = TEMPLATES[rng.int(TEMPLATES.length)];
  let ni = 0;
  let ai = 0;
  let vi = 0;
  const words: string[] = [];
  for (const slot of template.slots) {
    if ('lit' in slot) {
      words.push(slot.lit);
    } else if (slot.pick === 'noun') {
      words.push(nouns[ni++] ?? bank.nouns[0]);
    } else if (slot.pick === 'adjective') {
      words.push(adjectives[ai++] ?? bank.adjectives[0]);
    } else {
      words.push(verbs[vi++] ?? bank.verbs[0]);
    }
  }
  fixArticles(words);
  return words.join(' ');
}

/** Object form, for callers that prefer a named field. */
export function dreamNameFor(seed: string): { title: string } {
  return { title: deriveDreamName(seed) };
}
