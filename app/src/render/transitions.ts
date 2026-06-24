// app/src/render/transitions.ts
// GLSL transitions conforming to the gl-transitions v1 spec: each exposes a
//   vec4 transition(vec2 uv)
// body that may call getFromColor(uv) / getToColor(uv) and read the `progress` (0..1)
// and `ratio` uniforms. These are original implementations of the spec shape; the spec
// itself and the reference transitions are MIT (see NOTICE).

export interface TransitionDef {
  name: string;
  /** GLSL body of `vec4 transition(vec2 uv)`, including the closing brace's contents. */
  glsl: string;
}

// A soft cross-dissolve.
const fade: TransitionDef = {
  name: 'fade',
  glsl: /* glsl */ `
    vec4 transition(vec2 uv) {
      return mix(getFromColor(uv), getToColor(uv), progress);
    }
  `,
};

// A film-burn / dissolve: a value-noise threshold sweeps across, with a hot amber
// "burn" rim where the old frame is being eaten away — the signature reel decay.
const filmBurn: TransitionDef = {
  name: 'filmBurn',
  glsl: /* glsl */ `
    float hash(vec2 p) {
      p = fract(p * vec2(123.34, 345.45));
      p += dot(p, p + 34.345);
      return fract(p.x * p.y);
    }
    float vnoise(vec2 p) {
      vec2 i = floor(p), f = fract(p);
      f = f * f * (3.0 - 2.0 * f);
      float a = hash(i), b = hash(i + vec2(1.0, 0.0));
      float c = hash(i + vec2(0.0, 1.0)), d = hash(i + vec2(1.0, 1.0));
      return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
    }
    vec4 transition(vec2 uv) {
      float n = vnoise(uv * vec2(ratio, 1.0) * 9.0);
      float edge = 0.16;
      float t = smoothstep(n - edge, n + edge, progress);
      vec4 from = getFromColor(uv);
      vec4 to = getToColor(uv);
      // burn rim: a thin band near the dissolve front glows amber.
      float band = 1.0 - abs((progress - n) / edge);
      band = clamp(band, 0.0, 1.0);
      vec3 burn = vec3(0.78, 0.50, 0.18) * band * (1.0 - progress);
      vec4 mixed = mix(from, to, t);
      mixed.rgb += burn;
      return mixed;
    }
  `,
};

// A directional wipe with a soft feathered seam (left-to-right).
const wipe: TransitionDef = {
  name: 'wipe',
  glsl: /* glsl */ `
    vec4 transition(vec2 uv) {
      float feather = 0.08;
      float edge = progress * (1.0 + feather) - feather * 0.5;
      float t = smoothstep(edge - feather, edge + feather, uv.x);
      // t==1 -> still showing "from" on the right; invert so wipe reveals "to".
      return mix(getToColor(uv), getFromColor(uv), t);
    }
  `,
};

// A dream-dissolve: the outgoing frame swirls and drifts outward while the incoming frame
// melts in through a soft luminance threshold — the picture seems to come apart like a
// half-remembered image rather than cutting.
const dreamWarp: TransitionDef = {
  name: 'dreamWarp',
  glsl: /* glsl */ `
    vec4 transition(vec2 uv) {
      vec2 c = uv - 0.5;
      float r = length(c);
      float ang = atan(c.y, c.x);
      // outgoing frame swirls + drifts outward as it leaves
      float swirl = (1.0 - progress) * 0.0 + progress * 1.6;
      float fa = ang + swirl * (0.6 - r);
      vec2 fromUv = 0.5 + vec2(cos(fa), sin(fa)) * r * (1.0 + progress * 0.18);
      // incoming frame eases in from a gentle inward drift
      vec2 toUv = 0.5 + c * (1.0 + (1.0 - progress) * 0.12);
      vec4 from = getFromColor(clamp(fromUv, 0.0, 1.0));
      vec4 to = getToColor(clamp(toUv, 0.0, 1.0));
      // luminance-led melt so brighter regions of the new frame bloom in first
      float lum = dot(to.rgb, vec3(0.299, 0.587, 0.114));
      float t = smoothstep(0.0, 1.0, progress * 1.3 - (1.0 - lum) * 0.3);
      return mix(from, to, clamp(t, 0.0, 1.0));
    }
  `,
};

