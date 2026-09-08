package persistence

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
	"unicode/utf8"
)

var (
	ErrOpeningBookNotFound = errors.New("opening book not found")
	ErrOpeningNameNotFound = errors.New("opening name suggestion not found")
	// ErrOpeningLineNamed means somebody got there first. A player name is
	// published on the spot rather than queued, so the second person to name a
	// line is told it has one instead of quietly overwriting it -- a name that
	// changes under the people already using it is worse than a name they
	// disagree with, and disagreeing is what suggestions are for.
	ErrOpeningLineNamed = errors.New("opening line already named")
	// ErrOpeningLineTooLong means the line runs past PlayerOpeningNameLimit.
	ErrOpeningLineTooLong = errors.New("opening line too long to name")
	ErrInvalidOpeningName = errors.New("invalid opening name")
)

// OpeningBookDocument is the engine-produced artifact plus its import time.
// The server deliberately keeps the JSON opaque: RPSFish owns scores and move
// ordering, while this package owns only publication and human names.
type OpeningBookDocument struct {
	ModeID          string          `json:"modeId"`
	Document        json.RawMessage `json:"book"`
	UpdatedAtUnixMs int64           `json:"updatedAtUnixMs"`
}

type OpeningName struct {
	ModeID          string   `json:"modeId"`
	Line            []string `json:"line"`
	Name            string   `json:"name"`
	UpdatedAtUnixMs int64    `json:"updatedAtUnixMs"`
	// Source is OpeningNameCurator or OpeningNamePlayer.
	Source string `json:"source"`
	// Author is who published it, when a signed-in player did. Empty for a
	// curator name and for a name published before authorship was recorded.
	AuthorUserID   string `json:"authorUserId,omitempty"`
	AuthorUsername string `json:"authorUsername,omitempty"`
}

// Who named a line.
//
// The distinction is not decoration: a curator name is the book's own, shipped
// with the page and shown by default, while a player name is remembered and
// found by looking for it. Storing the source is what lets one screen show
// both without implying the engine vouched for either.
const (
	// OpeningNameCurator is a name published from the curator screen.
	OpeningNameCurator = "curator"
	// OpeningNamePlayer is a name a player published themselves.
	OpeningNamePlayer = "player"
)

// PlayerOpeningNameLimit is how many plies of a line a player may name.
//
// Where "book" ends is genuinely unclear -- there is no ply at which a game
// stops being an opening -- so this does not try to find that line. It picks a
// length at which a name is still describing an idea rather than a game: three
// moves each. Past it the honest answer is that the position has no name,
// which is what the screen says.
const PlayerOpeningNameLimit = 6

type OpeningNameSuggestion struct {
	SuggestionID    int64    `json:"suggestionId"`
	ModeID          string   `json:"modeId"`
	Line            []string `json:"line"`
	Name            string   `json:"name"`
	CreatedAtUnixMs int64    `json:"createdAtUnixMs"`
}

