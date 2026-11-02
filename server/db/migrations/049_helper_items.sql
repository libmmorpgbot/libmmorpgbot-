-- ── Помощники становятся предметами ────────────────────────────────────────
--
-- До этой миграции помощник был строкой player_helpers (048): свой уровень,
-- опыт и флаг «летает рядом». Теперь он — обычный предмет player_items со
-- слотом 'helper': лежит в сумке, надевается в свой слот и продаётся на
-- рынке (HELPER_ITEMS, shared/definitions.js).
--
-- Уровень и опыт — колонки САМОЙ строки, по тому же приёму, что содержимое
-- руны (029): строка при продаже не пересоздаётся, а отцепляется от
-- продавца и прицепляется к покупателю, и уровень едет вместе с ней. Не
-- `enhance`: у заточки свой смысл, свой потолок (15) и свои правила по всей
-- кодовой базе. У всех предметов, кроме помощников, обе колонки — NULL.
ALTER TABLE player_items ADD COLUMN IF NOT EXISTS hl_level smallint
  CHECK (hl_level IS NULL OR hl_level BETWEEN 1 AND 30);
ALTER TABLE player_items ADD COLUMN IF NOT EXISTS hl_xp integer
  CHECK (hl_xp IS NULL OR hl_xp >= 0);

-- Каталог. Приложение само синхронизирует item_catalog при старте
-- (items.syncCatalog), но миграция идёт ДО перезапуска, а перенос ниже
-- упирается во внешний ключ player_items.item_id → item_catalog. Поэтому
-- девятнадцать строк — здесь же; при старте syncCatalog их просто
-- перепишет теми же значениями.
INSERT INTO item_catalog (item_id, slot, stackable, enhanceable, rarity, name) VALUES
  ('hl_firefly', 'helper', false, false, 'common', 'Светлячок'),
  ('hl_sprout', 'helper', false, false, 'common', 'Росток'),
  ('hl_spark', 'helper', false, false, 'common', 'Искорка'),
  ('hl_pebble', 'helper', false, false, 'common', 'Камешек'),
  ('hl_breeze', 'helper', false, false, 'common', 'Ветерок'),
  ('hl_moth', 'helper', false, false, 'uncommon', 'Лунный мотылёк'),
  ('hl_bubble', 'helper', false, false, 'uncommon', 'Пузырёк'),
  ('hl_ember', 'helper', false, false, 'uncommon', 'Уголёк'),
  ('hl_leaf', 'helper', false, false, 'uncommon', 'Листочек'),
  ('hl_coin', 'helper', false, false, 'uncommon', 'Монетка'),
  ('hl_frost', 'helper', false, false, 'rare', 'Морозная фея'),
  ('hl_storm', 'helper', false, false, 'rare', 'Грозовой дух'),
  ('hl_crystal', 'helper', false, false, 'rare', 'Кристаллик'),
  ('hl_phoenix', 'helper', false, false, 'epic', 'Феникс'),
  ('hl_void', 'helper', false, false, 'epic', 'Дух бездны'),
  ('hl_wisp', 'helper', false, false, 'epic', 'Изумрудный эльф'),
  ('hl_dragon', 'helper', false, false, 'legendary', 'Звёздный дракончик'),
  ('hl_seraph', 'helper', false, false, 'legendary', 'Серафим'),
  ('hl_kitsune', 'helper', false, false, 'legendary', 'Небесная кицунэ')
ON CONFLICT (item_id) DO NOTHING;

-- ── перенос ─────────────────────────────────────────────────────────────────
-- Только если таблица 048 есть (на свежей базе её создаёт сама 048, но
-- миграция обязана пройти и там, где 048 когда-то откатили руками).
--
-- Каждый помощник игрока — одна строка предмета с его уровнем и опытом.
-- Тот, что летал рядом (active), — сразу в слот 'helper' экипировки, иначе
-- в сумку. Каждой строке — запись в item_ledger (+1), иначе ночная сверка
-- (items.reconcile) увидела бы предметы, которых журнал не знает, и
-- подняла бы тревогу на каждого игрока с помощником.
--
-- Строки player_helpers не удаляются: таблица остаётся как была, на случай
-- разбора; код её больше не читает и не пишет.
DO $$
BEGIN
  IF to_regclass('player_helpers') IS NULL THEN RETURN; END IF;

  CREATE TEMP TABLE _hl_moved ON COMMIT DROP AS
  WITH ins AS (
    INSERT INTO player_items (player_id, container, slot, item_id, enhance, qty, hl_level, hl_xp)
    SELECT h.player_id,
           CASE WHEN h.active THEN 'equipment' ELSE 'inventory' END::item_container_t,
           CASE WHEN h.active THEN 'helper' END,
           h.helper_id, 0, 1,
           LEAST(GREATEST(h.level, 1), 30), GREATEST(h.xp, 0)
      FROM player_helpers h
      JOIN item_catalog c ON c.item_id = h.helper_id
     -- Повторный прогон (если кто-то перезапустит файл руками) не должен
     -- задвоить: помощник, уже лежащий предметом у того же игрока, не
     -- переносится второй раз.
     WHERE NOT EXISTS (SELECT 1 FROM player_items p
                        WHERE p.player_id = h.player_id AND p.item_id = h.helper_id
                          AND p.hl_level IS NOT NULL)
    RETURNING id, player_id, item_id
  )
  SELECT * FROM ins;

  IF to_regclass('item_ledger') IS NOT NULL THEN
    INSERT INTO item_ledger (player_id, row_id, item_id, delta, qty_after, reason, ref_type)
    SELECT player_id, id, item_id, 1, 1, 'helper_migrate', 'helper'
      FROM _hl_moved;
  END IF;
END $$;

COMMENT ON COLUMN player_items.hl_level IS
  'Уровень помощника (slot = helper), 1..30; NULL у всех остальных предметов';
COMMENT ON COLUMN player_items.hl_xp IS
  'Опыт помощника на текущем уровне; NULL у всех остальных предметов';
