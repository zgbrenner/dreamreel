// app/src/audio/engine.ts
// A generative ambient bed that shifts with the Dreamwalker's mood. Built from Tone.js
// primitives (MIT, ship-safe). Everything is gated behind a user gesture (start()), and
// all parameter changes ramp to avoid clicks/pops.
//
// Public surface kept small so the Zustand store is the only driver:
//   start(), setMood(), setVolume(), setTempo(), suspend(), resume(), dispose().

import * as Tone from 'tone';
import {
  bedParamsFor,
  bellShotFor,
  deriveSynthCharacter,
  DEFAULT_SYNTH_CHARACTER,
  type Mood,
  type SynthCharacter,
} from './params';
import { makeRng, type Rng } from '../dream/prng';

const PENTATONIC = ['C', 'D', 'E', 'G', 'A'];
const RAMP = 1.5; // seconds for smooth parameter glides

// Neutral mood used to drive the tick rate before any real mood has been set.
const NEUTRAL_MOOD: Mood = {
  melancholy: 0.5,
  uncanny: 0.5,
  nostalgic: 0.5,
  ominous: 0.5,
  tender: 0.5,
  mechanical: 0.3,
  love: 0.5,
  loss: 0.5,
  joy: 0.5,
  fear: 0.5,
  absurdity: 0.5,
  strange: 0.5,
};

export class AudioEngine {
  private started = false;
  private muted = false;
  private tempoMul = 1;
  private mood: Mood | null = null;

  // Per-seed timbral identity (the INSTRUMENT). Defaults to the original hand-tuned bed so a
  // missing/empty seed reproduces the legacy sound bit-for-bit. See params.deriveSynthCharacter.
  private character: SynthCharacter = DEFAULT_SYNTH_CHARACTER;
  // Seeded generative stream for the bell voice — replaces Math.random so the bed obeys the
  // seed (no non-seeded randomness in the audio path). Reseeded by setSeed().
  private bellRng: Rng = makeRng('dreamreel:bells');

  // graph nodes (created on start)
  private master?: Tone.Gain;
  private reverb?: Tone.Reverb;
  private oscA?: Tone.Oscillator;
  private oscB?: Tone.Oscillator;
  private droneFilter?: Tone.Filter;
  private droneGain?: Tone.Gain;
  private droneLfo?: Tone.LFO;
  private noise?: Tone.Noise;
  private noiseFilter?: Tone.Filter;
  private hissGain?: Tone.Gain;
  private bell?: Tone.Synth;
  private bellGain?: Tone.Gain;
  private tick?: Tone.NoiseSynth;
  private tickGain?: Tone.Gain;
  private bellLoop?: Tone.Loop;
  private tickLoop?: Tone.Loop;

  get isStarted(): boolean {
    return this.started;
  }

  /** The master Gain node — available only after start() resolves. Used by the Mixer. */
  get masterGain(): Tone.Gain | undefined {
    return this.master;
  }

  /**
   * A raw Web Audio context + a native node carrying the master output, for an external visualizer
   * (the optional Butterchurn layer). Creates a native tap gain off the Tone master so the analyser
   * sees the full bed. Returns null until started or if anything goes wrong — callers degrade.
   */
  getVisualizerTap(): { context: unknown; node: unknown } | null {
    if (!this.master) return null;
    try {
      const raw = Tone.getContext().rawContext as unknown as AudioContext;
      const tap = raw.createGain();
      this.master.connect(tap); // Tone node → native node
      return { context: raw, node: tap };
    } catch {
      return null;
    }
  }

  /** Must be called from a user gesture. Idempotent. */
  async start(): Promise<void> {
    if (this.started) {
      await this.resume();
      return;
    }
    await Tone.start();
    this.build();
    this.started = true;
    const transport = Tone.getTransport();
    transport.start();
    // fade master in
    this.master?.gain.rampTo(this.muted ? 0 : 0.85, RAMP);
    if (this.mood) this.setMood(this.mood);
  }

