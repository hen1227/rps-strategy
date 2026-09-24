package persistence

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"

	"rps-strategy/backend/internal/game"
)

// Stored results for a bot-versus-bot series.
//
// The games themselves are ordinary games and live in the ordinary archive;
// what is here is the frame around them — which two engines, how many pairs,
// which opening seed, and the running tally. Keeping the frame separate is
// what lets a series be watched and reviewed through the machinery that
// already exists rather than a parallel one.

// BotSeriesStatus is where a run got to.
type BotSeriesStatus string

const (
	BotSeriesRunning   BotSeriesStatus = "running"
	BotSeriesCompleted BotSeriesStatus = "completed"
	BotSeriesAborted   BotSeriesStatus = "aborted"
)

// BotSeriesResult is one game's outcome, always from the first bot's point of
// view regardless of which colour it held. Storing it colour-relative would
// make the tally meaningless the moment the seats swap.
type BotSeriesResult string

const (
	BotSeriesPending   BotSeriesResult = "pending"
	BotSeriesFirstWin  BotSeriesResult = "first_win"
	BotSeriesSecondWin BotSeriesResult = "second_win"
	BotSeriesDraw      BotSeriesResult = "draw"
)

// ErrBotSeriesNotFound is returned for an unknown series id.
var ErrBotSeriesNotFound = errors.New("bot series not found")

// BotSeries is one run.
type BotSeries struct {
	SeriesID      string      `json:"seriesId"`
	ModeID        game.ModeID `json:"modeId"`
	FirstBotID    string      `json:"firstBotId"`
	SecondBotID   string      `json:"secondBotId"`
	FirstBotName  string      `json:"firstBotName,omitempty"`
	SecondBotName string      `json:"secondBotName,omitempty"`
	// The two engines' pictures, so a run can be drawn as the matchup it is
	// rather than as two names. Empty for a bot whose owner shipped no icon;
	// the client draws a monogram for those. See persistence.Bot.IconSHA256.
	FirstBotIcon  string `json:"firstBotIconSha256,omitempty"`
	SecondBotIcon string `json:"secondBotIconSha256,omitempty"`
	// The accounts the two engines play under, which is what a *rating* is
	// held against. A bot has two ids — the registry id its owner knows it by,
	// which is what this run is keyed on, and the account id every game record
	// and ladder row carries — and a page that wants to show the ladder's own
	// runs has to be able to join the two together.
	FirstBotUserID  string `json:"firstBotUserId,omitempty"`
	SecondBotUserID string `json:"secondBotUserId,omitempty"`
	// RequestedByUserID is whoever asked for the run, and RequestedByName is
	// their display name. Empty for a run started with the host token, which is
	// a secret rather than an account. Recorded because a run is no longer an
	// administrator's private act: anybody can start one, so a row on the
	// scoreboard has to be able to say who did, and an abort has to be able to
	// ask whether this caller is the one who started it.
	RequestedByUserID string          `json:"requestedByUserId,omitempty"`
	RequestedByName   string          `json:"requestedByName,omitempty"`
	Status            BotSeriesStatus `json:"status"`
	Pairs             int             `json:"pairs"`
	OpeningPlies      int             `json:"openingPlies"`
	// Seed is JSON-encoded as a string. It is a full 64-bit value, and a
	// JavaScript client parses a bare JSON number into a double — which silently
	// rounds anything past 2^53, so a seed rendered on the website was not the
	// seed that produced the run and could not be pasted back to reproduce it.
	Seed          int64           `json:"seed,string"`
	InitialTimeMs int64           `json:"initialTimeMs"`
	IncrementMs   int64           `json:"incrementMs"`
	FirstWins     int             `json:"firstWins"`
	SecondWins    int             `json:"secondWins"`
	Draws         int             `json:"draws"`
	Games         []BotSeriesGame `json:"games,omitempty"`
	CreatedAtMs   int64           `json:"createdAtUnixMs"`
	CompletedAtMs *int64          `json:"completedAtUnixMs,omitempty"`
	// Ladder is a run the ranked pool arranged, which is the only kind that
	// moves a rating. Stored on the row, because "who arranged this" is a fact
	// about the run and not something derivable from it afterwards.
	Ladder bool `json:"ladder"`
	// Casual is a run that does not move the ladder, which is every run except a
	// pool round — and a pool round between two engines one person registered,
	// which the fit drops however it was flagged (botHeadToHeadTx).
	//
	// Derived on every read rather than stored, which is what makes it right
	// about the runs played before the pool existed. Those games went down
	// `ranked = 1` and are not counted now, so the run did not move anything,
	// and "casual" is the true answer to the only question anybody asks of the
	// word here.
	Casual bool `json:"casual"`
}

