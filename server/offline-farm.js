'use strict';
// ── Оффлайн-фарм ────────────────────────────────────────────────────────────
// Игрок выбирает локацию и выходит; при следующем входе получает то, что
// нафармил бы там за это время. Модель темпа — offlineFarmRate в
// shared/definitions.js, там же разобрано, из чего он складывается.
//
// Здесь две половины:
//
//   start   запомнить локацию, время и снимок характеристик. Снимок — чтобы
//           темп считался по тому, с чем игрок ушёл, а не по тому, что у него
//           окажется к следующему входу. Без временных зелий: банка атаки на
//           десять минут не должна множить двенадцать часов.
//
//   claim   на входе, в одной транзакции: забрать запись (атомарно — второй
//           вход с другого устройства найдёт пусто), посчитать число убийств и
//           прогнать КАЖДОЕ через те же таблицы, что и онлайн-убийство
//           (onKill/rollLoot, server/handlers2/world.js): тот же опыт, то же
//           золото с шансом 30%, те же Liberty и GRAM, тот же дроп со вторым
//           броском за VIP/билет/вещи, та же руда. Разница одна — всё
//           начисляется одной суммой, а не двадцатью тысячами транзакций.
//
// Боссы не фармятся: у них респаун 1-2 часа, и в локации оффлайна их нет.

const crypto = require('crypto');
const players = require('./db/repos/players');
const stats = require('./db/repos/stats');
const money = require('./db/repos/money');
const items = require('./db/repos/items');
const progression = require('./db/repos/progression');
const clans = require('./db/repos/clans');
const loot = require('./game/loot');
const { query, hasColumn } = require('./db');
const {
  OFFLINE_FARM_VIP_MIN, OFFLINE_FARM_MAX_HOURS, OFFLINE_FARM_MIN_SEC,
  offlineFarmLocations, offlineFarmLocation, offlineFarmRate,
  VIP_BONUSES, SEASON_TICKET_DROP_PCT, SEASON_TICKET_XP_PCT, SEASON_TICKET_LIBERTY_PCT, seasonActive,
  FARM_LIBERTY_CHANCE, FARM_HIGH_LIBERTY_CHANCE, GRAM_DROP_CHANCE, GRAM_PER_LEVEL,
  clanBonusOf, oreDropChance, CRAFT_MATS, NEWBIE_BUFF,
} = require('../shared/definitions');

// Тот же генератор, что у онлайн-наград (handlers2/world.js): бросок решает,
// упадёт ли вещь, которая стоит денег на рынке.
const rand = () => crypto.randomInt(2 ** 30) / (2 ** 30);

const fail = (msg, code) => { throw Object.assign(new Error(msg), { userMessage: msg, code }); };

const MAX_MS = OFFLINE_FARM_MAX_HOURS * 3600 * 1000;
const _MAT_BY_ID = new Map(CRAFT_MATS.map(m => [m.id, m]));

async function available() { return hasColumn('player_progress', 'offline_farm'); }

// Характеристики, по которым считается темп, — постоянные. Зелья сняты, а
// «Награда новичка» оставлена: она на неделю и переживёт любой фарм.
async function _permanentStats(db, playerId) {
  const row = await stats.load(db, playerId);
  if (!row) return null;
  const buffs = {};
  const nb = row.buffs && row.buffs[NEWBIE_BUFF.type];
  if (nb) buffs[NEWBIE_BUFF.type] = nb;
  return stats.compute({ ...row, buffs });
}

// Только то, что нужно расчёту. Числа, не объект целиком: запись лежит в
// jsonb до двенадцати часов, и в ней не должно быть ничего лишнего.
function _snapshot(st) {
  const n = v => Number(v) || 0;
  return {
    atk: n(st.atk), def: n(st.def), maxHp: n(st.maxHp), hpRegen: n(st.hpRegen),
    critChance: n(st.critChance), critPower: n(st.critPower), atkSpeed: n(st.atkSpeed),
    gearXpPct: n(st.gearXpPct), gearDropPct: n(st.gearDropPct), gearNexumPct: n(st.gearNexumPct),
  };
}

