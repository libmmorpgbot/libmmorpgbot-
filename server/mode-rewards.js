'use strict';
// ── What an event mode pays, and to whom ────────────────────────────────────
//
// The six mode factories under server/game/ are kept verbatim from the old
// build, and they pay their winners by reaching into the winner's connection:
//
//   const won = s?.data?._dbGrantWin ? await s.data._dbGrantWin() : null;
//   const paid = await s.data._race10GrantReward(won);
//   const reward = winnerSocket?.data?._grantCoopBossReward ? await … : null;
//
// Four such closures, and the rewrite assigned none of them. Every call is
// written defensively — `?.` or a `? :` guard — so nothing threw and nothing
// logged: the death battle ended, announced a winner, and paid them nothing.
// The 3v3 arena the same. The Кровавая Башня the same, for every entrant. The
// co-op boss the same.
//
// They live here rather than in app.js because each is a transaction over the
// same repos every other reward goes through — and going through money.js is
// the point: the old versions incremented a per-connection balance field and
// let the debounced save carry it, so a disconnect between the win and the
// save lost the prize.
//
// Two rules hold for all four:
//
//   ONE KEY PER CALL   and deliberately so. The ledger's idem_key exists to
//                make a RETRIED transaction safe; none of these is retried —
//                each is called once from its mode's finish path, and `tx`
//                here does not retry. A key derived from the day instead would
//                be worse than useless: the 3v3 arena allows three runs a day
//                and co-op two, so the second and third win would find their
//                own key already in the ledger and pay nothing at all. Same
//                reasoning as resetUpgrades, which spells it out: two resets
//                on purpose are two legitimate resets.
//
//   ITEMS MAY NOT FIT   a full inventory must not swallow the currency half of
//                the reward. Room is checked per item and what does not fit is
//                reported back rather than silently dropped, which is what the
//                mode's own "delivered" flag is for.

const { tx } = require('./db');
const money = require('./db/repos/money');
const items = require('./db/repos/items');
const {
  DEATH_BATTLE_GRAM_REWARD, deathBattleRewards,
  race10Rewards, race10Liberty,
} = require('../shared/definitions');

// The co-op boss. Not in shared/definitions because nothing else refers to it
// — stated here, where it is paid.
const COOP_BOSS_NEXUM = 100;
const COOP_BOSS_ITEM = 'bless_stone';
const ARENA3_NEXUM = 10;

// `ref` names the mode, for the ledger's own audit trail.
//
// The key used to end in crypto.randomUUID() — a fresh value on every call,
// which means the ledger's UNIQUE constraint could never refuse anything and
// these four payouts had no idempotency whatsoever. The argument for it was
// that none of the four is ever retried. Three are genuinely single-fire; the
// co-op one deletes its run record only AFTER awaiting the payout, so its
// guard is still true for the whole payout window and the only thing stopping
// a second entry is attackEnemy refusing a hit on a corpse. Any future change
// to a finish path — a retry, a reconnect mid-finish, a second killed:true —
// would have paid twice, silently, and no reconcile could have caught it,
// because every key was unique.
//
// A ten-second bucket instead. A double-fire is milliseconds apart, so it
// collides and money.credit replays the first payment rather than making a
// second. What this does NOT do is dedupe two payouts more than ten seconds
// apart — it is a guard against re-entry, not a run identifier. No mode here
// can legitimately pay the same player twice inside ten seconds: every one of
// them runs for minutes.
const MODE_IDEM_BUCKET_MS = 10000;
async function credit(t, pid, currency, amount, ref) {
  if (!(amount > 0)) return null;
  const bucket = Math.floor(Date.now() / MODE_IDEM_BUCKET_MS);
  return money.credit(t, pid, currency, amount, {
    reason: 'mode_reward', refType: 'mode', refId: String(ref),
    idemKey: `mode:${pid}:${ref}:${bucket}`,
  });
}

