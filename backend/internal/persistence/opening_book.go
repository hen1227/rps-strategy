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
	ErrInvalidOpeningName  = errors.New("invalid opening name")
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
}

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
`
	if _, err := store.db.ExecContext(ctx, schema); err != nil {
		return fmt.Errorf("migrate opening books: %w", err)
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
	if err := publishOpeningName(ctx, tx, modeID, key, encoded, name, now); err != nil {
		return OpeningName{}, err
	}
	if err := tx.Commit(); err != nil {
		return OpeningName{}, fmt.Errorf("commit opening name: %w", err)
	}
	return OpeningName{ModeID: modeID, Line: normalized, Name: name, UpdatedAtUnixMs: now}, nil
}

// publishOpeningName is the one place a name becomes published, shared by
// naming a line outright and approving somebody's suggestion for it.
func publishOpeningName(
	ctx context.Context,
	tx *sql.Tx,
	modeID, key, encoded, name string,
	now int64,
) error {
	if _, err := tx.ExecContext(ctx, `
INSERT INTO opening_names (mode_id, line_key, line_json, name, updated_at_unix_ms)
VALUES (?, ?, ?, ?, ?)
ON CONFLICT(mode_id, line_key) DO UPDATE SET
    line_json = excluded.line_json,
    name = excluded.name,
    updated_at_unix_ms = excluded.updated_at_unix_ms
`, modeID, key, encoded, name, now); err != nil {
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
SELECT line_json, name, updated_at_unix_ms
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
		if err := rows.Scan(&encoded, &opening.Name, &opening.UpdatedAtUnixMs); err != nil {
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
	if err := publishOpeningName(
		ctx, tx, strings.TrimSpace(modeID), key, normalizedJSON, name, now,
	); err != nil {
		return OpeningName{}, err
	}
	if err := tx.Commit(); err != nil {
		return OpeningName{}, fmt.Errorf("commit opening name: %w", err)
	}
	return OpeningName{ModeID: strings.TrimSpace(modeID), Line: line, Name: name, UpdatedAtUnixMs: now}, nil
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
		if _, err := tx.ExecContext(ctx, `
INSERT INTO opening_names (mode_id, line_key, line_json, name, updated_at_unix_ms)
SELECT mode_id, ?, ?, name, updated_at_unix_ms FROM opening_names
WHERE mode_id = ? AND line_key = ?
ON CONFLICT(mode_id, line_key) DO UPDATE SET
    line_json = excluded.line_json,
    name = excluded.name,
    updated_at_unix_ms = excluded.updated_at_unix_ms
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
