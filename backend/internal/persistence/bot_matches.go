package persistence

import (
	"fmt"
	"strings"

	"context"
)

// The bot-versus-bot record.
//
// A bot's games are already in `game_history` — a bot has an ordinary account,
// which is the decision the whole registry rests on — so this is a filter over
// that table rather than a second store. What makes the filter worth having is
// that "two bots played" is not a column: it is both players' account kind, and
// asking a client to work that out for itself would mean shipping it the whole
// history and the roster to join against.
//
// Games against people are deliberately not excluded here even though they are
// unranked; they are excluded by the join, because a human is not a bot. A bot's
// human games belong on its own history, not on a board about which engine is
// better than which.

// BotMatch is one finished game between two bots.
//
// It embeds the ordinary GameRecord instead of projecting a smaller shape: the
// screens that show these rows want exactly what a game record carries — the
// mode, the two seats, the ratings either side of it, and how it ended — and a
// smaller struct would be a second thing to keep in step for no gain.
type BotMatch struct {
	GameRecord
	// SeriesID names the run this game belonged to, and TournamentID the event,
	// each empty when the game was not part of one. Both travel with the row
	// because the history is read as a feed of *occasions* rather than of games:
	// a six-game series is one thing that happened, an all-bot round robin is
	// one thing that happened, and a client cannot group them without being told
	// which games belong together. A game with neither is a bare challenge.
	SeriesID     string `json:"seriesId,omitempty"`
	TournamentID string `json:"tournamentId,omitempty"`
}

const (
	botMatchDefaultLimit = 20
	botMatchMaximumLimit = 100
)

// BotMatchFilter is one page of the record.
type BotMatchFilter struct {
	// BotUserIDs keeps only games one of these bot accounts played, which is
	// what turns the global list into "the top bots' recent games". Empty means
	// every bot. Note "one of", not "both of": a leading bot's game against a
	// bot outside the list is still one of its games.
	BotUserIDs []string
	// ModeID keeps to one mode, which is what a per-mode ladder needs: a board
	// of the best Infiltration bots with a history of their Total War games
	// under it would be answering a question nobody asked.
	ModeID string
	Limit  int
	Offset int
}

func (filter BotMatchFilter) normalized() BotMatchFilter {
	identifiers := make([]string, 0, len(filter.BotUserIDs))
	for _, userID := range filter.BotUserIDs {
		if trimmed := strings.TrimSpace(userID); trimmed != "" {
			identifiers = append(identifiers, trimmed)
		}
	}
	filter.BotUserIDs = identifiers
	filter.ModeID = strings.TrimSpace(filter.ModeID)
	if filter.Limit <= 0 || filter.Limit > botMatchMaximumLimit {
		filter.Limit = botMatchDefaultLimit
	}
	if filter.Offset < 0 {
		filter.Offset = 0
	}
	return filter
}

// BotMatches returns finished games between two bots, newest first.
func (store *Store) BotMatches(
	ctx context.Context,
	filter BotMatchFilter,
) ([]BotMatch, error) {
	filter = filter.normalized()

	arguments := []any{AccountKindBot, AccountKindBot}
	conditions := make([]string, 0, 2)
	if len(filter.BotUserIDs) > 0 {
		placeholders := strings.TrimSuffix(strings.Repeat("?, ", len(filter.BotUserIDs)), ", ")
		conditions = append(conditions, fmt.Sprintf(
			"(h.red_player_id IN (%s) OR h.blue_player_id IN (%s))",
			placeholders, placeholders,
		))
		for range 2 {
			for _, userID := range filter.BotUserIDs {
				arguments = append(arguments, userID)
			}
		}
	}
	if filter.ModeID != "" {
		conditions = append(conditions, "h.mode_id = ?")
		arguments = append(arguments, filter.ModeID)
	}
	where := ""
	if len(conditions) > 0 {
		where = "\n  WHERE " + strings.Join(conditions, " AND ")
	}
	arguments = append(arguments, filter.Limit, filter.Offset)

	// A subquery, so the outer select can reuse gameRecordColumns unqualified:
	// three tables are joined here and two of them carry a `game_id`, so the
	// shared list could not be used directly. `h.*` renames nothing, which is
	// what makes the outer names work.
	//
	// The ORDER BY is repeated outside on purpose. SQLite happens to preserve a
	// subquery's order today and does not promise to, and a match history in
	// arbitrary order is wrong in a way nobody would notice in review.
	query := `
SELECT ` + gameRecordColumns + `, series_id, tournament_id
FROM (
  SELECT h.*, COALESCE(g.series_id, '') AS series_id,
         COALESCE(t.tournament_id, '') AS tournament_id
  FROM game_history h
  JOIN accounts red ON red.user_id = h.red_player_id AND red.kind = ?
  JOIN accounts blue ON blue.user_id = h.blue_player_id AND blue.kind = ?
  LEFT JOIN bot_series_games g ON g.game_id = h.game_id
  LEFT JOIN tournament_matches t ON t.game_id = h.game_id` + where + `
  ORDER BY h.finished_at_unix_ms DESC, h.game_id DESC
  LIMIT ? OFFSET ?
)
ORDER BY finished_at_unix_ms DESC, game_id DESC
`
	rows, err := store.db.QueryContext(ctx, query, arguments...)
	if err != nil {
		return nil, fmt.Errorf("query bot matches: %w", err)
	}
	defer rows.Close()

	matches := make([]BotMatch, 0, filter.Limit)
	for rows.Next() {
		var match BotMatch
		record, err := scanGameRecord(botMatchScanner{
			rows:         rows,
			seriesID:     &match.SeriesID,
			tournamentID: &match.TournamentID,
		})
		if err != nil {
			return nil, err
		}
		match.GameRecord = record
		matches = append(matches, match)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("query bot matches: %w", err)
	}
	return matches, nil
}

// botMatchScanner lets scanGameRecord read a row that carries two extra columns.
//
// The alternative was a second scan function holding a copy of the twenty-one
// field order, which is the copy gameRecordColumns exists to avoid.
type botMatchScanner struct {
	rows         interface{ Scan(...any) error }
	seriesID     *string
	tournamentID *string
}

func (scanner botMatchScanner) Scan(destinations ...any) error {
	return scanner.rows.Scan(
		append(destinations, scanner.seriesID, scanner.tournamentID)...,
	)
}
