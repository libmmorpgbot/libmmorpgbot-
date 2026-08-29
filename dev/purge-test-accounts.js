#!/usr/bin/env node
'use strict';
// ── Убрать из боевой базы то, что наделали проверки ─────────────────────────
//
//   node dev/purge-test-accounts.js            только посчитать
//   node dev/purge-test-accounts.js --apply    и убрать
//
// Проверки из dev/ ходят по БОЕВОЙ базе — отдельной у проекта нет, — и каждая
// создаёт себе игроков через players.ensure. Убирали за собой не все, и
// накопилось около трёх тысяч аккаунтов: они попали в рейтинг
// (@adm-45491_victim, ур. 77, 5400 БМ), в админку и в общий чат.
//
// ── чем тестовый аккаунт отличается от живого ───────────────────────────────
// Первый заход отбирал по ИМЕНИ, по списку префиксов из `const TAG`. Этого
// оказалось мало: под `sk-?\\d{2,7}` подошёл живой игрок Sk1850, зашедший
// пятого августа с настоящим telegram id. Имя — не признак.
//
// Признак — telegram_id. Настоящий вход всегда приносит ЧИСЛО: finishLogin
// берёт его из payload Telegram и делает String(). Проверки же пишут туда свой
// тег целиком («cchk-72449-lead»), и такого не может появиться ни у одного
// живого аккаунта. Это правило и стоит первым, и оно закрывает 2981 из них.
//
// Оставшиеся сделаны через socket-логин с выдуманным числовым id. Для них
// правило тройное, и каждая часть отсекает Sk1850 по отдельности: имя вида
// «префикс-цифры_суффикс» (у него нет суффикса), id в диапазоне, который
// проверки себе выделили (у него 7338327135), и дата создания (он от 05.08).
//
// ── две судьбы, и они разные не по прихоти ──────────────────────────────────
//   без строк в ledger   удаляются целиком;
//   со строками          НЕ удаляются: у liberty_app намеренно нет права
//                        DELETE на ledger — процесс, который двигает деньги, не
//                        должен уметь стирать запись об этом, — и внешний ключ
//                        держит самого игрока. Такие банятся и обнуляются по
//                        БМ: из рейтинга их убирает каждое из двух по
//                        отдельности, а запись о движении денег цела.
const { pool, close } = require('../server/db');

const APPLY = process.argv.includes('--apply');

// Правило A: telegram_id не число. Настоящий вход такого дать не может.
const A = `telegram_id !~ '^[0-9]+$'`;
// Правило B: socket-логин проверок. Все три условия сразу.
const B = `(username ~ '^(ilchk|pchk|mfix|mkt|gchk|pvp|cchk|ichk|cn|cr|etl|enh|expl|gr|qchk`
        + `|mchk|pt|st|adm|ad|ev|pl|sk|boot|rl|se|pcl|stackchk|bot|gw)-[0-9]{2,7}_[a-z0-9]+$'`
        + ` AND telegram_id ~ '^[0-9]+$' AND telegram_id::bigint BETWEEN 930000000 AND 990000000`
        + ` AND created_at >= timestamptz '2026-08-01')`;
const WHERE = `(${A} OR ${B})`;

const q = (sql, args) => pool().query(sql, args);
const n = async (sql, args) => Number((await q(sql, args)).rows[0].n);

