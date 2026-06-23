// Pure ducking policy: given which buses want focus, return a per-bus gain trim in dB. The
// mixer applies these (ramped) only to buses that currently have a source. Priority order is
// voice ~= filmclip > music > foley > bed.

export type BusName = 'bed' | 'music' | 'foley' | 'voice' | 'filmclip';

export interface FocusState {
  voice: boolean;
  filmclip: boolean;
  music: boolean;
  foley: boolean;
}

export function busGainsDb(focus: FocusState): Record<BusName, number> {
  const focusActive = focus.voice || focus.filmclip;
  return {
    voice: 0,
    filmclip: 0,
    music: focusActive ? -9 : 0,
    foley: focusActive ? -6 : -3,
    bed: focusActive ? -10 : -5,
  };
}
