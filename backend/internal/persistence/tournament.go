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
	// TournamentDraft is an event that has been written down but not published.
	// It is not a value of the stored `status` column — see the note at the top
	// of tournament_admin.go, which explains what is stored instead and why.
	TournamentDraft        TournamentStatus = "draft"
	TournamentRegistration TournamentStatus = "registration"
	TournamentInProgress   TournamentStatus = "in_progress"
	TournamentCompleted    TournamentStatus = "completed"
	// TournamentCancelled is an event that was called off. Like draft, it is
	// derived rather than stored.
	TournamentCancelled TournamentStatus = "cancelled"

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
	// ErrTournamentAlreadyEntered is the answer to a second entry from the same
	// party — an owner who has already entered, or who has already entered one
	// of their bots. See tournamentPartyID for what a party is and why the rule
	// is one entry each rather than one row each.
	//
	// Always wrapped with the name already in the field, because "you are
	// already in" is unhelpful to somebody who entered an engine three days ago
	// and has forgotten which one.
	ErrTournamentAlreadyEntered = errors.New("you already have an entry in this tournament")
	// ErrTournamentEntryNotFound is the answer to withdrawing from an event you
	// are not in. Distinct from ErrTournamentNotFound: the event is real.
	ErrTournamentEntryNotFound = errors.New("you have no entry in this tournament")
)

// TournamentKind is which series an event belongs to.
//
// Two so far, and the difference is entirely about where an event appears and
// what it counts for: a manual event is one somebody built and announced, a
// weekend arena is one of a series that produces one every week. Fifty-two
// champions a year would thin the Tournament Champion title, and a board that
// listed every one of them would bury the events people came for.
//
// The stored value still reads "nightly", from the year this ran every night.
// It is the vocabulary of every event already in the archive, which titles.go
// and the rolling crown both read, and renaming it would rewrite history for
// the sake of a word nobody sees.
type TournamentKind string

const (
	TournamentManual  TournamentKind = "manual"
	TournamentWeekend TournamentKind = "nightly"
)

// Normalized turns a stored blank — every row that predates the column — into
// the manual event it was.
func (kind TournamentKind) Normalized() TournamentKind {
	if kind == TournamentWeekend {
		return TournamentWeekend
	}
	return TournamentManual
}

type TournamentStatus string

type TournamentMatchResult string

type Tournament struct {
	TournamentID string           `json:"tournamentId"`
	Name         string           `json:"name"`
	Description  string           `json:"description,omitempty"`
	ModeID       game.ModeID      `json:"modeId"`
	ModeName     string           `json:"modeName"`
	Status       TournamentStatus `json:"status"`
	// The competition's rules, as the host set them. See TournamentConfig,
	// which is the same set of answers on the way in.
	Format  TournamentFormat  `json:"format"`
	Field   TournamentField   `json:"field"`
	Seeding TournamentSeeding `json:"seeding"`
	// MaxPlayers is the cap on the field, and zero is uncapped.
	MaxPlayers int `json:"maxPlayers"`
	// SwissRounds is what the host asked for; zero means derived. Rounds below
	// is the answer, and is what a screen should show.
	SwissRounds int `json:"swissRounds,omitempty"`
	// GamesPerMatch is how many games one pairing plays, and is one for every
	// event that does not say otherwise. See the note on TournamentConfig.
	GamesPerMatch int `json:"gamesPerMatch"`
	// Kind is the series this belongs to, and WeekendNumber is its place in
	// that series — "Weekend Bot Arena #142" — or zero for a one-off. The wire
	// name stays "nightlyNumber" for the same reason the stored kind does; see
	// TournamentKind.
	Kind          TournamentKind `json:"kind"`
	WeekendNumber int            `json:"nightlyNumber,omitempty"`
	// Rounds is how many rounds this event will play in total, which a
	// progressive format needs published because its later rounds do not exist
	// yet. Zero before there is a field to compute it from.
	Rounds        int `json:"rounds"`
	InitialTimeMs int `json:"initialTimeMs,omitempty"`
	IncrementMs   int `json:"incrementMs,omitempty"`
	// StartsAtUnixMs is when the host intends to begin. Advisory — see the
	// field's note on TournamentConfig.
	StartsAtUnixMs    *int64               `json:"startsAtUnixMs,omitempty"`
	Players           []TournamentPlayer   `json:"players"`
	Standings         []TournamentStanding `json:"standings"`
	Matches           []TournamentMatch    `json:"matches"`
	Byes              []TournamentBye      `json:"byes,omitempty"`
	CreatedAtUnixMs   int64                `json:"createdAtUnixMs"`
	PublishedAtUnixMs *int64               `json:"publishedAtUnixMs,omitempty"`
	StartedAtUnixMs   *int64               `json:"startedAtUnixMs,omitempty"`
	CompletedAtUnixMs *int64               `json:"completedAtUnixMs,omitempty"`
	CancelledAtUnixMs *int64               `json:"cancelledAtUnixMs,omitempty"`
	// HiddenAtUnixMs is when it was taken off the public board, and nil for an
	// event that is on it. A hidden event still exists everywhere else — see
	// SetTournamentHidden, which is the whole explanation.
	HiddenAtUnixMs *int64 `json:"hiddenAtUnixMs,omitempty"`
}

