package persistence

// What people actually play, as opposed to what the engine recommends.
//
// The opening book is one half of an opening page and the less surprising
// half: it says what is good. This says what happens -- which first move most
// people choose, how often the recommended reply actually appears, and which
// of two equal-looking lines the people playing them tend to win.
//
// Three decisions shape the schema:
//
//   - **Every prefix is a row.** A game contributes a row for its first move,
//     another for its first two, and so on. That is what makes "x% of games
//     follow this path" a single lookup rather than a scan, and it makes the
//     conditional question -- of the games that got here, where did they go
//     next -- a lookup too. The cost is bounded and small: a game contributes
//     at most OpeningStatsPlies rows.
//   - **The parent is stored, not derived.** `parent_key` is the line minus
//     its last move, so a position's continuations are an indexed lookup
//     instead of a prefix LIKE over every line in the mode.
//   - **Recomputed whole, never incremented.** A daily compile replaces the
//     table for a mode. Incrementing would be faster and would drift: a game
//     re-archived, a rules change that makes an old line unreplayable, or a
//     compile that half-failed all leave counters that no longer describe any
//     set of games. See the compiler in internal/server/opening_stats.go.

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
)

// OpeningStatsPlies is how deep the statistics go.
//
// Past a few moves every game is its own line and a share stops meaning
// anything -- with a few hundred games the counts are already 1 by ply eight.
// This is deliberately longer than PlayerOpeningNameLimit, because a name is a
// claim about an idea and a count is just a count.
const OpeningStatsPlies = 12

// OpeningStatsCompiler is the version of the compiler that produced a stored
// set. Bump it whenever a compile would key, count or name anything differently
// from the last one.
//
// It exists because the daily compile is *lazy*: it recompiles a mode whose
// stored set is more than a day old, so a deploy that changes what a compile
// means leaves yesterday's numbers on the page for up to a day, computed by a
// compiler that no longer exists. That is not a stale count, which would be
// harmless -- when the keys change meaning it reads as "no game has ever
// reached this position", which looks exactly like a page with no data rather
// than like a deploy that needs a compile.
//
//  1. The first versioned compile. Everything before it reads as version zero.
//  2. Positions and the moves out of them are keyed on the *canonical* board
//     under the mode's symmetries, so a board and its reflection are one row.
const OpeningStatsCompiler = 2

// A segment is where a game came from and who played it -- the unit everything
// here is counted in, and the unit the explorer's checkboxes turn on and off.
//
// Segments partition every game exactly once, which is the property that makes
// them mixable: a reader who ticks three boxes gets the three counts added, and
// no game is counted twice because no game belongs to two segments. Adding a
// source is adding a constant here, tallying into it in the compiler, and
// listing it in OpeningSegments -- the query layer, the API and the page all
// take whatever set they are handed. That is deliberate room: meaf.us sends one
// undifferentiated pile today, and if it ever separates its own bots or its own
// ranked games those become segments beside this one without a schema change.
//
// Kept separate rather than pre-mixed because mixing them by default answers no
// question well: bots play the book they were given and humans do not, so a
// shared total describes neither. The reader decides.
const (
	// OpeningSegmentHuman is a game on this site with a human on both seats.
	OpeningSegmentHuman = "human"
	// OpeningSegmentBot is a game on this site with a bot on both seats.
	OpeningSegmentBot = "bot"
	// OpeningSegmentMixed is a game on this site, bot against human.
	OpeningSegmentMixed = "mixed"
	// OpeningSegmentMeaf is a game from the meaf.us archive, which is bulk
	// human play from a different server and is not in this site's own game
	// table at all -- see the importer in internal/server/opening_meaf.go.
	OpeningSegmentMeaf = "meaf"
)

// SegmentForSeats names the segment a game on this site belongs to, from the
// two account ids that played it. Only a bot account carries BotAccountPrefix,
// so the two seats decide it between them and nothing else has to be loaded.
//
// It lives here rather than beside the statistics compiler because the compiler
// is no longer the only caller: the published data set labels every game the
// same way, and the two answering differently would mean the site and the file
// disagree about what "bot games" are. Meaf is not reachable from here — those
// games have no seats on this site — so this returns one of the other three.
func SegmentForSeats(redPlayerID, bluePlayerID string) string {
	red := strings.HasPrefix(redPlayerID, BotAccountPrefix)
	blue := strings.HasPrefix(bluePlayerID, BotAccountPrefix)
	switch {
	case red && blue:
		return OpeningSegmentBot
	case red || blue:
		return OpeningSegmentMixed
	default:
		return OpeningSegmentHuman
	}
}

