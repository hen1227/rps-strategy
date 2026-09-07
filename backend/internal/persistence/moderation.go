package persistence

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"
)

// The sanctions that are less than a ban.
//
// `accounts.disabled` is the whole hammer: the account stops existing as far as
// the server is concerned, every session is revoked, and the connection is
// closed. It is the right answer roughly never. Almost everything a host
// actually needs to do is narrower — somebody who cannot behave in chat can
// still play, somebody who sandbagged the ladder can still enter events — and
// the alternative to having those narrow answers is that every incident gets
// resolved with the hammer or with nothing.
//
// So there are three of them, and they are independent:
//
//   - **mute** stops talking. Chat is refused, and so is posting or sending a
//     challenge, because a challenge carries a username somebody typed and is
//     the other way to put words in front of a person who does not want them.
//     (That pairing is deliberate and it is the whole definition — see
//     Server.muteRefusal, which is the only place either half is enforced.)
//   - **ranked** stops the ladder. Casual play, challenges, and spectating are
//     untouched; a rated game is downgraded exactly the way a guest's is.
//   - **tournament** stops entering events. Signups are refused and an event
//     already entered is left alone, because withdrawing somebody from a
//     started round robin rewrites results other people earned.
//
// Two decisions worth stating, because everything below assumes them:
//
//   - **They expire.** Every one of these takes an optional deadline, and the
//     usual answer is a deadline: a sanction with no end is a thing to remember
//     to undo, and the ones nobody remembers are the ones that quietly become
//     permanent. Indefinite is still available, and is what the "until lifted"
//     option in the admin screen writes, but it is a choice rather than the
//     default.
//   - **Expiry is a read-time question, not a job.** An elapsed restriction is
//     simply not active; nothing has to run for it to lapse. PruneExpired
//     exists to keep the table small, and if it never ran the behaviour would
//     be identical.
type RestrictionKind string

const (
	// RestrictMute silences chat and challenges. See the note above about why
	// those two travel together.
	RestrictMute RestrictionKind = "mute"
	// RestrictRanked bars rated play. A ranked game becomes casual rather than
	// being refused, so this never leaves somebody unable to play.
	RestrictRanked RestrictionKind = "ranked"
	// RestrictTournament bars entering events.
	RestrictTournament RestrictionKind = "tournament"
)

// ErrUnknownRestriction is what a bad `kind` produces, rather than a row that
// no enforcement path will ever consult.
var ErrUnknownRestriction = errors.New("unknown restriction")

// RestrictionKinds is every sanction there is, in the order the admin screen
// shows them: most common first.
var RestrictionKinds = []RestrictionKind{RestrictMute, RestrictRanked, RestrictTournament}

// Valid reports whether this is one of the three.
func (kind RestrictionKind) Valid() bool {
	for _, known := range RestrictionKinds {
		if kind == known {
			return true
		}
	}
	return false
}

// Label is the sanction in the words a player reads when they run into it.
func (kind RestrictionKind) Label() string {
	switch kind {
	case RestrictMute:
		return "muted"
	case RestrictRanked:
		return "barred from ranked play"
	case RestrictTournament:
		return "barred from tournaments"
	}
	return string(kind)
}

// Restriction is one sanction on one account.
type Restriction struct {
	Kind   RestrictionKind `json:"kind"`
	Reason string          `json:"reason,omitempty"`
	// IssuedBy is the administrator's user id, kept so that a sanction somebody
	// disagrees with has somebody to ask about it. It is not published to the
	// player it is on — see PublicRestriction.
	IssuedBy       string `json:"issuedBy,omitempty"`
	IssuedAtUnixMs int64  `json:"issuedAtUnixMs"`
	// ExpiresAtUnixMs is when it lapses, and nil for one that stands until an
	// administrator lifts it. A pointer rather than a zero sentinel because
	// "no deadline" and "expired in 1970" are opposite states and a zero would
	// read as the second.
	ExpiresAtUnixMs *int64 `json:"expiresAtUnixMs,omitempty"`
}

// ActiveAt reports whether this restriction is in force at an instant.
func (restriction Restriction) ActiveAt(now time.Time) bool {
	if restriction.ExpiresAtUnixMs == nil {
		return true
	}
	return now.UnixMilli() < *restriction.ExpiresAtUnixMs
}

// PublicRestriction is a sanction as the person under it is told about it: what
// it stops, why, and when it ends.
//
// Deliberately not the whole Restriction. Who issued it is an internal note —
// publishing it turns "you are muted for an hour" into a name to argue with,
// and the host is reachable through the Discord in the credits either way.
type PublicRestriction struct {
	Kind            RestrictionKind `json:"kind"`
	Reason          string          `json:"reason,omitempty"`
	ExpiresAtUnixMs *int64          `json:"expiresAtUnixMs,omitempty"`
}

