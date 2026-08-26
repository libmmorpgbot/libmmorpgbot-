#!/usr/bin/env node
'use strict';
// ═══════════════════════════════════════════════════════════════════════════
//  render-check.js — serve the real client so a browser can prove it draws
// ═══════════════════════════════════════════════════════════════════════════
//
//   node dev/render-check.js        then open http://127.0.0.1:8791/render-check
//
// Why this exists: every other detector in dev/ reads code or asks the
// database. None of them can tell whether the renderer puts anything on the
// screen — and the one time that broke (a duplicate top-level `let` between
// game.js and pixi-world.js) it shipped to production and every player got a
// blank page. The bundle parsed on the server; nothing ran it.
//
// This serves index.html and the real concatenated bundle with two things
// stubbed — socket.io and Telegram — then the page fakes a world, runs the
// real render path, and reports what the GPU was actually handed. No server,
// no database, no login.
const http = require('http');
const fs   = require('fs');
const path = require('path');

const ROOT  = path.join(__dirname, '..');
const FILES = require('../server/bundle-files');
const PORT  = Number(process.env.PORT || 8791);

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.webp': 'image/webp',
  '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.json': 'application/json',
  '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav',
};

function bundle() {
  return FILES.map(f => fs.readFileSync(path.join(ROOT, f), 'utf8')).join('\n;\n');
}

// The two things the client reaches for that have nothing to do with drawing.
const IO_STUB = `
window.io = function () {
  const s = { connected: false, id: 'render-check', io: { engine: { transport: { name: 'stub' } } } };
  s.on = () => s; s.once = () => s; s.off = () => s; s.emit = () => s;
  s.onAny = () => s; s.connect = () => s; s.disconnect = () => s;
  return s;
};`;

http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);
  const send = (code, type, body) => {
    res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    res.end(body);
  };
  if (url === '/socket.io/socket.io.js') return send(200, MIME['.js'], IO_STUB);
  if (url === '/bundle.js')              return send(200, MIME['.js'], bundle());
  // The game page itself, with an error collector prepended and the Telegram
  // SDK dropped — the harness needs to see what the client throws, and it has
  // no business reaching out to telegram.org to find out whether it draws.
  // The harness POSTs a composited frame here so the run leaves a picture
  // behind, not just a list of assertions. 'It drew something' and 'it drew
  // the right thing' are different claims and only one of them is testable.
  if (url === '/shot' && req.method === 'POST') {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      const comma = body.indexOf(',');
      const b64 = comma >= 0 ? body.slice(comma + 1) : body;
      const out = path.join(__dirname, '_render-shot.png');
      fs.writeFileSync(out, Buffer.from(b64, 'base64'));
      console.log('  снимок кадра -> ' + out + ' (' + (b64.length / 1365).toFixed(0) + ' KB)');
      send(200, 'text/plain', 'ok');
    });
    return;
  }
  if (url === '/game-frame.html') {
    let html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    const tg = html.indexOf('telegram.org/js/telegram-web-app.js');
    if (tg > 0) {
      const a = html.lastIndexOf('<script', tg), b = html.indexOf('</script>', tg);
      if (a >= 0 && b > a) html = html.slice(0, a) + html.slice(b + 9);
    }
    return send(200, MIME['.html'],
      '<script>window.__rcErrors=[];' +
      'addEventListener("error",function(e){__rcErrors.push(String(e.message)+" @"+(e.filename||"").split("/").pop()+":"+e.lineno);});' +
      'addEventListener("unhandledrejection",function(e){__rcErrors.push("promise: "+((e.reason&&e.reason.message)||e.reason));});' +
      '</script>' + html);
  }
  if (url === '/render-check' || url === '/')
    return send(200, MIME['.html'], fs.readFileSync(path.join(__dirname, 'render-check.html')));
  const f = path.join(ROOT, url);
  if (!f.startsWith(ROOT)) return send(403, 'text/plain', 'no');
  fs.readFile(f, (e, d) => {
    if (e) return send(404, 'text/plain', 'not found: ' + url);
    send(200, MIME[path.extname(f)] || 'application/octet-stream', d);
  });
}).listen(PORT, '127.0.0.1', () => {
  console.log('  render-check: http://127.0.0.1:' + PORT + '/render-check');
});