// A halation flash: the frame blooms to warm white at the midpoint, then resolves on the new
// image — like a projector lamp surging during a splice. Quintessential dream punctuation.
const lightFlash: TransitionDef = {
  name: 'lightFlash',
  glsl: /* glsl */ `
    vec4 transition(vec2 uv) {
      vec4 from = getFromColor(uv);
      vec4 to = getToColor(uv);
      vec4 base = mix(from, to, smoothstep(0.25, 0.75, progress));
      // a warm bloom that peaks at the crossover and falls away
      float flash = sin(progress * 3.14159);
      vec3 bloom = vec3(1.0, 0.92, 0.78) * flash * flash;
      return vec4(base.rgb + bloom, base.a);
    }
  `,
};

// ============================================================================
// Expanded mood-mapped catalog. These are original implementations of the
// gl-transitions v1 spec shape (vec4 transition(vec2 uv)); no shader source was
// copied verbatim. The spec + reference collection are MIT — see app/NOTICE.
// dream/filterDirector.ts maps blended emotion + intensity to a CHOICE among
// these; the names below are the contract it selects from.
// ============================================================================

// An instant hard cut at the midpoint — fear/ominous punctuation.
const cut: TransitionDef = {
  name: 'cut',
  glsl: /* glsl */ `
    vec4 transition(vec2 uv) {
      return progress < 0.5 ? getFromColor(uv) : getToColor(uv);
    }
  `,
};

// Venetian-bar wipe: horizontal slats fill in — mechanical/ominous.
const barWipe: TransitionDef = {
  name: 'barWipe',
  glsl: /* glsl */ `
    vec4 transition(vec2 uv) {
      float bars = 14.0;
      float local = fract(uv.y * bars);
      float t = step(local, progress);
      return mix(getFromColor(uv), getToColor(uv), t);
    }
  `,
};

// Luminance-led dissolve: brighter regions of the new frame resolve first — melancholy/loss.
const crossLuma: TransitionDef = {
  name: 'crossLuma',
  glsl: /* glsl */ `
    vec4 transition(vec2 uv) {
      vec4 from = getFromColor(uv);
      vec4 to = getToColor(uv);
      float lum = dot(to.rgb, vec3(0.299, 0.587, 0.114));
      float t = smoothstep(0.0, 1.0, progress * 1.4 - (1.0 - lum) * 0.4);
      return mix(from, to, clamp(t, 0.0, 1.0));
    }
  `,
};

// A luminous bloom dissolve — tender/love/joy: the crossover glows warm.
const bloomDissolve: TransitionDef = {
  name: 'bloomDissolve',
  glsl: /* glsl */ `
    vec4 transition(vec2 uv) {
      vec4 from = getFromColor(uv);
      vec4 to = getToColor(uv);
      vec4 base = mix(from, to, smoothstep(0.0, 1.0, progress));
      float bloom = sin(progress * 3.14159);
      base.rgb += vec3(0.9, 0.85, 0.7) * bloom * bloom * 0.6;
      return base;
    }
  `,
};

// A rotational swirl of the outgoing frame as the new one settles — absurdity/strange.
const swirl: TransitionDef = {
  name: 'swirl',
  glsl: /* glsl */ `
    vec4 transition(vec2 uv) {
      vec2 c = uv - 0.5;
      float r = length(c);
      float a = atan(c.y, c.x);
      a += sin(progress * 3.14159) * 3.0 * (0.5 - r);
      vec2 suv = 0.5 + vec2(cos(a), sin(a)) * r;
      vec4 from = getFromColor(clamp(suv, 0.0, 1.0));
      vec4 to = getToColor(uv);
      return mix(from, to, smoothstep(0.3, 0.95, progress));
    }
  `,
};

// A dripping vertical melt: the new frame oozes down in ragged columns — absurdity.
const melt: TransitionDef = {
  name: 'melt',
  glsl: /* glsl */ `
    float meltHash(float x) { return fract(sin(x * 127.1) * 43758.5453); }
    vec4 transition(vec2 uv) {
      float drip = meltHash(floor(uv.x * 42.0)) * 0.3;
      float edge = progress * 1.35 - drip;
      float t = step(1.0 - uv.y, edge);
      return mix(getFromColor(uv), getToColor(uv), t);
    }
  `,
};