(async () => {
  // Список считается ОДИН раз и дальше везде используется как массив id.
  // Первый заход подставлял условие текстом в каждый подзапрос и получил
  // «column reference created_at is ambiguous» — правило, которое нельзя
  // прочитать глазами, ещё и ломается.
  const ids = (await q(`SELECT id FROM players WHERE ${WHERE}`)).rows.map(r => Number(r.id));
  const total = ids.length;
  if (!total) { console.log('\n  тестовых аккаунтов нет\n'); await close(); return; }

  // ── ни один живой игрок не должен попасть под правило ────────────────────
  // Признак живого — связь с аккаунтом, который САМ под правило не подходит:
  // кошелёк, клан, приведённый живой друг или живой пригласивший. Связи
  // «тест с тестом» под это не идут — их проверки и наплодили.
  const { rows: suspect } = await q(`
    SELECT p.id, p.username, p.telegram_id FROM players p
     WHERE p.id = ANY($1)
       AND (p.ton_address IS NOT NULL
         OR EXISTS (SELECT 1 FROM clan_members m WHERE m.player_id = p.id)
         OR EXISTS (SELECT 1 FROM players r
                     WHERE r.referred_by = p.telegram_id AND NOT (r.id = ANY($1)))
         OR EXISTS (SELECT 1 FROM players r2
                     WHERE r2.telegram_id = p.referred_by AND NOT (r2.id = ANY($1))))
     LIMIT 10`, [ids]);
  if (suspect.length) {
    console.log('\n  \x1b[31mОСТАНОВЛЕНО\x1b[0m: под правило попали аккаунты со связями с живыми:');
    for (const s of suspect) console.log(`    ${s.username}  tg=${s.telegram_id}`);
    console.log('  Правило нужно сузить, база не тронута.\n');
    await close();
    process.exit(1);
  }

  // Чат отбирается ещё и ПО ИМЕНИ. chat_messages хранит username отдельной
  // колонкой, и строка переживает удаление игрока: двадцать сообщений
  // «привет<ESC>[31m xxxxx» от boot-*_u остались висеть в общем чате после
  // того, как сами аккаунты уже убрали. Убирать надо и их.
  const CHAT_PAT = "^(ilchk|pchk|mfix|mkt|gchk|pvp|cchk|ichk|cn|cr|etl|enh|expl|gr|qchk"
                 + "|mchk|pt|st|adm|ad|ev|pl|sk|boot|rl|se|pcl|stackchk|bot|gw)-?[0-9]{2,7}(_[a-z0-9]+)?$";
  const chat = await n(
    'SELECT count(*)::int n FROM chat_messages WHERE player_id = ANY($1) OR username ~ $2',
    [ids, CHAT_PAT]);
  const held = await n('SELECT count(DISTINCT player_id)::int n FROM ledger WHERE player_id = ANY($1)', [ids]);
  const inRating = await n(
    'SELECT count(*)::int n FROM players WHERE id = ANY($1) AND NOT banned AND bm > 0', [ids]);

  console.log(`\n  тестовых аккаунтов: ${total}`);
  console.log(`    видны в рейтинге:  ${inRating}`);
  console.log(`    держит ledger:     ${held}  (банятся, не удаляются)`);
  console.log(`    удаляются целиком: ${total - held}`);
  console.log(`  их сообщений в общем чате: ${chat}`);

  if (!APPLY) {
    console.log('\n  это разведка. Убрать:  node dev/purge-test-accounts.js --apply\n');
    await close();
    return;
  }

  // Чат — первым: эти сообщения игроки видят прямо сейчас.
  await q('DELETE FROM chat_messages WHERE player_id = ANY($1) OR username ~ $2', [ids, CHAT_PAT]);

  // Кого держит ledger — бан и БМ в ноль.
  await q(`UPDATE players SET banned = true, bm = 0
            WHERE id = ANY($1) AND EXISTS (SELECT 1 FROM ledger l WHERE l.player_id = players.id)`, [ids]);

  const free = (await q(`SELECT id FROM players WHERE id = ANY($1)
      AND NOT EXISTS (SELECT 1 FROM ledger l WHERE l.player_id = players.id)`, [ids])).rows.map(r => Number(r.id));
  const DEP = [
    'DELETE FROM clan_applications WHERE player_id = ANY($1)',
    'DELETE FROM clan_members WHERE player_id = ANY($1)',
    'DELETE FROM market_listings WHERE seller_id = ANY($1)',
    'DELETE FROM player_items WHERE player_id = ANY($1)',
    'DELETE FROM item_ledger WHERE player_id = ANY($1)',
    'DELETE FROM player_logs WHERE player_id = ANY($1)',
    'DELETE FROM player_season WHERE player_id = ANY($1)',
    'DELETE FROM player_daily WHERE player_id = ANY($1)',
    'DELETE FROM player_vip WHERE player_id = ANY($1)',
    'DELETE FROM balances WHERE player_id = ANY($1)',
    'DELETE FROM player_progress WHERE player_id = ANY($1)',
    'DELETE FROM players WHERE id = ANY($1)',
  ];
  let removed = 0;
  for (let i = 0; i < free.length; i += 500) {
    const chunk = free.slice(i, i + 500);
    for (const sql of DEP) await q(sql, [chunk]).catch(() => {});
    removed += chunk.length;
  }

  const left = await n(`SELECT count(*)::int n FROM players WHERE ${WHERE}`);
  const leftVisible = await n(`SELECT count(*)::int n FROM players WHERE ${WHERE} AND NOT banned AND bm > 0`);
  const leftChat = await n('SELECT count(*)::int n FROM chat_messages WHERE player_id = ANY($1) OR username ~ $2', [ids, CHAT_PAT]);

  console.log(`\n  удалено целиком: ${removed}`);
  console.log(`  осталось (забанены, БМ 0, ledger цел): ${left}`);
  console.log(`  из них видны в рейтинге: ${leftVisible}`);
  console.log(`  сообщений в чате осталось: ${leftChat}`);
  console.log(`  ${leftVisible === 0 && leftChat === 0 ? '1 пройшло, 0 впало' : '0 пройшло, 1 впало'}\n`);
  await close();
})().catch(e => { console.error('  ОШИБКА: ' + e.message); process.exit(1); });
