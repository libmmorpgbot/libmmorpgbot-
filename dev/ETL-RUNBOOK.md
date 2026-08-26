# Перенос данных Mongo → PostgreSQL

Один запуск, по живым деньгам и вещам, в окно обслуживания. Скрипт —
`dev/etl.js`, его детектор — `dev/etl-check.js`.

Порядок ниже написан так, чтобы **до точки невозврата** каждый шаг можно было
отменить бесплатно, а после неё — не пришлось. Всё, что идёт до неё, делается
дважды: один раз вхолостую и один раз на запасной базе. Само окно — третий
повтор того же самого, а не первый прыжок.

Три свойства, на которых всё держится (шапка `dev/etl.js` объясняет их
подробно):

| | |
|---|---|
| идемпотентность | повторный прогон ничего не меняет; ключ — `telegram_id` |
| атомарность на игрока | один аккаунт = одна транзакция; предметов без баланса не бывает |
| громкость про потери | всё, что не переехало, **посчитано и названо** в отчёте |

## Что нужно и чего нет

| | |
|---|---|
| дроплет | `root@178.128.136.68`, ключ `~/.ssh/liberty_do` |
| новая сборка | `/srv/liberty/next`, сервис `liberty-next` |
| env | `/srv/liberty/env` (там `DATABASE_URL`, `PG_CA_FILE=/srv/liberty/pg-ca.crt`) |
| база | `private-liberty-db-do-user-42796403-0.m.db.ondigitalocean.com:25060/liberty` |
| миграции | **только владелец**, паролем `doadmin` — ни у кого другого его нет |

`liberty_app` (та учётка, что в `DATABASE_URL`) намеренно **не умеет DDL**.
Поэтому шаг 1 может выполнить только владелец, и никакой скрипт здесь этого
не обойдёт.

## 0. Откуда возьмётся Mongo — решить ЗАРАНЕЕ

**Сейчас не работает ни один из двух путей.** В `/srv/liberty/env` нет
`MONGODB_URI`, а `mongodump` / `mongosh` / `mongo` на дроплете не установлены
вовсе. `dev/etl.js` ходит в Mongo через mongoose, не через CLI, — так что
клиент нужен только для дампа, но сам адрес нужен обязательно.

Выбрать одно и подготовить **до** окна:

**A. Подключаться к живой Mongo напрямую.** Ничего не ставить, но источник
должен принимать соединение с IP дроплета (`178.128.136.68`) — в Atlas это
Network Access → добавить адрес. Дописать строку в env:

```bash
ssh -i ~/.ssh/liberty_do root@178.128.136.68
echo 'MONGODB_URI=mongodb+srv://...' >> /srv/liberty/env
```

Проверить, что адрес живой, **до** окна:

```bash
cd /srv/liberty/next && set -a && . /srv/liberty/env && set +a
node -e "require('mongoose').connect(process.env.MONGODB_URI,{serverSelectionTimeoutMS:8000})
  .then(m=>m.connection.db.collection('players').countDocuments())
  .then(n=>{console.log('игроков:',n);process.exit(0)})
  .catch(e=>{console.error(e.message);process.exit(1)})"
```

**B. Дамп и восстановление на дроплете.** Источник никуда не открывается,
зато перенос идёт с локальной копии и не зависит от чужой сети. Поставить:

```bash
apt-get update
apt-get install -y mongodb-database-tools    # mongodump / mongorestore
apt-get install -y mongodb-org-server        # сам mongod; нужен репозиторий MongoDB
```

Дальше — снять дамп там, где Mongo доступна, привезти и поднять:

```bash
mongodump --uri="mongodb+srv://..." --out=dump/
scp -i ~/.ssh/liberty_do -r dump root@178.128.136.68:/srv/liberty/mongo-dump
ssh -i ~/.ssh/liberty_do root@178.128.136.68 \
  'mongorestore --drop --db liberty /srv/liberty/mongo-dump/<имя_базы>'
echo 'MONGODB_URI=mongodb://127.0.0.1:27017/liberty' >> /srv/liberty/env
```

**B надёжнее** — дамп это ещё и резервная копия, которая переживёт окно, — но
требует установки. A быстрее и требует доступа. Третьего варианта нет: без
`MONGODB_URI` скрипт выходит на первой строке.

