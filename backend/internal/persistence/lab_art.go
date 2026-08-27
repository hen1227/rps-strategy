package persistence

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"image"
	"image/jpeg"
	"image/png"
	"strings"
	"time"

	"rps-strategy/backend/internal/game/spec"
)

// The pictures a mode carries.
//
// A mode's rules are a document; its pictures cannot be. A spec is capped at
// 16 KiB and travels inside every game state, so an image lives here and the
// document holds only its id — which is why a published mode stays small and a
// client that has never heard of the mode can still play it.
//
// **The digest is the id.** An asset is addressed by the SHA-256 of the bytes
// this store decided to keep, so it can never come to mean a different picture
// than it did the day a mode referred to it. That is the same property a
// published mode has, reached the same way, and it is what lets art be a
// reference rather than a copy without the reference ever rotting.
//
// Everything here is re-encoded from a decoded image rather than kept as it
// arrived, for the reason bot_icon.go states: it makes "this is a PNG of at
// most 512x512" true by construction rather than by inspection — no oversized
// image, no trailing payload after the last chunk, and no metadata riding along
// in a file the whole world is served. On a phone photograph that last one is a
// real privacy win, since it is where the GPS coordinates would be.
//
// Never image.Decode or image.DecodeConfig. Those dispatch on the formats some
// package somewhere blank-imported, which makes the set of things this server
// will decode a property of the whole dependency graph rather than of this
// file. The magic bytes decide, and png/jpeg are called by name.

// ArtAsset is a stored picture, without its bytes.
type ArtAsset struct {
	// ArtID is what a spec writes: `img:` and the first 128 bits of the digest.
	ArtID string `json:"artId"`
	// SHA256 is the whole digest of the stored bytes.
	SHA256 string `json:"-"`
	// MediaType is what it is served as.
	MediaType string `json:"mediaType"`
	Width     int    `json:"width"`
	Height    int    `json:"height"`
	Bytes     int    `json:"bytes"`
	// Role is the slot it was uploaded for, and therefore the limits it was
	// checked against.
	Role string `json:"role"`
	// UploaderUserID is whoever first sent these bytes. Not a foreign key, for
	// the reason custom_modes gives: an anonymized account leaves its id behind
	// and the join simply finds no name.
	UploaderUserID string `json:"-"`
	// Published is whether some published mode already pins it. It is what lets
	// a fork use somebody else's picture without letting a stranger publish
	// somebody's private draft art on their behalf.
	Published bool `json:"published"`
	// SourceURL is where it was fetched from, when it was fetched rather than
	// uploaded. Provenance for triage; nothing that serves ever reads it.
	SourceURL   string `json:"-"`
	CreatedAtMs int64  `json:"createdAtUnixMs"`
}

// ArtImage is a stored picture with its bytes, for serving.
type ArtImage struct {
	Digest      string
	MediaType   string
	Bytes       []byte
	CreatedAtMs int64
}

// Filename is what ServeContent should call it. Nothing depends on the
// extension — an <img> does not care — but a name it can reason about is free.
func (image ArtImage) Filename() string {
	if image.MediaType == "image/jpeg" {
		return image.Digest + ".jpg"
	}
	return image.Digest + ".png"
}

var (
	ErrArtInvalid  = errors.New("artwork rejected")
	ErrArtNotFound = errors.New("artwork not found")
	ErrTooMuchArt  = errors.New("too much artwork on this account")
)

const (
	// MaximumArtPerAccount and MaximumArtBytesPerAccount bound what one person
	// can leave on this server. A fully illustrated mode is fourteen pictures,
	// so the count has to clear several modes' worth comfortably or the Lab
	// stalls in the middle of a design.
	MaximumArtPerAccount      = 240
	MaximumArtBytesPerAccount = 24 << 20

	// ArtRetention is how long an unpinned picture is kept. Publishing pins
	// what a mode uses, so what a sweep may reclaim is only what nobody built
	// anything out of. Thirty days because a draft is work in progress and a
	// week is not long enough to leave one alone.
	ArtRetention = 30 * 24 * time.Hour
)