// Public strips a restriction down to what its subject may see.
func (restriction Restriction) Public() PublicRestriction {
	return PublicRestriction{
		Kind:            restriction.Kind,
		Reason:          restriction.Reason,
		ExpiresAtUnixMs: restriction.ExpiresAtUnixMs,
	}
}

const maximumRestrictionReasonRunes = 200

// ensureModerationSchema creates the sanctions table.
//
// One row per account per kind, so re-muting somebody who is already muted
// extends the existing sanction rather than stacking a second one nobody can
// see behind the first. That is what the primary key buys, and it is why
// SetRestriction is an upsert rather than an insert.
func (store *Store) ensureModerationSchema(ctx context.Context) error {
	const schema = `
CREATE TABLE IF NOT EXISTS account_restrictions (
    user_id TEXT NOT NULL REFERENCES accounts(user_id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('mute', 'ranked', 'tournament')),
    reason TEXT NOT NULL DEFAULT '',
    issued_by TEXT NOT NULL DEFAULT '',
    issued_at_unix_ms INTEGER NOT NULL,
    expires_at_unix_ms INTEGER,
    PRIMARY KEY (user_id, kind)
);

CREATE INDEX IF NOT EXISTS account_restrictions_expiry_idx
    ON account_restrictions(expires_at_unix_ms);
`
	if _, err := store.db.ExecContext(ctx, schema); err != nil {
		return fmt.Errorf("migrate moderation schema: %w", err)
	}
	return nil
}

