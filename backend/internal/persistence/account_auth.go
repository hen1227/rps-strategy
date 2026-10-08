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
// anonymous browser identity": it holds a credential of some kind — a password,
// or an identity from any provider.
//
// This used to be spelled as an emptiness test on `password_hash`, at four
// sites that did not share code, which is how they came to disagree — the human leaderboard filter
// and the admin badge each kept their own copy. Discord turned that from
// duplication into a bug: an account can be real without ever having had a
// password, so every copy that is not updated together starts answering a
// different question. Apple is the second provider of that kind, and the reason
// "an identity" is a lookup in `account_identities` rather than a column per
// provider.
//
// The alias is for queries that join `accounts` under a name. Pass "" when the
// columns are unqualified and the table is `accounts` itself.
func registeredSQL(alias string) string {
	return "(" + columnPrefix(alias) + "password_hash <> '' OR " + hasIdentitySQL(alias) + ")"
}

// hasIdentitySQL is "this account holds an identity from some provider". It is
// what decides who has a player page, and whether a device key still names a
// guest.
func hasIdentitySQL(alias string) string {
	return "EXISTS (SELECT 1 FROM account_identities linked WHERE linked.user_id = " +
		outerUserID(alias) + ")"
}

// discordVerifiedSQL is "Discord has vouched for this account", which is
// narrower than registeredSQL and narrower than hasIdentitySQL, and is still
// the question for everything that needs to reach the person on Discord:
// tournament entry, the weekend arena, the Discord Verified title, and the
// read-only handle. An Apple ID does not answer it.
func discordVerifiedSQL(alias string) string {
	return providerIdentitySQL(alias, ProviderDiscord)
}

// appleLinkedSQL is "this account signs in with Apple", for the admin browser
// and the analytics counts. Nothing a player can do is decided by it.
func appleLinkedSQL(alias string) string {
	return providerIdentitySQL(alias, ProviderApple)
}

// providerIdentitySQL is hasIdentitySQL narrowed to one provider. The provider
// is spliced in as a literal, so only the constants in account_identity.go may
// reach it; anything else answers false rather than reaching the query.
func providerIdentitySQL(alias string, provider string) string {
	if !knownProvider(provider) {
		return "0"
	}
	return "EXISTS (SELECT 1 FROM account_identities linked WHERE linked.user_id = " +
		outerUserID(alias) + " AND linked.provider = '" + provider + "')"
}

// awaitingIdentityLinkSQL is the *other* narrow question: an account that still
// has a password and has not linked an identity.
//
// Not the negation of registeredSQL, and not derivable from it — an account
// that signs in with Discord or Apple is registered with no password at all, so
// "not registered" and "still on a password" are different sets. This is the
// remainder of the password era: the accounts the link paths exist for, and the
// count that has to reach zero before those paths can be removed.
//
// A store review account has a password and no identity too, and is left out:
// it is on a password for good, and the link paths refuse it. Counting it here
// would keep the boot log from ever reaching zero, and would offer a password
// box to anybody who typed its name at the naming step. See store_review.go.
//
// It is a shared fragment for the same reason registeredSQL is. Two callers
// want it — the boot-time count and the naming step deciding whether to offer a
// password box — and this package has already been through what happens when a
// predicate about credentials is written out by hand at several sites. See
// registered_rule_test.go, which is what keeps both of these honest.
func awaitingIdentityLinkSQL(alias string) string {
	return "(" + columnPrefix(alias) + "password_hash <> '' AND NOT " + hasIdentitySQL(alias) +
		" AND NOT EXISTS (SELECT 1 FROM store_review_accounts review WHERE review.user_id = " +
		outerUserID(alias) + "))"
}

func columnPrefix(alias string) string {
	if alias == "" {
		return ""
	}
	return alias + "."
}

// outerUserID names the outer row's user_id from inside a subquery. Unqualified,
// it would bind to the subquery's own table — comparing account_identities with
// itself, which is true of every row — so an unaliased caller is taken to be
// reading `accounts` by name.
func outerUserID(alias string) string {
	if alias == "" {
		return "accounts.user_id"
	}
	return alias + ".user_id"
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
		// The Discord snowflake, from before identities had a table of their own.
		// Still written beside `account_identities` for one release, so that a
		// rolled-back build finds every Discord link where it looks, and nothing
		// else reads it. See account_identity.go. `discord` beside it holds the
		// handle, which is only the display form and stays where it is.
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
-- is exclusive. The primary key of account_identities is what enforces that
-- now; this stays while the column is written, so the two cannot disagree.
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
	} else {
		// Its password is written into two app store consoles and read by the
		// people reviewing there. See store_review.go.
		review, err := isStoreReviewAccount(ctx, transaction, userID)
		if err != nil {
			return fmt.Errorf("set admin: %w", err)
		}
		if review {
			return ErrStoreReviewAdmin
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
