// app/src/render/dust.ts
// Dust specks and scratches rendered as textured quads / point sprites — the documented
// performance path (not per-pixel in the grain shader). Lives inside the compositor scene
// so it shares the single render pass and receives the film treatment uniformly.

import * as THREE from 'three';
import { makeRng } from '../dream/prng';

function speckTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = c.height = 32;
  const ctx = c.getContext('2d')!;
  const g = ctx.createRadialGradient(16, 16, 0, 16, 16, 16);
  g.addColorStop(0, 'rgba(232,228,214,0.9)');
  g.addColorStop(1, 'rgba(232,228,214,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 32, 32);
  const t = new THREE.CanvasTexture(c);
  t.userData.ownedByCompositor = false;
  return t;
}

export class DustField {
  readonly group = new THREE.Group();
  private readonly points: THREE.Points;
  private readonly positions: Float32Array;
  private readonly vel: Float32Array;
  private readonly scratches: THREE.Mesh[] = [];
  private readonly rng = makeRng('dust');
  private readonly count: number;
  private intensity = 1;
  // Wake-heartbeat gate (1 = classic full dust). PostFX.setWakeEnergy drives this in wake mode so
  // the specks/scratches all but vanish at the coherent baseline and return with escalation.
  private energy = 1;

  constructor(count = 60) {
    this.count = count;
    this.positions = new Float32Array(count * 3);
    this.vel = new Float32Array(count * 2);
    for (let i = 0; i < count; i++) {
      this.positions[i * 3] = this.rng.next() * 2 - 1;
      this.positions[i * 3 + 1] = this.rng.next() * 2 - 1;
      this.positions[i * 3 + 2] = 0;
      this.vel[i * 2] = (this.rng.next() - 0.5) * 0.04;
      this.vel[i * 2 + 1] = -(0.05 + this.rng.next() * 0.12);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    const mat = new THREE.PointsMaterial({
      map: speckTexture(),
      size: 0.02,
      transparent: true,
      opacity: 0.5,
      depthTest: false,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      sizeAttenuation: false,
    });
    this.points = new THREE.Points(geo, mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 5;
    this.group.add(this.points);

    // a few vertical scratches that blink in and out
    const scMat = new THREE.MeshBasicMaterial({
      color: 0xd8d2c4,
      transparent: true,
      opacity: 0,
      depthTest: false,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    for (let i = 0; i < 3; i++) {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(0.004, 2), scMat.clone());
      m.position.x = this.rng.next() * 2 - 1;
      m.frustumCulled = false;
      m.renderOrder = 5;
      this.scratches.push(m);
      this.group.add(m);
    }
  }

  setIntensity(reduceMotion: boolean): void {
    this.intensity = reduceMotion ? 0.35 : 1;
    this.applyOpacity();
  }

  /** 0..1 wake-intensity gate on speck/scratch visibility (classic never calls this; stays 1). */
  setEnergy(energy: number): void {
    this.energy = Math.max(0, Math.min(1, energy));
    this.applyOpacity();
  }

  private applyOpacity(): void {
    (this.points.material as THREE.PointsMaterial).opacity = 0.5 * this.intensity * this.energy;
  }

  update(dt: number, elapsed: number): void {
    const p = this.positions;
    for (let i = 0; i < this.count; i++) {
      p[i * 3] += this.vel[i * 2] * dt * this.intensity;
      p[i * 3 + 1] += this.vel[i * 2 + 1] * dt * this.intensity;
      if (p[i * 3 + 1] < -1) {
        p[i * 3 + 1] = 1;
        p[i * 3] = this.rng.next() * 2 - 1;
      }
      if (p[i * 3] < -1) p[i * 3] = 1;
      if (p[i * 3] > 1) p[i * 3] = -1;
    }
    this.points.geometry.attributes.position.needsUpdate = true;

    for (let i = 0; i < this.scratches.length; i++) {
      const s = this.scratches[i];
      const phase = Math.sin(elapsed * (0.7 + i * 0.5) + i * 2.1);
      const on = phase > 0.85 ? (phase - 0.85) / 0.15 : 0;
      const mat = s.material as THREE.MeshBasicMaterial;
      mat.opacity = on * 0.25 * this.intensity * this.energy;
      // when a scratch fades out, re-place it for the next blink (seeded, deterministic).
      if (on <= 0.001) s.position.x = this.rng.next() * 2 - 1;
    }
  }

  dispose(): void {
    this.points.geometry.dispose();
    (this.points.material as THREE.PointsMaterial).map?.dispose();
    (this.points.material as THREE.PointsMaterial).dispose();
    for (const s of this.scratches) {
      s.geometry.dispose();
      (s.material as THREE.Material).dispose();
    }
  }
}
