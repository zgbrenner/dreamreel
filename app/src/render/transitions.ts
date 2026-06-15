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

export const TRANSITIONS: Record<string, TransitionDef> = {
  fade,
  filmBurn,
  wipe,
  dreamWarp,
  lightFlash,
};

export const TRANSITION_NAMES = Object.keys(TRANSITIONS);
