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

// The bundle exactly as server/assets.js builds it. MIN=1 in the environment
// serves the terser output instead — which is what players actually download.
// Minification is configured with toplevel mangling AND toplevel compression
// off (assets.js explains why: half the client's entry points are named from
// strings inside index.html and inside JS template literals, which a minifier
// cannot see). That configuration is a promise, and this is the only place it
// can be checked by running the result instead of trusting it.
//
//   node dev/render-check.js         the readable bundle
//   MIN=1 node dev/render-check.js   what actually ships
const MINIFY = process.env.MIN === '1';
// --run / RUN=1: открыть страницу самому, дождаться результата и выйти с
// кодом. Без этого файл только подаёт страницу и ждёт человека с браузером.
const RUN = process.env.RUN === '1' || process.argv.includes('--run');
// ── proving an assertion can still go red ──────────────────────────────────
// A check that has never failed is a check nobody has tested, and the only way
// to see one of these fail used to be editing the client, running, and editing
// it back — by hand, in the tree the owner is working in. dev/bundle-check.js
// has I18N_FILE for exactly this reason ("that is how a change to them gets
// proven still able to go red"); this had no equivalent, so the wallet
// assertions above were written and never once seen red.
//
// PREV=<dir> serves any bundled file that EXISTS under <dir> in place of the
// one in the repo; everything else still comes from the repo. So
//
//   mkdir -p /tmp/prev/js && git show HEAD:js/ui.js > /tmp/prev/js/ui.js
//   PREV=/tmp/prev node dev/render-check.js --run
//
// runs TODAY's assertions against YESTERDAY's client, and the ones that stay
// green are the ones that were never load-bearing. Nothing in the working
// tree is touched, which is the whole point of doing it this way round.
const PREV = process.env.PREV || '';
function bundleSrc(f) {
  if (PREV) {
    const alt = path.join(PREV, f);
    if (fs.existsSync(alt)) return alt;
  }
  return path.join(ROOT, f);
}
function bundle() {
  const raw = FILES.map(f => fs.readFileSync(bundleSrc(f), 'utf8')).join('\n;\n');
  if (!MINIFY) return raw;
  const { minify_sync } = require('terser');
  const out = minify_sync(raw, {
    compress: { toplevel: false },
    mangle:   { toplevel: false },
    format:   { comments: false },
  });
  if (!out || !out.code) throw new Error('terser returned nothing');
  return out.code;
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
  // ── the REAL map of a real floor ─────────────────────────────────────────
  // A synthetic grid proves the renderer works; it does not prove it works on
  // the world players actually load. The tile builder reads rooms, arm
  // entries, race/guild/farm bounds and the biome theme off the dungeon, and
  // a black screen was traced to it failing on exactly that data. So the
  // harness can ask for the genuine article: the same mapPayload the server
  // hands a client, generated here with no database and no sockets.
  // Same path and same bytes the real server answers on, so the client's own
  // _loadWorldMap/_decodeWorldMap run unmodified.
  if (url.startsWith('/api/world-map/')) {
    try {
      const RoomC = require('../server/game/Room.js');
      const { FLOOR_IDS } = require('../server/game/floors.js');
      const want = url.split('/')[3] || 'hub';
      const floor = FLOOR_IDS[want] !== undefined ? FLOOR_IDS[want] : (Number(want) || FLOOR_IDS.hub);
      const r = new RoomC(floor, { to: () => ({ emit: () => {} }), sockets: { sockets: { get: () => null } } }, {}, null);
      const payload = r.mapPayload;
      if (r._interval) clearInterval(r._interval);
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store' });
      return res.end(payload);
    } catch (e) {
      console.error('  [world-map]', e);
      return send(500, 'text/plain', 'world-map failed: ' + e.message);
    }
  }
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
  // PREV through the static handler too, not only through the bundle. It used
  // to substitute bundled JS and nothing else, so css/style.css always came
  // from the working tree — and every assertion about a touch target or a
  // colour stayed green against an old client. An assertion that cannot go red
  // is indistinguishable from one that does not work, which is the exact trap
  // this switch exists to avoid.
  const rel = url.replace(/^\/+/, '');
  const f0 = path.join(ROOT, rel);
  if (!f0.startsWith(ROOT)) return send(403, 'text/plain', 'no');
  const f = bundleSrc(rel);
  fs.readFile(f, (e, d) => {
    if (e) return send(404, 'text/plain', 'not found: ' + url);
    send(200, MIME[path.extname(f)] || 'application/octet-stream', d);
  });
}).listen(PORT, '127.0.0.1', async () => {
  const url = 'http://127.0.0.1:' + PORT + '/render-check';
  if (!RUN) {
    console.log('  render-check: ' + url
      + (MINIFY ? '   [минифицированный бандл — то, что едет игрокам]' : ''));
    console.log('  (`node dev/render-check.js --run` — прогнать самому и выйти с кодом)');
    return;
  }

  // ── самостоятельный прогон ────────────────────────────────────────────────
  // Без этого файл только ПОДАВАЛ страницу, а открыть её и прочитать результат
  // должен был человек. Проверку, которую нельзя запустить одной командой, не
  // запускают: за всё время её гоняли вручную, и ровно те два дефекта, которые
  // владелец нашёл сам за полчаса — 404 на картинке и адрес кошелька в сырой
  // форме — жили в коде, который эта проверка покрывает.
  //
  // channel:'chrome' — берётся УЖЕ УСТАНОВЛЕННЫЙ Chrome, а не скачивается свой:
  // 300 МБ ради страницы, которую надо открыть один раз, того не стоят.
  let browser;
  try {
    const { chromium } = require('playwright');
    browser = await chromium.launch({ headless: true, channel: 'chrome' });
    const page = await browser.newPage({ viewport: { width: 900, height: 800 } });
    // Страница пишет свой лог в DOM; забираем его целиком, а не по строчке,
    // чтобы порядок и отступы дошли такими же, как их видит человек.
    page.on('pageerror', e => console.error('  [страница]', e.message));

    await page.goto(url, { waitUntil: 'domcontentloaded' });
    // Заголовок — сигнал завершения, который харнес ставит сам (см. finish()
    // в render-check.html). Ждём его, а не фиксированную паузу: прогон длится
    // от десяти секунд до минуты в зависимости от машины.
    // Строкой, а не стрелкой: тело исполняется в БРАУЗЕРЕ, и стрелка здесь
    // заставила бы линтер этого файла (окружение node) искать document.
    await page.waitForFunction(
      String.raw`/^render-check (OK|FAIL)/.test(document.title)`, null, { timeout: 240000 });

    const out = await page.evaluate(`document.body.innerText`);
    console.log(out.replace(/^/gm, '  '));
    const title = await page.title();
    const bad = /FAIL/.test(title);
    await browser.close();
    process.exit(bad ? 1 : 0);
  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    // Отсутствующий Chrome — это «проверка не выполнена», а не «проверка
    // прошла». Разные коды выхода, чтобы CI не принял одно за другое.
    console.error('  render-check не смог прогнаться: ' + err.message);
    process.exit(2);
  }
});
