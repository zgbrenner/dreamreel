// app/src/dream/steering.test.ts
//
// The seeded-spine-plus-bend model:
//   • A PASSIVE viewer (no / neutral steering) gets the EXACT seeded dream — same assets, text, and
//     layer events, in the same order, bit-for-bit.
//   • An ambient steering input applies a BOUNDED bend to the walk, then the bend RELAXES back to the
//     seeded spine once the input stops — and the script returns to the spine bit-for-bit.
//   • Presentation shimmer is bounded and NEVER touches the dream script.

import { describe, it, expect } from 'vitest';
import {
  createDreamwalker,
  BEND_MAX,
  type DreamwalkerPools,
  type DreamLayer,
} from './dreamwalker';
import {
  neutralSteering,
  createSteeringController,
  shimmerFromSteering,
  SHIMMER_PAN,
  SHIMMER_BREATHE,
  type SteeringState,
} from './steering';
import { createIntensityEngine } from './intensity';
import { parseManifest } from '../manifest/loader';
import seed from '../../public/manifest.seed.json';

const manifest = parseManifest(seed);
const pools: DreamwalkerPools = {
  visual: manifest.assets,
  texts: manifest.texts,
  moodAxes: manifest.moodAxes,
  embeddingDim: manifest.embeddingDim,
};

// A fixed interleave of all three layers, so a run exercises images, drifting text, AND ghost
// "layer events" — exactly the things the determinism contract pins.
const CADENCE: DreamLayer[] = ['image', 'text', 'ghost', 'image', 'image', 'text', 'ghost'];

interface Row {
  key: string; // layer + asset id + titleCard flag — the part of the script that must be deterministic
  dwell: number; // dwell ms — TIMING, allowed to vary
}

function run(
  seedStr: string,
  n: number,
  steerAt?: (beatIndex: number) => SteeringState | null,
): Row[] {
  const w = createDreamwalker(pools, { seed: seedStr, surreality: 0.6 });
  const out: Row[] = [];
  for (let i = 0; i < n; i++) {
    if (steerAt) w.setSteering(steerAt(i));
    const layer = CADENCE[i % CADENCE.length];
    const beat = w.next(layer, 1);
    out.push({ key: `${layer}:${beat.asset.id}:${beat.titleCard ? 'card' : '-'}`, dwell: beat.dwellMs });
  }
  return out;
}

const keys = (rows: Row[]): string[] => rows.map((r) => r.key);

describe('seeded spine — passive viewer gets the exact seeded dream', () => {
  it('zero interaction reproduces the exact seeded sequence (assets, text, layer events)', () => {
    const pure = run('reel-77', 140); // never calls setSteering
    const neutral = run('reel-77', 140, () => neutralSteering());
    const nulls = run('reel-77', 140, () => null);
    // Full rows (ids AND dwell) match — neutral steering is bit-for-bit identical to no steering.
    expect(neutral).toEqual(pure);
    expect(nulls).toEqual(pure);
  });

  it('coherence troughs are seed-deterministic: blur eases the ceiling but never reschedules them', () => {
    // Blur lowers the wake intensity ceiling (conductor.applySteeringToFilm). The trough SCHEDULE is
    // a pure function of the seed and is invariant to that ceiling — so the troughs a viewer sees are
    // preserved whether they watch or look away.
    const troughSeq = (maxI: number): number[] => {
      const eng = createIntensityEngine('reel-77', { maxIntensity: maxI });
      const ids: number[] = [];
      for (let t = 0; t < 200; t += 0.5) ids.push(eng.sample(t).troughId);
      return ids;
    };
    expect(troughSeq(0.45)).toEqual(troughSeq(1));
  });

  it('idle lengthens dwell (timing) but never reorders the seeded script', () => {
    const pure = run('idle-seed', 90);
    const idle = run('idle-seed', 90, () => {
      const s = neutralSteering();
      s.idle = 1; // a still, watching viewer
      return s;
    });
    // Order of assets/text/events is untouched...
    expect(keys(idle)).toEqual(keys(pure));
    // ...but every beat lingers ~1.6× longer (idle dwell gain).
    for (let i = 0; i < pure.length; i++) {
      expect(idle[i].dwell).toBeCloseTo(pure[i].dwell * 1.6, 6);
    }
  });
});