func (store *Store) ensureOpeningBookSchema(ctx context.Context) error {
	const schema = `
CREATE TABLE IF NOT EXISTS opening_books (
    mode_id TEXT PRIMARY KEY,
    document_json BLOB NOT NULL,
    updated_at_unix_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS opening_names (
    mode_id TEXT NOT NULL,
    line_key TEXT NOT NULL,
    line_json TEXT NOT NULL,
    name TEXT NOT NULL,
    updated_at_unix_ms INTEGER NOT NULL,
    -- No CHECK on source: ADD COLUMN cannot carry one, so a database migrated
    -- into these columns could not satisfy it and the two would disagree
    -- about what the schema is.
    source TEXT NOT NULL DEFAULT 'curator',
    author_user_id TEXT NOT NULL DEFAULT '',
    author_username TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (mode_id, line_key)
);

CREATE TABLE IF NOT EXISTS opening_name_suggestions (
    suggestion_id INTEGER PRIMARY KEY AUTOINCREMENT,
    mode_id TEXT NOT NULL,
    line_key TEXT NOT NULL,
    line_json TEXT NOT NULL,
    name TEXT NOT NULL,
    created_at_unix_ms INTEGER NOT NULL,
    UNIQUE (mode_id, line_key, name)
);

CREATE INDEX IF NOT EXISTS opening_names_mode_idx
    ON opening_names(mode_id, line_key);
CREATE INDEX IF NOT EXISTS opening_suggestions_mode_idx
    ON opening_name_suggestions(mode_id, created_at_unix_ms, suggestion_id);
-- The browse index is ordered by recency within a mode, because "what have
-- people been naming" is the question that screen exists to answer.
CREATE INDEX IF NOT EXISTS opening_names_recent_idx
    ON opening_names(mode_id, updated_at_unix_ms DESC);
`
	if _, err := store.db.ExecContext(ctx, schema); err != nil {
		return fmt.Errorf("migrate opening books: %w", err)
	}
	// CREATE TABLE IF NOT EXISTS does nothing to a table that already exists,
	// so a database from before players could name lines needs the columns
	// adding. Every name already in it was published by a curator, which is
	// what the default says.
	columns, err := tableColumns(ctx, store.db, "opening_names")
	if err != nil {
		return fmt.Errorf("inspect opening names schema: %w", err)
	}
	for _, migration := range []struct{ name, definition string }{
		{"source", "TEXT NOT NULL DEFAULT 'curator'"},
		{"author_user_id", "TEXT NOT NULL DEFAULT ''"},
		{"author_username", "TEXT NOT NULL DEFAULT ''"},
	} {
		if columns[migration.name] {
			continue
		}
		if _, err := store.db.ExecContext(ctx, fmt.Sprintf(
			"ALTER TABLE opening_names ADD COLUMN %s %s",
			migration.name, migration.definition,
		)); err != nil {
			return fmt.Errorf("add opening_names.%s: %w", migration.name, err)
		}
	}
	return nil
}

func (store *Store) ReplaceOpeningBook(
	ctx context.Context,
	modeID string,
	document json.RawMessage,
) (OpeningBookDocument, error) {
	modeID = strings.TrimSpace(modeID)
	if modeID == "" || len(document) == 0 || !json.Valid(document) {
		return OpeningBookDocument{}, fmt.Errorf("replace opening book: invalid document")
	}
	now := time.Now().UnixMilli()
	if _, err := store.db.ExecContext(ctx, `
INSERT INTO opening_books (mode_id, document_json, updated_at_unix_ms)
VALUES (?, ?, ?)
ON CONFLICT(mode_id) DO UPDATE SET
    document_json = excluded.document_json,
    updated_at_unix_ms = excluded.updated_at_unix_ms
`, modeID, []byte(document), now); err != nil {
		return OpeningBookDocument{}, fmt.Errorf("replace opening book: %w", err)
	}
	return OpeningBookDocument{
		ModeID:          modeID,
		Document:        append(json.RawMessage(nil), document...),
		UpdatedAtUnixMs: now,
	}, nil
}

func (store *Store) OpeningBook(ctx context.Context, modeID string) (OpeningBookDocument, error) {
	var document []byte
	var updated int64
	err := store.db.QueryRowContext(ctx, `
SELECT document_json, updated_at_unix_ms
FROM opening_books
WHERE mode_id = ?
`, strings.TrimSpace(modeID)).Scan(&document, &updated)
	if errors.Is(err, sql.ErrNoRows) {
		return OpeningBookDocument{}, ErrOpeningBookNotFound
	}
	if err != nil {
		return OpeningBookDocument{}, fmt.Errorf("get opening book: %w", err)
	}
	return OpeningBookDocument{
		ModeID:          strings.TrimSpace(modeID),
		Document:        json.RawMessage(document),
		UpdatedAtUnixMs: updated,
	}, nil
}

func normalizeOpeningLine(line []string) ([]string, string, string, error) {
	if len(line) == 0 || len(line) > 128 {
		return nil, "", "", fmt.Errorf("%w: choose a line between 1 and 128 moves", ErrInvalidOpeningName)
	}
	normalized := make([]string, len(line))
	for index, move := range line {
		move = strings.TrimSpace(move)
		if len(move) != 5 || move[2] != '-' ||
			move[0] < 'a' || move[0] > 'i' || move[1] < '1' || move[1] > '9' ||
			move[3] < 'a' || move[3] > 'i' || move[4] < '1' || move[4] > '9' ||
			move[:2] == move[3:] {
			return nil, "", "", fmt.Errorf("%w: move %d is not notation like d7-d6", ErrInvalidOpeningName, index+1)
		}
		normalized[index] = move
	}
	encoded, err := json.Marshal(normalized)
	if err != nil {
		return nil, "", "", fmt.Errorf("encode opening line: %w", err)
	}
	return normalized, strings.Join(normalized, " "), string(encoded), nil
}

