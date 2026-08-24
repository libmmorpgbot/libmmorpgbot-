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
const { query, tx } = require('../db');
const money = require('../db/repos/money');
const items = require('../db/repos/items');
const players = require('../db/repos/players');
const progression = require('../db/repos/progression');
const market = require('../db/repos/market');
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

  const fail = (res, e) => {
    console.error('[admin]', e);
    res.status(500).json({ error: e.message || 'server error' });
  };
  const who = req => (req.admin && req.admin.sub) || 'admin';

  // ── login ────────────────────────────────────────────────────────────────
  app.post('/admin/login', async (req, res) => {
    try {
      const { username, password } = req.body || {};
      const ip = req.ip;
      const locked = adminAuth.lockedFor(ip);
      if (locked > 0) {
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
        // Deliberately vague, and deliberately the same message for a wrong
        // name as for a wrong password: the difference is an oracle.
        return res.status(401).json({ error: 'Неверные данные' });
      }
      adminAuth.clearFails(ip);
      const token = await adminAuth.issue(username);
      adminAuth.setCookie(res, token);
      await adminAuth.audit(username, 'login', { meta: { ip } });
      res.json({ ok: true, csrf: token.slice(0, 16) });
    } catch (e) { fail(res, e); }
  });

  app.post('/admin/logout', guard, csrf, async (req, res) => {
    adminAuth.clearCookie(res);
    await adminAuth.audit(who(req), 'logout', { meta: { username: who(req) } });
    res.json({ ok: true });
  });

  // ── overview ─────────────────────────────────────────────────────────────
  app.get('/admin/stats', guard, async (_req, res) => {
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
    } catch (e) { fail(res, e); }
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
    } catch (e) { fail(res, e); }
  });

  app.get('/admin/top-referrals', guard, async (_req, res) => {
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
      res.json({
        rows: rows.map(r => ({
          username: r.username, telegramId: r.telegram_id,
          friends: r.friends, gram: Number(r.gram),
        })),
      });
    } catch (e) { fail(res, e); }
  });

  app.get('/admin/top-market', guard, async (_req, res) => {
    try {
      const { rows } = await query(null, `
        SELECT p.username, p.telegram_id,
               count(*)::int AS sales,
               COALESCE(sum(l.price), 0)::numeric AS volume
          FROM market_listings l JOIN players p ON p.id = l.seller_id
         WHERE l.status = 'sold'
         GROUP BY p.id, p.username, p.telegram_id
         ORDER BY volume DESC LIMIT 50`);
      res.json({
        rows: rows.map(r => ({
          username: r.username, telegramId: r.telegram_id,
          sales: r.sales, volume: Number(r.volume),
        })),
      });
    } catch (e) { fail(res, e); }
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
      if (!p) return res.status(404).json({ error: 'Not found' });
      const id = Number(p.id);

      const prog = await players.progressOf(null, id);
      const skills = await players.skillsOf(null, id);
      const inv = await items.inventoryOf(null, id);
      const bal = await money.balancesOf(null, id);
      const vip = await progression.vipOf(null, id);
      const season = await progression.seasonOf(null, id);
      const { rows: daily } = await query(null,
        'SELECT mode, used, seconds FROM player_daily WHERE player_id = $1 AND day = CURRENT_DATE', [id]);

      res.json({
        telegramId: p.telegram_id, username: p.username, bm: p.bm,
        banned: p.banned, referredBy: p.referred_by, createdAt: p.created_at,
        online: onlineTids().has(p.telegram_id),
        progress: prog, skills, items: inv, balances: bal, vip, season,
        daily: Object.fromEntries(daily.map(d => [d.mode, { used: d.used, seconds: d.seconds }])),
      });
    } catch (e) { fail(res, e); }
  });

  const banHandler = (banned) => async (req, res) => {
    try {
      const { rows } = await query(null,
        'UPDATE players SET banned = $2 WHERE telegram_id = $1 RETURNING id, username',
        [String(req.params.tid), banned]);
      if (!rows.length) return res.status(404).json({ error: 'Not found' });
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
    } catch (e) { fail(res, e); }
  };
  app.post('/admin/player/:tid/ban', guard, csrf, banHandler(true));
  app.post('/admin/player/:tid/unban', guard, csrf, banHandler(false));

  const resetAttempts = (mode) => async (req, res) => {
    try {
      const p = await byTid(req.params.tid);
      if (!p) return res.status(404).json({ error: 'Not found' });
      await query(null,
        'DELETE FROM player_daily WHERE player_id = $1 AND day = CURRENT_DATE AND mode = $2',
        [p.id, mode]);
      await adminAuth.audit(who(req), 'reset_attempts', { meta: { by: who(req), telegramId: p.telegram_id, mode } });
      res.json({ ok: true, mode });
    } catch (e) { fail(res, e); }
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
      if (!gold && !nexum && !gram && !sp) return res.status(400).json({ error: 'Нечего выдавать' });

      const p = await byTid(req.params.tid);
      if (!p) return res.status(404).json({ error: 'Not found' });
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
      if (e.userMessage) return res.status(400).json({ error: e.userMessage });
      fail(res, e);
    }
  });

  // Everyone at once. Bounded and batched: the old version built an array of
  // every player id in the game and issued one update per id.
  app.post('/admin/give-all', guard, csrf, async (req, res) => {
    try {
      const gold = int((req.body || {}).gold);
      const sp = int((req.body || {}).sp);
      if (!gold && !sp) return res.status(400).json({ error: 'Нечего выдавать' });
      if (gold < 0 || sp < 0) return res.status(400).json({ error: 'Только положительные суммы' });

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
      res.json({ ok: true, players: n });
    } catch (e) { fail(res, e); }
  });

  app.post('/admin/player/:tid/season-points', guard, csrf, async (req, res) => {
    try {
      const pts = int((req.body || {}).points);
      const p = await byTid(req.params.tid);
      if (!p) return res.status(404).json({ error: 'Not found' });
      const { rows } = await query(null, `
        INSERT INTO player_season (player_id, season, points)
        VALUES ($1, $2, GREATEST(0, $3))
        ON CONFLICT (player_id, season) DO UPDATE
          SET points = GREATEST(0, player_season.points + $3)
        RETURNING points`, [p.id, progression.CURRENT_SEASON, pts]);
      await adminAuth.audit(who(req), 'season_points', { meta: { by: who(req), telegramId: p.telegram_id, points: pts } });
      res.json({ ok: true, total: Number(rows[0].points) });
    } catch (e) { fail(res, e); }
  });

  // ── items ────────────────────────────────────────────────────────────────
  app.get('/admin/items', guard, (_req, res) => {
    res.json({
      items: CATALOG.map(d => ({
        id: d.id, name: d.name, slot: d.slot || 'material', rarity: d.rarity || null,
      })),
    });
  });

  app.post('/admin/player/:tid/items', guard, csrf, async (req, res) => {
    try {
      const { itemId, qty, enhance, remove } = req.body || {};
      const p = await byTid(req.params.tid);
      if (!p) return res.status(404).json({ error: 'Not found' });
      if (typeof itemId !== 'string' || !CATALOG.some(d => d.id === itemId)) {
        return res.status(400).json({ error: 'Неизвестный предмет' });
      }
      const n = Math.max(1, int(qty, 1));
      const enh = Math.max(0, Math.min(15, int(enhance, 0)));

      const out = await tx(async (t) => {
        await items.lockPlayer(t, Number(p.id));
        if (remove) {
          const gone = await items.removeQty(t, Number(p.id), itemId, n);
          if (!gone) throw Object.assign(new Error('no'), { userMessage: 'У игрока столько нет' });
          return { removed: n };
        }
        if (!await items.hasRoomFor(t, Number(p.id), itemId)) {
          throw Object.assign(new Error('full'), { userMessage: 'Инвентарь игрока полон' });
        }
        const rowId = await items.add(t, Number(p.id), itemId, { qty: n, enhance: enh });
        if (rowId === null) throw Object.assign(new Error('full'), { userMessage: 'Инвентарь игрока полон' });
        return { rowId, added: n };
      });

      await adminAuth.audit(who(req), remove ? 'item_remove' : 'item_give',
        { refType: 'player', refId: p.telegram_id, meta: { itemId, qty: n, enhance: enh } });

      // Their client re-reads the inventory from the database rather than
      // being told what changed.
      const sock = [...io.sockets.sockets.values()]
        .find(s => s.data && s.data.telegramId === p.telegram_id);
      if (sock && sock.data.session) await sock.data.session.pushItems();
      res.json({ ok: true, ...out });
    } catch (e) {
      if (e.userMessage) return res.status(400).json({ error: e.userMessage });
      fail(res, e);
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
      res.json({
        rows: rows.map(r => ({
          id: Number(r.id), kind: r.type, status: r.status, amount: Number(r.amount),
          memo: r.memo, address: r.address, username: r.username, telegramId: r.telegram_id,
          createdAt: r.created_at, creditedAt: r.credited_at, txHash: r.paid_tx_hash,
        })),
      });
    } catch (e) { fail(res, e); }
  });

  // Where the money does NOT add up. reconcile() compares the sum of every
  // ledger row against the stored balance — a non-empty answer means value
  // moved without going through money.js, and it is the single most important
  // number on this page.
  app.get('/admin/suspicious', guard, async (_req, res) => {
    try {
      const drift = await money.reconcile(null);
      const { rows: dupes } = await query(null, `
        SELECT p.username, p.telegram_id, count(*)::int AS n
          FROM player_items i JOIN players p ON p.id = i.player_id
         WHERE i.container = 'inventory'
         GROUP BY p.id, p.username, p.telegram_id
        HAVING count(*) > 140
         ORDER BY n DESC LIMIT 20`);
      res.json({
        drift: drift.map(d => ({ ...d, delta: Number(d.delta) })),
        fullInventories: dupes,
      });
    } catch (e) { fail(res, e); }
  });

  // ── clans ────────────────────────────────────────────────────────────────
  app.get('/admin/clans', guard, async (_req, res) => {
    try {
      const { rows } = await query(null, `
        SELECT c.id, c.name, c.icon, c.level, c.xp, c.created_at,
               count(m.player_id)::int AS members,
               (SELECT p.username FROM clan_members lm JOIN players p ON p.id = lm.player_id
                 WHERE lm.clan_id = c.id AND lm.role = 'leader' LIMIT 1) AS leader
          FROM clans c LEFT JOIN clan_members m ON m.clan_id = c.id
         GROUP BY c.id ORDER BY c.xp DESC LIMIT 100`);
      res.json({ clans: rows.map(r => ({ ...r, id: Number(r.id), xp: Number(r.xp) })) });
    } catch (e) { fail(res, e); }
  });

  app.delete('/admin/clan/:id', guard, csrf, async (req, res) => {
    try {
      const id = int(req.params.id);
      // The storage has to be empty, same rule a leader disbanding is held to
      // — otherwise the shards inside are destroyed with no record.
      const { rows: held } = await query(null,
        'SELECT COALESCE(sum(qty), 0)::int n FROM clan_storage WHERE clan_id = $1', [id]);
      if (held[0].n > 0) return res.status(400).json({ error: `В сховищі ще ${held[0].n} предметів` });
      const { rowCount } = await query(null, 'DELETE FROM clans WHERE id = $1', [id]);
      if (!rowCount) return res.status(404).json({ error: 'Not found' });
      await adminAuth.audit(who(req), 'clan_delete', { meta: { by: who(req), clanId: id } });
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });

  // ── chat ─────────────────────────────────────────────────────────────────
  app.get('/admin/chat', guard, async (req, res) => {
    try {
      const limit = clampLimit(req.query.limit, 100);
      const { rows } = await query(null, `
        SELECT id, username, text, created_at FROM chat_messages
         ORDER BY id DESC LIMIT $1`, [limit]);
      res.json({ messages: rows.reverse().map(r => ({ id: Number(r.id), ...r })) });
    } catch (e) { fail(res, e); }
  });

  app.delete('/admin/chat/:id', guard, csrf, async (req, res) => {
    try {
      const { rowCount } = await query(null, 'DELETE FROM chat_messages WHERE id = $1', [int(req.params.id)]);
      await adminAuth.audit(who(req), 'chat_delete', { meta: { by: who(req), id: req.params.id } });
      res.json({ ok: !!rowCount });
    } catch (e) { fail(res, e); }
  });

  app.post('/admin/broadcast', guard, csrf, async (req, res) => {
    try {
      const text = String((req.body || {}).text || '').trim().slice(0, 200);
      if (!text) return res.status(400).json({ error: 'Пустое сообщение' });
      io.emit('chatMsg', { username: 'СИСТЕМА', text, time: new Date().toISOString() });
      await adminAuth.audit(who(req), 'broadcast', { meta: { by: who(req), text } });
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });

  // ── the market ───────────────────────────────────────────────────────────
  app.get('/admin/market', guard, async (req, res) => {
    try {
      const limit = clampLimit(req.query.limit, 100);
      // One join, not a lookup per listing.
      const { rows } = await query(null, `
        SELECT l.id, l.price, l.status, l.created_at, l.closed_at,
               pi.item_id, pi.enhance, c.name AS item_name, c.rarity,
               s.username AS seller, s.telegram_id AS seller_tid,
               b.username AS buyer
          FROM market_listings l
          LEFT JOIN player_items pi ON pi.id = l.item_id
          LEFT JOIN item_catalog c  ON c.item_id = pi.item_id
          LEFT JOIN players s ON s.id = l.seller_id
          LEFT JOIN players b ON b.id = l.buyer_id
         ORDER BY l.id DESC LIMIT $1`, [limit]);
      res.json({
        listings: rows.map(r => ({
          id: Number(r.id), itemId: r.item_id, itemName: r.item_name,
          rarity: r.rarity, enhance: r.enhance,
          price: Number(r.price), status: r.status,
          seller: r.seller, sellerTid: r.seller_tid, buyer: r.buyer,
          createdAt: r.created_at, soldAt: r.closed_at,
        })),
      });
    } catch (e) { fail(res, e); }
  });

  // Cancelling returns the item to the seller. It goes through the same
  // repository a player's own cancel uses, so an admin cancel cannot leave an
  // item belonging to neither the listing nor anyone.
  app.post('/admin/market/:id/cancel', guard, csrf, async (req, res) => {
    try {
      const id = int(req.params.id);
      const { rows } = await query(null,
        `SELECT seller_id FROM market_listings WHERE id = $1 AND status = 'active'`, [id]);
      if (!rows.length) return res.status(404).json({ error: 'Лот не найден или уже закрыт' });
      await tx(t => market.cancel(t, Number(rows[0].seller_id), id));
      await adminAuth.audit(who(req), 'market_cancel', { meta: { by: who(req), listingId: id } });
      res.json({ ok: true });
    } catch (e) {
      if (e.userMessage) return res.status(400).json({ error: e.userMessage });
      fail(res, e);
    }
  });

  app.post('/admin/market/cancel-all', guard, csrf, async (req, res) => {
    try {
      const { rows } = await query(null,
        `SELECT id, seller_id FROM market_listings WHERE status = 'active'`);
      let done = 0;
      for (const r of rows) {
        // One transaction each: a single failure must not undo the rest.
        try { await tx(t => market.cancel(t, Number(r.seller_id), Number(r.id))); done++; }
        catch (err) { console.error('[admin] cancel', r.id, err.message); }
      }
      await adminAuth.audit(who(req), 'market_cancel_all', { meta: { by: who(req), listings: done, of: rows.length } });
      res.json({ ok: true, cancelled: done, total: rows.length });
    } catch (e) { fail(res, e); }
  });

  // ── special quests ───────────────────────────────────────────────────────
  app.get('/admin/special-quests', guard, async (_req, res) => {
    try {
      const { rows } = await query(null,
        `SELECT id, title, description, type, url, icon, reward_gold, reward_xp, reward_nexum,
                active, created_at FROM special_quests ORDER BY id DESC`);
      res.json({ quests: rows.map(r => ({ ...r, id: Number(r.id) })) });
    } catch (e) { fail(res, e); }
  });

  app.post('/admin/special-quests', guard, csrf, async (req, res) => {
    try {
      const { title, description, rewardXp } = req.body || {};
      const t = String(title || '').trim().slice(0, 120);
      if (!t) return res.status(400).json({ error: 'Нужен заголовок' });
      const { rows } = await query(null, `
        INSERT INTO special_quests (title, description, type, url, icon,
                                    reward_gold, reward_xp, reward_nexum, active)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true) RETURNING id`,
        [t, String(description || '').slice(0, 1000),
         String((req.body || {}).type || 'link'), String((req.body || {}).url || ''),
         String((req.body || {}).icon || '*'),
         Math.max(0, int((req.body || {}).rewardGold)), Math.max(0, int(rewardXp)),
         Math.max(0, num((req.body || {}).rewardNexum))]);
      await adminAuth.audit(who(req), 'quest_create', { meta: { by: who(req), id: Number(rows[0].id), title: t } });
      res.json({ ok: true, id: Number(rows[0].id) });
    } catch (e) { fail(res, e); }
  });

  app.delete('/admin/special-quests/:id', guard, csrf, async (req, res) => {
    try {
      const { rowCount } = await query(null,
        'UPDATE special_quests SET active = false WHERE id = $1', [int(req.params.id)]);
      await adminAuth.audit(who(req), 'quest_retire', { meta: { by: who(req), id: req.params.id } });
      res.json({ ok: !!rowCount });
    } catch (e) { fail(res, e); }
  });

  // Read by the CLIENT, not the panel — the only unauthenticated route here.
  app.get('/api/special-quests', async (_req, res) => {
    try {
      const { rows } = await query(null,
        `SELECT id, title, description, type, url, icon, reward_gold, reward_xp, reward_nexum
           FROM special_quests WHERE active ORDER BY id`);
      res.json({ quests: rows.map(r => ({ ...r, id: Number(r.id) })) });
    } catch (e) { fail(res, e); }
  });

  // ── event controls ───────────────────────────────────────────────────────
  // Thin wrappers over the mode runtime. They exist so an operator can open a
  // window early, or close one that has gone wrong, without a deploy.
  const modeCtl = (path, fn, name) => app.post(path, guard, csrf, async (req, res) => {
    try {
      const out = fn(req);
      await adminAuth.audit(who(req), name, {});
      res.json({ ok: true, ...(out || {}) });
    } catch (e) { fail(res, e); }
  });

  modeCtl('/admin/race10/open',   () => modes._race10OpenWindow && modes._race10OpenWindow(), 'race10_open');
  modeCtl('/admin/race10/close',  () => modes._race10CloseWindow && modes._race10CloseWindow(), 'race10_close');
  app.get('/admin/race10', guard, (_req, res) =>
    res.json(modes._race10PublicState ? modes._race10PublicState() : {}));

  app.get('/admin/event-boss', guard, (_req, res) =>
    res.json(modes._dbPublicState ? modes._dbPublicState() : {}));
  modeCtl('/admin/event-boss', () => modes._dbOpenReg && modes._dbOpenReg(), 'event_boss_open');

  app.get('/admin/guildwar', guard, (_req, res) => res.json(deps.guildWarState ? deps.guildWarState() : {}));
  modeCtl('/admin/guildwar/open',  () => deps.guildWarOpen && deps.guildWarOpen(), 'guildwar_open');
  modeCtl('/admin/guildwar/close', () => deps.guildWarClose && deps.guildWarClose(), 'guildwar_close');

  // ── maintenance ──────────────────────────────────────────────────────────
  app.get('/admin/maintenance', guard, (_req, res) => res.json({ on: maintenance.isOn() }));
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
