package persistence

import (
	"errors"
	"strings"
	"testing"
)

// linkDiscordForTest writes the identity columns directly.
//
// No production path sets them yet — that arrives with the OAuth routes — and
// what these tests are about is whether the reads agree once the columns are
// set, not how they came to be set. Writing them here keeps the read-side
// tests independent of the write side, so a bug in one cannot mask a bug in
// the other.
func linkDiscordForTest(t *testing.T, store *Store, userID, discordUserID, handle string) {
	t.Helper()
	if _, err := store.db.ExecContext(t.Context(), `
UPDATE accounts SET discord_user_id = ?, discord = ?, discord_linked_at_unix_ms = 1
WHERE user_id = ?
`, discordUserID, handle, userID); err != nil {
		t.Fatalf("link discord for %s: %v", userID, err)
	}
}

// seedLegacyPasswordAccount creates the thing nothing can create any more: an
// account whose only credential is a password.
//
// RegisterAccount was the door that made these, and it is gone — no new
// password account may exist. But the ones already in the database still sign
// in, and that path has to stay covered until the last of them has linked a
// Discord account. So the tests build the fixture directly, which is the honest
// arrangement: a legacy state deserves a seeder that looks like one, rather than
// a production function kept alive purely to be called by tests.
func seedLegacyPasswordAccount(t *testing.T, store *Store, userID, username, password string) {
	t.Helper()
	credential, err := hashPassword(password)
	if err != nil {
		t.Fatalf("hash password for %s: %v", userID, err)
	}
	if _, err := store.db.ExecContext(t.Context(), `
UPDATE accounts
SET username = ?, username_lower = ?, password_hash = ?, password_salt = ?,
    password_algorithm = ?, password_iterations = ?, password_updated_at_unix_ms = 1,
    updated_at_unix_ms = 1
WHERE user_id = ?
`,
		username, UsernameKey(username), credential.hash, credential.salt,
		credential.algorithm, credential.iterations, userID,
	); err != nil {
		t.Fatalf("seed legacy password account %s: %v", userID, err)
	}
}

// legacyPasswordAccount is the whole fixture: an anonymous account upgraded the
// way registration used to upgrade it.
func legacyPasswordAccount(t *testing.T, store *Store, userID, username, password string) {
	t.Helper()
	anonymousAccount(t, store, userID, username)
	seedLegacyPasswordAccount(t, store, userID, username, password)
}

func anonymousAccount(t *testing.T, store *Store, userID, username string) {
	t.Helper()
	key := strings.Repeat(userID+"0", 64)[:64]
	if _, err := store.EnsureAccountWithProfileKey(t.Context(), userID, username, key); err != nil {
		t.Fatalf("create account %s: %v", userID, err)
	}
}

// An account that signs in with Discord has no password, and "registered" used
// to mean exactly "has a password" in four queries that did not share code.
//
// This is one test rather than four because the four used to disagree, and a
// disagreement is only visible when they are asked together. In particular
// nothing else in the suite would notice a missed leaderboard filter: the
// existing ladder tests all use password accounts, so they would keep passing
// while every Discord player silently vanished from the human board.
func TestADiscordOnlyAccountCountsAsRegisteredEverywhere(t *testing.T) {
	store := authTestStore(t)
	ctx := t.Context()

	const userID = "discord-only-user"
	const username = "Yuki"
	anonymousAccount(t, store, userID, username)
	linkDiscordForTest(t, store, userID, "80351110224678912", "yuki")
	seedRecord(t, store, userID, 1500, 4)

	account, err := store.Account(ctx, userID)
	if err != nil {
		t.Fatalf("read account: %v", err)
	}
	if !account.Registered {
		t.Error("Account.Registered is false for a Discord account; accountSelect still asks about passwords")
	}
	if !account.DiscordVerified {
		t.Error("Account.DiscordVerified is false for a linked account")
	}

	summaries, err := store.SearchAccounts(ctx, username, 10, 0)
	if err != nil {
		t.Fatalf("search accounts: %v", err)
	}
	if len(summaries) != 1 {
		t.Fatalf("search returned %d accounts, want 1", len(summaries))
	}
	if !summaries[0].Registered {
		t.Error("the admin list calls a Discord account unregistered; SearchAccounts keeps its own copy of the rule")
	}

	entries, err := store.Leaderboard(ctx, LeaderboardFilter{Kind: LeaderboardKindHuman})
	if err != nil {
		t.Fatalf("read leaderboard: %v", err)
	}
	found := false
	for _, entry := range entries {
		if entry.UserID == userID {
			found = true
		}
	}
	if !found {
		t.Errorf("a Discord account is missing from the human ladder; got %v", usernames(entries))
	}

	if _, _, err := store.MintBotToken(ctx, userID); err != nil {
		t.Errorf("a Discord account cannot own a bot: %v", err)
	}
}

