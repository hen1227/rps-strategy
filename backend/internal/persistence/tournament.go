package persistence

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"
	"unicode/utf8"

	"rps-strategy/backend/internal/game"
)

const (
	TournamentRegistration TournamentStatus = "registration"
	TournamentInProgress   TournamentStatus = "in_progress"
	TournamentCompleted    TournamentStatus = "completed"

	MatchPending    TournamentMatchResult = "pending"
	MatchPlayer1Win TournamentMatchResult = "player1_win"
	MatchPlayer2Win TournamentMatchResult = "player2_win"
	MatchDraw       TournamentMatchResult = "draw"
)

var (
	ErrTournamentNotFound       = errors.New("tournament not found")
	ErrTournamentClosed         = errors.New("tournament registration is closed")
	ErrTournamentAlreadyStarted = errors.New("tournament has already started")
	ErrTournamentNeedsPlayers   = errors.New("tournament needs at least two players")
	ErrTournamentSignupExists   = errors.New("that account or IGN is already signed up")
	ErrTournamentMatchNotFound  = errors.New("tournament match not found")
	ErrInvalidTournament        = errors.New("invalid tournament data")
)

type TournamentStatus string

type TournamentMatchResult string

type Tournament struct {
	TournamentID      string               `json:"tournamentId"`
	Name              string               `json:"name"`
	ModeID            game.ModeID          `json:"modeId"`
	ModeName          string               `json:"modeName"`
	Status            TournamentStatus     `json:"status"`
	Players           []TournamentPlayer   `json:"players"`
	Standings         []TournamentStanding `json:"standings"`
	Matches           []TournamentMatch    `json:"matches"`
	CreatedAtUnixMs   int64                `json:"createdAtUnixMs"`
	StartedAtUnixMs   *int64               `json:"startedAtUnixMs,omitempty"`
	CompletedAtUnixMs *int64               `json:"completedAtUnixMs,omitempty"`
}

type TournamentPlayer struct {
	PlayerID               int64  `json:"playerId"`
	UserID                 string `json:"userId"`
	IGN                    string `json:"ign"`
	Discord                string `json:"discord"`
	AgreedToUnfilteredChat bool   `json:"agreedToUnfilteredChat"`
	SignupOrder            int    `json:"signupOrder"`
	JoinedAtUnixMs         int64  `json:"joinedAtUnixMs"`
}

type TournamentStanding struct {
	Rank        int    `json:"rank"`
	PlayerID    int64  `json:"playerId"`
	IGN         string `json:"ign"`
	Discord     string `json:"discord"`
	Played      int    `json:"played"`
	Wins        int    `json:"wins"`
	Losses      int    `json:"losses"`
	Draws       int    `json:"draws"`
	Points      int    `json:"points"`
	SignupOrder int    `json:"signupOrder"`
}

type TournamentMatch struct {
	MatchID         int64                 `json:"matchId"`
	RoundNumber     int                   `json:"roundNumber"`
	MatchOrder      int                   `json:"matchOrder"`
	Player1         TournamentPlayer      `json:"player1"`
	Player2         TournamentPlayer      `json:"player2"`
	Result          TournamentMatchResult `json:"result"`
	WinnerPlayerID  *int64                `json:"winnerPlayerId,omitempty"`
	GameID          string                `json:"gameId,omitempty"`
	UpdatedAtUnixMs int64                 `json:"updatedAtUnixMs"`
}

func (store *Store) CreateTournament(
	ctx context.Context,
	tournamentID string,
	name string,
	modeID game.ModeID,
	modeName string,
) (Tournament, error) {
	tournamentID = strings.TrimSpace(tournamentID)
	name = strings.TrimSpace(name)
	modeName = strings.TrimSpace(modeName)
	if tournamentID == "" {
		return Tournament{}, fmt.Errorf("%w: tournament ID is required", ErrInvalidTournament)
	}
	if utf8.RuneCountInString(name) < 1 || utf8.RuneCountInString(name) > 80 {
		return Tournament{}, fmt.Errorf("%w: name must be between 1 and 80 characters", ErrInvalidTournament)
	}
	if modeID == "" || modeName == "" {
		return Tournament{}, fmt.Errorf("%w: game mode is required", ErrInvalidTournament)
	}
	now := time.Now().UnixMilli()
	_, err := store.db.ExecContext(ctx, `
INSERT INTO tournaments (
    tournament_id, name, mode_id, mode_name, status, created_at_unix_ms
) VALUES (?, ?, ?, ?, ?, ?)
`, tournamentID, name, modeID, modeName, TournamentRegistration, now)
	if err != nil {
		return Tournament{}, fmt.Errorf("create tournament: %w", err)
	}
	return store.Tournament(ctx, tournamentID)
}

