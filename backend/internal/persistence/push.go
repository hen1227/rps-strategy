package persistence

import (
	"context"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"time"
)

var ErrInvalidPushSubscription = errors.New("invalid push subscription")

// PushTransport is the kind of address a row holds, and so which sender owns it.
//
// One table rather than two, because the away queue asks a single question —
// can this person be called back? — and the answer must not depend on which
// device they happen to own. Two tables would mean two counts, two prunes, and
// two chances to leave a seek on the board behind a device that is gone.
type PushTransport string

const (
	// TransportWebPush is a browser's push service URL, encrypted for with the
	// two keys below.
	TransportWebPush PushTransport = "webpush"
	// TransportAPNs is an iOS device token. It has no keys of its own: that
	// channel is authenticated by this server's Apple key rather than by
	// per-device material, so P256dh and Auth are empty on these rows.
	TransportAPNs PushTransport = "apns"
)

// PushSubscription is one browser's standing permission to be interrupted.
//
// It is the counterweight to a queue that outlives its tab. A seek can only
// wait for somebody who has left if there is a way to call them back, and this
// row is that way: no row, no away queue, and the seek is withdrawn on
// disconnect exactly as it always was. Keeping the two facts in one table is
// what lets "is this person reachable" be a single question with a single
// answer.
//
// Endpoint is the primary key because it is the browser's own name for the
// subscription. A browser that re-subscribes — after a permission reset, a
// profile copy, or a key rotation — hands back the same endpoint, so an upsert
// keeps one row per browser instead of accumulating one per visit.
//
// An iOS device token lives in that same column, for the same reason: it is the
// device's own name for itself, APNs hands back the same one until the app is
// reinstalled, and the upsert keeps one row per phone. Transport is what says
// which of the two an address is.
type PushSubscription struct {
	Endpoint         string        `json:"endpoint"`
	UserID           string        `json:"userId"`
	Transport        PushTransport `json:"transport"`
	P256dh           string        `json:"p256dh"`
	Auth             string        `json:"auth"`
	CreatedAtUnixMs  int64         `json:"createdAtUnixMs"`
	LastUsedAtUnixMs int64         `json:"lastUsedAtUnixMs"`
}

func (store *Store) ensurePushSchema(ctx context.Context) error {
	const schema = `
CREATE TABLE IF NOT EXISTS push_subscriptions (
    endpoint TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES accounts(user_id) ON DELETE CASCADE,
    transport TEXT NOT NULL DEFAULT 'webpush',
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    created_at_unix_ms INTEGER NOT NULL,
    last_used_at_unix_ms INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS push_subscriptions_user_idx
    ON push_subscriptions(user_id);
`
	if _, err := store.db.ExecContext(ctx, schema); err != nil {
		return fmt.Errorf("migrate push subscriptions: %w", err)
	}
	// CREATE TABLE IF NOT EXISTS does nothing to a table that is already there,
	// so a database from before iOS needs the column adding. Defaulting it to
	// webpush is what makes every row already in it go on meaning exactly what
	// it meant when it was written.
	columns, err := tableColumns(ctx, store.db, "push_subscriptions")
	if err != nil {
		return fmt.Errorf("inspect push subscription schema: %w", err)
	}
	if !columns["transport"] {
		if _, err := store.db.ExecContext(ctx,
			"ALTER TABLE push_subscriptions ADD COLUMN transport TEXT NOT NULL DEFAULT 'webpush'",
		); err != nil {
			return fmt.Errorf("add push subscription transport column: %w", err)
		}
	}
	return nil
}