// BotSeriesGame is one game of a run.
type BotSeriesGame struct {
	GameNumber  int             `json:"gameNumber"`
	PairNumber  int             `json:"pairNumber"`
	Swapped     bool            `json:"swapped"`
	GameID      string          `json:"gameId,omitempty"`
	OpeningLine string          `json:"openingLine,omitempty"`
	Result      BotSeriesResult `json:"result"`
	EndReason   string          `json:"endReason,omitempty"`
}

func (store *Store) ensureBotSeriesSchema(ctx context.Context) error {
	const schema = `
CREATE TABLE IF NOT EXISTS bot_series (
    series_id TEXT PRIMARY KEY,
    mode_id TEXT NOT NULL,
    first_bot_id TEXT NOT NULL REFERENCES bots(bot_id),
    second_bot_id TEXT NOT NULL REFERENCES bots(bot_id),
    status TEXT NOT NULL DEFAULT 'running'
        CHECK (status IN ('running', 'completed', 'aborted')),
    pairs INTEGER NOT NULL CHECK (pairs > 0),
    opening_plies INTEGER NOT NULL CHECK (opening_plies >= 0),
    seed INTEGER NOT NULL,
    initial_time_ms INTEGER NOT NULL,
    increment_ms INTEGER NOT NULL,
    first_wins INTEGER NOT NULL DEFAULT 0,
    second_wins INTEGER NOT NULL DEFAULT 0,
    draws INTEGER NOT NULL DEFAULT 0,
    -- No REFERENCES accounts(user_id), deliberately: ADD COLUMN cannot carry a
    -- foreign key onto an existing table with a non-null default, and a
    -- constraint that only holds on databases created after today is worse
    -- than one that holds nowhere. An anonymized account leaves the id behind
    -- and the join below simply finds no name, which is the right outcome.
    requested_by_user_id TEXT NOT NULL DEFAULT '',
    created_at_unix_ms INTEGER NOT NULL,
    completed_at_unix_ms INTEGER,
    CHECK (first_bot_id <> second_bot_id)
);

CREATE TABLE IF NOT EXISTS bot_series_games (
    series_id TEXT NOT NULL REFERENCES bot_series(series_id) ON DELETE CASCADE,
    game_number INTEGER NOT NULL CHECK (game_number > 0),
    pair_number INTEGER NOT NULL CHECK (pair_number > 0),
    swapped INTEGER NOT NULL CHECK (swapped IN (0, 1)),
    game_id TEXT,
    opening_line TEXT NOT NULL DEFAULT '',
    result TEXT NOT NULL DEFAULT 'pending',
    end_reason TEXT NOT NULL DEFAULT '',
    started_at_unix_ms INTEGER,
    finished_at_unix_ms INTEGER,
    PRIMARY KEY (series_id, game_number)
);

CREATE INDEX IF NOT EXISTS bot_series_status_idx
    ON bot_series(status, created_at_unix_ms DESC);
CREATE INDEX IF NOT EXISTS bot_series_games_game_idx
    ON bot_series_games(game_id);
`
	if _, err := store.db.ExecContext(ctx, schema); err != nil {
		return fmt.Errorf("migrate bot series schema: %w", err)
	}
	// CREATE TABLE IF NOT EXISTS does nothing to a table that already exists,
	// so a database from before series had a requester needs the column added.
	columns, err := tableColumns(ctx, store.db, "bot_series")
	if err != nil {
		return fmt.Errorf("inspect bot series schema: %w", err)
	}
	// The ranked pool arrives with the ladder column; a run recorded before it
	// existed was started by hand, which is exactly what a 0 here means.
	if !columns["ladder"] {
		if _, err := store.db.ExecContext(ctx,
			"ALTER TABLE bot_series ADD COLUMN ladder INTEGER NOT NULL DEFAULT 0"+
				" CHECK (ladder IN (0, 1))",
		); err != nil {
			return fmt.Errorf("add bot series ladder column: %w", err)
		}
	}
	if !columns["requested_by_user_id"] {
		if _, err := store.db.ExecContext(ctx,
			"ALTER TABLE bot_series ADD COLUMN requested_by_user_id TEXT NOT NULL DEFAULT ''",
		); err != nil {
			return fmt.Errorf("add bot series requester column: %w", err)
		}
	}
	return nil
}