// OpeningSegments is every segment, in the order the page offers them. The
// order is this site's own three first, most specific first, then the imports.
var OpeningSegments = []string{
	OpeningSegmentHuman,
	OpeningSegmentBot,
	OpeningSegmentMixed,
	OpeningSegmentMeaf,
}

// NormalizeOpeningSegments turns whatever a caller asked for into a set this
// store can query: known names only, deduplicated, in OpeningSegments order.
//
// Ordering the result rather than preserving the caller's order is what makes
// two requests for the same set produce byte-identical responses, which is
// worth more to a cache than honouring the order somebody happened to tick
// boxes in. An empty or wholly unrecognised request comes back empty, and the
// caller decides whether that is a default or an error.
func NormalizeOpeningSegments(requested []string) []string {
	wanted := make(map[string]bool, len(requested))
	for _, name := range requested {
		wanted[strings.ToLower(strings.TrimSpace(name))] = true
	}
	segments := make([]string, 0, len(OpeningSegments))
	for _, name := range OpeningSegments {
		if wanted[name] {
			segments = append(segments, name)
		}
	}
	return segments
}

// segmentPlaceholders builds the `IN (?, ?, ...)` fragment and its arguments.
//
// Every query here is "this mode, these segments, ...", and the aggregate is
// always the same shape: counts add, the shallowest ply wins, the most recent
// play wins, and the oldest compile is the one whose staleness the reader is
// owed. That arithmetic is sound precisely because segments partition the
// games -- see the note on the constants above.
func segmentPlaceholders(modeID string, segments []string) (string, []any) {
	arguments := make([]any, 0, len(segments)+1)
	arguments = append(arguments, modeID)
	marks := make([]string, len(segments))
	for index, segment := range segments {
		marks[index] = "?"
		arguments = append(arguments, segment)
	}
	return strings.Join(marks, ", "), arguments
}

// ErrOpeningStatsNotFound means no compile has stored anything for this mode
// and cohort yet -- which is different from a compile that found no games, and
// reads differently on the page.
var ErrOpeningStatsNotFound = errors.New("opening statistics not compiled yet")

// ErrNoOpeningSegments means the caller asked for no sources at all -- every
// box unticked. Distinct from "nothing compiled": there is nothing wrong with
// the data, the question just has no subject, and the page says so rather than
// showing a confident zero.
var ErrNoOpeningSegments = errors.New("no opening data sources selected")

// OpeningStatsLine is one line and what happened in the games that played it.
type OpeningStatsLine struct {
	Line []string `json:"line"`
	// Move is the last move of Line, so a continuation list does not have to
	// diff two lines to label a row.
	Move  string `json:"move,omitempty"`
	Games int    `json:"games"`
	// Share of the cohort's games that played this line, 0 to 1. Computed on
	// the way out from the cohort total rather than stored, so it cannot
	// disagree with the counts beside it.
	Share float64 `json:"share"`
	// ShareOfParent is the share of the games that reached the previous
	// position and then played this move. The more useful number of the two
	// once a line is a few moves long.
	ShareOfParent float64 `json:"shareOfParent"`
	RedWins       int     `json:"redWins"`
	BlueWins      int     `json:"blueWins"`
	Draws         int     `json:"draws"`
	// LastPlayedUnixMs is when this line last appeared, which is how a reader
	// tells a line people play from a line somebody played once in July.
	LastPlayedUnixMs int64 `json:"lastPlayedUnixMs"`
}

// OpeningStatsCohort is one compiled cohort, ready to be stored.
type OpeningStatsCohort struct {
	Cohort string
	// Games is the denominator: how many games were counted at all.
	Games int
	// Skipped is how many of this mode's archived games could not be counted.
	// Published rather than swallowed: a page that showed 3 games without
	// saying 300 were skipped would be lying by omission.
	Skipped int
	// Turned is how many of Games only replayed once their ranks were reversed
	// and their colours swapped -- games from before 2026-09-03, when Red moved
	// first and Intransitive ran the other way, counted as the openings they
	// are from the other end of the board. Part
	// of Games rather than beside it: they are games that were played and the
	// turn is a relabelling, not an estimate. Published for the same reason
	// Skipped is, because a reader looking at a mode whose archive is mostly
	// pre-change games is owed the fact that most of the count was turned.
	Turned int
	// Lines is every prefix, keyed by the space-joined line.
	Lines map[string]*OpeningStatsLine
	// Positions is every board reached, keyed by a hash of the board and the
	// side to move.
	//
	// Kept beside Lines rather than instead of it, because the two answer
	// questions neither can answer for the other. A line is a *path*, so it is
	// what "the most played openings" means; a position is a *board*, so it is
	// what "how many games reached here" means -- and those differ whenever two
	// move orders arrive at the same picture, which in a game where nine pieces
	// shuffle between adjacent squares is most of them.
	Positions map[string]*OpeningStatsPosition
}

