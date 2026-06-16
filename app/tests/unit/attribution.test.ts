import { describe, it, expect } from 'vitest';
import { requiresAttribution, attributionFor } from '../../src/manifest/attribution';

describe('requiresAttribution', () => {
  it('is true for every CC-BY variant', () => {
    for (const lic of ['CC-BY', 'CC-BY-4.0', 'CC-BY-SA-4.0', 'cc-by', 'cc-by-sa']) {
      expect(requiresAttribution(lic)).toBe(true);
    }
  });

  it('is false for CC0 / public domain / unknown / missing', () => {
    for (const lic of ['CC0', 'PD', 'public domain', 'MIT', '', undefined]) {
      expect(requiresAttribution(lic)).toBe(false);
    }
  });
});

describe('attributionFor', () => {
  it('surfaces the attribution string for a CC-BY asset (mandatory rendering)', () => {
    const asset = { license: 'CC-BY-4.0', attribution: 'Photo by A. Nyman / Flickr Commons' };
    expect(attributionFor(asset)).toBe('Photo by A. Nyman / Flickr Commons');
  });

  it('returns undefined for non-attribution licenses even if an attribution string exists', () => {
    expect(attributionFor({ license: 'CC0', attribution: 'ignored' })).toBeUndefined();
    expect(attributionFor({ license: 'PD', attribution: undefined })).toBeUndefined();
  });

  it('returns undefined for a CC-BY asset with no attribution string (nothing to render)', () => {
    expect(attributionFor({ license: 'CC-BY', attribution: undefined })).toBeUndefined();
  });
});
