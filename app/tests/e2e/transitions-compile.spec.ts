import { test, expect } from '@playwright/test';
import { TRANSITIONS } from '../../src/render/transitions';
import { buildFragment } from '../../src/render/TransitionMaterial';

// Every catalog shader must actually COMPILE + LINK in a real WebGL context. Vitest can't do
// this (no GL), and the smoke test only exercises whatever transitions a given seed happens to
// pick — so a typo in a rarely-selected family could ship unnoticed. Here we compile all of them
// against a throwaway context in a real browser, asserting zero shader errors.

const VERT = `
  attribute vec3 position;
  attribute vec2 uv;
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

const SHADERS = Object.entries(TRANSITIONS).map(([name, def]) => ({
  name,
  frag: buildFragment(def),
}));

test('every transition shader compiles and links in WebGL', async ({ page }) => {
  // Any page with a WebGL-capable browser will do; the app root is convenient.
  await page.goto('/');

  const failures = await page.evaluate(
    ({ shaders, vert }) => {
      const canvas = document.createElement('canvas');
      const gl = (canvas.getContext('webgl') ||
        canvas.getContext('experimental-webgl')) as WebGLRenderingContext | null;
      if (!gl) return [{ name: '(context)', log: 'no WebGL context available' }];

      const compile = (type: number, src: string): { ok: boolean; log: string } => {
        const sh = gl.createShader(type)!;
        gl.shaderSource(sh, src);
        gl.compileShader(sh);
        const ok = gl.getShaderParameter(sh, gl.COMPILE_STATUS) as boolean;
        const log = ok ? '' : gl.getShaderInfoLog(sh) || 'compile failed';
        gl.deleteShader(sh);
        return { ok, log };
      };

      const out: { name: string; log: string }[] = [];
      const vs = compile(gl.VERTEX_SHADER, vert);
      if (!vs.ok) return [{ name: '(vertex)', log: vs.log }];

      for (const { name, frag } of shaders) {
        const fs = compile(gl.FRAGMENT_SHADER, frag);
        if (!fs.ok) {
          out.push({ name, log: fs.log });
          continue;
        }
        // Also link a full program (vertex + this fragment) to catch interface errors.
        const prog = gl.createProgram()!;
        const v = gl.createShader(gl.VERTEX_SHADER)!;
        gl.shaderSource(v, vert);
        gl.compileShader(v);
        const f = gl.createShader(gl.FRAGMENT_SHADER)!;
        gl.shaderSource(f, frag);
        gl.compileShader(f);
        gl.attachShader(prog, v);
        gl.attachShader(prog, f);
        gl.linkProgram(prog);
        if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
          out.push({ name, log: gl.getProgramInfoLog(prog) || 'link failed' });
        }
        gl.deleteShader(v);
        gl.deleteShader(f);
        gl.deleteProgram(prog);
      }
      return out;
    },
    { shaders: SHADERS, vert: VERT },
  );

  expect(
    failures,
    `shader compile/link failures:\n${failures.map((f) => `  ${f.name}: ${f.log}`).join('\n')}`,
  ).toEqual([]);
});
