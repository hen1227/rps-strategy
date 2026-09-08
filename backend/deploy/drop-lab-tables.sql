-- Retire the RPS Lab's storage.
--
-- The schema has no migration tool and no version table: Store.initialize runs
-- idempotent CREATE TABLE IF NOT EXISTS blocks, and the two that made these
-- tables (ensureLabSchema, ensureLabArtSchema) are gone. So a fresh database
-- never creates them and an existing one simply keeps them, orphaned. This
-- script is only for tidying an existing database — nothing reads these tables
-- any more, and leaving them costs a few kilobytes and zero risk.
--
--   THIS IS DESTRUCTIVE AND THERE IS NO MIGRATION BACK.
--
-- Deleting the custom:% rows removes archived games that people may still hold
-- links to. That is the accepted cost of splitting GamesLab out of RPS, but it
-- should be a deliberate keystroke.
--
-- Run it like this, never against the live file:
--
--   systemctl stop rps-strategy          # a running server holds the file open
--   cp rps-strategy.sqlite rps-strategy.sqlite.before-lab-removal
--   sqlite3 rps-strategy.sqlite < deploy/drop-lab-tables.sql
--
-- The dev database at backend/data/rps-strategy.sqlite has none of these tables
-- and no custom:% rows, so there this is a no-op.

.headers on
.mode column

-- Read this before the deletes below run. If the numbers are not what you
-- expected, stop and press Ctrl-C: nothing has been changed yet.
SELECT 'game_pgn'             AS table_name, count(*) AS custom_rows FROM game_pgn             WHERE mode_id LIKE 'custom:%'
UNION ALL
SELECT 'game_history',              count(*) FROM game_history         WHERE mode_id LIKE 'custom:%'
UNION ALL
SELECT 'account_mode_ratings',      count(*) FROM account_mode_ratings WHERE mode_id LIKE 'custom:%';

BEGIN;

-- Order matters: foreign_keys is ON and lab_art_pins holds an
-- ON DELETE RESTRICT reference to lab_art, so the pins go first.
DROP TABLE IF EXISTS lab_art_pins;
DROP TABLE IF EXISTS lab_art;
DROP TABLE IF EXISTS lab_art_reports;
DROP TABLE IF EXISTS custom_modes;
DROP TABLE IF EXISTS rule_parts;
DROP TABLE IF EXISTS lab_drafts;

-- The three shared tables can hold a published mode's id. Left in place they
-- would mean: an account still reports ratings in modes that no longer exist,
-- refitAllBotLaddersTx (which runs on every persistence.Open) keeps refitting
-- ladders for them, and GET /api/leaderboard?mode=custom:… answers 400 rather
-- than the rows that are still there.
DELETE FROM game_pgn             WHERE mode_id LIKE 'custom:%';
DELETE FROM game_history         WHERE mode_id LIKE 'custom:%';
DELETE FROM account_mode_ratings WHERE mode_id LIKE 'custom:%';

COMMIT;

-- Expect three zeros.
SELECT 'game_pgn'             AS table_name, count(*) AS custom_rows FROM game_pgn             WHERE mode_id LIKE 'custom:%'
UNION ALL
SELECT 'game_history',              count(*) FROM game_history         WHERE mode_id LIKE 'custom:%'
UNION ALL
SELECT 'account_mode_ratings',      count(*) FROM account_mode_ratings WHERE mode_id LIKE 'custom:%';

VACUUM;