// Grants a list of catalog-shaped items, reporting what did not fit. The list
// comes from shared/definitions (deathBattleRewards, race10Rewards): each entry
// is a fully-formed item, so nothing here has to know what any of them are.
async function grantItems(t, pid, list) {
  // The lock items.js requires of anything that mutates items. Mode payouts
  // ran without it, so hasRoomFor -> add below could interleave with a kill
  // reward landing at the same moment and push the inventory past its cap.
  await items.lockPlayer(t, pid);
  const given = [], missed = [];
  for (const it of list) {
    const id = it && it.id;
    if (!id) continue;
    const qty = Math.max(1, Math.floor(Number(it.qty) || 1));
    // The WHOLE catalog entry comes back, not just the id: race10Result maps
    // each reward to { id, name, img, qty } for its result screen, and a list
    // of bare ids renders as a row of blanks.
    const entry = { ...it, id, qty };
    if (await items.hasRoomFor(t, pid, id)
        && await items.add(t, pid, id, { qty, source: 'mode', sourceRef: id }) !== null) given.push(entry);
    else missed.push(entry);
  }
  return { given, missed };
}

// Attaches the four closures to one connection. Called once per login, from
// the same place every other piece of per-connection state is set up.
function attach(socket, s) {
  // A mode resolves the winner's socket and then awaits this. By the time it
  // runs, the account may have reconnected on a different socket — the
  // PLAYER id is what the reward belongs to, and that does not change.
  const pid = () => (s.authed ? s.playerId : null);

  // Death battle: GRAM plus a fixed item set.
  socket.data._dbGrantWin = async () => {
    const id = pid();
    if (!id) return null;
    const ref = 'deathbattle';
    try {
      return await tx(async (t) => {
        const bal = await credit(t, id, 'gram', DEATH_BATTLE_GRAM_REWARD, ref);
        const { given, missed } = await grantItems(t, id, deathBattleRewards());
        await s.pushBalances(t);
        if (given.length) await s.pushItems(t);
        // `delivered` is what the winner's result screen prints — it means
        // "all of it fit", not "something was granted".
        return {
          gram: DEATH_BATTLE_GRAM_REWARD, balance: bal && bal.balance,
          items: given, missed, delivered: missed.length === 0,
        };
      });
    } catch (err) { return _report('deathbattle', err, id); }
  };

  // 3v3 arena: Liberty only. Returns the amount, which is what the mode puts
  // in its own end-of-match packet.
  socket.data._a3GrantWin = async () => {
    const id = pid();
    if (!id) return 0;
    try {
      await tx(async (t) => {
        await credit(t, id, 'nexum', ARENA3_NEXUM, 'arena3');
        await s.pushBalances(t);
      });
      return ARENA3_NEXUM;
    } catch (err) { _report('arena3', err, id); return 0; }
  };

  // Кровавая Башня: paid to EVERY entrant who landed a hit on the boss, not
  // only the winner — `won` picks the tier.
  socket.data._race10GrantReward = async (won) => {
    const id = pid();
    if (!id) return null;
    const ref = `race10:${won ? 'win' : 'part'}`;
    try {
      return await tx(async (t) => {
        const nexum = race10Liberty(won);
        const bal = await credit(t, id, 'nexum', nexum, ref);
        const { given, missed } = await grantItems(t, id, race10Rewards(won));
        await s.pushBalances(t);
        if (given.length) await s.pushItems(t);
        return { nexum, balance: bal && bal.balance, items: given, missed, delivered: missed.length === 0 };
      });
    } catch (err) { return _report('race10', err, id); }
  };

  // Co-op boss: Liberty plus one safe-enhancement stone, to whoever landed the
  // killing blow. The run ends for both participants either way.
  socket.data._grantCoopBossReward = async () => {
    const id = pid();
    if (!id) return null;
    try {
      return await tx(async (t) => {
        const bal = await credit(t, id, 'nexum', COOP_BOSS_NEXUM, 'coop');
        const { given, missed } = await grantItems(t, id, [{ id: COOP_BOSS_ITEM, qty: 1 }]);
        await s.pushBalances(t);
        if (given.length) await s.pushItems(t);
        return {
          nexum: COOP_BOSS_NEXUM, balance: bal && bal.balance,
          items: given, missed, delivered: missed.length === 0,
        };
      });
    } catch (err) { return _report('coop', err, id); }
  };
}

function _report(mode, err, playerId) {
  const ops = require('./tg-ops');
  console.error(`[mode-reward:${mode}]`, err);
  ops.alertError(`modeReward.${mode}`, `Не удалось выплатить награду (${mode})`, err, { playerId });
  return null;
}

module.exports = { attach, ARENA3_NEXUM, COOP_BOSS_NEXUM, COOP_BOSS_ITEM };
