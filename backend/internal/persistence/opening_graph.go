package persistence

// The opening book as the server owns it: a graph of positions, not a document.
//
// The engine publishes one flat payload per mode -- every position it analyzed,
// keyed by its hash in ordinary board coordinates, each move naming its child by
// key. Storing it that way rather than as the nested tree it used to be is what
// lets a visitor be served one position at a time: resolving a line is a walk of
// a few indexed lookups instead of parsing several megabytes of JSON to reach
// the node the walk wanted.
//
// Names are deliberately not part of this. They stay keyed by line in
// `opening_book.go`, because the same position reached by two move orders can be
// two differently named openings -- which is exactly the case a position-keyed
// graph merges, and exactly the case naming must not.

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
)

var (
	// ErrOpeningLineNotFound means the walk left the book: either the move is
	// not among the position's ranked moves, or it is but the scan stopped
	// there and no child was stored.
	ErrOpeningLineNotFound = errors.New("opening line not found")
)

// OpeningGraphMeta is everything about a published book except its positions.
type OpeningGraphMeta struct {
	ModeID          string     `json:"modeId"`
	ModeName        string     `json:"modeName"`
	EngineVersion   string     `json:"engineVersion"`
	RulesVersion    int        `json:"rulesVersion"`
	Weights         string     `json:"weights"`
	Symmetry        string     `json:"symmetry"`
	MaxPly          int        `json:"maxPly"`
	RootKey         string     `json:"rootKey"`
	MainLine        []string   `json:"mainLine"`
	Featured        [][]string `json:"featured"`
	PositionCount   int        `json:"positionCount"`
	UpdatedAtUnixMs int64      `json:"updatedAtUnixMs"`
}

// OpeningPosition is one board the engine analyzed, with its ranked moves.
type OpeningPosition struct {
	Key            string        `json:"key"`
	Turn           string        `json:"turn"`
	Score          int           `json:"score"`
	Depth          int           `json:"depth"`
	SelectiveDepth int           `json:"selectiveDepth"`
	Nodes          uint64        `json:"nodes"`
	Moves          []OpeningMove `json:"moves"`
}

// OpeningMove is one ranked move out of a position.
//
// `Searched` and `Child` differ where the engine knows more than the export
// carries: a move can have been analyzed while its position sits past the
// export's ply bound, in which case the website can say so rather than
// pretending the line simply ends.
type OpeningMove struct {
	Move     string `json:"move"`
	Score    int    `json:"score"`
	Rank     int    `json:"rank"`
	Searched bool   `json:"searched"`
	MainLine bool   `json:"mainLine"`
	Child    string `json:"child,omitempty"`
	// ChildTurn and ChildDepth describe the position behind the move without a
	// second request, which is all the move list needs to render.
	ChildTurn  string `json:"childTurn,omitempty"`
	ChildDepth int    `json:"childDepth,omitempty"`
	// Repetition is never stored. It depends on the line walked to get here,
	// so whoever resolves a line decides it.
	Repetition bool `json:"repetition,omitempty"`
}

func (store *Store) ensureOpeningGraphSchema(ctx context.Context) error {
	const schema = `
CREATE TABLE IF NOT EXISTS opening_positions (
    mode_id         TEXT NOT NULL,
    position_key    TEXT NOT NULL,
    turn            TEXT NOT NULL,
    score           INTEGER NOT NULL,
    depth           INTEGER NOT NULL,
    selective_depth INTEGER NOT NULL,
    nodes           INTEGER NOT NULL,
    PRIMARY KEY (mode_id, position_key)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS opening_edges (
    mode_id      TEXT NOT NULL,
    position_key TEXT NOT NULL,
    rank         INTEGER NOT NULL,
    move         TEXT NOT NULL,
    score        INTEGER NOT NULL,
    main_line    INTEGER NOT NULL,
    searched     INTEGER NOT NULL,
    child_key    TEXT,
    PRIMARY KEY (mode_id, position_key, rank)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS opening_graph_meta (
    mode_id            TEXT PRIMARY KEY,
    mode_name          TEXT NOT NULL,
    engine_version     TEXT NOT NULL,
    rules_version      INTEGER NOT NULL,
    weights            TEXT NOT NULL,
    symmetry           TEXT NOT NULL,
    max_ply            INTEGER NOT NULL,
    root_key           TEXT NOT NULL,
    main_line_json     TEXT NOT NULL,
    featured_json      TEXT NOT NULL,
    position_count     INTEGER NOT NULL,
    updated_at_unix_ms INTEGER NOT NULL
);
`
	if _, err := store.db.ExecContext(ctx, schema); err != nil {
		return fmt.Errorf("migrate opening graph: %w", err)
	}
	return nil
}

