-- ═══════════════════════════════════════════════════════════════════════════
--  005_withdraw_states — the three ways a withdrawal ends
-- ═══════════════════════════════════════════════════════════════════════════
-- A withdrawal deducts the GRAM the moment the request is created, so how it
-- ends decides where that money goes. There are three outcomes and they are
-- genuinely different, which is why 'rejected' alone was not enough:
--
--   confirmed  — Исполнено. The admin sent the TON. Money left the system.
--   rejected   — Отменено (вернуть). The payout did not happen and the GRAM
--                goes BACK to the player.
--   forfeited  — Отменено (забрать). The payout did not happen and the GRAM
--                does NOT go back — a fraudulent request, a chargeback, an
--                account being closed out.
--
-- Collapsing the last two into one status would mean the refund decision lives
-- only in whoever pressed the button, and "was this refunded?" would have no
-- answer in the data.
ALTER TYPE gram_tx_status_t ADD VALUE IF NOT EXISTS 'forfeited';

-- The ops message this request is shown in. Stored so a decision made from the
-- admin panel can EDIT the same Telegram message rather than leaving a stale
-- card with live buttons sitting in the group — the shape that gets pressed
-- twice by a second admin who did not see the panel.
--
-- gram_tx already has admin_msg_id from 002; this records which topic it went
-- to, because editMessageText needs the chat and the message, and a group with
-- forum topics can hold several conversations that look alike.
ALTER TABLE gram_tx ADD COLUMN ops_chat_id text;

-- Free-text note an admin can attach when cancelling, shown to nobody but the
-- other admins. Bounded: it is typed into a Telegram reply and ends up in an
-- HTML message.
ALTER TABLE gram_tx ADD COLUMN admin_note text CHECK (admin_note IS NULL OR length(admin_note) <= 300);
