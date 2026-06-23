import { test, expect, type Page } from '@playwright/test';

const RUN_SECONDS = Number(process.env.SMOKE_SECONDS ?? 30);
// Wake mode is the new default-intended experience (intensity-driven chaos engine),
// reachable via ?wake=1. A shorter window keeps CI fast while still exercising several
// intensity sweeps and layer-swaps.
const WAKE_SECONDS = Number(process.env.SMOKE_SECONDS ?? 20);

// The seed manifest references third-party public-domain images (e.g. Wikimedia Commons)
// that the browser may refuse to load over CORS in a headless/offline run. The app is
// designed to treat any asset load failure as a graceful fallback to a procedural source
// (never a black frame — see render/textureLoader.ts), so these browser-emitted network
// messages are NOT app errors. We filter them out and still assert that the app's own
// code (shader compile, three.js, wake-path) logs ZERO errors.
function isIgnorableNetworkError(text: string): boolean {
  return (
    /blocked by CORS policy/i.test(text) ||
    /Failed to load resource/i.test(text) ||
    /net::ERR_/i.test(text) ||
    /ERR_FAILED/i.test(text)
  );
}

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error' && !isIgnorableNetworkError(msg.text())) errors.push(msg.text());
  });
  page.on('pageerror', (err) => {
    if (!isIgnorableNetworkError(err.message)) errors.push(`pageerror: ${err.message}`);
  });
  return errors;
}

async function readHeap(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ??
      0,
  );
}

async function playAndAssert(page: Page, runSeconds: number, errors: string[]): Promise<void> {
  // Manifest loads and the idle gate appears.
  await expect(page.getByRole('heading', { name: 'Dreamreel' })).toBeVisible({ timeout: 15_000 });

  const canvas = page.locator('canvas');
  await expect(canvas).toBeVisible();
  const box = await canvas.boundingBox();
  expect(box?.width ?? 0).toBeGreaterThan(0);
  expect(box?.height ?? 0).toBeGreaterThan(0);

  // Press play (a real user gesture, also satisfies audio autoplay policy).
  await page.getByRole('button', { name: /play/i }).first().click();

  const heapStart = await readHeap(page);

  // Let the dream run.
  await page.waitForTimeout(runSeconds * 1000);

  const heapEnd = await readHeap(page);

  // The reel should still be there.
  await expect(canvas).toBeVisible();

  // Bounded heap growth: allow generous headroom but catch a real leak (only when measurable).
  if (heapStart > 0 && heapEnd > 0) {
    expect(heapEnd).toBeLessThan(heapStart * 3 + 80 * 1024 * 1024);
  }

  expect(errors, `console errors:\n${errors.join('\n')}`).toEqual([]);
}

test('DREAMREEL classic mode (?wake=0) loads, plays, and runs without console errors or runaway heap', async ({
  page,
}) => {
  test.setTimeout((RUN_SECONDS + 40) * 1000);
  const errors = collectErrors(page);
  // Wake is now the default; ?wake=0 opts back into the classic three-clock reel.
  await page.goto('/?wake=0');
  await playAndAssert(page, RUN_SECONDS, errors);
});

test('DREAMREEL wake mode (default) loads, plays, and runs without console errors or runaway heap', async ({
  page,
}) => {
  test.setTimeout((WAKE_SECONDS + 40) * 1000);
  const errors = collectErrors(page);
  // No param -> wake (the default-intended experience).
  await page.goto('/');
  await playAndAssert(page, WAKE_SECONDS, errors);
});
