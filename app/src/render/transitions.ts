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

// ============================================================================
// Catalog expansion (2026-07-02): ~10 more original gl-transitions-spec shaders
// widening the emotional families — love/tender (bokehBloom, lumaMelt),
// nostalgic/liquid (pageCurl, wateryRefract), joy (irisBloom, mosaicSparkle),
// fear/ominous (venetianSlice, shadowWipe), absurdity/strange (polarSwirl,
// voronoiShatter), mechanical (scanlineShutter). Same spec shape
// (vec4 transition(vec2 uv)), progress/ratio uniforms only; no source was copied.
// dream/filterDirector.ts wires each into the mood families it selects from.
// ============================================================================

// A soft bokeh-bloom dissolve: the crossfade is sampled through a widening ring of
// taps, so out-of-focus discs of light swell at the crossover — tender/love.
const bokehBloom: TransitionDef = {
  name: 'bokehBloom',
  glsl: /* glsl */ `
    vec4 bkMix(vec2 uv, float t) {
      vec2 c = clamp(uv, 0.0, 1.0);
      return mix(getFromColor(c), getToColor(c), t);
    }
    vec4 transition(vec2 uv) {
      float t = smoothstep(0.0, 1.0, progress);
      float amt = sin(progress * 3.14159) * 0.02;
      vec4 acc = bkMix(uv, t);
      acc += bkMix(uv + vec2(amt, 0.0), t);
      acc += bkMix(uv - vec2(amt, 0.0), t);
      acc += bkMix(uv + vec2(0.0, amt), t);
      acc += bkMix(uv - vec2(0.0, amt), t);
      acc += bkMix(uv + vec2(amt, amt) * 0.7071, t);
      acc += bkMix(uv - vec2(amt, amt) * 0.7071, t);
      acc *= 1.0 / 7.0;
      // bright regions glow softly while the picture is defocused
      float lum = dot(acc.rgb, vec3(0.299, 0.587, 0.114));
      acc.rgb += acc.rgb * lum * sin(progress * 3.14159) * 0.35;
      return acc;
    }
  `,
};

// A luminance-gated melt: the incoming frame arrives through its brightest regions
// first while the outgoing image sags gently downward — tender/love/melancholy.
const lumaMelt: TransitionDef = {
  name: 'lumaMelt',
  glsl: /* glsl */ `
    vec4 transition(vec2 uv) {
      vec4 to = getToColor(uv);
      float lum = dot(to.rgb, vec3(0.299, 0.587, 0.114));
      // brighter regions of the new frame open first; darker ones melt in later
      float gate = clamp(progress * 1.5 - (1.0 - lum) * 0.5, 0.0, 1.0);
      // the outgoing frame sags downward where the gate is opening
      float sag = gate * (1.0 - gate) * 0.06;
      vec4 from = getFromColor(clamp(uv + vec2(0.0, sag), 0.0, 1.0));
      return mix(from, to, smoothstep(0.0, 1.0, gate));
    }
  `,
};

// A page-curl-like diagonal sweep: the old frame folds back over a soft cylinder
// (paper-tinted backside, shaded fold, trailing shadow) revealing the new — nostalgic.
const pageCurl: TransitionDef = {
  name: 'pageCurl',
  glsl: /* glsl */ `
    vec4 transition(vec2 uv) {
      vec2 dir = normalize(vec2(1.0, 0.4)); // sweep from the lower-left corner
      float d = dot(uv, dir);
      float maxD = dot(vec2(1.0), dir);
      float roll = 0.12; // radius of the curl
      float edge = progress * (maxD + 0.3) - 0.15;
      if (d < edge - roll) {
        // fully revealed: the new page, with a soft shadow trailing the curl
        vec4 to = getToColor(uv);
        float sh = 1.0 - clamp((edge - roll - d) / 0.18, 0.0, 1.0);
        to.rgb *= 1.0 - sh * 0.25;
        return to;
      }
      if (d < edge) {
        // inside the curl: the old page mirrored over the fold, lit like a cylinder
        float k = (edge - d) / roll;
        vec2 fuv = clamp(uv + dir * (edge - d) * 2.0, 0.0, 1.0);
        vec4 from = getFromColor(fuv);
        from.rgb = mix(from.rgb, vec3(0.92, 0.88, 0.80), 0.35); // paper backside tint
        from.rgb *= 0.75 + 0.25 * sin(k * 3.14159);
        return from;
      }
      return getFromColor(uv);
    }
  `,
};

