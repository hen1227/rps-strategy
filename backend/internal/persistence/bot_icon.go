package persistence

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"image/png"
	"strings"
	"time"
)

// A bot's picture.
//
// Owners asked for their engine to look like something rather than like two
// letters on a coloured square, so the client sends a PNG along with the name
// and the settings it already asserts on every connect. It arrives over the
// same socket for the same reason nothing else about a bot uses HTTP: the whole
// claim rpsbot.py makes about itself is that there is one destination in it to
// audit.
//
// Everything stored here is re-encoded from a decoded image rather than kept as
// it arrived. That is what makes "this is a PNG of at most 128x128" true by
// construction instead of by inspection — no oversized image, no trailing
// payload after the last chunk, no metadata riding along in a file the whole
// world is served.
//
// The table lives in ensureBotSchema, beside the one it hangs off.

// BotIconImage is one stored icon: the bytes to serve, the digest to cache it
// by, and when it was set.
type BotIconImage struct {
	PNG             []byte
	SHA256          string
	UpdatedAtUnixMs int64
}

// SetBotIcon stores a bot's icon and returns the digest of what was stored.
//
// The digest is of the *re-encoded* image, because that is the thing clients
// fetch and cache. An icon that is already what the row holds is left alone: a
// bot reconnects on every network hiccup and re-asserts its whole config each
// time, and there is no reason for that to rewrite a blob.
func (store *Store) SetBotIcon(ctx context.Context, botID string, raw []byte) (string, error) {
	botID = strings.TrimSpace(botID)
	encoded, err := normalizeBotIcon(raw)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(encoded)
	digest := hex.EncodeToString(sum[:])

	var existing string
	err = store.db.QueryRowContext(ctx,
		`SELECT sha256 FROM bot_icons WHERE bot_id = ?`, botID).Scan(&existing)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return "", fmt.Errorf("read bot icon: %w", err)
	}
	if existing == digest {
		return digest, nil
	}

	if _, err := store.db.ExecContext(ctx, `
INSERT INTO bot_icons (bot_id, png, sha256, updated_at_unix_ms)
VALUES (?, ?, ?, ?)
ON CONFLICT(bot_id) DO UPDATE SET
    png = excluded.png,
    sha256 = excluded.sha256,
    updated_at_unix_ms = excluded.updated_at_unix_ms
`, botID, encoded, digest, time.Now().UnixMilli()); err != nil {
		return "", fmt.Errorf("set bot icon: %w", err)
	}
	return digest, nil
}

// ClearBotIcon removes a bot's icon, and says nothing when there was none.
//
// This is how an icon is taken down, because the config file is the owner's
// copy of their bot's identity: deleting the `icon` line and restarting has to
// mean what it says, or the file and the website would disagree for ever with
// no way to reconcile them.
func (store *Store) ClearBotIcon(ctx context.Context, botID string) error {
	if _, err := store.db.ExecContext(ctx,
		`DELETE FROM bot_icons WHERE bot_id = ?`, strings.TrimSpace(botID),
	); err != nil {
		return fmt.Errorf("clear bot icon: %w", err)
	}
	return nil
}

// BotIcon reads an icon by either of the two ids a bot has.
//
// A bot is known by its registry id on its owner's page and by its *account*
// id everywhere it has played — the ladder, a live game, a stored record — and
// those places would otherwise have to carry a second id for no reason but
// building an image URL. Telling them apart needs no lookup: a bot id is bare
// hex, so only an account id can carry BotAccountPrefix.
//
// A bot with no icon and an id belonging to nothing both come back
// ErrBotNotFound. Nothing that asks this question benefits from the difference,
// and answering differently would let a stranger enumerate bot ids.
func (store *Store) BotIcon(ctx context.Context, id string) (BotIconImage, error) {
	id = strings.TrimSpace(id)
	query := `
SELECT i.png, i.sha256, i.updated_at_unix_ms
FROM bot_icons i WHERE i.bot_id = ?`
	if strings.HasPrefix(id, BotAccountPrefix) {
		query = `
SELECT i.png, i.sha256, i.updated_at_unix_ms
FROM bot_icons i JOIN bots b ON b.bot_id = i.bot_id WHERE b.user_id = ?`
	}

	var icon BotIconImage
	err := store.db.QueryRowContext(ctx, query, id).
		Scan(&icon.PNG, &icon.SHA256, &icon.UpdatedAtUnixMs)
	if errors.Is(err, sql.ErrNoRows) {
		return BotIconImage{}, ErrBotNotFound
	}
	if err != nil {
		return BotIconImage{}, fmt.Errorf("read bot icon: %w", err)
	}
	return icon, nil
}

// normalizeBotIcon checks an icon and re-encodes it.
//
// The size is read from the header before the image is decoded, so a small file
// claiming to be enormous is refused rather than expanded into memory first.
func normalizeBotIcon(raw []byte) ([]byte, error) {
	if len(raw) == 0 {
		return nil, fmt.Errorf("%w: the file is empty", ErrBotIconInvalid)
	}
	if len(raw) > MaximumBotIconBytes {
		return nil, fmt.Errorf("%w: %d bytes is over the %d-byte limit",
			ErrBotIconInvalid, len(raw), MaximumBotIconBytes)
	}
	config, err := png.DecodeConfig(bytes.NewReader(raw))
	if err != nil {
		// Named formats, because "not a PNG" is nearly always a .jpg or a .ico
		// that somebody renamed, and the fix is to export it again.
		return nil, fmt.Errorf("%w: it is not a PNG (%v)", ErrBotIconInvalid, err)
	}
	if config.Width != config.Height {
		return nil, fmt.Errorf("%w: it is %dx%d, and an icon has to be square",
			ErrBotIconInvalid, config.Width, config.Height)
	}
	if config.Width < 1 || config.Width > BotIconPixels {
		return nil, fmt.Errorf("%w: it is %dx%d, and the limit is %dx%d",
			ErrBotIconInvalid, config.Width, config.Height, BotIconPixels, BotIconPixels)
	}

	decoded, err := png.Decode(bytes.NewReader(raw))
	if err != nil {
		return nil, fmt.Errorf("%w: the PNG data is damaged (%v)", ErrBotIconInvalid, err)
	}
	var buffer bytes.Buffer
	if err := (&png.Encoder{CompressionLevel: png.DefaultCompression}).
		Encode(&buffer, decoded); err != nil {
		return nil, fmt.Errorf("%w: it could not be re-encoded (%v)", ErrBotIconInvalid, err)
	}
	return buffer.Bytes(), nil
}
