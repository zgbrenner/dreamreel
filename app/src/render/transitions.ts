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

export const TRANSITIONS: Record<string, TransitionDef> = {
  fade,
  filmBurn,
  wipe,
};

export const TRANSITION_NAMES = Object.keys(TRANSITIONS);