// A watery refraction dissolve: both frames shimmer through a drifting noise flow
// field that swells mid-cut and stills again — nostalgic/liquid.
const wateryRefract: TransitionDef = {
  name: 'wateryRefract',
  glsl: /* glsl */ `
    float wrHash(vec2 p) {
      p = fract(p * vec2(123.34, 345.45));
      p += dot(p, p + 34.345);
      return fract(p.x * p.y);
    }
    float wrNoise(vec2 p) {
      vec2 i = floor(p), f = fract(p);
      f = f * f * (3.0 - 2.0 * f);
      float a = wrHash(i), b = wrHash(i + vec2(1.0, 0.0));
      float c = wrHash(i + vec2(0.0, 1.0)), d = wrHash(i + vec2(1.0, 1.0));
      return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
    }
    vec4 transition(vec2 uv) {
      float amp = sin(progress * 3.14159) * 0.045;
      vec2 flow = vec2(
        wrNoise(uv * 6.0 + progress * 2.0) - 0.5,
        wrNoise(uv * 6.0 + 31.7 - progress * 2.0) - 0.5
      );
      vec2 ruv = clamp(uv + flow * amp * 2.0, 0.0, 1.0);
      return mix(getFromColor(ruv), getToColor(ruv), smoothstep(0.1, 0.9, progress));
    }
  `,
};

// A radial iris-bloom: an aspect-true iris eases open with a luminous rim riding
// the aperture — joy.
const irisBloom: TransitionDef = {
  name: 'irisBloom',
  glsl: /* glsl */ `
    vec4 transition(vec2 uv) {
      vec2 c = (uv - 0.5) * vec2(ratio, 1.0);
      float r = length(c);
      float rad = progress * progress * (0.5 + ratio * 0.5); // accelerates open like a bloom
      float t = smoothstep(rad + 0.06, rad - 0.06, r);
      vec4 mixed = mix(getFromColor(uv), getToColor(uv), t);
      // a warm rim rides the opening iris
      float rim = 1.0 - clamp(abs(r - rad) / 0.05, 0.0, 1.0);
      mixed.rgb += vec3(1.0, 0.93, 0.75) * rim * sin(progress * 3.14159) * 0.5;
      return mixed;
    }
  `,
};

// A mosaic sparkle: coarse tiles flip to the new frame in a scattered order, each
// with a brief bright glint as it turns — joy.
const mosaicSparkle: TransitionDef = {
  name: 'mosaicSparkle',
  glsl: /* glsl */ `
    float msHash(vec2 p) {
      p = fract(p * vec2(123.34, 345.45));
      p += dot(p, p + 34.345);
      return fract(p.x * p.y);
    }
    vec4 transition(vec2 uv) {
      vec2 cell = floor(uv * vec2(24.0 * ratio, 24.0));
      float n = msHash(cell);
      float front = progress * 1.15 - 0.075; // each tile flips at its own moment
      vec4 col = mix(getFromColor(uv), getToColor(uv), step(n, front));
      // a brief sparkle as a tile flips
      float spark = 1.0 - clamp(abs(front - n) / 0.06, 0.0, 1.0);
      col.rgb += vec3(1.0, 0.96, 0.85) * spark * 0.6;
      return col;
    }
  `,
};

// A hard venetian slice: thin alternating slats shear in from opposite sides with
// no feathering — fear/ominous/mechanical.
const venetianSlice: TransitionDef = {
  name: 'venetianSlice',
  glsl: /* glsl */ `
    vec4 transition(vec2 uv) {
      float bands = 18.0;
      float odd = mod(floor(uv.y * bands), 2.0);
      float local = mix(uv.x, 1.0 - uv.x, odd); // alternate slats slice opposite ways
      float t = step(local, progress * 1.04 - 0.02);
      return mix(getFromColor(uv), getToColor(uv), t);
    }
  `,
};

