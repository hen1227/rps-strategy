package persistence

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log"
	"sort"
	"time"

	"rps-strategy/backend/internal/game"
	"rps-strategy/backend/internal/notation"
)

// Rebuilding every rating from the record.
//
// A rating is a function of the ranked games in game_history taken in the order
// they finished, and nothing else, which is what makes it safe to correct. A
// finished game updates its two players in place (see RecordCompletedGame).
// Everything else — a deleted game, a game moved between ranked and casual, a
// purged account, a new version of rating.go — is applied by running the whole
// record through again, so the board always reads as though the record had
// been that way from the start. Three things are restated when that changes
// them:
//
//   - each account's rating in each mode, and the number it publishes as;
//   - the four ratings every game row records, before and after for each seat;
//   - the same four numbers in the archived record, which is the copy that
//     leaves the building.
//
// Only what actually changed is written, so replaying a record that has not
// changed writes nothing. One runs on every start, as the repair for any drift.

// ratingSystemVersion is the rating system whose numbers this database holds.
// When it differs from the stored one, the rebuild that changes the numbers
// also rebuilds what was decided by the old ones: the bot reign ledger, and the
// rating titles.
const ratingSystemVersion = notation.RatingSystem

// ratingKey is one account in one mode, which is what a rating belongs to.
type ratingKey struct {
	userID string
	modeID game.ModeID
}

// gameRatings is what one game row says about the two seats' ratings.
type gameRatings struct {
	redBefore  int
	redAfter   int
	blueBefore int
	blueAfter  int
}

// recordedGame is one row of game_history as the replay reads it.
type recordedGame struct {
	gameID     string
	modeID     game.ModeID
	redID      string
	blueID     string
	finishedAt int64
	// rated is whether the game moves ratings: ranked, with a result, and not
	// between two engines one person registered. redScore is only read when it
	// is.
	rated    bool
	redScore float64
	// stored is what the row says now, so only rows that change are written.
	stored gameRatings
}

// gameScore is Red's score for an outcome, and false for one that is not a
// result.
func gameScore(outcome string) (float64, bool) {
	switch outcome {
	case "red_win":
		return 1, true
	case "blue_win":
		return 0, true
	case "draw":
		return 0.5, true
	}
	return 0, false
}

// sameOwner reports whether one person registered both engines. Their games
// never move a rating, whatever they were filed as: an owner who controls both
// sides of a game controls its result.
func sameOwner(owners map[string]string, redID string, blueID string) bool {
	owner, found := owners[redID]
	return found && owner != "" && owner == owners[blueID]
}

// rateRecordedGame is the one place a game turns into ratings, shared by the
// replay and by a game being recorded, so the two cannot disagree. It returns
// the players' ratings after the game and what the game's row should record.
func rateRecordedGame(
	red glickoRating,
	blue glickoRating,
	played recordedGame,
) (glickoRating, glickoRating, gameRatings) {
	at := played.finishedAt
	result := gameRatings{redBefore: red.shown(at), blueBefore: blue.shown(at)}
	result.redAfter, result.blueAfter = result.redBefore, result.blueBefore
	if !played.rated {
		return red, blue, result
	}
	red, blue = rateGame(red, blue, played.redScore, at)
	result.redAfter, result.blueAfter = red.shown(at), blue.shown(at)
	return red, blue, result
}

// ratingLedger is every rating as of some point in the record.
type ratingLedger struct {
	ratings map[ratingKey]glickoRating
	// played counts every game each account has finished in each mode, rated
	// or not, which is the board's tiebreak; only the reign rebuild reads it.
	played map[ratingKey]int
}

func newRatingLedger() *ratingLedger {
	return &ratingLedger{
		ratings: make(map[ratingKey]glickoRating),
		played:  make(map[ratingKey]int),
	}
}

// rating is one account's rating in one mode, or a newcomer's for an account
// that has not played a ranked game in it.
func (ledger *ratingLedger) rating(key ratingKey) glickoRating {
	if rating, found := ledger.ratings[key]; found {
		return rating
	}
	return newGlickoRating()
}

// apply runs one game through the ledger and returns what its row should say.
func (ledger *ratingLedger) apply(played recordedGame) gameRatings {
	redKey := ratingKey{userID: played.redID, modeID: played.modeID}
	blueKey := ratingKey{userID: played.blueID, modeID: played.modeID}
	red, blue, result := rateRecordedGame(ledger.rating(redKey), ledger.rating(blueKey), played)
	if played.rated {
		ledger.ratings[redKey], ledger.ratings[blueKey] = red, blue
	}
	ledger.played[redKey]++
	ledger.played[blueKey]++
	return result
}