// CreateBotSeries records a new run.
func (store *Store) CreateBotSeries(ctx context.Context, series BotSeries) (BotSeries, error) {
	now := time.Now().UnixMilli()
	if _, err := store.db.ExecContext(ctx, `
INSERT INTO bot_series (
    series_id, mode_id, first_bot_id, second_bot_id, pairs, opening_plies, seed,
    initial_time_ms, increment_ms, requested_by_user_id, ladder, created_at_unix_ms
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`,
		series.SeriesID, series.ModeID, series.FirstBotID, series.SecondBotID,
		series.Pairs, series.OpeningPlies, series.Seed,
		series.InitialTimeMs, series.IncrementMs, series.RequestedByUserID,
		boolToInt(series.Ladder), now,
	); err != nil {
		return BotSeries{}, fmt.Errorf("create bot series: %w", err)
	}
	return store.BotSeries(ctx, series.SeriesID)
}

// RecordBotSeriesGame notes that one game of a run has started.
func (store *Store) RecordBotSeriesGame(
	ctx context.Context,
	seriesID string,
	gameNumber int,
	pairNumber int,
	swapped bool,
	gameID string,
	openingLine string,
) error {
	if _, err := store.db.ExecContext(ctx, `
INSERT INTO bot_series_games (
    series_id, game_number, pair_number, swapped, game_id, opening_line, started_at_unix_ms
) VALUES (?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(series_id, game_number) DO UPDATE SET game_id = excluded.game_id
`, seriesID, gameNumber, pairNumber, boolToInt(swapped), gameID, openingLine,
		time.Now().UnixMilli()); err != nil {
		return fmt.Errorf("record bot series game: %w", err)
	}
	return nil
}

// FinishBotSeriesGame files a result and updates the tally in one transaction,
// so the per-game rows and the summary can never disagree.
func (store *Store) FinishBotSeriesGame(
	ctx context.Context,
	seriesID string,
	gameNumber int,
	result BotSeriesResult,
	endReason string,
) error {
	transaction, err := store.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("finish bot series game: begin transaction: %w", err)
	}
	defer func() { _ = transaction.Rollback() }()

	// Guarded on the row still being pending, so a repeated result — which a
	// retry or a double callback would produce — cannot count twice.
	outcome, err := transaction.ExecContext(ctx, `
UPDATE bot_series_games
SET result = ?, end_reason = ?, finished_at_unix_ms = ?
WHERE series_id = ? AND game_number = ? AND result = ?
`, result, endReason, time.Now().UnixMilli(), seriesID, gameNumber, BotSeriesPending)
	if err != nil {
		return fmt.Errorf("finish bot series game: %w", err)
	}
	if affected, _ := outcome.RowsAffected(); affected == 0 {
		return nil
	}

	column := "draws"
	switch result {
	case BotSeriesFirstWin:
		column = "first_wins"
	case BotSeriesSecondWin:
		column = "second_wins"
	}
	if _, err := transaction.ExecContext(ctx,
		"UPDATE bot_series SET "+column+" = "+column+" + 1 WHERE series_id = ?",
		seriesID,
	); err != nil {
		return fmt.Errorf("update bot series tally: %w", err)
	}
	return transaction.Commit()
}

// CloseBotSeries marks a run finished or abandoned.
func (store *Store) CloseBotSeries(
	ctx context.Context,
	seriesID string,
	status BotSeriesStatus,
) error {
	if _, err := store.db.ExecContext(ctx, `
UPDATE bot_series SET status = ?, completed_at_unix_ms = ?
WHERE series_id = ? AND status = ?
`, status, time.Now().UnixMilli(), seriesID, BotSeriesRunning); err != nil {
		return fmt.Errorf("close bot series: %w", err)
	}
	return nil
}

