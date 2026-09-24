package persistence

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"

	"rps-strategy/backend/internal/game"
)

// Building a tournament, rather than playing one.
//
// The old flow was two buttons: create with a name and a mode, then start. Every
// other decision was a constant somewhere — round robin, signup order, default
// clock, open to anybody — and the moment the tournament existed it was already
// taking signups. That last part is the real problem: there was no way to write
// an event down, look at it, fix the name, and *then* let people in. A host
// setting up an event either published a half-finished one or did not use the
// feature.
//
// So a tournament now has a draft stage, and the shape of the lifecycle is:
//
//	draft ──publish──▶ registration ──start──▶ in_progress ──▶ completed
//	  │                     │                      │
//	  └──── delete ─────────┴────── cancel ─────────┘
//
// Draft is where everything is editable and nothing is public. Publishing is
// the one-way-ish door: signups open, and the details freeze except for the
// handful that are still safe to change (see UpdateTournament). Starting closes
// the field and builds the schedule.
//
// # Why `draft` is not a status column value
//
// It would be the obvious spelling, and it is not what this does. The stored
// `tournaments.status` column carries a CHECK constraint listing exactly
// 'registration', 'in_progress' and 'completed'. SQLite cannot alter a CHECK;
// changing it means rebuilding the table, and two other tables hold foreign
// keys into it. Doing that to a live database to add a word is a bad trade.
//
// What is stored instead is the fact underneath: `published_at_unix_ms`. A
// tournament in the registration status that has never been published is a
// draft, and a tournament with `cancelled_at_unix_ms` set is cancelled
// whatever else it says. `derivedStatus` below is the single place those two
// columns become the five-value status the API publishes, and nothing outside
// this file reads the raw column.

// TournamentConfig is every decision a host makes about an event.
//
// One struct for create and update, because they are the same set of answers
// and a field that only one of them accepts is a field the builder cannot
// round-trip.
type TournamentConfig struct {
	Name        string      `json:"name"`
	Description string      `json:"description"`
	ModeID      game.ModeID `json:"modeId"`
	// ModeName is denormalised alongside the id, as it has always been, so a
	// completed event still says what it was played in after a mode is retired
	// and drops out of the registry.
	ModeName string            `json:"modeName"`
	Format   TournamentFormat  `json:"format"`
	Field    TournamentField   `json:"field"`
	Seeding  TournamentSeeding `json:"seeding"`
	// MaxPlayers caps the field; zero is uncapped. A cap is how a round robin
	// stays finishable — see the arithmetic at the top of tournament_format.go.
	MaxPlayers int `json:"maxPlayers"`
	// SwissRounds is the round count for a Swiss event; zero derives it from
	// the field size. Ignored by every other format.
	SwissRounds int `json:"swissRounds"`
	// Kind is the series this event belongs to. Empty means TournamentManual,
	// which is what a host building one by hand gets.
	Kind TournamentKind `json:"kind,omitempty"`
	// WeekendNumber is the serial of a weekend arena, and zero for anything a
	// host built by hand.
	WeekendNumber int `json:"nightlyNumber,omitempty"`
	// GamesPerMatch is how many games one pairing plays; zero and one both mean
	// a single game, which is what every event before this played.
	//
	// More than one exists for fairness rather than for length. The colours
	// swap every game — see startTournamentMatch — so an even number cancels
	// the advantage of opening, which matters here because one side always
	// moves first and engines are good enough for that to decide games. It also
	// halves the noise: a single game between two close engines is close to a
	// coin toss, and a match is not.
	GamesPerMatch int `json:"gamesPerMatch"`
	// InitialTimeMs and IncrementMs are the clock every match is played with,
	// and zero means the server's default. Kept as milliseconds rather than as
	// a game.TimeControl so that "unset" is expressible: a zeroed TimeControl
	// is a legal-looking control with no time on it.
	InitialTimeMs int `json:"initialTimeMs"`
	IncrementMs   int `json:"incrementMs"`
	// StartsAtUnixMs is when the host intends to begin, published so entrants
	// know when to turn up. Advisory only: nothing starts on it, because a
	// tournament that starts itself while its host is asleep and half the field
	// is absent is worse than one that starts late.
	StartsAtUnixMs *int64 `json:"startsAtUnixMs,omitempty"`
}

// DefaultTournamentConfig is what the builder opens on: the behaviour every
// event had before any of this existed.
func DefaultTournamentConfig(modeID game.ModeID, modeName string) TournamentConfig {
	return TournamentConfig{
		ModeID:        modeID,
		ModeName:      modeName,
		Format:        FormatRoundRobin,
		GamesPerMatch: 1,
		Field:         FieldOpen,
		Seeding:       SeedBySignup,
	}
}

// normalize fills the blanks a client is allowed to leave blank, so that an
// older client — or a hand-written request — cannot store an empty format that
// no pairing engine matches.
func (config *TournamentConfig) normalize() {
	config.Name = strings.TrimSpace(config.Name)
	config.Description = strings.TrimSpace(config.Description)
	config.ModeName = strings.TrimSpace(config.ModeName)
	if config.Format == "" {
		config.Format = FormatRoundRobin
	}
	if config.Field == "" {
		config.Field = FieldOpen
	}
	if config.Seeding == "" {
		config.Seeding = SeedBySignup
	}
}

