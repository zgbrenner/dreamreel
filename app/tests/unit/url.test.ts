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

  it('round-trips the seed through the URL — the only shareable dream param', async () => {
    const { writeShareState, readShareState } = await import('../../src/state/url');
    writeShareState({ seed: 'abc123' });
    expect(readShareState().seed).toBe('abc123');
  });

  it('drops any legacy s=/t= params on write (surreality/tempo are seed-derived now)', async () => {
    installWindow('?seed=keep&s=0.7&t=1.25');
    const { writeShareState } = await import('../../src/state/url');
    writeShareState({ seed: 'keep' });
    const search = window.location.search;
    expect(search).toContain('seed=keep');
    expect(search).not.toContain('s=');
    expect(search).not.toContain('t=');
  });

  it('supplies a random seed when absent', async () => {
    installWindow();
    const { readShareState } = await import('../../src/state/url');
    expect(readShareState().seed.length).toBeGreaterThan(0);
  });
});

describe('wake flag', () => {
  it('defaults wake ON, and only ?wake=0 / ?wake=false opt out', async () => {
    const { readShareState } = await import('../../src/state/url');
    // Default (no param): wake is the default-intended experience -> ON.
    installWindow();
    expect(readShareState().wake).toBe(true);
    // Explicit opt-out.
    installWindow('?wake=0');
    expect(readShareState().wake).toBe(false);
    installWindow('?wake=false');
    expect(readShareState().wake).toBe(false);
    // Explicit opt-in still works.
    installWindow('?wake=1');
    expect(readShareState().wake).toBe(true);
    installWindow('?wake=true');
    expect(readShareState().wake).toBe(true);
  });
});