// ── что показывает окно выбора ──────────────────────────────────────────────
// Каждая локация: открыта ли по уровню, в силах ли игрок её фармить и сколько
// в час. Опыт и золото в час — без бонусов, «как есть с монстра»: бонусы у
// всех разные и лягут сверху при выдаче.
async function info(db, playerId) {
  const prog = await players.progressOf(db, playerId);
  const st = await _permanentStats(db, playerId);
  const snap = st ? _snapshot(st) : null;
  const lvl = (prog && prog.lvl) || 1;
  const list = offlineFarmLocations().map(loc => {
    const out = { id: loc.id, kind: loc.kind, arm: loc.arm || null, minLvl: loc.minLvl, maxLvl: loc.maxLvl,
                  reqLevel: loc.reqLevel, open: lvl >= loc.reqLevel };
    if (!out.open || !snap) return out;
    const r = offlineFarmRate(snap, loc);
    out.ok = r.ok;
    if (!r.ok) { out.reason = r.reason; return out; }
    const avg = f => r.mobs.reduce((a, m) => a + f(m), 0) / r.mobs.length;
    out.killsPerHour = Math.round(r.killsPerHour);
    out.xpPerHour = Math.round(r.killsPerHour * avg(m => m.xp));
    out.goldPerHour = Math.round(r.killsPerHour * avg(m => m.gold) * 0.30);
    out.reach = r.reach;
    return out;
  });
  let active = null;
  if (await available()) {
    const { rows } = await query(db, 'SELECT offline_farm FROM player_progress WHERE player_id = $1', [playerId]);
    const f = rows.length ? rows[0].offline_farm : null;
    if (f) active = { loc: f.loc, at: Number(f.at) };
  }
  const vip = (await progression.vipOf(db, playerId)).level || 0;
  return { locations: list, active, maxHours: OFFLINE_FARM_MAX_HOURS, minSec: OFFLINE_FARM_MIN_SEC,
           vipLevel: vip, vipMin: OFFLINE_FARM_VIP_MIN };
}

// ── запуск ──────────────────────────────────────────────────────────────────
async function start(db, playerId, locId) {
  if (!await available()) fail('Оффлайн-фарм пока недоступен', 'unavailable');
  const loc = typeof locId === 'string' ? offlineFarmLocation(locId) : null;
  if (!loc) fail('Неизвестная локация', 'bad_loc');
  // Уровень VIP — из базы, а не с сессии: кэш сессии обновляется не на каждую
  // покупку, а порог решает, пускать ли вообще.
  const vip = (await progression.vipOf(db, playerId)).level || 0;
  if (vip < OFFLINE_FARM_VIP_MIN) fail(`Оффлайн-фарм доступен с VIP ${OFFLINE_FARM_VIP_MIN}`, 'vip_required');

  const { rows } = await query(db,
    'SELECT lvl, char_class, offline_farm FROM player_progress WHERE player_id = $1 FOR UPDATE', [playerId]);
  if (!rows.length) fail('Персонаж не найден', 'no_player');
  if (!rows[0].char_class) fail('Сначала выберите класс', 'no_class');
  if (rows[0].offline_farm) fail('Оффлайн-фарм уже запущен', 'already');
  if ((rows[0].lvl || 1) < loc.reqLevel) fail(`Нужен ${loc.reqLevel} уровень`, 'low_level');

  const st = await _permanentStats(db, playerId);
  if (!st) fail('Персонаж не найден', 'no_player');
  const snap = _snapshot(st);
  const r = offlineFarmRate(snap, loc);
  if (!r.ok) fail('Монстры здесь пока слишком сильны для вас', 'too_strong');

  const at = Date.now();
  await query(db, 'UPDATE player_progress SET offline_farm = $2, updated_at = now() WHERE player_id = $1',
    [playerId, JSON.stringify({ loc: loc.id, at, st: snap })]);
  return { loc: loc.id, at, killsPerHour: Math.round(r.killsPerHour), maxHours: OFFLINE_FARM_MAX_HOURS };
}

// ── сколько убийств ─────────────────────────────────────────────────────────
// Дробная часть не выбрасывается и не округляется вверх, а разыгрывается:
// 2.3 убийства — это 2 наверняка и третье с шансом 30%. Иначе короткие фармы
// систематически теряли бы или дарили по монстру.
function _killsFor(killsPerHour, sec) {
  const exact = killsPerHour * sec / 3600;
  const whole = Math.floor(exact);
  return whole + (rand() < exact - whole ? 1 : 0);
}

// Какая часть окна фарма пришлась на действие зелья, которое истекает в
// `until` (мс). Зелье опыта, выпитое за пять минут до выхода, удваивает опыт
// первых пяти минут фарма, а не всех двенадцати часов.
function _overlap(until, from, to) {
  const u = Number(until) || 0;
  if (u <= from || to <= from) return 0;
  return Math.min(1, (u - from) / (to - from));
}

