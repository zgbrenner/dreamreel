// app/src/dream/slotHold.ts
// Round-robin layer-slot picker that respects per-slot "holds" so a video clip (or any content
// we want watched) isn't overwritten before its hold expires. Pure + deterministic; the caller
// owns the cursor and the heldUntil array (in logical-clock seconds).

export function pickSwapSlot(
  cursor: number,
  heldUntil: number[],
  clock: number,
  maxLayers: number,
): { slot: number; nextCursor: number } {
  for (let i = 0; i < maxLayers; i++) {
    const slot = (cursor + i) % maxLayers;
    if (!(heldUntil[slot] > clock)) {
      return { slot, nextCursor: cursor + i + 1 };
    }
  }
  // Every slot is held — fall back to the cursor slot so we never stall.
  return { slot: cursor % maxLayers, nextCursor: cursor + 1 };
}