const botSeriesSelect = `
SELECT s.series_id, s.mode_id, s.first_bot_id, s.second_bot_id,
       COALESCE(fa.username, ''), COALESCE(sa.username, ''),
       COALESCE(fi.sha256, ''), COALESCE(si.sha256, ''),
       COALESCE(fb.user_id, ''), COALESCE(sb.user_id, ''),
       s.requested_by_user_id, COALESCE(ra.username, ''),
       s.status, s.pairs, s.opening_plies, s.seed,
       s.initial_time_ms, s.increment_ms,
       s.first_wins, s.second_wins, s.draws,
       s.created_at_unix_ms, s.completed_at_unix_ms,
       s.ladder,
       CASE WHEN s.ladder = 0 THEN 1
            ELSE COALESCE(fb.owner_user_id IS NOT NULL
                          AND fb.owner_user_id = sb.owner_user_id, 0)
       END
FROM bot_series s
LEFT JOIN bots fb ON fb.bot_id = s.first_bot_id
LEFT JOIN accounts fa ON fa.user_id = fb.user_id
LEFT JOIN bot_icons fi ON fi.bot_id = s.first_bot_id
LEFT JOIN bots sb ON sb.bot_id = s.second_bot_id
LEFT JOIN accounts sa ON sa.user_id = sb.user_id
LEFT JOIN bot_icons si ON si.bot_id = s.second_bot_id
LEFT JOIN accounts ra ON ra.user_id = s.requested_by_user_id`

func scanBotSeries(scanner interface{ Scan(...any) error }) (BotSeries, error) {
	var series BotSeries
	var completedAt sql.NullInt64
	var ladder, casual int
	err := scanner.Scan(
		&series.SeriesID, &series.ModeID, &series.FirstBotID, &series.SecondBotID,
		&series.FirstBotName, &series.SecondBotName,
		&series.FirstBotIcon, &series.SecondBotIcon,
		&series.FirstBotUserID, &series.SecondBotUserID,
		&series.RequestedByUserID, &series.RequestedByName,
		&series.Status, &series.Pairs, &series.OpeningPlies, &series.Seed,
		&series.InitialTimeMs, &series.IncrementMs,
		&series.FirstWins, &series.SecondWins, &series.Draws,
		&series.CreatedAtMs, &completedAt, &ladder, &casual,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return BotSeries{}, ErrBotSeriesNotFound
	}
	if err != nil {
		return BotSeries{}, fmt.Errorf("read bot series: %w", err)
	}
	if completedAt.Valid {
		series.CompletedAtMs = &completedAt.Int64
	}
	series.Ladder = ladder == 1
	series.Casual = casual == 1
	return series, nil
}

// BotSeries reads one run and its games.
func (store *Store) BotSeries(ctx context.Context, seriesID string) (BotSeries, error) {
	series, err := scanBotSeries(store.db.QueryRowContext(ctx, botSeriesSelect+`
WHERE s.series_id = ?`, strings.TrimSpace(seriesID)))
	if err != nil {
		return BotSeries{}, err
	}
	games, err := store.botSeriesGames(ctx, []string{series.SeriesID})
	if err != nil {
		return BotSeries{}, err
	}
	series.Games = games[series.SeriesID]
	return series, nil
}

// BotSeriesForGame reads the run one game belonged to.
//
// The lookup the review screen needs. A game arrives there as an id in a URL —
// somebody's shared link, or a step across from the ladder — and the screen has
// no way to know it was the fourth game of a six-game run unless it can ask. It
// is a query rather than a parameter on the link so that the strip appears on a
// pasted URL too, which is most of what those links are for.
func (store *Store) BotSeriesForGame(ctx context.Context, gameID string) (BotSeries, error) {
	gameID = strings.TrimSpace(gameID)
	if gameID == "" {
		return BotSeries{}, ErrBotSeriesNotFound
	}
	var seriesID string
	err := store.db.QueryRowContext(ctx,
		`SELECT series_id FROM bot_series_games WHERE game_id = ?`, gameID,
	).Scan(&seriesID)
	if errors.Is(err, sql.ErrNoRows) {
		return BotSeries{}, ErrBotSeriesNotFound
	}
	if err != nil {
		return BotSeries{}, fmt.Errorf("read bot series for game: %w", err)
	}
	return store.BotSeries(ctx, seriesID)
}