// botOwnersTx is every engine's owner, by the engine's user id.
func botOwnersTx(ctx context.Context, transaction *sql.Tx) (map[string]string, error) {
	rows, err := transaction.QueryContext(ctx,
		"SELECT user_id, owner_user_id FROM bots WHERE user_id IS NOT NULL",
	)
	if err != nil {
		return nil, fmt.Errorf("read bot owners: %w", err)
	}
	defer rows.Close()
	owners := make(map[string]string)
	for rows.Next() {
		var userID, ownerID string
		if err := rows.Scan(&userID, &ownerID); err != nil {
			return nil, fmt.Errorf("read bot owner: %w", err)
		}
		owners[userID] = ownerID
	}
	return owners, rows.Err()
}

// recordedGamesTx reads every finished game, oldest first, ties broken by id so
// that two replays of the same record take the same path through it.
func recordedGamesTx(ctx context.Context, transaction *sql.Tx) ([]recordedGame, error) {
	owners, err := botOwnersTx(ctx, transaction)
	if err != nil {
		return nil, err
	}
	rows, err := transaction.QueryContext(ctx, `
SELECT game_id, mode_id, red_player_id, blue_player_id, outcome, ranked,
       finished_at_unix_ms,
       red_elo_before, red_elo_after, blue_elo_before, blue_elo_after
FROM game_history
ORDER BY finished_at_unix_ms, game_id
`)
	if err != nil {
		return nil, fmt.Errorf("replay ratings: read games: %w", err)
	}
	defer rows.Close()

	games := make([]recordedGame, 0, 1024)
	for rows.Next() {
		var played recordedGame
		var outcome string
		var ranked int
		if err := rows.Scan(
			&played.gameID, &played.modeID, &played.redID, &played.blueID,
			&outcome, &ranked, &played.finishedAt,
			&played.stored.redBefore, &played.stored.redAfter,
			&played.stored.blueBefore, &played.stored.blueAfter,
		); err != nil {
			return nil, fmt.Errorf("replay ratings: read game: %w", err)
		}
		score, decided := gameScore(outcome)
		played.redScore = score
		played.rated = ranked == 1 && decided &&
			!sameOwner(owners, played.redID, played.blueID)
		games = append(games, played)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("replay ratings: read games: %w", err)
	}
	return games, nil
}

// ratingReplay is what a replay found.
type ratingReplay struct {
	games  []recordedGame
	ledger *ratingLedger
	// gamesRestated is how many game rows changed.
	gamesRestated int
}

// replayRatingsTx runs the whole record through the rating system and writes
// whatever came out different. Every caller that changes the record calls this
// before committing, so the change and the ratings it implies land together.
func replayRatingsTx(
	ctx context.Context,
	transaction *sql.Tx,
	now int64,
) (ratingReplay, error) {
	games, err := recordedGamesTx(ctx, transaction)
	if err != nil {
		return ratingReplay{}, err
	}
	ledger := newRatingLedger()
	changed := make(map[string]gameRatings)
	for _, played := range games {
		if result := ledger.apply(played); result != played.stored {
			changed[played.gameID] = result
		}
	}
	if err := restateGamesTx(ctx, transaction, changed); err != nil {
		return ratingReplay{}, err
	}
	if err := storeLedgerTx(ctx, transaction, ledger, now); err != nil {
		return ratingReplay{}, err
	}
	if err := refreshHeadlineRatingsTx(ctx, transaction); err != nil {
		return ratingReplay{}, err
	}
	return ratingReplay{games: games, ledger: ledger, gamesRestated: len(changed)}, nil
}