var (
	// ErrTournamentPublished is the answer to editing something that is only
	// editable in draft.
	ErrTournamentPublished = errors.New("tournament has already been published")
	// ErrTournamentFull is the answer to a signup that would exceed the cap.
	ErrTournamentFull = errors.New("tournament is full")
	// ErrTournamentFieldClosed is the answer to a bot entering a humans-only
	// event, or a person entering a bots-only one.
	ErrTournamentFieldClosed = errors.New("this tournament is not open to that kind of player")
	// ErrTournamentDiscordRequired is the answer to somebody entering an event
	// that wants verified entrants, from an account that has not linked
	// Discord. Distinct from ErrTournamentFieldClosed because the remedy is
	// completely different: this one is fixable in about ten seconds, and the
	// message needs to say so rather than reading like a refusal.
	ErrTournamentDiscordRequired = errors.New(
		"this tournament is only open to players who have verified their account with Discord",
	)
	// ErrTournamentCancelled is the answer to anything at all, once an event has
	// been called off.
	ErrTournamentCancelled = errors.New("tournament has been cancelled")
	// ErrTournamentNotHideable is the answer to hiding an event people still
	// need to find. See SetTournamentHidden.
	ErrTournamentNotHideable = errors.New(
		"only a finished or cancelled tournament can be hidden",
	)
)

// TournamentDeletion is what a hard delete removed, so the host is told rather
// than left to guess.
//
// Modelled on AccountPurge, and for the same reason: a destructive action
// should report its own scope. "Deleted Summer Cup: 8 entrants, 28 matches" is
// a sentence somebody can check against what they meant to do.
type TournamentDeletion struct {
	TournamentID   string           `json:"tournamentId"`
	Name           string           `json:"name"`
	Status         TournamentStatus `json:"status"`
	PlayersDeleted int              `json:"playersDeleted"`
	MatchesDeleted int              `json:"matchesDeleted"`
	ByesDeleted    int              `json:"byesDeleted"`
	// ChampionUserIDs is whoever won it, when it was a completed event.
	//
	// Reported because of a consequence that is otherwise invisible: the
	// Tournament Champion title is *recomputed* from this table rather than
	// stored as a fact — see tournamentTitles — so deleting the event takes the
	// title away from whoever won it, the next time titles are evaluated. A
	// host deleting a played event should be told whose title they are about to
	// remove.
	ChampionUserIDs []string `json:"championUserIds,omitempty"`
	// GamesKept is how many recorded games mentioned this event and are staying.
	//
	// They are not the tournament's to delete. Two people played them, they are
	// in both histories and in the archive, and the rating they moved has
	// already moved. The schedule that arranged them is what goes.
	GamesKept int `json:"gamesKept"`
}

