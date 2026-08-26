'use strict';
// ── The admin panel, on PostgreSQL ─────────────────────────────────────────
// A port of server/routes/admin.js, which read six Mongo models directly and
// was not mounted on the new server at all. Two things are different, and both
// matter more than the port.
//
// AN ADMIN GRANT GOES THROUGH THE LEDGER. The old /give wrote savedData.gold
// straight onto the document and incremented the balance field beside it.
// money.js exists so that every movement of value has a row saying who moved
// it and why — an admin grant that skips it is money appearing from nowhere,
// which is precisely what reconcile() alarms on. So a grant is a credit with
// reason 'admin_give' and the admin's name in the reference, and it shows up
// in the player's own balance history like everything else.
//
// EVERY WRITE IS AUDITED. admin-auth's audit() records who did what to whom.
// The old panel logged some actions to player_logs and others not at all.
//
// The reads are one query each. Several of the old ones were N+1 loops — the
// market page fetched every listing and then looked up each seller by id.

const adminAuth = require('../admin-auth');
const ops = require('../tg-ops');
const { query, tx } = require('../db');
const money = require('../db/repos/money');
const items = require('../db/repos/items');
const players = require('../db/repos/players');
const progression = require('../db/repos/progression');
const market = require('../db/repos/market');
const plog = require('../db/repos/playerlog');
const { ITEM_DEF, CRAFT_MATS, BOX_DEF } = require('../../shared/definitions');

const CATALOG = [...ITEM_DEF, ...CRAFT_MATS, ...BOX_DEF];

const num = (v, d = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};
const int = (v, d = 0) => Math.trunc(num(v, d));
const clampLimit = (v, d = 30, max = 200) => Math.max(1, Math.min(max, int(v, d) || d));

