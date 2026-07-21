-- 035 — Intelligence upgrades:
--  - rolling conversation summary per session (context beyond the 20-turn window)
--  - structured tool results retained per assistant message ("chart that" works
--    on prior SQL results)

ALTER TABLE agent_chat_sessions ADD COLUMN IF NOT EXISTS summary TEXT;
ALTER TABLE agent_chat_sessions ADD COLUMN IF NOT EXISTS summary_thru_message_id INTEGER;

ALTER TABLE agent_chat_messages ADD COLUMN IF NOT EXISTS structured_results JSONB;