// ensureTournamentConfigSchema adds everything the builder needs.
//
// Three groups: the configuration columns on `tournaments`, the seed column on
// `tournament_players`, and the byes table. See TournamentBye for why a bye is
// not a match row.
func (store *Store) ensureTournamentConfigSchema(ctx context.Context) error {
	columns, err := tableColumns(ctx, store.db, "tournaments")
	if err != nil {
		return fmt.Errorf("inspect tournament schema: %w", err)
	}
	// Whether this run is the one that introduces publishing. The backfill
	// below must happen exactly once, and only for the events that existed
	// before the column did.
	adoptingPublication := !columns["published_at_unix_ms"]
	for _, migration := range []struct {
		name       string
		definition string
	}{
		{name: "description", definition: "TEXT NOT NULL DEFAULT ''"},
		{name: "format", definition: "TEXT NOT NULL DEFAULT 'round_robin'"},
		// `field_rule` rather than `field`: the column is a rule about who may
		// enter, and a bare `field` beside `format` reads like a column of the
		// tournament rather than a constraint on it.
		{name: "field_rule", definition: "TEXT NOT NULL DEFAULT 'open'"},
		{name: "seeding", definition: "TEXT NOT NULL DEFAULT 'signup'"},
		{name: "max_players", definition: "INTEGER NOT NULL DEFAULT 0"},
		{name: "swiss_rounds", definition: "INTEGER NOT NULL DEFAULT 0"},
		// Whether entrants must have a verified Discord identity. Defaults to
		// off, which is what every event before it behaved as.
		// Retained, and nothing reads it. It was the host's per-event switch for
		// "verified entrants only", which is now unconditional and asked of the
		// party rather than the account — see the door in SignupForTournament.
		// The column stays because every existing row has one and dropping a
		// column in SQLite means rewriting the table for no gain.
		{name: "require_discord", definition: "INTEGER NOT NULL DEFAULT 0"},
		// How many games one pairing plays. One unless a host says otherwise,
		// which is what every event before this behaved as. See
		// RecordTournamentMatchGame for what more than one buys.
		{name: "games_per_match", definition: "INTEGER NOT NULL DEFAULT 1"},
		// Which series an event belongs to. "manual" is a one-off a host built;
		// "nightly" is one the recurring schedule created — the stored spelling
		// of what the code now calls a weekend arena, kept because the archive is
		// full of it. See TournamentKind. It decides what the public board lists
		// and what the Tournament Champion title counts, so it is a column rather
		// than a name convention.
		{name: "kind", definition: "TEXT NOT NULL DEFAULT 'manual'"},
		// The weekend arena's serial number, and zero on everything else.
		// Sequential so an event has a name people can say: "Weekend #142".
		{name: "nightly_number", definition: "INTEGER NOT NULL DEFAULT 0"},
		{name: "initial_time_ms", definition: "INTEGER NOT NULL DEFAULT 0"},
		{name: "increment_ms", definition: "INTEGER NOT NULL DEFAULT 0"},
		{name: "starts_at_unix_ms", definition: "INTEGER"},
		{name: "published_at_unix_ms", definition: "INTEGER"},
		{name: "cancelled_at_unix_ms", definition: "INTEGER"},
		// When it was taken off the public board. See SetTournamentHidden for
		// what hiding does and does not do.
		{name: "hidden_at_unix_ms", definition: "INTEGER"},
	} {
		if columns[migration.name] {
			continue
		}
		statement := fmt.Sprintf(
			"ALTER TABLE tournaments ADD COLUMN %s %s", migration.name, migration.definition,
		)
		if _, err := store.db.ExecContext(ctx, statement); err != nil {
			return fmt.Errorf("add tournament %s column: %w", migration.name, err)
		}
	}
	if adoptingPublication {
		// Every event that already exists was public the moment it was created,
		// because that was the only thing a tournament could be. Without this
		// they would all come back as drafts — a live event would vanish from
		// the board and stop taking signups on the next deploy.
		if _, err := store.db.ExecContext(ctx, `
UPDATE tournaments
SET published_at_unix_ms = created_at_unix_ms
WHERE published_at_unix_ms IS NULL
`); err != nil {
			return fmt.Errorf("backfill tournament publication: %w", err)
		}
	}

	playerColumns, err := tableColumns(ctx, store.db, "tournament_players")
	if err != nil {
		return fmt.Errorf("inspect tournament player schema: %w", err)
	}
	if !playerColumns["seed"] {
		// The seeding position the schedule was built from. Stored rather than
		// recomputed because a bracket re-seeds every round — see
		// eliminationNextRound — and recomputing from live ratings would
		// reorder a half-played bracket every time somebody's rating moved.
		if _, err := store.db.ExecContext(ctx,
			"ALTER TABLE tournament_players ADD COLUMN seed INTEGER NOT NULL DEFAULT 0",
		); err != nil {
			return fmt.Errorf("add tournament player seed column: %w", err)
		}
	}

	const byes = `
-- The games of one scheduled match, when a match is more than one game.
--
-- A row per game rather than a running total on the match, because the games
-- are the record: a crosstable that says 2½–1½ is not readable without them,
-- and a replay of a match is a list of boards. The score is stored doubled so
-- that a draw is an integer.
CREATE TABLE IF NOT EXISTS tournament_match_games (
    tournament_id TEXT NOT NULL REFERENCES tournaments(tournament_id) ON DELETE CASCADE,
    match_id INTEGER NOT NULL REFERENCES tournament_matches(match_id) ON DELETE CASCADE,
    game_index INTEGER NOT NULL CHECK (game_index >= 0),
    game_id TEXT NOT NULL,
    -- The first player's score for this game, doubled: 2 a win, 1 a draw, 0 a
    -- loss. From the pairing's point of view rather than the board's, because
    -- the colours swap every game and a board result is not comparable across
    -- the games of one match.
    player1_points_x2 INTEGER NOT NULL CHECK (player1_points_x2 BETWEEN 0 AND 2),
    recorded_at_unix_ms INTEGER NOT NULL,
    PRIMARY KEY (tournament_id, match_id, game_index)
);

CREATE TABLE IF NOT EXISTS tournament_byes (
    tournament_id TEXT NOT NULL REFERENCES tournaments(tournament_id) ON DELETE CASCADE,
    round_number INTEGER NOT NULL CHECK (round_number > 0),
    player_id INTEGER NOT NULL REFERENCES tournament_players(player_id),
    reason TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (tournament_id, round_number, player_id)
);
`
	if _, err := store.db.ExecContext(ctx, byes); err != nil {
		return fmt.Errorf("migrate tournament byes schema: %w", err)
	}
	return nil
}

// CreateTournament writes a new event as a draft.
//
// Nothing about it is public until PublishTournament is called, which is the
// whole point: a host can create it half-decided and finish deciding later.
func (store *Store) CreateTournament(
	ctx context.Context,
	tournamentID string,
	config TournamentConfig,
) (Tournament, error) {
	tournamentID = strings.TrimSpace(tournamentID)
	config.normalize()
	if tournamentID == "" {
		return Tournament{}, fmt.Errorf("%w: tournament ID is required", ErrInvalidTournament)
	}
	if config.ModeID == "" || config.ModeName == "" {
		return Tournament{}, fmt.Errorf("%w: game mode is required", ErrInvalidTournament)
	}
	if err := validateTournamentConfig(config); err != nil {
		return Tournament{}, err
	}
	now := time.Now().UnixMilli()
	if _, err := store.db.ExecContext(ctx, `
INSERT INTO tournaments (
    tournament_id, name, description, mode_id, mode_name, status,
    format, field_rule, seeding, max_players, swiss_rounds, games_per_match,
    kind, nightly_number,
    initial_time_ms, increment_ms, starts_at_unix_ms, created_at_unix_ms
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`,
		tournamentID, config.Name, config.Description, config.ModeID, config.ModeName,
		TournamentRegistration, config.Format, config.Field, config.Seeding,
		config.MaxPlayers, config.SwissRounds, normalizeGamesPerMatch(config.GamesPerMatch),
		config.Kind.Normalized(), config.WeekendNumber,
		config.InitialTimeMs, config.IncrementMs,
		config.StartsAtUnixMs, now,
	); err != nil {
		return Tournament{}, fmt.Errorf("create tournament: %w", err)
	}
	return store.Tournament(ctx, tournamentID)
}

