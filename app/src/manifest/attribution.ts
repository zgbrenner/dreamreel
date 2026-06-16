// app/src/manifest/attribution.ts
// Single source of truth for the licensing "hard constraint" (CLAUDE.md): CC-BY assets may
// ship only if their attribution is rendered on screen. Both the conductor (which builds the
// caption) and the Captions strip (which renders it) go through here so the rule can't drift.

import type { Asset } from './types';

/** True when a license obliges us to show attribution (any CC-BY variant). */
export function requiresAttribution(license: string | undefined): boolean {
  return (license ?? '').toUpperCase().startsWith('CC-BY');
}

/**
 * The attribution string to display for an asset, or undefined when none is required (CC0/PD)
 * or none is available. A CC-BY asset with no attribution string yields undefined — there is
 * nothing to render — which the pipeline's license gate is responsible for preventing.
 */
export function attributionFor(asset: Pick<Asset, 'license' | 'attribution'>): string | undefined {
  return requiresAttribution(asset.license) ? asset.attribution : undefined;
}