// restateGamesTx writes new ratings onto game rows and into their archived
// records, in game id order so the same replay always writes the same way.
func restateGamesTx(
	ctx context.Context,
	transaction *sql.Tx,
	changed map[string]gameRatings,
) error {
	if len(changed) == 0 {
		return nil
	}
	gameIDs := make([]string, 0, len(changed))
	for gameID := range changed {
		gameIDs = append(gameIDs, gameID)
	}
	sort.Strings(gameIDs)

	history, err := transaction.PrepareContext(ctx, `
UPDATE game_history
SET red_elo_before = ?, red_elo_after = ?, blue_elo_before = ?, blue_elo_after = ?
WHERE game_id = ?
`)
	if err != nil {
		return fmt.Errorf("replay ratings: prepare history: %w", err)
	}
	defer history.Close()
	read, err := transaction.PrepareContext(ctx, "SELECT pgn FROM game_pgn WHERE game_id = ?")
	if err != nil {
		return fmt.Errorf("replay ratings: prepare archive read: %w", err)
	}
	defer read.Close()
	write, err := transaction.PrepareContext(ctx, "UPDATE game_pgn SET pgn = ? WHERE game_id = ?")
	if err != nil {
		return fmt.Errorf("replay ratings: prepare archive write: %w", err)
	}
	defer write.Close()

	for _, gameID := range gameIDs {
		result := changed[gameID]
		if _, err := history.ExecContext(ctx,
			result.redBefore, result.redAfter, result.blueBefore, result.blueAfter, gameID,
		); err != nil {
			return fmt.Errorf("replay ratings: restate game %s: %w", gameID, err)
		}
		var pgn string
		switch err := read.QueryRowContext(ctx, gameID).Scan(&pgn); {
		case errors.Is(err, sql.ErrNoRows):
			// A game whose archive write failed. The history is what ratings are
			// read from, so it is restated on its own.
			continue
		case err != nil:
			return fmt.Errorf("replay ratings: read record %s: %w", gameID, err)
		}
		restated := notation.SetRatings(pgn, notation.Ratings{
			RedBefore: result.redBefore, RedAfter: result.redAfter,
			BlueBefore: result.blueBefore, BlueAfter: result.blueAfter,
		})
		if restated == pgn {
			continue
		}
		if _, err := write.ExecContext(ctx, restated, gameID); err != nil {
			return fmt.Errorf("replay ratings: restate record %s: %w", gameID, err)
		}
	}
	return nil
}

// storedRating is one account_mode_ratings row's rating columns.
type storedRating struct {
	key    ratingKey
	elo    int
	rating glickoRating
}

// ratingColumns is the column list scanStoredRating reads, in its order.
const ratingColumns = `user_id, mode_id, elo,
       strength, deviation, volatility, rated_games, last_rated_at_unix_ms`

func scanStoredRating(scanner interface{ Scan(...any) error }) (storedRating, error) {
	var row storedRating
	err := scanner.Scan(
		&row.key.userID, &row.key.modeID, &row.elo,
		&row.rating.strength, &row.rating.deviation, &row.rating.volatility,
		&row.rating.games, &row.rating.lastGameAt,
	)
	return row, err
}

// storeLedgerTx makes every rating row say what the ledger says, publishing at
// `now`. A row the ledger has nothing for belongs to an account with no ranked
// game left in that mode, and goes back to a newcomer's rating.
func storeLedgerTx(
	ctx context.Context,
	transaction *sql.Tx,
	ledger *ratingLedger,
	now int64,
) error {
	// Read to the end and closed before anything is written: the database is
	// one connection, and a write issued with these rows open waits on itself.
	rows, err := transaction.QueryContext(ctx, "SELECT "+ratingColumns+" FROM account_mode_ratings")
	if err != nil {
		return fmt.Errorf("replay ratings: read ratings: %w", err)
	}
	stored := make(map[ratingKey]storedRating)
	for rows.Next() {
		row, err := scanStoredRating(rows)
		if err != nil {
			rows.Close()
			return fmt.Errorf("replay ratings: read rating: %w", err)
		}
		stored[row.key] = row
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return fmt.Errorf("replay ratings: read ratings: %w", err)
	}
	rows.Close()

	keys := make([]ratingKey, 0, len(stored)+len(ledger.ratings))
	for key := range stored {
		keys = append(keys, key)
	}
	for key := range ledger.ratings {
		if _, found := stored[key]; !found {
			keys = append(keys, key)
		}
	}
	sort.Slice(keys, func(first, second int) bool {
		if keys[first].userID != keys[second].userID {
			return keys[first].userID < keys[second].userID
		}
		return keys[first].modeID < keys[second].modeID
	})

	for _, key := range keys {
		target := ledger.rating(key)
		row, found := stored[key]
		if found && row.rating == target && row.elo == target.shown(now) {
			continue
		}
		if !found {
			// Every ranked game makes sure both players have a row, so this is a
			// record written some other way. Give it one rather than lose it.
			if err := ensureModeRatingTx(ctx, transaction, key.userID, key.modeID, now); err != nil {
				return err
			}
		}
		if err := writeRatingTx(ctx, transaction, key, target, now); err != nil {
			return err
		}
	}
	return nil
}

