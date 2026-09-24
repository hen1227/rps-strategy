package main

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"

	"rps-strategy/backend/internal/game"
	"rps-strategy/backend/internal/notation"
	"rps-strategy/backend/internal/persistence"
)

// namesPublishedFrom is the promise in PRIVACY.md, as a Unix millisecond
// timestamp: 2026-09-09T00:00:00Z. A game that finished before it is published
// with both names removed, because it was played before the policy said games
// would be published under names at all. A game that finished after it carries
// the usernames it was played under.
//
// It is a constant rather than a flag on purpose. The cutoff is a commitment
// made to players in a document with a date on it, and a run that could be
// pointed at a different one by accident is a run that could publish a name
// nobody agreed to.
const namesPublishedFrom int64 = 1788912000000

// anonymousName is the name both seats take on a record published without
// them. Deliberately not "Deleted player", which the account deletion path
// already writes into stored rows and means something else: that person asked
// to be gone, where these games are simply older than the policy.
const anonymousName = "Anonymous player"

// playerKeyLength is how much of the HMAC is published. Sixty-four bits is far
// more than enough to keep a few thousand accounts apart, and the secret rather
// than the length is what stops the key being walked back to an account id.
const playerKeyLength = 16

// errNoSeatID reports a stored game with an empty account id on a seat. Such a
// row is skipped rather than published: there is no id to derive an opaque key
// from, so the seat could only be published as a bare name with no identity
// behind it -- and a participant this server cannot identify is not one it
// should be publishing under any terms. None were found in 800 sampled
// production games, so this is a guard rather than a routine path.
var errNoSeatID = errors.New("game has a seat with no account id")

// archivedRow is one row of game_pgn, as the exporter reads it. Deliberately
// its own type rather than persistence.ArchivedGame: this command selects the
// columns it publishes and nothing else, so a column added to the archive later
// cannot reach the data set until somebody names it here.
type archivedRow struct {
	GameID           string
	ModeID           string
	ModeName         string
	RedPlayerID      string
	RedUsername      string
	BluePlayerID     string
	BlueUsername     string
	WinnerColor      string
	Outcome          string
	EndReason        string
	Ranked           bool
	TournamentID     string
	PlyCount         int
	InitialTimeMs    int64
	IncrementMs      int64
	StartedAtUnixMs  int64
	FinishedAtUnixMs int64
	PGN              string
}

// exportRecord is one game as it is published.
//
// The field names are snake_case, unlike the camelCase of the admin API's
// ArchivedGame, because this is a different contract with a different reader:
// the admin export answers a browser, and this answers pandas.
//
// recorded_at is deliberately absent. PRIVACY.md lists what the data set
// carries, and when a row was written to the database is not on that list --
// it is an operational detail about this server, not a fact about the game.
type exportRecord struct {
	GameID   string `json:"game_id"`
	ModeID   string `json:"mode_id"`
	ModeName string `json:"mode_name"`

	// RedPlayer and BluePlayer are usernames, or anonymousName. RedKey and
	// BlueKey are the opaque per-player keys PRIVACY.md promises, so a reader
	// can group one person's games without the key leading back to an account.
	RedPlayer  string `json:"red_player"`
	BluePlayer string `json:"blue_player"`
	RedKey     string `json:"red_key"`
	BlueKey    string `json:"blue_key"`
	// Players is "bot", "mixed" or "human", from persistence.SegmentForSeats,
	// which is the same classifier the opening explorer's segment checkboxes
	// use. About seven games in ten are bot against bot.
	Players string `json:"players"`

	// Opener is the colour that moved first, read off the record's own FEN.
	// The first mover changed on 2026-09-03 -- Blue opens now, Red opened
	// before -- and the archive holds both, so this is the label that stops a
	// reader mixing two rule sets without noticing.
	Opener string `json:"opener"`
	// PGNDialect is the Generator tag's version. It is a *move numbering*
	// convention, not the rules: dialect 1 numbered pairs by colour so "12."
	// was always Red, and dialect 2 numbers by whoever opened. Both replay
	// correctly. Read Opener, not this, to tell the rule sets apart.
	PGNDialect int `json:"pgn_dialect"`

	WinnerColor  string `json:"winner_color"`
	Outcome      string `json:"outcome"`
	EndReason    string `json:"end_reason"`
	Termination  string `json:"termination"`
	Event        string `json:"event"`
	Ranked       bool   `json:"ranked"`
	TournamentID string `json:"tournament_id"`
	SeriesID     string `json:"series_id"`
	OpeningSeed  string `json:"opening_seed"`
	// BookPlies counts opening moves that were dealt from a seeded random
	// opening rather than chosen, on bot matches. Anyone training on these
	// games wants it for the reason the review tooling skips those plies:
	// grading a move nobody picked would slander both engines.
	BookPlies int `json:"book_plies"`

	RedElo       int `json:"red_elo"`
	RedEloAfter  int `json:"red_elo_after"`
	BlueElo      int `json:"blue_elo"`
	BlueEloAfter int `json:"blue_elo_after"`

	PlyCount         int   `json:"ply_count"`
	InitialTimeMs    int64 `json:"initial_time_ms"`
	IncrementMs      int64 `json:"increment_ms"`
	StartedAtUnixMs  int64 `json:"started_at_unix_ms"`
	FinishedAtUnixMs int64 `json:"finished_at_unix_ms"`

	PGN string `json:"pgn"`
}