// OpeningStatsPosition is one board, and the moves played out of it.
type OpeningStatsPosition struct {
	// Ply is the shallowest depth this board was seen at, which is what an
	// explorer shows as "N moves in".
	Ply              int
	Games            int
	RedWins          int
	BlueWins         int
	Draws            int
	LastPlayedUnixMs int64
	// Moves is what was played from here, keyed by notation.
	Moves map[string]*OpeningStatsMove
}

// OpeningStatsMove is one move out of a position.
type OpeningStatsMove struct {
	Games    int
	RedWins  int
	BlueWins int
	Draws    int
}

// OpeningStatsMeta is what a reader needs in order to trust the numbers.
type OpeningStatsMeta struct {
	ModeID string `json:"modeId"`
	// Segments are the sources these numbers were added up from, echoed back
	// so a reader can tell which boxes the counts belong to -- and so a cached
	// response carries its own provenance.
	Segments         []string `json:"segments"`
	Games            int      `json:"games"`
	Skipped          int      `json:"skipped"`
	Turned           int      `json:"turned"`
	Plies            int      `json:"plies"`
	ComputedAtUnixMs int64    `json:"computedAtUnixMs"`
}

// OpeningStatsNode is the answer to "what happens here": the line asked about,
// and where the games that played it went next.
type OpeningStatsNode struct {
	OpeningStatsMeta
	// Line is the line asked about, empty for the starting position.
	Line []string `json:"line"`
	// Position is this line's own counts. Absent for the starting position,
	// whose counts are the cohort totals.
	Position *OpeningStatsLine `json:"position,omitempty"`
	// Continuations are the moves played from here, most played first.
	Continuations []OpeningStatsLine `json:"continuations"`
	// Popular is the mode's most played lines of any length, most played
	// first. The condensed answer to "what do people play", and the reason a
	// caller does not have to walk the tree to get one.
	Popular []OpeningStatsLine `json:"popular,omitempty"`
}

