#!/usr/bin/env node
// Local-files sync server for the OpenSCAD playground (fork).
//
// Serves the built playground (dist/) and a tiny JSON API that lets the
// playground load and save .scad files from a local repo, so a project can be
// edited in the browser and synced back to the files on disk.
//
// Usage:
//   node sync-server.mjs [--repo <path>] [--port <port>] [--host <host>]
//
// Env vars: HELIOSTAT_REPO, PORT, HOST (CLI args win).
//
// API:
//   GET  /api/health          -> {ok: true, repo: <path>}
//   GET  /api/files           -> {files: [{path, content}]}  (relative paths, /-separated)
//   PUT  /api/files/<path>    -> body: file content; writes <repo>/<path>
//   GET  /*                   -> static files from dist/
//
// Only .scad files under the repo root are served or written; paths are
// validated to stay inside the repo. No auth: bind to localhost (the default)
// and use a tunnel for remote access.

import { createServer } from 'node:http';
import { readFile, writeFile, readdir, mkdir } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stat } from 'node:fs/promises';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const DIST_DIR = resolve(__dirname, 'dist');

// ─── Arguments ────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
let repoArg, portArg, hostArg;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--repo') repoArg = args[++i];
  else if (args[i] === '--port') portArg = args[++i];
  else if (args[i] === '--host') hostArg = args[++i];
  else if (args[i] === '--help' || args[i] === '-h') {
    console.log('Usage: node sync-server.mjs [--repo <path>] [--port <port>] [--host <host>]');
    process.exit(0);
  }
}
const REPO = resolve(repoArg ?? process.env.HELIOSTAT_REPO ?? process.cwd());
const PORT = parseInt(portArg ?? process.env.PORT ?? '8787', 10);
const HOST = hostArg ?? process.env.HOST ?? '127.0.0.1';

// ─── Repo helpers ──────────────────────────────────────────────────────────
async function collectScadFiles(dir, base = '') {
  const out = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const full = join(dir, entry.name);
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      out.push(...await collectScadFiles(full, rel));
    } else if (entry.name.endsWith('.scad')) {
      out.push(rel);
    }
  }
  return out.sort();
}

/** Returns an error string, or null if the path is safe. */
function validatePath(p) {
  if (typeof p !== 'string' || p === '') return 'path is required';
  if (p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p)) return 'path must be relative';
  const parts = p.split('/');
  if (parts.some(part => part === '..')) return 'path must not contain ".."';
  if (parts.some(part => part === '' || part === '.')) return 'invalid path';
  if (!p.endsWith('.scad')) return 'only .scad files are allowed';
  const abs = resolve(REPO, p);
  if (abs !== REPO && !abs.startsWith(REPO + sep)) return 'path escapes the repo';
  return null;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > 32 * 1024 * 1024) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// ─── Static files ──────────────────────────────────────────────────────────
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.zip': 'application/zip',
  '.m4a': 'audio/mp4',
  '.ogg': 'audio/ogg',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml',
  '.webmanifest': 'application/manifest+json',
  '.manifest': 'application/manifest+json',
};

async function serveStatic(res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel.endsWith('/')) rel += 'index.html';
  const abs = resolve(DIST_DIR, '.' + rel);
  if (abs !== DIST_DIR && !abs.startsWith(DIST_DIR + sep)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }
  let st;
  try { st = await stat(abs); } catch {
    // fall back to index.html for SPA-style routing
    const fallback = join(DIST_DIR, 'index.html');
    try {
      const data = await readFile(fallback);
      res.writeHead(200, {'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache'});
      res.end(data);
      return;
    } catch {
      res.writeHead(404); res.end('Not found'); return;
    }
  }
  if (st.isDirectory()) {
    const data = await readFile(join(abs, 'index.html')).catch(() => null);
    if (data) {
      res.writeHead(200, {'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache'});
      res.end(data);
      return;
    }
    res.writeHead(404); res.end('Not found'); return;
  }
  const ext = abs.slice(abs.lastIndexOf('.'));
  const type = MIME[ext] ?? 'application/octet-stream';
  const data = await readFile(abs);
  res.writeHead(200, {
    'content-type': type,
    'cache-control': ext === '.html' ? 'no-cache' : 'public, max-age=3600',
    'content-length': data.length,
  });
  res.end(data);
}

// ─── Server ────────────────────────────────────────────────────────────────
const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const pathname = url.pathname;

  // CORS: the playground may be opened from any origin (e.g. a tunnel).
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-methods', 'GET, PUT, OPTIONS');
  res.setHeader('access-control-allow-headers', 'content-type');
  if (req.method === 'OPTIONS') {
    res.writeHead(204); res.end(); return;
  }

  try {
    if (pathname === '/api/health' && req.method === 'GET') {
      res.writeHead(200, {'content-type': 'application/json'});
      res.end(JSON.stringify({ok: true, repo: REPO}));
      return;
    }

    if (pathname === '/api/files' && req.method === 'GET') {
      const files = [];
      for (const rel of await collectScadFiles(REPO)) {
        const content = await readFile(join(REPO, rel), 'utf8');
        files.push({path: rel, content});
      }
      res.writeHead(200, {'content-type': 'application/json'});
      res.end(JSON.stringify({files}));
      return;
    }

    if (pathname.startsWith('/api/files/') && req.method === 'PUT') {
      const rel = decodeURIComponent(pathname.slice('/api/files/'.length));
      const err = validatePath(rel);
      if (err) {
        res.writeHead(400, {'content-type': 'application/json'});
        res.end(JSON.stringify({error: err}));
        return;
      }
      const body = await readBody(req);
      const abs = resolve(REPO, rel);
      await mkdir(resolve(abs, '..'), {recursive: true});
      await writeFile(abs, body, 'utf8');
      res.writeHead(200, {'content-type': 'application/json'});
      res.end(JSON.stringify({ok: true, path: rel, bytes: body.length}));
      return;
    }

    if (req.method === 'GET') {
      await serveStatic(res, pathname);
      return;
    }

    res.writeHead(405, {'content-type': 'application/json'});
    res.end(JSON.stringify({error: 'Method not allowed'}));
  } catch (e) {
    console.error(`[sync-server] ${req.method} ${pathname} failed:`, e);
    if (!res.headersSent) {
      res.writeHead(500, {'content-type': 'application/json'});
      res.end(JSON.stringify({error: String(e)}));
    }
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[sync-server] Serving ${DIST_DIR}`);
  console.log(`[sync-server] Repo: ${REPO}`);
  console.log(`[sync-server] Listening on http://${HOST}:${PORT}/`);
  console.log(`[sync-server] Open: http://${HOST}:${PORT}/?sync=http://${HOST}:${PORT}`);
});
