-- Drop the attention_items table and its status enum.
--
-- Every attention signal is DERIVED at read time from the forecast bundle
-- (`attention-rules.ts`): it exists exactly while its condition holds and
-- disappears when the condition clears, with no write to keep in step. The table
-- existed for the two things that cannot be recomputed — a hand-flagged item and
-- a "don't show me this again" tombstone — and neither was ever used: the table
-- held ZERO rows in production, and no client ever called the endpoints that
-- wrote to it.
--
-- Keeping it meant every reader had to merge a stored set that was always empty,
-- and every new signal had to answer "store or derive?" when the answer was
-- always derive. See backend memory/attention-items.md.
--
-- What is NOT dropped:
--   * `AttentionLevel` — still used by `cashflow_events.attention_level`.
--   * `RelatedObjectType` — still used by the derived signals' payload.
--   * `snapshots.attention_count` — older snapshots keep their frozen value;
--     new ones write 0. Dropping it would rewrite history that was true when
--     taken.
--
-- Data loss: none. The table is empty.
DROP TABLE IF EXISTS "attention_items";

DROP TYPE IF EXISTS "AttentionItemStatus";