// exporter turns stored rows into published ones. It holds the two things that
// decide what a record says about its players: the key secret, and whoever has
// asked to be left out.
type exporter struct {
	secret   []byte
	excluded map[string]bool
}

// playerKey is the opaque identifier published in place of an account id.
//
// HMAC rather than a plain hash because account ids are drawn from a small,
// enumerable space -- every one of them is served publicly by /api/accounts and
// listed on the leaderboard -- so an unkeyed digest of one is reversible by
// anybody who scrapes the site and hashes what they find. The secret is what
// makes the key opaque, and it is never published.
func (export *exporter) playerKey(userID string) string {
	mac := hmac.New(sha256.New, export.secret)
	mac.Write([]byte(userID))
	return hex.EncodeToString(mac.Sum(nil))[:playerKeyLength]
}

// nameFor decides what a seat is called in the published record.
//
// Anonymous in two cases, for the same reason: nobody agreed to it. Games older
// than the policy were played before it existed, and an opt-out is somebody
// saying so directly. Opting out anonymizes rather than drops the game, because
// a game belongs to two people and removing it would put a hole in the
// opponent's record -- the argument the deletion policy already makes.
func (export *exporter) nameFor(userID, username string, finishedAtUnixMs int64) string {
	if finishedAtUnixMs < namesPublishedFrom || export.excluded[userID] {
		return anonymousName
	}
	return username
}

// record turns one stored row into the record that is published for it.
func (export *exporter) record(row archivedRow) (exportRecord, error) {
	if row.RedPlayerID == "" || row.BluePlayerID == "" {
		return exportRecord{}, errNoSeatID
	}
	// Tags only, deliberately. Everything read below is a header, and a record
	// whose movetext no longer replays under today's rules is exactly the old
	// game the archive exists to preserve -- it must not drop out of the data
	// set because the parser got stricter.
	tags, err := notation.ParseTags(row.PGN)
	if err != nil {
		return exportRecord{}, err
	}

	redName := export.nameFor(row.RedPlayerID, row.RedUsername, row.FinishedAtUnixMs)
	blueName := export.nameFor(row.BluePlayerID, row.BlueUsername, row.FinishedAtUnixMs)
	redKey := export.playerKey(row.RedPlayerID)
	blueKey := export.playerKey(row.BluePlayerID)

	// Both seats are rewritten inside the PGN as well as beside it. The tag
	// block is the copy that travels: a reader who takes the pgn column and
	// throws the rest away must not end up holding an account id.
	//
	// Addressed by seat rather than by the id already in the tag, because those
	// two disagree for every game an anonymized account played -- see SetSeat.
	published := notation.SetSeat(row.PGN, game.Red, redName, redKey)
	published = notation.SetSeat(published, game.Blue, blueName, blueKey)

	record := exportRecord{
		GameID:   row.GameID,
		ModeID:   row.ModeID,
		ModeName: row.ModeName,

		RedPlayer:  redName,
		BluePlayer: blueName,
		RedKey:     redKey,
		BlueKey:    blueKey,
		Players:    persistence.SegmentForSeats(row.RedPlayerID, row.BluePlayerID),

		Opener:     openerOf(tags),
		PGNDialect: dialectOf(tags),

		WinnerColor:  row.WinnerColor,
		Outcome:      row.Outcome,
		EndReason:    row.EndReason,
		Termination:  notation.TagValue(tags, "Termination"),
		Event:        notation.TagValue(tags, "Event"),
		Ranked:       row.Ranked,
		TournamentID: row.TournamentID,
		SeriesID:     notation.TagValue(tags, "SeriesId"),
		OpeningSeed:  notation.TagValue(tags, "OpeningSeed"),
		BookPlies:    tagInt(tags, "BookPlies"),

		RedElo:       tagInt(tags, "RedElo"),
		RedEloAfter:  tagInt(tags, "RedEloAfter"),
		BlueElo:      tagInt(tags, "BlueElo"),
		BlueEloAfter: tagInt(tags, "BlueEloAfter"),

		PlyCount:         row.PlyCount,
		InitialTimeMs:    row.InitialTimeMs,
		IncrementMs:      row.IncrementMs,
		StartedAtUnixMs:  row.StartedAtUnixMs,
		FinishedAtUnixMs: row.FinishedAtUnixMs,

		PGN: published,
	}

	if err := export.verify(row, record); err != nil {
		return exportRecord{}, err
	}
	return record, nil
}

