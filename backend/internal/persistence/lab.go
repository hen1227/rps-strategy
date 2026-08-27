package persistence

// The mode library: games people wrote, and the pieces of them worth reusing.
//
// Three tables, and the shape of each is borrowed rather than invented. Modes
// follow `bots`: owner-scoped, a visibility flag, a per-account cap, soft retire
// rather than delete. Parts follow the same. Drafts are private scratch space,
// one row per author per draft, so the Lab survives a closed tab.
//
// **A published mode is immutable.** An edit is a new version under a new id,
// and that is not tidiness: a live game holds its rules, an archived record
// replays through them, and a library that let an author rewrite a mode under a
// game in progress would be a library that changes the rules mid-game. It is
// also why nothing here needs an "unregister": a mode, once loaded, is never
// wrong.

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
	ErrModeNotFound     = errors.New("mode not found")
	ErrModeExists       = errors.New("a mode with that name and version already exists")
	ErrTooManyModes     = errors.New("too many published modes for this account")
	ErrNotModeOwner     = errors.New("that mode belongs to somebody else")
	ErrPartNotFound     = errors.New("rule part not found")
	ErrTooManyRuleParts = errors.New("too many published parts for this account")
)

// MaximumModesPerAccount mirrors MaximumBotsPerAccount in spirit: publishing is
// open to anyone, and open to anyone is not the same as unlimited.
const (
	MaximumModesPerAccount  = 40
	MaximumPartsPerAccount  = 40
	MaximumDraftsPerAccount = 25
)

// CustomMode is one published mode, as the library lists it.
//
// Spec is the whole rule document. It is stored as text rather than shredded
// into columns because the database has no opinion about rules: the schema for
// a spec is `docs/rulespec.md`, and a column per field would be a second one.
type CustomMode struct {
	ModeID        string          `json:"modeId"`
	Slug          string          `json:"slug"`
	Version       int             `json:"version"`
	OwnerUserID   string          `json:"ownerUserId"`
	OwnerUsername string          `json:"ownerUsername,omitempty"`
	Name          string          `json:"name"`
	ShortCode     string          `json:"shortCode"`
	Description   string          `json:"description"`
	Objective     string          `json:"objective"`
	Spec          json.RawMessage `json:"spec"`
	// DerivedFrom names the reusable parts this mode was built from, so the
	// library can credit them. Recorded at publish time, when the references
	// were resolved and inlined.
	DerivedFrom   []string `json:"derivedFrom,omitempty"`
	Visibility    string   `json:"visibility"`
	Plays         int      `json:"plays"`
	PublishedAtMs int64    `json:"publishedAtUnixMs"`
	RetiredAtMs   int64    `json:"retiredAtUnixMs,omitempty"`
}

func (mode CustomMode) Retired() bool { return mode.RetiredAtMs > 0 }

// RulePart is a published fragment of one slot of the language.
type RulePart struct {
	PartID        string          `json:"partId"`
	Version       int             `json:"version"`
	OwnerUserID   string          `json:"ownerUserId"`
	OwnerUsername string          `json:"ownerUsername,omitempty"`
	Kind          string          `json:"kind"`
	Name          string          `json:"name"`
	Summary       string          `json:"summary"`
	Params        json.RawMessage `json:"params,omitempty"`
	Body          json.RawMessage `json:"body"`
	UsedBy        int             `json:"usedBy"`
	PublishedAtMs int64           `json:"publishedAtUnixMs"`
}

// LabDraft is a mode being worked on. Private to its author, and overwritten in
// place: the Lab's undo lives in the page, not in the database.
type LabDraft struct {
	DraftID     string          `json:"draftId"`
	OwnerUserID string          `json:"-"`
	Name        string          `json:"name"`
	Spec        json.RawMessage `json:"spec"`
	UpdatedAtMs int64           `json:"updatedAtUnixMs"`
}

