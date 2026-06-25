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

/** Sprite-sheet animation (SAM 2 video tracking): cycle a grid of frames so the cutout MOVES. */
export interface SpriteAnim {
  frames: number;
  cols: number;
  fps: number;
}

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
  // Set for animated (sprite-sheet) cutouts: the cloned, UV-windowed texture + grid info.
  animMap?: THREE.Texture;
  anim?: { frames: number; cols: number; rows: number; fps: number };
}

export class SpriteField {
  readonly group = new THREE.Group();
  private readonly active: ActiveSprite[] = [];

  constructor() {
    this.group.renderOrder = 3; // above the layer stack + ghost, below post-FX (it's in-scene)
  }

  /** Summon a cutout as a fading, drifting quad. `aspect` = width / height of one frame. When
   *  `anim` (a sprite sheet, frames > 1) is given, the quad's UVs cycle so the figure moves. */
  summon(texture: THREE.Texture, aspect: number, p: SpritePlacement, elapsed: number, anim?: SpriteAnim): void {
    const h = p.scale;
    const w = h * Math.max(0.05, aspect);

    const animated = !!anim && anim.frames > 1;
    let map = texture;
    let animState: ActiveSprite['anim'];
    let animMap: THREE.Texture | undefined;
    if (animated) {
      const a = anim as SpriteAnim;
      const rows = Math.ceil(a.frames / a.cols);
      // Clone so this summon owns its UV window (independent of other active copies of the sheet).
      map = texture.clone();
      map.needsUpdate = true;
      map.wrapS = THREE.RepeatWrapping;
      map.wrapT = THREE.RepeatWrapping;
      map.repeat.set(1 / a.cols, 1 / rows);
      animMap = map;
      animState = { frames: a.frames, cols: a.cols, rows, fps: a.fps > 0 ? a.fps : 10 };
    }

    const mat = new THREE.MeshBasicMaterial({
      map,
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
    this.active.push({
      mesh, mat, born: elapsed, life: p.life, peak: p.opacity, vx: p.vx, vy: p.vy, x: p.x, y: p.y,
      animMap, anim: animState,
    });
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
      // Animated sheet: advance the UV window to the current frame (looping). Image rows are
      // top-down but UV origin is bottom-left, so the row offset is flipped.
      if (s.anim && s.animMap) {
        const f = Math.floor((elapsed - s.born) * s.anim.fps) % s.anim.frames;
        const col = f % s.anim.cols;
        const row = Math.floor(f / s.anim.cols);
        s.animMap.offset.set(col / s.anim.cols, (s.anim.rows - 1 - row) / s.anim.rows);
      }
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
    // A static cutout's texture is owned by the conductor's cache (shared) — not disposed here.
    // An animated cutout's UV-windowed clone IS owned by this sprite, so dispose it.
    s.animMap?.dispose();
  }

  dispose(): void {
    for (const s of [...this.active]) this.expire(s);
  }
}
