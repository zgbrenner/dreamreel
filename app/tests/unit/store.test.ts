import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { DreamRuntime } from '../../src/state/runtime';
import { deriveSeedParams } from '../../src/dream/seedParams';

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

describe('store — reseed (the only dream-shaping action)', () => {
  it('reseed() with no arg mints a fresh base36 seed, persists it, and delegates seed-derived params', () => {
    const before = store.getState().seed;
    store.getState().reseed();
    const after = store.getState().seed;

    expect(after).not.toBe(before);
    expect(after).toMatch(/^[0-9a-z]+$/); // base36
    expect(readShareState().seed).toBe(after);
    // Surreality + tempo are derived from the new seed, not read from any settable state.
    const { surreality, tempo } = deriveSeedParams(after);
    expect(runtime.reseed).toHaveBeenLastCalledWith(after, surreality, tempo);
  });

  it('reseed(seed) honors the given (trimmed) seed', () => {
    store.getState().reseed('  hello-7  ');
    expect(store.getState().seed).toBe('hello-7');
    expect(readShareState().seed).toBe('hello-7');
  });
});

describe('store — sound (a pure output control, not a dream knob)', () => {
  it('setSound updates state and drives the runtime', () => {
    store.getState().setSound(false);
    expect(store.getState().soundOn).toBe(false);
    expect(runtime.setSound).toHaveBeenLastCalledWith(false);
  });
});

describe('store — shareable & reloadable', () => {
  it('only the seed lands in the URL so a dream reloads identically', () => {
    store.getState().reseed('shareme');
    expect(readShareState().seed).toBe('shareme');
  });
});
