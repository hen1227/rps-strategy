package persistence

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
)

// How long an engine has been top of a mode, and who used to be.
//
// Two questions a bot author asked for, which turn out to be one record:
// "how long has this engine held first place" is the current reign's age, and
// "did this engine ever hold it" is whether there is any reign at all. Keeping
// a ledger of reigns answers both, and answers them about every engine rather
// than only the one in front.
//
// # Why this is not a title
//
// bot_titles.go argues that an engine's tags are a reflection rather than a
// collection: SyncBotTitles works out what is true now and deletes what has
// lapsed, because a superlative kept after it stops being true is a lie on
// somebody's name. That argument is right and it is the reason this is a
// separate record. "Top of V6" is a claim about the present and belongs in a
// tag; "was top of V6 for eleven days last spring" is a claim about the past,
// is still true, and belongs here. Only one tag is worn at a time in any case,
// so a historical mark could not have shared the slot with RC.
//
// # Why a reign is confirmed rather than observed
//
// A bot rating is the whole record solved again rather than a running total,
// and evidence decays on a clock — so the leader of a mode can change with no
// game played by anybody, and a refit can swap two engines that are a point
// apart. Writing a reign the first time a new name appears on top would
// manufacture reigns out of arithmetic noise and make "days at number one"
// read as the interval between refits.
//
// So a change of leader has to be seen twice in a row before it is written,
// and the reign is then dated from the *first* of the two sightings rather
// than from the confirmation. The candidate between those two sweeps lives in
// bot_reign_watch, one row per mode.

// ensureBotReignSchema creates the ledger and the watch.
//
// ended_at_unix_ms is NULL for the reign in progress rather than zero, so
// "who is top of this mode now" is an index lookup rather than a sort, and so
// a partial index can hold the one-current-reign-per-mode rule instead of the
// sweep having to remember it.
func (store *Store) ensureBotReignSchema(ctx context.Context) error {
	const schema = `
CREATE TABLE IF NOT EXISTS bot_reigns (
    user_id TEXT NOT NULL REFERENCES accounts(user_id) ON DELETE CASCADE,
    mode_id TEXT NOT NULL,
    started_at_unix_ms INTEGER NOT NULL,
    ended_at_unix_ms INTEGER,
    PRIMARY KEY (user_id, mode_id, started_at_unix_ms)
);

CREATE UNIQUE INDEX IF NOT EXISTS bot_reigns_current_idx
    ON bot_reigns(mode_id) WHERE ended_at_unix_ms IS NULL;

CREATE INDEX IF NOT EXISTS bot_reigns_engine_idx
    ON bot_reigns(user_id, started_at_unix_ms DESC);

CREATE TABLE IF NOT EXISTS bot_reign_watch (
    mode_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    seen_at_unix_ms INTEGER NOT NULL
);
`
	if _, err := store.db.ExecContext(ctx, schema); err != nil {
		return fmt.Errorf("migrate bot reign schema: %w", err)
	}
	return nil
}

// BotReign is one spell at the top of one mode.
type BotReign struct {
	UserID string `json:"userId"`
	ModeID string `json:"modeId"`
	// StartedAtUnixMs is when the board first showed this engine in front, not
	// when that was confirmed. See the note above about the two sightings.
	StartedAtUnixMs int64 `json:"startedAtUnixMs"`
	// EndedAtUnixMs is zero while the reign is the current one, which is what
	// Current reports. A caller that wants "how long" reads it against now.
	EndedAtUnixMs int64 `json:"endedAtUnixMs,omitempty"`
	Current       bool  `json:"current"`
}

