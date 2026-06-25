// app/src/render/SpriteField.ts
// The literal-recurrence layer: when the dream strongly remembers an entity, the conductor summons
// its segmented cutout (an RGBA PNG, extracted offline by Grounding DINO + SAM 2) here as a soft,
// drifting, fading ghost quad — the actual fragment of an earlier scene returns. Added to the
// compositor's stage scene via addOverlay, so cutouts pass through the same film grade as the dream
// (they read as part of it, never pasted-on UI).
//
// No randomness of its own: placements are computed by the conductor from a seeded RNG and passed
// in, so summoning is deterministic per seed. Lifecycle is dt/elapsed-driven (cosmetic, like dust).

import * as THREE from 'three';
import type { Rng } from '../dream/prng';

/** A deterministic placement for a summoned cutout, drawn from a seeded RNG by the conductor. */
export interface SpritePlacement {
  x: number; // centre, NDC [-1, 1]
  y: number;
  scale: number; // quad HEIGHT in NDC units (width = scale * aspect)
  vx: number; // drift velocity, NDC/sec
  vy: number;
  life: number; // seconds visible
  opacity: number; // peak opacity (kept low — a ghost, not a sticker)
}

const MAX_ACTIVE = 3;

/** Draw a deterministic, dreamlike placement from a seeded RNG. Pure. */
export function makeSpritePlacement(rng: Rng): SpritePlacement {
  return {
    x: (rng.next() * 2 - 1) * 0.6, // kept off the dead-centre, within frame
    y: (rng.next() * 2 - 1) * 0.55,
    scale: 0.32 + rng.next() * 0.5, // ~a third to most of the frame height
    vx: (rng.next() * 2 - 1) * 0.04, // a slow drift
    vy: (rng.next() * 2 - 1) * 0.03,
    life: 4 + rng.next() * 5, // 4–9 s
    opacity: 0.28 + rng.next() * 0.24, // 0.28–0.52 — faint
  };
}

interface ActiveSprite {
  mesh: THREE.Mesh;
  mat: THREE.MeshBasicMaterial;
  born: number;
  life: number;
  peak: number;
  vx: number;
  vy: number;
  x: number;
  y: number;
}

export class SpriteField {
  readonly group = new THREE.Group();
  private readonly active: ActiveSprite[] = [];

  constructor() {
    this.group.renderOrder = 3; // above the layer stack + ghost, below post-FX (it's in-scene)
  }

  /** Summon a cutout texture as a fading, drifting quad. `aspect` = width / height. */
  summon(texture: THREE.Texture, aspect: number, p: SpritePlacement, elapsed: number): void {
    const h = p.scale;
    const w = h * Math.max(0.05, aspect);
    const mat = new THREE.MeshBasicMaterial({
      map: texture,
      transparent: true,
      opacity: 0,
      depthTest: false,
      depthWrite: false,
    });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
    mesh.position.set(p.x, p.y, 0);
    mesh.frustumCulled = false;
    mesh.renderOrder = 3;
    this.group.add(mesh);
    this.active.push({ mesh, mat, born: elapsed, life: p.life, peak: p.opacity, vx: p.vx, vy: p.vy, x: p.x, y: p.y });
    while (this.active.length > MAX_ACTIVE) this.expire(this.active[0]);
  }

  /** Drift + fade active cutouts; retire expired ones. */
  update(dt: number, elapsed: number): void {
    for (const s of [...this.active]) {
      const t = (elapsed - s.born) / s.life;
      if (t >= 1 || t < 0) {
        this.expire(s);
        continue;
      }
      // A sine envelope: fade in, hold, fade out — never a hard pop.
      s.mat.opacity = Math.sin(t * Math.PI) * s.peak;
      s.x += s.vx * dt;
      s.y += s.vy * dt;
      s.mesh.position.set(s.x, s.y, 0);
    }
  }

  /** Number of cutouts currently on screen (for tests). */
  activeCount(): number {
    return this.active.length;
  }

  private expire(s: ActiveSprite): void {
    const i = this.active.indexOf(s);
    if (i !== -1) this.active.splice(i, 1);
    this.group.remove(s.mesh);
    s.mesh.geometry.dispose();
    s.mat.dispose();
    // The texture is owned by the conductor's sprite cache (shared across summons) — not disposed here.
  }

  dispose(): void {
    for (const s of [...this.active]) this.expire(s);
  }
}
