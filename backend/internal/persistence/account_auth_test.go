package persistence

import (
	"database/sql"
	"errors"
	"path/filepath"
	"testing"

	"rps-strategy/backend/internal/game"
)

// Registering and logging in derive a password hash each, so the tests run at
// a cost nobody is measuring. Verification reads the count back from the row,
// so this changes speed and nothing else.
func init() {
	passwordIterations = 2
}

const authTestPassword = "correct horse battery"

func authTestStore(t *testing.T) *Store {
	t.Helper()
	store, err := Open(":memory:")
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })
	return store
}

func TestClaimingWithDiscordUpgradesAnAnonymousAccountInPlace(t *testing.T) {
	store := authTestStore(t)
	ctx := t.Context()

	before, err := store.EnsureAccountWithProfileKey(ctx, "player-1", "Scrappy", testProfileKey)
	if err != nil {
		t.Fatalf("create anonymous account: %v", err)
	}
	// Give the account a history worth keeping, so "in place" is a claim the
	// test can actually check rather than a hope.
	if _, err := store.db.ExecContext(ctx, `
INSERT INTO account_mode_ratings (user_id, mode_id, elo, created_at_unix_ms, updated_at_unix_ms)
VALUES (?, ?, ?, ?, ?)
`, "player-1", game.ModeTotalWar, 1437, 1, 1); err != nil {
		t.Fatalf("seed mode rating: %v", err)
	}

	after, err := store.ClaimAccountWithDiscord(
		ctx, "player-1", "Scrappy", "80351110224678912", "scrappy",
	)
	if err != nil {
		t.Fatalf("claim: %v", err)
	}
	if after.UserID != before.UserID {
		t.Fatalf("user ID changed on claiming: %q -> %q", before.UserID, after.UserID)
	}
	if !after.Registered {
		t.Fatal("account should report itself registered")
	}
	if !after.DiscordVerified || after.Discord != "scrappy" {
		t.Fatalf("verified handle not stored: %+v", after)
	}
	if rating := after.ModeRatings[game.ModeTotalWar]; rating.Elo != 1437 {
		t.Fatalf("mode rating lost on claiming: %#v", after.ModeRatings)
	}
	// The browser this account was claimed from keeps its key: claiming is an
	// upgrade of that identity, not a migration to somewhere else.
	if _, err := store.EnsureAccountWithProfileKey(ctx, "player-1", "Guest", testProfileKey); err != nil {
		t.Fatalf("profile key stopped working after claiming: %v", err)
	}
}

// The regression for the takeover hole: every user ID in this database is
// public, so an account with no profile key must not be adoptable by whoever
// asks first unless it is genuinely an unclaimed anonymous one.
func TestProfileKeyCannotClaimBotOrRegisteredAccount(t *testing.T) {
	store := authTestStore(t)
	ctx := t.Context()
	const attackerKey = "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"

	legacyPasswordAccount(t, store, "victim", "Victim", authTestPassword)
	// Simulate the dangerous shape directly: a registered row whose profile key
	// has been cleared. Before the guard, the next key to arrive won the account.
	if _, err := store.db.ExecContext(ctx,
		`UPDATE accounts SET profile_key_hash = '' WHERE user_id = 'victim'`); err != nil {
		t.Fatalf("clear profile key: %v", err)
	}
	if _, err := store.EnsureAccountWithProfileKey(ctx, "victim", "Guest", attackerKey); !errors.Is(err, ErrInvalidProfileKey) {
		t.Fatalf("a password account was claimable with an arbitrary key: %v", err)
	}

	// And the same for a Discord account, which is the shape that matters most
	// now: it has no browser behind it at all, so an empty profile key is its
	// natural state rather than an accident.
	anonymousAccount(t, store, "discord-victim", "Yuki")
	if _, err := store.ClaimAccountWithDiscord(
		ctx, "discord-victim", "Yuki", "80351110224678912", "yuki",
	); err != nil {
		t.Fatalf("claim discord account: %v", err)
	}
	if _, err := store.db.ExecContext(ctx,
		`UPDATE accounts SET profile_key_hash = '' WHERE user_id = 'discord-victim'`); err != nil {
		t.Fatalf("clear profile key: %v", err)
	}
	if _, err := store.EnsureAccountWithProfileKey(
		ctx, "discord-victim", "Guest", attackerKey,
	); !errors.Is(err, ErrInvalidProfileKey) {
		t.Fatalf("a Discord account was claimable with an arbitrary key: %v", err)
	}

	// The same must hold for a bot account, which is the case that matters
	// most: a bot's user ID is printed in every live-game row and PGN tag.
	if _, err := store.db.ExecContext(ctx, `
INSERT INTO accounts (user_id, kind, username, discord, profile_key_hash, elo,
                      created_at_unix_ms, updated_at_unix_ms)
VALUES ('bot-1', 'bot', 'MyBot', '', '', 1200, 0, 0)
`); err != nil {
		t.Fatalf("insert bot account: %v", err)
	}
	if _, err := store.EnsureAccountWithProfileKey(ctx, "bot-1", "Guest", attackerKey); !errors.Is(err, ErrInvalidProfileKey) {
		t.Fatalf("a bot account was claimable with an arbitrary key: %v", err)
	}
	if _, err := store.UpdateAccountProfile(ctx, "bot-1", "Stolen", "someone#1"); !errors.Is(err, ErrNotRegistered) {
		t.Fatalf("a bot account was renameable through the profile route: %v", err)
	}
}

