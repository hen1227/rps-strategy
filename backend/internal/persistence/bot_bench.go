package persistence

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
)

// Where the scheduled bot benches are kept between restarts.
//
// The enforcement, and the whole argument for why a bench is a window rather
// than a switch, is in server/bot_bench.go. This is the half that survives a
// deploy: a list of windows, and a ledger of which of them the binary put there
// itself.
//
// # Why a ledger of seeds
//
// A window that ships with the binary — the tournament somebody wrote into the
// source last week — has to appear on a server that has never heard of it, or
// the feature depends on a person remembering to type it in on the morning. So
// the binary seeds them at boot.
//
// A plain `INSERT OR IGNORE` keyed on the window's id would do that, and would
// also undo every deletion: a host who calls off a bench because the event was
// postponed finds it back after the next deploy, silently, with nothing on
// screen to say why. Hence `bot_bench_seeds` — a row per seed key, written when
// the seed is first applied and never removed. The question it answers is "has
// this binary's window ever been offered", which is different from "is it in
// the schedule now", and only the first one may decide whether to insert.

// BotBenchWindow is one stretch of time in which no engine takes a new game.
//
// The instants are milliseconds since the epoch — exact moments, for the reason
// server/bot_bench.go gives at length: a wall clock plus a location needs the
// zoneinfo database on the host and is an hour wrong when it guesses. UntilLabel
// carries the human half separately, and is the only part that knows what a
// timezone is.
type BotBenchWindow struct {
	ID     string `json:"id"`
	Reason string `json:"reason"`
	// UntilLabel is when it ends, written in the timezone the event was
	// announced in, because "20:00 UTC" is not how somebody told "10 AM
	// Eastern" is holding the day in their head.
	UntilLabel  string `json:"untilLabel"`
	FromUnixMs  int64  `json:"fromUnixMs"`
	UntilUnixMs int64  `json:"untilUnixMs"`
	// CreatedAtUnixMs and CreatedBy are the audit half: who scheduled this and
	// when. CreatedBy is a user id, or empty for a window the binary seeded.
	CreatedAtUnixMs int64  `json:"createdAtUnixMs"`
	CreatedBy       string `json:"createdBy,omitempty"`
}

// ensureBotBenchSchema creates the schedule and the seed ledger.
func (store *Store) ensureBotBenchSchema(ctx context.Context) error {
	const schema = `
CREATE TABLE IF NOT EXISTS bot_bench_windows (
    id TEXT PRIMARY KEY,
    reason TEXT NOT NULL,
    until_label TEXT NOT NULL,
    from_unix_ms INTEGER NOT NULL,
    until_unix_ms INTEGER NOT NULL,
    created_at_unix_ms INTEGER NOT NULL,
    created_by TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS bot_bench_windows_from_idx
    ON bot_bench_windows(from_unix_ms);

CREATE TABLE IF NOT EXISTS bot_bench_seeds (
    seed_key TEXT PRIMARY KEY,
    applied_at_unix_ms INTEGER NOT NULL
);
`
	if _, err := store.db.ExecContext(ctx, schema); err != nil {
		return fmt.Errorf("migrate bot bench schema: %w", err)
	}
	return nil
}

// ErrInvalidBotBenchWindow is a window that describes no stretch of time.
var ErrInvalidBotBenchWindow = errors.New("invalid bot bench window")

// validBotBenchWindow rejects the two shapes that would read as a bench and
// never be one: no reason to show a player, and an end at or before the start.
//
// Checked here rather than only at the route because the seeds go in through
// this file too, and a typo in a compiled-in date is exactly the mistake nobody
// finds until the afternoon it matters.
func validBotBenchWindow(window BotBenchWindow) error {
	if strings.TrimSpace(window.Reason) == "" {
		return fmt.Errorf("%w: a reason is required", ErrInvalidBotBenchWindow)
	}
	if window.UntilUnixMs <= window.FromUnixMs {
		return fmt.Errorf("%w: it ends before it starts", ErrInvalidBotBenchWindow)
	}
	return nil
}

