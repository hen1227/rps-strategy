package persistence

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
)

// The look a player chose, carried on the account so it follows them between a
// browser and a phone.
//
// The server does not know what a theme is, and that is the design rather than
// a shortcut. The catalogue of themes, boards, piece sets and sound packs lives
// in the client, where the colours and the artwork are; a client ships new ones
// on its own schedule, and a server that checked ids against its own copy would
// reject every look added by a build newer than itself — which, for a phone app
// people update whenever they update it, is most of them. The same lesson the
// title catalogue records in `types/protocol.ts` on the other side.
//
// So what is stored is opaque, and what is enforced is only what has to be:
// that it is a JSON object, that its keys are ones this format knows, that
// every value is a short string, and that the whole thing is small. Those are
// limits on a *shape*, which cannot go out of date.

// ErrBadAppearance reports an appearance that is not the shape this column
// holds. It is always the caller's fault, never an unknown preset's.
var ErrBadAppearance = errors.New("appearance is not a valid set of choices")

// appearanceFields are the axes a look is chosen along. Adding one here is what
// lets a client start sending it; it is deliberately a closed list, so that a
// bug in a client cannot fill this column with arbitrary data.
var appearanceFields = map[string]bool{
	"theme":  true,
	"board":  true,
	"pieces": true,
	"sound":  true,
}

const (
	// maxAppearanceID is longer than any id anybody should need and short
	// enough that the column cannot be used as storage.
	maxAppearanceID = 64
	// maxAppearanceBytes bounds the whole object, including a value this
	// version has never heard of.
	maxAppearanceBytes = 512
)

// normalizeAppearance checks the shape and returns what should be stored: the
// canonical JSON of the known fields, or "" for a request that clears it.
func normalizeAppearance(raw string) (string, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "", nil
	}
	if len(raw) > maxAppearanceBytes {
		return "", fmt.Errorf("%w: too long", ErrBadAppearance)
	}
	var parsed map[string]string
	if err := json.Unmarshal([]byte(raw), &parsed); err != nil {
		return "", fmt.Errorf("%w: %v", ErrBadAppearance, err)
	}
	cleaned := make(map[string]string, len(parsed))
	for key, value := range parsed {
		if !appearanceFields[key] {
			return "", fmt.Errorf("%w: unknown field %q", ErrBadAppearance, key)
		}
		if value == "" {
			continue
		}
		if len(value) > maxAppearanceID {
			return "", fmt.Errorf("%w: %q is too long", ErrBadAppearance, key)
		}
		cleaned[key] = value
	}
	if len(cleaned) == 0 {
		return "", nil
	}
	// Marshalled again rather than stored as sent, so the column holds one
	// canonical form: Go sorts object keys, so two clients that send the same
	// four choices in a different order store the same bytes.
	encoded, err := json.Marshal(cleaned)
	if err != nil {
		return "", fmt.Errorf("%w: %v", ErrBadAppearance, err)
	}
	return string(encoded), nil
}

// SetAccountAppearance stores the look this account should be shown in. An
// empty request clears it, which puts the account back on whatever each device
// decides for itself.
func (store *Store) SetAccountAppearance(
	ctx context.Context,
	userID string,
	appearance string,
) (Account, error) {
	userID = strings.TrimSpace(userID)
	normalized, err := normalizeAppearance(appearance)
	if err != nil {
		return Account{}, err
	}
	result, err := store.db.ExecContext(ctx, `
UPDATE accounts SET appearance = ?, updated_at_unix_ms = ? WHERE user_id = ?
`, normalized, time.Now().UnixMilli(), userID)
	if err != nil {
		return Account{}, fmt.Errorf("set account appearance: %w", err)
	}
	if affected, err := result.RowsAffected(); err == nil && affected == 0 {
		return Account{}, ErrAccountNotFound
	}
	return store.Account(ctx, userID)
}
