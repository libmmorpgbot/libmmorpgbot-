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

  // ── the bot's own name ───────────────────────────────────────────────────
  // The login screen builds a t.me link from it. Resolved once from getMe and
  // then cached in memory — the old route hit Telegram on every miss, which is
  // a third-party call on the path of the first page a player ever sees.
  //
  // Answered as 503 rather than a guess when the token is missing or Telegram
  // is down: a link to the wrong bot is worse than no link.
  let botName = process.env.TG_BOT_USERNAME || null;
  let botPending = null;
  app.get('/tg-botname', async (_req, res) => {
    if (botName) return res.json({ username: botName });
    const token = process.env.TG_BOT_TOKEN;
    if (!token) return res.status(503).json({ error: 'bot not resolved' });
    try {
      // One in-flight request, however many callers: a burst of logins after a
      // restart would otherwise all miss the cache together.
      botPending = botPending || fetch(`https://api.telegram.org/bot${token}/getMe`)
        .then(r => r.json())
        .finally(() => { botPending = null; });
      const d = await botPending;
      if (!d || !d.ok) return res.status(503).json({ error: 'bot not resolved' });
      botName = d.result.username;
      res.json({ username: botName });
    } catch {
      res.status(503).json({ error: 'bot not resolved' });
    }
  });

  // ── local development ────────────────────────────────────────────────────
  // Signs a Telegram initData for a made-up account so the game can be opened
  // in an ordinary browser. OFF unless DEV_LOCAL is set, and refuses outright
  // when NODE_ENV is production even if it is: this route mints a login, and
  // the only thing standing between it and anyone's account is that it is not
  // mounted. A flag that can be set by accident is not enough — both have to
  // agree.
  if (process.env.DEV_LOCAL === '1' && process.env.NODE_ENV !== 'production') {
    const crypto = require('crypto');
    console.log('DEV_LOCAL: /dev/init-data enabled — local browser login');
    app.get('/dev/init-data', (req, res) => {
      const token = process.env.TG_BOT_TOKEN;
      if (!token) return res.status(503).json({ error: 'TG_BOT_TOKEN not set' });
      const username = (String(req.query.dev || 'dev').slice(0, 32).replace(/[^\w-]/g, '')) || 'dev';
      // Derived from the name rather than random, so reopening the page comes
      // back to the SAME account and yesterday's character is still there.
      const telegramId = '9' + parseInt(
        crypto.createHash('sha1').update(username).digest('hex').slice(0, 10), 16).toString().slice(0, 9);
      const params = new URLSearchParams({
        user: JSON.stringify({ id: Number(telegramId), username, first_name: username }),
        auth_date: String(Math.floor(Date.now() / 1000)),
        query_id: 'DEV',
      });
      const checkStr = [...params.entries()].sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => `${k}=${v}`).join('\n');
      const secret = crypto.createHmac('sha256', 'WebAppData').update(token).digest();
      params.set('hash', crypto.createHmac('sha256', secret).update(checkStr).digest('hex'));
      res.json({ initData: params.toString() });
    });
  }

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