  private build(): void {
    // The character is the INSTRUMENT: oscillator types, harmonic interval, filter/LFO shape,
    // noise colour and room size all come from the per-seed character. Mood (setMood) still
    // reshapes how it's PLAYED on top. DEFAULT_SYNTH_CHARACTER reproduces the legacy bed exactly.
    const c = this.character;

    this.master = new Tone.Gain(0).toDestination();
    this.reverb = new Tone.Reverb({ decay: c.reverbDecay, wet: 0.5, preDelay: 0.02 }).connect(
      this.master,
    );

    // Drone: two oscillators (character timbres), stacked at the character's harmonic interval,
    // through a slow-LFO filter (character shape).
    this.droneGain = new Tone.Gain(c.droneGain).connect(this.reverb);
    this.droneFilter = new Tone.Filter({ type: c.filterType, frequency: 600, Q: c.filterQ }).connect(
      this.droneGain,
    );
    this.oscA = new Tone.Oscillator({ frequency: 55, type: c.oscAType }).connect(this.droneFilter);
    this.oscB = new Tone.Oscillator({
      frequency: 55 * c.intervalRatio,
      type: c.oscBType,
      detune: 8 + c.detuneSpread,
    }).connect(this.droneFilter);
    this.droneLfo = new Tone.LFO({
      frequency: c.lfoRateHz,
      min: c.lfoMin,
      max: c.lfoMax,
      type: c.lfoType,
    });
    this.droneLfo.connect(this.droneFilter.frequency);
    this.oscA.start();
    this.oscB.start();
    this.droneLfo.start();

    // Tape hiss / static: filtered noise (character colour).
    this.hissGain = new Tone.Gain(0.05).connect(this.master);
    this.noiseFilter = new Tone.Filter({ type: 'lowpass', frequency: 2600, Q: 0.6 }).connect(
      this.hissGain,
    );
    this.noise = new Tone.Noise(c.noiseColor).connect(this.noiseFilter);
    this.noise.start();

    // Bells: a soft synth (character timbre) with long release, into reverb.
    this.bellGain = new Tone.Gain(0.18).connect(this.reverb);
    this.bell = new Tone.Synth({
      oscillator: { type: c.bellType },
      envelope: { attack: 0.005, decay: 1.2, sustain: 0, release: 2.5 },
      volume: -6,
    }).connect(this.bellGain);

    // Projector tick: short filtered noise burst.
    this.tickGain = new Tone.Gain(0.0).connect(this.master);
    this.tick = new Tone.NoiseSynth({
      noise: { type: 'white' },
      envelope: { attack: 0.001, decay: 0.03, sustain: 0 },
      volume: -18,
    }).connect(this.tickGain);

    // Scheduled generative events.
    this.bellLoop = new Tone.Loop((time) => {
      const { prob, octave } = bellShotFor(this.mood ?? NEUTRAL_MOOD);
      // Seeded, not Math.random: the bell pattern belongs to the dream's seed (CLAUDE.md forbids
      // non-seeded randomness in the audio path). A passive same-seed viewer hears the same shots.
      if (this.bellRng.next() < prob) {
        const note = PENTATONIC[this.bellRng.int(PENTATONIC.length)];
        this.bell?.triggerAttackRelease(`${note}${octave}`, '2n', time, 0.4 + this.bellRng.next() * 0.3);
      }
    }, '2n').start(0);

    this.tickLoop = new Tone.Loop((time) => {
      this.tick?.triggerAttackRelease('16n', time);
    }, '4n').start(0);
    this.updateTickRate();
  }