func (store *Store) ensureLabSchema(ctx context.Context) error {
	const schema = `
CREATE TABLE IF NOT EXISTS custom_modes (
    mode_id TEXT PRIMARY KEY,
    slug TEXT NOT NULL,
    version INTEGER NOT NULL CHECK (version > 0),
    -- No REFERENCES accounts(user_id), for the reason bot_series states: an
    -- anonymized account leaves its id behind, and the join simply finds no
    -- name. A mode outliving its author is the right outcome — people are still
    -- playing it.
    owner_user_id TEXT NOT NULL,
    name TEXT NOT NULL,
    short_code TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    objective TEXT NOT NULL DEFAULT '',
    spec TEXT NOT NULL,
    derived_from TEXT NOT NULL DEFAULT '',
    visibility TEXT NOT NULL DEFAULT 'public'
        CHECK (visibility IN ('public', 'unlisted')),
    plays INTEGER NOT NULL DEFAULT 0,
    published_at_unix_ms INTEGER NOT NULL,
    retired_at_unix_ms INTEGER,
    UNIQUE (slug, version)
);

CREATE INDEX IF NOT EXISTS custom_modes_listing_idx
    ON custom_modes(visibility, retired_at_unix_ms, published_at_unix_ms DESC);
CREATE INDEX IF NOT EXISTS custom_modes_owner_idx
    ON custom_modes(owner_user_id, published_at_unix_ms DESC);

CREATE TABLE IF NOT EXISTS rule_parts (
    part_id TEXT NOT NULL,
    version INTEGER NOT NULL CHECK (version > 0),
    owner_user_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    name TEXT NOT NULL,
    summary TEXT NOT NULL DEFAULT '',
    params TEXT NOT NULL DEFAULT '',
    body TEXT NOT NULL,
    used_by INTEGER NOT NULL DEFAULT 0,
    published_at_unix_ms INTEGER NOT NULL,
    PRIMARY KEY (part_id, version)
);

CREATE INDEX IF NOT EXISTS rule_parts_kind_idx ON rule_parts(kind, used_by DESC);

CREATE TABLE IF NOT EXISTS lab_drafts (
    draft_id TEXT PRIMARY KEY,
    owner_user_id TEXT NOT NULL,
    name TEXT NOT NULL DEFAULT '',
    spec TEXT NOT NULL,
    updated_at_unix_ms INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS lab_drafts_owner_idx
    ON lab_drafts(owner_user_id, updated_at_unix_ms DESC);
`
	if _, err := store.db.ExecContext(ctx, schema); err != nil {
		return fmt.Errorf("ensure lab schema: %w", err)
	}
	return nil
}

/* ------------------------------------------------------------------- modes -- */

// PublishedModes is every mode the server should register at start-up.
//
// Retired ones are included on purpose: a retired mode still has games in the
// archive and players holding links to them, and a replay needs its rules. What
// retiring does is stop it accepting *new* games, which is `Playable` on the
// definition rather than absence from the registry.
func (store *Store) PublishedModes(ctx context.Context) ([]CustomMode, error) {
	rows, err := store.db.QueryContext(ctx, `
SELECT m.mode_id, m.slug, m.version, m.owner_user_id, COALESCE(a.username, ''),
       m.name, m.short_code, m.description, m.objective, m.spec, m.derived_from,
       m.visibility, m.plays, m.published_at_unix_ms, COALESCE(m.retired_at_unix_ms, 0)
FROM custom_modes m
LEFT JOIN accounts a ON a.user_id = m.owner_user_id
ORDER BY m.published_at_unix_ms ASC`)
	if err != nil {
		return nil, fmt.Errorf("load published modes: %w", err)
	}
	defer rows.Close()
	return scanModes(rows)
}

// ListModes is the library page: public, un-retired, newest first, optionally
// filtered by a search term or an owner.
func (store *Store) ListModes(
	ctx context.Context,
	search string,
	ownerUserID string,
	limit, offset int,
) ([]CustomMode, error) {
	if limit <= 0 || limit > 100 {
		limit = 40
	}
	clauses := []string{"m.retired_at_unix_ms IS NULL"}
	args := []any{}
	if ownerUserID != "" {
		// Somebody's own shelf shows their unlisted modes too; the public
		// listing never does.
		clauses = append(clauses, "m.owner_user_id = ?")
		args = append(args, ownerUserID)
	} else {
		clauses = append(clauses, "m.visibility = 'public'")
	}
	if trimmed := strings.TrimSpace(search); trimmed != "" {
		clauses = append(clauses, "(m.name LIKE ? OR m.description LIKE ? OR m.objective LIKE ?)")
		pattern := "%" + trimmed + "%"
		args = append(args, pattern, pattern, pattern)
	}
	args = append(args, limit, offset)

	rows, err := store.db.QueryContext(ctx, `
SELECT m.mode_id, m.slug, m.version, m.owner_user_id, COALESCE(a.username, ''),
       m.name, m.short_code, m.description, m.objective, m.spec, m.derived_from,
       m.visibility, m.plays, m.published_at_unix_ms, COALESCE(m.retired_at_unix_ms, 0)
FROM custom_modes m
LEFT JOIN accounts a ON a.user_id = m.owner_user_id
WHERE `+strings.Join(clauses, " AND ")+`
ORDER BY m.plays DESC, m.published_at_unix_ms DESC
LIMIT ? OFFSET ?`, args...)
	if err != nil {
		return nil, fmt.Errorf("list modes: %w", err)
	}
	defer rows.Close()
	return scanModes(rows)
}