func (store *Store) ensureOpeningStatsSchema(ctx context.Context) error {
	const schema = `
CREATE TABLE IF NOT EXISTS opening_stats (
    mode_id    TEXT NOT NULL,
    cohort     TEXT NOT NULL,
    line_key   TEXT NOT NULL,
    parent_key TEXT NOT NULL,
    move       TEXT NOT NULL,
    line_json  TEXT NOT NULL,
    plies      INTEGER NOT NULL,
    games      INTEGER NOT NULL,
    red_wins   INTEGER NOT NULL,
    blue_wins  INTEGER NOT NULL,
    draws      INTEGER NOT NULL,
    last_played_unix_ms INTEGER NOT NULL,
    PRIMARY KEY (mode_id, cohort, line_key)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS opening_stats_meta (
    mode_id TEXT NOT NULL,
    cohort  TEXT NOT NULL,
    games   INTEGER NOT NULL,
    skipped INTEGER NOT NULL,
    plies   INTEGER NOT NULL,
    computed_at_unix_ms INTEGER NOT NULL,
    turned  INTEGER NOT NULL DEFAULT 0,
    compiler INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (mode_id, cohort)
);

-- Continuations of a position, most played first: the query the page makes on
-- every tap.
CREATE INDEX IF NOT EXISTS opening_stats_children_idx
    ON opening_stats(mode_id, cohort, parent_key, games DESC);
-- The most played lines in a mode, which is the condensed payload.
CREATE INDEX IF NOT EXISTS opening_stats_popular_idx
    ON opening_stats(mode_id, cohort, games DESC, plies);

-- One row per board reached, for the explorer. Keyed by a hash of the board
-- and the side to move rather than by the moves that got there, so two move
-- orders arriving at the same picture are one row -- which is the whole
-- question the explorer asks and the one the line table cannot answer.
CREATE TABLE IF NOT EXISTS opening_stats_positions (
    mode_id      TEXT NOT NULL,
    cohort       TEXT NOT NULL,
    position_key TEXT NOT NULL,
    ply          INTEGER NOT NULL,
    games        INTEGER NOT NULL,
    red_wins     INTEGER NOT NULL,
    blue_wins    INTEGER NOT NULL,
    draws        INTEGER NOT NULL,
    last_played_unix_ms INTEGER NOT NULL,
    PRIMARY KEY (mode_id, cohort, position_key)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS opening_stats_position_moves (
    mode_id      TEXT NOT NULL,
    cohort       TEXT NOT NULL,
    position_key TEXT NOT NULL,
    move         TEXT NOT NULL,
    games        INTEGER NOT NULL,
    red_wins     INTEGER NOT NULL,
    blue_wins    INTEGER NOT NULL,
    draws        INTEGER NOT NULL,
    PRIMARY KEY (mode_id, cohort, position_key, move)
) WITHOUT ROWID;

-- The explorer's only query: the moves out of one board, most played first.
CREATE INDEX IF NOT EXISTS opening_stats_position_moves_idx
    ON opening_stats_position_moves(mode_id, cohort, position_key, games DESC);
`
	if _, err := store.db.ExecContext(ctx, schema); err != nil {
		return fmt.Errorf("migrate opening statistics: %w", err)
	}
	// CREATE TABLE IF NOT EXISTS does nothing to a table that already exists,
	// so a database from before turned games were counted needs the column
	// adding. The stored rows then read as "nothing turned" until the next
	// daily compile, which is the correct account of a count taken before
	// anything was turned.
	columns, err := tableColumns(ctx, store.db, "opening_stats_meta")
	if err != nil {
		return fmt.Errorf("inspect opening statistics schema: %w", err)
	}
	if !columns["turned"] {
		if _, err := store.db.ExecContext(ctx,
			"ALTER TABLE opening_stats_meta ADD COLUMN turned INTEGER NOT NULL DEFAULT 0",
		); err != nil {
			return fmt.Errorf("add opening_stats_meta.turned: %w", err)
		}
	}
	// A database compiled before the compiler was versioned reads as version
	// zero, which is older than any version there is -- so the first server to
	// see it recompiles, which is exactly right for rows whose keys were
	// computed by a compiler that no longer exists.
	if !columns["compiler"] {
		if _, err := store.db.ExecContext(ctx,
			"ALTER TABLE opening_stats_meta ADD COLUMN compiler INTEGER NOT NULL DEFAULT 0",
		); err != nil {
			return fmt.Errorf("add opening_stats_meta.compiler: %w", err)
		}
	}
	return nil
}

// ReplaceOpeningStats swaps in a freshly compiled set for one mode.
//
// One transaction over every cohort, because the cohorts are read together: a
// page showing "human" beside a bot count assembled from the previous compile
// would present two different days as one measurement.
func (store *Store) ReplaceOpeningStats(
	ctx context.Context,
	modeID string,
	cohorts []OpeningStatsCohort,
) error {
	modeID = strings.TrimSpace(modeID)
	if modeID == "" {
		return fmt.Errorf("replace opening statistics: mode is required")
	}
	now := time.Now().UnixMilli()

	tx, err := store.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("replace opening statistics: %w", err)
	}
	defer tx.Rollback()

	for _, statement := range []string{
		`DELETE FROM opening_stats WHERE mode_id = ?`,
		`DELETE FROM opening_stats_meta WHERE mode_id = ?`,
		`DELETE FROM opening_stats_positions WHERE mode_id = ?`,
		`DELETE FROM opening_stats_position_moves WHERE mode_id = ?`,
	} {
		if _, err := tx.ExecContext(ctx, statement, modeID); err != nil {
			return fmt.Errorf("clear opening statistics: %w", err)
		}
	}

	insertLine, err := tx.PrepareContext(ctx, `
INSERT INTO opening_stats (
    mode_id, cohort, line_key, parent_key, move, line_json, plies,
    games, red_wins, blue_wins, draws, last_played_unix_ms
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`)
	if err != nil {
		return fmt.Errorf("prepare opening statistics: %w", err)
	}
	defer insertLine.Close()

	insertPosition, err := tx.PrepareContext(ctx, `
INSERT INTO opening_stats_positions (
    mode_id, cohort, position_key, ply, games, red_wins, blue_wins, draws,
    last_played_unix_ms
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`)
	if err != nil {
		return fmt.Errorf("prepare opening position statistics: %w", err)
	}
	defer insertPosition.Close()

	insertPositionMove, err := tx.PrepareContext(ctx, `
INSERT INTO opening_stats_position_moves (
    mode_id, cohort, position_key, move, games, red_wins, blue_wins, draws
) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`)
	if err != nil {
		return fmt.Errorf("prepare opening position moves: %w", err)
	}
	defer insertPositionMove.Close()

	for _, cohort := range cohorts {
		for key, position := range cohort.Positions {
			if _, err := insertPosition.ExecContext(ctx,
				modeID, cohort.Cohort, key, position.Ply, position.Games,
				position.RedWins, position.BlueWins, position.Draws,
				position.LastPlayedUnixMs,
			); err != nil {
				return fmt.Errorf("write opening position statistics: %w", err)
			}
			for notation, move := range position.Moves {
				if _, err := insertPositionMove.ExecContext(ctx,
					modeID, cohort.Cohort, key, notation, move.Games,
					move.RedWins, move.BlueWins, move.Draws,
				); err != nil {
					return fmt.Errorf("write opening position move: %w", err)
				}
			}
		}
		for key, line := range cohort.Lines {
			encoded, err := json.Marshal(nonNilLines(line.Line))
			if err != nil {
				return fmt.Errorf("encode opening statistics line: %w", err)
			}
			parent := ""
			if index := strings.LastIndex(key, " "); index >= 0 {
				parent = key[:index]
			}
			if _, err := insertLine.ExecContext(ctx,
				modeID, cohort.Cohort, key, parent, line.Move, string(encoded),
				len(line.Line), line.Games, line.RedWins, line.BlueWins, line.Draws,
				line.LastPlayedUnixMs,
			); err != nil {
				return fmt.Errorf("write opening statistics line: %w", err)
			}
		}
		if _, err := tx.ExecContext(ctx, `
INSERT INTO opening_stats_meta (
    mode_id, cohort, games, skipped, turned, plies, computed_at_unix_ms, compiler
) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`, modeID, cohort.Cohort, cohort.Games, cohort.Skipped, cohort.Turned,
			OpeningStatsPlies, now, OpeningStatsCompiler); err != nil {
			return fmt.Errorf("write opening statistics meta: %w", err)
		}
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit opening statistics: %w", err)
	}
	return nil
}