// SetRestriction places or extends a sanction.
//
// `expiresAt` is nil for one that stands until it is lifted. Placing the same
// kind twice replaces it, which is what makes "mute them for another hour"
// work: the reason and the deadline are both the new ones, and there is still
// exactly one mute to lift.
func (store *Store) SetRestriction(
	ctx context.Context,
	userID string,
	kind RestrictionKind,
	reason string,
	issuedBy string,
	expiresAt *int64,
) (Restriction, error) {
	userID = strings.TrimSpace(userID)
	reason = strings.TrimSpace(reason)
	if !kind.Valid() {
		return Restriction{}, fmt.Errorf("%w: %q", ErrUnknownRestriction, kind)
	}
	if len([]rune(reason)) > maximumRestrictionReasonRunes {
		return Restriction{}, fmt.Errorf(
			"reason must be at most %d characters", maximumRestrictionReasonRunes,
		)
	}
	// Checked here rather than relied on through the foreign key, because a
	// constraint failure on a typo'd user id reads as a server fault and this
	// reads as the mistake it is.
	var exists int
	if err := store.db.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM accounts WHERE user_id = ?`, userID,
	).Scan(&exists); err != nil {
		return Restriction{}, fmt.Errorf("set restriction: read account: %w", err)
	}
	if exists == 0 {
		return Restriction{}, ErrAccountNotFound
	}

	now := time.Now().UnixMilli()
	var deadline any
	if expiresAt != nil {
		deadline = *expiresAt
	}
	if _, err := store.db.ExecContext(ctx, `
INSERT INTO account_restrictions (
    user_id, kind, reason, issued_by, issued_at_unix_ms, expires_at_unix_ms
) VALUES (?, ?, ?, ?, ?, ?)
ON CONFLICT (user_id, kind) DO UPDATE SET
    reason = excluded.reason,
    issued_by = excluded.issued_by,
    issued_at_unix_ms = excluded.issued_at_unix_ms,
    expires_at_unix_ms = excluded.expires_at_unix_ms
`, userID, kind, reason, strings.TrimSpace(issuedBy), now, deadline); err != nil {
		return Restriction{}, fmt.Errorf("set restriction: %w", err)
	}
	return Restriction{
		Kind:            kind,
		Reason:          reason,
		IssuedBy:        strings.TrimSpace(issuedBy),
		IssuedAtUnixMs:  now,
		ExpiresAtUnixMs: expiresAt,
	}, nil
}

// ClearRestriction lifts a sanction. Lifting one that was never placed is not
// an error: the caller wanted the account unrestricted, and it is.
func (store *Store) ClearRestriction(
	ctx context.Context,
	userID string,
	kind RestrictionKind,
) error {
	if !kind.Valid() {
		return fmt.Errorf("%w: %q", ErrUnknownRestriction, kind)
	}
	if _, err := store.db.ExecContext(ctx,
		`DELETE FROM account_restrictions WHERE user_id = ? AND kind = ?`,
		strings.TrimSpace(userID), kind,
	); err != nil {
		return fmt.Errorf("clear restriction: %w", err)
	}
	return nil
}

// Restrictions reads one account's sanctions, expired ones included.
//
// Expired ones are included on purpose: this is what the admin screen shows,
// and "muted until 20 minutes ago, for spamming the lobby" is the context a
// host wants before deciding what to do about the next incident.
func (store *Store) Restrictions(ctx context.Context, userID string) ([]Restriction, error) {
	byAccount, err := store.RestrictionsFor(ctx, []string{strings.TrimSpace(userID)})
	if err != nil {
		return nil, err
	}
	return byAccount[strings.TrimSpace(userID)], nil
}

// RestrictionsFor reads the sanctions on a page of accounts in one query, so
// the admin list does not do a round trip per row.
func (store *Store) RestrictionsFor(
	ctx context.Context,
	userIDs []string,
) (map[string][]Restriction, error) {
	byAccount := make(map[string][]Restriction, len(userIDs))
	if len(userIDs) == 0 {
		return byAccount, nil
	}
	placeholders := make([]string, len(userIDs))
	arguments := make([]any, len(userIDs))
	for index, userID := range userIDs {
		placeholders[index] = "?"
		arguments[index] = userID
	}
	rows, err := store.db.QueryContext(ctx, `
SELECT user_id, kind, reason, issued_by, issued_at_unix_ms, expires_at_unix_ms
FROM account_restrictions
WHERE user_id IN (`+strings.Join(placeholders, ", ")+`)
`, arguments...)
	if err != nil {
		return nil, fmt.Errorf("read restrictions: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var userID string
		var restriction Restriction
		var expires *int64
		if err := rows.Scan(
			&userID, &restriction.Kind, &restriction.Reason, &restriction.IssuedBy,
			&restriction.IssuedAtUnixMs, &expires,
		); err != nil {
			return nil, fmt.Errorf("read restriction row: %w", err)
		}
		restriction.ExpiresAtUnixMs = expires
		byAccount[userID] = append(byAccount[userID], restriction)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("read restrictions: %w", err)
	}
	for userID := range byAccount {
		sortRestrictions(byAccount[userID])
	}
	return byAccount, nil
}

// AllRestrictions reads every sanction on record, which is what the server
// loads into memory at boot. See Server.loadRestrictions for why it is held
// there rather than queried on every chat message.
func (store *Store) AllRestrictions(ctx context.Context) (map[string][]Restriction, error) {
	rows, err := store.db.QueryContext(ctx, `
SELECT user_id, kind, reason, issued_by, issued_at_unix_ms, expires_at_unix_ms
FROM account_restrictions
`)
	if err != nil {
		return nil, fmt.Errorf("read all restrictions: %w", err)
	}
	defer rows.Close()
	byAccount := make(map[string][]Restriction)
	for rows.Next() {
		var userID string
		var restriction Restriction
		var expires *int64
		if err := rows.Scan(
			&userID, &restriction.Kind, &restriction.Reason, &restriction.IssuedBy,
			&restriction.IssuedAtUnixMs, &expires,
		); err != nil {
			return nil, fmt.Errorf("read restriction row: %w", err)
		}
		restriction.ExpiresAtUnixMs = expires
		byAccount[userID] = append(byAccount[userID], restriction)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("read all restrictions: %w", err)
	}
	for userID := range byAccount {
		sortRestrictions(byAccount[userID])
	}
	return byAccount, nil
}

// PruneExpiredRestrictions deletes lapsed sanctions.
//
// Housekeeping only. An expired restriction is already not in force — see the
// note at the top of this file — so this changes nothing anyone can observe
// except the size of the table and the length of the history the admin screen
// shows.
func (store *Store) PruneExpiredRestrictions(ctx context.Context, before time.Time) (int, error) {
	result, err := store.db.ExecContext(ctx, `
DELETE FROM account_restrictions
WHERE expires_at_unix_ms IS NOT NULL AND expires_at_unix_ms < ?
`, before.UnixMilli())
	if err != nil {
		return 0, fmt.Errorf("prune restrictions: %w", err)
	}
	affected, _ := result.RowsAffected()
	return int(affected), nil
}

// sortRestrictions puts them in RestrictionKinds order, so every screen and
// every payload lists a person's sanctions the same way round.
func sortRestrictions(restrictions []Restriction) {
	rank := make(map[RestrictionKind]int, len(RestrictionKinds))
	for index, kind := range RestrictionKinds {
		rank[kind] = index
	}
	sort.SliceStable(restrictions, func(first, second int) bool {
		return rank[restrictions[first].Kind] < rank[restrictions[second].Kind]
	})
}