func (store *Store) Mode(ctx context.Context, modeID string) (CustomMode, error) {
	rows, err := store.db.QueryContext(ctx, `
SELECT m.mode_id, m.slug, m.version, m.owner_user_id, COALESCE(a.username, ''),
       m.name, m.short_code, m.description, m.objective, m.spec, m.derived_from,
       m.visibility, m.plays, m.published_at_unix_ms, COALESCE(m.retired_at_unix_ms, 0)
FROM custom_modes m
LEFT JOIN accounts a ON a.user_id = m.owner_user_id
WHERE m.mode_id = ?`, modeID)
	if err != nil {
		return CustomMode{}, fmt.Errorf("read mode: %w", err)
	}
	defer rows.Close()
	found, err := scanModes(rows)
	if err != nil {
		return CustomMode{}, err
	}
	if len(found) == 0 {
		return CustomMode{}, ErrModeNotFound
	}
	return found[0], nil
}

func scanModes(rows *sql.Rows) ([]CustomMode, error) {
	modes := make([]CustomMode, 0, 16)
	for rows.Next() {
		var mode CustomMode
		var spec, derived string
		if err := rows.Scan(
			&mode.ModeID, &mode.Slug, &mode.Version, &mode.OwnerUserID, &mode.OwnerUsername,
			&mode.Name, &mode.ShortCode, &mode.Description, &mode.Objective, &spec, &derived,
			&mode.Visibility, &mode.Plays, &mode.PublishedAtMs, &mode.RetiredAtMs,
		); err != nil {
			return nil, fmt.Errorf("scan mode: %w", err)
		}
		mode.Spec = json.RawMessage(spec)
		if derived != "" {
			mode.DerivedFrom = strings.Split(derived, ",")
		}
		modes = append(modes, mode)
	}
	return modes, rows.Err()
}

// NextModeVersion is what an edit of `slug` should be published as. Version 1
// for a name nobody has used.
func (store *Store) NextModeVersion(ctx context.Context, slug string) (int, error) {
	var highest sql.NullInt64
	err := store.db.QueryRowContext(ctx,
		`SELECT MAX(version) FROM custom_modes WHERE slug = ?`, slug).Scan(&highest)
	if err != nil {
		return 0, fmt.Errorf("next mode version: %w", err)
	}
	if !highest.Valid {
		return 1, nil
	}
	return int(highest.Int64) + 1, nil
}

// artIDs are the pictures the mode refers to, pinned in the same transaction as
// the mode row. Not afterwards: a crash between the two would leave a published
// mode whose artwork the sweep is free to reclaim, and a published mode is
// immutable, so there would be no way to put it back.
func (store *Store) PublishMode(ctx context.Context, mode CustomMode, artIDs []string) error {
	transaction, err := store.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("publish mode: begin transaction: %w", err)
	}
	defer func() { _ = transaction.Rollback() }()

	var published int
	if err := transaction.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM custom_modes WHERE owner_user_id = ? AND retired_at_unix_ms IS NULL`,
		mode.OwnerUserID).Scan(&published); err != nil {
		return fmt.Errorf("count published modes: %w", err)
	}
	if published >= MaximumModesPerAccount {
		return ErrTooManyModes
	}
	if mode.PublishedAtMs == 0 {
		mode.PublishedAtMs = time.Now().UnixMilli()
	}
	if mode.Visibility == "" {
		mode.Visibility = "public"
	}
	if _, err := transaction.ExecContext(ctx, `
INSERT INTO custom_modes (
    mode_id, slug, version, owner_user_id, name, short_code, description, objective,
    spec, derived_from, visibility, published_at_unix_ms
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		mode.ModeID, mode.Slug, mode.Version, mode.OwnerUserID, mode.Name, mode.ShortCode,
		mode.Description, mode.Objective, string(mode.Spec),
		strings.Join(mode.DerivedFrom, ","), mode.Visibility, mode.PublishedAtMs,
	); err != nil {
		if strings.Contains(err.Error(), "UNIQUE") {
			return ErrModeExists
		}
		return fmt.Errorf("publish mode: %w", err)
	}
	for _, artID := range artIDs {
		if _, err := transaction.ExecContext(ctx,
			`INSERT OR IGNORE INTO lab_art_pins (art_id, mode_id) VALUES (?, ?)`,
			artID, mode.ModeID,
		); err != nil {
			// The foreign key is the last word on a picture that was reclaimed
			// between the route checking for it and this insert.
			if strings.Contains(err.Error(), "FOREIGN KEY") {
				return ErrArtNotFound
			}
			return fmt.Errorf("pin artwork: %w", err)
		}
	}
	if err := transaction.Commit(); err != nil {
		return fmt.Errorf("publish mode: %w", err)
	}
	return nil
}

