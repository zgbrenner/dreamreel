// Dev-only CORS proxy for DREAMREEL local video playback.
//
// archive.org serves the film clips but sends NO Access-Control-Allow-Origin header, so the
// browser (which loads video/img textures with crossOrigin="anonymous") refuses them and the app
// falls back to procedural texture. This proxy mirrors archive.org, follows its 302 redirects,
// forwards Range requests, and adds ACAO:* so the WebGL video textures load. It also serves a
// rewritten manifest whose video src points back at this proxy (images keep their museum hosts,
// which already send CORS).
//
// Not shipped, not imported by the app — a local dev aid only. Run: node .devproxy/proxy.mjs
import http from 'node:http';
import { Readable } from 'node:stream';

const PORT = Number(process.env.PROXY_PORT || 8088);
const R2_MANIFEST = 'https://pub-0f361adf4c4d425198bd06d2d9ab5194.r2.dev/manifest/latest.json';
const SELF_BASE = `http://localhost:${PORT}`;

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,HEAD,OPTIONS',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Expose-Headers': '*',
};

let manifestCache = null;
async function buildManifest() {
  if (manifestCache) return manifestCache;
  const res = await fetch(R2_MANIFEST);
  const m = await res.json();
  const assets = m.assets || m.visuals || [];
  let rewritten = 0;
  for (const a of assets) {
    const src = a.src || '';
    if (src.startsWith('https://archive.org/')) {
      a.src = src.replace('https://archive.org', SELF_BASE);
      rewritten++;
    }
  }
  console.log(`[proxy] manifest: ${assets.length} assets, rewrote ${rewritten} archive.org video src -> ${SELF_BASE}`);
  manifestCache = JSON.stringify(m);
  return manifestCache;
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors);
      res.end();
      return;
    }

    const url = new URL(req.url, SELF_BASE);

    if (url.pathname === '/manifest.json') {
      const body = await buildManifest();
      res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
      res.end(body);
      return;
    }

    // Everything else is proxied to archive.org, preserving the path + query.
    const target = `https://archive.org${url.pathname}${url.search}`;
    const headers = {};
    if (req.headers.range) headers.range = req.headers.range;
    const upstream = await fetch(target, { headers, redirect: 'follow' });

    const outHeaders = { ...cors };
    for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'cache-control', 'etag', 'last-modified']) {
      const v = upstream.headers.get(h);
      if (v) outHeaders[h] = v;
    }
    res.writeHead(upstream.status, outHeaders);
    if (req.method === 'HEAD' || !upstream.body) {
      res.end();
      return;
    }
    Readable.fromWeb(upstream.body).pipe(res);
  } catch (err) {
    console.error('[proxy] error', req.url, err?.message);
    if (!res.headersSent) res.writeHead(502, cors);
    res.end('proxy error');
  }
});

server.listen(PORT, () => console.log(`[proxy] listening on ${SELF_BASE} — manifest at ${SELF_BASE}/manifest.json`));