  /** Ramp the bed toward a mood. ominous => lower/darker + more hiss; tender => brighter +
   *  higher bells; mechanical => brighter static + faster ticks. */
  setMood(mood: Mood): void {
    this.mood = mood;
    if (!this.started) return;

    // All targets come from the pure mood->params map; here we only ramp toward them.
    const p = bedParamsFor(mood, this.tempoMul);

    // Drone: pitch down for ominous/melancholy, up for tender; uncanny widens the beating.
    // The character owns the harmonic interval (which chord the drone stacks), the extra detune
    // "width", and the room's brightness bias — the mood targets ride on top of those.
    this.oscA?.frequency.rampTo(p.droneRootHz, RAMP);
    this.oscB?.frequency.rampTo(p.droneRootHz * this.character.intervalRatio, RAMP);
    this.oscB?.detune.rampTo(p.beatDetune + this.character.detuneSpread, RAMP);
    this.droneFilter?.frequency.rampTo(p.droneCutoffHz * this.character.cutoffScale, RAMP);

    // Hiss: more for ominous + mechanical, brighter for mechanical.
    this.hissGain?.gain.rampTo(p.hissGain, RAMP);
    this.noiseFilter?.frequency.rampTo(p.hissCutoffHz, RAMP);

    // Bells brighten with tenderness.
    this.bellGain?.gain.rampTo(p.bellGain, RAMP);

    // Reverb wetness: more dreamlike when tender/uncanny.
    this.reverb?.wet.rampTo(p.reverbWet, RAMP);

    // Ticks louder/faster with mechanical.
    this.tickGain?.gain.rampTo(p.tickGain, RAMP);
    this.updateTickRate();
  }

  /**
   * Give the bed a per-seed timbral identity (the INSTRUMENT). Safe to call before or after
   * start(): before, the graph is built with the character; after (e.g. on "New dream"), the live
   * graph is re-tuned toward it. A missing/empty seed reproduces the default bed. Best-effort —
   * this must never throw into the dream, so callers can wrap it in their audio-safe path.
   */
  setSeed(seed: string): void {
    this.character = deriveSynthCharacter(seed);
    this.bellRng = makeRng(`${seed.trim() ? seed : 'dreamreel'}:bells`);
    if (this.started) this.applyCharacter();
  }

  /** Re-tune the already-built graph toward the current character (used on reseed). */
  private applyCharacter(): void {
    const c = this.character;
    if (this.oscA) this.oscA.type = c.oscAType;
    if (this.oscB) this.oscB.type = c.oscBType;
    if (this.droneFilter) {
      this.droneFilter.type = c.filterType;
      this.droneFilter.Q.rampTo(c.filterQ, RAMP);
    }
    this.droneGain?.gain.rampTo(c.droneGain, RAMP);
    if (this.droneLfo) {
      this.droneLfo.type = c.lfoType;
      this.droneLfo.frequency.rampTo(c.lfoRateHz, RAMP);
      this.droneLfo.min = c.lfoMin;
      this.droneLfo.max = c.lfoMax;
    }
    if (this.noise) this.noise.type = c.noiseColor;
    if (this.reverb) this.reverb.decay = c.reverbDecay; // regenerates the impulse response async
    if (this.bell) this.bell.oscillator.type = c.bellType;
    // Re-apply mood so the interval/detune/cutoff that depend on the new character take effect.
    if (this.mood) this.setMood(this.mood);
  }

  setTempo(mul: number): void {
    this.tempoMul = Math.max(0.25, mul);
    this.updateTickRate();
  }

  private updateTickRate(): void {
    if (!this.tickLoop) return;
    this.tickLoop.interval = bedParamsFor(this.mood ?? NEUTRAL_MOOD, this.tempoMul).tickIntervalSec;
  }

  /** Mute/unmute with a ramp (no clicks). */
  setVolume(on: boolean): void {
    this.muted = !on;
    this.master?.gain.rampTo(on ? 0.85 : 0, RAMP * 0.5);
  }

  async resume(): Promise<void> {
    if (Tone.getContext().state !== 'running') await Tone.getContext().resume();
    Tone.getTransport().start();
    this.master?.gain.rampTo(this.muted ? 0 : 0.85, RAMP * 0.5);
  }

  suspend(): void {
    this.master?.gain.rampTo(0, 0.2);
    Tone.getTransport().pause();
  }

  dispose(): void {
    this.bellLoop?.dispose();
    this.tickLoop?.dispose();
    for (const node of [
      this.oscA,
      this.oscB,
      this.droneFilter,
      this.droneGain,
      this.droneLfo,
      this.noise,
      this.noiseFilter,
      this.hissGain,
      this.bell,
      this.bellGain,
      this.tick,
      this.tickGain,
      this.reverb,
      this.master,
    ]) {
      node?.dispose();
    }
    this.started = false;
  }
}