// OpeningStatsCompiledAt reports when a mode was last compiled, so the daily
// job can tell a restart from a day passing.
func (store *Store) OpeningStatsCompiledAt(
	ctx context.Context,
	modeID string,
) (int64, int, error) {
	var computed, compiler sql.NullInt64
	err := store.db.QueryRowContext(ctx, `
SELECT MAX(computed_at_unix_ms), MIN(compiler) FROM opening_stats_meta WHERE mode_id = ?
`, strings.TrimSpace(modeID)).Scan(&computed, &compiler)
	if err != nil {
		return 0, 0, fmt.Errorf("read opening statistics time: %w", err)
	}
	return computed.Int64, int(compiler.Int64), nil
}

// OpeningStatsAt answers what happens at one line.
//
// `popular` asks for the mode's most played lines alongside, which is what
// makes the starting position's response the whole condensed dataset in one
// request.
func (store *Store) OpeningStatsAt(
	ctx context.Context,
	modeID string,
	segments []string,
	line []string,
	popular int,
) (OpeningStatsNode, error) {
	modeID = strings.TrimSpace(modeID)
	if len(segments) == 0 {
		return OpeningStatsNode{}, ErrNoOpeningSegments
	}
	node := OpeningStatsNode{
		Line:          nonNilLines(line),
		Continuations: make([]OpeningStatsLine, 0, 8),
	}
	marks, arguments := segmentPlaceholders(modeID, segments)
	// COUNT(*) rather than trusting the SUMs: summing over nothing yields NULL
	// rows, not no rows, so "no segment has ever been compiled" and "every
	// segment compiled and found nothing" would otherwise look identical here.
	// They read very differently on the page.
	var compiled int
	err := store.db.QueryRowContext(ctx, `
SELECT COUNT(*), COALESCE(SUM(games), 0), COALESCE(SUM(skipped), 0),
       COALESCE(SUM(turned), 0), COALESCE(MAX(plies), 0),
       COALESCE(MIN(computed_at_unix_ms), 0)
FROM opening_stats_meta WHERE mode_id = ? AND cohort IN (`+marks+`)
`, arguments...).Scan(
		&compiled, &node.Games, &node.Skipped, &node.Turned,
		&node.Plies, &node.ComputedAtUnixMs,
	)
	if err != nil {
		return OpeningStatsNode{}, fmt.Errorf("read opening statistics: %w", err)
	}
	if compiled == 0 {
		return OpeningStatsNode{}, ErrOpeningStatsNotFound
	}
	node.ModeID = modeID
	node.Segments = segments

	key := strings.Join(node.Line, " ")
	// The denominator for a conditional share. At the starting position every
	// game reached here by definition, which is what makes the segment total
	// the right value rather than a special case.
	reached := node.Games
	if key != "" {
		position, err := store.openingStatsLine(ctx, modeID, segments, key)
		switch {
		case errors.Is(err, sql.ErrNoRows):
			// A line nobody has played. Not an error: "no games went this way"
			// is the answer, and an empty continuation list says it.
			reached = 0
		case err != nil:
			return OpeningStatsNode{}, err
		default:
			position.Share = shareOf(position.Games, node.Games)
			node.Position = &position
			reached = position.Games
		}
	}

	arguments = append(arguments, key, len(node.Line)+1)
	rows, err := store.db.QueryContext(ctx, `
SELECT MAX(line_json), MAX(move), SUM(games), SUM(red_wins), SUM(blue_wins),
       SUM(draws), MAX(last_played_unix_ms)
FROM opening_stats
WHERE mode_id = ? AND cohort IN (`+marks+`) AND parent_key = ? AND plies = ?
GROUP BY line_key
ORDER BY SUM(games) DESC, MAX(move)
`, arguments...)
	if err != nil {
		return OpeningStatsNode{}, fmt.Errorf("read opening continuations: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		child, err := scanOpeningStatsLine(rows)
		if err != nil {
			return OpeningStatsNode{}, err
		}
		child.Share = shareOf(child.Games, node.Games)
		child.ShareOfParent = shareOf(child.Games, reached)
		node.Continuations = append(node.Continuations, child)
	}
	if err := rows.Err(); err != nil {
		return OpeningStatsNode{}, fmt.Errorf("read opening continuations: %w", err)
	}

	if popular > 0 {
		node.Popular, err = store.popularOpenings(ctx, modeID, segments, node.Games, popular)
		if err != nil {
			return OpeningStatsNode{}, err
		}
	}
	return node, nil
}

// popularOpenings is the most played lines in a mode, most played first.
//
// Bounded below at two plies: a one-move line is a first-move breakdown, which
// the continuation list already is, and it would otherwise fill the whole list
// with the most popular openings' own first moves.
func (store *Store) popularOpenings(
	ctx context.Context,
	modeID string,
	segments []string,
	total, limit int,
) ([]OpeningStatsLine, error) {
	if limit > 100 {
		limit = 100
	}
	marks, arguments := segmentPlaceholders(modeID, segments)
	arguments = append(arguments, limit)
	rows, err := store.db.QueryContext(ctx, `
SELECT MAX(line_json), MAX(move), SUM(games), SUM(red_wins), SUM(blue_wins),
       SUM(draws), MAX(last_played_unix_ms)
FROM opening_stats
WHERE mode_id = ? AND cohort IN (`+marks+`) AND plies >= 2
GROUP BY line_key
ORDER BY SUM(games) DESC, MAX(plies) DESC, line_key
LIMIT ?
`, arguments...)
	if err != nil {
		return nil, fmt.Errorf("read popular openings: %w", err)
	}
	defer rows.Close()
	popular := make([]OpeningStatsLine, 0, limit)
	for rows.Next() {
		line, err := scanOpeningStatsLine(rows)
		if err != nil {
			return nil, err
		}
		line.Share = shareOf(line.Games, total)
		popular = append(popular, line)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("read popular openings: %w", err)
	}
	return popular, nil
}

func (store *Store) openingStatsLine(
	ctx context.Context,
	modeID string,
	segments []string,
	key string,
) (OpeningStatsLine, error) {
	marks, arguments := segmentPlaceholders(modeID, segments)
	arguments = append(arguments, key)
	// HAVING rather than letting the aggregate answer: a GROUP BY that matches
	// nothing returns no rows, but this query has no GROUP BY when the line is
	// absent from every segment, and would hand back a row of NULLs. The
	// caller reads sql.ErrNoRows as "nobody played this", so it has to be a
	// missing row rather than a zero one.
	row := store.db.QueryRowContext(ctx, `
SELECT MAX(line_json), MAX(move), SUM(games), SUM(red_wins), SUM(blue_wins),
       SUM(draws), MAX(last_played_unix_ms)
FROM opening_stats
WHERE mode_id = ? AND cohort IN (`+marks+`) AND line_key = ?
HAVING COUNT(*) > 0
`, arguments...)
	return scanOpeningStatsLine(row)
}

// scanner is what QueryRow and Rows have in common, so one scan serves both.
type scanner interface {
	Scan(destination ...any) error
}

func scanOpeningStatsLine(source scanner) (OpeningStatsLine, error) {
	var line OpeningStatsLine
	var encoded string
	if err := source.Scan(
		&encoded, &line.Move, &line.Games,
		&line.RedWins, &line.BlueWins, &line.Draws, &line.LastPlayedUnixMs,
	); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return OpeningStatsLine{}, err
		}
		return OpeningStatsLine{}, fmt.Errorf("scan opening statistics line: %w", err)
	}
	if err := json.Unmarshal([]byte(encoded), &line.Line); err != nil {
		return OpeningStatsLine{}, fmt.Errorf("decode opening statistics line: %w", err)
	}
	return line, nil
}