// ArtLimits is what a picture uploaded for a given slot has to fit.
//
// Keyed by role because the slots genuinely differ: a piece is drawn inside a
// coloured ring at twenty points and must be square and have transparency, and
// a board background is a backdrop that may be a photograph. The role is a
// property of the *request*, not of the image, which is why it is checked again
// at publish against the slot the spec actually puts the picture in rather than
// being stored on the row and trusted later.
type ArtLimits struct {
	Role string
	// WireBytes is the most that may arrive.
	WireBytes int
	// StoreBytes is the most that may be kept, measured after re-encoding.
	StoreBytes int
	MaxSide    int
	MinSide    int
	// Square is whether the picture has to be as wide as it is tall.
	Square bool
	// PNGOnly is whether transparency is required. A piece is drawn over its
	// side's ring, so a rectangle of opaque pixels would hide the one thing
	// saying whose piece it is.
	PNGOnly bool
}

var ArtRoleLimits = map[string]ArtLimits{
	spec.ArtRolePiece: {spec.ArtRolePiece, 256 << 10, 192 << 10, 512, 16, true, true},
	spec.ArtRoleBoard: {spec.ArtRoleBoard, 2 << 20, 512 << 10, 1024, 64, false, false},
	spec.ArtRoleCover: {spec.ArtRoleCover, 2 << 20, 512 << 10, 1200, 64, false, false},
}

func (store *Store) ensureLabArtSchema(ctx context.Context) error {
	const schema = `
CREATE TABLE IF NOT EXISTS lab_art (
    -- The digest is the id, so an asset is immutable by construction: there is
    -- no updated_at, and nothing that serves it needs a cache-busting query.
    art_id TEXT PRIMARY KEY,
    sha256 TEXT NOT NULL,
    media_type TEXT NOT NULL CHECK (media_type IN ('image/png', 'image/jpeg')),
    width INTEGER NOT NULL CHECK (width > 0),
    height INTEGER NOT NULL CHECK (height > 0),
    bytes BLOB NOT NULL,
    byte_length INTEGER NOT NULL CHECK (byte_length > 0),
    role TEXT NOT NULL CHECK (role IN ('piece', 'board', 'cover')),
    uploader_user_id TEXT NOT NULL,
    source_url TEXT NOT NULL DEFAULT '',
    taken_down_at_unix_ms INTEGER,
    created_at_unix_ms INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS lab_art_uploader_idx
    ON lab_art(uploader_user_id, created_at_unix_ms DESC);

-- What makes "a published mode's pictures are kept" a fact the database
-- enforces rather than a query somebody remembers to run. RESTRICT is the whole
-- point: the sweep cannot delete a pinned row even if its WHERE clause is
-- wrong, and a published mode is immutable, so a pin is forever.
CREATE TABLE IF NOT EXISTS lab_art_pins (
    art_id TEXT NOT NULL REFERENCES lab_art(art_id) ON DELETE RESTRICT,
    mode_id TEXT NOT NULL,
    PRIMARY KEY (art_id, mode_id)
);

CREATE INDEX IF NOT EXISTS lab_art_pins_mode_idx ON lab_art_pins(mode_id);

CREATE TABLE IF NOT EXISTS lab_art_reports (
    report_id INTEGER PRIMARY KEY AUTOINCREMENT,
    -- No REFERENCES lab_art: a report has to outlive the picture, or an admin
    -- reviewing the queue cannot see what was already reclaimed.
    art_id TEXT NOT NULL,
    reported_by_user_id TEXT NOT NULL DEFAULT '',
    reason TEXT NOT NULL DEFAULT '',
    reported_at_unix_ms INTEGER NOT NULL,
    resolved_at_unix_ms INTEGER,
    resolution TEXT NOT NULL DEFAULT ''
        CHECK (resolution IN ('', 'taken_down', 'kept'))
);

CREATE INDEX IF NOT EXISTS lab_art_reports_open_idx
    ON lab_art_reports(resolved_at_unix_ms, reported_at_unix_ms DESC);

-- One report per person per picture, so re-reporting is idempotent and a
-- brigade cannot inflate a count an admin is reading as a signal.
CREATE UNIQUE INDEX IF NOT EXISTS lab_art_reports_once_idx
    ON lab_art_reports(art_id, reported_by_user_id)
    WHERE reported_by_user_id <> '';
`
	if _, err := store.db.ExecContext(ctx, schema); err != nil {
		return fmt.Errorf("ensure lab art schema: %w", err)
	}
	return nil
}

/* ------------------------------------------------------------- normalizing -- */

type normalizedArt struct {
	bytes     []byte
	mediaType string
	width     int
	height    int
}

