package persistence

import (
	"context"
	"fmt"
	"time"
)

// Revoking a provider's token after the account it signed in has gone.
//
// Apple asks every app that offers its sign-in to revoke the user's tokens when
// they delete their account, through its REST API, so that the app stops
// appearing under "Sign in with Apple" in their Apple ID settings. That needs
// the refresh token stored at sign-in (see Identity.RefreshToken), and it needs
// Apple to answer — which is the part that must never stand between somebody
// and the deletion they asked for. Apple's own guidance (TN3194) says the same:
// delete the account regardless.
//
// So deletion does not call Apple. It queues the token, in the same transaction
// that removes the identity, and the server works through the queue on its own
// time: once straight away, then again with a growing wait until Apple accepts
// it. A token that is in the queue has already left the account it belonged
// to, so nothing here can be traced back to the person who left.
//
// The queueing is a trigger rather than a call, on purpose. An identity row can
// go by several paths — anonymizing, purging, the cascade from any deleted
// account row — and a step that each of them had to remember is a step one of
// them would one day forget. SQLite runs a delete trigger for rows a foreign
// key cascade removes as well, so the trigger covers every one of them.

// TokenRevocation is one token waiting to be revoked.
type TokenRevocation struct {
	ID       int64
	Provider string
	// ClientID is the client the token was issued to, which is the client
	// Apple accepts its revocation from.
	ClientID string
	Token    string
	Attempts int
}

func (store *Store) ensureIdentityRevocationSchema(ctx context.Context) error {
	// No reference to accounts: the account is gone by the time a row is
	// read, and the token is the whole of what is left to do.
	const schema = `
CREATE TABLE IF NOT EXISTS identity_token_revocations (
    revocation_id INTEGER PRIMARY KEY AUTOINCREMENT,
    provider TEXT NOT NULL,
    client_id TEXT NOT NULL,
    token TEXT NOT NULL,
    queued_at_unix_ms INTEGER NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at_unix_ms INTEGER NOT NULL DEFAULT 0,
    last_error TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS identity_token_revocations_due_idx
    ON identity_token_revocations(next_attempt_at_unix_ms);

CREATE TRIGGER IF NOT EXISTS account_identities_queue_revocation
AFTER DELETE ON account_identities
WHEN old.refresh_token <> ''
BEGIN
    INSERT INTO identity_token_revocations (provider, client_id, token, queued_at_unix_ms)
    VALUES (old.provider, old.token_client_id, old.refresh_token,
            CAST(strftime('%s', 'now') AS INTEGER) * 1000);
END;
`
	if _, err := store.db.ExecContext(ctx, schema); err != nil {
		return fmt.Errorf("migrate identity token revocations: %w", err)
	}
	return nil
}

// DueTokenRevocations lists the revocations whose next attempt has come, oldest
// first.
func (store *Store) DueTokenRevocations(
	ctx context.Context,
	now time.Time,
	limit int,
) ([]TokenRevocation, error) {
	if limit <= 0 {
		limit = 20
	}
	rows, err := store.db.QueryContext(ctx, `
SELECT revocation_id, provider, client_id, token, attempts
FROM identity_token_revocations
WHERE next_attempt_at_unix_ms <= ?
ORDER BY revocation_id
LIMIT ?
`, now.UnixMilli(), limit)
	if err != nil {
		return nil, fmt.Errorf("read due token revocations: %w", err)
	}
	defer rows.Close()
	var due []TokenRevocation
	for rows.Next() {
		var revocation TokenRevocation
		if err := rows.Scan(
			&revocation.ID, &revocation.Provider, &revocation.ClientID,
			&revocation.Token, &revocation.Attempts,
		); err != nil {
			return nil, fmt.Errorf("read token revocation: %w", err)
		}
		due = append(due, revocation)
	}
	return due, rows.Err()
}

// CompleteTokenRevocation forgets a token the provider has accepted the
// revocation of. Nothing about it is kept.
func (store *Store) CompleteTokenRevocation(ctx context.Context, id int64) error {
	if _, err := store.db.ExecContext(ctx,
		`DELETE FROM identity_token_revocations WHERE revocation_id = ?`, id,
	); err != nil {
		return fmt.Errorf("complete token revocation: %w", err)
	}
	return nil
}

// PostponeTokenRevocation records a failed attempt and when to try again.
func (store *Store) PostponeTokenRevocation(
	ctx context.Context,
	id int64,
	next time.Time,
	reason string,
) error {
	if len(reason) > 500 {
		reason = reason[:500]
	}
	if _, err := store.db.ExecContext(ctx, `
UPDATE identity_token_revocations
SET attempts = attempts + 1, next_attempt_at_unix_ms = ?, last_error = ?
WHERE revocation_id = ?
`, next.UnixMilli(), reason, id); err != nil {
		return fmt.Errorf("postpone token revocation: %w", err)
	}
	return nil
}

// PendingTokenRevocations counts the tokens still waiting, for the boot log.
func (store *Store) PendingTokenRevocations(ctx context.Context) (int, error) {
	var pending int
	if err := store.db.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM identity_token_revocations`,
	).Scan(&pending); err != nil {
		return 0, fmt.Errorf("count token revocations: %w", err)
	}
	return pending, nil
}