func (store *Store) SignupForTournament(
	ctx context.Context,
	tournamentID string,
	userID string,
	ign string,
	discord string,
	agreedToUnfilteredChat bool,
) (Tournament, error) {
	tournamentID = strings.TrimSpace(tournamentID)
	userID = strings.TrimSpace(userID)
	ign = strings.TrimSpace(ign)
	discord = strings.TrimSpace(discord)
	if userID == "" || utf8.RuneCountInString(userID) > 128 {
		return Tournament{}, fmt.Errorf("%w: userId must be between 1 and 128 characters", ErrInvalidTournament)
	}
	if utf8.RuneCountInString(ign) < 1 || utf8.RuneCountInString(ign) > 32 {
		return Tournament{}, fmt.Errorf("%w: IGN must be between 1 and 32 characters", ErrInvalidTournament)
	}
	if utf8.RuneCountInString(discord) < 2 || utf8.RuneCountInString(discord) > 64 {
		return Tournament{}, fmt.Errorf("%w: Discord must be between 2 and 64 characters", ErrInvalidTournament)
	}
	if !agreedToUnfilteredChat {
		return Tournament{}, fmt.Errorf("%w: unfiltered chat agreement is required", ErrInvalidTournament)
	}

	transaction, err := store.db.BeginTx(ctx, nil)
	if err != nil {
		return Tournament{}, fmt.Errorf("sign up for tournament: begin transaction: %w", err)
	}
	defer func() { _ = transaction.Rollback() }()

	var status TournamentStatus
	if err := transaction.QueryRowContext(ctx, `
SELECT status FROM tournaments WHERE tournament_id = ?
`, tournamentID).Scan(&status); errors.Is(err, sql.ErrNoRows) {
		return Tournament{}, ErrTournamentNotFound
	} else if err != nil {
		return Tournament{}, fmt.Errorf("sign up for tournament: read tournament: %w", err)
	}
	if status != TournamentRegistration {
		return Tournament{}, ErrTournamentClosed
	}

	var signupOrder int
	if err := transaction.QueryRowContext(ctx, `
SELECT COALESCE(MAX(signup_order), 0) + 1
FROM tournament_players
WHERE tournament_id = ?
`, tournamentID).Scan(&signupOrder); err != nil {
		return Tournament{}, fmt.Errorf("sign up for tournament: choose order: %w", err)
	}
	_, err = transaction.ExecContext(ctx, `
INSERT INTO tournament_players (
    tournament_id, user_id, ign, discord, agreed_to_unfiltered_chat,
    signup_order, joined_at_unix_ms
) VALUES (?, ?, ?, ?, 1, ?, ?)
`, tournamentID, userID, ign, discord, signupOrder, time.Now().UnixMilli())
	if err != nil {
		if isUniqueConstraint(err) {
			return Tournament{}, ErrTournamentSignupExists
		}
		return Tournament{}, fmt.Errorf("sign up for tournament: insert player: %w", err)
	}
	if err := transaction.Commit(); err != nil {
		return Tournament{}, fmt.Errorf("sign up for tournament: commit: %w", err)
	}
	return store.Tournament(ctx, tournamentID)
}

func (store *Store) Tournaments(ctx context.Context) ([]Tournament, error) {
	rows, err := store.db.QueryContext(ctx, `
SELECT tournament_id
FROM tournaments
ORDER BY created_at_unix_ms DESC, tournament_id DESC
`)
	if err != nil {
		return nil, fmt.Errorf("list tournaments: %w", err)
	}
	ids := make([]string, 0)
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			_ = rows.Close()
			return nil, fmt.Errorf("list tournaments: %w", err)
		}
		ids = append(ids, id)
	}
	if err := rows.Err(); err != nil {
		_ = rows.Close()
		return nil, fmt.Errorf("list tournaments: %w", err)
	}
	if err := rows.Close(); err != nil {
		return nil, fmt.Errorf("list tournaments: %w", err)
	}

	tournaments := make([]Tournament, 0, len(ids))
	for _, id := range ids {
		tournament, err := store.Tournament(ctx, id)
		if err != nil {
			return nil, err
		}
		tournaments = append(tournaments, tournament)
	}
	return tournaments, nil
}