// verify is the last thing standing between a bad rewrite and a published file
// nobody can recall.
//
// It re-reads the record that is actually about to be written rather than
// trusting that the transformation above did what it says, because every way an
// account id could escape looks the same from here: a tag nobody thought of, a
// seat whose rewrite silently found nothing, a field added later by someone who
// did not know the rules. Marshalling costs a few microseconds against a
// consequence that cannot be undone.
//
// Ids are checked by substring over the whole encoded record, because they are
// long and unique enough that a false positive is not a real possibility and a
// scan catches carriers nobody enumerated. Names are checked by exact tag
// equality instead, because a short username like "Bu" would collide with
// ordinary text and turn this into a guard people learn to switch off.
func (export *exporter) verify(row archivedRow, record exportRecord) error {
	encoded, err := json.Marshal(record)
	if err != nil {
		return fmt.Errorf("verify record: %w", err)
	}
	for _, id := range []string{row.RedPlayerID, row.BluePlayerID} {
		if bytes.Contains(encoded, []byte(id)) {
			return fmt.Errorf("account id %q survived into the published record", id)
		}
	}
	tags, err := notation.ParseTags(record.PGN)
	if err != nil {
		return fmt.Errorf("verify record: reread published pgn: %w", err)
	}
	for _, seat := range []struct {
		colour string
		name   string
		key    string
	}{
		{string(game.Red), record.RedPlayer, record.RedKey},
		{string(game.Blue), record.BluePlayer, record.BlueKey},
	} {
		if got := notation.TagValue(tags, seat.colour); got != seat.name {
			return fmt.Errorf(
				"published [%s] is %q, want %q", seat.colour, got, seat.name,
			)
		}
		if got := notation.TagValue(tags, seat.colour+"Id"); got != seat.key {
			return fmt.Errorf(
				"published [%sId] is %q, want the opaque key", seat.colour, got,
			)
		}
	}
	// The movetext is the game. A rewrite that touched it would mean the
	// published record is no longer what was played.
	if movetextOf(record.PGN) != movetextOf(row.PGN) {
		return errors.New("rewriting the tag block changed the movetext")
	}
	return nil
}

// movetextOf returns everything after the tag block, which is where the moves
// live and where nothing in this command is allowed to write.
func movetextOf(pgn string) string {
	_, movetext, found := strings.Cut(pgn, "\n\n")
	if !found {
		return pgn
	}
	return movetext
}

// openerOf reads the colour that moved first out of the record's own FEN tag,
// whose second field is the side to move from the starting position.
//
// This, not the Generator tag, is the direct evidence of which rule set a game
// was played under. Empty when the record carries no FEN, which every generated
// record does.
func openerOf(tags []notation.Tag) string {
	fields := strings.Fields(notation.TagValue(tags, "FEN"))
	if len(fields) < 2 {
		return ""
	}
	switch fields[1] {
	case "r":
		return "red"
	case "b":
		return "blue"
	default:
		return ""
	}
}

// dialectOf reads the Generator tag's version. A record with no Generator tag
// is the current dialect, which is what the notation documentation says a
// reader must assume -- so an absent tag can never be mistaken for an old one.
func dialectOf(tags []notation.Tag) int {
	const current = 2
	generator := notation.TagValue(tags, "Generator")
	_, version, found := strings.Cut(generator, "/")
	if !found {
		return current
	}
	parsed10, err := strconv.Atoi(strings.TrimSpace(version))
	if err != nil {
		return current
	}
	return parsed10
}

// tagInt reads a numeric tag, or zero when it is absent or unreadable. Absent
// is the ordinary case for most of these: a casual game has no ratings and a
// game outside a series has no book plies.
func tagInt(tags []notation.Tag, name string) int {
	value, err := strconv.Atoi(strings.TrimSpace(notation.TagValue(tags, name)))
	if err != nil {
		return 0
	}
	return value
}