// The mirror of the test above: widening "registered" must not accidentally
// promote the anonymous browser identity, which is the thing the rule exists to
// exclude in the first place.
func TestAnAnonymousAccountIsStillUnregisteredEverywhere(t *testing.T) {
	store := authTestStore(t)
	ctx := t.Context()

	const userID = "anonymous-user"
	anonymousAccount(t, store, userID, "Guest")
	seedRecord(t, store, userID, 1500, 4)

	account, err := store.Account(ctx, userID)
	if err != nil {
		t.Fatalf("read account: %v", err)
	}
	if account.Registered || account.DiscordVerified {
		t.Errorf("anonymous account reads registered=%v discordVerified=%v, want both false",
			account.Registered, account.DiscordVerified)
	}

	entries, err := store.Leaderboard(ctx, LeaderboardFilter{Kind: LeaderboardKindHuman})
	if err != nil {
		t.Fatalf("read leaderboard: %v", err)
	}
	for _, entry := range entries {
		if entry.UserID == userID {
			t.Error("an anonymous account reached the human ladder")
		}
	}

	if _, _, err := store.MintBotToken(ctx, userID); err == nil {
		t.Error("an anonymous account was allowed to own a bot")
	}
}

func TestOneDiscordAccountCannotHoldTwoPlayerAccounts(t *testing.T) {
	store := authTestStore(t)
	ctx := t.Context()
	const snowflake = "80351110224678912"

	anonymousAccount(t, store, "first", "First")
	if _, err := store.ClaimAccountWithDiscord(ctx, "first", "First", snowflake, "yuki"); err != nil {
		t.Fatalf("claim first: %v", err)
	}

	anonymousAccount(t, store, "second", "Second")
	_, err := store.ClaimAccountWithDiscord(ctx, "second", "Second", snowflake, "yuki")
	if !errors.Is(err, ErrIdentityAlreadyLinked) {
		t.Fatalf("a second account claimed the same Discord identity: %v", err)
	}
	// And the first account is untouched: a refused claim must not be a partial
	// one.
	account, err := store.Account(ctx, "first")
	if err != nil {
		t.Fatalf("read first: %v", err)
	}
	if account.Username != "First" || !account.DiscordVerified {
		t.Fatalf("the refused claim disturbed the account that holds the identity: %+v", account)
	}
}

func TestLinkingDiscordRetiresThePassword(t *testing.T) {
	store := authTestStore(t)
	ctx := t.Context()

	legacyPasswordAccount(t, store, "legacy", "Ada", authTestPassword)
	if _, err := store.AuthenticateAccount(ctx, "Ada", authTestPassword); err != nil {
		t.Fatalf("the fixture cannot sign in with its password: %v", err)
	}

	linked, err := store.LinkDiscordIdentity(ctx, "legacy", "80351110224678912", "ada")
	if err != nil {
		t.Fatalf("link: %v", err)
	}
	if !linked.DiscordVerified || linked.Discord != "ada" {
		t.Fatalf("link did not record the identity: %+v", linked)
	}
	if !linked.Registered {
		t.Fatal("an account that traded its password for an identity must stay registered")
	}
	// The whole point: the old door is closed, not merely unused.
	if _, err := store.AuthenticateAccount(ctx, "Ada", authTestPassword); !errors.Is(
		err, ErrInvalidCredentials,
	) {
		t.Fatalf("the password still works after linking: %v", err)
	}
	// The username survives. Linking is not a re-registration, and an account
	// that quietly renamed itself to the Discord handle would be a nasty
	// surprise for somebody who has worn a name for months.
	if linked.Username != "Ada" {
		t.Fatalf("linking renamed the account: %q", linked.Username)
	}
}