// ── прогон убийств ──────────────────────────────────────────────────────────
// Чистая функция от снимка, бонусов и числа убийств — чтобы её можно было
// проверить без базы (dev/offline-farm-check.js). Бонусы — те же поля, что
// onKill читает с сессии: vipLevel, seasonTicket, clanLevel.
function simulate(loc, snap, kills, bonus = {}) {
  const r = offlineFarmRate(snap, loc);
  const out = { kills: 0, xp: 0, gold: 0, nexum: 0, gram: 0, drops: [], byEid: {} };
  if (!r.ok || kills <= 0) return out;

  const vipB = VIP_BONUSES[bonus.vipLevel || 0] || VIP_BONUSES[0] || {};
  const ticketOn = !!(bonus.seasonTicket && seasonActive());
  const clanB = clanBonusOf(bonus.clanLevel);
  const xpPct = (vipB.xp || 0) + (ticketOn ? (SEASON_TICKET_XP_PCT || 0) : 0) + clanB.xp + (snap.gearXpPct || 0);
  const goldPct = (vipB.gold || 0) + clanB.gold;
  const extraRoll = (vipB.drop || 0) + (snap.gearDropPct || 0) + (ticketOn ? (SEASON_TICKET_DROP_PCT || 0) : 0);
  const ticketLibertyMult = ticketOn ? 1 + (SEASON_TICKET_LIBERTY_PCT || 0) / 100 : 1;
  const runeNexumMult = 1 + (snap.gearNexumPct || 0) / 100;
  const libertyChance = (loc.kind === 'farmZone' ? (FARM_LIBERTY_CHANCE || 0)
    : loc.kind === 'farmHigh' ? (FARM_HIGH_LIBERTY_CHANCE || 0) : 0) * ticketLibertyMult * runeNexumMult;
  const payGram = loc.kind === 'corridor';

  const rollTable = (inv, m) =>
      loc.kind === 'farmZone' ? loot._rollFarmZoneLoot(inv, m.eid)
    : loc.kind === 'farmHigh' ? loot._rollFarmHighLoot(inv, m.eid)
    : loot._rollMobLoot(inv, m.eid, m.rlvl);

  // Материалы складываются в одну стопку на вид, снаряжение — по штуке: оно
  // не стакается, и каждая вещь ляжет в свою ячейку.
  const stacks = new Map();
  const push = (d) => {
    if (_MAT_BY_ID.has(d.id)) {
      const cur = stacks.get(d.id);
      if (cur) cur.qty += d.qty || 1;
      else stacks.set(d.id, { id: d.id, name: d.name, rarity: d.rarity, qty: d.qty || 1 });
    } else {
      out.drops.push({ id: d.id, name: d.name, rarity: d.rarity, qty: 1 });
    }
  };

  let xp = 0, gold = 0, gram = 0;
  for (let i = 0; i < kills; i++) {
    const m = r.mobs[Math.floor(rand() * r.mobs.length)];
    out.byEid[m.eid] = (out.byEid[m.eid] || 0) + 1;
    xp += m.xp;
    if (rand() < 0.30) gold += m.gold;                     // calcGoldDrop
    for (const d of (rollTable([], m) || [])) push(d);
    if (rand() < oreDropChance(m.rlvl)) {
      const ore = _MAT_BY_ID.get('ore_common');
      if (ore) push({ id: ore.id, name: ore.name, rarity: ore.rarity, qty: 1 });
    }
    if (extraRoll > 0 && rand() * 100 < extraRoll) for (const d of (rollTable([], m) || [])) push(d);
    if (libertyChance > 0 && rand() < libertyChance) out.nexum++;
    if (payGram && rand() < (GRAM_DROP_CHANCE || 0)) gram += (m.rlvl || 1) * (GRAM_PER_LEVEL || 0);
  }
  out.kills = kills;
  out.xp = Math.round(xp * (1 + xpPct / 100));
  out.gold = Math.round(gold * (1 + goldPct / 100));
  // numeric(24,8) в балансе; сумма тысяч 1e-7 в float копит хвост.
  out.gram = Math.round(gram * 1e8) / 1e8;
  out.drops.unshift(...stacks.values());
  return out;
}

