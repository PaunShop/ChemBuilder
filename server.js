#!/usr/bin/env node
'use strict';
/*
 * ChemBuild - zero-dependency local server.
 * Serves the app shell, the vendored Ketcher editor and RDKit WASM,
 * plus a small JSON API backed by plain files in ./drawings.
 * Binds to loopback only.
 */
const http = require('http');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = __dirname;
const DRAWINGS = path.join(ROOT, 'drawings');
const HOST = '127.0.0.1';
const PORT_RANGE = [8731, 8732, 8733, 8734, 8735, 8736, 8737, 8738, 8739, 8740];
const MAX_BODY = 24 * 1024 * 1024;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.mol': 'chemical/x-mdl-molfile',
  '.rxn': 'chemical/x-mdl-rxnfile',
  '.ket': 'application/json; charset=utf-8',
};

const STATIC_MOUNTS = [
  { prefix: '/app/', dir: path.join(ROOT, 'app'), cache: 'no-store' },
  { prefix: '/vendor/', dir: path.join(ROOT, 'vendor'), cache: 'public, max-age=31536000, immutable' },
  { prefix: '/drawings/', dir: DRAWINGS, cache: 'no-store' },
];

function sendJson(res, status, obj) {
  const body = Buffer.from(JSON.stringify(obj));
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
  });
  res.end(body);
}

function sendText(res, status, text) {
  const body = Buffer.from(String(text));
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'content-length': body.length });
  res.end(body);
}

/* Resolve a URL path inside a mount directory, refusing anything that escapes it. */
function resolveInside(dir, relPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(relPath);
  } catch (err) {
    return null;
  }
  if (decoded.indexOf('\u0000') !== -1) return null;
  const full = path.resolve(dir, '.' + (decoded.charAt(0) === '/' ? decoded : '/' + decoded));
  if (full !== dir && !full.startsWith(dir + path.sep)) return null;
  return full;
}

async function serveFile(res, filePath, cache, headOnly) {
  let st;
  try {
    st = await fsp.stat(filePath);
  } catch (err) {
    return sendText(res, 404, 'Not found');
  }
  if (st.isDirectory()) return serveFile(res, path.join(filePath, 'index.html'), cache, headOnly);
  const ext = path.extname(filePath).toLowerCase();
  res.writeHead(200, {
    'content-type': MIME[ext] || 'application/octet-stream',
    'content-length': st.size,
    'cache-control': cache || 'no-store',
    'last-modified': st.mtime.toUTCString(),
    'x-content-type-options': 'nosniff',
  });
  if (headOnly) return res.end();
  fs.createReadStream(filePath).on('error', () => res.destroy()).pipe(res);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJsonBody(req) {
  const buf = await readBody(req);
  if (!buf.length) return {};
  return JSON.parse(buf.toString('utf8'));
}

async function writeAtomic(filePath, data) {
  const tmp = filePath + '.tmp-' + process.pid + '-' + Date.now();
  await fsp.writeFile(tmp, data);
  await fsp.rename(tmp, filePath);
}

/* Accept SVG with or without an XML declaration (RDKit emits one), reject anything else. */
function looksLikeSvg(text) {
  if (typeof text !== 'string') return false;
  const trimmed = text.trim();
  if (trimmed.charAt(0) !== '<' || trimmed.length > 4 * 1024 * 1024) return false;
  return trimmed.slice(0, 500).toLowerCase().indexOf('<svg') !== -1;
}

function newId() {
  /* Digits only: anything outside ID_RE would make the record unreadable later. */
  const stamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
  const suffix = Math.random().toString(36).replace(/[^a-z0-9]/g, '').slice(0, 5) || 'x';
  const id = 'd' + stamp + '-' + suffix;
  return ID_RE.test(id) ? id : 'd' + Date.now();
}

function sanitizeMeta(raw, prev) {
  const now = new Date().toISOString();
  const cleanName =
    typeof raw.name === 'string' && raw.name.trim()
      ? raw.name.trim().slice(0, 160)
      : (prev && prev.name) || 'Untitled';
  let kind = 'empty';
  if (raw.kind === 'reaction') kind = 'reaction';
  else if (raw.kind === 'molecule') kind = 'molecule';
  return {
    id: prev ? prev.id : raw.id,
    name: cleanName,
    kind: kind,
    smiles: typeof raw.smiles === 'string' ? raw.smiles.slice(0, 8000) : '',
    formula: typeof raw.formula === 'string' ? raw.formula.slice(0, 400) : '',
    note: typeof raw.note === 'string' ? raw.note.slice(0, 4000) : (prev && prev.note) || '',
    created: (prev && prev.created) || now,
    updated: now,
  };
}

async function listDrawings() {
  let files;
  try {
    files = await fsp.readdir(DRAWINGS);
  } catch (err) {
    return [];
  }
  const metas = [];
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    try {
      const meta = JSON.parse(await fsp.readFile(path.join(DRAWINGS, f), 'utf8'));
      if (!meta || !ID_RE.test(String(meta.id || ''))) continue;
      meta.hasThumb = fs.existsSync(path.join(DRAWINGS, meta.id + '.svg'));
      metas.push(meta);
    } catch (err) {
      /* skip unreadable record */
    }
  }
  metas.sort((a, b) => String(b.updated || '').localeCompare(String(a.updated || '')));
  return metas;
}

