#!/usr/bin/env node
import { createServer } from 'node:http';
import http from 'node:http';
import https from 'node:https';

const port = Number(process.env.PORT ?? 8787);
const maxRedirects = Number(process.env.MAX_REDIRECTS ?? 8);

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Allow-Headers': 'Range, If-Range, If-None-Match, If-Modified-Since, Content-Type',
  'Access-Control-Expose-Headers': 'Accept-Ranges, Content-Length, Content-Range, Content-Type, ETag, Last-Modified',
};

const forwardedRequestHeaders = [
  'range',
  'if-range',
  'if-none-match',
  'if-modified-since',
  'user-agent',
  'accept',
  'accept-encoding',
];

const forwardedResponseHeaders = [
  'accept-ranges',
  'cache-control',
  'content-length',
  'content-range',
  'content-type',
  'etag',
  'last-modified',
];

function isAllowedArchiveUrl(url) {
  return url.protocol === 'https:' && (url.hostname === 'archive.org' || url.hostname.endsWith('.archive.org'));
}

function send(res, status, body) {
  res.writeHead(status, {
    ...corsHeaders,
    'Content-Type': 'text/plain; charset=utf-8',
  });
  res.end(body);
}

function headersFrom(req) {
  const out = {};
  for (const name of forwardedRequestHeaders) {
    const value = req.headers[name];
    if (value) out[name] = value;
  }
  return out;
}

function responseHeadersFrom(upstream) {
  const out = { ...corsHeaders };
  for (const name of forwardedResponseHeaders) {
    const value = upstream.headers[name];
    if (value) out[name] = value;
  }
  return out;
}

function proxyArchive(req, res, target, redirectsLeft) {
  if (!isAllowedArchiveUrl(target)) {
    send(res, 403, 'Only https://archive.org and archive.org CDN hosts are allowed.\n');
    return;
  }

  const client = target.protocol === 'https:' ? https : http;
  const upstreamReq = client.request(
    target,
    {
      method: req.method,
      headers: headersFrom(req),
    },
    (upstream) => {
      const location = upstream.headers.location;
      if (
        location &&
        upstream.statusCode &&
        upstream.statusCode >= 300 &&
        upstream.statusCode < 400
      ) {
        upstream.resume();
        if (redirectsLeft <= 0) {
          send(res, 502, 'Too many archive.org redirects.\n');
          return;
        }
        proxyArchive(req, res, new URL(location, target), redirectsLeft - 1);
        return;
      }

      res.writeHead(upstream.statusCode ?? 502, responseHeadersFrom(upstream));
      if (req.method === 'HEAD') {
        upstream.resume();
        res.end();
      } else {
        upstream.pipe(res);
      }
    },
  );

  upstreamReq.on('error', (err) => {
    if (!res.headersSent) send(res, 502, `archive.org proxy failed: ${err.message}\n`);
    else res.destroy(err);
  });

  req.on('aborted', () => upstreamReq.destroy());
  upstreamReq.end();
}

createServer((req, res) => {
  Object.entries(corsHeaders).forEach(([key, value]) => res.setHeader(key, value));

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    send(res, 405, 'Method not allowed.\n');
    return;
  }

  const requestUrl = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
  const targetParam = requestUrl.searchParams.get('url');
  if (!targetParam) {
    send(res, 400, 'Usage: /?url=https%3A%2F%2Farchive.org%2Fdownload%2F...\n');
    return;
  }

  let target;
  try {
    target = new URL(targetParam);
  } catch {
    send(res, 400, 'Invalid url parameter.\n');
    return;
  }

  proxyArchive(req, res, target, maxRedirects);
}).listen(port, '127.0.0.1', () => {
  console.log(`Dreamreel archive.org dev proxy listening on http://127.0.0.1:${port}`);
});