// BotSeriesList returns recent runs, newest first, with their games.
//
// With, because a run is read as one thing that happened rather than as a row
// with a score on it: the client draws the six boards, says which were drawn and
// which were abandoned, and lets somebody step between them. Fetching those a
// run at a time would be a request per row of the page.
//
// Two queries rather than a join, so that a run with no games yet still comes
// back — and so the runs are not multiplied out and reassembled.
func (store *Store) BotSeriesList(ctx context.Context, limit int) ([]BotSeries, error) {
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	return store.botSeriesWhere(ctx, `
ORDER BY s.created_at_unix_ms DESC LIMIT ?`, limit)
}

// LadderSeriesBetween returns the pool's own runs from one window of time,
// newest first, with their games.
//
// The window is how a *round* is identified, and it is the only handle there
// is: the pool records that a round ran and when, not which runs it seated, so
// the runs of the 14:00 round are the ladder runs created between 14:00 and
// 15:00. That holds because a round is seated within seconds of its slot and
// is skipped outright once the grace has passed — see ladderRoundDue — so no
// run can be filed under a round that did not start it.
//
// `ladder = 1` is the other half. A round's window also contains whatever
// anybody started by hand in the same hour, and those did not move a rating;
// a page that showed them as the round's results would be describing the wrong
// games.
func (store *Store) LadderSeriesBetween(
	ctx context.Context,
	fromUnixMs int64,
	toUnixMs int64,
) ([]BotSeries, error) {
	return store.botSeriesWhere(ctx, `
WHERE s.ladder = 1 AND s.created_at_unix_ms >= ? AND s.created_at_unix_ms < ?
ORDER BY s.created_at_unix_ms DESC`, fromUnixMs, toUnixMs)
}

// botSeriesWhere reads runs and their games, however the caller narrowed them.
//
// Two queries rather than a join, so that a run with no games yet still comes
// back — and so the runs are not multiplied out and reassembled. Shared because
// the second query is the easy half to forget: a list read without it is a list
// of scorelines with no games under them, which every caller here draws as a
// run that played nothing.
func (store *Store) botSeriesWhere(
	ctx context.Context,
	clause string,
	arguments ...any,
) ([]BotSeries, error) {
	rows, err := store.db.QueryContext(ctx, botSeriesSelect+clause, arguments...)
	if err != nil {
		return nil, fmt.Errorf("list bot series: %w", err)
	}
	defer rows.Close()
	list := make([]BotSeries, 0, 16)
	identifiers := make([]string, 0, 16)
	for rows.Next() {
		series, err := scanBotSeries(rows)
		if err != nil {
			return nil, err
		}
		list = append(list, series)
		identifiers = append(identifiers, series.SeriesID)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("list bot series: %w", err)
	}

	games, err := store.botSeriesGames(ctx, identifiers)
	if err != nil {
		return nil, err
	}
	for index := range list {
		list[index].Games = games[list[index].SeriesID]
	}
	return list, nil
}

// botSeriesGames reads the games of any number of runs, in playing order.
func (store *Store) botSeriesGames(
	ctx context.Context,
	seriesIDs []string,
) (map[string][]BotSeriesGame, error) {
	games := make(map[string][]BotSeriesGame, len(seriesIDs))
	if len(seriesIDs) == 0 {
		return games, nil
	}
	placeholders := strings.TrimSuffix(strings.Repeat("?, ", len(seriesIDs)), ", ")
	arguments := make([]any, 0, len(seriesIDs))
	for _, seriesID := range seriesIDs {
		arguments = append(arguments, seriesID)
	}
	rows, err := store.db.QueryContext(ctx, fmt.Sprintf(`
SELECT series_id, game_number, pair_number, swapped, COALESCE(game_id, ''),
       opening_line, result, end_reason
FROM bot_series_games
WHERE series_id IN (%s)
ORDER BY series_id, game_number
`, placeholders), arguments...)
	if err != nil {
		return nil, fmt.Errorf("read bot series games: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var seriesID string
		var entry BotSeriesGame
		if err := rows.Scan(
			&seriesID, &entry.GameNumber, &entry.PairNumber, &entry.Swapped,
			&entry.GameID, &entry.OpeningLine, &entry.Result, &entry.EndReason,
		); err != nil {
			return nil, fmt.Errorf("read bot series game: %w", err)
		}
		games[seriesID] = append(games[seriesID], entry)
	}
	return games, rows.Err()
}