// writeRatingTx stores one account's rating in one mode and the number it
// publishes as at `now`.
func writeRatingTx(
	ctx context.Context,
	transaction *sql.Tx,
	key ratingKey,
	rating glickoRating,
	now int64,
) error {
	if _, err := transaction.ExecContext(ctx, `
UPDATE account_mode_ratings
SET elo = ?, strength = ?, deviation = ?, volatility = ?,
    rated_games = ?, last_rated_at_unix_ms = ?
WHERE user_id = ? AND mode_id = ?
`, rating.shown(now), rating.strength, rating.deviation, rating.volatility,
		rating.games, rating.lastGameAt, key.userID, key.modeID,
	); err != nil {
		return fmt.Errorf("write rating for %s: %w", key.userID, err)
	}
	return nil
}

// headlineRatingSQL is the number that stands for an account as a whole: its
// best rated mode, or a newcomer's rating if it has none. It is what
// accounts.elo holds, so every list of accounts sorts and prints the same one.
const headlineRatingSQL = `COALESCE((
    SELECT MAX(r.elo) FROM account_mode_ratings r
    WHERE r.user_id = accounts.user_id AND r.rated_games > 0), ?)`

// refreshHeadlineRatingsTx brings accounts.elo in line with the mode ratings,
// for the given accounts or for everybody when none are named.
func refreshHeadlineRatingsTx(
	ctx context.Context,
	transaction *sql.Tx,
	userIDs ...string,
) error {
	statement := "UPDATE accounts SET elo = " + headlineRatingSQL +
		" WHERE elo <> " + headlineRatingSQL
	if len(userIDs) == 0 {
		if _, err := transaction.ExecContext(ctx, statement, RatingStart, RatingStart); err != nil {
			return fmt.Errorf("refresh headline ratings: %w", err)
		}
		return nil
	}
	for _, userID := range userIDs {
		if _, err := transaction.ExecContext(ctx,
			statement+" AND user_id = ?", RatingStart, RatingStart, userID,
		); err != nil {
			return fmt.Errorf("refresh headline rating for %s: %w", userID, err)
		}
	}
	return nil
}

// ensureRatingSystemSchema creates the one row that says which rating system
// the numbers in this database came from.
func (store *Store) ensureRatingSystemSchema(ctx context.Context) error {
	if _, err := store.db.ExecContext(ctx, `
CREATE TABLE IF NOT EXISTS rating_system (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    version TEXT NOT NULL,
    rebuilt_at_unix_ms INTEGER NOT NULL
)`); err != nil {
		return fmt.Errorf("migrate rating system schema: %w", err)
	}
	return nil
}

// RebuildRatings replays every game on record and restates whatever came out
// different. Called on every start.
//
// The first start under a new rating system is also when the numbers the old
// one decided are redone: who led each mode's bot ladder and when, which is
// rebuilt from the record (see rebuildBotReignsTx), and the rating titles,
// which are awarded to anybody the new numbers qualify. Titles are never taken
// away by this, the rule EvaluateTitles keeps everywhere.
func (store *Store) RebuildRatings(ctx context.Context) error {
	started := time.Now()
	now := started.UnixMilli()
	transaction, err := store.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("rebuild ratings: begin transaction: %w", err)
	}
	defer func() { _ = transaction.Rollback() }()

	var version string
	switch err := transaction.QueryRowContext(ctx,
		"SELECT version FROM rating_system WHERE id = 1",
	).Scan(&version); {
	case errors.Is(err, sql.ErrNoRows):
	case err != nil:
		return fmt.Errorf("rebuild ratings: read version: %w", err)
	}
	upgrading := version != ratingSystemVersion

	replay, err := replayRatingsTx(ctx, transaction, now)
	if err != nil {
		return err
	}
	if upgrading {
		if err := rebuildBotReignsTx(ctx, transaction, replay.games, now); err != nil {
			return err
		}
	}
	if _, err := transaction.ExecContext(ctx, `
INSERT INTO rating_system (id, version, rebuilt_at_unix_ms) VALUES (1, ?, ?)
ON CONFLICT(id) DO UPDATE SET version = excluded.version,
                              rebuilt_at_unix_ms = excluded.rebuilt_at_unix_ms
`, ratingSystemVersion, now); err != nil {
		return fmt.Errorf("rebuild ratings: write version: %w", err)
	}
	if err := transaction.Commit(); err != nil {
		return fmt.Errorf("rebuild ratings: commit: %w", err)
	}
	if replay.gamesRestated > 0 || (upgrading && len(replay.games) > 0) {
		log.Printf("ratings rebuilt from %d games: %d restated in %s",
			len(replay.games), replay.gamesRestated, time.Since(started).Round(time.Millisecond))
	}
	if !upgrading {
		return nil
	}

	people, err := store.ratedPeople(ctx)
	if err != nil {
		return err
	}
	for _, userID := range people {
		if _, err := store.EvaluateTitles(ctx, userID); err != nil {
			return fmt.Errorf("rebuild ratings: titles for %s: %w", userID, err)
		}
	}
	return nil
}