async function handleApi(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean); // ['api','drawings',id?]
  const section = parts[1];

  if (section === 'drawings') {
    const id = parts[2];
    if (id !== undefined && !ID_RE.test(id)) return sendJson(res, 400, { error: 'Bad id' });

    if (!id && req.method === 'GET') return sendJson(res, 200, { drawings: await listDrawings() });

    if (!id && req.method === 'POST') {
      const body = await readJsonBody(req);
      const fresh = newId();
      const meta = sanitizeMeta(Object.assign({}, body, { id: fresh }), null);
      meta.id = fresh;
      await fsp.mkdir(DRAWINGS, { recursive: true });
      await writeAtomic(path.join(DRAWINGS, fresh + '.ket'), String(body.ket || ''));
      if (looksLikeSvg(body.svg)) {
        await writeAtomic(path.join(DRAWINGS, fresh + '.svg'), body.svg);
      }
      await writeAtomic(path.join(DRAWINGS, fresh + '.json'), JSON.stringify(meta, null, 2));
      return sendJson(res, 201, { meta });
    }

    if (id && req.method === 'GET') {
      try {
        const meta = JSON.parse(await fsp.readFile(path.join(DRAWINGS, id + '.json'), 'utf8'));
        const ket = await fsp.readFile(path.join(DRAWINGS, id + '.ket'), 'utf8').catch(() => '');
        return sendJson(res, 200, { meta, ket });
      } catch (err) {
        return sendJson(res, 404, { error: 'No such drawing' });
      }
    }

    if (id && req.method === 'PUT') {
      const body = await readJsonBody(req);
      let prev = null;
      try {
        prev = JSON.parse(await fsp.readFile(path.join(DRAWINGS, id + '.json'), 'utf8'));
      } catch (err) {
        prev = null;
      }
      const meta = sanitizeMeta(Object.assign({}, body, { id: id }), prev);
      meta.id = id;
      await fsp.mkdir(DRAWINGS, { recursive: true });
      if (typeof body.ket === 'string') await writeAtomic(path.join(DRAWINGS, id + '.ket'), body.ket);
      if (looksLikeSvg(body.svg)) {
        await writeAtomic(path.join(DRAWINGS, id + '.svg'), body.svg);
      }
      await writeAtomic(path.join(DRAWINGS, id + '.json'), JSON.stringify(meta, null, 2));
      return sendJson(res, 200, { meta });
    }

    if (id && req.method === 'DELETE') {
      let removed = 0;
      for (const ext of ['.json', '.ket', '.svg']) {
        try {
          await fsp.unlink(path.join(DRAWINGS, id + ext));
          removed++;
        } catch (err) {
          /* already gone */
        }
      }
      return sendJson(res, 200, { deleted: removed > 0 });
    }

    return sendJson(res, 405, { error: 'Method not allowed' });
  }

  if (section === 'info' && req.method === 'GET') {
    return sendJson(res, 200, {
      app: 'ChemBuild',
      drawingsDir: DRAWINGS,
      node: process.version,
    });
  }

  return sendJson(res, 404, { error: 'Unknown endpoint' });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://' + HOST);
  try {
    if (['GET', 'HEAD', 'POST', 'PUT', 'DELETE'].indexOf(req.method) === -1) {
      return sendText(res, 405, 'Method not allowed');
    }
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);

    if (url.pathname === '/' || url.pathname === '/index.html') {
      return await serveFile(res, path.join(ROOT, 'app', 'index.html'), 'no-store', req.method === 'HEAD');
    }
    if (url.pathname === '/favicon.ico') {
      return await serveFile(res, path.join(ROOT, 'app', 'icon.svg'), 'no-store', req.method === 'HEAD');
    }
    for (const mount of STATIC_MOUNTS) {
      if (url.pathname.startsWith(mount.prefix)) {
        const rel = url.pathname.slice(mount.prefix.length);
        const file = resolveInside(mount.dir, rel);
        if (!file) return sendText(res, 403, 'Forbidden');
        return await serveFile(res, file, mount.cache, req.method === 'HEAD');
      }
    }
    return sendText(res, 404, 'Not found');
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    if (!res.headersSent) sendJson(res, 500, { error: msg });
    else res.destroy();
  }
});

function listen(ports) {
  return new Promise((resolve, reject) => {
    const tryPort = (i) => {
      if (i >= ports.length) {
        reject(new Error('No free port in range ' + ports[0] + '-' + ports[ports.length - 1]));
        return;
      }
      server.once('error', (err) => {
        if (err.code === 'EADDRINUSE') tryPort(i + 1);
        else reject(err);
      });
      server.listen(ports[i], HOST, () => resolve(ports[i]));
    };
    tryPort(0);
  });
}

function openBrowser(url) {
  if (process.platform === 'win32') {
    spawn('cmd.exe', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
  } else if (process.platform === 'darwin') {
    spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
  } else {
    spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
  }
}

(async () => {
  await fsp.mkdir(DRAWINGS, { recursive: true });
  const envPort = process.env.CHEMBUILD_PORT ? [Number(process.env.CHEMBUILD_PORT)] : PORT_RANGE;
  const port = await listen(envPort);
  const url = 'http://' + HOST + ':' + port + '/';
  console.log('ChemBuild ready  ->  ' + url);
  console.log('Drawings folder: ' + DRAWINGS);
  console.log('Press Ctrl+C to stop.');
  if (process.argv.indexOf('--open') !== -1) openBrowser(url);
})().catch((err) => {
  console.error('Startup failed:', err.message);
  process.exit(1);
});
