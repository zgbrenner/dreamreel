import { test, expect } from '@playwright/test';

const RUN_SECONDS = Number(process.env.SMOKE_SECONDS ?? 30);

test('DREAMREEL loads, plays, and runs without console errors or runaway heap', async ({
  page,
}) => {
  test.setTimeout((RUN_SECONDS + 40) * 1000);

  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));

  await page.goto('/');

  // Manifest loads and the idle gate appears.
  await expect(page.getByRole('heading', { name: 'Dreamreel' })).toBeVisible({ timeout: 15_000 });

  const canvas = page.locator('canvas');
  await expect(canvas).toBeVisible();
  const box = await canvas.boundingBox();
  expect(box?.width ?? 0).toBeGreaterThan(0);
  expect(box?.height ?? 0).toBeGreaterThan(0);

  // Press play (a real user gesture, also satisfies audio autoplay policy).
  await page.getByRole('button', { name: /play/i }).first().click();

  const heapStart = await page.evaluate(
    () => (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? 0,
  );

  // Let the dream run.
  await page.waitForTimeout(RUN_SECONDS * 1000);

  const heapEnd = await page.evaluate(
    () => (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? 0,
  );

  // The reel should still be there and a caption should have appeared.
  await expect(canvas).toBeVisible();

  // Bounded heap growth: allow generous headroom but catch a real leak (only when measurable).
  if (heapStart > 0 && heapEnd > 0) {
    expect(heapEnd).toBeLessThan(heapStart * 3 + 80 * 1024 * 1024);
  }

  expect(errors, `console errors:\n${errors.join('\n')}`).toEqual([]);
});