// ── забрать на входе ────────────────────────────────────────────────────────
// null — фарма не было. Иначе сводка для окна «пока вас не было».
// `s` — сессия: VIP, билет и клан читаются с неё, как и у онлайн-убийства.
async function claim(db, playerId, s) {
  if (!await available()) return null;
  // Обычный вход — без фарма, и ему незачем что-то блокировать: сначала
  // дешёвый взгляд без блокировки, и только если есть что забирать — дальше.
  const { rows: peek } = await query(db,
    'SELECT offline_farm IS NOT NULL AS has FROM player_progress WHERE player_id = $1', [playerId]);
  if (!peek.length || !peek[0].has) return null;
  // Порядок блокировок — как у grantKillReward: предметы (строка игрока)
  // первыми, player_progress после. Обратный порядок против параллельной
  // выдачи предметов этому же игроку — готовый deadlock.
  await items.lockPlayer(db, playerId);
  // Забирается и стирается одним запросом, под блокировкой строки: второй
  // вход того же аккаунта в ту же секунду получит пустоту, а откат
  // транзакции вернёт запись на место вместе со всем остальным.
  // `prev`, а не `old`: в PostgreSQL 18 `old` в RETURNING — это прежняя
  // версия строки, и CTE с тем же именем сделал бы запрос двусмысленным.
  const { rows } = await query(db, `
    WITH prev AS (
      SELECT offline_farm FROM player_progress WHERE player_id = $1 FOR UPDATE
    )
    UPDATE player_progress p SET offline_farm = NULL, updated_at = now()
      FROM prev
     WHERE p.player_id = $1 AND prev.offline_farm IS NOT NULL
    RETURNING prev.offline_farm AS farm, p.buffs AS buffs`, [playerId]);
  if (!rows.length) return null;
  const farm = rows[0].farm || {};
  const loc = offlineFarmLocation(farm.loc);
  const at = Number(farm.at) || 0;
  const now = Date.now();
  const ms = Math.max(0, Math.min(now - at, MAX_MS));
  const sec = Math.floor(ms / 1000);
  const summary = { loc: farm.loc, seconds: sec, capped: now - at > MAX_MS, kills: 0,
                    xp: 0, gold: 0, nexum: 0, gram: 0, items: [], lost: [], levelsGained: 0 };
  if (!loc || !farm.st || !at || sec < OFFLINE_FARM_MIN_SEC) { summary.tooShort = true; return summary; }

  const r = offlineFarmRate(farm.st, loc);
  const kills = r.ok ? _killsFor(r.killsPerHour, sec) : 0;
  const res = simulate(loc, farm.st, kills, {
    vipLevel: s && s.vipLevel, seasonTicket: s && s.seasonTicket, clanLevel: s && s.clan && s.clan.level,
  });

  // Зелья опыта/золота и «Награда новичка» — на ту часть фарма, которую они
  // действительно покрыли. Множители те же, что в onKill.
  const buffs = rows[0].buffs || {};
  const to = at + ms;
  const fExp = _overlap(buffs.exp, at, to);
  const fGold = _overlap(buffs.gold, at, to);
  const fNew = _overlap(buffs[NEWBIE_BUFF.type], at, to);
  const xp = Math.round(res.xp * (1 + fExp) * (1 + fNew * (NEWBIE_BUFF.xpMult - 1)));
  const gold = Math.round(res.gold * (1 + fGold));

  const idem = `offline:${playerId}:${at}`;
  if (gold > 0) await money.credit(db, playerId, 'gold', gold, { reason: 'offline_farm', idemKey: `${idem}:gold` });
  if (res.nexum > 0) await money.credit(db, playerId, 'nexum', res.nexum, { reason: 'offline_farm', idemKey: `${idem}:nexum` });
  if (res.gram > 0) await money.credit(db, playerId, 'gram', res.gram, { reason: 'offline_farm', idemKey: `${idem}:gram` });
  let xpRes = null;
  if (xp > 0) xpRes = await players.grantXp(db, playerId, xp);
  for (const d of res.drops) {
    // Полная сумка — как и онлайн: не влезло, значит пропало, и игроку это
    // говорится списком, а не молчанием.
    if (!await items.hasRoomFor(db, playerId, d.id)) { summary.lost.push(d); continue; }
    const rowId = await items.add(db, playerId, d.id, { qty: d.qty || 1, source: 'offline_farm', sourceRef: idem });
    if (rowId === null) summary.lost.push(d); else summary.items.push(d);
  }

  // Счётчики, которые онлайн двигает каждое убийство: клан, сюжетный квест и
  // сезонные задания фарм-зон.
  const clanId = s && s.clan && s.clan.clanId;
  if (clanId && kills > 0) await clans.addXp(db, clanId, clans.CLAN_XP_PER_KILL * kills);
  for (const [eid, n] of Object.entries(res.byEid)) {
    await progression.questOnKill(db, playerId, { eid, rlvl: loc.maxLvl, count: n });
  }
  if (kills > 0) {
    if (loc.kind === 'farmZone') await progression.bumpFarmKill(db, playerId, 'farmKills', undefined, kills);
    else if (loc.kind === 'farmHigh') await progression.bumpFarmKill(db, playerId, 'farmHighKills', undefined, kills);
  }
  if (xpRes && xpRes.levelsGained > 0) {
    summary.levelsGained = xpRes.levelsGained;
    summary.refBonus = await progression.payReferralOnLevel(db, playerId, xpRes.lvl || 0);
  }

  summary.kills = kills;
  summary.xp = xpRes ? (xpRes.granted != null ? xpRes.granted : xp) : 0;
  summary.gold = gold;
  summary.nexum = res.nexum;
  summary.gram = res.gram;
  return summary;
}

module.exports = { available, info, start, claim, simulate, _killsFor, _overlap };