// shareOf is a proportion, and zero when there is nothing to divide by.
//
// A share of a total of zero is not 0% -- it is unanswerable -- but every
// caller here is rendering a bar, and a bar of unknown length is drawn empty.
func shareOf(part, total int) float64 {
	if total <= 0 {
		return 0
	}
	return float64(part) / float64(total)
}

// ArchivedGameOpening is the little of an archived game the compiler needs.
type ArchivedGameOpening struct {
	GameID           string
	RedPlayerID      string
	BluePlayerID     string
	Outcome          string
	FinishedAtUnixMs int64
	PGN              string
}

// EachArchivedGameOpening streams a mode's archived games, oldest first.
//
// Streaming rather than paging: the compiler reads every game in a mode and
// keeps only counters, so the whole archive never has to be in memory at once
// and there is no page size to tune as the archive grows. Only the columns the
// compiler uses are selected, which leaves the review join out.
//
// The callback runs while the rows are open, so it must not touch the store.
func (store *Store) EachArchivedGameOpening(
	ctx context.Context,
	modeID string,
	visit func(ArchivedGameOpening) error,
) error {
	rows, err := store.db.QueryContext(ctx, `
SELECT game_id, red_player_id, blue_player_id, outcome, finished_at_unix_ms, pgn
FROM game_pgn
WHERE mode_id = ?
ORDER BY finished_at_unix_ms ASC, game_id ASC
`, strings.TrimSpace(modeID))
	if err != nil {
		return fmt.Errorf("read archived games: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var archived ArchivedGameOpening
		if err := rows.Scan(
			&archived.GameID, &archived.RedPlayerID, &archived.BluePlayerID,
			&archived.Outcome, &archived.FinishedAtUnixMs, &archived.PGN,
		); err != nil {
			return fmt.Errorf("scan archived game: %w", err)
		}
		if err := visit(archived); err != nil {
			return err
		}
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("read archived games: %w", err)
	}
	return nil
}

// ---------------------------------------------------------------------------
// The explorer
// ---------------------------------------------------------------------------

// OpeningStatsExploredMove is one move out of the board being looked at.
type OpeningStatsExploredMove struct {
	// Move is how this move is written on the board the caller is standing on.
	// Stored canonically and rewritten on the way out -- see exploredBoard in
	// the server -- so a visitor is always shown squares they are looking at.
	Move string `json:"move"`
	// Twins are the other ways to write the same move on that board, empty for
	// most moves.
	//
	// Not a duplicate row and not a second move: from a board that is its own
	// reflection, `e3-f3` and `c5-c6` move different pieces to different squares
	// and reach the *same position*, so they are one continuation with one set
	// of counts. Both are legal and either can be played; the page draws the
	// first as an arrow and the rest as its dashed twins, in the same colour,
	// because the alternative -- two rows with the games split between them --
	// would show a reader two half-sized moves that are the same move.
	Twins []string `json:"twins,omitempty"`
	Games int      `json:"games"`
	// Share of the games that *reached this board* and then played this move.
	// The conditional share is the one an explorer wants: "of the people who
	// got here, this is what they did".
	Share float64 `json:"share"`
	// ShareOfAll is the same count against the whole cohort, for a sense of
	// how travelled this part of the tree is at all.
	ShareOfAll float64 `json:"shareOfAll"`
	RedWins    int     `json:"redWins"`
	BlueWins   int     `json:"blueWins"`
	Draws      int     `json:"draws"`
}

// OpeningStatsExplored is one board, and what happened from it.
type OpeningStatsExplored struct {
	OpeningStatsMeta
	// Line is the path the caller walked to get here. Reported back because a
	// board can be reached several ways and the caller's own route is the one
	// its move list is showing.
	Line []string `json:"line"`
	// Ply is how many moves in this board is, by the shortest route anybody
	// took to it.
	Ply int `json:"ply"`
	// Games that reached this board by any move order. Zero is a real answer
	// and the page says "no games have reached here".
	Games int `json:"games"`
	// Share of the cohort's games that reached this board.
	Share    float64 `json:"share"`
	RedWins  int     `json:"redWins"`
	BlueWins int     `json:"blueWins"`
	Draws    int     `json:"draws"`
	// Moves played from here, most played first.
	Moves            []OpeningStatsExploredMove `json:"moves"`
	LastPlayedUnixMs int64                      `json:"lastPlayedUnixMs"`
}

// ExploreOpeningPosition answers "what happens from this board".
//
// `positionKey` is whatever OpeningPositionKey made of the board; the caller
// replays the line, because the rules live on that side and a key the client
// computed would be a key this server could not check.
func (store *Store) ExploreOpeningPosition(
	ctx context.Context,
	modeID string,
	segments []string,
	positionKey string,
	line []string,
) (OpeningStatsExplored, error) {
	modeID = strings.TrimSpace(modeID)
	if len(segments) == 0 {
		return OpeningStatsExplored{}, ErrNoOpeningSegments
	}
	explored := OpeningStatsExplored{
		Line:  nonNilLines(line),
		Moves: make([]OpeningStatsExploredMove, 0, 8),
	}
	marks, arguments := segmentPlaceholders(modeID, segments)
	var compiled int
	err := store.db.QueryRowContext(ctx, `
SELECT COUNT(*), COALESCE(SUM(games), 0), COALESCE(SUM(skipped), 0),
       COALESCE(SUM(turned), 0), COALESCE(MAX(plies), 0),
       COALESCE(MIN(computed_at_unix_ms), 0)
FROM opening_stats_meta WHERE mode_id = ? AND cohort IN (`+marks+`)
`, arguments...).Scan(
		&compiled, &explored.Games, &explored.Skipped, &explored.Turned,
		&explored.Plies, &explored.ComputedAtUnixMs,
	)
	if err != nil {
		return OpeningStatsExplored{}, fmt.Errorf("read opening statistics: %w", err)
	}
	if compiled == 0 {
		return OpeningStatsExplored{}, ErrOpeningStatsNotFound
	}
	total := explored.Games
	explored.ModeID = modeID
	explored.Segments = segments
	explored.Games = 0

	positionArguments := append(append([]any(nil), arguments...), positionKey)
	var reached int
	err = store.db.QueryRowContext(ctx, `
SELECT COUNT(*), COALESCE(MIN(ply), 0), COALESCE(SUM(games), 0),
       COALESCE(SUM(red_wins), 0), COALESCE(SUM(blue_wins), 0),
       COALESCE(SUM(draws), 0), COALESCE(MAX(last_played_unix_ms), 0)
FROM opening_stats_positions
WHERE mode_id = ? AND cohort IN (`+marks+`) AND position_key = ?
`, positionArguments...).Scan(
		&reached, &explored.Ply, &explored.Games, &explored.RedWins,
		&explored.BlueWins, &explored.Draws, &explored.LastPlayedUnixMs,
	)
	if err != nil {
		return OpeningStatsExplored{}, fmt.Errorf("read opening position: %w", err)
	}
	if reached == 0 {
		// A board nobody has reached. Not an error -- it is the answer, and it
		// is the answer for most of the tree. The ply the caller walked to is
		// still the truth about where they are.
		explored.Ply = len(explored.Line)
	}
	explored.Share = shareOf(explored.Games, total)

	rows, err := store.db.QueryContext(ctx, `
SELECT move, SUM(games), SUM(red_wins), SUM(blue_wins), SUM(draws)
FROM opening_stats_position_moves
WHERE mode_id = ? AND cohort IN (`+marks+`) AND position_key = ?
GROUP BY move
ORDER BY SUM(games) DESC, move
`, positionArguments...)
	if err != nil {
		return OpeningStatsExplored{}, fmt.Errorf("read opening position moves: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var move OpeningStatsExploredMove
		if err := rows.Scan(
			&move.Move, &move.Games, &move.RedWins, &move.BlueWins, &move.Draws,
		); err != nil {
			return OpeningStatsExplored{}, fmt.Errorf("scan opening position move: %w", err)
		}
		move.Share = shareOf(move.Games, explored.Games)
		move.ShareOfAll = shareOf(move.Games, total)
		explored.Moves = append(explored.Moves, move)
	}
	if err := rows.Err(); err != nil {
		return OpeningStatsExplored{}, fmt.Errorf("read opening position moves: %w", err)
	}
	return explored, nil
}
