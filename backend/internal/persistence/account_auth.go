package persistence

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"time"
)

// Registered accounts: claiming a username, setting a password, and holding a
// session.
//
// The rule that shapes all of it is that an account is *upgraded*, never
// replaced. A player who has been clicking around anonymously for months has a
// user ID, an Elo in three modes, and a pile of archived games; registering
// attaches a name and a password to that same row. Creating a second account
// and asking them to start over would be the easy implementation and the wrong
// product.

const (
	// SessionLifetime is deliberately long. The alternative to a long-lived
	// session here is not better security, it is players who stop registering.
	SessionLifetime = 90 * 24 * time.Hour
	// SessionTokenPrefix marks a session token on sight. Three different
	// secrets arrive in `Authorization: Bearer` headers, and guessing which is
	// which by shape is how one gets accepted where another was meant.
	SessionTokenPrefix = "rps_s_"
	sessionTokenBytes  = 32
)

var (
	// ErrAccountDisabled is returned for an account an admin has switched off.
	ErrAccountDisabled = errors.New("account is disabled")
	// ErrAlreadyRegistered is returned when an account already has a password.
	ErrAlreadyRegistered = errors.New("account is already registered")
	// ErrInvalidCredentials covers every login failure, on purpose: the caller
	// must not learn whether the username exists.
	ErrInvalidCredentials = errors.New("username or password is incorrect")
	// ErrSessionInvalid covers an unknown, expired, or revoked session token.
	ErrSessionInvalid = errors.New("session is not valid")
	// ErrNotRegistered is returned when an operation needs a real account and
	// the caller only has the anonymous browser identity.
	ErrNotRegistered = errors.New("account is not registered")
)

// registeredSQL is the one definition of "a real account rather than the
// anonymous browser identity": it holds a credential of some kind.
//
// This used to be spelled as an emptiness test on `password_hash`, at four
// sites that did not share code, which is how they came to disagree — the human leaderboard filter
// and the admin badge each kept their own copy. Discord turns that from
// duplication into a bug: an account can now be real without ever having had a
// password, so every copy that is not updated together starts answering a
// different question.
//
// The alias is for queries that join `accounts` under a name. Pass "" when the
// columns are unqualified.
func registeredSQL(alias string) string {
	prefix := ""
	if alias != "" {
		prefix = alias + "."
	}
	return "(" + prefix + "password_hash <> '' OR " + prefix + "discord_user_id <> '')"
}

// awaitingDiscordLinkSQL is the *other* narrow question: an account that still
// has a password and has not linked an identity.
//
// Not the negation of registeredSQL, and not derivable from it — a Discord
// account is registered with no password at all, so "not registered" and "still
// on a password" are different sets. This is the remainder of the password era:
// the accounts the link paths exist for, and the count that has to reach zero
// before password sign-in can be removed.
//
// It is a shared fragment for the same reason registeredSQL is. Two callers
// want it — the boot-time count and the naming step deciding whether to offer a
// password box — and this package has already been through what happens when a
// predicate about credentials is written out by hand at several sites. See
// registered_rule_test.go, which is what keeps both of these honest.
func awaitingDiscordLinkSQL(alias string) string {
	prefix := ""
	if alias != "" {
		prefix = alias + "."
	}
	return "(" + prefix + "password_hash <> '' AND " + prefix + "discord_user_id = '')"
}

// accountIsRegistered is the Go-side twin of registeredSQL, for the callers
// that have already read the two columns and are deciding in Go. The two must
// always agree: a rule enforced one way in SQL and another way in Go is the
// same rule twice, which is the shape of the problem this pair exists to end.
func accountIsRegistered(passwordHash string, discordUserID string) bool {
	return passwordHash != "" || discordUserID != ""
}