func (store *Store) Tournament(ctx context.Context, tournamentID string) (Tournament, error) {
	return readTournament(ctx, store.db, strings.TrimSpace(tournamentID))
}

func (store *Store) StartTournament(ctx context.Context, tournamentID string) (Tournament, error) {
	tournamentID = strings.TrimSpace(tournamentID)
	transaction, err := store.db.BeginTx(ctx, nil)
	if err != nil {
		return Tournament{}, fmt.Errorf("start tournament: begin transaction: %w", err)
	}
	defer func() { _ = transaction.Rollback() }()

	var status TournamentStatus
	if err := transaction.QueryRowContext(ctx, `
SELECT status FROM tournaments WHERE tournament_id = ?
`, tournamentID).Scan(&status); errors.Is(err, sql.ErrNoRows) {
		return Tournament{}, ErrTournamentNotFound
	} else if err != nil {
		return Tournament{}, fmt.Errorf("start tournament: read tournament: %w", err)
	}
	if status != TournamentRegistration {
		return Tournament{}, ErrTournamentAlreadyStarted
	}

	rows, err := transaction.QueryContext(ctx, `
SELECT player_id
FROM tournament_players
WHERE tournament_id = ?
ORDER BY signup_order
`, tournamentID)
	if err != nil {
		return Tournament{}, fmt.Errorf("start tournament: read players: %w", err)
	}
	playerIDs := make([]int64, 0)
	for rows.Next() {
		var playerID int64
		if err := rows.Scan(&playerID); err != nil {
			_ = rows.Close()
			return Tournament{}, fmt.Errorf("start tournament: read player: %w", err)
		}
		playerIDs = append(playerIDs, playerID)
	}
	if err := rows.Err(); err != nil {
		_ = rows.Close()
		return Tournament{}, fmt.Errorf("start tournament: read players: %w", err)
	}
	if err := rows.Close(); err != nil {
		return Tournament{}, fmt.Errorf("start tournament: read players: %w", err)
	}
	if len(playerIDs) < 2 {
		return Tournament{}, ErrTournamentNeedsPlayers
	}

	now := time.Now().UnixMilli()
	matchOrder := 1
	for roundIndex, pairs := range roundRobinPairs(playerIDs) {
		for _, pair := range pairs {
			if _, err := transaction.ExecContext(ctx, `
INSERT INTO tournament_matches (
    tournament_id, round_number, match_order, player1_id, player2_id,
    result, updated_at_unix_ms
) VALUES (?, ?, ?, ?, ?, ?, ?)
`, tournamentID, roundIndex+1, matchOrder, pair[0], pair[1], MatchPending, now); err != nil {
				return Tournament{}, fmt.Errorf("start tournament: create matches: %w", err)
			}
			matchOrder++
		}
	}
	if _, err := transaction.ExecContext(ctx, `
UPDATE tournaments
SET status = ?, started_at_unix_ms = ?, completed_at_unix_ms = NULL
WHERE tournament_id = ?
`, TournamentInProgress, now, tournamentID); err != nil {
		return Tournament{}, fmt.Errorf("start tournament: update status: %w", err)
	}
	if err := transaction.Commit(); err != nil {
		return Tournament{}, fmt.Errorf("start tournament: commit: %w", err)
	}
	return store.Tournament(ctx, tournamentID)
}

