package persistence

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"
)

// One player deciding they do not want to deal with another.
//
// This is not moderation. Everything in moderation.go is a *host* deciding
// something about an account and applying it to everybody; a block is one
// person's own preference, invisible to the rest of the site and reversible by
// them alone. The two never meet: a block places no sanction, appears on no
// admin screen as a mark against anybody, and says nothing about whether the
// blocked player did anything wrong. Reporting — reports.go — is the path that
// asks the host to look.
//
// # What it does
//
// Two things, and deliberately not a third:
//
//   - **Chat is hidden, both ways.** Neither sees the other's messages, in a
//     live room or in the history a joining client is handed. Both ways rather
//     than one, because a conversation where one side can read the other and
//     reply into a void is worse for both of them than plain silence.
//   - **Direct challenges are refused, both ways.** A challenge addressed to a
//     username lands in that person's inbox, which is the other way to put
//     yourself in front of somebody who does not want you there. Same reasoning
//     as the mute sanction, which pairs chat and challenges for the same
//     reason.
//
// What it deliberately does *not* do is take either of them out of
// matchmaking. The queue pairs whoever is waiting, and on a site this size
// removing people from each other's pool would quietly turn a block into "one
// of us cannot get a game". Someone who cannot bear to play the other at all
// has nothing to say to them either, and the block already guarantees that.
//
// # Why it is symmetric
//
// A block is stored one-directional — who blocked whom is a real fact, and the
// list a player manages is theirs. Every *effect* above is symmetric, and is
// asked as "is there a block between these two" rather than "did A block B".
// One-directional effects are how you end up with a blocked account that can
// still see, and answer, everything the blocker says.

// ErrCannotBlockSelf is what blocking your own account produces, rather than a
// row that would silently hide you from yourself.
var ErrCannotBlockSelf = errors.New("you cannot block yourself")

// BlockedAccount is one entry of the list a player manages, joined to the name
// they would recognise it by. A user id alone is not a list anybody can use.
type BlockedAccount struct {
	UserID   string `json:"userId"`
	Username string `json:"username"`
	Title    string `json:"title,omitempty"`
	// Kind distinguishes a person from an engine, since bots have accounts too
	// and a blocked bot reads oddly without it.
	Kind            string `json:"kind"`
	BlockedAtUnixMs int64  `json:"blockedAtUnixMs"`
}

// MaximumBlocks caps one account's list.
//
// Not a moral position — it is a bound on the memory the server holds for a
// feature every connection consults. Ten times what anybody has ever needed,
// and low enough that a script filling the table is refused rather than served.
const MaximumBlocks = 500

// ensureBlockSchema creates the block list.
//
// The primary key is the pair, so blocking somebody twice is the same single
// row: the insert is an upsert and the second press of the button is a no-op
// rather than a duplicate nobody can see behind the first.
func (store *Store) ensureBlockSchema(ctx context.Context) error {
	const schema = `
CREATE TABLE IF NOT EXISTS account_blocks (
    blocker_user_id TEXT NOT NULL REFERENCES accounts(user_id) ON DELETE CASCADE,
    blocked_user_id TEXT NOT NULL REFERENCES accounts(user_id) ON DELETE CASCADE,
    created_at_unix_ms INTEGER NOT NULL,
    PRIMARY KEY (blocker_user_id, blocked_user_id),
    CHECK (blocker_user_id <> blocked_user_id)
);

CREATE INDEX IF NOT EXISTS account_blocks_blocked_idx
    ON account_blocks(blocked_user_id);
`
	if _, err := store.db.ExecContext(ctx, schema); err != nil {
		return fmt.Errorf("migrate block schema: %w", err)
	}
	return nil
}

