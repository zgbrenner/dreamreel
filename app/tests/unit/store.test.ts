import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { DreamRuntime } from '../../src/state/runtime';

// Minimal window/history stub (mirrors url.test.ts) so the store + url.ts run under the node
// test environment without jsdom. The store reads/writes the URL at import time, so this must
// be installed before the (reset) dynamic import in each test.
function installWindow(search = ''): void {
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

function makeFakeRuntime(): DreamRuntime {
  return {
    play: vi.fn(async () => {}),
    pause: vi.fn(),
    setSurreality: vi.fn(),
    setTempo: vi.fn(),
    setSound: vi.fn(),
    setArchive: vi.fn(),
    reseed: vi.fn(),
    dispose: vi.fn(),
  };
}

type Store = typeof import('../../src/state/store');
type Url = typeof import('../../src/state/url');

let store: Store['useStore'];
let readShareState: Url['readShareState'];
let runtime: DreamRuntime;

beforeEach(async () => {
  vi.resetModules(); // fresh store singleton per test
  installWindow();
  ({ useStore: store } = await import('../../src/state/store'));
  ({ readShareState } = await import('../../src/state/url'));
  runtime = makeFakeRuntime();
  store.getState().attachRuntime(runtime);
});

describe('store — playback', () => {
  it('togglePlay flips playing and drives the runtime', () => {
    expect(store.getState().playing).toBe(false);

    store.getState().togglePlay();
    expect(store.getState().playing).toBe(true);
    expect(runtime.play).toHaveBeenCalledTimes(1);

    store.getState().togglePlay();
    expect(store.getState().playing).toBe(false);
    expect(runtime.pause).toHaveBeenCalledTimes(1);
  });
});

describe('store — surreality & tempo', () => {
  it('setSurreality clamps to 0..1, updates state, persists to URL, and delegates', () => {
    store.getState().setSurreality(0.7);
    expect(store.getState().surreality).toBeCloseTo(0.7, 6);
    expect(runtime.setSurreality).toHaveBeenLastCalledWith(0.7);
    expect(readShareState().surreality).toBeCloseTo(0.7, 2);

    store.getState().setSurreality(5);
    expect(store.getState().surreality).toBe(1);
    store.getState().setSurreality(-3);
    expect(store.getState().surreality).toBe(0);
  });

  it('setTempo clamps to 0.5..2, updates state, persists to URL, and delegates', () => {
    store.getState().setTempo(1.75);
    expect(store.getState().tempoMul).toBeCloseTo(1.75, 6);
    expect(runtime.setTempo).toHaveBeenLastCalledWith(1.75);
    expect(readShareState().tempo).toBeCloseTo(1.75, 2);

    store.getState().setTempo(10);
    expect(store.getState().tempoMul).toBe(2);
    store.getState().setTempo(0);
    expect(store.getState().tempoMul).toBe(0.5);
  });
});

describe('store — reseed', () => {
  it('reseed() with no arg mints a fresh base36 seed, persists it, and delegates', () => {
    const before = store.getState().seed;
    store.getState().reseed();
    const after = store.getState().seed;

    expect(after).not.toBe(before);
    expect(after).toMatch(/^[0-9a-z]+$/); // base36
    expect(readShareState().seed).toBe(after);
    expect(runtime.reseed).toHaveBeenLastCalledWith(
      after,
      store.getState().surreality,
      store.getState().tempoMul,
    );
  });

  it('reseed(seed) honors the given (trimmed) seed', () => {
    store.getState().reseed('  hello-7  ');
    expect(store.getState().seed).toBe('hello-7');
    expect(readShareState().seed).toBe('hello-7');
  });
});

describe('store — sound & archive toggles delegate', () => {
  it('setSound updates state and drives the runtime', () => {
    store.getState().setSound(false);
    expect(store.getState().soundOn).toBe(false);
    expect(runtime.setSound).toHaveBeenLastCalledWith(false);
  });

  it('setArchive updates state and drives the runtime', () => {
    store.getState().setArchive(false);
    expect(store.getState().archiveOn).toBe(false);
    expect(runtime.setArchive).toHaveBeenLastCalledWith(false);
  });
});

describe('store — shareable & reloadable', () => {
  it('seed/surreality/tempo all land in the URL so a dream reloads identically', () => {
    store.getState().reseed('shareme');
    store.getState().setSurreality(0.33);
    store.getState().setTempo(1.25);

    const read = readShareState();
    expect(read.seed).toBe('shareme');
    expect(read.surreality).toBeCloseTo(0.33, 2);
    expect(read.tempo).toBeCloseTo(1.25, 2);
  });
});