func (store *Store) SetTournamentMatchResult(
	ctx context.Context,
	tournamentID string,
	matchID int64,
	result TournamentMatchResult,
) (Tournament, error) {
	if result != MatchPending && result != MatchPlayer1Win &&
		result != MatchPlayer2Win && result != MatchDraw {
		return Tournament{}, fmt.Errorf(
			"%w: result must be pending, player1_win, player2_win, or draw",
			ErrInvalidTournament,
		)
	}
	tournamentID = strings.TrimSpace(tournamentID)
	transaction, err := store.db.BeginTx(ctx, nil)
	if err != nil {
		return Tournament{}, fmt.Errorf("set tournament result: begin transaction: %w", err)
	}
	defer func() { _ = transaction.Rollback() }()

	var status TournamentStatus
	if err := transaction.QueryRowContext(ctx, `
SELECT status FROM tournaments WHERE tournament_id = ?
`, tournamentID).Scan(&status); errors.Is(err, sql.ErrNoRows) {
		return Tournament{}, ErrTournamentNotFound
	} else if err != nil {
		return Tournament{}, fmt.Errorf("set tournament result: read tournament: %w", err)
	}
	if status == TournamentRegistration {
		return Tournament{}, ErrTournamentMatchNotFound
	}

	var player1ID, player2ID int64
	if err := transaction.QueryRowContext(ctx, `
SELECT player1_id, player2_id
FROM tournament_matches
WHERE tournament_id = ? AND match_id = ?
`, tournamentID, matchID).Scan(&player1ID, &player2ID); errors.Is(err, sql.ErrNoRows) {
		return Tournament{}, ErrTournamentMatchNotFound
	} else if err != nil {
		return Tournament{}, fmt.Errorf("set tournament result: read match: %w", err)
	}

	var winnerID any
	switch result {
	case MatchPlayer1Win:
		winnerID = player1ID
	case MatchPlayer2Win:
		winnerID = player2ID
	default:
		winnerID = nil
	}
	now := time.Now().UnixMilli()
	if _, err := transaction.ExecContext(ctx, `
UPDATE tournament_matches
SET result = ?, winner_player_id = ?, updated_at_unix_ms = ?
WHERE tournament_id = ? AND match_id = ?
`, result, winnerID, now, tournamentID, matchID); err != nil {
		return Tournament{}, fmt.Errorf("set tournament result: update match: %w", err)
	}

	var pendingMatches int
	if err := transaction.QueryRowContext(ctx, `
SELECT COUNT(*)
FROM tournament_matches
WHERE tournament_id = ? AND result = ?
`, tournamentID, MatchPending).Scan(&pendingMatches); err != nil {
		return Tournament{}, fmt.Errorf("set tournament result: count pending matches: %w", err)
	}
	nextStatus := TournamentInProgress
	var completedAt any
	if pendingMatches == 0 {
		nextStatus = TournamentCompleted
		completedAt = now
	}
	if _, err := transaction.ExecContext(ctx, `
UPDATE tournaments
SET status = ?, completed_at_unix_ms = ?
WHERE tournament_id = ?
`, nextStatus, completedAt, tournamentID); err != nil {
		return Tournament{}, fmt.Errorf("set tournament result: update status: %w", err)
	}
	if err := transaction.Commit(); err != nil {
		return Tournament{}, fmt.Errorf("set tournament result: commit: %w", err)
	}
	return store.Tournament(ctx, tournamentID)
}

type tournamentQueryer interface {
	QueryRowContext(context.Context, string, ...any) *sql.Row
	QueryContext(context.Context, string, ...any) (*sql.Rows, error)
}

func readTournament(
	ctx context.Context,
	queryer tournamentQueryer,
	tournamentID string,
) (Tournament, error) {
	var tournament Tournament
	var startedAt, completedAt sql.NullInt64
	err := queryer.QueryRowContext(ctx, `
SELECT tournament_id, name, mode_id, mode_name, status,
       created_at_unix_ms, started_at_unix_ms, completed_at_unix_ms
FROM tournaments
WHERE tournament_id = ?
`, tournamentID).Scan(
		&tournament.TournamentID,
		&tournament.Name,
		&tournament.ModeID,
		&tournament.ModeName,
		&tournament.Status,
		&tournament.CreatedAtUnixMs,
		&startedAt,
		&completedAt,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return Tournament{}, ErrTournamentNotFound
	}
	if err != nil {
		return Tournament{}, fmt.Errorf("read tournament: %w", err)
	}
	if startedAt.Valid {
		tournament.StartedAtUnixMs = &startedAt.Int64
	}
	if completedAt.Valid {
		tournament.CompletedAtUnixMs = &completedAt.Int64
	}

	players, playerByID, err := readTournamentPlayers(ctx, queryer, tournamentID)
	if err != nil {
		return Tournament{}, err
	}
	matches, err := readTournamentMatches(ctx, queryer, tournamentID, playerByID)
	if err != nil {
		return Tournament{}, err
	}
	tournament.Players = players
	tournament.Matches = matches
	tournament.Standings = tournamentStandings(players, matches)
	return tournament, nil
}

