# Agent Notes

## Local Video Playback

- Local Vite dev rewrites archive.org media `src` values through the dev proxy in `app/src/manifest/archiveProxy.ts`.
- Run the proxy whenever testing local video from the seed manifest or a remote manifest that still hotlinks archive.org:

```bash
cd app
npm run dev:proxy
```

- The proxy lives at `.devproxy/proxy.mjs`, listens on `http://127.0.0.1:8787` by default, follows archive.org redirects, forwards `Range` requests, and adds `Access-Control-Allow-Origin: *`.
- The rewrite is dev-only (`import.meta.env.DEV`). Production/preview builds do not use the local proxy. Production video should be served from CORS-clean R2/CDN URLs, or a deployed equivalent proxy/worker.
- Do not remove `crossOrigin = "anonymous"` from the image/video loaders to work around archive.org. WebGL textures must remain CORS-clean.