// SavePushSubscription records a browser as reachable, or moves an existing
// endpoint to whoever is signed in now.
//
// The move matters: two people sharing a laptop subscribe the same browser, and
// the notification has to follow the account that asked for it most recently
// rather than being delivered to whoever got there first.
func (store *Store) SavePushSubscription(
	ctx context.Context,
	subscription PushSubscription,
) (PushSubscription, error) {
	subscription.Endpoint = strings.TrimSpace(subscription.Endpoint)
	subscription.UserID = strings.TrimSpace(subscription.UserID)
	subscription.P256dh = strings.TrimSpace(subscription.P256dh)
	subscription.Auth = strings.TrimSpace(subscription.Auth)
	// An unset transport is Web Push: it is what every row written before iOS
	// existed is, and what every caller that predates the field means.
	if subscription.Transport == "" {
		subscription.Transport = TransportWebPush
	}
	if subscription.UserID == "" {
		return PushSubscription{}, fmt.Errorf("%w: account is required", ErrInvalidPushSubscription)
	}
	switch subscription.Transport {
	case TransportWebPush:
		switch {
		case subscription.Endpoint == "":
			return PushSubscription{}, fmt.Errorf("%w: endpoint is required", ErrInvalidPushSubscription)
		case !strings.HasPrefix(subscription.Endpoint, "https://"):
			// A push service is always https. Refusing anything else keeps the
			// server from being talked into making requests to arbitrary hosts.
			return PushSubscription{}, fmt.Errorf("%w: endpoint must be https", ErrInvalidPushSubscription)
		case subscription.P256dh == "" || subscription.Auth == "":
			return PushSubscription{}, fmt.Errorf("%w: both encryption keys are required", ErrInvalidPushSubscription)
		}
	case TransportAPNs:
		if err := validateDeviceToken(subscription.Endpoint); err != nil {
			return PushSubscription{}, err
		}
		// APNs rows carry no key material, so any that arrived is dropped here
		// rather than stored where a later reader would take it for a Web Push
		// subscription with an unusable endpoint.
		subscription.P256dh = ""
		subscription.Auth = ""
	default:
		return PushSubscription{}, fmt.Errorf(
			"%w: unknown transport %q", ErrInvalidPushSubscription, subscription.Transport,
		)
	}

	now := time.Now().UnixMilli()
	if subscription.CreatedAtUnixMs == 0 {
		subscription.CreatedAtUnixMs = now
	}
	subscription.LastUsedAtUnixMs = now
	if _, err := store.db.ExecContext(ctx, `
INSERT INTO push_subscriptions (
    endpoint, user_id, transport, p256dh, auth, created_at_unix_ms, last_used_at_unix_ms
) VALUES (?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(endpoint) DO UPDATE SET
    user_id = excluded.user_id,
    transport = excluded.transport,
    p256dh = excluded.p256dh,
    auth = excluded.auth,
    last_used_at_unix_ms = excluded.last_used_at_unix_ms
`,
		subscription.Endpoint, subscription.UserID, string(subscription.Transport),
		subscription.P256dh, subscription.Auth,
		subscription.CreatedAtUnixMs, subscription.LastUsedAtUnixMs,
	); err != nil {
		return PushSubscription{}, fmt.Errorf("save push subscription: %w", err)
	}
	return subscription, nil
}

// PushSubscriptionsFor is every device one account can be reached on, of every
// kind. The caller sends to each by its own transport; nothing above this line
// has to know how many kinds there are.
func (store *Store) PushSubscriptionsFor(
	ctx context.Context,
	userID string,
) ([]PushSubscription, error) {
	rows, err := store.db.QueryContext(ctx, `
SELECT endpoint, user_id, transport, p256dh, auth,
       created_at_unix_ms, last_used_at_unix_ms
FROM push_subscriptions
WHERE user_id = ?
ORDER BY created_at_unix_ms
`, strings.TrimSpace(userID))
	if err != nil {
		return nil, fmt.Errorf("query push subscriptions: %w", err)
	}
	defer rows.Close()

	subscriptions := make([]PushSubscription, 0, 2)
	for rows.Next() {
		var subscription PushSubscription
		if err := rows.Scan(
			&subscription.Endpoint, &subscription.UserID, &subscription.Transport,
			&subscription.P256dh, &subscription.Auth,
			&subscription.CreatedAtUnixMs, &subscription.LastUsedAtUnixMs,
		); err != nil {
			return nil, fmt.Errorf("read push subscription: %w", err)
		}
		subscriptions = append(subscriptions, subscription)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("read push subscriptions: %w", err)
	}
	return subscriptions, nil
}

// HasPushSubscription answers the only question the queue asks: can this person
// be called back? Counted rather than fetched, because the caller that asks is
// deciding whether to keep a seek, not preparing to send anything.
func (store *Store) HasPushSubscription(ctx context.Context, userID string) (bool, error) {
	var count int
	err := store.db.QueryRowContext(ctx, `
SELECT COUNT(*) FROM push_subscriptions WHERE user_id = ?
`, strings.TrimSpace(userID)).Scan(&count)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return false, fmt.Errorf("count push subscriptions: %w", err)
	}
	return count > 0, nil
}

// validateDeviceToken refuses an APNs token that could never be delivered to.
//
// Length is bounded rather than pinned: a token is 32 bytes today and Apple has
// said that may change. The alphabet is checked though, because a token with a
// colon or a slash in it is the shape of something that was meant to be a URL,
// and storing one would leave an account looking reachable for ever while
// silently being anything but.
func validateDeviceToken(token string) error {
	switch {
	case token == "":
		return fmt.Errorf("%w: device token is required", ErrInvalidPushSubscription)
	case len(token) < 32 || len(token) > 200 || len(token)%2 == 1:
		return fmt.Errorf(
			"%w: device token must be 32 to 200 hex characters",
			ErrInvalidPushSubscription,
		)
	}
	if _, err := hex.DecodeString(token); err != nil {
		return fmt.Errorf("%w: device token must be hexadecimal", ErrInvalidPushSubscription)
	}
	return nil
}

// DeletePushSubscription forgets one browser, or one phone.
//
// Called both when somebody turns notifications off and when a push service
// answers 404 or 410, which is its way of saying the subscription is dead. The
// second case is the important one: an endpoint nobody prunes is an account
// that looks reachable for ever and silently is not, which is precisely the
// ghost the away queue must not contain.
func (store *Store) DeletePushSubscription(ctx context.Context, endpoint string) error {
	if _, err := store.db.ExecContext(
		ctx,
		"DELETE FROM push_subscriptions WHERE endpoint = ?",
		strings.TrimSpace(endpoint),
	); err != nil {
		return fmt.Errorf("delete push subscription: %w", err)
	}
	return nil
}