func normalizeOpeningName(name string) (string, error) {
	name = strings.Join(strings.Fields(name), " ")
	if utf8.RuneCountInString(name) < 2 || utf8.RuneCountInString(name) > 80 {
		return "", fmt.Errorf("%w: use between 2 and 80 characters", ErrInvalidOpeningName)
	}
	for _, character := range name {
		if character < ' ' || character == '\u007f' {
			return "", fmt.Errorf("%w: control characters are not allowed", ErrInvalidOpeningName)
		}
	}
	return name, nil
}

// SetOpeningName publishes a name for a line, and resolves that line's queue.
//
// Clearing the pending suggestions is the same act approval performs, for the
// same reason: the queue means "lines still waiting for a name", and a line
// that has one is no longer waiting. A curator who types a name over a line
// that had three proposals has answered all three.
func (store *Store) SetOpeningName(
	ctx context.Context,
	modeID string,
	line []string,
	name string,
) (OpeningName, error) {
	normalized, key, encoded, err := normalizeOpeningLine(line)
	if err != nil {
		return OpeningName{}, err
	}
	name, err = normalizeOpeningName(name)
	if err != nil {
		return OpeningName{}, err
	}
	modeID = strings.TrimSpace(modeID)
	now := time.Now().UnixMilli()
	tx, err := store.db.BeginTx(ctx, nil)
	if err != nil {
		return OpeningName{}, fmt.Errorf("set opening name: %w", err)
	}
	defer tx.Rollback()
	if err := publishOpeningName(
		ctx, tx, modeID, key, encoded, name, now, OpeningNameCurator, "", "",
	); err != nil {
		return OpeningName{}, err
	}
	if err := tx.Commit(); err != nil {
		return OpeningName{}, fmt.Errorf("commit opening name: %w", err)
	}
	return OpeningName{
		ModeID: modeID, Line: normalized, Name: name,
		UpdatedAtUnixMs: now, Source: OpeningNameCurator,
	}, nil
}

// PublishPlayerOpeningName is a player naming a line, published on the spot.
//
// No queue, deliberately. A line nobody has named shows "suggest a name", and
// the honest answer to somebody who then types one is to use it -- a proposal
// that sits invisible until a curator happens to look is a question the site
// asked and then ignored. What that costs is a name nobody vetted, which is
// why the source travels with it, the author is recorded, and a curator can
// take it off again.
//
// Two rules keep this from swallowing the book. The line may not run past
// PlayerOpeningNameLimit, and a line that already has a name is refused rather
// than overwritten: first to name it wins, and everybody after them is
// offering an alternative, which is what a suggestion is.
func (store *Store) PublishPlayerOpeningName(
	ctx context.Context,
	modeID string,
	line []string,
	name string,
	authorUserID string,
	authorUsername string,
) (OpeningName, error) {
	normalized, key, encoded, err := normalizeOpeningLine(line)
	if err != nil {
		return OpeningName{}, err
	}
	if len(normalized) > PlayerOpeningNameLimit {
		return OpeningName{}, fmt.Errorf(
			"%w: name the first %d moves or fewer",
			ErrOpeningLineTooLong, PlayerOpeningNameLimit,
		)
	}
	name, err = normalizeOpeningName(name)
	if err != nil {
		return OpeningName{}, err
	}
	modeID = strings.TrimSpace(modeID)
	now := time.Now().UnixMilli()

	tx, err := store.db.BeginTx(ctx, nil)
	if err != nil {
		return OpeningName{}, fmt.Errorf("name opening: %w", err)
	}
	defer tx.Rollback()

	// Inside the transaction, so two people naming the same line in the same
	// second cannot both be told they were first.
	var existing string
	err = tx.QueryRowContext(ctx, `
SELECT name FROM opening_names WHERE mode_id = ? AND line_key = ?
`, modeID, key).Scan(&existing)
	switch {
	case err == nil:
		return OpeningName{}, fmt.Errorf("%w: it is called %q", ErrOpeningLineNamed, existing)
	case !errors.Is(err, sql.ErrNoRows):
		return OpeningName{}, fmt.Errorf("name opening: %w", err)
	}

	if err := publishOpeningName(
		ctx, tx, modeID, key, encoded, name, now,
		OpeningNamePlayer, strings.TrimSpace(authorUserID), strings.TrimSpace(authorUsername),
	); err != nil {
		return OpeningName{}, err
	}
	if err := tx.Commit(); err != nil {
		return OpeningName{}, fmt.Errorf("commit opening name: %w", err)
	}
	return OpeningName{
		ModeID: modeID, Line: normalized, Name: name, UpdatedAtUnixMs: now,
		Source:         OpeningNamePlayer,
		AuthorUserID:   strings.TrimSpace(authorUserID),
		AuthorUsername: strings.TrimSpace(authorUsername),
	}, nil
}