// A radial ripple distortion that resolves to the new frame — nostalgic/strange.
const ripple: TransitionDef = {
  name: 'ripple',
  glsl: /* glsl */ `
    vec4 transition(vec2 uv) {
      vec2 c = uv - 0.5;
      float r = length(c);
      float w = sin(r * 40.0 - progress * 12.0) * 0.02 * (1.0 - progress);
      vec2 ruv = uv + normalize(c + 1e-5) * w;
      vec4 from = getFromColor(clamp(ruv, 0.0, 1.0));
      vec4 to = getToColor(uv);
      return mix(from, to, smoothstep(0.2, 0.9, progress));
    }
  `,
};

// A sinusoidal liquid wipe with a wavering seam — nostalgic.
const liquidWave: TransitionDef = {
  name: 'liquidWave',
  glsl: /* glsl */ `
    vec4 transition(vec2 uv) {
      float wave = sin(uv.y * 10.0 + progress * 6.28318) * 0.05;
      float edge = progress * 1.1;
      float t = smoothstep(edge - 0.1, edge + 0.1, uv.x + wave);
      return mix(getToColor(uv), getFromColor(uv), t);
    }
  `,
};

// A blocky RGB-split glitch that peaks at the crossover — mechanical/fear.
const glitch: TransitionDef = {
  name: 'glitch',
  glsl: /* glsl */ `
    float glHash(vec2 p) {
      p = fract(p * vec2(123.34, 345.45));
      p += dot(p, p + 34.345);
      return fract(p.x * p.y);
    }
    vec4 transition(vec2 uv) {
      float t = step(0.5, progress);
      float amt = 1.0 - abs(progress - 0.5) * 2.0;
      float blk = glHash(vec2(floor(uv.y * 20.0), floor(progress * 30.0)));
      vec2 off = vec2((blk - 0.5) * 0.08 * amt, 0.0);
      vec4 a = mix(getFromColor(uv + off), getToColor(uv + off), t);
      vec4 b = mix(getFromColor(uv - off), getToColor(uv - off), t);
      vec4 c = mix(getFromColor(uv), getToColor(uv), t);
      return vec4(a.r, c.g, b.b, c.a);
    }
  `,
};

// A pixelation cross: dissolve through a coarse mosaic — mechanical.
const pixelize: TransitionDef = {
  name: 'pixelize',
  glsl: /* glsl */ `
    vec4 transition(vec2 uv) {
      float amt = 1.0 - abs(progress - 0.5) * 2.0;
      float blocks = mix(220.0, 14.0, amt);
      vec2 puv = (floor(uv * blocks) + 0.5) / blocks;
      float t = step(0.5, progress);
      return mix(getFromColor(puv), getToColor(puv), t);
    }
  `,
};

// A directional wipe whose seam is posterized into hard colour steps — mechanical.
const posterizeWipe: TransitionDef = {
  name: 'posterizeWipe',
  glsl: /* glsl */ `
    vec4 transition(vec2 uv) {
      float edge = progress;
      float t = step(uv.x, edge);
      vec4 col = mix(getFromColor(uv), getToColor(uv), t);
      vec3 post = floor(col.rgb * 4.0) / 4.0;
      float near = 1.0 - clamp(abs(uv.x - edge) / 0.15, 0.0, 1.0);
      col.rgb = mix(col.rgb, post, near);
      return col;
    }
  `,
};

// A circular iris opening from the centre — joy/love.
const irisOpen: TransitionDef = {
  name: 'irisOpen',
  glsl: /* glsl */ `
    vec4 transition(vec2 uv) {
      float r = length(uv - 0.5);
      float rad = progress * 0.8;
      float t = smoothstep(rad + 0.05, rad - 0.05, r);
      return mix(getFromColor(uv), getToColor(uv), t);
    }
  `,
};

// An angular clock-wipe sweeping around the centre — joy.
const radialReveal: TransitionDef = {
  name: 'radialReveal',
  glsl: /* glsl */ `
    vec4 transition(vec2 uv) {
      vec2 c = uv - 0.5;
      float a = atan(c.y, c.x) / 6.28318 + 0.5;
      float t = step(a, progress);
      return mix(getFromColor(uv), getToColor(uv), t);
    }
  `,
};

// A dip to black at the midpoint before the new frame rises — loss.
const fadeBlack: TransitionDef = {
  name: 'fadeBlack',
  glsl: /* glsl */ `
    vec4 transition(vec2 uv) {
      vec4 mixed = mix(getFromColor(uv), getToColor(uv), step(0.5, progress));
      float dip = 1.0 - abs(progress - 0.5) * 2.0;
      return vec4(mixed.rgb * (1.0 - dip), mixed.a);
    }
  `,
};