func readTournamentPlayers(
	ctx context.Context,
	queryer tournamentQueryer,
	tournamentID string,
) ([]TournamentPlayer, map[int64]TournamentPlayer, error) {
	rows, err := queryer.QueryContext(ctx, `
SELECT player_id, user_id, ign, discord, agreed_to_unfiltered_chat,
       signup_order, joined_at_unix_ms
FROM tournament_players
WHERE tournament_id = ?
ORDER BY signup_order
`, tournamentID)
	if err != nil {
		return nil, nil, fmt.Errorf("read tournament players: %w", err)
	}
	defer rows.Close()
	players := make([]TournamentPlayer, 0)
	playerByID := make(map[int64]TournamentPlayer)
	for rows.Next() {
		var player TournamentPlayer
		var agreed int
		if err := rows.Scan(
			&player.PlayerID,
			&player.UserID,
			&player.IGN,
			&player.Discord,
			&agreed,
			&player.SignupOrder,
			&player.JoinedAtUnixMs,
		); err != nil {
			return nil, nil, fmt.Errorf("read tournament player: %w", err)
		}
		player.AgreedToUnfilteredChat = agreed == 1
		players = append(players, player)
		playerByID[player.PlayerID] = player
	}
	if err := rows.Err(); err != nil {
		return nil, nil, fmt.Errorf("read tournament players: %w", err)
	}
	return players, playerByID, nil
}

func readTournamentMatches(
	ctx context.Context,
	queryer tournamentQueryer,
	tournamentID string,
	playerByID map[int64]TournamentPlayer,
) ([]TournamentMatch, error) {
	rows, err := queryer.QueryContext(ctx, `
SELECT match_id, round_number, match_order, player1_id, player2_id,
       result, winner_player_id, game_id, updated_at_unix_ms
FROM tournament_matches
WHERE tournament_id = ?
ORDER BY match_order
`, tournamentID)
	if err != nil {
		return nil, fmt.Errorf("read tournament matches: %w", err)
	}
	defer rows.Close()
	matches := make([]TournamentMatch, 0)
	for rows.Next() {
		var match TournamentMatch
		var player1ID, player2ID int64
		var winnerID sql.NullInt64
		var gameID sql.NullString
		if err := rows.Scan(
			&match.MatchID,
			&match.RoundNumber,
			&match.MatchOrder,
			&player1ID,
			&player2ID,
			&match.Result,
			&winnerID,
			&gameID,
			&match.UpdatedAtUnixMs,
		); err != nil {
			return nil, fmt.Errorf("read tournament match: %w", err)
		}
		match.Player1 = playerByID[player1ID]
		match.Player2 = playerByID[player2ID]
		if winnerID.Valid {
			match.WinnerPlayerID = &winnerID.Int64
		}
		match.GameID = gameID.String
		matches = append(matches, match)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("read tournament matches: %w", err)
	}
	return matches, nil
}

func tournamentStandings(
	players []TournamentPlayer,
	matches []TournamentMatch,
) []TournamentStanding {
	standings := make([]TournamentStanding, 0, len(players))
	standingByPlayerID := make(map[int64]*TournamentStanding, len(players))
	for _, player := range players {
		standing := TournamentStanding{
			PlayerID:    player.PlayerID,
			IGN:         player.IGN,
			Discord:     player.Discord,
			SignupOrder: player.SignupOrder,
		}
		standings = append(standings, standing)
		standingByPlayerID[player.PlayerID] = &standings[len(standings)-1]
	}
	for _, match := range matches {
		first := standingByPlayerID[match.Player1.PlayerID]
		second := standingByPlayerID[match.Player2.PlayerID]
		if first == nil || second == nil || match.Result == MatchPending {
			continue
		}
		first.Played++
		second.Played++
		switch match.Result {
		case MatchPlayer1Win:
			first.Wins++
			first.Points += 3
			second.Losses++
		case MatchPlayer2Win:
			second.Wins++
			second.Points += 3
			first.Losses++
		case MatchDraw:
			first.Draws++
			second.Draws++
			first.Points++
			second.Points++
		}
	}
	sort.SliceStable(standings, func(i, j int) bool {
		if standings[i].Points != standings[j].Points {
			return standings[i].Points > standings[j].Points
		}
		if standings[i].Wins != standings[j].Wins {
			return standings[i].Wins > standings[j].Wins
		}
		if standings[i].Draws != standings[j].Draws {
			return standings[i].Draws > standings[j].Draws
		}
		return standings[i].SignupOrder < standings[j].SignupOrder
	})
	for index := range standings {
		standings[index].Rank = index + 1
	}
	return standings
}

