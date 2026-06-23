// app/src/state/url.ts
// Shareable state lives in URL params (?seed=&s=&t=), never browser storage — so a dream is
// reproducible from a link. localStorage is reserved for non-essential UI prefs only.

export interface ShareState {
  seed: string;
  surreality: number;
  tempo: number;
  wake?: boolean;
}

export function randomSeed(): string {
  return Math.floor(Math.random() * 0xffffffff).toString(36) + Date.now().toString(36).slice(-3);
}

export function readShareState(): ShareState {
  const q = new URLSearchParams(window.location.search);
  const seed = q.get('seed') || randomSeed();
  const surreality = clampNum(parseFloat(q.get('s') ?? ''), 0, 1, 0.45);
  const tempo = clampNum(parseFloat(q.get('t') ?? ''), 0.5, 2, 1);
  // Wake mode is the default-intended experience: ON unless explicitly disabled with
  // ?wake=0 (or ?wake=false). The classic three-clock reel remains reachable as an opt-out.
  const wakeParam = q.get('wake');
  const wake = wakeParam !== '0' && wakeParam !== 'false';
  return { seed, surreality, tempo, wake };
}

export function writeShareState(s: ShareState): void {
  const q = new URLSearchParams(window.location.search);
  q.set('seed', s.seed);
  q.set('s', s.surreality.toFixed(2));
  q.set('t', s.tempo.toFixed(2));
  const url = `${window.location.pathname}?${q.toString()}`;
  window.history.replaceState(null, '', url);
}

function clampNum(v: number, lo: number, hi: number, fallback: number): number {
  if (Number.isNaN(v)) return fallback;
  return Math.max(lo, Math.min(hi, v));
}
