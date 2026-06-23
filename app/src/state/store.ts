// app/src/state/store.ts
import { create } from 'zustand';
import type { MoodAxis } from '../manifest/types';
import { blankMood } from '../dream/mood';
import { deriveSeedParams } from '../dream/seedParams';
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

// The viewer can only summon a NEW dream — never tune or edit the one they're given. So the
// store holds no dream-shaping knobs: surreality, tempo, and archive are derived from the seed
// (see dream/seedParams.ts) and applied internally, not exposed as settable state. The only
// dream actions are reseed ("New dream") and play/pause; sound on/off is a pure output control.
export interface PlayerState {
  playing: boolean;
  seed: string;
  soundOn: boolean;
  mood: Record<MoodAxis, number>;
  caption: Caption;
  // actions
  togglePlay(): void;
  reseed(seed?: string): void;
  setSound(on: boolean): void;
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
  seed: initial.seed,
  soundOn: true,
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

  reseed: (seed) => {
    const next = seed && seed.trim() ? seed.trim() : randomSeed();
    set({ seed: next });
    // Surreality + tempo are this dream's character, derived from its seed — not user input.
    const { surreality, tempo } = deriveSeedParams(next);
    get()._runtime?.reseed(next, surreality, tempo);
    writeShareState({ seed: next });
  },

  setSound: (on) => {
    set({ soundOn: on });
    get()._runtime?.setSound(on);
  },
}));

// Persist the initial seed so a freshly generated dream is shareable from the URL immediately.
writeShareState({ seed: initial.seed });