func (store *Store) ensureAccountAuthColumns(ctx context.Context) error {
	columns, err := tableColumns(ctx, store.db, "accounts")
	if err != nil {
		return fmt.Errorf("inspect account auth schema: %w", err)
	}
	// No CHECK clauses: SQLite restricts what ADD COLUMN accepts, and the
	// existing migrations in this package all use the plain form. The domains
	// of kind, disabled, and is_admin are enforced in Go instead.
	for _, migration := range []struct {
		name       string
		definition string
	}{
		{name: "kind", definition: "TEXT NOT NULL DEFAULT 'human'"},
		{name: "username_lower", definition: "TEXT NOT NULL DEFAULT ''"},
		{name: "password_hash", definition: "TEXT NOT NULL DEFAULT ''"},
		{name: "password_salt", definition: "TEXT NOT NULL DEFAULT ''"},
		{name: "password_algorithm", definition: "TEXT NOT NULL DEFAULT ''"},
		{name: "password_iterations", definition: "INTEGER NOT NULL DEFAULT 0"},
		{name: "password_updated_at_unix_ms", definition: "INTEGER NOT NULL DEFAULT 0"},
		{name: "disabled", definition: "INTEGER NOT NULL DEFAULT 0"},
		{name: "is_admin", definition: "INTEGER NOT NULL DEFAULT 0"},
		// The Discord snowflake, which is the identity; `discord` beside it holds
		// the handle, which is only its display form and which Discord lets people
		// change. Empty means this account has no linked identity.
		{name: "discord_user_id", definition: "TEXT NOT NULL DEFAULT ''"},
		{name: "discord_linked_at_unix_ms", definition: "INTEGER NOT NULL DEFAULT 0"},
	} {
		if columns[migration.name] {
			continue
		}
		statement := fmt.Sprintf(
			"ALTER TABLE accounts ADD COLUMN %s %s",
			migration.name,
			migration.definition,
		)
		if _, err := store.db.ExecContext(ctx, statement); err != nil {
			return fmt.Errorf("add account %s column: %w", migration.name, err)
		}
	}

	// The index has to come after the ALTER that creates its column, which is
	// why it is not in the main schema blob. Partial, so that the millions of
	// anonymous accounts sharing the name "Guest" stay legal while a claimed
	// name is exclusive.
	const indexes = `
CREATE UNIQUE INDEX IF NOT EXISTS accounts_username_lower_idx
    ON accounts(username_lower)
    WHERE username_lower <> '';

CREATE INDEX IF NOT EXISTS accounts_kind_idx ON accounts(kind, disabled);

-- Partial for the same reason the username index is: the great majority of
-- rows have no linked identity and must stay legal, while a claimed snowflake
-- is exclusive. This is what stops one Discord account holding two of ours.
CREATE UNIQUE INDEX IF NOT EXISTS accounts_discord_user_id_idx
    ON accounts(discord_user_id)
    WHERE discord_user_id <> '';

CREATE TABLE IF NOT EXISTS account_sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES accounts(user_id) ON DELETE CASCADE,
    created_at_unix_ms INTEGER NOT NULL,
    last_seen_at_unix_ms INTEGER NOT NULL,
    expires_at_unix_ms INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS account_sessions_user_idx
    ON account_sessions(user_id, expires_at_unix_ms DESC);
CREATE INDEX IF NOT EXISTS account_sessions_expiry_idx
    ON account_sessions(expires_at_unix_ms);
`
	if _, err := store.db.ExecContext(ctx, indexes); err != nil {
		return fmt.Errorf("migrate account auth schema: %w", err)
	}
	return nil
}

// AuthenticateAccount verifies a username and password.
//
// Every failure returns ErrInvalidCredentials, and an unknown username still
// pays the full derivation cost, so neither the response body nor the response
// time distinguishes "no such user" from "wrong password".
func (store *Store) AuthenticateAccount(
	ctx context.Context,
	username string,
	password string,
) (Account, error) {
	key := UsernameKey(username)
	var userID string
	var credential passwordCredential
	var kind string
	var disabled int
	err := store.db.QueryRowContext(ctx, `
SELECT user_id, kind, disabled, password_hash, password_salt, password_algorithm,
       password_iterations
FROM accounts
WHERE username_lower = ?
`, key).Scan(
		&userID, &kind, &disabled,
		&credential.hash, &credential.salt, &credential.algorithm, &credential.iterations,
	)
	if errors.Is(err, sql.ErrNoRows) {
		burnPasswordTime(password)
		return Account{}, ErrInvalidCredentials
	}
	if err != nil {
		return Account{}, fmt.Errorf("authenticate account: %w", err)
	}
	if kind != AccountKindHuman || !credential.isSet() {
		burnPasswordTime(password)
		return Account{}, ErrInvalidCredentials
	}
	if !verifyPassword(credential, password) {
		return Account{}, ErrInvalidCredentials
	}
	// Checked after the password so that a disabled account is not detectable
	// without knowing its password in the first place.
	if disabled != 0 {
		return Account{}, ErrAccountDisabled
	}
	return store.Account(ctx, userID)
}