// RetireMode stops a mode accepting new games. Its rules stay, because its games
// do: an archived record replays through the mode it was played in.
func (store *Store) RetireMode(ctx context.Context, modeID, ownerUserID string) error {
	result, err := store.db.ExecContext(ctx,
		`UPDATE custom_modes SET retired_at_unix_ms = ?
         WHERE mode_id = ? AND owner_user_id = ? AND retired_at_unix_ms IS NULL`,
		time.Now().UnixMilli(), modeID, ownerUserID)
	if err != nil {
		return fmt.Errorf("retire mode: %w", err)
	}
	changed, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("retire mode: %w", err)
	}
	if changed == 0 {
		// Either it is not there or it is not theirs; both are the same answer
		// to the caller, and saying which would tell a stranger what exists.
		return ErrNotModeOwner
	}
	return nil
}

// CountModePlay is how the library orders itself. Best effort: a lost count is
// a slightly wrong sort, and failing a finished game over it would be worse.
func (store *Store) CountModePlay(ctx context.Context, modeID string) {
	_, _ = store.db.ExecContext(ctx,
		`UPDATE custom_modes SET plays = plays + 1 WHERE mode_id = ?`, modeID)
}

/* ------------------------------------------------------------------- parts -- */

func (store *Store) ListParts(ctx context.Context, kind, search string, limit int) ([]RulePart, error) {
	if limit <= 0 || limit > 100 {
		limit = 40
	}
	clauses := []string{"1 = 1"}
	args := []any{}
	if kind != "" {
		clauses = append(clauses, "p.kind = ?")
		args = append(args, kind)
	}
	if trimmed := strings.TrimSpace(search); trimmed != "" {
		clauses = append(clauses, "(p.name LIKE ? OR p.summary LIKE ? OR p.part_id LIKE ?)")
		pattern := "%" + trimmed + "%"
		args = append(args, pattern, pattern, pattern)
	}
	args = append(args, limit)

	rows, err := store.db.QueryContext(ctx, `
SELECT p.part_id, p.version, p.owner_user_id, COALESCE(a.username, ''), p.kind,
       p.name, p.summary, p.params, p.body, p.used_by, p.published_at_unix_ms
FROM rule_parts p
LEFT JOIN accounts a ON a.user_id = p.owner_user_id
WHERE `+strings.Join(clauses, " AND ")+`
ORDER BY p.used_by DESC, p.published_at_unix_ms DESC
LIMIT ?`, args...)
	if err != nil {
		return nil, fmt.Errorf("list parts: %w", err)
	}
	defer rows.Close()
	return scanParts(rows)
}

func (store *Store) Part(ctx context.Context, partID string, version int) (RulePart, error) {
	query := `
SELECT p.part_id, p.version, p.owner_user_id, COALESCE(a.username, ''), p.kind,
       p.name, p.summary, p.params, p.body, p.used_by, p.published_at_unix_ms
FROM rule_parts p
LEFT JOIN accounts a ON a.user_id = p.owner_user_id
WHERE p.part_id = ?`
	args := []any{partID}
	if version > 0 {
		query += ` AND p.version = ?`
		args = append(args, version)
	}
	query += ` ORDER BY p.version DESC LIMIT 1`

	rows, err := store.db.QueryContext(ctx, query, args...)
	if err != nil {
		return RulePart{}, fmt.Errorf("read part: %w", err)
	}
	defer rows.Close()
	found, err := scanParts(rows)
	if err != nil {
		return RulePart{}, err
	}
	if len(found) == 0 {
		return RulePart{}, ErrPartNotFound
	}
	return found[0], nil
}

func scanParts(rows *sql.Rows) ([]RulePart, error) {
	parts := make([]RulePart, 0, 16)
	for rows.Next() {
		var part RulePart
		var params, body string
		if err := rows.Scan(
			&part.PartID, &part.Version, &part.OwnerUserID, &part.OwnerUsername, &part.Kind,
			&part.Name, &part.Summary, &params, &body, &part.UsedBy, &part.PublishedAtMs,
		); err != nil {
			return nil, fmt.Errorf("scan part: %w", err)
		}
		if params != "" {
			part.Params = json.RawMessage(params)
		}
		part.Body = json.RawMessage(body)
		parts = append(parts, part)
	}
	return parts, rows.Err()
}