type TournamentPlayer struct {
	PlayerID               int64  `json:"playerId"`
	UserID                 string `json:"userId"`
	IGN                    string `json:"ign"`
	Discord                string `json:"discord"`
	AgreedToUnfilteredChat bool   `json:"agreedToUnfilteredChat"`
	SignupOrder            int    `json:"signupOrder"`
	// Seed is this entrant's position in the seeding, set when the event
	// starts and zero before that. Every round after the first is paired from
	// it — see ensureTournamentConfigSchema.
	Seed           int   `json:"seed,omitempty"`
	JoinedAtUnixMs int64 `json:"joinedAtUnixMs"`
}

type TournamentStanding struct {
	Rank     int    `json:"rank"`
	PlayerID int64  `json:"playerId"`
	IGN      string `json:"ign"`
	Discord  string `json:"discord"`
	Played   int    `json:"played"`
	Wins     int    `json:"wins"`
	Losses   int    `json:"losses"`
	Draws    int    `json:"draws"`
	// Byes is how many rounds this entrant sat out. Each one is scored as a
	// win — see swissStateOf — so this is here to explain a win count that is
	// larger than the games played.
	Byes   int `json:"byes,omitempty"`
	Points int `json:"points"`
	// EliminatedInRound is the round a knockout entrant went out in, and nil
	// for somebody still in it. Only ever set for an elimination bracket,
	// where it is what the ranking is built on rather than points.
	EliminatedInRound *int `json:"eliminatedInRound,omitempty"`
	Seed              int  `json:"seed,omitempty"`
	SignupOrder       int  `json:"signupOrder"`
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
	// GamesPlayed and the two scores are how far through a multi-game match the
	// pairing is. All zero on a match of one game until it is played, at which
	// point Result says the same thing more simply — so a screen showing a
	// single-game event can ignore them entirely.
	GamesPlayed   int     `json:"gamesPlayed,omitempty"`
	Player1Points float64 `json:"player1Points,omitempty"`
	Player2Points float64 `json:"player2Points,omitempty"`
}

// SignupForTournament enters one account, subject to every rule the door has.
//
// One of those rules is one place per party — see tournamentPartyID — which is
// what makes "yourself, or exactly one of your bots" true. HostSignupForTournament
// is the same door with that one rule lifted.
func (store *Store) SignupForTournament(
	ctx context.Context,
	tournamentID string,
	userID string,
	ign string,
	discord string,
	agreedToUnfilteredChat bool,
) (Tournament, error) {
	return store.signup(ctx, tournamentID, userID, ign, discord, agreedToUnfilteredChat, true)
}

// HostSignupForTournament enters an account on the host's authority, without
// the one-place-per-party rule.
//
// The rule it lifts is about *self-service*: an entrant choosing between
// themselves and their engines has one place, because an author who could enter
// four engines into a six-place event has taken the event. A host filling a
// bots-only field is not that — they are looking at the engines that are up and
// deciding the field should contain them, and an author who happens to run two
// of the four is not gaming anything. So the sweep may seat both, and nothing an
// owner can press ever reaches this.
//
// Everything else still applies, including the stage, the field rule, the cap,
// and the unique constraint that stops one account being seated twice.
func (store *Store) HostSignupForTournament(
	ctx context.Context,
	tournamentID string,
	userID string,
	ign string,
	discord string,
) (Tournament, error) {
	// The chat agreement is asserted rather than asked, because there is nobody
	// to ask: a program has no view on it, and the host adding it has one.
	return store.signup(ctx, tournamentID, userID, ign, discord, true, false)
}