// UpdateTournament changes an event's details.
//
// Editable in full while it is a draft. Once it is published the rules of the
// competition are frozen — format, mode, seeding, and the clock are what people
// signed up for — and only the presentation and the two numbers that cannot
// invalidate a signup stay editable:
//
//   - the name and description, because fixing a typo in front of people is
//     better than living with it;
//   - the intended start time, because it slips;
//   - the player cap, provided it is not lowered below the field that has
//     already entered — raising it lets more people in, and lowering it to
//     where somebody's accepted signup no longer fits would be a silent
//     un-registration.
//
// A started or completed tournament takes only the name and description.
func (store *Store) UpdateTournament(
	ctx context.Context,
	tournamentID string,
	config TournamentConfig,
) (Tournament, error) {
	tournamentID = strings.TrimSpace(tournamentID)
	config.normalize()
	if err := validateTournamentConfig(config); err != nil {
		return Tournament{}, err
	}
	existing, err := store.Tournament(ctx, tournamentID)
	if err != nil {
		return Tournament{}, err
	}
	if existing.Status == TournamentCancelled {
		return Tournament{}, ErrTournamentCancelled
	}
	if config.ModeID == "" || config.ModeName == "" {
		return Tournament{}, fmt.Errorf("%w: game mode is required", ErrInvalidTournament)
	}

	if existing.Status == TournamentDraft {
		if _, err := store.db.ExecContext(ctx, `
UPDATE tournaments
SET name = ?, description = ?, mode_id = ?, mode_name = ?, format = ?,
    field_rule = ?, seeding = ?, max_players = ?, swiss_rounds = ?,
    games_per_match = ?, initial_time_ms = ?, increment_ms = ?, starts_at_unix_ms = ?
WHERE tournament_id = ?
`,
			config.Name, config.Description, config.ModeID, config.ModeName, config.Format,
			config.Field, config.Seeding, config.MaxPlayers, config.SwissRounds,
			normalizeGamesPerMatch(config.GamesPerMatch), config.InitialTimeMs, config.IncrementMs,
			config.StartsAtUnixMs, tournamentID,
		); err != nil {
			return Tournament{}, fmt.Errorf("update tournament: %w", err)
		}
		return store.Tournament(ctx, tournamentID)
	}

	if existing.Status == TournamentRegistration {
		if config.MaxPlayers > 0 && config.MaxPlayers < len(existing.Players) {
			return Tournament{}, fmt.Errorf(
				"%w: %d players have already entered, so the cap cannot go below that",
				ErrInvalidTournament, len(existing.Players),
			)
		}
		if _, err := store.db.ExecContext(ctx, `
UPDATE tournaments
SET name = ?, description = ?, max_players = ?, starts_at_unix_ms = ?
WHERE tournament_id = ?
`, config.Name, config.Description, config.MaxPlayers, config.StartsAtUnixMs, tournamentID,
		); err != nil {
			return Tournament{}, fmt.Errorf("update tournament: %w", err)
		}
		return store.Tournament(ctx, tournamentID)
	}

	// Started or finished: the words only.
	if _, err := store.db.ExecContext(ctx, `
UPDATE tournaments SET name = ?, description = ? WHERE tournament_id = ?
`, config.Name, config.Description, tournamentID); err != nil {
		return Tournament{}, fmt.Errorf("update tournament: %w", err)
	}
	return store.Tournament(ctx, tournamentID)
}

// PublishTournament opens registration.
//
// The event appears on the public board and starts taking signups. Publishing
// twice is not an error — the caller wanted it public, and it is — but it does
// not move the publication timestamp, so "open since" stays true.
func (store *Store) PublishTournament(ctx context.Context, tournamentID string) (Tournament, error) {
	tournamentID = strings.TrimSpace(tournamentID)
	existing, err := store.Tournament(ctx, tournamentID)
	if err != nil {
		return Tournament{}, err
	}
	switch existing.Status {
	case TournamentCancelled:
		return Tournament{}, ErrTournamentCancelled
	case TournamentInProgress, TournamentCompleted:
		return Tournament{}, ErrTournamentAlreadyStarted
	case TournamentRegistration:
		return existing, nil
	}
	if _, err := store.db.ExecContext(ctx, `
UPDATE tournaments SET published_at_unix_ms = ? WHERE tournament_id = ?
`, time.Now().UnixMilli(), tournamentID); err != nil {
		return Tournament{}, fmt.Errorf("publish tournament: %w", err)
	}
	return store.Tournament(ctx, tournamentID)
}

// UnpublishTournament takes an event back off the board and into draft.
//
// Only while nobody has entered. Once somebody has signed up, withdrawing the
// event from under them is a cancellation and should say so — which is why this
// refuses rather than quietly dropping the field.
func (store *Store) UnpublishTournament(
	ctx context.Context,
	tournamentID string,
) (Tournament, error) {
	tournamentID = strings.TrimSpace(tournamentID)
	existing, err := store.Tournament(ctx, tournamentID)
	if err != nil {
		return Tournament{}, err
	}
	if existing.Status == TournamentCancelled {
		return Tournament{}, ErrTournamentCancelled
	}
	if existing.Status != TournamentRegistration {
		return Tournament{}, ErrTournamentAlreadyStarted
	}
	if len(existing.Players) > 0 {
		return Tournament{}, fmt.Errorf(
			"%w: %d players have entered; cancel it instead",
			ErrInvalidTournament, len(existing.Players),
		)
	}
	if _, err := store.db.ExecContext(ctx, `
UPDATE tournaments SET published_at_unix_ms = NULL WHERE tournament_id = ?
`, tournamentID); err != nil {
		return Tournament{}, fmt.Errorf("unpublish tournament: %w", err)
	}
	return store.Tournament(ctx, tournamentID)
}