// publishOpeningName is the one place a name becomes published, shared by
// naming a line outright and approving somebody's suggestion for it.
func publishOpeningName(
	ctx context.Context,
	tx *sql.Tx,
	modeID, key, encoded, name string,
	now int64,
	source, authorUserID, authorUsername string,
) error {
	if _, err := tx.ExecContext(ctx, `
INSERT INTO opening_names (
    mode_id, line_key, line_json, name, updated_at_unix_ms,
    source, author_user_id, author_username
)
VALUES (?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(mode_id, line_key) DO UPDATE SET
    line_json = excluded.line_json,
    name = excluded.name,
    updated_at_unix_ms = excluded.updated_at_unix_ms,
    source = excluded.source,
    author_user_id = excluded.author_user_id,
    author_username = excluded.author_username
`, modeID, key, encoded, name, now, source, authorUserID, authorUsername); err != nil {
		return fmt.Errorf("publish opening name: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `
DELETE FROM opening_name_suggestions WHERE mode_id = ? AND line_key = ?
`, modeID, key); err != nil {
		return fmt.Errorf("clear opening suggestions: %w", err)
	}
	return nil
}

// DeleteOpeningName unpublishes a name, leaving the line unnamed again.
//
// A curator needs this for the name that turned out to be wrong: without it
// the only way out of a bad name is a better one, and "no name yet" is a
// perfectly good state for a line to return to.
func (store *Store) DeleteOpeningName(ctx context.Context, modeID string, line []string) error {
	_, key, _, err := normalizeOpeningLine(line)
	if err != nil {
		return err
	}
	result, err := store.db.ExecContext(ctx, `
DELETE FROM opening_names WHERE mode_id = ? AND line_key = ?
`, strings.TrimSpace(modeID), key)
	if err != nil {
		return fmt.Errorf("delete opening name: %w", err)
	}
	if affected, err := result.RowsAffected(); err == nil && affected == 0 {
		return ErrOpeningNameNotFound
	}
	return nil
}

// DeleteOpeningNameSuggestion turns down one proposal without naming the line.
func (store *Store) DeleteOpeningNameSuggestion(
	ctx context.Context,
	modeID string,
	suggestionID int64,
) error {
	result, err := store.db.ExecContext(ctx, `
DELETE FROM opening_name_suggestions WHERE mode_id = ? AND suggestion_id = ?
`, strings.TrimSpace(modeID), suggestionID)
	if err != nil {
		return fmt.Errorf("delete opening suggestion: %w", err)
	}
	if affected, err := result.RowsAffected(); err == nil && affected == 0 {
		return ErrOpeningNameNotFound
	}
	return nil
}

func (store *Store) OpeningNames(ctx context.Context, modeID string) ([]OpeningName, error) {
	rows, err := store.db.QueryContext(ctx, `
SELECT line_json, name, updated_at_unix_ms, source, author_user_id, author_username
FROM opening_names
WHERE mode_id = ?
ORDER BY length(line_key), line_key
`, strings.TrimSpace(modeID))
	if err != nil {
		return nil, fmt.Errorf("list opening names: %w", err)
	}
	defer rows.Close()
	names := make([]OpeningName, 0)
	for rows.Next() {
		var encoded string
		var opening OpeningName
		opening.ModeID = strings.TrimSpace(modeID)
		if err := rows.Scan(
			&encoded, &opening.Name, &opening.UpdatedAtUnixMs,
			&opening.Source, &opening.AuthorUserID, &opening.AuthorUsername,
		); err != nil {
			return nil, fmt.Errorf("scan opening name: %w", err)
		}
		if err := json.Unmarshal([]byte(encoded), &opening.Line); err != nil {
			return nil, fmt.Errorf("decode opening line: %w", err)
		}
		names = append(names, opening)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("list opening names: %w", err)
	}
	return names, nil
}

func (store *Store) SuggestOpeningName(
	ctx context.Context,
	modeID string,
	line []string,
	name string,
) (OpeningNameSuggestion, error) {
	normalized, key, encoded, err := normalizeOpeningLine(line)
	if err != nil {
		return OpeningNameSuggestion{}, err
	}
	name, err = normalizeOpeningName(name)
	if err != nil {
		return OpeningNameSuggestion{}, err
	}
	modeID = strings.TrimSpace(modeID)
	now := time.Now().UnixMilli()
	_, err = store.db.ExecContext(ctx, `
INSERT INTO opening_name_suggestions (
    mode_id, line_key, line_json, name, created_at_unix_ms
) VALUES (?, ?, ?, ?, ?)
ON CONFLICT(mode_id, line_key, name) DO UPDATE SET
    created_at_unix_ms = excluded.created_at_unix_ms
`, modeID, key, encoded, name, now)
	if err != nil {
		return OpeningNameSuggestion{}, fmt.Errorf("suggest opening name: %w", err)
	}
	var id int64
	err = store.db.QueryRowContext(ctx, `
SELECT suggestion_id FROM opening_name_suggestions
WHERE mode_id = ? AND line_key = ? AND name = ?
`, modeID, key, name).Scan(&id)
	if err != nil {
		return OpeningNameSuggestion{}, fmt.Errorf("read opening suggestion: %w", err)
	}
	return OpeningNameSuggestion{
		SuggestionID: id, ModeID: modeID, Line: normalized, Name: name, CreatedAtUnixMs: now,
	}, nil
}

func (store *Store) OpeningNameSuggestions(
	ctx context.Context,
	modeID string,
) ([]OpeningNameSuggestion, error) {
	rows, err := store.db.QueryContext(ctx, `
SELECT suggestion_id, line_json, name, created_at_unix_ms
FROM opening_name_suggestions
WHERE mode_id = ?
ORDER BY created_at_unix_ms, suggestion_id
`, strings.TrimSpace(modeID))
	if err != nil {
		return nil, fmt.Errorf("list opening suggestions: %w", err)
	}
	defer rows.Close()
	suggestions := make([]OpeningNameSuggestion, 0)
	for rows.Next() {
		var encoded string
		var suggestion OpeningNameSuggestion
		suggestion.ModeID = strings.TrimSpace(modeID)
		if err := rows.Scan(
			&suggestion.SuggestionID,
			&encoded,
			&suggestion.Name,
			&suggestion.CreatedAtUnixMs,
		); err != nil {
			return nil, fmt.Errorf("scan opening suggestion: %w", err)
		}
		if err := json.Unmarshal([]byte(encoded), &suggestion.Line); err != nil {
			return nil, fmt.Errorf("decode suggested opening line: %w", err)
		}
		suggestions = append(suggestions, suggestion)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("list opening suggestions: %w", err)
	}
	return suggestions, nil
}

func (store *Store) ApproveOpeningNameSuggestion(
	ctx context.Context,
	modeID string,
	suggestionID int64,
) (OpeningName, error) {
	tx, err := store.db.BeginTx(ctx, nil)
	if err != nil {
		return OpeningName{}, fmt.Errorf("approve opening suggestion: %w", err)
	}
	defer tx.Rollback()
	var encoded, name string
	err = tx.QueryRowContext(ctx, `
SELECT line_json, name
FROM opening_name_suggestions
WHERE mode_id = ? AND suggestion_id = ?
`, strings.TrimSpace(modeID), suggestionID).Scan(&encoded, &name)
	if errors.Is(err, sql.ErrNoRows) {
		return OpeningName{}, ErrOpeningNameNotFound
	}
	if err != nil {
		return OpeningName{}, fmt.Errorf("find opening suggestion: %w", err)
	}
	var line []string
	if err := json.Unmarshal([]byte(encoded), &line); err != nil {
		return OpeningName{}, fmt.Errorf("decode opening suggestion: %w", err)
	}
	_, key, normalizedJSON, err := normalizeOpeningLine(line)
	if err != nil {
		return OpeningName{}, err
	}
	now := time.Now().UnixMilli()
	// A curator source, even though somebody else wrote the words: the source
	// records who vouched for the name, and approving is exactly that act.
	if err := publishOpeningName(
		ctx, tx, strings.TrimSpace(modeID), key, normalizedJSON, name, now,
		OpeningNameCurator, "", "",
	); err != nil {
		return OpeningName{}, err
	}
	if err := tx.Commit(); err != nil {
		return OpeningName{}, fmt.Errorf("commit opening name: %w", err)
	}
	return OpeningName{
		ModeID: strings.TrimSpace(modeID), Line: line, Name: name,
		UpdatedAtUnixMs: now, Source: OpeningNameCurator,
	}, nil
}

// RekeyOpeningLines rewrites stored lines into the caller's canonical form.
//
// Names are keyed by the line that reaches them, and the rule for which of two
// equivalent lines is *the* key lives above this package, with the rules that
// make them equivalent. When that rule arrives -- or changes -- rows written
// under the old one would quietly become unreachable: the screen would ask for
// the canonical key, find nothing, and offer to name a line that already has a
// name. So the owner of the rule hands it here once at startup and this walks
// the mode's rows into line with it.
//
// Collisions are real: a line and its mirror can each have been named before
// they were understood to be the same opening. `canonical` decides which key
// they share, and the order rows are walked in decides which of the two
// survives -- the most recent decision for a published name, the first
// proposal for a suggestion, since part of a suggestion's worth is that
// somebody said it first.
func (store *Store) RekeyOpeningLines(
	ctx context.Context,
	modeID string,
	canonical func([]string) []string,
) (int, error) {
	modeID = strings.TrimSpace(modeID)
	tx, err := store.db.BeginTx(ctx, nil)
	if err != nil {
		return 0, fmt.Errorf("rekey opening lines: %w", err)
	}
	defer tx.Rollback()

	changed := 0
	names, err := storedOpeningLines(ctx, tx, `
SELECT line_key, line_json FROM opening_names
WHERE mode_id = ? ORDER BY updated_at_unix_ms DESC, line_key
`, modeID)
	if err != nil {
		return 0, err
	}
	for _, row := range names {
		key, encoded, wanted := canonicalOpeningKey(canonical, row)
		if !wanted {
			continue
		}
		// Copied onto the canonical key and then removed, rather than renamed
		// in place: the key can already be taken, by the other half of the pair
		// having been named back when the two looked like two openings. Only
		// one of them can survive that, and the guard below says which -- the
		// decision somebody made most recently.
		// Every column travels, provenance included. Leaving source and author
		// off the select does not blank them -- it takes their *defaults*, so
		// a player's name silently became the book's own and lost its author
		// the first time the server started after they wrote it.
		if _, err := tx.ExecContext(ctx, `
INSERT INTO opening_names (
    mode_id, line_key, line_json, name, updated_at_unix_ms,
    source, author_user_id, author_username
)
SELECT mode_id, ?, ?, name, updated_at_unix_ms,
       source, author_user_id, author_username
FROM opening_names
WHERE mode_id = ? AND line_key = ?
ON CONFLICT(mode_id, line_key) DO UPDATE SET
    line_json = excluded.line_json,
    name = excluded.name,
    updated_at_unix_ms = excluded.updated_at_unix_ms,
    source = excluded.source,
    author_user_id = excluded.author_user_id,
    author_username = excluded.author_username
WHERE excluded.updated_at_unix_ms > opening_names.updated_at_unix_ms
`, key, encoded, modeID, row.key); err != nil {
			return 0, fmt.Errorf("rekey opening name: %w", err)
		}
		if _, err := tx.ExecContext(ctx, `
DELETE FROM opening_names WHERE mode_id = ? AND line_key = ?
`, modeID, row.key); err != nil {
			return 0, fmt.Errorf("drop rekeyed opening name: %w", err)
		}
		changed++
	}

	suggestions, err := storedOpeningLines(ctx, tx, `
SELECT line_key, line_json FROM opening_name_suggestions
WHERE mode_id = ? ORDER BY created_at_unix_ms, suggestion_id
`, modeID)
	if err != nil {
		return 0, err
	}
	for _, row := range suggestions {
		key, encoded, wanted := canonicalOpeningKey(canonical, row)
		if !wanted {
			continue
		}
		// Every proposal for the line moves at once: they differ only by name,
		// and the name is the rest of what makes a proposal distinct. A name
		// already proposed for the canonical line is the same proposal said
		// twice, and the one already there was said first.
		result, err := tx.ExecContext(ctx, `
INSERT INTO opening_name_suggestions (mode_id, line_key, line_json, name, created_at_unix_ms)
SELECT mode_id, ?, ?, name, created_at_unix_ms FROM opening_name_suggestions
WHERE mode_id = ? AND line_key = ?
ON CONFLICT(mode_id, line_key, name) DO NOTHING
`, key, encoded, modeID, row.key)
		if err != nil {
			return 0, fmt.Errorf("rekey opening suggestion: %w", err)
		}
		moved, err := result.RowsAffected()
		if err != nil {
			return 0, fmt.Errorf("rekey opening suggestion: %w", err)
		}
		if _, err := tx.ExecContext(ctx, `
DELETE FROM opening_name_suggestions WHERE mode_id = ? AND line_key = ?
`, modeID, row.key); err != nil {
			return 0, fmt.Errorf("drop rekeyed opening suggestion: %w", err)
		}
		changed += int(moved)
	}

	if err := tx.Commit(); err != nil {
		return 0, fmt.Errorf("commit rekeyed opening lines: %w", err)
	}
	return changed, nil
}

// storedOpeningLine is one distinct line found in a table, and the key it is
// stored under.
type storedOpeningLine struct {
	key  string
	line []string
}

func storedOpeningLines(
	ctx context.Context,
	tx *sql.Tx,
	query string,
	modeID string,
) ([]storedOpeningLine, error) {
	rows, err := tx.QueryContext(ctx, query, modeID)
	if err != nil {
		return nil, fmt.Errorf("read opening lines: %w", err)
	}
	defer rows.Close()
	stored := make([]storedOpeningLine, 0)
	seen := make(map[string]struct{})
	for rows.Next() {
		var row storedOpeningLine
		var encoded string
		if err := rows.Scan(&row.key, &encoded); err != nil {
			return nil, fmt.Errorf("scan opening line: %w", err)
		}
		if _, repeated := seen[row.key]; repeated {
			continue
		}
		seen[row.key] = struct{}{}
		if err := json.Unmarshal([]byte(encoded), &row.line); err != nil {
			return nil, fmt.Errorf("decode opening line: %w", err)
		}
		stored = append(stored, row)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("read opening lines: %w", err)
	}
	return stored, nil
}

// canonicalOpeningKey answers what a stored row should be keyed by, and whether
// that differs from where it is. A line this package cannot normalize is left
// exactly where it is: a row it does not understand is not a row it should move.
func canonicalOpeningKey(
	canonical func([]string) []string,
	row storedOpeningLine,
) (string, string, bool) {
	_, key, encoded, err := normalizeOpeningLine(canonical(row.line))
	if err != nil || key == row.key {
		return "", "", false
	}
	return key, encoded, true
}

// OpeningNameFilter narrows the browse index.
type OpeningNameFilter struct {
	ModeID string
	// Source restricts to OpeningNameCurator or OpeningNamePlayer. Empty means
	// both, which is what "every named opening" asks for.
	Source string
	// Query matches the name, case-insensitively, anywhere in it. It
	// deliberately does not match the line: somebody searching "stone" wants
	// the openings called that, and somebody who knows the moves has the
	// explorer.
	Query  string
	Limit  int
	Offset int
}

// OpeningNamePage is one screen of the browse index, with the total behind it.
type OpeningNamePage struct {
	Names []OpeningName `json:"names"`
	// Total is how many names match the filter, not how many are on this page,
	// so a reader can be told what they are paging through.
	Total int `json:"total"`
	// Curator and Player count the whole mode regardless of the filter. They
	// are what lets a screen say "42 book names, 380 named by players" while
	// showing one of the two.
	Curator int `json:"curator"`
	Player  int `json:"player"`
}

// BrowseOpeningNames pages the naming layer, newest first.
//
// This is the screen that makes a player name findable. The openings page
// leads with the engine's certified lines and does not list player names
// beside them -- an unvetted name shown next to a certified opening reads as
// though the engine had something to do with it. But a name nobody can find
// is a name nobody will use, so every one of them is here.
func (store *Store) BrowseOpeningNames(
	ctx context.Context,
	filter OpeningNameFilter,
) (OpeningNamePage, error) {
	modeID := strings.TrimSpace(filter.ModeID)
	page := OpeningNamePage{Names: make([]OpeningName, 0)}

	// The two totals are the whole mode, so they do not move as somebody types
	// in the search box.
	rows, err := store.db.QueryContext(ctx, `
SELECT source, COUNT(*) FROM opening_names WHERE mode_id = ? GROUP BY source
`, modeID)
	if err != nil {
		return OpeningNamePage{}, fmt.Errorf("count opening names: %w", err)
	}
	for rows.Next() {
		var source string
		var count int
		if err := rows.Scan(&source, &count); err != nil {
			rows.Close()
			return OpeningNamePage{}, fmt.Errorf("scan opening name count: %w", err)
		}
		if source == OpeningNamePlayer {
			page.Player = count
		} else {
			page.Curator = count
		}
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return OpeningNamePage{}, fmt.Errorf("count opening names: %w", err)
	}

	// LIKE with an escaped pattern rather than a bare one: a name may contain
	// `%` or `_`, and a search for it should find that name rather than
	// everything.
	where := []string{"mode_id = ?"}
	arguments := []any{modeID}
	if filter.Source == OpeningNameCurator || filter.Source == OpeningNamePlayer {
		where = append(where, "source = ?")
		arguments = append(arguments, filter.Source)
	}
	if query := strings.TrimSpace(filter.Query); query != "" {
		where = append(where, `name LIKE ? ESCAPE '\'`)
		arguments = append(arguments, "%"+escapeLikePattern(query)+"%")
	}
	condition := strings.Join(where, " AND ")

	if err := store.db.QueryRowContext(ctx,
		"SELECT COUNT(*) FROM opening_names WHERE "+condition, arguments...,
	).Scan(&page.Total); err != nil {
		return OpeningNamePage{}, fmt.Errorf("count matching opening names: %w", err)
	}

	limit := filter.Limit
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	offset := filter.Offset
	if offset < 0 {
		offset = 0
	}
	listed, err := store.db.QueryContext(ctx,
		`SELECT line_json, name, updated_at_unix_ms, source, author_user_id, author_username
FROM opening_names WHERE `+condition+`
ORDER BY updated_at_unix_ms DESC, line_key
LIMIT ? OFFSET ?`,
		append(arguments, limit, offset)...,
	)
	if err != nil {
		return OpeningNamePage{}, fmt.Errorf("browse opening names: %w", err)
	}
	defer listed.Close()
	for listed.Next() {
		var encoded string
		opening := OpeningName{ModeID: modeID}
		if err := listed.Scan(
			&encoded, &opening.Name, &opening.UpdatedAtUnixMs,
			&opening.Source, &opening.AuthorUserID, &opening.AuthorUsername,
		); err != nil {
			return OpeningNamePage{}, fmt.Errorf("scan opening name: %w", err)
		}
		if err := json.Unmarshal([]byte(encoded), &opening.Line); err != nil {
			return OpeningNamePage{}, fmt.Errorf("decode opening line: %w", err)
		}
		page.Names = append(page.Names, opening)
	}
	if err := listed.Err(); err != nil {
		return OpeningNamePage{}, fmt.Errorf("browse opening names: %w", err)
	}
	return page, nil
}

// escapeLikePattern makes a user's text safe to drop inside a LIKE pattern.
func escapeLikePattern(text string) string {
	replaced := strings.ReplaceAll(text, `\`, `\\`)
	replaced = strings.ReplaceAll(replaced, "%", `\%`)
	return strings.ReplaceAll(replaced, "_", `\_`)
}