describe('behavioral bend — bounded perturbation that relaxes back to the spine', () => {
  it('a steering input perturbs the walk within the cap, then relaxes back to the spine', () => {
    const STEER_FROM = 20;
    const STEER_TO = 45;
    const steerAt = (i: number): SteeringState => {
      const s = neutralSteering();
      if (i >= STEER_FROM && i < STEER_TO) {
        s.pointerX = 1; // pointer pinned to a corner — full attention
        s.pointerY = -1;
      }
      return s;
    };

    const pure = run('bend-seed', 140);
    const bent = run('bend-seed', 140, steerAt);

    // Before any input: identical to the seeded spine.
    expect(bent.slice(0, STEER_FROM)).toEqual(pure.slice(0, STEER_FROM));
    // During input: the walk actually bends — at least one beat diverges from the spine.
    expect(keys(bent.slice(STEER_FROM, STEER_TO))).not.toEqual(keys(pure.slice(STEER_FROM, STEER_TO)));
    // After the input stops and the bend relaxes: the script returns to the spine bit-for-bit.
    expect(bent.slice(90)).toEqual(pure.slice(90));
  });

  it('the bend never exceeds the documented cap, and returns to exactly zero on relax', () => {
    const w = createDreamwalker(pools, { seed: 'cap-seed', surreality: 0.6 });
    // Drive full attention for a stretch and watch the image-layer bend magnitude stay capped.
    const hard = neutralSteering();
    hard.pointerX = 1;
    hard.pointerY = 1;
    let maxSeen = 0;
    for (let i = 0; i < 40; i++) {
      w.setSteering(hard);
      w.next('image', 1);
      maxSeen = Math.max(maxSeen, w.bendMagnitude('image'));
    }
    expect(maxSeen).toBeGreaterThan(0); // it did bend
    expect(maxSeen).toBeLessThanOrEqual(BEND_MAX + 1e-9); // but never past the cap

    // Release the input: the bend decays and snaps to exactly 0 (back on the spine).
    for (let i = 0; i < 40; i++) {
      w.setSteering(neutralSteering());
      w.next('image', 1);
    }
    expect(w.bendMagnitude('image')).toBe(0);
  });
});

describe('presentation shimmer — bounded and fully separate from the dream script', () => {
  it('presentation-only signals (tilt, pointer speed, time-of-day) never change the script', () => {
    const presOnly = (i: number): SteeringState => {
      const s = neutralSteering();
      // Vary ONLY the presentation-only fields; pointer attention/idle/focus stay neutral.
      s.tiltX = Math.sin(i);
      s.tiltY = Math.cos(i);
      s.pointerSpeed = 1;
      s.timeOfDay = (i % 24) / 24;
      return s;
    };
    const pure = run('shimmer-seed', 120);
    const withPres = run('shimmer-seed', 120, presOnly);
    expect(withPres).toEqual(pure);
  });

  it('shimmerFromSteering stays within its documented bounds for arbitrary input', () => {
    for (let i = 0; i < 60; i++) {
      const s = neutralSteering();
      s.pointerX = Math.sin(i * 1.3);
      s.pointerY = Math.cos(i * 0.7);
      s.tiltX = Math.sin(i);
      s.tiltY = -Math.cos(i * 1.1);
      s.pointerSpeed = (i % 11) / 10;
      const sh = shimmerFromSteering(s);
      expect(Math.abs(sh.dx)).toBeLessThanOrEqual(SHIMMER_PAN + 1e-9);
      expect(Math.abs(sh.dy)).toBeLessThanOrEqual(SHIMMER_PAN + 1e-9);
      expect(sh.zoom).toBeGreaterThanOrEqual(1);
      expect(sh.zoom).toBeLessThanOrEqual(1 + SHIMMER_BREATHE + 1e-9);
    }
  });

  it('reduced-motion damps the shimmer', () => {
    const base = neutralSteering();
    base.pointerX = 1;
    base.tiltX = 1;
    base.pointerSpeed = 1;
    const reduced: SteeringState = { ...base, reduceMotion: true };
    const full = shimmerFromSteering(base);
    const damp = shimmerFromSteering(reduced);
    expect(Math.abs(damp.dx)).toBeLessThan(Math.abs(full.dx));
    expect(damp.zoom - 1).toBeLessThan(full.zoom - 1);
  });
});

describe('steering controller', () => {
  it('returns a neutral state when there is no DOM (node/test env)', () => {
    const c = createSteeringController();
    expect(c.state).toEqual(neutralSteering());
    c.dispose();
  });

  it('honors a reduceMotion override even without a DOM', () => {
    const c = createSteeringController({ reduceMotion: true });
    expect(c.state.reduceMotion).toBe(true);
    c.dispose();
  });
});
