import { describe, it, expect, beforeEach } from 'vitest';

// Minimal window/history stub so url.ts can run under the node test environment without jsdom.
function installWindow(search = '') {
  let href = `http://localhost/${search}`;
  const stub = {
    location: {
      get search() {
        return new URL(href).search;
      },
      get pathname() {
        return new URL(href).pathname;
      },
    },
    history: {
      replaceState: (_s: unknown, _t: string, url: string) => {
        href = new URL(url, 'http://localhost/').toString();
      },
    },
  };
  (globalThis as unknown as { window: typeof stub }).window = stub;
}

describe('shareable URL state', () => {
  beforeEach(() => installWindow());

  it('round-trips seed/surreality/tempo through the URL', async () => {
    const { writeShareState, readShareState } = await import('../../src/state/url');
    writeShareState({ seed: 'abc123', surreality: 0.7, tempo: 1.25 });
    const read = readShareState();
    expect(read.seed).toBe('abc123');
    expect(read.surreality).toBeCloseTo(0.7, 2);
    expect(read.tempo).toBeCloseTo(1.25, 2);
  });

  it('clamps out-of-range values and supplies a random seed when absent', async () => {
    installWindow('?s=9&t=-1');
    const { readShareState } = await import('../../src/state/url');
    const read = readShareState();
    expect(read.surreality).toBeLessThanOrEqual(1);
    expect(read.tempo).toBeGreaterThanOrEqual(0.5);
    expect(read.seed.length).toBeGreaterThan(0);
  });
});

describe('wake flag', () => {
  it('readShareState reads ?wake=1 as true and defaults false', async () => {
    installWindow('?wake=1');
    const { readShareState } = await import('../../src/state/url');
    expect(readShareState().wake).toBe(true);
    installWindow();
    expect(readShareState().wake).toBe(false);
  });
});