## 1. Миграции (владелец, `doadmin`)

```bash
ssh -i ~/.ssh/liberty_do root@178.128.136.68
bash /srv/liberty/migrate-now.sh        # спросит пароль doadmin, не покажет ввод
```

Пароль берётся в DigitalOcean → Databases → liberty-db → Connection details →
User: `doadmin` → Show password.

`dev/etl.js` пишет `player_items.source` (миграция 011) и
`market_listings.snap_item_id` (010). Он проверяет их наличие **до** первой
записи и выходит с внятным сообщением, а не двадцатью тысячами одинаковых
`42703`. Убедиться, что применено всё:

```sql
SELECT version FROM schema_migrations ORDER BY version;
-- ожидается 001…011, последней 011_item_provenance.sql
```

## 2. Чистка тестовых аккаунтов — ПРЕДУСЛОВИЕ, не пожелание

В базе **3521 тестовый аккаунт на 7 настоящих игроков**. Часть из них создана
socket-наборами через настоящий телеграмный вход и носит id вида `910000001`,
`930000631` — той же формы, что и живой.

Это самый тяжёлый способ провалить перенос, и провал будет **тихим**:
`ON CONFLICT (telegram_id) DO NOTHING` увидит существующую строку и
**пропустит настоящего игрока**. Не смешает с фикстурой — заменит ею. Месяц
игры не переедет, и в выводе это будет неотличимо от строки «уже был».

```bash
bash /srv/liberty/purge-test.sh          # спросит пароль doadmin
```

Проверка, что чистка прошла — **выполнить и посмотреть глазами**, а не
предположить:

```sql
-- 1. Сколько осталось всего. На чистой базе перед первым прогоном ждём 0.
SELECT count(*) AS accounts FROM players;

-- 2. Не осталось ли тестовых по шаблону.
SELECT count(*) AS still_test FROM players
 WHERE username ~ '^([a-z]{2,6}-[0-9]{3,6}[_-])|^(probe_|tester$|999$)'
    OR telegram_id !~ '^[0-9]+$';

-- 3. Числовые id-фикстуры, которые шаблон не ловит.
SELECT telegram_id, username FROM players WHERE telegram_id LIKE '9_________';

-- 4. Осиротевшие предметы и расхождения — должно быть 0/0.
SELECT count(*) FROM player_items pi
 WHERE pi.player_id IS NULL
   AND NOT EXISTS (SELECT 1 FROM market_listings m WHERE m.item_id = pi.id);
SELECT count(*) FROM balances b
 WHERE b.amount <> COALESCE((SELECT sum(l.delta) FROM ledger l
        WHERE l.player_id=b.player_id AND l.currency=b.currency), 0);
```

Если после чистки в `players` осталось что-то, кроме двух реальных админов
(`1199957588`, `8868342638`) — **остановиться**. Дальше идти нельзя.

Полностью пустая база получается так (тоже требует `DATABASE_URL`, не
`doadmin`):

```bash
cd /srv/liberty/next && set -a && . /srv/liberty/env && set +a
node dev/wipe-game-data.js                       # покажет, что снесёт, и ничего не сделает
WIPE_CONFIRM=liberty node dev/wipe-game-data.js --yes
```

## 3. Репетиция первая — `--dry`

Ничего не пишет. Прогоняет **весь** трансформ по всем документам и печатает
отчёт «что НЕ перенеслось».

```bash
cd /srv/liberty/next && set -a && . /srv/liberty/env && set +a
node dev/etl.js --dry 2>&1 | tee /srv/liberty/etl-dry-$(date +%F-%H%M).log
```

**Что смотреть — по порядку важности:**

1. **`предметы: усі id відомі каталогу ✅`** — единственная строка, которую
   нужно увидеть. Если вместо неё список id, то каждый такой id — это вещи,
   которые **исчезнут у живых людей**. Проверить каждый по `shared/definitions.js`.
   Если хоть один окажется настоящим предметом, добавленным позже, — **окно
   отменяется**, предмет добавляется в каталог, и `--dry` гоняется заново.
   Это ровно тот случай, ради которого пробный прогон существует.
2. **`знайдено акаунтів: N`** — сравнить с ожидаемым числом игроков. Меньше
   ожидаемого = не то имя коллекции или не та база.