// SyncBotReigns brings the ledger into line with the board and reports the
// modes whose leader changed.
//
// Whole-fleet in one pass, like SyncBotTitles and for the same reason: a reign
// ending is another engine's reign beginning, so a sweep that looked at one
// mode's leader would have nothing to close the old reign against.
//
// Returns the modes where a reign actually changed hands, which is the half a
// caller wants to log — a reign continuing is the usual answer and says
// nothing.
func (store *Store) SyncBotReigns(
	ctx context.Context,
	now int64,
) (map[string]BotReign, error) {
	leaders, err := store.modeBoardLeaders(ctx)
	if err != nil {
		return nil, err
	}
	watch, err := store.botReignWatch(ctx)
	if err != nil {
		return nil, err
	}
	current, err := store.currentBotReigns(ctx)
	if err != nil {
		return nil, err
	}

	// Every mode the board or the ledger has an opinion about. A mode that has
	// dropped off the board entirely still has to be visited, or the reign it
	// left behind would stay open for ever and read as still running.
	modes := make(map[string]struct{}, len(leaders)+len(current))
	for modeID := range leaders {
		modes[modeID] = struct{}{}
	}
	for modeID := range current {
		modes[modeID] = struct{}{}
	}

	changed := make(map[string]BotReign)
	for modeID := range modes {
		entry, hasLeader := leaders[modeID]
		leader := entry.UserID
		reigning, hasReign := current[modeID]

		// The board still says what the ledger says. Nothing to confirm and
		// nothing to write; clear any candidate, because a challenger that did
		// not last two sweeps did not happen.
		if hasLeader && hasReign && leader == reigning.UserID {
			if err := store.clearBotReignWatch(ctx, modeID); err != nil {
				return nil, err
			}
			continue
		}

		// Nobody qualifies on this mode any more — every engine dropped below
		// the games floor, or was disabled, or the mode was retired. The reign
		// ends: it stopped being true, and the ledger only claims the past.
		if !hasLeader {
			if hasReign {
				if err := store.endBotReign(ctx, modeID, now); err != nil {
					return nil, err
				}
				reigning.EndedAtUnixMs = now
				reigning.Current = false
				changed[modeID] = reigning
			}
			if err := store.clearBotReignWatch(ctx, modeID); err != nil {
				return nil, err
			}
			continue
		}

		// A new name is in front. Write it only if the last sweep saw the same
		// one, and date the reign from that sighting rather than from now.
		candidate, watched := watch[modeID]
		if !watched || candidate.UserID != leader {
			if err := store.setBotReignWatch(ctx, modeID, leader, now); err != nil {
				return nil, err
			}
			continue
		}

		if hasReign {
			if err := store.endBotReign(ctx, modeID, candidate.SeenAtUnixMs); err != nil {
				return nil, err
			}
		}
		reign := BotReign{
			UserID:          leader,
			ModeID:          modeID,
			StartedAtUnixMs: candidate.SeenAtUnixMs,
			Current:         true,
		}
		if err := store.openBotReign(ctx, reign); err != nil {
			return nil, err
		}
		if err := store.clearBotReignWatch(ctx, modeID); err != nil {
			return nil, err
		}
		changed[modeID] = reign
	}
	return changed, nil
}

// botReignCandidate is a leader seen once and not yet confirmed.
type botReignCandidate struct {
	UserID       string
	SeenAtUnixMs int64
}

func (store *Store) botReignWatch(
	ctx context.Context,
) (map[string]botReignCandidate, error) {
	rows, err := store.db.QueryContext(ctx,
		"SELECT mode_id, user_id, seen_at_unix_ms FROM bot_reign_watch",
	)
	if err != nil {
		return nil, fmt.Errorf("read bot reign watch: %w", err)
	}
	defer rows.Close()

	watch := make(map[string]botReignCandidate)
	for rows.Next() {
		var modeID string
		var candidate botReignCandidate
		if err := rows.Scan(
			&modeID, &candidate.UserID, &candidate.SeenAtUnixMs,
		); err != nil {
			return nil, fmt.Errorf("read bot reign watch: %w", err)
		}
		watch[modeID] = candidate
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("read bot reign watch: %w", err)
	}
	return watch, nil
}

func (store *Store) setBotReignWatch(
	ctx context.Context,
	modeID string,
	userID string,
	now int64,
) error {
	if _, err := store.db.ExecContext(ctx, `
INSERT INTO bot_reign_watch (mode_id, user_id, seen_at_unix_ms)
VALUES (?, ?, ?)
ON CONFLICT(mode_id) DO UPDATE SET user_id = excluded.user_id,
                                   seen_at_unix_ms = excluded.seen_at_unix_ms
`, modeID, userID, now); err != nil {
		return fmt.Errorf("watch bot reign: %w", err)
	}
	return nil
}

func (store *Store) clearBotReignWatch(ctx context.Context, modeID string) error {
	if _, err := store.db.ExecContext(ctx,
		"DELETE FROM bot_reign_watch WHERE mode_id = ?", modeID,
	); err != nil {
		return fmt.Errorf("clear bot reign watch: %w", err)
	}
	return nil
}

// currentBotReigns is the open reign of each mode, by mode id.
func (store *Store) currentBotReigns(
	ctx context.Context,
) (map[string]BotReign, error) {
	rows, err := store.db.QueryContext(ctx, `
SELECT user_id, mode_id, started_at_unix_ms
FROM bot_reigns WHERE ended_at_unix_ms IS NULL
`)
	if err != nil {
		return nil, fmt.Errorf("read current bot reigns: %w", err)
	}
	defer rows.Close()

	reigns := make(map[string]BotReign)
	for rows.Next() {
		reign := BotReign{Current: true}
		if err := rows.Scan(
			&reign.UserID, &reign.ModeID, &reign.StartedAtUnixMs,
		); err != nil {
			return nil, fmt.Errorf("read current bot reigns: %w", err)
		}
		reigns[reign.ModeID] = reign
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("read current bot reigns: %w", err)
	}
	return reigns, nil
}