// CreateSession issues a bearer token for an account and returns the plaintext
// exactly once. Only its SHA-256 is stored, so a copy of the database does not
// hand over live sessions.
func (store *Store) CreateSession(ctx context.Context, userID string) (string, error) {
	raw := make([]byte, sessionTokenBytes)
	if _, err := rand.Read(raw); err != nil {
		return "", fmt.Errorf("create session: %w", err)
	}
	token := SessionTokenPrefix + base64.RawURLEncoding.EncodeToString(raw)
	now := time.Now()
	_, err := store.db.ExecContext(ctx, `
INSERT INTO account_sessions (
    token_hash, user_id, created_at_unix_ms, last_seen_at_unix_ms, expires_at_unix_ms
) VALUES (?, ?, ?, ?, ?)
`,
		hashSessionToken(token), strings.TrimSpace(userID),
		now.UnixMilli(), now.UnixMilli(), now.Add(SessionLifetime).UnixMilli(),
	)
	if err != nil {
		return "", fmt.Errorf("create session: %w", err)
	}
	return token, nil
}

// SessionAccount resolves a bearer token to its account.
//
// A session token is 256 bits of randomness, so it is looked up by SHA-256
// equality rather than run through PBKDF2: there is nothing to brute-force,
// and a slow hash on every authenticated request would be a self-inflicted
// denial of service.
func (store *Store) SessionAccount(ctx context.Context, token string) (Account, error) {
	if !strings.HasPrefix(token, SessionTokenPrefix) {
		return Account{}, ErrSessionInvalid
	}
	hash := hashSessionToken(token)
	now := time.Now().UnixMilli()
	var userID string
	var expiresAt int64
	err := store.db.QueryRowContext(ctx, `
SELECT user_id, expires_at_unix_ms FROM account_sessions WHERE token_hash = ?
`, hash).Scan(&userID, &expiresAt)
	if errors.Is(err, sql.ErrNoRows) {
		return Account{}, ErrSessionInvalid
	}
	if err != nil {
		return Account{}, fmt.Errorf("read session: %w", err)
	}
	if expiresAt <= now {
		_, _ = store.db.ExecContext(ctx,
			`DELETE FROM account_sessions WHERE token_hash = ?`, hash)
		return Account{}, ErrSessionInvalid
	}
	account, err := store.Account(ctx, userID)
	if err != nil {
		return Account{}, err
	}
	if account.Disabled {
		return Account{}, ErrAccountDisabled
	}
	_, _ = store.db.ExecContext(ctx,
		`UPDATE account_sessions SET last_seen_at_unix_ms = ? WHERE token_hash = ?`, now, hash)
	return account, nil
}

// RevokeSession signs one token out. Unknown tokens are not an error: logging
// out twice is not a failure worth reporting.
func (store *Store) RevokeSession(ctx context.Context, token string) error {
	if _, err := store.db.ExecContext(ctx,
		`DELETE FROM account_sessions WHERE token_hash = ?`, hashSessionToken(token),
	); err != nil {
		return fmt.Errorf("revoke session: %w", err)
	}
	return nil
}

// RevokeAllSessions signs an account out everywhere, which is what a password
// change and an admin disable both need.
func (store *Store) RevokeAllSessions(ctx context.Context, userID string) error {
	if _, err := store.db.ExecContext(ctx,
		`DELETE FROM account_sessions WHERE user_id = ?`, strings.TrimSpace(userID),
	); err != nil {
		return fmt.Errorf("revoke sessions: %w", err)
	}
	return nil
}