// A wipe whose seam solarizes (tone-inverts) as it passes — uncanny.
const solarizeWipe: TransitionDef = {
  name: 'solarizeWipe',
  glsl: /* glsl */ `
    vec4 transition(vec2 uv) {
      float edge = progress;
      float t = step(uv.x, edge);
      vec4 col = mix(getFromColor(uv), getToColor(uv), t);
      vec3 sol = mix(col.rgb, 1.0 - col.rgb, step(vec3(0.5), col.rgb));
      float near = 1.0 - clamp(abs(uv.x - edge) / 0.2, 0.0, 1.0);
      col.rgb = mix(col.rgb, sol, near);
      return col;
    }
  `,
};

// A hard horizontal push: the new frame shoves the old one off-screen — fear/ominous.
const slideHarsh: TransitionDef = {
  name: 'slideHarsh',
  glsl: /* glsl */ `
    vec4 transition(vec2 uv) {
      if (uv.x < 1.0 - progress) {
        return getFromColor(uv + vec2(progress, 0.0));
      }
      return getToColor(uv - vec2(1.0 - progress, 0.0));
    }
  `,
};

// ============================================================================
// Catalog expansion (2026-06-24): more original gl-transitions-spec shaders for
// visual variety, so the reel's crossfades stay chaotic and fluid rather than
// recycling a handful. Same spec shape (vec4 transition(vec2 uv)); no source was
// copied. dream/filterDirector.ts wires each into the mood families it selects from.
// ============================================================================

// Vertical venetian blinds — the columnar complement to barWipe (mechanical/ominous).
const windowBlinds: TransitionDef = {
  name: 'windowBlinds',
  glsl: /* glsl */ `
    vec4 transition(vec2 uv) {
      float bars = 12.0;
      float local = fract(uv.x * bars);
      float t = step(local, progress);
      return mix(getFromColor(uv), getToColor(uv), t);
    }
  `,
};

// A radial zoom-blur that punches in at the crossover then settles — energetic (joy/fear).
const crossZoom: TransitionDef = {
  name: 'crossZoom',
  glsl: /* glsl */ `
    vec4 zoomMix(vec2 uv, float t) {
      vec2 c = clamp(uv, 0.0, 1.0);
      return mix(getFromColor(c), getToColor(c), t);
    }
    vec4 transition(vec2 uv) {
      float amt = sin(progress * 3.14159);
      float t = smoothstep(0.35, 0.65, progress);
      vec2 c = uv - 0.5;
      vec4 acc = vec4(0.0);
      acc += zoomMix(0.5 + c * (1.0 + amt * 0.00), t);
      acc += zoomMix(0.5 + c * (1.0 + amt * 0.06), t);
      acc += zoomMix(0.5 + c * (1.0 + amt * 0.12), t);
      acc += zoomMix(0.5 + c * (1.0 + amt * 0.18), t);
      return acc * 0.25;
    }
  `,
};

// A dark organic ink-bleed dissolve: cool tendrils eat the old frame away (ominous/loss/fear).
const inkBleed: TransitionDef = {
  name: 'inkBleed',
  glsl: /* glsl */ `
    float ibHash(vec2 p) {
      p = fract(p * vec2(123.34, 345.45));
      p += dot(p, p + 34.345);
      return fract(p.x * p.y);
    }
    float ibNoise(vec2 p) {
      vec2 i = floor(p), f = fract(p);
      f = f * f * (3.0 - 2.0 * f);
      float a = ibHash(i), b = ibHash(i + vec2(1.0, 0.0));
      float c = ibHash(i + vec2(0.0, 1.0)), d = ibHash(i + vec2(1.0, 1.0));
      return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
    }
    vec4 transition(vec2 uv) {
      float n = ibNoise(uv * vec2(ratio, 1.0) * 6.0);
      float edge = 0.2;
      float t = smoothstep(n - edge, n + edge, progress);
      float band = clamp(1.0 - abs((progress - n) / edge), 0.0, 1.0);
      vec4 mixed = mix(getFromColor(uv), getToColor(uv), t);
      mixed.rgb *= 1.0 - band * 0.85; // darken the bleeding front
      return mixed;
    }
  `,
};