func (store *Store) NextPartVersion(ctx context.Context, partID string) (int, error) {
	var highest sql.NullInt64
	err := store.db.QueryRowContext(ctx,
		`SELECT MAX(version) FROM rule_parts WHERE part_id = ?`, partID).Scan(&highest)
	if err != nil {
		return 0, fmt.Errorf("next part version: %w", err)
	}
	if !highest.Valid {
		return 1, nil
	}
	return int(highest.Int64) + 1, nil
}

func (store *Store) PublishPart(ctx context.Context, part RulePart) error {
	var published int
	if err := store.db.QueryRowContext(ctx,
		`SELECT COUNT(DISTINCT part_id) FROM rule_parts WHERE owner_user_id = ?`,
		part.OwnerUserID).Scan(&published); err != nil {
		return fmt.Errorf("count published parts: %w", err)
	}
	if published >= MaximumPartsPerAccount {
		return ErrTooManyRuleParts
	}
	if part.PublishedAtMs == 0 {
		part.PublishedAtMs = time.Now().UnixMilli()
	}
	_, err := store.db.ExecContext(ctx, `
INSERT INTO rule_parts (part_id, version, owner_user_id, kind, name, summary, params, body, published_at_unix_ms)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		part.PartID, part.Version, part.OwnerUserID, part.Kind, part.Name, part.Summary,
		string(part.Params), string(part.Body), part.PublishedAtMs)
	if err != nil {
		return fmt.Errorf("publish part: %w", err)
	}
	return nil
}

// CreditParts is what makes the library's "used by" number mean anything.
func (store *Store) CreditParts(ctx context.Context, partIDs []string) {
	for _, id := range partIDs {
		name, _, _ := strings.Cut(id, "@")
		_, _ = store.db.ExecContext(ctx,
			`UPDATE rule_parts SET used_by = used_by + 1 WHERE part_id = ?`, name)
	}
}

/* ------------------------------------------------------------------ drafts -- */

func (store *Store) SaveDraft(ctx context.Context, draft LabDraft) error {
	var held int
	if err := store.db.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM lab_drafts WHERE owner_user_id = ? AND draft_id <> ?`,
		draft.OwnerUserID, draft.DraftID).Scan(&held); err != nil {
		return fmt.Errorf("count drafts: %w", err)
	}
	if held >= MaximumDraftsPerAccount {
		return fmt.Errorf("at most %d drafts per account", MaximumDraftsPerAccount)
	}
	_, err := store.db.ExecContext(ctx, `
INSERT INTO lab_drafts (draft_id, owner_user_id, name, spec, updated_at_unix_ms)
VALUES (?, ?, ?, ?, ?)
ON CONFLICT(draft_id) DO UPDATE SET
    name = excluded.name,
    spec = excluded.spec,
    updated_at_unix_ms = excluded.updated_at_unix_ms
WHERE lab_drafts.owner_user_id = excluded.owner_user_id`,
		draft.DraftID, draft.OwnerUserID, draft.Name, string(draft.Spec),
		time.Now().UnixMilli())
	if err != nil {
		return fmt.Errorf("save draft: %w", err)
	}
	return nil
}

func (store *Store) Drafts(ctx context.Context, ownerUserID string) ([]LabDraft, error) {
	rows, err := store.db.QueryContext(ctx, `
SELECT draft_id, owner_user_id, name, spec, updated_at_unix_ms
FROM lab_drafts WHERE owner_user_id = ?
ORDER BY updated_at_unix_ms DESC LIMIT 50`, ownerUserID)
	if err != nil {
		return nil, fmt.Errorf("list drafts: %w", err)
	}
	defer rows.Close()
	drafts := make([]LabDraft, 0, 8)
	for rows.Next() {
		var draft LabDraft
		var spec string
		if err := rows.Scan(&draft.DraftID, &draft.OwnerUserID, &draft.Name, &spec, &draft.UpdatedAtMs); err != nil {
			return nil, fmt.Errorf("scan draft: %w", err)
		}
		draft.Spec = json.RawMessage(spec)
		drafts = append(drafts, draft)
	}
	return drafts, rows.Err()
}

func (store *Store) DeleteDraft(ctx context.Context, draftID, ownerUserID string) error {
	_, err := store.db.ExecContext(ctx,
		`DELETE FROM lab_drafts WHERE draft_id = ? AND owner_user_id = ?`, draftID, ownerUserID)
	if err != nil {
		return fmt.Errorf("delete draft: %w", err)
	}
	return nil
}
