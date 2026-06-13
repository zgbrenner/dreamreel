// app/src/state/runtime.ts
// The boundary between the Zustand store (state + UI dispatch) and the imperative engines
// (compositor, post-FX, conductor, audio). The store holds a DreamRuntime and delegates;
// the runtime calls back into the store for caption/mood updates. Keeps the store free of
// three.js / Tone.js imports.

export interface DreamRuntime {
  play(): Promise<void>;
  pause(): void;
  setSurreality(v: number): void;
  setTempo(v: number): void;
  setSound(on: boolean): void;
  setArchive(on: boolean): void;
  /** Hard cut into a new seed (New dream / edited seed field). */
  reseed(seed: string, surreality: number, tempo: number): void;
  dispose(): void;
}