// normalizeArt checks a picture against its slot's limits and re-encodes it.
//
// The order matters and mirrors normalizeBotIcon: refuse on length before
// touching the bytes, then read the header only, then refuse on the dimensions
// the header claims, and only then decode. A small file claiming to be enormous
// is a decompression bomb, and it is refused rather than expanded into memory.
func normalizeArt(limits ArtLimits, raw []byte) (normalizedArt, error) {
	if len(raw) == 0 {
		return normalizedArt{}, fmt.Errorf("%w: the file is empty", ErrArtInvalid)
	}
	if len(raw) > limits.WireBytes {
		return normalizedArt{}, fmt.Errorf("%w: %d bytes is over the %d-byte limit for %s artwork",
			ErrArtInvalid, len(raw), limits.WireBytes, limits.Role)
	}

	isPNG := bytes.HasPrefix(raw, []byte("\x89PNG\r\n\x1a\n"))
	isJPEG := bytes.HasPrefix(raw, []byte{0xFF, 0xD8, 0xFF})
	if !isPNG && !isJPEG {
		return normalizedArt{}, fmt.Errorf("%w: it is not a PNG or a JPEG", ErrArtInvalid)
	}
	if isJPEG && limits.PNGOnly {
		return normalizedArt{}, fmt.Errorf(
			"%w: a piece's artwork has to be a PNG — it is drawn inside its side's ring, so it needs transparency",
			ErrArtInvalid)
	}

	reader := bytes.NewReader(raw)
	var config image.Config
	var err error
	if isPNG {
		config, err = png.DecodeConfig(reader)
	} else {
		config, err = jpeg.DecodeConfig(reader)
	}
	if err != nil {
		return normalizedArt{}, fmt.Errorf("%w: the header is not readable (%v)", ErrArtInvalid, err)
	}
	if err := checkArtSize(limits, config.Width, config.Height); err != nil {
		return normalizedArt{}, err
	}

	reader = bytes.NewReader(raw)
	var decoded image.Image
	if isPNG {
		decoded, err = png.Decode(reader)
	} else {
		decoded, err = jpeg.Decode(reader)
	}
	if err != nil {
		return normalizedArt{}, fmt.Errorf("%w: the image data is damaged (%v)", ErrArtInvalid, err)
	}

	// Re-encode as what the slot needs, not as what arrived. A piece is always
	// a PNG because it needs an alpha channel; a board or a cover keeps its own
	// format, because re-encoding a photograph to PNG turns half a megabyte
	// into several.
	var buffer bytes.Buffer
	mediaType := "image/png"
	if isJPEG {
		mediaType = "image/jpeg"
		err = jpeg.Encode(&buffer, decoded, &jpeg.Options{Quality: 82})
	} else {
		err = (&png.Encoder{CompressionLevel: png.DefaultCompression}).Encode(&buffer, decoded)
	}
	if err != nil {
		return normalizedArt{}, fmt.Errorf("%w: it could not be re-encoded (%v)", ErrArtInvalid, err)
	}
	if buffer.Len() > limits.StoreBytes {
		return normalizedArt{}, fmt.Errorf(
			"%w: it re-encodes to %d bytes, over the %d-byte limit for %s artwork; send a smaller picture",
			ErrArtInvalid, buffer.Len(), limits.StoreBytes, limits.Role)
	}

	bounds := decoded.Bounds()
	return normalizedArt{
		bytes:     buffer.Bytes(),
		mediaType: mediaType,
		width:     bounds.Dx(),
		height:    bounds.Dy(),
	}, nil
}

func checkArtSize(limits ArtLimits, width, height int) error {
	if width < 1 || height < 1 {
		return fmt.Errorf("%w: it has no pixels", ErrArtInvalid)
	}
	if limits.Square && width != height {
		return fmt.Errorf("%w: it is %dx%d, and a piece's artwork has to be square",
			ErrArtInvalid, width, height)
	}
	if width > limits.MaxSide || height > limits.MaxSide {
		return fmt.Errorf("%w: it is %dx%d, and %s artwork is at most %dx%d",
			ErrArtInvalid, width, height, limits.Role, limits.MaxSide, limits.MaxSide)
	}
	if width < limits.MinSide || height < limits.MinSide {
		return fmt.Errorf("%w: it is %dx%d, and the smallest %s artwork is %dx%d",
			ErrArtInvalid, width, height, limits.Role, limits.MinSide, limits.MinSide)
	}
	return nil
}