module.exports = function registerAdminRoutes(app, deps) {
  const { io, modes, maintenance } = deps;
  const guard = adminAuth.requireAdmin;
  const csrf = adminAuth.requireCsrfHeader;

  // Who is connected, by telegram id. Read once per request rather than per
  // row — the old players list did a Set build inside the map.
  const onlineTids = () => new Set(
    [...io.sockets.sockets.values()].map(s => s.data && s.data.telegramId).filter(Boolean));

  // ── nothing fails quietly ────────────────────────────────────────────────
  // Every one of these used to be a console.error and nothing else. An admin
  // pressing a button that does not work had no way to find out why, and
  // neither did anyone else — which is exactly the complaint: the panel said
  // nothing, and the alerts topic said nothing either.
  //
  // fail() is for a crash: something threw. deny() is for a refusal: the
  // request was understood and answered no. Both are reported now, because
  // "почему не сработало" has to have an answer either way — but they are
  // reported under different keys, so a wrong click and a broken route do not
  // look alike in the group.
  const fail = (res, e, req) => {
    const at = req ? `${req.method} ${req.path}` : 'admin';
    console.error(`[admin] ${at}`, e);
    ops.alertError(`admin.fail.${(req && req.route && req.route.path) || at}`,
      `Админка: ошибка ${at}`, e, { админ: req ? who(req) : undefined }).catch(() => {});
    res.status(500).json({ error: e.message || 'server error' });
  };

  // A refusal the admin sees as a red toast. Reported too, because half of the
  // "кнопка не работает" reports are a rule firing, and a rule that fires
  // invisibly is indistinguishable from a broken button.
  const deny = (res, req, code, message) => {
    console.warn(`[admin] ${req.method} ${req.path} → ${code} ${message}`);
    ops.alert(`admin.deny.${req.path.replace(/\d+/g, '#')}.${code}`,
      `Админка отказала: ${message}`, `${req.method} ${req.path}`,
      { админ: who(req), код: code }).catch(() => {});
    return res.status(code).json({ error: message });
  };
  const who = req => (req.admin && req.admin.sub) || 'admin';

  // ── login ────────────────────────────────────────────────────────────────
  app.post('/admin/login', async (req, res) => {
    try {
      const { username, password } = req.body || {};
      const ip = req.ip;
      const locked = adminAuth.lockedFor(ip);
      if (locked > 0) {
        // Somebody is guessing. This is the one alert here that is about
        // security rather than about a broken button, and it is the reason the
        // lockout is not enough on its own: a lockout that nobody is told about
        // stops the attempt and hides that it happened.
        ops.alert('admin.locked', 'Админка: вход заблокирован после серии попыток',
          `IP ${ip}`, { осталось: `${Math.ceil(locked / 1000)}с` }).catch(() => {});
        return res.status(429).json({ error: `Слишком много попыток, подождите ${Math.ceil(locked / 1000)}с` });
      }
      // The name is checked too, and both are checked in constant time
      // relative to each other: verifyPassword is scrypt and takes ~44ms
      // whatever it is given, so a wrong username must not short-circuit past
      // it and answer in a microsecond.
      const nameOk = String(username || '') === (process.env.ADMIN_USERNAME || '');
      const passOk = adminAuth.verifyPassword(password, process.env.ADMIN_PASSWORD_HASH);
      if (!nameOk || !passOk) {
        adminAuth.recordFail(ip);
        ops.alert('admin.badlogin', 'Админка: неудачный вход', `IP ${ip}`,
          { имя: String(username || '').slice(0, 40) }).catch(() => {});
        // Deliberately vague, and deliberately the same message for a wrong
        // name as for a wrong password: the difference is an oracle.
        return res.status(401).json({ error: 'Неверные данные' });
      }
      adminAuth.clearFails(ip);
      const token = await adminAuth.issue(username);
      adminAuth.setCookie(res, token);
      await adminAuth.audit(username, 'login', { meta: { ip } });
      ops.alert(`admin.login.${ip}`, 'Вход в админ-панель', `IP ${ip}`,
        { имя: String(username).slice(0, 40) }).catch(() => {});
      // The COOKIE is the credential — httpOnly, so page JavaScript cannot read
      // it and an XSS in the game client cannot walk off with it. `csrf` is not
      // a second credential: it is a value the page keeps so it knows it is
      // logged in, and the header it sends alongside it is what a cross-site
      // form cannot forge.
      //
      // The page used to read `d.token` here, which this has never returned. It
      // stored the string "undefined" and sent it as a Bearer header on every
      // request; the requests worked anyway, on the cookie, which is why the
      // mistake survived — until the first POST, which needs the header this
      // reply is really about.
      res.json({ ok: true, csrf: token.slice(0, 16) });
    } catch (e) { fail(res, e, req); }
  });

  app.post('/admin/logout', guard, csrf, async (req, res) => {
    adminAuth.clearCookie(res);
    await adminAuth.audit(who(req), 'logout', { meta: { username: who(req) } });
    res.json({ ok: true });
  });

  // ── overview ─────────────────────────────────────────────────────────────
  app.get('/admin/stats', guard, async (req, res) => {
    try {
      // One statement for the counters. Four round trips for four COUNT(*)s
      // over the same table is three more than it needs.
      const { rows: c } = await query(null, `
        SELECT
          count(*)::int                                                        AS total,
          count(*) FILTER (WHERE created_at >= now() - interval '1 day')::int   AS new_today,
          count(*) FILTER (WHERE created_at >= now() - interval '7 days')::int  AS new_week,
          count(*) FILTER (WHERE banned)::int                                   AS banned
        FROM players`);

      const { rows: g } = await query(null, `
        SELECT COALESCE(sum(amount), 0)::numeric AS total
          FROM gram_tx WHERE type = 'deposit' AND status = 'confirmed'`);

      const top = async (sql, params = []) => (await query(null, sql, params)).rows;
      const tops = {
        bm: await top(`SELECT username, bm AS val FROM players ORDER BY bm DESC NULLS LAST LIMIT 5`),
        lvl: await top(`
          SELECT p.username, pr.lvl AS val FROM player_progress pr
            JOIN players p ON p.id = pr.player_id ORDER BY pr.lvl DESC LIMIT 5`),
        gold: await top(`
          SELECT p.username, b.amount AS val FROM balances b
            JOIN players p ON p.id = b.player_id
           WHERE b.currency = 'gold' ORDER BY b.amount DESC LIMIT 5`),
        nexum: await top(`
          SELECT p.username, b.amount AS val FROM balances b
            JOIN players p ON p.id = b.player_id
           WHERE b.currency = 'nexum' ORDER BY b.amount DESC LIMIT 5`),
      };

      res.json({
        total: c[0].total, newToday: c[0].new_today, newWeek: c[0].new_week,
        banned: c[0].banned, online: io.sockets.sockets.size,
        gramTotal: Number(g[0].total),
        tops: Object.fromEntries(Object.entries(tops).map(([k, rows]) =>
          [k, rows.map(r => ({ username: r.username, val: Number(r.val) }))])),
      });
    } catch (e) { fail(res, e, req); }
  });

  app.get('/admin/players', guard, async (req, res) => {
    try {
      const limit = clampLimit(req.query.limit);
      const page = Math.max(1, int(req.query.page, 1));
      const q = String(req.query.q || '').slice(0, 64);

      // ILIKE with the pattern as a PARAMETER — the old version escaped the
      // string into a regex by hand, which is one forgotten character away
      // from a search that scans the table or throws.
      const { rows } = await query(null, `
        SELECT p.id, p.telegram_id, p.username, p.bm, p.banned, p.referred_by, p.created_at,
               COALESCE(pr.lvl, 1) AS lvl,
               COALESCE(bg.amount, 0) AS gold,
               COALESCE(bn.amount, 0) AS nexum,
               COALESCE(bm2.amount, 0) AS gram,
               count(*) OVER ()::int AS total
          FROM players p
          LEFT JOIN player_progress pr ON pr.player_id = p.id
          LEFT JOIN balances bg  ON bg.player_id  = p.id AND bg.currency  = 'gold'
          LEFT JOIN balances bn  ON bn.player_id  = p.id AND bn.currency  = 'nexum'
          LEFT JOIN balances bm2 ON bm2.player_id = p.id AND bm2.currency = 'gram'
         WHERE ($1 = '' OR p.username ILIKE '%' || $1 || '%')
         ORDER BY p.bm DESC NULLS LAST
         LIMIT $2 OFFSET $3`, [q, limit, (page - 1) * limit]);

      const online = onlineTids();
      res.json({
        total: rows.length ? rows[0].total : 0,
        page, limit,
        players: rows.map(r => ({
          id: Number(r.id), telegramId: r.telegram_id, username: r.username,
          bm: r.bm || 0, banned: r.banned, lvl: r.lvl,
          gold: Number(r.gold), nexum: Number(r.nexum), gram: Number(r.gram),
          referredBy: r.referred_by, createdAt: r.created_at,
          online: online.has(r.telegram_id),
        })),
      });
    } catch (e) { fail(res, e, req); }
  });

  app.get('/admin/top-referrals', guard, async (req, res) => {
    try {
      // Ranked by GRAM the referrals actually deposited, which is the number
      // the referral bonus is paid on — not by how many people signed up.
      const { rows } = await query(null, `
        SELECT r.username, r.telegram_id,
               count(f.id)::int AS friends,
               COALESCE(sum(t.amount) FILTER (
                 WHERE t.type = 'deposit' AND t.status = 'confirmed'), 0)::numeric AS gram
          FROM players r
          JOIN players f ON f.referred_by = r.telegram_id
          LEFT JOIN gram_tx t ON t.player_id = f.id
         GROUP BY r.id, r.username, r.telegram_id
         ORDER BY gram DESC, friends DESC
         LIMIT 50`);
      // `referrers`, `count`, `bonusEarned` — the names the page reads. It was
      // reading `d.referrers` off a reply that said `rows`, so the tab showed
      // "Рефералов пока нет" no matter how many there were.
      res.json({
        referrers: rows.map(r => ({
          username: r.username, telegramId: r.telegram_id,
          count: r.friends, bonusEarned: Number(r.gram),
        })),
      });
    } catch (e) { fail(res, e, req); }
  });

  app.get('/admin/top-market', guard, async (req, res) => {
    try {
      // BOTH sides of the trade. Grouping by seller only answered half the
      // question, and the page asks for the other half by name (`bought`,
      // `boughtCount`) — those columns rendered as `undefined` beside real
      // ones, which is what makes a table look broken rather than empty.
      const { rows } = await query(null, `
        WITH sides AS (
          SELECT seller_id AS player_id, price, 'sold' AS side FROM market_listings WHERE status = 'sold'
          UNION ALL
          SELECT buyer_id  AS player_id, price, 'bought'      FROM market_listings
           WHERE status = 'sold' AND buyer_id IS NOT NULL
        )
        SELECT p.username, p.telegram_id,
               COALESCE(sum(s.price) FILTER (WHERE s.side = 'sold'), 0)::numeric   AS sold,
               count(*) FILTER (WHERE s.side = 'sold')::int                        AS sold_count,
               COALESCE(sum(s.price) FILTER (WHERE s.side = 'bought'), 0)::numeric AS bought,
               count(*) FILTER (WHERE s.side = 'bought')::int                      AS bought_count
          FROM sides s JOIN players p ON p.id = s.player_id
         GROUP BY p.id, p.username, p.telegram_id
         ORDER BY (COALESCE(sum(s.price), 0)) DESC
         LIMIT 50`);
      res.json({
        traders: rows.map(r => ({
          username: r.username, telegramId: r.telegram_id,
          sold: Number(r.sold), soldCount: r.sold_count,
          bought: Number(r.bought), boughtCount: r.bought_count,
        })),
      });
    } catch (e) { fail(res, e, req); }
  });

  // ── one player ───────────────────────────────────────────────────────────
  const byTid = async (tid) => {
    const { rows } = await query(null,
      'SELECT id, telegram_id, username, bm, banned, referred_by, created_at FROM players WHERE telegram_id = $1',
      [String(tid)]);
    return rows.length ? rows[0] : null;
  };

  app.get('/admin/player/:tid', guard, async (req, res) => {
    try {
      const p = await byTid(req.params.tid);
      if (!p) return deny(res, req, 404, 'Игрок не найден');
      const id = Number(p.id);

      const prog = await players.progressOf(null, id);
      const skills = await players.skillsOf(null, id);
      const inv = await items.inventoryOf(null, id);
      const bal = await money.balancesOf(null, id);
      const vip = await progression.vipOf(null, id);
      const season = await progression.seasonOf(null, id);
      const { rows: daily } = await query(null,
        'SELECT mode, used, seconds FROM player_daily WHERE player_id = $1 AND day = CURRENT_DATE', [id]);

      // What happened to this player, from two sources that answer different
      // questions. player_logs is the action trail (see repos/playerlog.js —
      // it had no writer until now, so this pane was empty for everyone). The
      // ledger is where the money went, and it is the one the questions are
      // actually about: "куда делось золото" has an exact answer here.
      const logs = await plog.recent(null, id, 120);
      const { rows: ledger } = await query(null, `
        SELECT currency, delta, reason, ref_type, ref_id, created_at
          FROM ledger WHERE player_id = $1
         ORDER BY id DESC LIMIT 80`, [id]);
      // Both lists in one stream, newest first, so a grant and the purchase it
      // paid for sit next to each other instead of in two panes.
      const merged = [
        ...logs,
        ...ledger.map(l => ({
          event: `${Number(l.delta) >= 0 ? '+' : ''}${l.currency}`,
          at: l.created_at,
          meta: {
            сумма: Number(l.delta), причина: l.reason,
            ref: l.ref_id ? `${l.ref_type || ''}:${l.ref_id}` : undefined,
          },
        })),
      ].sort((a, b) => new Date(b.at) - new Date(a.at)).slice(0, 150);

      // The season pane reads these two by name and neither was sent, so it
      // showed "0 очков" for a player who had thousands.
      const { rows: seasonLog } = await query(null, `
        SELECT event, meta, created_at FROM player_logs
         WHERE player_id = $1 AND event LIKE 'season%'
         ORDER BY created_at DESC LIMIT 60`, [id]);

      res.json({
        telegramId: p.telegram_id, username: p.username, bm: p.bm,
        banned: p.banned, referredBy: p.referred_by, createdAt: p.created_at,
        online: onlineTids().has(p.telegram_id),
        progress: prog, skills, items: inv, balances: bal, vip, season,
        daily: Object.fromEntries(daily.map(d => [d.mode, { used: d.used, seconds: d.seconds }])),
        logs: merged,
        seasonPoints: (season && season.points) || 0,
        seasonLogs: seasonLog.map(r => ({ event: r.event, meta: r.meta, at: r.created_at })),
      });
    } catch (e) { fail(res, e, req); }
  });

  const banHandler = (banned) => async (req, res) => {
    try {
      const { rows } = await query(null,
        'UPDATE players SET banned = $2 WHERE telegram_id = $1 RETURNING id, username',
        [String(req.params.tid), banned]);
      if (!rows.length) return deny(res, req, 404, 'Игрок не найден');
      await adminAuth.audit(who(req), banned ? 'ban' : 'unban',
        { refType: 'player', refId: req.params.tid, meta: { username: rows[0].username } });
      // A ban takes effect NOW, not on their next login. The old version set
      // the flag and left the session running.
      if (banned) {
        const sock = [...io.sockets.sockets.values()]
          .find(s => s.data && s.data.telegramId === String(req.params.tid));
        if (sock) { sock.emit('kicked', { reason: 'Аккаунт заблокирован' }); sock.disconnect(true); }
      }
      res.json({ ok: true });
    } catch (e) { fail(res, e, req); }
  };
  app.post('/admin/player/:tid/ban', guard, csrf, banHandler(true));
  app.post('/admin/player/:tid/unban', guard, csrf, banHandler(false));

  const resetAttempts = (mode) => async (req, res) => {
    try {
      const p = await byTid(req.params.tid);
      if (!p) return deny(res, req, 404, 'Игрок не найден');
      await query(null,
        'DELETE FROM player_daily WHERE player_id = $1 AND day = CURRENT_DATE AND mode = $2',
        [p.id, mode]);
      await adminAuth.audit(who(req), 'reset_attempts', { meta: { by: who(req), telegramId: p.telegram_id, mode } });
      res.json({ ok: true, mode });
    } catch (e) { fail(res, e, req); }
  };
  app.post('/admin/player/:tid/reset-fear-attempts', guard, csrf, resetAttempts('fear'));
  app.post('/admin/player/:tid/reset-coop-attempts', guard, csrf, resetAttempts('coop'));

  // ── granting ─────────────────────────────────────────────────────────────
  // Through money.js, so the grant is in the ledger with the admin's name on
  // it. The old path wrote the balance field directly, which is money
  // appearing from nowhere as far as reconcile() is concerned — the alarm
  // would have fired on every admin gift.
  app.post('/admin/player/:tid/give', guard, csrf, async (req, res) => {
    try {
      const body = req.body || {};
      const gold = num(body.gold), nexum = num(body.nexum), gram = num(body.gram);
      const sp = int(body.sp);
      if (!gold && !nexum && !gram && !sp) return deny(res, req, 400, 'Нечего выдавать');

      const p = await byTid(req.params.tid);
      if (!p) return deny(res, req, 404, 'Игрок не найден');
      const id = Number(p.id);
      const stamp = `${Date.now()}`;

      const bal = await tx(async (t) => {
        for (const [cur, amt] of [['gold', gold], ['nexum', nexum], ['gram', gram]]) {
          if (!amt) continue;
          const opts = {
            reason: 'admin_give', refType: 'admin', refId: who(req),
            idemKey: `admin_give:${id}:${cur}:${stamp}`,
          };
          // A negative amount is a TAKE, and it is allowed — an admin has to
          // be able to undo a mistake. It goes through spend() so the balance
          // cannot be driven below zero by one.
          if (amt > 0) await money.credit(t, id, cur, amt, opts);
          else if (!await money.spend(t, id, cur, -amt, opts)) {
            throw Object.assign(new Error(`Недостаточно ${cur}`), { userMessage: `Недостаточно ${cur}` });
          }
        }
        if (sp) {
          await query(t, `
            UPDATE player_progress SET bonus_sp = GREATEST(0, bonus_sp + $2)
             WHERE player_id = $1`, [id, sp]);
        }
        return money.balancesOf(t, id);
      });

      await adminAuth.audit(who(req), 'give', { meta: { by: who(req), telegramId: p.telegram_id, gold, nexum, gram, sp } });

      // Told immediately, in the events the client already handles.
      const room = `tg_${p.telegram_id}`;
      if (gold)  io.to(room).emit('goldSync', { gold: bal.gold });
      if (gram)  io.to(room).emit('gramBalanceUpdate', { balance: bal.gram });
      if (nexum) io.to(room).emit('nexumBalanceUpdate', { balance: bal.nexum });
      io.to(room).emit('adminGive', { gold, nexum, gram, sp, newGold: bal.gold });

      res.json({ ok: true, balances: bal });
    } catch (e) {
      if (e.userMessage) return deny(res, req, 400, e.userMessage);
      fail(res, e, req);
    }
  });

  // Everyone at once. Bounded and batched: the old version built an array of
  // every player id in the game and issued one update per id.
  app.post('/admin/give-all', guard, csrf, async (req, res) => {
    try {
      const gold = int((req.body || {}).gold);
      const sp = int((req.body || {}).sp);
      if (!gold && !sp) return deny(res, req, 400, 'Нечего выдавать');
      if (gold < 0 || sp < 0) return deny(res, req, 400, 'Только положительные суммы');

      const stamp = `${Date.now()}`;
      const n = await tx(async (t) => {
        const { rows } = await query(t, 'SELECT id FROM players WHERE NOT banned');
        for (const r of rows) {
          if (gold) {
            await money.credit(t, Number(r.id), 'gold', gold, {
              reason: 'admin_give_all', refType: 'admin', refId: who(req),
              idemKey: `admin_give_all:${r.id}:gold:${stamp}`,
            });
          }
          if (sp) {
            await query(t, 'UPDATE player_progress SET bonus_sp = bonus_sp + $2 WHERE player_id = $1',
              [r.id, sp]);
          }
        }
        return rows.length;
      });

      await adminAuth.audit(who(req), 'give_all', { meta: { by: who(req), gold, sp, players: n } });
      io.emit('adminGive', { gold, nexum: 0, gram: 0, sp });
      ops.alert('admin.giveall', 'Выдача всем игрокам', null,
        { админ: who(req), золото: gold || undefined, очки: sp || undefined, игроков: n }).catch(() => {});
      // `online` and `offline` because that is what the panel's toast prints.
      // It was reading two fields this had never sent, so a successful give-all
      // reported "Выдано: undefined онлайн, undefined офлайн".
      const online = onlineTids().size;
      res.json({ ok: true, players: n, online, offline: Math.max(0, n - online) });
    } catch (e) { fail(res, e, req); }
  });

  app.post('/admin/player/:tid/season-points', guard, csrf, async (req, res) => {
    try {
      const pts = int((req.body || {}).points);
      const p = await byTid(req.params.tid);
      if (!p) return deny(res, req, 404, 'Игрок не найден');
      const { rows } = await query(null, `
        INSERT INTO player_season (player_id, season, points)
        VALUES ($1, $2, GREATEST(0, $3))
        ON CONFLICT (player_id, season) DO UPDATE
          SET points = GREATEST(0, player_season.points + $3)
        RETURNING points`, [p.id, progression.CURRENT_SEASON, pts]);
      await adminAuth.audit(who(req), 'season_points', { meta: { by: who(req), telegramId: p.telegram_id, points: pts } });
      res.json({ ok: true, total: Number(rows[0].points) });
    } catch (e) { fail(res, e, req); }
  });

  // ── items ────────────────────────────────────────────────────────────────
  app.get('/admin/items', guard, (req, res) => {
    res.json({
      items: CATALOG.map(d => ({
        id: d.id, name: d.name, slot: d.slot || 'material', rarity: d.rarity || null,
      })),
    });
  });

  // TWO CALLING CONVENTIONS, because there are two callers and only one of
  // them was ever implemented here.
  //
  //   { itemId, qty, enhance, remove }              — scripts, dev/adminapi-check
  //   { action: 'add'|'removeInv'|'removeEq', … }   — the panel
  //
  // The panel's has never worked: it sends `action` and either an inventory
  // INDEX or an equipment SLOT, and this route read `itemId`, found undefined,
  // and answered "Неизвестный предмет" to every click. Removing by index is
  // also the only way to delete one particular row when a player holds five
  // copies of the same sword at different enhancement levels, so it is not a
  // convenience — it is the operation the panel needs and could not express.
  app.post('/admin/player/:tid/items', guard, csrf, async (req, res) => {
    try {
      const body = req.body || {};
      const p = await byTid(req.params.tid);
      if (!p) return deny(res, req, 404, 'Игрок не найден');
      const id = Number(p.id);
      const action = body.action || (body.remove ? 'remove' : 'add');
      const n = Math.max(1, int(body.qty, 1));
      const enh = Math.max(0, Math.min(15, int(body.enhance, 0)));

      if ((action === 'add' || action === 'remove')
          && (typeof body.itemId !== 'string' || !CATALOG.some(d => d.id === body.itemId))) {
        return deny(res, req, 400, 'Неизвестный предмет');
      }

      const done = await tx(async (t) => {
        await items.lockPlayer(t, id);
        // WHICH admin goes into the ledger on the way out too, for the same
        // reason it goes in on the way in (see the grant below). A removal is
        // the half an audit asks about first, and 'consume' — the default a
        // player's own craft leaves — would file it as one.
        const byAdmin = { reason: 'admin_remove', refType: 'admin', refId: who(req) };
        if (action === 'remove') {
          const gone = await items.removeQty(t, id, body.itemId, n, byAdmin);
          if (!gone) throw Object.assign(new Error('no'), { userMessage: 'У игрока столько нет' });
          return { removed: n, itemId: body.itemId };
        }
        if (action === 'removeInv') {
          // Read the inventory INSIDE the transaction, after the lock: the row
          // at index 3 a second ago may be a different row now.
          const cur = await items.inventoryOf(t, id);
          const row = (cur.inventory || [])[int(body.index, -1)];
          if (!row) throw Object.assign(new Error('gone'), { userMessage: 'Такой ячейки уже нет — обновите карточку' });
          await items.removeRow(t, row.rowId, id, byAdmin);
          return { removed: row.qty || 1, itemId: row.id };
        }
        if (action === 'removeEq') {
          const cur = await items.inventoryOf(t, id);
          const row = (cur.equipment || {})[String(body.slot || '')];
          if (!row) throw Object.assign(new Error('gone'), { userMessage: 'В этом слоте пусто' });
          await items.removeRow(t, row.rowId, id, byAdmin);
          return { removed: 1, itemId: row.id, slot: body.slot };
        }
        if (!await items.hasRoomFor(t, id, body.itemId)) {
          throw Object.assign(new Error('full'), { userMessage: 'Инвентарь игрока полон' });
        }
        // The one path where a human decides. Which admin goes in the
        // reference: "an admin gave it" and "which admin gave it" are
        // different answers, and only the second one is worth having.
        const rowId = await items.add(t, id, body.itemId,
          { qty: n, enhance: enh, source: 'admin', sourceRef: who(req) });
        if (rowId === null) throw Object.assign(new Error('full'), { userMessage: 'Инвентарь игрока полон' });
        return { rowId, added: n, itemId: body.itemId };
      });

      const isRemoval = action !== 'add';
      await adminAuth.audit(who(req), isRemoval ? 'item_remove' : 'item_give',
        { refType: 'player', refId: p.telegram_id, meta: { ...done, enhance: enh } });
      // In the player's own log too, so they can be told what happened to a
      // thing that disappeared without anyone having to remember doing it.
      plog.log(id, isRemoval ? 'admin:item_remove' : 'admin:item_give',
        { ...done, админ: who(req) });

      // Their client re-reads the inventory from the database rather than
      // being told what changed.
      const sock = [...io.sockets.sockets.values()]
        .find(s => s.data && s.data.telegramId === p.telegram_id);
      if (sock && sock.data.session) await sock.data.session.pushItems();

      // The panel redraws from THIS reply rather than reopening the card, so it
      // needs the inventory back. It was reading `d.inventory` off `{ok, rowId,
      // added}` and drawing an empty grid after every successful grant.
      const fresh = await items.inventoryOf(null, id);
      res.json({ ok: true, ...done, inventory: fresh.inventory, equipment: fresh.equipment,
        online: !!sock });
    } catch (e) {
      if (e.userMessage) return deny(res, req, 400, e.userMessage);
      fail(res, e, req);
    }
  });

  // ── money movements ──────────────────────────────────────────────────────
  app.get('/admin/transactions', guard, async (req, res) => {
    try {
      const limit = clampLimit(req.query.limit, 50);
      const { rows } = await query(null, `
        SELECT t.id, t.type, t.status, t.amount, t.memo, t.address, t.created_at,
               t.credited_at, t.paid_tx_hash, p.username, p.telegram_id
          FROM gram_tx t LEFT JOIN players p ON p.id = t.player_id
         ORDER BY t.id DESC LIMIT $1`, [limit]);
      // `txs` and `type`, which is what the page reads. It was looking for
      // `d.txs[].type` in a reply that said `rows[].kind`, so the GRAM tab was
      // empty however many deposits were pending — and its own comment says
      // somebody already chased this once and fixed the wrong half.
      res.json({
        txs: rows.map(r => ({
          id: Number(r.id), type: r.type, status: r.status, amount: Number(r.amount),
          memo: r.memo, address: r.address, username: r.username, telegramId: r.telegram_id,
          createdAt: r.created_at, creditedAt: r.credited_at, txHash: r.paid_tx_hash,
        })),
      });
    } catch (e) { fail(res, e, req); }
  });

  // Where the money does NOT add up. reconcile() compares the sum of every
  // ledger row against the stored balance — a non-empty answer means value
  // moved without going through money.js, and it is the single most important
  // number on this page.
  app.get('/admin/suspicious', guard, async (req, res) => {
    try {
      // reconcile() returns `drift`, not `delta` — the old line here mapped
      // `Number(d.delta)` over rows that have no such field and produced NaN
      // for every one of them.
      const drift = await money.reconcile(null);
      const { rows: dupes } = await query(null, `
        SELECT p.id, p.username, p.telegram_id, count(*)::int AS n
          FROM player_items i JOIN players p ON p.id = i.player_id
         WHERE i.container = 'inventory'
         GROUP BY p.id, p.username, p.telegram_id
        HAVING count(*) > 140
         ORDER BY n DESC LIMIT 20`);

      // The page renders `d.players` — a flat list of accounts to look at, each
      // with a reason. It was reading that off a reply of `{drift,
      // fullInventories}`, so the tab said "✓ Подозрительных аккаунтов нет"
      // even when the ledger did not balance, which is the single worst thing
      // this screen could get wrong.
      const ids = [...new Set([...drift.map(d => d.playerId), ...dupes.map(d => Number(d.id))])];
      const { rows: who_ } = ids.length ? await query(null, `
        SELECT p.id, p.telegram_id, p.username, p.bm, p.created_at,
               COALESCE(pr.lvl, 1) AS lvl
          FROM players p LEFT JOIN player_progress pr ON pr.player_id = p.id
         WHERE p.id = ANY($1)`, [ids]) : { rows: [] };
      const byId = new Map(who_.map(r => [Number(r.id), r]));

      const reasons = new Map();
      for (const d of drift) {
        const cur = reasons.get(d.playerId) || [];
        cur.push(`баланс ${d.currency} расходится на ${d.drift}`);
        reasons.set(d.playerId, cur);
      }
      for (const d of dupes) {
        const cur = reasons.get(Number(d.id)) || [];
        cur.push(`${d.n} предметов в инвентаре`);
        reasons.set(Number(d.id), cur);
      }

      // Drift is not a curiosity — it means value moved without going through
      // money.js. Nobody should have to open this tab to find out.
      if (drift.length) {
        ops.alert('reconcile.drift', 'Баланс не сходится с леджером',
          drift.slice(0, 5).map(d => `${d.playerId} ${d.currency}: ${d.drift}`).join('\n'),
          { счетов: drift.length }).catch(() => {});
      }

      res.json({
        players: ids.map(id => {
          const r = byId.get(id) || {};
          return {
            telegramId: r.telegram_id, username: r.username || `#${id}`,
            bm: r.bm || 0, lvl: r.lvl || 1, createdAt: r.created_at,
            reason: (reasons.get(id) || []).join(' · '),
          };
        }),
        drift,
        fullInventories: dupes,
      });
    } catch (e) { fail(res, e, req); }
  });

  // ── clans ────────────────────────────────────────────────────────────────
  app.get('/admin/clans', guard, async (req, res) => {
    try {
      const { rows } = await query(null, `
        SELECT c.id, c.name, c.icon, c.level, c.xp, c.created_at,
               count(m.player_id)::int AS members,
               (SELECT p.username FROM clan_members lm JOIN players p ON p.id = lm.player_id
                 WHERE lm.clan_id = c.id AND lm.role = 'leader' LIMIT 1) AS leader
          FROM clans c LEFT JOIN clan_members m ON m.clan_id = c.id
         GROUP BY c.id ORDER BY c.xp DESC LIMIT 100`);
      // memberCount as well as members: the page prints `c.memberCount`, and
      // `Участников: undefined` is how a working query looks when the two ends
      // disagree about one word.
      res.json({
        clans: rows.map(r => ({
          ...r, id: Number(r.id), xp: Number(r.xp),
          memberCount: r.members, createdAt: r.created_at,
        })),
      });
    } catch (e) { fail(res, e, req); }
  });

  app.delete('/admin/clan/:id', guard, csrf, async (req, res) => {
    try {
      const id = int(req.params.id);
      // The storage has to be empty, same rule a leader disbanding is held to
      // — otherwise the shards inside are destroyed with no record.
      const { rows: held } = await query(null,
        'SELECT COALESCE(sum(qty), 0)::int n FROM clan_storage WHERE clan_id = $1', [id]);
      if (held[0].n > 0) return deny(res, req, 400, `В хранилище ещё ${held[0].n} предметов`);
      const { rowCount } = await query(null, 'DELETE FROM clans WHERE id = $1', [id]);
      if (!rowCount) return deny(res, req, 404, 'Клан не найден');
      await adminAuth.audit(who(req), 'clan_delete', { meta: { by: who(req), clanId: id } });
      res.json({ ok: true });
    } catch (e) { fail(res, e, req); }
  });

  // ── chat ─────────────────────────────────────────────────────────────────
  app.get('/admin/chat', guard, async (req, res) => {
    try {
      const limit = clampLimit(req.query.limit, 100);
      const { rows } = await query(null, `
        SELECT id, username, text, created_at FROM chat_messages
         ORDER BY id DESC LIMIT $1`, [limit]);
      // createdAt beside created_at, because the page formats `m.ts`/`m.createdAt`
      // and a raw snake_case column is not something a template should have to
      // know about.
      res.json({
        messages: rows.reverse().map(r => ({
          id: Number(r.id), username: r.username, text: r.text,
          createdAt: r.created_at,
        })),
      });
    } catch (e) { fail(res, e, req); }
  });

  app.delete('/admin/chat/:id', guard, csrf, async (req, res) => {
    try {
      const { rowCount } = await query(null, 'DELETE FROM chat_messages WHERE id = $1', [int(req.params.id)]);
      await adminAuth.audit(who(req), 'chat_delete', { meta: { by: who(req), id: req.params.id } });
      res.json({ ok: !!rowCount });
    } catch (e) { fail(res, e, req); }
  });

  app.post('/admin/broadcast', guard, csrf, async (req, res) => {
    try {
      const text = String((req.body || {}).text || '').trim().slice(0, 200);
      if (!text) return deny(res, req, 400, 'Пустое сообщение');
      // `target` has always been sent by the page and never read here. Both
      // values reach the same people — a chat line only exists for someone
      // connected — so the honest thing is to say so in the reply rather than
      // pretend there are two behaviours.
      const sent = io.sockets.sockets.size;
      io.emit('chatMsg', { username: 'СИСТЕМА', text, time: new Date().toISOString() });
      await adminAuth.audit(who(req), 'broadcast', { meta: { by: who(req), text } });
      ops.alert('admin.broadcast', 'Рассылка в общий чат', text,
        { админ: who(req), получателей: sent }).catch(() => {});
      // The page prints `Отправлено ${d.sent} игрокам`, and this used to answer
      // `{ok:true}` — so a broadcast that reached forty people reported zero.
      res.json({ ok: true, sent });
    } catch (e) { fail(res, e, req); }
  });

  // ── the market ───────────────────────────────────────────────────────────
  app.get('/admin/market', guard, async (req, res) => {
    try {
      const limit = clampLimit(req.query.limit, 100);
      // `?tab=` has always been sent and never read, so "Активные" and
      // "История" were the same list — and the history rows were rendered with
      // the active template's fields, which is why a sold lot showed a "Снять"
      // button that could not work.
      const tab = String(req.query.tab || 'active');
      const statuses = tab === 'history' ? ['sold', 'cancelled'] : ['active'];

      // The item id comes from the LISTING's own snapshot where there is one
      // (migration 010), falling back to the player_items row. A sold lot's
      // item row belongs to the buyer now, and a cancelled one may be gone —
      // reading the name through it alone is why history showed blanks.
      const { rows } = await query(null, `
        SELECT l.id, l.price, l.status, l.created_at, l.closed_at,
               COALESCE(l.snap_item_id, pi.item_id) AS item_id,
               COALESCE(l.snap_enhance, pi.enhance)  AS enhance,
               c.name AS item_name, c.rarity,
               s.username AS seller, s.telegram_id AS seller_tid,
               b.username AS buyer,
               rp.username AS referrer
          FROM market_listings l
          LEFT JOIN player_items pi ON pi.id = l.item_id
          LEFT JOIN item_catalog c  ON c.item_id = COALESCE(l.snap_item_id, pi.item_id)
          LEFT JOIN players s  ON s.id = l.seller_id
          LEFT JOIN players b  ON b.id = l.buyer_id
          LEFT JOIN players rp ON rp.telegram_id = s.referred_by
         WHERE l.status = ANY($2)
         ORDER BY l.id DESC LIMIT $1`, [limit, statuses]);

      // Both spellings of every name. The page reads itemRarity /
      // sellerUsername / buyerUsername; `rarity` / `seller` / `buyer` are what
      // a caller reading this API fresh would expect. Sending both costs a
      // handful of bytes and removes a whole class of "undefined" from the
      // screen — which is the class of bug this page was full of.
      res.json({
        listings: rows.map(r => ({
          id: Number(r.id), itemId: r.item_id, itemName: r.item_name || r.item_id || '—',
          rarity: r.rarity, itemRarity: r.rarity, enhance: r.enhance,
          price: Number(r.price), status: r.status,
          seller: r.seller, sellerUsername: r.seller, sellerTid: r.seller_tid,
          buyer: r.buyer, buyerUsername: r.buyer,
          referrerUsername: r.referrer,
          createdAt: r.created_at, soldAt: r.closed_at,
        })),
      });
    } catch (e) { fail(res, e, req); }
  });

  // Cancelling returns the item to the seller. It goes through the same
  // repository a player's own cancel uses, so an admin cancel cannot leave an
  // item belonging to neither the listing nor anyone.
  app.post('/admin/market/:id/cancel', guard, csrf, async (req, res) => {
    try {
      const id = int(req.params.id);
      const { rows } = await query(null,
        `SELECT seller_id FROM market_listings WHERE id = $1 AND status = 'active'`, [id]);
      if (!rows.length) return deny(res, req, 404, 'Лот не найден или уже закрыт');
      const seller = Number(rows[0].seller_id);
      const out = await tx(t => market.cancel(t, seller, id));
      await adminAuth.audit(who(req), 'market_cancel', { meta: { by: who(req), listingId: id } });
      plog.log(seller, 'admin:market_cancel', { listingId: id, админ: who(req) });
      // `delivered` says whether the item actually made it back into the
      // seller's bag or is waiting because their inventory is full — the page
      // prints two different sentences for the two cases and had neither.
      res.json({ ok: true, delivered: out === undefined ? true : !!out });
    } catch (e) {
      if (e.userMessage) return deny(res, req, 400, e.userMessage);
      fail(res, e, req);
    }
  });

  app.post('/admin/market/cancel-all', guard, csrf, async (req, res) => {
    try {
      const { rows } = await query(null,
        `SELECT id, seller_id FROM market_listings WHERE status = 'active'`);
      let delivered = 0;
      const errors = [];
      for (const r of rows) {
        // One transaction each: a single failure must not undo the rest.
        try {
          await tx(t => market.cancel(t, Number(r.seller_id), Number(r.id)));
          delivered++;
        } catch (err) {
          // Named, not just counted. "Снято 40 из 47" with no word about the
          // other seven is the shape of a report nobody can act on.
          errors.push({ id: Number(r.id), error: err.userMessage || err.message });
          console.error('[admin] cancel', r.id, err.message);
        }
      }
      await adminAuth.audit(who(req), 'market_cancel_all',
        { meta: { by: who(req), listings: delivered, of: rows.length, failed: errors.length } });
      if (errors.length) {
        ops.alert('admin.cancelall.partial', 'Снятие всех лотов прошло частично',
          errors.slice(0, 5).map(e => `#${e.id}: ${e.error}`).join('\n'),
          { всего: rows.length, снято: delivered, ошибок: errors.length }).catch(() => {});
      }
      res.json({
        ok: true, total: rows.length, delivered,
        cancelled: delivered, failed: errors.length, errors: errors.slice(0, 20),
      });
    } catch (e) { fail(res, e, req); }
  });

  // ── special quests ───────────────────────────────────────────────────────
  app.get('/admin/special-quests', guard, async (req, res) => {
    try {
      const { rows } = await query(null,
        `SELECT id, title, description, type, url, icon, reward_gold, reward_xp, reward_nexum,
                active, created_at FROM special_quests ORDER BY id DESC`);
      // `reward` as an object AND the flat columns. The page prints
      // `q.reward?.gold` — optional chaining, so a missing `reward` renders 0
      // rather than throwing, which is why every quest showed all-zero rewards
      // and looked configured wrong rather than read wrong.
      res.json({
        quests: rows.map(r => ({
          ...r, id: Number(r.id),
          desc: r.description,
          createdAt: r.created_at,
          reward: {
            gold: Number(r.reward_gold) || 0,
            xp: Number(r.reward_xp) || 0,
            nexum: Number(r.reward_nexum) || 0,
          },
        })),
      });
    } catch (e) { fail(res, e, req); }
  });

  app.post('/admin/special-quests', guard, csrf, async (req, res) => {
    try {
      const b = req.body || {};
      const t = String(b.title || '').trim().slice(0, 120);
      if (!t) return deny(res, req, 400, 'Нужен заголовок');
      // The form sends `desc` and a nested `reward` object; this read
      // `description` and `rewardGold`, so every quest created through the
      // panel was saved with no text and zero reward — and reported success.
      // Both spellings are accepted rather than one side being declared right.
      const reward = b.reward || {};
      const { rows } = await query(null, `
        INSERT INTO special_quests (title, description, type, url, icon,
                                    reward_gold, reward_xp, reward_nexum, active)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true) RETURNING id`,
        [t, String(b.description ?? b.desc ?? '').slice(0, 1000),
         String(b.type || 'link'), String(b.url || ''),
         String(b.icon || '*'),
         Math.max(0, int(b.rewardGold ?? reward.gold)),
         Math.max(0, int(b.rewardXp ?? reward.xp)),
         Math.max(0, num(b.rewardNexum ?? reward.nexum))]);
      await adminAuth.audit(who(req), 'quest_create', { meta: { by: who(req), id: Number(rows[0].id), title: t } });
      res.json({ ok: true, id: Number(rows[0].id) });
    } catch (e) { fail(res, e, req); }
  });

  // The panel's on/off switch. It has always called PUT here and there has
  // never been a PUT route — express answered 404, the panel ignored the reply
  // (`await api(...)` with nothing read from it) and redrew the list from the
  // database, so the toggle snapped back and looked like it had simply not been
  // pressed. Nothing was logged anywhere, by anyone.
  app.put('/admin/special-quests/:id', guard, csrf, async (req, res) => {
    try {
      const active = !!(req.body || {}).active;
      const { rowCount } = await query(null,
        'UPDATE special_quests SET active = $2 WHERE id = $1', [int(req.params.id), active]);
      if (!rowCount) return deny(res, req, 404, 'Задание не найдено');
      await adminAuth.audit(who(req), active ? 'quest_enable' : 'quest_disable',
        { meta: { by: who(req), id: req.params.id } });
      res.json({ ok: true, active });
    } catch (e) { fail(res, e, req); }
  });

  app.delete('/admin/special-quests/:id', guard, csrf, async (req, res) => {
    try {
      const { rowCount } = await query(null,
        'UPDATE special_quests SET active = false WHERE id = $1', [int(req.params.id)]);
      await adminAuth.audit(who(req), 'quest_retire', { meta: { by: who(req), id: req.params.id } });
      res.json({ ok: !!rowCount });
    } catch (e) { fail(res, e, req); }
  });

  // Read by the CLIENT, not the panel — the only unauthenticated route here.
  app.get('/api/special-quests', async (req, res) => {
    try {
      const { rows } = await query(null,
        `SELECT id, title, description, type, url, icon, reward_gold, reward_xp, reward_nexum
           FROM special_quests WHERE active ORDER BY id`);
      // `reward` as an object AND the flat columns. The page prints
      // `q.reward?.gold` — optional chaining, so a missing `reward` renders 0
      // rather than throwing, which is why every quest showed all-zero rewards
      // and looked configured wrong rather than read wrong.
      res.json({
        quests: rows.map(r => ({
          ...r, id: Number(r.id),
          desc: r.description,
          createdAt: r.created_at,
          reward: {
            gold: Number(r.reward_gold) || 0,
            xp: Number(r.reward_xp) || 0,
            nexum: Number(r.reward_nexum) || 0,
          },
        })),
      });
    } catch (e) { fail(res, e, req); }
  });

  // ── event controls ───────────────────────────────────────────────────────
  // Thin wrappers over the mode runtime. They exist so an operator can open a
  // window early, or close one that has gone wrong, without a deploy.
  //
  // EVERY ONE OF THESE USED TO ANSWER `ok` WHETHER OR NOT IT DID ANYTHING. The
  // shape was `() => modes._x && modes._x()`, so a runtime function that did
  // not exist under that name evaluated to undefined, the route replied
  // `{ok:true}`, and the panel said "Регистрация открыта". Nothing had opened.
  // That is precisely the report — "нажимаю, не вызывает" — and it is why the
  // name is now looked up by string and its absence is an error with the name
  // in it, rather than a silent false.
  const need = (fnName) => {
    const fn = modes && modes[fnName];
    if (typeof fn !== 'function') {
      throw Object.assign(new Error(`modes.${fnName} отсутствует`),
        { userMessage: `Режим не подключён (modes.${fnName}) — сборка неполная` });
    }
    return fn;
  };

  const modeCtl = (path, fn, name) => app.post(path, guard, csrf, async (req, res) => {
    try {
      const out = await fn(req);
      await adminAuth.audit(who(req), name, { meta: { by: who(req) } });
      // The operator sees a toast; the group sees a line. Two people pressing
      // the same button a minute apart, or an event that started because
      // somebody pressed something rather than because the schedule came round,
      // is otherwise unexplainable after the fact.
      ops.alert(`admin.event.${name}`, `Событие запущено вручную: ${name}`,
        null, { админ: who(req) }).catch(() => {});
      res.json({ ok: true, ...(out || {}) });
    } catch (e) {
      if (e.userMessage) return deny(res, req, 400, e.userMessage);
      fail(res, e, req);
    }
  });

  // The Кровавая Башня. `openAt` is what the announcement is keyed on — called
  // with nothing, two manual opens in one process produced the same key
  // (`race10:now:undefined`) and announceOnce swallowed the second, so the
  // second window opened with nobody told about it.
  modeCtl('/admin/race10/open', async (req) => {
    // The panel's confirmation promises "+1 попытка всем, включая тех, кто уже
    // использовал" and nothing implemented it: an out-of-schedule window opened
    // for everyone except the people most likely to want it. Clearing today's
    // usage is that promise, kept.
    //
    // Opt-OUT rather than opt-in, because the panel is the only caller that
    // matters and its text has always said the attempts come back. The flag
    // exists so dev/panel-check.js can prove the window opens without writing
    // to a table full of real players' daily state.
    let attemptsRestored = 0;
    if ((req.body || {}).restoreAttempts !== false) {
      ({ rowCount: attemptsRestored } = await query(null,
        `DELETE FROM player_daily WHERE day = CURRENT_DATE AND mode = 'race10'`));
    }
    need('_race10OpenWindow')(Date.now());
    return { attemptsRestored };
  }, 'race10_open');
  modeCtl('/admin/race10/close', () => need('_race10CloseWindow')(), 'race10_close');
  app.get('/admin/race10', guard, (req, res) =>
    res.json(modes._race10PublicState ? modes._race10PublicState() : {}));

  // ── the world boss ───────────────────────────────────────────────────────
  // This route was wired to _dbPublicState / _dbOpenReg — the DEATH BATTLE.
  // Two different events under one old name, so the panel's "Мировой босс"
  // card reported the death battle's registration state and its button opened
  // that registration. The card even reads `dropsOnGround`, which only the
  // world boss has.
  app.get('/admin/event-boss', guard, (req, res) => {
    const st = modes.eventBossState ? modes.eventBossState() : {};
    res.json({
      alive: !!st.alive,
      spawnAt: st.spawnAt || 0,
      nextAt: st.nextAt || 0,
      dropsOnGround: (st.drops || []).length,
    });
  });
  modeCtl('/admin/event-boss', () => {
    const r = need('scheduleEventBoss')();
    if (r && r.error) throw Object.assign(new Error(r.error), { userMessage: r.error });
    return r;
  }, 'world_boss_summon');

  // ── the death battle ─────────────────────────────────────────────────────
  // Its own route now, under its own name.
  //
  // _dbOpenReg takes the ABSOLUTE moment the round starts, and this called it
  // with no argument at all. `_db.startAt` became undefined; the start timer
  // was armed for `Math.max(0, undefined - Date.now())`, which is NaN, which
  // setTimeout treats as zero — so pressing the button opened registration and
  // started the battle in the same tick, with nobody in it. The panel showed a
  // countdown from `(undefined || 0)`, i.e. nothing.
  // From shared/definitions, the same value the scheduled window uses — not a
  // number typed here that would drift the day the other one changes.
  const { DEATH_BATTLE_REG_MS: DB_REG_MS } = require('../../shared/definitions');
  app.get('/admin/death-battle', guard, (req, res) =>
    res.json(modes._dbPublicState ? modes._dbPublicState() : {}));
  modeCtl('/admin/death-battle', () => {
    if (modes._db && modes._db.phase !== 'idle') {
      throw Object.assign(new Error('busy'), {
        userMessage: modes._db.phase === 'reg' ? 'Регистрация уже открыта' : 'Битва уже идёт',
      });
    }
    const startAt = Date.now() + DB_REG_MS;
    need('_dbOpenReg')(startAt);
    return { startAt, regMs: DB_REG_MS };
  }, 'death_battle_open');

  app.get('/admin/guildwar', guard, (req, res) => res.json(deps.guildWarState ? deps.guildWarState() : {}));
  modeCtl('/admin/guildwar/open',  () => need('_gwOpenWindow')(Date.now()), 'guildwar_open');
  modeCtl('/admin/guildwar/close', () => need('_gwCloseWindow')(), 'guildwar_close');

  // ── the arena, 3v3 ───────────────────────────────────────────────────────
  // The one scheduled event with no way to start it by hand: "остальные
  // события я запустить не могу". Its window opens on a schedule like the
  // others and there was simply no endpoint.
  app.get('/admin/arena3', guard, (req, res) =>
    res.json(modes._a3PublicState ? modes._a3PublicState() : {}));
  modeCtl('/admin/arena3/open',  () => need('_a3OpenWindow')(Date.now()), 'arena3_open');
  modeCtl('/admin/arena3/close', () => need('_a3CloseWindow')(), 'arena3_close');

  // ── Страх, one player at a time ──────────────────────────────────────────
  // Not an event with a window: a player walks in when they choose and spends
  // a daily attempt. What an operator actually needs is to GIVE the attempt
  // back, which is the reset that already exists per player — this does it for
  // everybody at once, which is what "запустить Страх" means in practice.
  modeCtl('/admin/fear/reset-all', async () => {
    const { rowCount } = await query(null,
      `DELETE FROM player_daily WHERE day = CURRENT_DATE AND mode = 'fear'`);
    return { attemptsRestored: rowCount };
  }, 'fear_reset_all');
  modeCtl('/admin/coop/reset-all', async () => {
    const { rowCount } = await query(null,
      `DELETE FROM player_daily WHERE day = CURRENT_DATE AND mode = 'coop'`);
    return { attemptsRestored: rowCount };
  }, 'coop_reset_all');

  // The world boss's loot, swept off the floor. A summon that went wrong
  // leaves sixty piles lying in the arena for their full lifetime.
  modeCtl('/admin/event-boss/clear-drops', () => {
    const world = require('../world');
    const arena = world.roomOf(world.FLOOR_IDS.arena);
    if (!arena) throw Object.assign(new Error('no arena'), { userMessage: 'Арена недоступна' });
    // claimWorldDrop is the same call a pickup makes, so each pile leaves the
    // floor the way it normally would — the clients watching get their
    // 'worldDropTaken' and the piles disappear from every screen.
    const drops = arena.worldDropSnapshot();
    for (const d of drops) arena.claimWorldDrop(d.id, d.x, d.y);
    return { cleared: drops.length };
  }, 'boss_clear_drops');

  // ── maintenance ──────────────────────────────────────────────────────────
  app.get('/admin/maintenance', guard, (req, res) => res.json({ on: maintenance.isOn() }));
  app.post('/admin/maintenance/on', guard, csrf, async (req, res) => {
    maintenance.set(true);
    await adminAuth.audit(who(req), 'maintenance_on', { meta: { by: who(req) } });
    res.json({ ok: true, on: true });
  });
  app.post('/admin/maintenance/off', guard, csrf, async (req, res) => {
    maintenance.set(false);
    await adminAuth.audit(who(req), 'maintenance_off', { meta: { by: who(req) } });
    res.json({ ok: true, on: false });
  });
};