// RGB channels drift apart and reconverge across the cut — uncanny/strange/mechanical.
const chromaDrift: TransitionDef = {
  name: 'chromaDrift',
  glsl: /* glsl */ `
    vec4 transition(vec2 uv) {
      float amt = (1.0 - abs(progress - 0.5) * 2.0) * 0.03;
      float t = smoothstep(0.35, 0.65, progress);
      vec2 d = vec2(amt, 0.0);
      float r = mix(getFromColor(clamp(uv + d, 0.0, 1.0)), getToColor(clamp(uv + d, 0.0, 1.0)), t).r;
      vec4 g = mix(getFromColor(uv), getToColor(uv), t);
      float b = mix(getFromColor(clamp(uv - d, 0.0, 1.0)), getToColor(clamp(uv - d, 0.0, 1.0)), t).b;
      return vec4(r, g.g, b, g.a);
    }
  `,
};

// A single expanding ripple ring that reveals the new frame — nostalgic/tender/strange.
const waterDrop: TransitionDef = {
  name: 'waterDrop',
  glsl: /* glsl */ `
    vec4 transition(vec2 uv) {
      vec2 c = uv - 0.5;
      float r = length(c);
      float ring = progress * 0.9;
      float dr = (r - ring) * 12.0; // pow() is undefined for a negative base in GLSL ES — square it
      float w = exp(-dr * dr) * 0.05 * (1.0 - progress);
      vec2 duv = uv + normalize(c + 1e-5) * w;
      vec4 from = getFromColor(clamp(duv, 0.0, 1.0));
      vec4 to = getToColor(uv);
      float t = smoothstep(ring + 0.04, ring - 0.04, r); // inside the ring shows the new frame
      return mix(from, to, t);
    }
  `,
};

// A soft diagonal wipe with a feathered seam — a calm directional (nostalgic/melancholy).
const diagonalWipe: TransitionDef = {
  name: 'diagonalWipe',
  glsl: /* glsl */ `
    vec4 transition(vec2 uv) {
      float d = (uv.x + uv.y) * 0.5;
      float feather = 0.1;
      float edge = progress * (1.0 + feather) - feather * 0.5;
      float t = smoothstep(edge - feather, edge + feather, d);
      return mix(getToColor(uv), getFromColor(uv), t);
    }
  `,
};

// A kaleidoscopic mirror-fold that eases in, then resolves on the new frame — absurdity/strange.
const mirrorFold: TransitionDef = {
  name: 'mirrorFold',
  glsl: /* glsl */ `
    vec4 transition(vec2 uv) {
      float k = sin(progress * 3.14159);
      vec2 fuv;
      fuv.x = mix(uv.x, abs(uv.x - 0.5) + 0.25, k);
      fuv.y = mix(uv.y, abs(uv.y - 0.5) + 0.25, k);
      vec4 from = getFromColor(clamp(fuv, 0.0, 1.0));
      vec4 to = getToColor(uv);
      return mix(from, to, smoothstep(0.25, 0.95, progress));
    }
  `,
};

// A TV-static dissolve: per-pixel noise threshold with a speckled front — mechanical/uncanny/fear.
const staticDissolve: TransitionDef = {
  name: 'staticDissolve',
  glsl: /* glsl */ `
    float sdHash(vec2 p) {
      p = fract(p * vec2(123.34, 345.45));
      p += dot(p, p + 34.345);
      return fract(p.x * p.y);
    }
    vec4 transition(vec2 uv) {
      float n = sdHash(floor(uv * vec2(150.0 * ratio, 150.0)));
      float t = step(n, progress);
      float band = clamp(1.0 - abs(n - progress) / 0.12, 0.0, 1.0);
      vec4 mixed = mix(getFromColor(uv), getToColor(uv), t);
      float sp = sdHash(uv * (progress + 0.1) * 50.0) - 0.5;
      mixed.rgb += sp * band * 0.4; // a brief speckle along the dissolve front
      return mixed;
    }
  `,
};

export const TRANSITIONS: Record<string, TransitionDef> = {
  fade,
  filmBurn,
  wipe,
  dreamWarp,
  lightFlash,
  cut,
  barWipe,
  crossLuma,
  bloomDissolve,
  swirl,
  melt,
  ripple,
  liquidWave,
  glitch,
  pixelize,
  posterizeWipe,
  irisOpen,
  radialReveal,
  fadeBlack,
  solarizeWipe,
  slideHarsh,
  windowBlinds,
  crossZoom,
  inkBleed,
  chromaDrift,
  waterDrop,
  diagonalWipe,
  mirrorFold,
  staticDissolve,
};

export const TRANSITION_NAMES = Object.keys(TRANSITIONS);
