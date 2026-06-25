import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { SpriteField, makeSpritePlacement, type SpritePlacement } from '../../src/render/SpriteField';
import { makeRng } from '../../src/dream/prng';

const tex = () => new THREE.Texture();
const place = (life = 5, opacity = 0.5, vx = 0.1): SpritePlacement => ({
  x: 0,
  y: 0,
  scale: 0.4,
  vx,
  vy: 0,
  life,
  opacity,
});

describe('makeSpritePlacement', () => {
  it('is deterministic per seed and stays within frame bounds', () => {
    const p1 = makeSpritePlacement(makeRng('s'));
    const p2 = makeSpritePlacement(makeRng('s'));
    expect(p1).toEqual(p2);
    expect(Math.abs(p1.x)).toBeLessThanOrEqual(0.6);
    expect(Math.abs(p1.y)).toBeLessThanOrEqual(0.55);
    expect(p1.scale).toBeGreaterThan(0.3);
    expect(p1.life).toBeGreaterThanOrEqual(4);
    expect(p1.opacity).toBeLessThan(0.6); // a faint ghost
  });

  it('different seeds give different placements', () => {
    expect(makeSpritePlacement(makeRng('a'))).not.toEqual(makeSpritePlacement(makeRng('b')));
  });
});

describe('SpriteField', () => {
  it('summon adds a quad; update fades on a sine envelope + drifts; expires after life', () => {
    const f = new SpriteField();
    f.summon(tex(), 1, place(4, 0.5, 0.1), 0);
    expect(f.activeCount()).toBe(1);
    expect(f.group.children.length).toBe(1);

    f.update(2, 2); // t = 0.5 → opacity sin(π/2)*0.5 = 0.5; drift x += 0.1*2
    const mesh = f.group.children[0] as THREE.Mesh;
    const mat = mesh.material as THREE.MeshBasicMaterial;
    expect(mat.opacity).toBeCloseTo(0.5, 5);
    expect(mesh.position.x).toBeCloseTo(0.2, 5);

    f.update(3, 5); // elapsed 5 ≥ born(0)+life(4) → retired
    expect(f.activeCount()).toBe(0);
    expect(f.group.children.length).toBe(0);
  });

  it('caps the number of concurrent cutouts', () => {
    const f = new SpriteField();
    for (let i = 0; i < 6; i++) f.summon(tex(), 1, place(), i * 0.1);
    expect(f.activeCount()).toBeLessThanOrEqual(3);
  });

  it('animated sprite sheets clone the texture, window the UVs, and cycle frames', () => {
    const f = new SpriteField();
    const base = tex();
    // 4 frames in a 2-col grid → 2 rows → each cell is half the sheet.
    f.summon(base, 1, place(10, 0.5, 0), 0, { frames: 4, cols: 2, fps: 10 });
    const mesh = f.group.children[0] as THREE.Mesh;
    const map = (mesh.material as THREE.MeshBasicMaterial).map!;
    expect(map).not.toBe(base); // cloned, so its UV window is independent
    expect(map.repeat.x).toBeCloseTo(0.5, 5);
    expect(map.repeat.y).toBeCloseTo(0.5, 5);

    // frame 0 (col 0, row 0) → bottom row in UV space (offset.y = 0.5)
    f.update(0.0, 0.0);
    expect(map.offset.x).toBeCloseTo(0, 5);
    expect(map.offset.y).toBeCloseTo(0.5, 5);

    // at 0.1 s, fps 10 → frame 1 (col 1, row 0)
    f.update(0.1, 0.1);
    expect(map.offset.x).toBeCloseTo(0.5, 5);
    expect(map.offset.y).toBeCloseTo(0.5, 5);

    // at 0.25 s → frame 2 (col 0, row 1) → top row in UV space (offset.y = 0)
    f.update(0.15, 0.25);
    expect(map.offset.x).toBeCloseTo(0, 5);
    expect(map.offset.y).toBeCloseTo(0, 5);
  });

  it('dispose clears everything', () => {
    const f = new SpriteField();
    f.summon(tex(), 1, place(), 0);
    f.dispose();
    expect(f.activeCount()).toBe(0);
    expect(f.group.children.length).toBe(0);
  });
});
