package persistence

import (
	"fmt"
	"strings"
	"testing"
	"time"

	"rps-strategy/backend/internal/game"
)

// botLadderStore builds a store with a registered owner, so a test can mint
// bots without repeating the setup.
func botLadderStore(t *testing.T) *Store {
	t.Helper()
	store := authTestStore(t)
	registeredOwner(t, store, "owner", "Owner")
	return store
}

// rivalBot claims an engine under an owner of its own.
//
// Separate owners on purpose: the games of two engines one person registered
// never move a rating (see sameOwner), so a board minted under a single owner
// rates nothing at all. The one test that wants the other thing says so by
// using stablemate.
func rivalBot(t *testing.T, store *Store, name string) Bot {
	t.Helper()
	owner := "owner-" + strings.ToLower(name)
	registeredOwner(t, store, owner, "Owner_"+name)
	return claimedBot(t, store, owner, name)
}

// rival is rivalBot's account, which is what games are filed against.
func rival(t *testing.T, store *Store, name string) Account {
	t.Helper()
	return account(t, store, rivalBot(t, store, name).UserID)
}

// stablemate claims an engine under the same owner as one already minted: the
// pair whose games the ratings skip.
func stablemate(t *testing.T, store *Store, sibling Bot, name string) Bot {
	t.Helper()
	return claimedBot(t, store, sibling.OwnerUserID, name)
}

// seedBotGame files one ranked Total War game, finished a minute ago.
func seedBotGame(
	t *testing.T,
	store *Store,
	gameID string,
	red Account,
	blue Account,
	outcome string,
) {
	t.Helper()
	seedRankedGame(t, store, gameID, game.ModeTotalWar, red, blue, outcome,
		time.Now().Add(-time.Minute).UnixMilli())
}

// seedRankedGame files one finished, ranked game straight into the history,
// with no ratings on it, and makes sure both players have a row in the mode.
// The ratings are the replay's to work out; see replay.
func seedRankedGame(
	t *testing.T,
	store *Store,
	gameID string,
	modeID game.ModeID,
	red Account,
	blue Account,
	outcome string,
	at int64,
) {
	t.Helper()
	seedHistoryGame(t, store, gameID, modeID, red, blue, outcome, true, at)
}

// seedHistoryGame is seedRankedGame with the ranked flag said out loud.
func seedHistoryGame(
	t *testing.T,
	store *Store,
	gameID string,
	modeID game.ModeID,
	red Account,
	blue Account,
	outcome string,
	ranked bool,
	at int64,
) {
	t.Helper()
	var winner any
	switch outcome {
	case "red_win":
		winner = red.UserID
	case "blue_win":
		winner = blue.UserID
	}
	colour := map[string]string{"red_win": "Red", "blue_win": "Blue", "draw": "Neutral"}[outcome]
	if _, err := store.db.ExecContext(t.Context(), `
INSERT INTO game_history (
    game_id, mode_id, mode_name,
    red_player_id, red_username, blue_player_id, blue_username,
    winner_player_id, winner_color, outcome, end_reason, ranked,
    red_elo_before, red_elo_after, blue_elo_before, blue_elo_after,
    move_number, initial_time_ms, increment_ms,
    started_at_unix_ms, finished_at_unix_ms
) VALUES (?, ?, 'Test', ?, ?, ?, ?, ?, ?, ?, 'resignation', ?,
          0, 0, 0, 0, 30, 60000, 0, ?, ?)
`,
		gameID, modeID,
		red.UserID, red.Username, blue.UserID, blue.Username,
		winner, colour, outcome, boolToInt(ranked), at, at,
	); err != nil {
		t.Fatalf("seed game %s: %v", gameID, err)
	}
	for _, player := range []Account{red, blue} {
		if _, err := store.db.ExecContext(t.Context(), `
INSERT OR IGNORE INTO account_mode_ratings (
    user_id, mode_id, elo, games_played, created_at_unix_ms, updated_at_unix_ms
) VALUES (?, ?, ?, 0, ?, ?)
`, player.UserID, modeID, RatingStart, at, at); err != nil {
			t.Fatalf("seed mode rating: %v", err)
		}
		if _, err := store.db.ExecContext(t.Context(), `
UPDATE account_mode_ratings SET games_played = games_played + 1
WHERE user_id = ? AND mode_id = ?
`, player.UserID, modeID); err != nil {
			t.Fatalf("count seeded game: %v", err)
		}
	}
}