// ratedPeople is every person with a ranked game in some mode.
func (store *Store) ratedPeople(ctx context.Context) ([]string, error) {
	rows, err := store.db.QueryContext(ctx, `
SELECT DISTINCT r.user_id FROM account_mode_ratings r
JOIN accounts a ON a.user_id = r.user_id AND a.kind = ?
WHERE r.rated_games > 0
ORDER BY r.user_id
`, AccountKindHuman)
	if err != nil {
		return nil, fmt.Errorf("read rated people: %w", err)
	}
	defer rows.Close()
	var people []string
	for rows.Next() {
		var userID string
		if err := rows.Scan(&userID); err != nil {
			return nil, fmt.Errorf("read rated person: %w", err)
		}
		people = append(people, userID)
	}
	return people, rows.Err()
}

// RepublishRatings brings every published number up to date with the clock,
// and reports the modes in which one moved.
//
// A rating's deviation grows while its owner is away (see rating.go), so the
// number an idle account publishes falls slowly with nobody playing. Stored
// numbers are what every board sorts on, so something has to rewrite them, and
// this is it: the server calls it every hour.
func (store *Store) RepublishRatings(ctx context.Context, now int64) ([]game.ModeID, error) {
	transaction, err := store.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, fmt.Errorf("republish ratings: begin transaction: %w", err)
	}
	defer func() { _ = transaction.Rollback() }()

	rows, err := transaction.QueryContext(ctx,
		"SELECT "+ratingColumns+" FROM account_mode_ratings WHERE rated_games > 0",
	)
	if err != nil {
		return nil, fmt.Errorf("republish ratings: read: %w", err)
	}
	var stale []storedRating
	for rows.Next() {
		row, err := scanStoredRating(rows)
		if err != nil {
			rows.Close()
			return nil, fmt.Errorf("republish ratings: read row: %w", err)
		}
		if row.rating.shown(now) != row.elo {
			stale = append(stale, row)
		}
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, fmt.Errorf("republish ratings: read: %w", err)
	}
	rows.Close()

	moved := make(map[game.ModeID]bool)
	for _, row := range stale {
		if _, err := transaction.ExecContext(ctx, `
UPDATE account_mode_ratings SET elo = ? WHERE user_id = ? AND mode_id = ?
`, row.rating.shown(now), row.key.userID, row.key.modeID); err != nil {
			return nil, fmt.Errorf("republish ratings: write: %w", err)
		}
		moved[row.key.modeID] = true
	}
	if len(stale) > 0 {
		if err := refreshHeadlineRatingsTx(ctx, transaction); err != nil {
			return nil, err
		}
	}
	if err := transaction.Commit(); err != nil {
		return nil, fmt.Errorf("republish ratings: commit: %w", err)
	}
	modes := make([]game.ModeID, 0, len(moved))
	for modeID := range moved {
		modes = append(modes, modeID)
	}
	sort.Slice(modes, func(first, second int) bool { return modes[first] < modes[second] })
	return modes, nil
}

// ReplayRatings replays the whole record outside of a start, for a caller that
// has changed it some way this package does not already replay after.
func (store *Store) ReplayRatings(ctx context.Context) error {
	transaction, err := store.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("replay ratings: begin transaction: %w", err)
	}
	defer func() { _ = transaction.Rollback() }()
	if _, err := replayRatingsTx(ctx, transaction, time.Now().UnixMilli()); err != nil {
		return err
	}
	if err := transaction.Commit(); err != nil {
		return fmt.Errorf("replay ratings: commit: %w", err)
	}
	return nil
}
