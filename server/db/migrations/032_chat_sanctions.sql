-- ── Модерация общего чата: мут и бан на время ───────────────────────────────
--
-- server/chat-mod.js держит санкции в памяти и дублирует сюда, чтобы они
-- переживали перезапуск. Одна строка на игрока: новая санкция заменяет
-- старую. Ключ — telegram_id, как и у ролей (модераторы/админы задаются
-- telegram id), а не players.id.
CREATE TABLE chat_sanctions (
  telegram_id  text PRIMARY KEY,
  kind         text NOT NULL CHECK (kind IN ('mute', 'ban')),
  until        timestamptz NOT NULL,
  by_username  text NOT NULL DEFAULT '',
  created_at   timestamptz NOT NULL DEFAULT now()
);