func TestLinkingTheSameIdentityTwiceSucceeds(t *testing.T) {
	store := authTestStore(t)
	ctx := t.Context()

	legacyPasswordAccount(t, store, "legacy", "Ada", authTestPassword)
	if _, err := store.LinkDiscordIdentity(ctx, "legacy", "8035111", "ada"); err != nil {
		t.Fatalf("first link: %v", err)
	}
	// A redelivered callback or a double-tapped button must not tell somebody
	// who is already finished that something went wrong.
	if _, err := store.LinkDiscordIdentity(ctx, "legacy", "8035111", "ada"); err != nil {
		t.Fatalf("relinking the same identity should be a no-op, got: %v", err)
	}
}

func TestClaimingRefusesAnAccountThatAlreadyHasAPassword(t *testing.T) {
	store := authTestStore(t)
	ctx := t.Context()

	legacyPasswordAccount(t, store, "legacy", "Ada", authTestPassword)
	// Claiming would overwrite the username of an established account, so the
	// two operations are kept apart: this one is LinkDiscordIdentity's job.
	_, err := store.ClaimAccountWithDiscord(ctx, "legacy", "Renamed", "8035111", "ada")
	if !errors.Is(err, ErrAlreadyRegistered) {
		t.Fatalf("claiming overwrote a password account: %v", err)
	}
}

func TestAFreshDiscordAccountIsSealedAgainstAdoption(t *testing.T) {
	store := authTestStore(t)
	ctx := t.Context()
	const attackerKey = "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"

	// No user ID: this is somebody with no local history to keep, so the
	// account is minted here rather than upgraded.
	created, err := store.ClaimAccountWithDiscord(ctx, "", "Yuki", "8035111", "yuki")
	if err != nil {
		t.Fatalf("claim without a local account: %v", err)
	}
	if created.UserID == "" {
		t.Fatal("minted account has no user ID")
	}
	// It has no browser behind it, so its profile key is a discarded random
	// one rather than empty. An empty hash is the "adopt me" marker, and this
	// account's user ID is as public as every other.
	if _, err := store.EnsureAccountWithProfileKey(
		ctx, created.UserID, "Guest", attackerKey,
	); !errors.Is(err, ErrInvalidProfileKey) {
		t.Fatalf("a minted Discord account was adoptable: %v", err)
	}
}

func TestAnonymizeClearsTheDiscordIdentity(t *testing.T) {
	store := authTestStore(t)
	ctx := t.Context()

	anonymousAccount(t, store, "leaver", "Yuki")
	if _, err := store.ClaimAccountWithDiscord(ctx, "leaver", "Yuki", "8035111", "yuki"); err != nil {
		t.Fatalf("claim: %v", err)
	}
	if _, err := store.AnonymizeAccount(ctx, "leaver"); err != nil {
		t.Fatalf("anonymize: %v", err)
	}
	// Nothing refers to this account, so it is deleted outright and the
	// identity is free again. The failure this guards against is the other
	// shape: a stripped row that still holds the snowflake, which would lock
	// that Discord user out of ever signing in again.
	if _, err := store.AccountForDiscordIdentity(ctx, "8035111"); !errors.Is(
		err, ErrAccountNotFound,
	) {
		t.Fatalf("the Discord identity survived anonymization: %v", err)
	}
}