3. **`перенеслось би: N акаунтів, M предметів`** — записать M. После боевого
   прогона `count(*) FROM player_items` должен сойтись с ним (плюс предметы из
   активных лотов, они считаются отдельно).
4. **`перейменовані акаунти`** — имена, столкнувшиеся на `citext UNIQUE`.
   Аккаунт не теряется, он переезжает на `tg_<id>`, но человек будет называться
   не так, как привык. Список — это те, кому надо сказать.
5. **`інвентар понад ліміт`** — у кого больше 150 предметов. Всё переедет, но
   пока такой игрок не разгрузится, дроп не подбирается и отмена лота падает.

## 4. Репетиция вторая — настоящая запись в запасную базу

Тот же кластер, отдельная база. Проверяет то, чего `--dry` не проверяет
вообще: ограничения, внешние ключи, типы, скорость и — главное — сходимость
денег.

Создать (владелец, `doadmin`; `psql` с тем же `ADMIN_URL`, что в `migrate-now.sh`):

```sql
CREATE DATABASE liberty_rehearsal;
```

Применить схему и прогнать перенос на неё:

```bash
cd /srv/liberty/next && set -a && . /srv/liberty/env && set +a
ADMIN_URL='postgresql://doadmin:ПАРОЛЬ@private-liberty-db-do-user-42796403-0.m.db.ondigitalocean.com:25060/liberty_rehearsal?sslmode=require' \
  bash server/db/migrate.sh

REHEARSAL="${DATABASE_URL%/liberty*}/liberty_rehearsal?sslmode=require"
DATABASE_URL="$REHEARSAL" node dev/etl.js 2>&1 | tee /srv/liberty/etl-rehearsal.log
```

**Что проверить между репетицией и окном:**

```bash
# Детектор трансформа: синтетические документы старой формы через migratePlayer.
DATABASE_URL="$REHEARSAL" node dev/etl-check.js

# Деньги: у каждого перенесённого баланса есть ровно один открывающий запись.
DATABASE_URL="$REHEARSAL" node dev/money-check.js
```

И руками, по запасной базе:

```sql
-- Сходимость. ДОЛЖНО быть пусто. Непустой ответ = кто-то без открывающей
-- записи в леджере, и ночная сверка будет звенеть про него вечно.
SELECT b.player_id, b.currency, b.amount,
       COALESCE(sum(l.delta), 0) AS ledger
  FROM balances b LEFT JOIN ledger l
    ON l.player_id=b.player_id AND l.currency=b.currency
 GROUP BY b.player_id, b.currency, b.amount
HAVING b.amount <> COALESCE(sum(l.delta), 0);

-- Каждая открывающая запись помечена и одна на (игрок, валюта).
SELECT reason, count(*) FROM ledger GROUP BY reason;
SELECT count(*) FROM (SELECT player_id, currency FROM ledger
   WHERE reason='migration_opening' GROUP BY 1,2 HAVING count(*)>1) d;

-- Предметы. Второй запрос — вещи в активных лотах: player_id NULL и на них
-- ссылается лот. Бесхозных без лота быть не должно ни одной.
SELECT container, count(*) FROM player_items GROUP BY container;
SELECT count(*) FROM player_items pi WHERE pi.player_id IS NULL
   AND NOT EXISTS (SELECT 1 FROM market_listings m WHERE m.item_id = pi.id);

-- Заточка: максимум не выше ENHANCE_MAX, и +N действительно доехали.
SELECT max(enhance) FROM player_items;           -- <= 15
SELECT enhance, count(*) FROM player_items WHERE enhance > 0 GROUP BY 1 ORDER BY 1;

-- Стеки: одна строка с qty 20, а не двадцать строк.
SELECT item_id, qty FROM player_items WHERE qty > 1 ORDER BY qty DESC LIMIT 20;

-- Отметки о полученных наградах спецквестов доехали.
SELECT count(*) FROM player_special_quests;
```

Записать **время** прогона — это длина окна, которую нужно объявить игрокам.

Затем повторить `node dev/etl.js` на той же запасной базе **второй раз** и
убедиться, что ничего не удвоилось:

```sql
SELECT count(*) FROM players;          -- не изменилось
SELECT count(*) FROM player_items;     -- не изменилось
SELECT count(*) FROM market_listings;  -- не изменилось
SELECT count(*) FROM gram_tx;          -- не изменилось
SELECT count(*) FROM special_quests;   -- не изменилось
```

Это и есть проверка обещания «повторный прогон ничего не меняет». Если хоть
одно число выросло — в окно не идём.

Убрать за собой: `DROP DATABASE liberty_rehearsal;`

## 5. Окно

```bash
ssh -i ~/.ssh/liberty_do root@178.128.136.68
```

1. Предупредить игроков.
2. **Остановить старую сборку.** Пока она жива, игроки продолжают писать в
   Mongo, и всё, что они сделают после начала переноса, не переедет.
3. Снять свежий дамп Mongo (путь B) или убедиться, что источник больше не
   принимает записи (путь A). Дамп — это то, к чему можно вернуться.
4. Ещё раз убедиться, что `SELECT count(*) FROM players` даёт то же, что и в
   шаге 2. Если выросло — кто-то зашёл в новую сборку; вернуться к шагу 2.
5. Перенос:

```bash
cd /srv/liberty/next && set -a && . /srv/liberty/env && set +a
node dev/etl.js 2>&1 | tee /srv/liberty/etl-real-$(date +%F-%H%M).log
```

6. Прочитать отчёт целиком. Строки `✗` — это аккаунты, **не переехавшие
   совсем**. Их должно быть ноль. Каждая такая строка называет `telegram_id`:
   разобраться и перезапустить `node dev/etl.js` — уже переехавшие пропустятся,
   упавшие пойдут заново.
7. Прогнать те же запросы из шага 4, теперь по боевой базе.
8. Поднять новую сборку:

```bash
systemctl restart liberty-next
curl -s https://libertymmorpg.online/health
```

## Точка невозврата

**Первый игрок, вошедший в новую сборку.**

До неё всё дёшево: `wipe-game-data.js`, и перенос запускается снова с любого
места. После неё — нет: игрок уже что-то убил, купил и продал, и это записано
только в PostgreSQL. Откат на Mongo с этого момента стирает всё, что было
сделано после переключения, у всех.

Отсюда порядок в шаге 5: сначала перенос и **все** проверки, и только потом
`systemctl restart liberty-next`. Между ними можно стоять сколько угодно.

## Как отменить

**Пока новая сборка не поднята** (то есть до точки невозврата):

```bash
cd /srv/liberty/next && set -a && . /srv/liberty/env && set +a
WIPE_CONFIRM=liberty node dev/wipe-game-data.js --yes
```

Затем поднять старую сборку обратно на Mongo. Ничего не потеряно: Mongo не
менялась переносом ни одним байтом — `dev/etl.js` только читает её.

**После точки невозврата** отмены нет. Есть только починка вперёд: найти, что
именно не доехало, и дописать это отдельным скриптом по дампу Mongo, который
для этого и снимался в шаге 5.

## Чего перенос НЕ переносит

Знать заранее, чтобы не искать потом:

| | |
|---|---|
| дневные попытки | `fearAttempts`/`coopAttempts`/`arena3Attempts`/`race10Attempts`/`farm2Minutes` — все получат полный запас в день переключения |
| история рынка | переезжают только **активные** лоты; проданные и отменённые — нет |
| история GRAM | переезжают только **pending withdraw**; депозиты и закрытые заявки — нет |
| заявки в кланы | `applications` |
| выдачи в кланах | `allocations` — осколки, выданные лидером и не забранные |
| чаты и PvP-история | глобальный чат, клановый чат, личные сообщения, `pvp_history` |
| состояние мира | `boss_state`, `guild_war_state` — восстановятся сами |
| `player_logs` | диагностический журнал старой сборки |

Кланы без выдач — это единственная строка отсюда, которую игрок заметит как
**потерю вещей**: невыбранная выдача исчезает. Если такие есть, их видно
заранее:

```javascript
// по Mongo, до окна
db.clans.aggregate([{$unwind:'$allocations'},
  {$project:{name:1, tg:'$allocations.telegramId', id:'$allocations.id', qty:'$allocations.qty'}}])
```

Раздать их старой сборкой до окна — дешевле, чем объяснять после.