func TestAnonymousAccountsMayStillShareADisplayName(t *testing.T) {
	store := authTestStore(t)
	ctx := t.Context()
	const otherKey = "abababababababababababababababababababababababababababababababab"

	// Two strangers both called Guest is the normal state of the world, and
	// the partial unique index exists so that stays true.
	if _, err := store.EnsureAccountWithProfileKey(ctx, "anon-1", "Twin", testProfileKey); err != nil {
		t.Fatalf("first anonymous account: %v", err)
	}
	if _, err := store.EnsureAccountWithProfileKey(ctx, "anon-2", "Twin", otherKey); err != nil {
		t.Fatalf("second anonymous account with the same name: %v", err)
	}

	// A claimed name, though, is exclusive.
	if _, err := store.ClaimAccountWithDiscord(
		ctx, "anon-1", "Twin", "discord-anon-1", "twin",
	); err != nil {
		t.Fatalf("claim first: %v", err)
	}
	_, err := store.ClaimAccountWithDiscord(ctx, "anon-2", "TWIN", "discord-anon-2", "twin2")
	if !errors.Is(err, ErrUsernameTaken) {
		t.Fatalf("a claimed name must be exclusive regardless of case, got %v", err)
	}
}

func TestLoginRejectsWrongPasswordAndUnknownUser(t *testing.T) {
	store := authTestStore(t)
	ctx := t.Context()

	legacyPasswordAccount(t, store, "player-1", "Ada", authTestPassword)

	account, err := store.AuthenticateAccount(ctx, "ADA", authTestPassword)
	if err != nil {
		t.Fatalf("login should be case-insensitive on the username: %v", err)
	}
	if account.UserID != "player-1" {
		t.Fatalf("logged into the wrong account: %q", account.UserID)
	}
	// Both failures must be the same error, so a caller cannot tell a wrong
	// password from a username that does not exist.
	if _, err := store.AuthenticateAccount(ctx, "Ada", "wrong password here"); !errors.Is(err, ErrInvalidCredentials) {
		t.Fatalf("wrong password: %v", err)
	}
	if _, err := store.AuthenticateAccount(ctx, "nobody", authTestPassword); !errors.Is(err, ErrInvalidCredentials) {
		t.Fatalf("unknown user: %v", err)
	}
}

func TestSessionsResolveExpireAndRevoke(t *testing.T) {
	store := authTestStore(t)
	ctx := t.Context()

	anonymousAccount(t, store, "player-1", "Ada")
	if _, err := store.ClaimAccountWithDiscord(
		ctx, "player-1", "Ada", "80351110224678912", "ada",
	); err != nil {
		t.Fatalf("claim: %v", err)
	}

	token, err := store.CreateSession(ctx, "player-1")
	if err != nil {
		t.Fatalf("create session: %v", err)
	}
	account, err := store.SessionAccount(ctx, token)
	if err != nil {
		t.Fatalf("resolve session: %v", err)
	}
	if account.UserID != "player-1" {
		t.Fatalf("session resolved to %q", account.UserID)
	}
	// The plaintext must not be recoverable from the database.
	var stored string
	if err := store.db.QueryRowContext(ctx,
		`SELECT token_hash FROM account_sessions WHERE user_id = 'player-1'`).Scan(&stored); err != nil {
		t.Fatalf("read session row: %v", err)
	}
	if stored == token {
		t.Fatal("session tokens must be stored hashed")
	}

	if err := store.RevokeSession(ctx, token); err != nil {
		t.Fatalf("revoke: %v", err)
	}
	if _, err := store.SessionAccount(ctx, token); !errors.Is(err, ErrSessionInvalid) {
		t.Fatalf("revoked session still resolves: %v", err)
	}

	expired, err := store.CreateSession(ctx, "player-1")
	if err != nil {
		t.Fatalf("create session: %v", err)
	}
	if _, err := store.db.ExecContext(ctx,
		`UPDATE account_sessions SET expires_at_unix_ms = 1`); err != nil {
		t.Fatalf("expire session: %v", err)
	}
	if _, err := store.SessionAccount(ctx, expired); !errors.Is(err, ErrSessionInvalid) {
		t.Fatalf("expired session still resolves: %v", err)
	}
	if _, err := store.SessionAccount(ctx, "not-even-a-token"); !errors.Is(err, ErrSessionInvalid) {
		t.Fatalf("garbage token: %v", err)
	}
}