/* ------------------------------------------------------------------ store -- */

// StoreArt keeps a picture and returns how a spec refers to it.
//
// The same bytes twice are one row: the id is the digest, so a second upload
// finds the first and charges nothing. That is deliberate rather than merely
// efficient — it means one account cannot exhaust another's budget by racing
// them to a digest, and it means taking a picture down takes it down
// everywhere it was ever used.
func (store *Store) StoreArt(
	ctx context.Context,
	uploaderUserID, role, sourceURL string,
	raw []byte,
) (ArtAsset, error) {
	limits, known := ArtRoleLimits[role]
	if !known {
		return ArtAsset{}, fmt.Errorf("%w: %q is not a slot a picture can go in", ErrArtInvalid, role)
	}
	normalized, err := normalizeArt(limits, raw)
	if err != nil {
		return ArtAsset{}, err
	}
	sum := sha256.Sum256(normalized.bytes)
	digest := hex.EncodeToString(sum[:])
	artID := "img:" + digest[:32]

	if existing, err := store.artAsset(ctx, artID); err == nil {
		return existing, nil
	} else if !errors.Is(err, ErrArtNotFound) {
		return ArtAsset{}, err
	}

	if err := store.checkArtBudget(ctx, uploaderUserID, len(normalized.bytes)); err != nil {
		return ArtAsset{}, err
	}

	now := time.Now().UnixMilli()
	if _, err := store.db.ExecContext(ctx, `
INSERT INTO lab_art (art_id, sha256, media_type, width, height, bytes, byte_length,
                     role, uploader_user_id, source_url, created_at_unix_ms)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(art_id) DO NOTHING`,
		artID, digest, normalized.mediaType, normalized.width, normalized.height,
		normalized.bytes, len(normalized.bytes), role, uploaderUserID,
		strings.TrimSpace(sourceURL), now,
	); err != nil {
		return ArtAsset{}, fmt.Errorf("store artwork: %w", err)
	}
	return store.artAsset(ctx, artID)
}

// checkArtBudget counts taken-down rows on purpose: a takedown is not a refund,
// or an account could publish something objectionable, have it removed, and be
// handed its quota back to try again.
func (store *Store) checkArtBudget(ctx context.Context, userID string, incoming int) error {
	var count, total int
	err := store.db.QueryRowContext(ctx, `
SELECT COUNT(*), COALESCE(SUM(byte_length), 0) FROM lab_art WHERE uploader_user_id = ?`,
		userID).Scan(&count, &total)
	if err != nil {
		return fmt.Errorf("read artwork budget: %w", err)
	}
	if count >= MaximumArtPerAccount {
		return fmt.Errorf("%w: at most %d pictures per account", ErrTooMuchArt, MaximumArtPerAccount)
	}
	if total+incoming > MaximumArtBytesPerAccount {
		return fmt.Errorf("%w: at most %d bytes of pictures per account",
			ErrTooMuchArt, MaximumArtBytesPerAccount)
	}
	return nil
}

const artAssetColumns = `
SELECT a.art_id, a.sha256, a.media_type, a.width, a.height, a.byte_length, a.role,
       a.uploader_user_id, a.source_url, a.created_at_unix_ms,
       EXISTS (SELECT 1 FROM lab_art_pins p WHERE p.art_id = a.art_id)
FROM lab_art a`

func scanArtAsset(row interface{ Scan(...any) error }) (ArtAsset, error) {
	var asset ArtAsset
	err := row.Scan(&asset.ArtID, &asset.SHA256, &asset.MediaType, &asset.Width, &asset.Height,
		&asset.Bytes, &asset.Role, &asset.UploaderUserID, &asset.SourceURL,
		&asset.CreatedAtMs, &asset.Published)
	return asset, err
}

func (store *Store) artAsset(ctx context.Context, artID string) (ArtAsset, error) {
	row := store.db.QueryRowContext(ctx,
		artAssetColumns+` WHERE a.art_id = ? AND a.taken_down_at_unix_ms IS NULL`, artID)
	asset, err := scanArtAsset(row)
	if errors.Is(err, sql.ErrNoRows) {
		return ArtAsset{}, ErrArtNotFound
	}
	if err != nil {
		return ArtAsset{}, fmt.Errorf("read artwork: %w", err)
	}
	return asset, nil
}

