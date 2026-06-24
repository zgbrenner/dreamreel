// app/src/state/url.ts
// Shareable state lives in the URL, never browser storage — so a dream is reproducible from a
// link. The viewer cannot tune a dream; surreality and tempo are derived from the seed (see
// dream/seedParams.ts), so ?seed= is the ONLY shareable dream param. (?wake= is a non-UI engine
// mode flag, not a dream-shaping control.) localStorage is reserved for non-essential UI prefs.

export interface ShareState {
  seed: string;
  wake: boolean;
  /** Non-UI engine flag: opt IN to the optional psychedelic Butterchurn layer with ?butterchurn=1. */
  butterchurn: boolean;
}

export function randomSeed(): string {
  return Math.floor(Math.random() * 0xffffffff).toString(36) + Date.now().toString(36).slice(-3);
}

export function readShareState(): ShareState {
  const q = new URLSearchParams(window.location.search);
  const seed = q.get('seed') || randomSeed();
  // Wake mode is the default-intended experience: ON unless explicitly disabled with
  // ?wake=0 (or ?wake=false). The classic three-clock reel remains reachable as an opt-out.
  const wakeParam = q.get('wake');
  const wake = wakeParam !== '0' && wakeParam !== 'false';
  // Butterchurn is OFF by default (optional packages + preset licensing must be vetted first);
  // opt in explicitly with ?butterchurn=1 (or =true).
  const bcParam = q.get('butterchurn');
  const butterchurn = bcParam === '1' || bcParam === 'true';
  return { seed, wake, butterchurn };
}

export function writeShareState(s: { seed: string }): void {
  const q = new URLSearchParams(window.location.search);
  q.set('seed', s.seed);
  // Surreality/tempo are seed-derived, not shareable params — never written to the URL.
  q.delete('s');
  q.delete('t');
  const url = `${window.location.pathname}?${q.toString()}`;
  window.history.replaceState(null, '', url);
}