func TestDisabledAccountCannotLogInOrConnect(t *testing.T) {
	store := authTestStore(t)
	ctx := t.Context()

	legacyPasswordAccount(t, store, "player-1", "Ada", authTestPassword)
	if _, err := store.db.ExecContext(ctx,
		`UPDATE accounts SET disabled = 1 WHERE user_id = 'player-1'`); err != nil {
		t.Fatalf("disable: %v", err)
	}

	if _, err := store.AuthenticateAccount(ctx, "Ada", authTestPassword); !errors.Is(err, ErrAccountDisabled) {
		t.Fatalf("disabled account logged in: %v", err)
	}
	// Disabling has to close the browser-key door too, or it only stops the
	// half of the players who registered.
	if _, err := store.EnsureAccountWithProfileKey(ctx, "player-1", "Guest", testProfileKey); !errors.Is(err, ErrAccountDisabled) {
		t.Fatalf("disabled account still connects: %v", err)
	}
}

func TestSetAccountAdminRefusesToRemoveTheLastAdministrator(t *testing.T) {
	store := authTestStore(t)
	ctx := t.Context()

	if _, err := store.EnsureAccountWithProfileKey(ctx, "boss", "Boss", testProfileKey); err != nil {
		t.Fatalf("create account: %v", err)
	}
	if err := store.SetAccountAdmin(ctx, "boss", true); err != nil {
		t.Fatalf("grant admin: %v", err)
	}
	if err := store.SetAccountAdmin(ctx, "boss", false); err == nil {
		t.Fatal("removing the only administrator must be refused")
	}
	account, err := store.Account(ctx, "boss")
	if err != nil {
		t.Fatalf("read account: %v", err)
	}
	if !account.IsAdmin {
		t.Fatal("the refused demotion must not have taken effect")
	}
}

// A database created before this feature existed must survive the upgrade with
// every account intact and still usable.
func TestAccountAuthMigrationAddsColumnsToExistingDatabase(t *testing.T) {
	path := filepath.Join(t.TempDir(), "legacy.sqlite")
	legacy, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatalf("open legacy database: %v", err)
	}
	if _, err := legacy.Exec(`
CREATE TABLE accounts (
    user_id TEXT PRIMARY KEY,
    username TEXT NOT NULL,
    discord TEXT NOT NULL DEFAULT '',
    profile_key_hash TEXT NOT NULL DEFAULT '',
    elo INTEGER NOT NULL DEFAULT 1200,
    wins INTEGER NOT NULL DEFAULT 0,
    losses INTEGER NOT NULL DEFAULT 0,
    draws INTEGER NOT NULL DEFAULT 0,
    games_played INTEGER NOT NULL DEFAULT 0,
    created_at_unix_ms INTEGER NOT NULL,
    updated_at_unix_ms INTEGER NOT NULL
);
INSERT INTO accounts (user_id, username, elo, wins, created_at_unix_ms, updated_at_unix_ms)
VALUES ('veteran', 'Veteran', 1550, 12, 1, 2);
`); err != nil {
		t.Fatalf("create legacy schema: %v", err)
	}
	if err := legacy.Close(); err != nil {
		t.Fatalf("close legacy database: %v", err)
	}

	store, err := Open(path)
	if err != nil {
		t.Fatalf("migrate: %v", err)
	}
	defer func() { _ = store.Close() }()

	account, err := store.Account(t.Context(), "veteran")
	if err != nil {
		t.Fatalf("read migrated account: %v", err)
	}
	if account.Elo != 1550 || account.Wins != 12 {
		t.Fatalf("migration lost account data: %#v", account)
	}
	if account.Kind != AccountKindHuman {
		t.Fatalf("existing accounts must migrate as human, got %q", account.Kind)
	}
	if account.Registered || account.IsAdmin || account.Disabled {
		t.Fatalf("existing accounts must migrate unregistered and unprivileged: %#v", account)
	}
	// An account whose key was never claimed must still be claimable — this is
	// the ordinary pre-key upgrade path and the guard must not have broken it.
	if _, err := store.EnsureAccountWithProfileKey(
		t.Context(), "veteran", "Veteran", testProfileKey,
	); err != nil {
		t.Fatalf("a legacy pre-key account must still be claimable: %v", err)
	}
}
