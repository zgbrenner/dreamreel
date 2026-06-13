// app/src/state/store.ts
import { create } from 'zustand';
import type { MoodAxis } from '../manifest/types';
import { blankMood } from '../dream/mood';
import type { DreamRuntime } from './runtime';
import { readShareState, writeShareState, randomSeed } from './url';

export interface Caption {
  reel: string;
  source: string;
  whisper: string;
  license?: string;
  attribution?: string;
  attributionUrl?: string;
}

export interface PlayerState {
  playing: boolean;
  surreality: number; // 0..1
  tempoMul: number; // 0.5..2
  seed: string;
  soundOn: boolean;
  archiveOn: boolean; // include networked PD media vs procedural-only
  mood: Record<MoodAxis, number>;
  caption: Caption;
  // actions
  togglePlay(): void;
  setSurreality(v: number): void;
  setTempo(v: number): void;
  reseed(seed?: string): void;
  setSound(on: boolean): void;
  setArchive(on: boolean): void;
}

// Internal extensions the runtime/conductor use; not part of the public contract.
interface InternalState extends PlayerState {
  _runtime: DreamRuntime | null;
  attachRuntime(r: DreamRuntime | null): void;
  _setCaption(c: Partial<Caption>): void;
  _setMood(m: Record<MoodAxis, number>): void;
}

const initial = readShareState();

export const useStore = create<InternalState>((set, get) => ({
  playing: false,
  surreality: initial.surreality,
  tempoMul: initial.tempo,
  seed: initial.seed,
  soundOn: true,
  archiveOn: true,
  mood: blankMood(),
  caption: { reel: 'DREAMREEL', source: '', whisper: '' },

  _runtime: null,
  attachRuntime: (r) => set({ _runtime: r }),
  _setCaption: (c) => set((s) => ({ caption: { ...s.caption, ...c } })),
  _setMood: (m) => set({ mood: m }),

  togglePlay: () => {
    const { playing, _runtime } = get();
    const next = !playing;
    set({ playing: next });
    if (next) void _runtime?.play();
    else _runtime?.pause();
  },

  setSurreality: (v) => {
    const surreality = clamp(v, 0, 1);
    set({ surreality });
    get()._runtime?.setSurreality(surreality);
    persist(get);
  },

  setTempo: (v) => {
    const tempoMul = clamp(v, 0.5, 2);
    set({ tempoMul });
    get()._runtime?.setTempo(tempoMul);
    persist(get);
  },

  reseed: (seed) => {
    const next = seed && seed.trim() ? seed.trim() : randomSeed();
    set({ seed: next });
    const { surreality, tempoMul, _runtime } = get();
    _runtime?.reseed(next, surreality, tempoMul);
    persist(get);
  },

  setSound: (on) => {
    set({ soundOn: on });
    get()._runtime?.setSound(on);
  },

  setArchive: (on) => {
    set({ archiveOn: on });
    get()._runtime?.setArchive(on);
  },
}));

function persist(get: () => InternalState): void {
  const { seed, surreality, tempoMul } = get();
  writeShareState({ seed, surreality, tempo: tempoMul });
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

// Persist the initial share state so a freshly generated seed is in the URL immediately.
writeShareState({ seed: initial.seed, surreality: initial.surreality, tempo: initial.tempo });