func roundRobinPairs(playerIDs []int64) [][][2]int64 {
	rotation := append([]int64(nil), playerIDs...)
	if len(rotation)%2 != 0 {
		rotation = append(rotation, 0)
	}
	rounds := make([][][2]int64, 0, len(rotation)-1)
	for roundIndex := 0; roundIndex < len(rotation)-1; roundIndex++ {
		pairs := make([][2]int64, 0, len(rotation)/2)
		for index := 0; index < len(rotation)/2; index++ {
			first := rotation[index]
			second := rotation[len(rotation)-1-index]
			if first == 0 || second == 0 {
				continue
			}
			if index == 0 && roundIndex%2 == 1 {
				first, second = second, first
			}
			pairs = append(pairs, [2]int64{first, second})
		}
		rounds = append(rounds, pairs)
		rotation = append(
			[]int64{rotation[0], rotation[len(rotation)-1]},
			rotation[1:len(rotation)-1]...,
		)
	}
	return rounds
}

func isUniqueConstraint(err error) bool {
	return strings.Contains(strings.ToLower(err.Error()), "unique constraint failed")
}

// ensureTournamentMatchColumns migrates databases created before tournament
// matches were played inside the app.
func (store *Store) ensureTournamentMatchColumns(ctx context.Context) error {
	columns, err := tableColumns(ctx, store.db, "tournament_matches")
	if err != nil {
		return fmt.Errorf("inspect tournament match schema: %w", err)
	}
	if columns["game_id"] {
		return nil
	}
	if _, err := store.db.ExecContext(
		ctx,
		"ALTER TABLE tournament_matches ADD COLUMN game_id TEXT",
	); err != nil {
		return fmt.Errorf("add tournament match game_id column: %w", err)
	}
	return nil
}

// SetTournamentMatchGame records the live game session playing out a scheduled
// match. Only a pending match of a started tournament can be assigned a game,
// which keeps a recorded result from being replayed.
func (store *Store) SetTournamentMatchGame(
	ctx context.Context,
	tournamentID string,
	matchID int64,
	gameID string,
) (Tournament, error) {
	tournamentID = strings.TrimSpace(tournamentID)
	gameID = strings.TrimSpace(gameID)
	if gameID == "" {
		return Tournament{}, fmt.Errorf("%w: gameId is required", ErrInvalidTournament)
	}

	transaction, err := store.db.BeginTx(ctx, nil)
	if err != nil {
		return Tournament{}, fmt.Errorf("set tournament match game: begin transaction: %w", err)
	}
	defer func() { _ = transaction.Rollback() }()

	var status TournamentStatus
	if err := transaction.QueryRowContext(ctx, `
SELECT status FROM tournaments WHERE tournament_id = ?
`, tournamentID).Scan(&status); errors.Is(err, sql.ErrNoRows) {
		return Tournament{}, ErrTournamentNotFound
	} else if err != nil {
		return Tournament{}, fmt.Errorf("set tournament match game: read tournament: %w", err)
	}
	if status != TournamentInProgress {
		return Tournament{}, ErrTournamentMatchNotFound
	}

	result, err := transaction.ExecContext(ctx, `
UPDATE tournament_matches
SET game_id = ?, updated_at_unix_ms = ?
WHERE tournament_id = ? AND match_id = ? AND result = ?
`, gameID, time.Now().UnixMilli(), tournamentID, matchID, MatchPending)
	if err != nil {
		return Tournament{}, fmt.Errorf("set tournament match game: update match: %w", err)
	}
	updated, err := result.RowsAffected()
	if err != nil {
		return Tournament{}, fmt.Errorf("set tournament match game: count updates: %w", err)
	}
	if updated == 0 {
		return Tournament{}, ErrTournamentMatchNotFound
	}
	if err := transaction.Commit(); err != nil {
		return Tournament{}, fmt.Errorf("set tournament match game: commit: %w", err)
	}
	return store.Tournament(ctx, tournamentID)
}