// seedSeries files `games` ranked games between two accounts a minute apart
// from `start`, Red winning `redWins` of them and Blue the rest, spread evenly
// through the run the way a real record mixes them. The games are tagged tag-1,
// tag-2 and so on.
//
// Spread rather than blocked because a rating is sequential: all of one side's
// wins and then all of the other's would read as a player who got better, and
// the ratings would say so.
//
// The start is the caller's so that two stores can be given the same games at
// the same moments: a rating depends on when its games were played as well as
// on their results, because a deviation grows with time between them.
func seedSeries(
	t *testing.T,
	store *Store,
	tag string,
	modeID game.ModeID,
	red Account,
	blue Account,
	games int,
	redWins int,
	start time.Time,
) {
	t.Helper()
	for index := range games {
		outcome := "blue_win"
		if (index+1)*redWins/games > index*redWins/games {
			outcome = "red_win"
		}
		at := start.Add(time.Duration(index) * time.Minute).UnixMilli()
		seedRankedGame(t, store, fmt.Sprintf("%s-%d", tag, index+1), modeID, red, blue, outcome, at)
	}
}

// recently is a start for seedSeries a couple of days back: long enough for a
// few hundred games a minute apart, and short enough that nobody's deviation
// has grown much since.
func recently() time.Time {
	return time.Now().Add(-48 * time.Hour).Truncate(time.Minute)
}

// replay runs the whole record through the rating system, as every start does.
func replay(t *testing.T, store *Store) {
	t.Helper()
	if err := store.ReplayRatings(t.Context()); err != nil {
		t.Fatalf("replay ratings: %v", err)
	}
}

// modeRating reads one account's rating in one mode, as everything else reads
// it: through the account.
func modeRating(t *testing.T, store *Store, userID string, modeID game.ModeID) ModeRating {
	t.Helper()
	rating, found := account(t, store, userID).ModeRatings[modeID]
	if !found {
		t.Fatalf("%s has no rating in %s", userID, modeID)
	}
	return rating
}

// storedRatings reads the rating behind each account's row in one mode, exactly
// as stored, which unlike the published number does not depend on the clock.
func storedRatings(t *testing.T, store *Store, modeID game.ModeID, accounts ...Account) []glickoRating {
	t.Helper()
	ratings := make([]glickoRating, 0, len(accounts))
	for _, player := range accounts {
		var rating glickoRating
		if err := store.db.QueryRowContext(t.Context(), `
SELECT strength, deviation, volatility, rated_games, last_rated_at_unix_ms
FROM account_mode_ratings WHERE user_id = ? AND mode_id = ?
`, player.UserID, modeID).Scan(
			&rating.strength, &rating.deviation, &rating.volatility,
			&rating.games, &rating.lastGameAt,
		); err != nil {
			t.Fatalf("read rating for %s: %v", player.Username, err)
		}
		ratings = append(ratings, rating)
	}
	return ratings
}

// gameRow reads the four ratings one game row records.
func gameRow(t *testing.T, store *Store, gameID string) gameRatings {
	t.Helper()
	var row gameRatings
	if err := store.db.QueryRowContext(t.Context(), `
SELECT red_elo_before, red_elo_after, blue_elo_before, blue_elo_after
FROM game_history WHERE game_id = ?
`, gameID).Scan(&row.redBefore, &row.redAfter, &row.blueBefore, &row.blueAfter); err != nil {
		t.Fatalf("read game %s: %v", gameID, err)
	}
	return row
}