// CancelTournament calls an event off.
//
// The rows stay. A cancelled event keeps its entrants, its schedule and
// whatever results were recorded before it stopped, because the people in it
// played those games and a page that says "cancelled after round two, here is
// where it stood" is the honest record. Deleting is for a draft nobody saw.
func (store *Store) CancelTournament(
	ctx context.Context,
	tournamentID string,
	reason string,
) (Tournament, error) {
	tournamentID = strings.TrimSpace(tournamentID)
	existing, err := store.Tournament(ctx, tournamentID)
	if err != nil {
		return Tournament{}, err
	}
	if existing.Status == TournamentCancelled {
		return existing, nil
	}
	reason = strings.TrimSpace(reason)
	if utf8Runes(reason) > 200 {
		return Tournament{}, fmt.Errorf(
			"%w: cancellation reason must be at most 200 characters", ErrInvalidTournament,
		)
	}
	// The reason joins the description rather than taking a column of its own:
	// it is the last thing the event has to say for itself, it is shown in the
	// same place, and a column would be a second field every read has to
	// remember to render.
	description := existing.Description
	if reason != "" {
		if description != "" {
			description += "\n\n"
		}
		description += "Cancelled: " + reason
	}
	if _, err := store.db.ExecContext(ctx, `
UPDATE tournaments SET cancelled_at_unix_ms = ?, description = ? WHERE tournament_id = ?
`, time.Now().UnixMilli(), description, tournamentID); err != nil {
		return Tournament{}, fmt.Errorf("cancel tournament: %w", err)
	}
	return store.Tournament(ctx, tournamentID)
}

// SetTournamentHidden takes an event off the public board, or puts it back.
//
// Hiding is the housekeeping answer, and it is deliberately much weaker than
// deleting. A hidden event:
//
//   - is not in the public list, and not in the socket broadcast;
//   - *is* still readable at its own address, so an old link and the placement
//     on somebody's profile page both still work;
//   - is still counted everywhere it was counted — the analytics totals, the
//     entrants' profile histories, and the Tournament Champion title, which is
//     recomputed from `status` and does not consult this flag at all.
//
// So it is a listing decision, not a record decision. That distinction is the
// whole point: a board that accumulates every test event and every finished
// event forever needs tidying, and tidying should not mean destroying results
// people earned.
//
// Only a finished or cancelled event can be hidden. One that is taking signups
// or being played is something people need to find, and hiding it would take
// it out of the very broadcast its own participants read their next match from.
// Cancel it first — which is one press — and then hide it.
func (store *Store) SetTournamentHidden(
	ctx context.Context,
	tournamentID string,
	hidden bool,
) (Tournament, error) {
	tournamentID = strings.TrimSpace(tournamentID)
	existing, err := store.Tournament(ctx, tournamentID)
	if err != nil {
		return Tournament{}, err
	}
	if hidden &&
		existing.Status != TournamentCompleted &&
		existing.Status != TournamentCancelled {
		return Tournament{}, fmt.Errorf(
			"%w (this one is %s)", ErrTournamentNotHideable, existing.Status,
		)
	}
	var hiddenAt any
	if hidden {
		hiddenAt = time.Now().UnixMilli()
	}
	if _, err := store.db.ExecContext(ctx, `
UPDATE tournaments SET hidden_at_unix_ms = ? WHERE tournament_id = ?
`, hiddenAt, tournamentID); err != nil {
		return Tournament{}, fmt.Errorf("hide tournament: %w", err)
	}
	return store.Tournament(ctx, tournamentID)
}

// DeleteTournament removes an event entirely.
//
// Any event, at any stage. It used to refuse anything but a draft, on the
// reasoning that a played event is a record and cancelling is the honest way to
// end one — which is true, and was the wrong rule to *enforce*, because it left
// a host with no way to clear a board that had accumulated test events and
// abandoned ones. Hiding is now the answer for an event worth keeping, so this
// can be what its name says.
//
// The entrants, the schedule and the byes go with it: all three cascade. The
// *games* do not — see TournamentDeletion.GamesKept for why they are not this
// function's to delete — and neither does anything in the archive.
//
// The returned report is not decoration. Deleting a completed event silently
// removes the Tournament Champion title from whoever won it, because that title
// is recomputed from this table rather than stored; the report names them so a
// caller can say so before doing it.
func (store *Store) DeleteTournament(
	ctx context.Context,
	tournamentID string,
) (TournamentDeletion, error) {
	tournamentID = strings.TrimSpace(tournamentID)
	existing, err := store.Tournament(ctx, tournamentID)
	if err != nil {
		return TournamentDeletion{}, err
	}
	deletion := TournamentDeletion{
		TournamentID:   existing.TournamentID,
		Name:           existing.Name,
		Status:         existing.Status,
		PlayersDeleted: len(existing.Players),
		MatchesDeleted: len(existing.Matches),
		ByesDeleted:    len(existing.Byes),
	}
	for _, match := range existing.Matches {
		if match.GameID != "" {
			deletion.GamesKept++
		}
	}
	// Read before the rows go, since the standings it comes from are about to
	// stop existing.
	for championID := range tournamentChampions(existing) {
		deletion.ChampionUserIDs = append(deletion.ChampionUserIDs, championID)
	}
	sort.Strings(deletion.ChampionUserIDs)

	if _, err := store.db.ExecContext(ctx,
		`DELETE FROM tournaments WHERE tournament_id = ?`, tournamentID,
	); err != nil {
		return TournamentDeletion{}, fmt.Errorf("delete tournament: %w", err)
	}
	return deletion, nil
}

