// app/src/audio/engine.ts
// A generative ambient bed that shifts with the Dreamwalker's mood. Built from Tone.js
// primitives (MIT, ship-safe). Everything is gated behind a user gesture (start()), and
// all parameter changes ramp to avoid clicks/pops.
//
// Public surface kept small so the Zustand store (prompt 7) is the only driver:
//   start(), setMood(), setVolume(), setTempo(), suspend(), resume(), dispose().

import * as Tone from 'tone';
import type { MoodAxis } from '../manifest/types';

type Mood = Record<MoodAxis, number>;

const PENTATONIC = ['C', 'D', 'E', 'G', 'A'];
const RAMP = 1.5; // seconds for smooth parameter glides

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

export class AudioEngine {
  private started = false;
  private muted = false;
  private tempoMul = 1;
  private mood: Mood | null = null;

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
    this.master = new Tone.Gain(0).toDestination();
    this.reverb = new Tone.Reverb({ decay: 7, wet: 0.5, preDelay: 0.02 }).connect(this.master);

    // Drone: two detuned oscillators through a slow-LFO lowpass.
    this.droneGain = new Tone.Gain(0.22).connect(this.reverb);
    this.droneFilter = new Tone.Filter({ type: 'lowpass', frequency: 600, Q: 1 }).connect(
      this.droneGain,
    );
    this.oscA = new Tone.Oscillator({ frequency: 55, type: 'sine' }).connect(this.droneFilter);
    this.oscB = new Tone.Oscillator({ frequency: 55, type: 'triangle', detune: 8 }).connect(
      this.droneFilter,
    );
    this.droneLfo = new Tone.LFO({ frequency: 0.05, min: 320, max: 900 });
    this.droneLfo.connect(this.droneFilter.frequency);
    this.oscA.start();
    this.oscB.start();
    this.droneLfo.start();

    // Tape hiss / static: filtered pink noise.
    this.hissGain = new Tone.Gain(0.05).connect(this.master);
    this.noiseFilter = new Tone.Filter({ type: 'lowpass', frequency: 2600, Q: 0.6 }).connect(
      this.hissGain,
    );
    this.noise = new Tone.Noise('pink').connect(this.noiseFilter);
    this.noise.start();

    // Bells: a soft sine synth with long release, into reverb.
    this.bellGain = new Tone.Gain(0.18).connect(this.reverb);
    this.bell = new Tone.Synth({
      oscillator: { type: 'sine' },
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
      const tenderness = this.mood ? this.mood.tender : 0.5;
      const p = 0.18 + tenderness * 0.4;
      if (Math.random() < p) {
        const note = PENTATONIC[Math.floor(Math.random() * PENTATONIC.length)];
        const octave = 3 + Math.round(tenderness * 2); // tender => higher register
        this.bell?.triggerAttackRelease(`${note}${octave}`, '2n', time, 0.4 + Math.random() * 0.3);
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

    const ominous = clamp01(mood.ominous);
    const tender = clamp01(mood.tender);
    const mechanical = clamp01(mood.mechanical);
    const melancholy = clamp01(mood.melancholy);
    const uncanny = clamp01(mood.uncanny);

    // Drone pitch: down for ominous/melancholy, up a little for tender.
    const root = 46 + tender * 18 - ominous * 8 - melancholy * 4; // Hz
    this.oscA?.frequency.rampTo(root, RAMP);
    this.oscB?.frequency.rampTo(root * 1.5, RAMP); // a fifth above, detuned
    this.oscB?.detune.rampTo(6 + uncanny * 22, RAMP); // uncanny => more beating

    // Drone filter brightness.
    const cutoff = 380 + tender * 1400 + mechanical * 600 - ominous * 150;
    this.droneFilter?.frequency.rampTo(Math.max(200, cutoff), RAMP);

    // Hiss: more for ominous + mechanical, brighter for mechanical.
    this.hissGain?.gain.rampTo(0.03 + ominous * 0.1 + mechanical * 0.06, RAMP);
    this.noiseFilter?.frequency.rampTo(1400 + mechanical * 5000, RAMP);

    // Bells brightness via gain.
    this.bellGain?.gain.rampTo(0.08 + tender * 0.22, RAMP);

    // Reverb wetness: more dreamlike when tender/uncanny.
    this.reverb?.wet.rampTo(0.4 + tender * 0.25 + uncanny * 0.15, RAMP);

    // Ticks louder/faster with mechanical.
    this.tickGain?.gain.rampTo(mechanical * 0.12, RAMP);
    this.updateTickRate();
  }

  setTempo(mul: number): void {
    this.tempoMul = Math.max(0.25, mul);
    this.updateTickRate();
  }

  private updateTickRate(): void {
    if (!this.tickLoop) return;
    const mechanical = this.mood ? clamp01(this.mood.mechanical) : 0.3;
    // base every quarter; mechanical + tempo shorten the interval.
    const seconds = 0.6 / (this.tempoMul * (0.6 + mechanical * 1.4));
    this.tickLoop.interval = Math.max(0.08, seconds);
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