// A shadow-wipe: a wall of darkness crosses the frame, swallowing the old image;
// the new one is already standing when the light returns — fear/ominous/loss.
const shadowWipe: TransitionDef = {
  name: 'shadowWipe',
  glsl: /* glsl */ `
    vec4 transition(vec2 uv) {
      float span = 0.3;
      float front = progress * (1.0 + 3.0 * span) - span; // the shadow's leading edge
      float dark = (1.0 - smoothstep(front, front + span, uv.x))
                 * smoothstep(front - 2.0 * span, front - span, uv.x);
      float t = step(uv.x, front - span); // the swap hides inside full darkness
      vec4 col = mix(getFromColor(uv), getToColor(uv), t);
      col.rgb *= 1.0 - dark * 0.92;
      return col;
    }
  `,
};

// A polar-coordinates swirl morph: mid-cut the picture is remapped toward its own
// polar unwrap (angle->x, radius->y) and back — absurdity/strange/uncanny.
const polarSwirl: TransitionDef = {
  name: 'polarSwirl',
  glsl: /* glsl */ `
    vec4 transition(vec2 uv) {
      vec2 c = uv - 0.5;
      vec2 polar = vec2(atan(c.y, c.x) / 6.28318 + 0.5, length(c) * 1.4142);
      float k = sin(progress * 3.14159);
      vec2 warped = clamp(mix(uv, polar, k * 0.85), 0.0, 1.0);
      vec4 from = getFromColor(warped);
      vec4 to = getToColor(warped);
      return mix(from, to, smoothstep(0.35, 0.65, progress));
    }
  `,
};

// A voronoi shatter: the frame breaks into irregular cells, each shard detaching at
// its own moment and drifting away as the new frame stands — absurdity/strange.
const voronoiShatter: TransitionDef = {
  name: 'voronoiShatter',
  glsl: /* glsl */ `
    vec2 vshHash2(vec2 p) {
      return vec2(
        fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453),
        fract(sin(dot(p, vec2(269.5, 183.3))) * 43758.5453)
      );
    }
    vec4 transition(vec2 uv) {
      vec2 g = uv * vec2(6.0 * ratio, 6.0);
      vec2 cellId = floor(g);
      // nearest voronoi seed among the 3x3 neighbourhood (constant loop bounds)
      float best = 8.0;
      vec2 bestId = cellId;
      for (int y = -1; y <= 1; y++) {
        for (int x = -1; x <= 1; x++) {
          vec2 nb = cellId + vec2(float(x), float(y));
          float d = length(g - (nb + vshHash2(nb)));
          if (d < best) { best = d; bestId = nb; }
        }
      }
      vec2 h = vshHash2(bestId);
      float n = fract(h.x * 1.37 + h.y * 0.61);
      // each shard detaches at its own moment and slides away as it fades
      float t = clamp(progress * 1.6 - n * 0.6, 0.0, 1.0);
      vec2 drift = (vshHash2(bestId + 7.0) - 0.5) * t * 0.25;
      vec4 from = getFromColor(clamp(uv + drift, 0.0, 1.0));
      return mix(from, getToColor(uv), smoothstep(0.25, 0.85, t));
    }
  `,
};

// A scanline shutter: the swap rolls down in staggered scanlines, rows tearing
// sideways near the front under a thin phosphor-bright line — mechanical.
const scanlineShutter: TransitionDef = {
  name: 'scanlineShutter',
  glsl: /* glsl */ `
    float ssHash(float x) { return fract(sin(x * 91.7) * 43758.5453); }
    vec4 transition(vec2 uv) {
      float lines = 96.0;
      float row = floor(uv.y * lines);
      float yTop = 1.0 - uv.y; // distance rolled from the top of the frame
      float sweep = progress * 1.3 - 0.15;
      float t = step(yTop, sweep - ssHash(row) * 0.05);
      // rows near the shutter tear sideways slightly
      float near = 1.0 - clamp(abs(yTop - sweep) / 0.08, 0.0, 1.0);
      vec2 tuv = clamp(uv + vec2((ssHash(row + 31.0) - 0.5) * 0.05 * near, 0.0), 0.0, 1.0);
      vec4 col = mix(getFromColor(tuv), getToColor(tuv), t);
      // a thin bright scanline rides the shutter front
      col.rgb += vec3(0.6, 0.7, 0.65) * near * near * 0.35;
      return col;
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
  bokehBloom,
  lumaMelt,
  pageCurl,
  wateryRefract,
  irisBloom,
  mosaicSparkle,
  venetianSlice,
  shadowWipe,
  polarSwirl,
  voronoiShatter,
  scanlineShutter,
};

export const TRANSITION_NAMES = Object.keys(TRANSITIONS);