// WithdrawTournamentPlayer takes an entrant back out of the field.
//
// Registration only. Withdrawing somebody from a started event would delete
// match rows other people's standings are computed from — a half-played round
// robin with one player removed is not a smaller round robin, it is a set of
// results that no longer add up. A host who needs to remove somebody from a
// running event marks their remaining matches as losses instead, which is what
// the result editor is for.
func (store *Store) WithdrawTournamentPlayer(
	ctx context.Context,
	tournamentID string,
	playerID int64,
) (Tournament, error) {
	tournamentID = strings.TrimSpace(tournamentID)
	existing, err := store.Tournament(ctx, tournamentID)
	if err != nil {
		return Tournament{}, err
	}
	if existing.Status != TournamentRegistration && existing.Status != TournamentDraft {
		return Tournament{}, fmt.Errorf(
			"%w: the field is closed; edit their match results instead",
			ErrTournamentAlreadyStarted,
		)
	}
	result, err := store.db.ExecContext(ctx,
		`DELETE FROM tournament_players WHERE tournament_id = ? AND player_id = ?`,
		tournamentID, playerID,
	)
	if err != nil {
		return Tournament{}, fmt.Errorf("withdraw tournament player: %w", err)
	}
	if affected, _ := result.RowsAffected(); affected == 0 {
		return Tournament{}, ErrTournamentMatchNotFound
	}
	return store.Tournament(ctx, tournamentID)
}