func (store *Store) openBotReign(ctx context.Context, reign BotReign) error {
	// OR IGNORE so that a sweep re-run against the same millisecond — a retry,
	// or two ticks inside one clock granularity — leaves one reign rather than
	// failing. The unique index on the open reign is what makes that safe to
	// say: there cannot already be a different current reign here.
	if _, err := store.db.ExecContext(ctx, `
INSERT OR IGNORE INTO bot_reigns (user_id, mode_id, started_at_unix_ms, ended_at_unix_ms)
VALUES (?, ?, ?, NULL)
`, reign.UserID, reign.ModeID, reign.StartedAtUnixMs); err != nil {
		return fmt.Errorf("open bot reign: %w", err)
	}
	return nil
}

// endBotReign closes a mode's open reign.
//
// The end is clamped forward to the start, so a reign confirmed in the same
// sweep it began — possible when a mode's board empties immediately after a
// change of leader — cannot be recorded as ending before it started.
func (store *Store) endBotReign(ctx context.Context, modeID string, at int64) error {
	if _, err := store.db.ExecContext(ctx, `
UPDATE bot_reigns
SET ended_at_unix_ms = MAX(?, started_at_unix_ms)
WHERE mode_id = ? AND ended_at_unix_ms IS NULL
`, at, modeID); err != nil {
		return fmt.Errorf("end bot reign: %w", err)
	}
	return nil
}

// BotReigns is every spell one engine has had at the top, newest first.
//
// For the profile page, which draws them as a history. An engine that has never
// led comes back empty, which is the common answer and is not an error.
func (store *Store) BotReigns(
	ctx context.Context,
	userID string,
) ([]BotReign, error) {
	rows, err := store.db.QueryContext(ctx, `
SELECT user_id, mode_id, started_at_unix_ms, ended_at_unix_ms
FROM bot_reigns WHERE user_id = ?
ORDER BY started_at_unix_ms DESC
`, userID)
	if err != nil {
		return nil, fmt.Errorf("read bot reigns: %w", err)
	}
	defer rows.Close()

	reigns := make([]BotReign, 0, 4)
	for rows.Next() {
		var reign BotReign
		var ended sql.NullInt64
		if err := rows.Scan(
			&reign.UserID, &reign.ModeID, &reign.StartedAtUnixMs, &ended,
		); err != nil {
			return nil, fmt.Errorf("read bot reigns: %w", err)
		}
		reign.EndedAtUnixMs = ended.Int64
		reign.Current = !ended.Valid
		reigns = append(reigns, reign)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("read bot reigns: %w", err)
	}
	return reigns, nil
}

// annotateReigns fills in the reign fields of a page of the bot board.
//
// One query for the page rather than one per row, and in Go rather than as a
// join on the board itself: the board's query is already four nested selects
// deep and two more correlated subqueries would be paid by every row it then
// throws away for paging.
//
// A row is matched on its own mode, which is what makes this right on the
// combined board too — there an entry's ModeID is the mode that account is
// strongest in, and "leading since" has to mean the mode being reported rather
// than any mode at all.
func (store *Store) annotateReigns(ctx context.Context, entries []LeaderboardEntry) error {
	if len(entries) == 0 {
		return nil
	}
	placeholders := make([]string, 0, len(entries))
	arguments := make([]any, 0, len(entries))
	for _, entry := range entries {
		placeholders = append(placeholders, "?")
		arguments = append(arguments, entry.UserID)
	}

	query := fmt.Sprintf(`
SELECT user_id, mode_id, started_at_unix_ms, ended_at_unix_ms
FROM bot_reigns WHERE user_id IN (%s)
`, strings.Join(placeholders, ", "))

	rows, err := store.db.QueryContext(ctx, query, arguments...)
	if err != nil {
		return fmt.Errorf("read board reigns: %w", err)
	}
	defer rows.Close()

	held := make(map[string]bool, len(entries))
	// Keyed on both, because an engine can hold the top of one mode while
	// having lost it in another, and the row is about one of them.
	leading := make(map[[2]string]int64)
	for rows.Next() {
		var userID, modeID string
		var started int64
		var ended sql.NullInt64
		if err := rows.Scan(&userID, &modeID, &started, &ended); err != nil {
			return fmt.Errorf("read board reigns: %w", err)
		}
		held[userID] = true
		if !ended.Valid {
			leading[[2]string{userID, modeID}] = started
		}
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("read board reigns: %w", err)
	}

	for index := range entries {
		entry := &entries[index]
		entry.HeldTopSeat = held[entry.UserID]
		entry.LeadingSinceUnixMs = leading[[2]string{entry.UserID, entry.ModeID}]
	}
	return nil
}