// ReplaceOpeningGraph swaps in a whole published book for one mode.
//
// One transaction, because a half-replaced book is a book that answers some
// lines from the new scan and some from the old, and the two do not have to
// agree about anything.
func (store *Store) ReplaceOpeningGraph(
	ctx context.Context,
	meta OpeningGraphMeta,
	positions []OpeningPosition,
) (OpeningGraphMeta, error) {
	modeID := strings.TrimSpace(meta.ModeID)
	if modeID == "" {
		return OpeningGraphMeta{}, fmt.Errorf("replace opening graph: mode is required")
	}
	if len(positions) == 0 {
		return OpeningGraphMeta{}, fmt.Errorf("replace opening graph: no positions")
	}
	mainLine, err := json.Marshal(nonNilLines(meta.MainLine))
	if err != nil {
		return OpeningGraphMeta{}, fmt.Errorf("encode main line: %w", err)
	}
	featured, err := json.Marshal(nonNilFeatured(meta.Featured))
	if err != nil {
		return OpeningGraphMeta{}, fmt.Errorf("encode featured lines: %w", err)
	}

	tx, err := store.db.BeginTx(ctx, nil)
	if err != nil {
		return OpeningGraphMeta{}, fmt.Errorf("replace opening graph: %w", err)
	}
	defer tx.Rollback()

	for _, statement := range []string{
		`DELETE FROM opening_edges WHERE mode_id = ?`,
		`DELETE FROM opening_positions WHERE mode_id = ?`,
		// The pre-graph blob is superseded by these tables; dropping the row
		// keeps a stale document from being served by any straggling reader.
		`DELETE FROM opening_books WHERE mode_id = ?`,
	} {
		if _, err := tx.ExecContext(ctx, statement, modeID); err != nil {
			return OpeningGraphMeta{}, fmt.Errorf("clear opening graph: %w", err)
		}
	}

	insertPosition, err := tx.PrepareContext(ctx, `
INSERT INTO opening_positions
    (mode_id, position_key, turn, score, depth, selective_depth, nodes)
VALUES (?, ?, ?, ?, ?, ?, ?)
`)
	if err != nil {
		return OpeningGraphMeta{}, fmt.Errorf("prepare opening position: %w", err)
	}
	defer insertPosition.Close()
	insertEdge, err := tx.PrepareContext(ctx, `
INSERT INTO opening_edges
    (mode_id, position_key, rank, move, score, main_line, searched, child_key)
VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`)
	if err != nil {
		return OpeningGraphMeta{}, fmt.Errorf("prepare opening edge: %w", err)
	}
	defer insertEdge.Close()

	for _, position := range positions {
		if _, err := insertPosition.ExecContext(ctx,
			modeID, position.Key, position.Turn, position.Score,
			position.Depth, position.SelectiveDepth, position.Nodes,
		); err != nil {
			return OpeningGraphMeta{}, fmt.Errorf("insert opening position: %w", err)
		}
		for _, move := range position.Moves {
			var child any
			if move.Child != "" {
				child = move.Child
			}
			if _, err := insertEdge.ExecContext(ctx,
				modeID, position.Key, move.Rank, move.Move, move.Score,
				move.MainLine, move.Searched, child,
			); err != nil {
				return OpeningGraphMeta{}, fmt.Errorf("insert opening edge: %w", err)
			}
		}
	}

	now := time.Now().UnixMilli()
	if _, err := tx.ExecContext(ctx, `
INSERT INTO opening_graph_meta (
    mode_id, mode_name, engine_version, rules_version, weights, symmetry,
    max_ply, root_key, main_line_json, featured_json, position_count,
    updated_at_unix_ms
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(mode_id) DO UPDATE SET
    mode_name = excluded.mode_name,
    engine_version = excluded.engine_version,
    rules_version = excluded.rules_version,
    weights = excluded.weights,
    symmetry = excluded.symmetry,
    max_ply = excluded.max_ply,
    root_key = excluded.root_key,
    main_line_json = excluded.main_line_json,
    featured_json = excluded.featured_json,
    position_count = excluded.position_count,
    updated_at_unix_ms = excluded.updated_at_unix_ms
`,
		modeID, meta.ModeName, meta.EngineVersion, meta.RulesVersion, meta.Weights,
		meta.Symmetry, meta.MaxPly, meta.RootKey, string(mainLine), string(featured),
		len(positions), now,
	); err != nil {
		return OpeningGraphMeta{}, fmt.Errorf("write opening graph meta: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return OpeningGraphMeta{}, fmt.Errorf("commit opening graph: %w", err)
	}

	meta.ModeID = modeID
	meta.PositionCount = len(positions)
	meta.UpdatedAtUnixMs = now
	return meta, nil
}

// OpeningGraph returns a mode's book metadata, without any of its positions.
func (store *Store) OpeningGraph(ctx context.Context, modeID string) (OpeningGraphMeta, error) {
	var meta OpeningGraphMeta
	var mainLine, featured string
	err := store.db.QueryRowContext(ctx, `
SELECT mode_name, engine_version, rules_version, weights, symmetry, max_ply,
       root_key, main_line_json, featured_json, position_count, updated_at_unix_ms
FROM opening_graph_meta
WHERE mode_id = ?
`, strings.TrimSpace(modeID)).Scan(
		&meta.ModeName, &meta.EngineVersion, &meta.RulesVersion, &meta.Weights,
		&meta.Symmetry, &meta.MaxPly, &meta.RootKey, &mainLine, &featured,
		&meta.PositionCount, &meta.UpdatedAtUnixMs,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return OpeningGraphMeta{}, ErrOpeningBookNotFound
	}
	if err != nil {
		return OpeningGraphMeta{}, fmt.Errorf("get opening graph: %w", err)
	}
	meta.ModeID = strings.TrimSpace(modeID)
	if err := json.Unmarshal([]byte(mainLine), &meta.MainLine); err != nil {
		return OpeningGraphMeta{}, fmt.Errorf("decode main line: %w", err)
	}
	if err := json.Unmarshal([]byte(featured), &meta.Featured); err != nil {
		return OpeningGraphMeta{}, fmt.Errorf("decode featured lines: %w", err)
	}
	return meta, nil
}

// OpeningPositionAt returns one position and its ranked moves.
//
// The join is what lets a move list render without a request per move: a move's
// child contributes only the two fields the list shows.
func (store *Store) OpeningPositionAt(
	ctx context.Context,
	modeID string,
	key string,
) (OpeningPosition, error) {
	modeID = strings.TrimSpace(modeID)
	position := OpeningPosition{Key: key, Moves: make([]OpeningMove, 0, 8)}
	err := store.db.QueryRowContext(ctx, `
SELECT turn, score, depth, selective_depth, nodes
FROM opening_positions
WHERE mode_id = ? AND position_key = ?
`, modeID, key).Scan(
		&position.Turn, &position.Score, &position.Depth,
		&position.SelectiveDepth, &position.Nodes,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return OpeningPosition{}, ErrOpeningLineNotFound
	}
	if err != nil {
		return OpeningPosition{}, fmt.Errorf("get opening position: %w", err)
	}

	rows, err := store.db.QueryContext(ctx, `
SELECT edge.rank, edge.move, edge.score, edge.main_line, edge.searched,
       edge.child_key, child.turn, child.depth
FROM opening_edges AS edge
LEFT JOIN opening_positions AS child
       ON child.mode_id = edge.mode_id AND child.position_key = edge.child_key
WHERE edge.mode_id = ? AND edge.position_key = ?
ORDER BY edge.rank
`, modeID, key)
	if err != nil {
		return OpeningPosition{}, fmt.Errorf("list opening moves: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var move OpeningMove
		var child, childTurn sql.NullString
		var childDepth sql.NullInt64
		if err := rows.Scan(
			&move.Rank, &move.Move, &move.Score, &move.MainLine, &move.Searched,
			&child, &childTurn, &childDepth,
		); err != nil {
			return OpeningPosition{}, fmt.Errorf("scan opening move: %w", err)
		}
		move.Child = child.String
		move.ChildTurn = childTurn.String
		move.ChildDepth = int(childDepth.Int64)
		position.Moves = append(position.Moves, move)
	}
	if err := rows.Err(); err != nil {
		return OpeningPosition{}, fmt.Errorf("list opening moves: %w", err)
	}
	return position, nil
}

// ResolveOpeningLine walks a line from the start and returns the keys it passes
// through, beginning with the root. A line of n moves yields n+1 keys.
func (store *Store) ResolveOpeningLine(
	ctx context.Context,
	modeID string,
	rootKey string,
	line []string,
) ([]string, error) {
	modeID = strings.TrimSpace(modeID)
	path := make([]string, 0, len(line)+1)
	path = append(path, rootKey)
	current := rootKey
	for _, move := range line {
		var child sql.NullString
		err := store.db.QueryRowContext(ctx, `
SELECT child_key FROM opening_edges
WHERE mode_id = ? AND position_key = ? AND move = ?
`, modeID, current, move).Scan(&child)
		if errors.Is(err, sql.ErrNoRows) || (err == nil && !child.Valid) {
			return nil, ErrOpeningLineNotFound
		}
		if err != nil {
			return nil, fmt.Errorf("resolve opening line: %w", err)
		}
		current = child.String
		path = append(path, current)
	}
	return path, nil
}

// OpeningLineExists reports whether a line is one the book has, which is a
// weaker question than resolving it.
//
// The last move only has to be a move the engine *ranked*: a line that ends at
// the frontier -- analyzed, but with nothing stored behind it -- is still a real
// line and still worth naming. Only the moves before it need a child, because
// those are the ones the walk has to step through.
func (store *Store) OpeningLineExists(
	ctx context.Context,
	modeID string,
	rootKey string,
	line []string,
) (bool, error) {
	if len(line) == 0 {
		return false, nil
	}
	path, err := store.ResolveOpeningLine(ctx, modeID, rootKey, line[:len(line)-1])
	if errors.Is(err, ErrOpeningLineNotFound) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	var found int
	err = store.db.QueryRowContext(ctx, `
SELECT COUNT(*) FROM opening_edges
WHERE mode_id = ? AND position_key = ? AND move = ?
`, strings.TrimSpace(modeID), path[len(path)-1], line[len(line)-1]).Scan(&found)
	if err != nil {
		return false, fmt.Errorf("check opening line: %w", err)
	}
	return found > 0, nil
}

// json.Marshal turns a nil slice into `null`; these keep it `[]`, so a reader
// never has to tell "no featured openings" from "field missing".
func nonNilLines(line []string) []string {
	if line == nil {
		return []string{}
	}
	return line
}

func nonNilFeatured(featured [][]string) [][]string {
	if featured == nil {
		return [][]string{}
	}
	for index, line := range featured {
		featured[index] = nonNilLines(line)
	}
	return featured
}