// StartTournament closes the field and builds the schedule.
//
// What gets built depends on the format. A fixed format gets its whole schedule
// here; a progressive one gets its first round, and the rest arrive from
// AdvanceTournament as results come in. See the note at the top of
// tournament_format.go.
func (store *Store) StartTournament(ctx context.Context, tournamentID string) (Tournament, error) {
	tournamentID = strings.TrimSpace(tournamentID)
	existing, err := store.Tournament(ctx, tournamentID)
	if err != nil {
		return Tournament{}, err
	}
	switch existing.Status {
	case TournamentCancelled:
		return Tournament{}, ErrTournamentCancelled
	case TournamentDraft:
		return Tournament{}, fmt.Errorf(
			"%w: publish it and let people enter first", ErrInvalidTournament,
		)
	case TournamentInProgress, TournamentCompleted:
		return Tournament{}, ErrTournamentAlreadyStarted
	}
	if len(existing.Players) < 2 {
		return Tournament{}, ErrTournamentNeedsPlayers
	}

	// Seeding is resolved before the transaction, because seeding by rating
	// reads `account_mode_ratings` and there is no reason to hold a write
	// transaction open across it.
	seeds, err := store.seedField(ctx, existing)
	if err != nil {
		return Tournament{}, err
	}

	transaction, err := store.db.BeginTx(ctx, nil)
	if err != nil {
		return Tournament{}, fmt.Errorf("start tournament: begin transaction: %w", err)
	}
	defer func() { _ = transaction.Rollback() }()

	// The seeding order is written down, because every later round reads it —
	// see the seed column's note in ensureTournamentConfigSchema.
	for position, playerID := range seeds {
		if _, err := transaction.ExecContext(ctx,
			`UPDATE tournament_players SET seed = ? WHERE tournament_id = ? AND player_id = ?`,
			position+1, tournamentID, playerID,
		); err != nil {
			return Tournament{}, fmt.Errorf("start tournament: record seeding: %w", err)
		}
	}

	var rounds []roundPairing
	switch existing.Format {
	case FormatSingleElimination:
		rounds = []roundPairing{eliminationFirstRound(seeds)}
	case FormatSwiss:
		rounds = []roundPairing{swissRound(seeds, swissState{
			points:    map[int64]int{},
			met:       map[[2]int64]bool{},
			byesTaken: map[int64]bool{},
			openings:  map[int64]int{},
		})}
	default:
		rounds = fixedSchedule(existing.Format, seeds)
	}
	now := time.Now().UnixMilli()
	if err := insertRounds(ctx, transaction, tournamentID, 1, rounds, now); err != nil {
		return Tournament{}, err
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

// seedField puts the entrants in the order the pairing engines read them.
func (store *Store) seedField(ctx context.Context, tournament Tournament) ([]int64, error) {
	players := append([]TournamentPlayer(nil), tournament.Players...)
	if tournament.Seeding != SeedByRating {
		sort.SliceStable(players, func(first, second int) bool {
			return players[first].SignupOrder < players[second].SignupOrder
		})
		seeds := make([]int64, 0, len(players))
		for _, player := range players {
			seeds = append(seeds, player.PlayerID)
		}
		return seeds, nil
	}

	// Strongest first, by each entrant's rating in this event's own mode. An
	// entrant with no account on record — which a hand-entered signup can be —
	// seeds at the default rather than at zero, so a data gap does not read as
	// a beginner and land in the bottom half of the bracket.
	ratings := make(map[int64]int, len(players))
	for _, player := range players {
		ratings[player.PlayerID] = RatingFloor
		account, err := store.Account(ctx, player.UserID)
		if errors.Is(err, ErrAccountNotFound) {
			continue
		}
		if err != nil {
			return nil, fmt.Errorf("seed tournament: read rating: %w", err)
		}
		ratings[player.PlayerID] = account.ModeElo(tournament.ModeID)
	}
	sort.SliceStable(players, func(first, second int) bool {
		firstElo, secondElo := ratings[players[first].PlayerID], ratings[players[second].PlayerID]
		if firstElo != secondElo {
			return firstElo > secondElo
		}
		return players[first].SignupOrder < players[second].SignupOrder
	})
	seeds := make([]int64, 0, len(players))
	for _, player := range players {
		seeds = append(seeds, player.PlayerID)
	}
	return seeds, nil
}

// AdvanceTournament builds the next round of a progressive tournament.
//
// Called after a result lands. It answers three questions in order: is there a
// round to build, can it be built, and if not is the event over. Returning the
// tournament either way means the caller does not have to know which of those
// happened — it broadcasts what it is given.
func (store *Store) AdvanceTournament(
	ctx context.Context,
	tournamentID string,
) (Tournament, error) {
	tournamentID = strings.TrimSpace(tournamentID)
	tournament, err := store.Tournament(ctx, tournamentID)
	if err != nil {
		return Tournament{}, err
	}
	if tournament.Status != TournamentInProgress || !tournament.Format.Progressive() {
		return tournament, nil
	}
	// Nothing is built while anything is still being played: a Swiss round
	// pairs on the standings, and an elimination round pairs on who survived.
	for _, match := range tournament.Matches {
		if match.Result == MatchPending {
			return tournament, nil
		}
	}

	pairing, nextRound := store.nextRoundPairing(tournament)
	now := time.Now().UnixMilli()
	if len(pairing.pairs) == 0 {
		// No further round: the event is finished. A bye with nobody to play
		// is not a round, so this is also the path for an elimination bracket
		// whose final has been decided.
		if _, err := store.db.ExecContext(ctx, `
UPDATE tournaments SET status = ?, completed_at_unix_ms = ? WHERE tournament_id = ?
`, TournamentCompleted, now, tournamentID); err != nil {
			return Tournament{}, fmt.Errorf("finish tournament: %w", err)
		}
		return store.Tournament(ctx, tournamentID)
	}

	transaction, err := store.db.BeginTx(ctx, nil)
	if err != nil {
		return Tournament{}, fmt.Errorf("advance tournament: begin transaction: %w", err)
	}
	defer func() { _ = transaction.Rollback() }()
	if err := insertRounds(
		ctx, transaction, tournamentID, nextRound, []roundPairing{pairing}, now,
	); err != nil {
		return Tournament{}, err
	}
	if err := transaction.Commit(); err != nil {
		return Tournament{}, fmt.Errorf("advance tournament: commit: %w", err)
	}
	return store.Tournament(ctx, tournamentID)
}

// nextRoundPairing works out what the next round of a progressive tournament
// is, and which round number it will be. An empty pairing means there is none.
func (store *Store) nextRoundPairing(tournament Tournament) (roundPairing, int) {
	playedRounds := 0
	for _, match := range tournament.Matches {
		if match.RoundNumber > playedRounds {
			playedRounds = match.RoundNumber
		}
	}
	for _, bye := range tournament.Byes {
		if bye.RoundNumber > playedRounds {
			playedRounds = bye.RoundNumber
		}
	}
	nextRound := playedRounds + 1

	switch tournament.Format {
	case FormatSingleElimination:
		survivors := eliminationSurvivors(tournament, playedRounds)
		if len(survivors) < 2 {
			return roundPairing{}, nextRound
		}
		return eliminationNextRound(survivors), nextRound
	case FormatSwiss:
		if nextRound > swissRoundCount(len(tournament.Players), tournament.SwissRounds) {
			return roundPairing{}, nextRound
		}
		return swissRound(seedOrderOf(tournament), swissStateOf(tournament)), nextRound
	}
	return roundPairing{}, nextRound
}

// eliminationSurvivors is who is still in the bracket after a round: the
// winners of that round's matches, plus anybody who had a bye in it, in seeding
// order.
//
// A drawn knockout match advances the higher seed. Somebody has to go through,
// the alternative conventions are a replay (which needs a scheduler nobody
// asked for) or a coin toss (which is worse than a stated rule), and seeding is
// the only ordering the bracket already trusts.
func eliminationSurvivors(tournament Tournament, round int) []int64 {
	seedOf := make(map[int64]int, len(tournament.Players))
	for _, player := range tournament.Players {
		seedOf[player.PlayerID] = player.Seed
	}
	survivors := make([]int64, 0, len(tournament.Players))
	for _, match := range tournament.Matches {
		if match.RoundNumber != round {
			continue
		}
		switch match.Result {
		case MatchPlayer1Win:
			survivors = append(survivors, match.Player1.PlayerID)
		case MatchPlayer2Win:
			survivors = append(survivors, match.Player2.PlayerID)
		case MatchDraw:
			if seedOf[match.Player1.PlayerID] <= seedOf[match.Player2.PlayerID] {
				survivors = append(survivors, match.Player1.PlayerID)
			} else {
				survivors = append(survivors, match.Player2.PlayerID)
			}
		}
	}
	for _, bye := range tournament.Byes {
		if bye.RoundNumber == round {
			survivors = append(survivors, bye.PlayerID)
		}
	}
	sort.SliceStable(survivors, func(first, second int) bool {
		return seedOf[survivors[first]] < seedOf[survivors[second]]
	})
	return survivors
}

// seedOrderOf is the field in seeding order, which is what the Swiss pairing
// wants as its tiebreak within a score group.
func seedOrderOf(tournament Tournament) []int64 {
	players := append([]TournamentPlayer(nil), tournament.Players...)
	sort.SliceStable(players, func(first, second int) bool {
		if players[first].Seed != players[second].Seed {
			return players[first].Seed < players[second].Seed
		}
		return players[first].SignupOrder < players[second].SignupOrder
	})
	seeds := make([]int64, 0, len(players))
	for _, player := range players {
		seeds = append(seeds, player.PlayerID)
	}
	return seeds
}

// swissStateOf reconstructs the pairing state from the rounds already played.
//
// Rebuilt from the stored matches rather than carried between calls, because
// there is nowhere to carry it: rounds are paired minutes or days apart, across
// restarts, and the schedule on disk is the only thing that survives that.
func swissStateOf(tournament Tournament) swissState {
	state := swissState{
		points:    make(map[int64]int, len(tournament.Players)),
		met:       make(map[[2]int64]bool, len(tournament.Matches)),
		byesTaken: make(map[int64]bool, len(tournament.Byes)),
		openings:  make(map[int64]int, len(tournament.Players)),
	}
	for _, match := range tournament.Matches {
		first, second := match.Player1.PlayerID, match.Player2.PlayerID
		state.met[pairKey(first, second)] = true
		state.openings[first]++
		switch match.Result {
		case MatchPlayer1Win:
			state.points[first] += 3
		case MatchPlayer2Win:
			state.points[second] += 3
		case MatchDraw:
			state.points[first]++
			state.points[second]++
		}
	}
	for _, bye := range tournament.Byes {
		state.byesTaken[bye.PlayerID] = true
		// A bye is a full point, on the same scale as a win, which is the
		// standard Swiss treatment and what keeps the player who sat out level
		// with the players who beat somebody that round.
		state.points[bye.PlayerID] += 3
	}
	return state
}

// insertRounds writes a stretch of schedule, numbering rounds from `firstRound`
// and continuing the tournament's existing match order.
func insertRounds(
	ctx context.Context,
	transaction *sql.Tx,
	tournamentID string,
	firstRound int,
	rounds []roundPairing,
	now int64,
) error {
	var matchOrder int
	if err := transaction.QueryRowContext(ctx, `
SELECT COALESCE(MAX(match_order), 0) FROM tournament_matches WHERE tournament_id = ?
`, tournamentID).Scan(&matchOrder); err != nil {
		return fmt.Errorf("schedule tournament: read match order: %w", err)
	}
	for offset, round := range rounds {
		roundNumber := firstRound + offset
		for _, pair := range round.pairs {
			matchOrder++
			if _, err := transaction.ExecContext(ctx, `
INSERT INTO tournament_matches (
    tournament_id, round_number, match_order, player1_id, player2_id,
    result, updated_at_unix_ms
) VALUES (?, ?, ?, ?, ?, ?, ?)
`, tournamentID, roundNumber, matchOrder, pair[0], pair[1], MatchPending, now); err != nil {
				return fmt.Errorf("schedule tournament: create match: %w", err)
			}
		}
		for _, playerID := range round.byes {
			if _, err := transaction.ExecContext(ctx, `
INSERT INTO tournament_byes (tournament_id, round_number, player_id, reason)
VALUES (?, ?, ?, ?)
ON CONFLICT (tournament_id, round_number, player_id) DO NOTHING
`, tournamentID, roundNumber, playerID, round.byeReason); err != nil {
				return fmt.Errorf("schedule tournament: record bye: %w", err)
			}
		}
	}
	return nil
}

// readTournamentByes reads the rounds people sat out.
func readTournamentByes(
	ctx context.Context,
	queryer tournamentQueryer,
	tournamentID string,
	playerByID map[int64]TournamentPlayer,
) ([]TournamentBye, error) {
	rows, err := queryer.QueryContext(ctx, `
SELECT round_number, player_id, reason
FROM tournament_byes
WHERE tournament_id = ?
ORDER BY round_number, player_id
`, tournamentID)
	if err != nil {
		return nil, fmt.Errorf("read tournament byes: %w", err)
	}
	defer rows.Close()
	byes := make([]TournamentBye, 0)
	for rows.Next() {
		var bye TournamentBye
		if err := rows.Scan(&bye.RoundNumber, &bye.PlayerID, &bye.Reason); err != nil {
			return nil, fmt.Errorf("read tournament bye: %w", err)
		}
		bye.Player = playerByID[bye.PlayerID]
		byes = append(byes, bye)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("read tournament byes: %w", err)
	}
	return byes, nil
}

// derivedStatus turns the two stored columns into the status the API publishes.
// See the note at the top of this file for why the column itself cannot hold
// 'draft' or 'cancelled'.
func derivedStatus(stored TournamentStatus, publishedAt *int64, cancelledAt *int64) TournamentStatus {
	if cancelledAt != nil {
		return TournamentCancelled
	}
	if stored == TournamentRegistration && publishedAt == nil {
		return TournamentDraft
	}
	return stored
}

// MaximumGamesPerMatch bounds one pairing. Ten games between the same two
// entrants is already a long look at one pairing, and a Swiss round cannot
// finish until its slowest match does.
const MaximumGamesPerMatch = 10

// normalizeGamesPerMatch turns an unset or out-of-range answer into a legal one.
//
// Zero means "the host did not say", which is one game — the behaviour of every
// event that predates the setting. Clamped rather than refused because this is
// a knob, not a claim: a host who types 40 wants a long match, and ten is the
// longest one available.
func normalizeGamesPerMatch(games int) int {
	if games <= 0 {
		return 1
	}
	if games > MaximumGamesPerMatch {
		return MaximumGamesPerMatch
	}
	return games
}