// ArtBytes is the picture itself, for serving.
//
// The takedown filter is in the WHERE clause rather than in a branch at the
// handler, so there is one code path and the identical-404 property falls out
// rather than having to be maintained.
func (store *Store) ArtBytes(ctx context.Context, artID string) (ArtImage, error) {
	var image ArtImage
	err := store.db.QueryRowContext(ctx, `
SELECT sha256, media_type, bytes, created_at_unix_ms
FROM lab_art WHERE art_id = ? AND taken_down_at_unix_ms IS NULL`, artID,
	).Scan(&image.Digest, &image.MediaType, &image.Bytes, &image.CreatedAtMs)
	if errors.Is(err, sql.ErrNoRows) {
		return ArtImage{}, ErrArtNotFound
	}
	if err != nil {
		return ArtImage{}, fmt.Errorf("read artwork: %w", err)
	}
	return image, nil
}

// ArtAssets looks up several pictures at once, without their bytes. This is
// what the publish route checks a mode's references against.
func (store *Store) ArtAssets(ctx context.Context, artIDs []string) (map[string]ArtAsset, error) {
	found := make(map[string]ArtAsset, len(artIDs))
	if len(artIDs) == 0 {
		return found, nil
	}
	placeholders := strings.TrimSuffix(strings.Repeat("?,", len(artIDs)), ",")
	arguments := make([]any, 0, len(artIDs))
	for _, id := range artIDs {
		arguments = append(arguments, id)
	}
	rows, err := store.db.QueryContext(ctx,
		artAssetColumns+` WHERE a.taken_down_at_unix_ms IS NULL AND a.art_id IN (`+placeholders+`)`,
		arguments...)
	if err != nil {
		return nil, fmt.Errorf("read artwork: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		asset, err := scanArtAsset(rows)
		if err != nil {
			return nil, fmt.Errorf("read artwork: %w", err)
		}
		found[asset.ArtID] = asset
	}
	return found, rows.Err()
}

// ArtForAccount is what somebody has already uploaded, newest first, so an
// agent can reuse a picture rather than send it again.
func (store *Store) ArtForAccount(ctx context.Context, userID string, limit int) ([]ArtAsset, error) {
	rows, err := store.db.QueryContext(ctx,
		artAssetColumns+` WHERE a.uploader_user_id = ? AND a.taken_down_at_unix_ms IS NULL
ORDER BY a.created_at_unix_ms DESC LIMIT ?`, userID, limit)
	if err != nil {
		return nil, fmt.Errorf("list artwork: %w", err)
	}
	defer rows.Close()
	assets := make([]ArtAsset, 0, limit)
	for rows.Next() {
		asset, err := scanArtAsset(rows)
		if err != nil {
			return nil, fmt.Errorf("list artwork: %w", err)
		}
		assets = append(assets, asset)
	}
	return assets, rows.Err()
}

/* -------------------------------------------------- keeping and reclaiming -- */

// ReclaimUnpinnedArt deletes pictures nobody built anything out of.
//
// Pinned rows are skipped by the WHERE clause and protected by the foreign key
// besides, so a mistake here cannot cost a published mode its artwork. Taken-
// down rows are skipped too, and deliberately: the row is what keeps the digest
// claimed, so the same bytes cannot be uploaded again into a live picture.
func (store *Store) ReclaimUnpinnedArt(ctx context.Context, before time.Time) (int, error) {
	result, err := store.db.ExecContext(ctx, `
DELETE FROM lab_art
 WHERE created_at_unix_ms < ?
   AND taken_down_at_unix_ms IS NULL
   AND art_id NOT IN (SELECT art_id FROM lab_art_pins)`,
		before.UnixMilli())
	if err != nil {
		return 0, fmt.Errorf("reclaim artwork: %w", err)
	}
	reclaimed, err := result.RowsAffected()
	if err != nil {
		return 0, fmt.Errorf("reclaim artwork: %w", err)
	}
	return int(reclaimed), nil
}

/* --------------------------------------------------- reporting and removal -- */

// ArtReport is one complaint about a picture.
type ArtReport struct {
	ReportID         int64  `json:"reportId"`
	ArtID            string `json:"artId"`
	ReportedByUserID string `json:"reportedByUserId"`
	Reason           string `json:"reason"`
	ReportedAtMs     int64  `json:"reportedAtUnixMs"`
	// MediaType and the sizes come from the picture, so the queue shows what is
	// being complained about without a second call.
	MediaType string `json:"mediaType"`
	Width     int    `json:"width"`
	Height    int    `json:"height"`
	TakenDown bool   `json:"takenDown"`
	// Modes is how many published modes pin it, which is what a takedown costs.
	Modes int `json:"modes"`
}

// ReportArt records a complaint. Idempotent per person, so re-reporting is
// harmless and a count stays a signal rather than a measure of persistence.
func (store *Store) ReportArt(ctx context.Context, artID, byUserID, reason string) error {
	_, err := store.db.ExecContext(ctx, `
INSERT INTO lab_art_reports (art_id, reported_by_user_id, reason, reported_at_unix_ms)
VALUES (?, ?, ?, ?)
ON CONFLICT DO NOTHING`,
		artID, byUserID, strings.TrimSpace(reason), time.Now().UnixMilli())
	if err != nil {
		return fmt.Errorf("report artwork: %w", err)
	}
	return nil
}

// OpenArtReports is the queue, newest first.
func (store *Store) OpenArtReports(ctx context.Context, limit int) ([]ArtReport, error) {
	rows, err := store.db.QueryContext(ctx, `
SELECT r.report_id, r.art_id, r.reported_by_user_id, r.reason, r.reported_at_unix_ms,
       COALESCE(a.media_type, ''), COALESCE(a.width, 0), COALESCE(a.height, 0),
       COALESCE(a.taken_down_at_unix_ms IS NOT NULL, 0),
       (SELECT COUNT(*) FROM lab_art_pins p WHERE p.art_id = r.art_id)
FROM lab_art_reports r
LEFT JOIN lab_art a ON a.art_id = r.art_id
WHERE r.resolved_at_unix_ms IS NULL
ORDER BY r.reported_at_unix_ms DESC
LIMIT ?`, limit)
	if err != nil {
		return nil, fmt.Errorf("read artwork reports: %w", err)
	}
	defer rows.Close()
	reports := make([]ArtReport, 0, limit)
	for rows.Next() {
		var report ArtReport
		if err := rows.Scan(&report.ReportID, &report.ArtID, &report.ReportedByUserID,
			&report.Reason, &report.ReportedAtMs, &report.MediaType, &report.Width,
			&report.Height, &report.TakenDown, &report.Modes); err != nil {
			return nil, fmt.Errorf("read artwork reports: %w", err)
		}
		reports = append(reports, report)
	}
	return reports, rows.Err()
}

// TakeArtDown stops a picture being served, everywhere it was ever used.
//
// The bytes are dropped and the row is kept. Keeping it is what holds the
// digest, so the same picture cannot be uploaded back into a live row — content
// addressing is what makes a takedown stick, and deleting the row would undo
// exactly that.
//
// A mode that used it is untouched. A published mode is immutable and its
// archived games replay through it; what happens is that its pieces draw their
// letters, which is what the client already does for a picture it cannot load.
func (store *Store) TakeArtDown(ctx context.Context, artID, note string) error {
	transaction, err := store.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("take artwork down: %w", err)
	}
	defer func() { _ = transaction.Rollback() }()

	now := time.Now().UnixMilli()
	result, err := transaction.ExecContext(ctx, `
UPDATE lab_art SET taken_down_at_unix_ms = ?, bytes = x'', source_url = ?
WHERE art_id = ? AND taken_down_at_unix_ms IS NULL`, now, strings.TrimSpace(note), artID)
	if err != nil {
		return fmt.Errorf("take artwork down: %w", err)
	}
	changed, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("take artwork down: %w", err)
	}
	if changed == 0 {
		return ErrArtNotFound
	}
	if _, err := transaction.ExecContext(ctx, `
UPDATE lab_art_reports SET resolved_at_unix_ms = ?, resolution = 'taken_down'
WHERE art_id = ? AND resolved_at_unix_ms IS NULL`, now, artID); err != nil {
		return fmt.Errorf("take artwork down: %w", err)
	}
	return transaction.Commit()
}

// KeepArt closes a picture's open reports without removing it, which is what
// actually empties a queue.
func (store *Store) KeepArt(ctx context.Context, artID string) error {
	_, err := store.db.ExecContext(ctx, `
UPDATE lab_art_reports SET resolved_at_unix_ms = ?, resolution = 'kept'
WHERE art_id = ? AND resolved_at_unix_ms IS NULL`, time.Now().UnixMilli(), artID)
	if err != nil {
		return fmt.Errorf("keep artwork: %w", err)
	}
	return nil
}