// PurgeExpiredSessions drops rows nobody can use any more.
func (store *Store) PurgeExpiredSessions(ctx context.Context) error {
	if _, err := store.db.ExecContext(ctx,
		`DELETE FROM account_sessions WHERE expires_at_unix_ms <= ?`, time.Now().UnixMilli(),
	); err != nil {
		return fmt.Errorf("purge sessions: %w", err)
	}
	return nil
}

// SetAccountAdmin grants or revokes host privileges.
//
// It refuses to remove the last admin: an installation with no way in needs a
// database edit to recover, and that is a bad afternoon.
func (store *Store) SetAccountAdmin(ctx context.Context, userID string, admin bool) error {
	transaction, err := store.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("set admin: begin transaction: %w", err)
	}
	defer func() { _ = transaction.Rollback() }()

	if !admin {
		var remaining int
		if err := transaction.QueryRowContext(ctx, `
SELECT COUNT(*) FROM accounts WHERE is_admin = 1 AND disabled = 0 AND user_id <> ?
`, userID).Scan(&remaining); err != nil {
			return fmt.Errorf("set admin: count admins: %w", err)
		}
		if remaining == 0 {
			return errors.New("refusing to remove the last administrator")
		}
	}
	value := 0
	if admin {
		value = 1
	}
	result, err := transaction.ExecContext(ctx, `
UPDATE accounts SET is_admin = ?, updated_at_unix_ms = ? WHERE user_id = ? AND kind = ?
`, value, time.Now().UnixMilli(), strings.TrimSpace(userID), AccountKindHuman)
	if err != nil {
		return fmt.Errorf("set admin: %w", err)
	}
	if affected, _ := result.RowsAffected(); affected == 0 {
		return ErrAccountNotFound
	}
	return transaction.Commit()
}

// statementRunner is the part of *sql.DB and *sql.Tx that grantOwnerAdmin
// needs, so the same grant can run inside a claiming transaction or beside one.
type statementRunner interface {
	ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error)
}

// grantOwnerAdmin makes whoever claimed the owner handle an administrator.
//
// Called from both paths that write `username_lower` — registering and
// renaming — because a name is a claim wherever it is made, and a rule enforced
// on one of two doors is not enforced.
//
// It only ever grants. Renaming *away* from the owner handle deliberately
// leaves the flag alone: dropping it would turn an ordinary profile edit into a
// silent self-demotion, and revoking is what SetAccountAdmin is for. The write
// is also conditional on the account being a human with the name actually
// stored, so a bot row and a stale caller both come away with nothing.
func grantOwnerAdmin(
	ctx context.Context,
	runner statementRunner,
	userID string,
	username string,
) error {
	if !IsOwnerUsername(username) {
		return nil
	}
	if _, err := runner.ExecContext(ctx, `
UPDATE accounts SET is_admin = 1, updated_at_unix_ms = ?
WHERE user_id = ? AND kind = ? AND username_lower = ? AND is_admin = 0
`, time.Now().UnixMilli(), strings.TrimSpace(userID), AccountKindHuman,
		UsernameKey(username),
	); err != nil {
		return fmt.Errorf("grant owner admin: %w", err)
	}
	return nil
}

// ensureOwnerIsAdmin runs the same grant at startup, for the account that
// already holds the name.
//
// Without it the rule would only apply to a name claimed after this code
// shipped, and the owner of a live installation — who claimed it months ago —
// would be the one person it never reached.
func (store *Store) ensureOwnerIsAdmin(ctx context.Context) error {
	var userID string
	err := store.db.QueryRowContext(ctx,
		`SELECT user_id FROM accounts WHERE username_lower = ? AND kind = ?`,
		UsernameKey(OwnerUsername), AccountKindHuman,
	).Scan(&userID)
	if errors.Is(err, sql.ErrNoRows) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("find owner account: %w", err)
	}
	return grantOwnerAdmin(ctx, store.db, userID, OwnerUsername)
}

func hashSessionToken(token string) string {
	sum := sha256.Sum256([]byte(strings.TrimSpace(token)))
	return hex.EncodeToString(sum[:])
}