// BlockAccount adds one player to another's list.
//
// Blocking somebody already blocked succeeds without changing anything, which
// is what makes the button safe to press twice — from two tabs, or after a
// reply that never arrived.
func (store *Store) BlockAccount(ctx context.Context, blockerID, blockedID string) error {
	blockerID = strings.TrimSpace(blockerID)
	blockedID = strings.TrimSpace(blockedID)
	if blockerID == "" || blockedID == "" {
		return ErrAccountNotFound
	}
	if blockerID == blockedID {
		return ErrCannotBlockSelf
	}
	// Both ends checked here rather than left to the foreign keys, because a
	// constraint failure on an id that does not exist reads as a server fault
	// and this reads as the mistake it is.
	for _, userID := range []string{blockerID, blockedID} {
		var exists int
		if err := store.db.QueryRowContext(ctx,
			`SELECT COUNT(*) FROM accounts WHERE user_id = ?`, userID,
		).Scan(&exists); err != nil {
			return fmt.Errorf("block account: read account: %w", err)
		}
		if exists == 0 {
			return ErrAccountNotFound
		}
	}
	var held int
	if err := store.db.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM account_blocks WHERE blocker_user_id = ?`, blockerID,
	).Scan(&held); err != nil {
		return fmt.Errorf("block account: count blocks: %w", err)
	}
	if held >= MaximumBlocks {
		return fmt.Errorf("you can block at most %d players", MaximumBlocks)
	}
	if _, err := store.db.ExecContext(ctx, `
INSERT INTO account_blocks (blocker_user_id, blocked_user_id, created_at_unix_ms)
VALUES (?, ?, ?)
ON CONFLICT (blocker_user_id, blocked_user_id) DO NOTHING
`, blockerID, blockedID, time.Now().UnixMilli()); err != nil {
		return fmt.Errorf("block account: %w", err)
	}
	return nil
}

// UnblockAccount removes one entry. Unblocking somebody who was never blocked
// is not an error: the caller wanted them unblocked, and they are.
func (store *Store) UnblockAccount(ctx context.Context, blockerID, blockedID string) error {
	if _, err := store.db.ExecContext(ctx, `
DELETE FROM account_blocks WHERE blocker_user_id = ? AND blocked_user_id = ?
`, strings.TrimSpace(blockerID), strings.TrimSpace(blockedID)); err != nil {
		return fmt.Errorf("unblock account: %w", err)
	}
	return nil
}

// BlockedAccounts is the list one player manages, newest first.
//
// A LEFT JOIN rather than an inner one: an account that has since been
// anonymized keeps its row here, and dropping it from the list would silently
// unblock somebody without saying so.
func (store *Store) BlockedAccounts(
	ctx context.Context,
	blockerID string,
) ([]BlockedAccount, error) {
	rows, err := store.db.QueryContext(ctx, `
SELECT b.blocked_user_id, COALESCE(a.username, ''), COALESCE(a.title, ''),
       COALESCE(a.kind, 'human'), b.created_at_unix_ms
FROM account_blocks b
LEFT JOIN accounts a ON a.user_id = b.blocked_user_id
WHERE b.blocker_user_id = ?
ORDER BY b.created_at_unix_ms DESC
`, strings.TrimSpace(blockerID))
	if err != nil {
		return nil, fmt.Errorf("list blocks: %w", err)
	}
	defer func() { _ = rows.Close() }()

	blocked := make([]BlockedAccount, 0, 8)
	for rows.Next() {
		var entry BlockedAccount
		if err := rows.Scan(
			&entry.UserID, &entry.Username, &entry.Title,
			&entry.Kind, &entry.BlockedAtUnixMs,
		); err != nil {
			return nil, fmt.Errorf("list blocks: %w", err)
		}
		if entry.Username == "" {
			entry.Username = "Deleted player"
		}
		blocked = append(blocked, entry)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("list blocks: %w", err)
	}
	return blocked, nil
}

// IsBlockedBetween reports whether either of two accounts has blocked the
// other. The symmetric question, which is the only one any effect asks.
func (store *Store) IsBlockedBetween(ctx context.Context, first, second string) (bool, error) {
	var count int
	if err := store.db.QueryRowContext(ctx, `
SELECT COUNT(*) FROM account_blocks
WHERE (blocker_user_id = ?1 AND blocked_user_id = ?2)
   OR (blocker_user_id = ?2 AND blocked_user_id = ?1)
`, strings.TrimSpace(first), strings.TrimSpace(second)).Scan(&count); err != nil {
		return false, fmt.Errorf("read block: %w", err)
	}
	return count > 0, nil
}

// AllBlocks is every block on record, keyed by who placed it.
//
// Read once at boot and held in memory, for the reason moderation.go gives at
// length about sanctions: chat delivery asks this question once per listener
// per message, over the same single SQLite connection the game loop uses. See
// Server.loadBlocks, which owns the cache and is the only thing that reads
// this.
func (store *Store) AllBlocks(ctx context.Context) (map[string]map[string]struct{}, error) {
	rows, err := store.db.QueryContext(ctx,
		`SELECT blocker_user_id, blocked_user_id FROM account_blocks`,
	)
	if err != nil {
		return nil, fmt.Errorf("load blocks: %w", err)
	}
	defer func() { _ = rows.Close() }()

	byBlocker := make(map[string]map[string]struct{})
	for rows.Next() {
		var blocker, blocked string
		if err := rows.Scan(&blocker, &blocked); err != nil {
			return nil, fmt.Errorf("load blocks: %w", err)
		}
		if byBlocker[blocker] == nil {
			byBlocker[blocker] = make(map[string]struct{})
		}
		byBlocker[blocker][blocked] = struct{}{}
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("load blocks: %w", err)
	}
	return byBlocker, nil
}

// AccountIDForUsername resolves a name to the account behind it, which is what
// a client blocking or reporting somebody it only knows by name needs.
//
// Case-insensitive, through the same folding uniqueness uses, so the name a
// player copied out of a chat line resolves however they typed it back.
func (store *Store) AccountIDForUsername(ctx context.Context, username string) (string, error) {
	var userID string
	err := store.db.QueryRowContext(ctx,
		`SELECT user_id FROM accounts WHERE username_lower = ?`, UsernameKey(username),
	).Scan(&userID)
	if errors.Is(err, sql.ErrNoRows) {
		return "", ErrAccountNotFound
	}
	if err != nil {
		return "", fmt.Errorf("resolve username: %w", err)
	}
	return userID, nil
}
