'use strict';
// ── Everything the browser downloads ───────────────────────────────────────
// The new server had none of this. It answered sockets and /health and served
// no client at all: no index.html, no bundle, no images, no audio, no map.
// Caddy would have returned 404 for every page and the game would not have
// loaded — which is the kind of gap that is obvious the moment anyone opens
// the site and invisible to every test that speaks socket.io.
//
// Ported from server/index.js with the cache policy intact, because that
// policy is doing real work:
//
//   * the bundle and the CSS are served at a path containing their own content
//     hash, so they are immutable for a year and a deploy is a new URL rather
//     than a cache to bust.
//   * /bundle.js is the same bytes at a stable path with `no-cache`, for a
//     client that has the old index.html cached.
//   * index.html itself is `no-cache`: it is the one file that must be
//     re-fetched, because it names the hashed paths.
//   * images and audio never change between deploys and are immutable for a
//     month.
//
// The world map is content-addressed too — /api/world-map/:floor/:ver — and a
// stale version is a 404 rather than the current map, so a client that asks
// for yesterday's geometry is told to re-read gameStart rather than handed
// something its enemies do not match.

const path = require('path');
const express = require('express');

const ROOT = path.join(__dirname, '..');
const assets = require('./assets');

const IMMUTABLE_YEAR = 'public, max-age=31536000, immutable';

// index.html, and the handful of other pages served whole. Anything not on
// this list is not reachable — the alternative, pointing express.static at the
// repo root, would publish server/, dev/ and .env alongside them.
const PAGES = {
  '/':                         'index.html',
  '/index.html':               'index.html',
  '/guide.html':               'guide.html',
  '/admin.html':               'admin.html',
  '/tonconnect-manifest.json': 'tonconnect-manifest.json',
};

function mount(app, { floorRooms }) {
  // ── the client bundle ────────────────────────────────────────────────────
  app.get([assets.JS_BUNDLE_PATH, '/bundle.js'], (req, res) => {
    if (req.headers['if-none-match'] === assets.jsBundleEtag) return res.status(304).end();
    res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    res.setHeader('ETag', assets.jsBundleEtag);
    res.setHeader('Cache-Control', req.path === assets.JS_BUNDLE_PATH ? IMMUTABLE_YEAR : 'no-cache');
    res.setHeader('Vary', 'Accept-Encoding');
    if (/\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
      res.setHeader('Content-Encoding', 'gzip');
      return res.send(assets.jsBundleGz);
    }
    res.send(assets.jsBundleCode);
  });

  app.get(assets.JS_MAP_PATH, (_req, res) => {
    if (!assets.jsBundleMap) return res.status(404).end();
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', IMMUTABLE_YEAR);
    res.send(assets.jsBundleMap);
  });

  app.get(assets.CSS_PATH, (_req, res) => {
    res.setHeader('Content-Type', 'text/css; charset=utf-8');
    res.setHeader('Cache-Control', IMMUTABLE_YEAR);
    res.send(assets.cssBundle);
  });

  // ── vendored libraries ───────────────────────────────────────────────────
  // Served from disk rather than bundled: PixiJS is larger than everything
  // else put together and never changes between deploys, so it belongs in its
  // own immutable cache entry.
  for (const p of ['/js/pixi.min.js', '/js/vendor/tonconnect-ui.min.js', '/js/vendor/tonconnect-ui.min.js.map']) {
    app.get(p, (_req, res) => {
      res.setHeader('Cache-Control', IMMUTABLE_YEAR);
      res.sendFile(path.join(ROOT, p.replace(/^\//, '')), err => { if (err) res.status(404).end(); });
    });
  }

  // ── media ────────────────────────────────────────────────────────────────
  app.use('/images', express.static(path.join(ROOT, 'images'), { maxAge: '30d', immutable: true }));
  app.use('/audio',  express.static(path.join(ROOT, 'audio'),  { maxAge: '30d', immutable: true }));
  app.use('/css',    express.static(path.join(ROOT, 'css')));

  // ── the world's geometry ─────────────────────────────────────────────────
  app.get('/api/world-map/:floor/:ver', (req, res) => {
    const room = floorRooms.get(Number(req.params.floor));
    if (!room) return res.status(503).json({ error: 'not ready' });
    // A stale version is a 404, not the current map: handing over new geometry
    // to a client still drawing the old enemies is worse than making it ask
    // again.
    if (req.params.ver !== room.mapVersion) return res.status(404).json({ error: 'stale version' });
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Cache-Control', IMMUTABLE_YEAR);
    res.setHeader('ETag', `"${room.mapVersion}"`);
    res.send(room.mapPayload);
  });

  // ── pages ────────────────────────────────────────────────────────────────
  app.get(Object.keys(PAGES), (req, res) => {
    if (PAGES[req.path] === 'index.html') {
      // Built at boot with the hashed asset paths substituted in, and never
      // cached — it is what tells the browser which hashed bundle to fetch.
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache');
      return res.send(assets.INDEX_HTML);
    }
    res.sendFile(path.join(ROOT, PAGES[req.path]), err => { if (err) res.status(404).end(); });
  });
}

module.exports = { mount, PAGES };