// BotBenchWindows is the whole schedule, earliest first.
//
// Past windows included. They cost nothing to carry, they are the record of
// what happened, and the host's screen is the only place anybody would ever go
// looking for "was the ladder actually off that afternoon".
func (store *Store) BotBenchWindows(ctx context.Context) ([]BotBenchWindow, error) {
	rows, err := store.db.QueryContext(ctx, `
SELECT id, reason, until_label, from_unix_ms, until_unix_ms, created_at_unix_ms, created_by
FROM bot_bench_windows
ORDER BY from_unix_ms, id
`)
	if err != nil {
		return nil, fmt.Errorf("read bot bench windows: %w", err)
	}
	defer rows.Close()

	windows := make([]BotBenchWindow, 0, 8)
	for rows.Next() {
		var window BotBenchWindow
		if err := rows.Scan(
			&window.ID,
			&window.Reason,
			&window.UntilLabel,
			&window.FromUnixMs,
			&window.UntilUnixMs,
			&window.CreatedAtUnixMs,
			&window.CreatedBy,
		); err != nil {
			return nil, fmt.Errorf("read bot bench window: %w", err)
		}
		windows = append(windows, window)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("read bot bench windows: %w", err)
	}
	return windows, nil
}

// AddBotBenchWindow schedules one.
func (store *Store) AddBotBenchWindow(ctx context.Context, window BotBenchWindow) error {
	if err := validBotBenchWindow(window); err != nil {
		return err
	}
	if _, err := store.db.ExecContext(ctx, `
INSERT INTO bot_bench_windows
    (id, reason, until_label, from_unix_ms, until_unix_ms, created_at_unix_ms, created_by)
VALUES (?, ?, ?, ?, ?, ?, ?)
`,
		window.ID,
		strings.TrimSpace(window.Reason),
		strings.TrimSpace(window.UntilLabel),
		window.FromUnixMs,
		window.UntilUnixMs,
		window.CreatedAtUnixMs,
		window.CreatedBy,
	); err != nil {
		return fmt.Errorf("add bot bench window: %w", err)
	}
	return nil
}

// DeleteBotBenchWindow removes one, and reports whether there was one to remove.
//
// Deletion rather than an "cancelled" flag, and the seed ledger above is what
// makes that safe: the record of a *seeded* window having been offered survives
// independently, so cancelling one is not a thing a restart can undo.
func (store *Store) DeleteBotBenchWindow(ctx context.Context, id string) (bool, error) {
	result, err := store.db.ExecContext(ctx,
		"DELETE FROM bot_bench_windows WHERE id = ?", id,
	)
	if err != nil {
		return false, fmt.Errorf("delete bot bench window: %w", err)
	}
	removed, err := result.RowsAffected()
	if err != nil {
		return false, fmt.Errorf("delete bot bench window: %w", err)
	}
	return removed > 0, nil
}

// SeedBotBenchWindow schedules a window the binary carries, once ever.
//
// Reports whether it inserted. The seed key is the memory: a key already in the
// ledger means this window has had its turn, whether it is still in the
// schedule or a host deleted it, and either way the answer is to do nothing.
func (store *Store) SeedBotBenchWindow(
	ctx context.Context,
	seedKey string,
	window BotBenchWindow,
	now int64,
) (bool, error) {
	if strings.TrimSpace(seedKey) == "" {
		return false, fmt.Errorf("%w: a seed key is required", ErrInvalidBotBenchWindow)
	}
	if err := validBotBenchWindow(window); err != nil {
		return false, err
	}

	transaction, err := store.db.BeginTx(ctx, nil)
	if err != nil {
		return false, fmt.Errorf("seed bot bench window: %w", err)
	}
	defer func() { _ = transaction.Rollback() }()

	var appliedAt int64
	err = transaction.QueryRowContext(ctx,
		"SELECT applied_at_unix_ms FROM bot_bench_seeds WHERE seed_key = ?", seedKey,
	).Scan(&appliedAt)
	if err == nil {
		return false, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return false, fmt.Errorf("seed bot bench window: %w", err)
	}

	if _, err := transaction.ExecContext(ctx, `
INSERT INTO bot_bench_windows
    (id, reason, until_label, from_unix_ms, until_unix_ms, created_at_unix_ms, created_by)
VALUES (?, ?, ?, ?, ?, ?, '')
`,
		window.ID,
		strings.TrimSpace(window.Reason),
		strings.TrimSpace(window.UntilLabel),
		window.FromUnixMs,
		window.UntilUnixMs,
		now,
	); err != nil {
		return false, fmt.Errorf("seed bot bench window: %w", err)
	}
	if _, err := transaction.ExecContext(ctx,
		"INSERT INTO bot_bench_seeds (seed_key, applied_at_unix_ms) VALUES (?, ?)",
		seedKey, now,
	); err != nil {
		return false, fmt.Errorf("seed bot bench window: %w", err)
	}
	if err := transaction.Commit(); err != nil {
		return false, fmt.Errorf("seed bot bench window: %w", err)
	}
	return true, nil
}
