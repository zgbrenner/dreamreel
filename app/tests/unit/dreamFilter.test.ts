import { describe, it, expect } from 'vitest';
import { DreamFilter } from '../../src/render/DreamFilter';

const U = ['uKaleido', 'uLiquid', 'uSolarize', 'uMelt', 'uPosterize'];

describe('DreamFilter', () => {
  it('defaults every filter strength to 0 (identity passthrough)', () => {
    const fx = new DreamFilter();
    for (const u of U) expect((fx.uniforms.get(u) as { value: number }).value).toBe(0);
  });

  it('setStrengths writes the five fragment-filter uniforms', () => {
    const fx = new DreamFilter();
    fx.setStrengths({ kaleidoscope: 0.1, liquid: 0.2, solarize: 0.3, melt: 0.4, posterize: 0.5, feedback: 0.9 });
    expect((fx.uniforms.get('uKaleido') as { value: number }).value).toBeCloseTo(0.1);
    expect((fx.uniforms.get('uLiquid') as { value: number }).value).toBeCloseTo(0.2);
    expect((fx.uniforms.get('uSolarize') as { value: number }).value).toBeCloseTo(0.3);
    expect((fx.uniforms.get('uMelt') as { value: number }).value).toBeCloseTo(0.4);
    expect((fx.uniforms.get('uPosterize') as { value: number }).value).toBeCloseTo(0.5);
    expect(fx.uniforms.has('uFeedback')).toBe(false);
  });
});