func (store *Store) signup(
	ctx context.Context,
	tournamentID string,
	userID string,
	ign string,
	discord string,
	agreedToUnfilteredChat bool,
	onePlacePerParty bool,
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

	// Everything the door has to check, in one read: which stage the event is
	// at, who it admits, and how many it holds.
	var stored TournamentStatus
	var publishedAt, cancelledAt *int64
	var fieldRule TournamentField
	var maxPlayers int
	if err := transaction.QueryRowContext(ctx, `
SELECT status, published_at_unix_ms, cancelled_at_unix_ms, field_rule, max_players
FROM tournaments WHERE tournament_id = ?
`, tournamentID).Scan(
		&stored, &publishedAt, &cancelledAt, &fieldRule, &maxPlayers,
	); errors.Is(err, sql.ErrNoRows) {
		return Tournament{}, ErrTournamentNotFound
	} else if err != nil {
		return Tournament{}, fmt.Errorf("sign up for tournament: read tournament: %w", err)
	}
	switch derivedStatus(stored, publishedAt, cancelledAt) {
	case TournamentCancelled:
		return Tournament{}, ErrTournamentCancelled
	case TournamentRegistration:
		// Open. Everything below applies.
	default:
		// A draft is closed for the same reason a finished event is: nobody
		// outside the host's own screen is supposed to know it exists yet, and
		// the one thing worse than a signup form nobody can find is one that
		// silently enters people into an event that has not been announced.
		return Tournament{}, ErrTournamentClosed
	}

	// The field rule is enforced against the account's kind rather than
	// against anything the signup says about itself, because the signup is a
	// form somebody filled in and `accounts.kind` is what the server knows. An
	// entrant with no account on record reads as human, which is what a
	// hand-entered signup is.
	kind := AccountKindHuman
	var verifiedDiscordUserID, verifiedDiscordHandle string
	if err := transaction.QueryRowContext(ctx,
		`SELECT kind, discord_user_id, discord FROM accounts WHERE user_id = ?`, userID,
	).Scan(&kind, &verifiedDiscordUserID, &verifiedDiscordHandle); err != nil &&
		!errors.Is(err, sql.ErrNoRows) {
		return Tournament{}, fmt.Errorf("sign up for tournament: read account: %w", err)
	}
	if fieldRule == "" {
		fieldRule = FieldOpen
	}
	if !fieldRule.Admits(kind) {
		return Tournament{}, fmt.Errorf("%w: %s", ErrTournamentFieldClosed, fieldRule.Label())
	}

	// The verification door, and it is unconditional: every entrant in every
	// event is somebody Discord has vouched for.
	//
	// It is asked of the **party** rather than of the account playing, which is
	// what lets it apply to engines at all. A program has no Discord account and
	// never will, so the question for a bot is whether the person who entered it
	// is verified — the same person a host has to reach when it stops turning
	// up, and the same person the one-place rule is about. That makes the answer
	// "yes, both human and bot entries" rather than the exemption engines used
	// to get.
	party, err := tournamentPartyID(ctx, transaction, userID)
	if err != nil {
		return Tournament{}, err
	}
	if party != userID {
		if err := transaction.QueryRowContext(ctx,
			`SELECT discord_user_id, discord FROM accounts WHERE user_id = ?`, party,
		).Scan(&verifiedDiscordUserID, &verifiedDiscordHandle); err != nil &&
			!errors.Is(err, sql.ErrNoRows) {
			return Tournament{}, fmt.Errorf("sign up for tournament: read owner: %w", err)
		}
	}
	if strings.TrimSpace(verifiedDiscordUserID) == "" {
		return Tournament{}, ErrTournamentDiscordRequired
	}
	// The handle typed into the form is discarded in favour of the one Discord
	// vouched for. Without this the requirement buys nothing: an entrant could
	// verify as one account and write somebody else's handle on the form, which
	// is exactly the substitution this exists to prevent. It also means the host
	// contacting the field is using handles that are known to resolve — and for
	// an engine it is how "bot.fishy", which reaches nobody, becomes its
	// author's handle, which reaches somebody.
	//
	// Bounded by the same 2-to-64 rule the typed handle is held to, so the
	// substitution cannot store something a person would have been refused for
	// writing.
	handle := storedDiscordHandle(verifiedDiscordHandle)
	if length := utf8.RuneCountInString(handle); length >= 2 && length <= 64 {
		discord = handle
	}

	// One entry per party, which is the rule that makes "yourself, or one of
	// your bots" mean something. Checked inside the transaction that inserts,
	// so two tabs cannot each see an empty slot for the same owner. Lifted for
	// the host's sweep — see HostSignupForTournament.
	if onePlacePerParty {
		if held, found, err := tournamentEntryOfParty(
			ctx, transaction, tournamentID, party,
		); err != nil {
			return Tournament{}, err
		} else if found {
			return Tournament{}, fmt.Errorf("%w, as %s", ErrTournamentAlreadyEntered, held.IGN)
		}
	}

	if maxPlayers > 0 {
		var entered int
		if err := transaction.QueryRowContext(ctx,
			`SELECT COUNT(*) FROM tournament_players WHERE tournament_id = ?`, tournamentID,
		).Scan(&entered); err != nil {
			return Tournament{}, fmt.Errorf("sign up for tournament: count field: %w", err)
		}
		// Inside the transaction that inserts, so two signups racing for the
		// last place cannot both see room for themselves.
		if entered >= maxPlayers {
			return Tournament{}, fmt.Errorf("%w: %d places", ErrTournamentFull, maxPlayers)
		}
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

// A party is who an entry belongs to, and it is not always the account playing.
//
// An engine plays under an account of its own, but it does not decide anything:
// its owner enters it, withdraws it, and answers for it. So for every question
// of the form "is this entrant already in?" the account that matters is the
// owner's, and a person's party is simply themselves.
//
// That is the whole of the "yourself, or exactly one of your bots" rule. It is
// derived from `bots.owner_user_id` rather than stored on the signup, so it
// stays true for the events that were entered before any of this existed, and
// there is no second copy of ownership to fall out of step with the first.
func tournamentPartyID(
	ctx context.Context,
	queryer tournamentQueryer,
	userID string,
) (string, error) {
	userID = strings.TrimSpace(userID)
	var owner string
	err := queryer.QueryRowContext(ctx,
		`SELECT owner_user_id FROM bots WHERE user_id = ?`, userID,
	).Scan(&owner)
	switch {
	case errors.Is(err, sql.ErrNoRows):
		// Not an engine, so the account answers for itself.
		return userID, nil
	case err != nil:
		return "", fmt.Errorf("read tournament party: %w", err)
	}
	return owner, nil
}

// tournamentEntryOfParty is the one entry a party holds in an event, if any.
//
// The LEFT JOIN is what makes the comparison work in both directions at once:
// an entry's party is its bot's owner when there is a bot row for it, and the
// entrant themselves when there is not.
func tournamentEntryOfParty(
	ctx context.Context,
	queryer tournamentQueryer,
	tournamentID string,
	party string,
) (TournamentPlayer, bool, error) {
	var player TournamentPlayer
	var agreed int
	err := queryer.QueryRowContext(ctx, `
SELECT tp.player_id, tp.user_id, tp.ign, tp.discord, tp.agreed_to_unfiltered_chat,
       tp.signup_order, tp.seed, tp.joined_at_unix_ms
FROM tournament_players tp
LEFT JOIN bots b ON b.user_id = tp.user_id
WHERE tp.tournament_id = ? AND COALESCE(b.owner_user_id, tp.user_id) = ?
ORDER BY tp.signup_order
LIMIT 1
`, tournamentID, party).Scan(
		&player.PlayerID, &player.UserID, &player.IGN, &player.Discord, &agreed,
		&player.SignupOrder, &player.Seed, &player.JoinedAtUnixMs,
	)
	switch {
	case errors.Is(err, sql.ErrNoRows):
		return TournamentPlayer{}, false, nil
	case err != nil:
		return TournamentPlayer{}, false, fmt.Errorf("read tournament entry: %w", err)
	}
	player.AgreedToUnfilteredChat = agreed == 1
	return player, true, nil
}

// TournamentEntryFor is the entry an account is answerable for in an event:
// their own, or the one their bot is playing.
//
// Answers to either end of the pair — pass an owner or pass a bot's account and
// the same row comes back — so a caller that only has one of the two does not
// have to work out which it is holding.
func (store *Store) TournamentEntryFor(
	ctx context.Context,
	tournamentID string,
	userID string,
) (TournamentPlayer, error) {
	party, err := tournamentPartyID(ctx, store.db, strings.TrimSpace(userID))
	if err != nil {
		return TournamentPlayer{}, err
	}
	entry, found, err := tournamentEntryOfParty(
		ctx, store.db, strings.TrimSpace(tournamentID), party,
	)
	if err != nil {
		return TournamentPlayer{}, err
	}
	if !found {
		return TournamentPlayer{}, ErrTournamentEntryNotFound
	}
	return entry, nil
}

// WithdrawTournamentEntry takes a party's entry back out of an event.
//
// The entrant's own door, where WithdrawFromTournament is the host's and the
// bot drain's: it removes whatever this account is answerable for rather than
// an account named from outside, so an owner can change their mind about which
// engine they are entering without going through the host.
//
// Registration only, for the reason WithdrawFromTournament gives at length: a
// name that leaves before the pairings exist costs nothing, and one that leaves
// afterwards rewrites games that have been played.
func (store *Store) WithdrawTournamentEntry(
	ctx context.Context,
	tournamentID string,
	userID string,
) (Tournament, TournamentPlayer, error) {
	tournamentID = strings.TrimSpace(tournamentID)

	transaction, err := store.db.BeginTx(ctx, nil)
	if err != nil {
		return Tournament{}, TournamentPlayer{}, fmt.Errorf(
			"withdraw tournament entry: begin transaction: %w", err)
	}
	defer func() { _ = transaction.Rollback() }()

	var stored TournamentStatus
	var publishedAt, cancelledAt *int64
	if err := transaction.QueryRowContext(ctx, `
SELECT status, published_at_unix_ms, cancelled_at_unix_ms
FROM tournaments WHERE tournament_id = ?
`, tournamentID).Scan(&stored, &publishedAt, &cancelledAt); errors.Is(err, sql.ErrNoRows) {
		return Tournament{}, TournamentPlayer{}, ErrTournamentNotFound
	} else if err != nil {
		return Tournament{}, TournamentPlayer{}, fmt.Errorf(
			"withdraw tournament entry: read tournament: %w", err)
	}
	switch derivedStatus(stored, publishedAt, cancelledAt) {
	case TournamentCancelled:
		return Tournament{}, TournamentPlayer{}, ErrTournamentCancelled
	case TournamentRegistration:
		// Open. This is the only stage an entrant may leave under their own
		// steam.
	default:
		return Tournament{}, TournamentPlayer{}, ErrTournamentAlreadyStarted
	}

	party, err := tournamentPartyID(ctx, transaction, strings.TrimSpace(userID))
	if err != nil {
		return Tournament{}, TournamentPlayer{}, err
	}
	entry, found, err := tournamentEntryOfParty(ctx, transaction, tournamentID, party)
	if err != nil {
		return Tournament{}, TournamentPlayer{}, err
	}
	if !found {
		return Tournament{}, TournamentPlayer{}, ErrTournamentEntryNotFound
	}
	if _, err := transaction.ExecContext(ctx,
		`DELETE FROM tournament_players WHERE tournament_id = ? AND player_id = ?`,
		tournamentID, entry.PlayerID,
	); err != nil {
		return Tournament{}, TournamentPlayer{}, fmt.Errorf(
			"withdraw tournament entry: delete player: %w", err)
	}
	if err := transaction.Commit(); err != nil {
		return Tournament{}, TournamentPlayer{}, fmt.Errorf(
			"withdraw tournament entry: commit: %w", err)
	}
	tournament, err := store.Tournament(ctx, tournamentID)
	return tournament, entry, err
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

	var stored TournamentStatus
	var publishedAt, cancelledAt *int64
	var format TournamentFormat
	if err := transaction.QueryRowContext(ctx, `
SELECT status, published_at_unix_ms, cancelled_at_unix_ms, format
FROM tournaments WHERE tournament_id = ?
`, tournamentID).Scan(
		&stored, &publishedAt, &cancelledAt, &format,
	); errors.Is(err, sql.ErrNoRows) {
		return Tournament{}, ErrTournamentNotFound
	} else if err != nil {
		return Tournament{}, fmt.Errorf("set tournament result: read tournament: %w", err)
	}
	switch derivedStatus(stored, publishedAt, cancelledAt) {
	case TournamentCancelled:
		return Tournament{}, ErrTournamentCancelled
	case TournamentDraft, TournamentRegistration:
		return Tournament{}, ErrTournamentMatchNotFound
	}

	var player1ID, player2ID int64
	var roundNumber int
	if err := transaction.QueryRowContext(ctx, `
SELECT player1_id, player2_id, round_number
FROM tournament_matches
WHERE tournament_id = ? AND match_id = ?
`, tournamentID, matchID).Scan(
		&player1ID, &player2ID, &roundNumber,
	); errors.Is(err, sql.ErrNoRows) {
		return Tournament{}, ErrTournamentMatchNotFound
	} else if err != nil {
		return Tournament{}, fmt.Errorf("set tournament result: read match: %w", err)
	}

	// A progressive format's later rounds were paired *from* this result. In a
	// bracket, changing who won a quarter-final does not change who is in the
	// semi-final that has already been played — it just makes the two disagree,
	// permanently and invisibly. So it is refused, and the host is told which
	// of the two things they might have meant is available: rewind, or leave it.
	if format.Progressive() {
		var laterRounds int
		if err := transaction.QueryRowContext(ctx, `
SELECT COUNT(*) FROM tournament_matches
WHERE tournament_id = ? AND round_number > ?
`, tournamentID, roundNumber).Scan(&laterRounds); err != nil {
			return Tournament{}, fmt.Errorf("set tournament result: count later rounds: %w", err)
		}
		if laterRounds > 0 {
			return Tournament{}, fmt.Errorf(
				"%w: round %d has already been paired from this result, so it can no longer be edited",
				ErrInvalidTournament, roundNumber+1,
			)
		}
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
	// "No pending matches" finishes a fixed-format event, because its whole
	// schedule was created at the start. For a progressive one it only means
	// the current round is over, and whether there is another is a question for
	// AdvanceTournament below.
	if pendingMatches == 0 && !format.Progressive() {
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
	// Done here rather than left to the caller. Two paths record results — a
	// finished game and a host editing the table — and a bracket that only
	// advances from one of them is a bracket that stalls whenever the other one
	// closes a round.
	if format.Progressive() && pendingMatches == 0 {
		return store.AdvanceTournament(ctx, tournamentID)
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
	var stored TournamentStatus
	err := queryer.QueryRowContext(ctx, `
SELECT tournament_id, name, description, mode_id, mode_name, status,
       format, field_rule, seeding, max_players, swiss_rounds, games_per_match,
       kind, nightly_number, initial_time_ms, increment_ms, starts_at_unix_ms,
       created_at_unix_ms, published_at_unix_ms, started_at_unix_ms,
       completed_at_unix_ms, cancelled_at_unix_ms, hidden_at_unix_ms
FROM tournaments
WHERE tournament_id = ?
`, tournamentID).Scan(
		&tournament.TournamentID,
		&tournament.Name,
		&tournament.Description,
		&tournament.ModeID,
		&tournament.ModeName,
		&stored,
		&tournament.Format,
		&tournament.Field,
		&tournament.Seeding,
		&tournament.MaxPlayers,
		&tournament.SwissRounds,
		&tournament.GamesPerMatch,
		&tournament.Kind,
		&tournament.WeekendNumber,
		&tournament.InitialTimeMs,
		&tournament.IncrementMs,
		&tournament.StartsAtUnixMs,
		&tournament.CreatedAtUnixMs,
		&tournament.PublishedAtUnixMs,
		&tournament.StartedAtUnixMs,
		&tournament.CompletedAtUnixMs,
		&tournament.CancelledAtUnixMs,
		&tournament.HiddenAtUnixMs,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return Tournament{}, ErrTournamentNotFound
	}
	if err != nil {
		return Tournament{}, fmt.Errorf("read tournament: %w", err)
	}
	// The five-value status the API publishes, out of the three-value column
	// plus the two timestamps. See the note at the top of tournament_admin.go.
	tournament.Status = derivedStatus(
		stored, tournament.PublishedAtUnixMs, tournament.CancelledAtUnixMs,
	)

	players, playerByID, err := readTournamentPlayers(ctx, queryer, tournamentID)
	if err != nil {
		return Tournament{}, err
	}
	matches, err := readTournamentMatches(ctx, queryer, tournamentID, playerByID)
	if err != nil {
		return Tournament{}, err
	}
	byes, err := readTournamentByes(ctx, queryer, tournamentID, playerByID)
	if err != nil {
		return Tournament{}, err
	}
	tournament.Players = players
	tournament.Matches = matches
	tournament.Byes = byes
	tournament.Rounds = plannedRounds(tournament.Format, len(players), tournament.SwissRounds)
	tournament.Standings = tournamentStandings(tournament.Format, players, matches, byes)
	return tournament, nil
}

func readTournamentPlayers(
	ctx context.Context,
	queryer tournamentQueryer,
	tournamentID string,
) ([]TournamentPlayer, map[int64]TournamentPlayer, error) {
	rows, err := queryer.QueryContext(ctx, `
SELECT player_id, user_id, ign, discord, agreed_to_unfiltered_chat,
       signup_order, seed, joined_at_unix_ms
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
			&player.Seed,
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
	// Closed before the second query rather than left to the defer: this store
	// runs on a single SQLite connection, and a second read issued while these
	// rows are still open is asking one connection to do two things at once.
	if err := rows.Close(); err != nil {
		return nil, fmt.Errorf("read tournament matches: %w", err)
	}
	if err := attachMatchGames(ctx, queryer, tournamentID, matches); err != nil {
		return nil, err
	}
	return matches, nil
}

// attachMatchGames fills in the per-match running score of a multi-game event.
//
// One query for the whole board rather than one per match: a Swiss round of ten
// pairings is ten matches, and a tournament is read on every broadcast.
func attachMatchGames(
	ctx context.Context,
	queryer tournamentQueryer,
	tournamentID string,
	matches []TournamentMatch,
) error {
	rows, err := queryer.QueryContext(ctx, `
SELECT match_id, COUNT(*), COALESCE(SUM(player1_points_x2), 0)
FROM tournament_match_games
WHERE tournament_id = ?
GROUP BY match_id
`, tournamentID)
	if err != nil {
		return fmt.Errorf("read tournament match games: %w", err)
	}
	defer rows.Close()
	type tally struct {
		games    int
		pointsX2 int
	}
	played := make(map[int64]tally)
	for rows.Next() {
		var matchID int64
		var counted tally
		if err := rows.Scan(&matchID, &counted.games, &counted.pointsX2); err != nil {
			return fmt.Errorf("read tournament match games: %w", err)
		}
		played[matchID] = counted
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("read tournament match games: %w", err)
	}
	for index := range matches {
		counted, found := played[matches[index].MatchID]
		if !found {
			continue
		}
		matches[index].GamesPlayed = counted.games
		matches[index].Player1Points = float64(counted.pointsX2) / 2
		// The other side's score is what is left of the games played, which is
		// why only one of the two is stored.
		matches[index].Player2Points = float64(counted.games) - matches[index].Player1Points
	}
	return nil
}

// tournamentStandings is the table, computed from the schedule.
//
// Two rankings, chosen by format. Points decide a round robin or a Swiss, which
// is what this has always done. A knockout is ranked by how far each entrant
// got instead: in a bracket the runner-up has one loss and so does everybody
// knocked out in round one, and a points table would sort the final's loser
// somewhere in the middle of the field they beat to get there.
func tournamentStandings(
	format TournamentFormat,
	players []TournamentPlayer,
	matches []TournamentMatch,
	byes []TournamentBye,
) []TournamentStanding {
	standings := make([]TournamentStanding, 0, len(players))
	standingByPlayerID := make(map[int64]*TournamentStanding, len(players))
	for _, player := range players {
		standing := TournamentStanding{
			PlayerID:    player.PlayerID,
			IGN:         player.IGN,
			Discord:     player.Discord,
			Seed:        player.Seed,
			SignupOrder: player.SignupOrder,
		}
		standings = append(standings, standing)
		standingByPlayerID[player.PlayerID] = &standings[len(standings)-1]
	}
	// Byes first, so that a player whose only round so far was a bye still has
	// a point beside their name rather than an empty row.
	for _, bye := range byes {
		standing := standingByPlayerID[bye.PlayerID]
		if standing == nil {
			continue
		}
		standing.Byes++
		standing.Wins++
		standing.Points += 3
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
	if format.Knockout() {
		markEliminations(standings, standingByPlayerID, matches)
	}
	sort.SliceStable(standings, func(i, j int) bool {
		if format.Knockout() {
			// Still in it beats out of it; out later beats out earlier.
			firstOut, secondOut := standings[i].EliminatedInRound, standings[j].EliminatedInRound
			if (firstOut == nil) != (secondOut == nil) {
				return firstOut == nil
			}
			if firstOut != nil && *firstOut != *secondOut {
				return *firstOut > *secondOut
			}
			// Level on rounds survived — two semi-finalists, say — falls back
			// to the seeding they were given, which is the only ordering a
			// bracket ever claimed between them.
			if standings[i].Seed != standings[j].Seed {
				return standings[i].Seed < standings[j].Seed
			}
			return standings[i].SignupOrder < standings[j].SignupOrder
		}
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

// markEliminations records the round each knockout entrant went out in.
//
// A drawn knockout match eliminates the lower seed, matching the rule
// eliminationSurvivors advances by — the two have to agree, or the bracket
// would carry somebody forward that the table has already knocked out.
func markEliminations(
	standings []TournamentStanding,
	standingByPlayerID map[int64]*TournamentStanding,
	matches []TournamentMatch,
) {
	seedOf := make(map[int64]int, len(standings))
	for index := range standings {
		seedOf[standings[index].PlayerID] = standings[index].Seed
	}
	for _, match := range matches {
		if match.Result == MatchPending {
			continue
		}
		loser := int64(0)
		switch match.Result {
		case MatchPlayer1Win:
			loser = match.Player2.PlayerID
		case MatchPlayer2Win:
			loser = match.Player1.PlayerID
		case MatchDraw:
			loser = match.Player2.PlayerID
			if seedOf[match.Player2.PlayerID] < seedOf[match.Player1.PlayerID] {
				loser = match.Player1.PlayerID
			}
		}
		standing := standingByPlayerID[loser]
		if standing == nil {
			continue
		}
		round := match.RoundNumber
		standing.EliminatedInRound = &round
	}
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

// RecordTournamentMatchGame files one finished game of a scheduled match, and
// closes the match when it was the last one.
//
// `player1PointsX2` is the *first player's* score for that game, doubled: 2 for
// a win, 1 for a draw, 0 for a loss. Doubled because a draw is a half point and
// the column is an integer; the first player's because the colours swap every
// game — see startTournamentMatch — so "Red won" does not say who won without
// knowing which game it was.
//
// Returns the tournament and whether the match is now resolved. A caller that
// gets false has another game to start; one that gets true has a result in the
// standings. A single-game match resolves on its first call, which is what
// every event that never sets GamesPerMatch does.
//
// The aggregate is played out in full rather than stopped once a side cannot be
// caught. Cutting a 4-game match at 3–0 would leave an odd number of games
// played, which hands one side an extra turn at opening — and cancelling that
// advantage is the whole reason a match is more than one game.
func (store *Store) RecordTournamentMatchGame(
	ctx context.Context,
	tournamentID string,
	matchID int64,
	gameID string,
	player1PointsX2 int,
) (Tournament, bool, error) {
	tournamentID = strings.TrimSpace(tournamentID)
	if player1PointsX2 < 0 || player1PointsX2 > 2 {
		return Tournament{}, false, fmt.Errorf(
			"%w: a game score must be 0, 1 or 2 half-points", ErrInvalidTournament)
	}

	transaction, err := store.db.BeginTx(ctx, nil)
	if err != nil {
		return Tournament{}, false, fmt.Errorf(
			"record tournament match game: begin transaction: %w", err)
	}
	defer func() { _ = transaction.Rollback() }()

	var target int
	if err := transaction.QueryRowContext(ctx,
		`SELECT games_per_match FROM tournaments WHERE tournament_id = ?`, tournamentID,
	).Scan(&target); errors.Is(err, sql.ErrNoRows) {
		return Tournament{}, false, ErrTournamentNotFound
	} else if err != nil {
		return Tournament{}, false, fmt.Errorf(
			"record tournament match game: read tournament: %w", err)
	}
	if target < 1 {
		target = 1
	}

	var played, pointsX2 int
	if err := transaction.QueryRowContext(ctx, `
SELECT COUNT(*), COALESCE(SUM(player1_points_x2), 0)
FROM tournament_match_games
WHERE tournament_id = ? AND match_id = ?
`, tournamentID, matchID).Scan(&played, &pointsX2); err != nil {
		return Tournament{}, false, fmt.Errorf(
			"record tournament match game: count games: %w", err)
	}
	// A match that has already played its games is not given more. The claim in
	// the server keeps one game per match in flight, so reaching this means
	// something was replayed, and the honest answer is to leave the record as it
	// is rather than to append past the target.
	//
	// Rolled back explicitly before reading the tournament back: this store runs
	// on one SQLite connection, and an open transaction holds it, so a read
	// issued from inside this block would wait on a connection it is itself
	// holding. The deferred rollback is a safety net, not a release point.
	if played >= target {
		if err := transaction.Rollback(); err != nil {
			return Tournament{}, false, fmt.Errorf(
				"record tournament match game: release: %w", err)
		}
		tournament, err := store.Tournament(ctx, tournamentID)
		return tournament, true, err
	}

	if _, err := transaction.ExecContext(ctx, `
INSERT INTO tournament_match_games (
    tournament_id, match_id, game_index, game_id, player1_points_x2, recorded_at_unix_ms
) VALUES (?, ?, ?, ?, ?, ?)
`, tournamentID, matchID, played, strings.TrimSpace(gameID), player1PointsX2,
		time.Now().UnixMilli(),
	); err != nil {
		return Tournament{}, false, fmt.Errorf(
			"record tournament match game: insert game: %w", err)
	}
	if err := transaction.Commit(); err != nil {
		return Tournament{}, false, fmt.Errorf(
			"record tournament match game: commit: %w", err)
	}

	played++
	pointsX2 += player1PointsX2
	if played < target {
		tournament, err := store.Tournament(ctx, tournamentID)
		return tournament, false, err
	}

	// The aggregate. `played` games were worth `played*2` doubled points, so
	// half of them is `played` — which is what the first player has to beat.
	result := MatchDraw
	switch {
	case pointsX2 > played:
		result = MatchPlayer1Win
	case pointsX2 < played:
		result = MatchPlayer2Win
	}
	tournament, err := store.SetTournamentMatchResult(ctx, tournamentID, matchID, result)
	return tournament, true, err
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

// WithdrawFromTournament removes a signup from a tournament that has not
// started.
//
// Only from registration, and that is the whole of the rule. Before the start
// there are no pairings, no results and no standings, so a name leaving costs
// nothing; after it, every other entrant's round robin is built around that
// name being there, and removing it would quietly rewrite games that have
// already been played.
//
// Returns false when there was nothing to remove, so a caller doing this
// speculatively — a bot draining out of every event it is in — does not have to
// look first.
func (store *Store) WithdrawFromTournament(
	ctx context.Context,
	tournamentID string,
	userID string,
) (bool, error) {
	tournamentID = strings.TrimSpace(tournamentID)
	userID = strings.TrimSpace(userID)

	transaction, err := store.db.BeginTx(ctx, nil)
	if err != nil {
		return false, fmt.Errorf("withdraw from tournament: begin transaction: %w", err)
	}
	defer func() { _ = transaction.Rollback() }()

	var status TournamentStatus
	if err := transaction.QueryRowContext(ctx, `
SELECT status FROM tournaments WHERE tournament_id = ?
`, tournamentID).Scan(&status); errors.Is(err, sql.ErrNoRows) {
		return false, ErrTournamentNotFound
	} else if err != nil {
		return false, fmt.Errorf("withdraw from tournament: read tournament: %w", err)
	}
	if status != TournamentRegistration {
		return false, ErrTournamentAlreadyStarted
	}

	outcome, err := transaction.ExecContext(ctx, `
DELETE FROM tournament_players WHERE tournament_id = ? AND user_id = ?
`, tournamentID, userID)
	if err != nil {
		return false, fmt.Errorf("withdraw from tournament: delete player: %w", err)
	}
	removed, _ := outcome.RowsAffected()
	if removed == 0 {
		return false, nil
	}
	if err := transaction.Commit(); err != nil {
		return false, fmt.Errorf("withdraw from tournament: commit: %w", err)
	}
	return true, nil
}
