package persistence

import (
	"errors"
	"path/filepath"
	"strings"
	"testing"
)

// linkDiscordForTest writes a Discord link directly, both places it is kept.
//
// What these tests are about is whether the reads agree once an account is
// linked, not how it came to be linked. Writing the rows here keeps the
// read-side tests independent of the write side, so a bug in one cannot mask a
// bug in the other. Both the table and the old columns, because that is the
// state every link is in while the columns are still written — see the note at
// the top of account_identity.go.
func linkDiscordForTest(t *testing.T, store *Store, userID, discordUserID, handle string) {
	t.Helper()
	if _, err := store.db.ExecContext(t.Context(), `
UPDATE accounts SET discord_user_id = ?, discord = ?, discord_linked_at_unix_ms = 1
WHERE user_id = ?
`, discordUserID, handle, userID); err != nil {
		t.Fatalf("link discord for %s: %v", userID, err)
	}
	if _, err := store.db.ExecContext(t.Context(), `
INSERT INTO account_identities (provider, subject, user_id, linked_at_unix_ms)
VALUES ('discord', ?, ?, 1)
`, discordUserID, userID); err != nil {
		t.Fatalf("link discord identity for %s: %v", userID, err)
	}
}

// seedLegacyPasswordAccount creates the thing nothing can create any more: an
// account whose only credential is a password.
//
// RegisterAccount was the door that made these, and it is gone — no player may
// get a new password account. (Store review accounts are the one exception, and
// they cannot stand in for a legacy one: the link paths refuse them.) But the
// ones already in the database still sign in, and that path has to stay covered
// until the last of them has linked a Discord account. So the tests build the
// fixture directly, which is the honest arrangement: a legacy state deserves a
// seeder that looks like one, rather than a production function kept alive
// purely to be called by tests.
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

	page, err := store.SearchAccounts(ctx, AccountFilter{Query: username})
	if err != nil {
		t.Fatalf("search accounts: %v", err)
	}
	if len(page.Accounts) != 1 {
		t.Fatalf("search returned %d accounts, want 1", len(page.Accounts))
	}
	if !page.Accounts[0].Registered {
		t.Error("the admin list calls a Discord account unregistered; SearchAccounts keeps its own copy of the rule")
	}
	// The narrower of the two flags, and the one the browser filters on: a
	// linked account is registered *and* verified, and a password account is
	// only the first.
	if !page.Accounts[0].DiscordVerified {
		t.Error("AccountSummary.DiscordVerified is false for a linked account")
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
	if _, err := store.ClaimAccountWithIdentity(ctx, "first", "First", DiscordIdentity(snowflake, "yuki")); err != nil {
		t.Fatalf("claim first: %v", err)
	}

	anonymousAccount(t, store, "second", "Second")
	_, err := store.ClaimAccountWithIdentity(ctx, "second", "Second", DiscordIdentity(snowflake, "yuki"))
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

	linked, err := store.LinkIdentity(ctx, "legacy", DiscordIdentity("80351110224678912", "ada"))
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
	if _, err := store.LinkIdentity(ctx, "legacy", DiscordIdentity("8035111", "ada")); err != nil {
		t.Fatalf("first link: %v", err)
	}
	// A redelivered callback or a double-tapped button must not tell somebody
	// who is already finished that something went wrong.
	if _, err := store.LinkIdentity(ctx, "legacy", DiscordIdentity("8035111", "ada")); err != nil {
		t.Fatalf("relinking the same identity should be a no-op, got: %v", err)
	}
}

func TestClaimingRefusesAnAccountThatAlreadyHasAPassword(t *testing.T) {
	store := authTestStore(t)
	ctx := t.Context()

	legacyPasswordAccount(t, store, "legacy", "Ada", authTestPassword)
	// Claiming would overwrite the username of an established account, so the
	// two operations are kept apart: this one is LinkDiscordIdentity's job.
	_, err := store.ClaimAccountWithIdentity(ctx, "legacy", "Renamed", DiscordIdentity("8035111", "ada"))
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
	created, err := store.ClaimAccountWithIdentity(ctx, "", "Yuki", DiscordIdentity("8035111", "yuki"))
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
	if _, err := store.ClaimAccountWithIdentity(ctx, "leaver", "Yuki", DiscordIdentity("8035111", "yuki")); err != nil {
		t.Fatalf("claim: %v", err)
	}
	if _, err := store.AnonymizeAccount(ctx, "leaver"); err != nil {
		t.Fatalf("anonymize: %v", err)
	}
	// Nothing refers to this account, so it is deleted outright and the
	// identity is free again. The failure this guards against is the other
	// shape: a stripped row that still holds the snowflake, which would lock
	// that Discord user out of ever signing in again.
	if _, err := store.AccountForIdentity(ctx, ProviderDiscord, "8035111"); !errors.Is(
		err, ErrAccountNotFound,
	) {
		t.Fatalf("the Discord identity survived anonymization: %v", err)
	}
}

// The path the naming step needs: a legacy account holder, with no session,
// proving which account is theirs with the password they already have.
func TestLinkingWithAPasswordFindsTheAccountAndKeepsIt(t *testing.T) {
	store := authTestStore(t)
	ctx := t.Context()

	legacyPasswordAccount(t, store, "legacy", "Ada", authTestPassword)

	linked, err := store.LinkIdentityWithPassword(
		ctx, "Ada", authTestPassword, DiscordIdentity("80351110224678912", "yuki"),
	)
	if err != nil {
		t.Fatalf("link with password: %v", err)
	}
	// The account they already had, not a new one beside it.
	if linked.UserID != "legacy" {
		t.Fatalf("linking landed on a different account: %q", linked.UserID)
	}
	if linked.Username != "Ada" {
		t.Fatalf("linking renamed the account: %q", linked.Username)
	}
	if !linked.DiscordVerified {
		t.Fatalf("linking did not record the identity: %+v", linked)
	}
	// Same trade LinkDiscordIdentity makes: the password is spent, not kept.
	if _, err := store.AuthenticateAccount(ctx, "Ada", authTestPassword); !errors.Is(
		err, ErrInvalidCredentials,
	) {
		t.Fatalf("the password still works after linking: %v", err)
	}
}

// The username is not the proof. Somebody who knows a name — and every name is
// on the leaderboard — must not be able to attach their Discord to it.
func TestLinkingWithAPasswordRefusesTheWrongPassword(t *testing.T) {
	store := authTestStore(t)
	ctx := t.Context()

	legacyPasswordAccount(t, store, "legacy", "Ada", authTestPassword)

	_, err := store.LinkIdentityWithPassword(
		ctx, "Ada", "not-"+authTestPassword, DiscordIdentity("80351110224678912", "yuki"),
	)
	if !errors.Is(err, ErrInvalidCredentials) {
		t.Fatalf("a wrong password linked an identity: %v", err)
	}
	account, err := store.Account(ctx, "legacy")
	if err != nil {
		t.Fatal(err)
	}
	if account.DiscordVerified {
		t.Fatal("a refused attempt still wrote the identity")
	}
}

// An account that already signs in with Discord has no password left, so this
// door cannot be used to take one over.
func TestLinkingWithAPasswordCannotReachADiscordAccount(t *testing.T) {
	store := authTestStore(t)
	ctx := t.Context()

	legacyPasswordAccount(t, store, "legacy", "Ada", authTestPassword)
	if _, err := store.LinkIdentity(ctx, "legacy", DiscordIdentity("111", "ada")); err != nil {
		t.Fatalf("first link: %v", err)
	}

	_, err := store.LinkIdentityWithPassword(
		ctx, "Ada", authTestPassword, DiscordIdentity("222", "someone-else"),
	)
	if !errors.Is(err, ErrInvalidCredentials) {
		t.Fatalf("a linked account was reachable by password: %v", err)
	}
}

// UsernameCanLinkWithPassword decides whether the naming step offers a password
// box, so the three answers it can give are worth pinning down together.
func TestUsernameCanLinkWithPasswordOnlyForLegacyAccounts(t *testing.T) {
	store := authTestStore(t)
	ctx := t.Context()

	legacyPasswordAccount(t, store, "legacy", "Ada", authTestPassword)
	legacyPasswordAccount(t, store, "moved-on", "Bex", authTestPassword)
	if _, err := store.LinkIdentity(ctx, "moved-on", DiscordIdentity("111", "bex")); err != nil {
		t.Fatalf("link Bex: %v", err)
	}
	anonymousAccount(t, store, "guest", "Guest")

	for _, probe := range []struct {
		username string
		want     bool
		why      string
	}{
		{username: "Ada", want: true, why: "a legacy password account is the whole point"},
		{username: "ada", want: true, why: "names are matched case-insensitively"},
		{username: "Bex", want: false, why: "already signs in with Discord: no password to offer"},
		{username: "Guest", want: false, why: "an anonymous account holds no name to claim"},
		{username: "Nobody", want: false, why: "a free name is claimed, not linked"},
	} {
		got, err := store.UsernameCanLinkWithPassword(ctx, probe.username)
		if err != nil {
			t.Fatalf("probe %q: %v", probe.username, err)
		}
		if got != probe.want {
			t.Errorf("%q: got %v, want %v — %s", probe.username, got, probe.want, probe.why)
		}
	}
}

// A disabled account must not be linkable, or a ban is one Discord sign-in away
// from being undone.
func TestLinkingWithAPasswordRefusesADisabledAccount(t *testing.T) {
	store := authTestStore(t)
	ctx := t.Context()

	legacyPasswordAccount(t, store, "legacy", "Ada", authTestPassword)
	if err := store.SetAccountDisabled(ctx, "legacy", true); err != nil {
		t.Fatalf("disable: %v", err)
	}

	if _, err := store.LinkIdentityWithPassword(
		ctx, "Ada", authTestPassword, DiscordIdentity("111", "ada"),
	); !errors.Is(err, ErrAccountDisabled) {
		t.Fatalf("a disabled account was linked: %v", err)
	}
	offered, err := store.UsernameCanLinkWithPassword(ctx, "Ada")
	if err != nil {
		t.Fatal(err)
	}
	if offered {
		t.Fatal("a disabled account was offered a password box")
	}
}

const (
	testAppleSubject  = "001234.0123456789abcdef0123456789abcdef.0123"
	testAppleClientID = "com.henhen1227.rps-strategy"
)

// An account made with Apple is as much an account as one made with Discord:
// registered, on the human ladder, with a page and a bot of its own. It is not
// Discord-verified, which is about being reachable on Discord rather than about
// being real, and an Apple ID does not answer it.
func TestAnAppleOnlyAccountCountsAsRegisteredEverywhere(t *testing.T) {
	store := authTestStore(t)
	ctx := t.Context()

	const userID = "apple-only-user"
	anonymousAccount(t, store, userID, "Guest")
	if _, err := store.ClaimAccountWithIdentity(
		ctx, userID, "Orchard", AppleIdentity(testAppleSubject, "", ""),
	); err != nil {
		t.Fatalf("claim with apple: %v", err)
	}
	seedRecord(t, store, userID, 1500, 4)

	account, err := store.Account(ctx, userID)
	if err != nil {
		t.Fatalf("read account: %v", err)
	}
	if !account.Registered {
		t.Error("an Apple account reads as unregistered")
	}
	if account.DiscordVerified {
		t.Error("an Apple account reads as Discord-verified")
	}
	if account.Discord != "" {
		t.Errorf("an Apple sign-in wrote a Discord handle: %q", account.Discord)
	}

	page, err := store.SearchAccounts(ctx, AccountFilter{Query: "Orchard"})
	if err != nil || len(page.Accounts) != 1 {
		t.Fatalf("search accounts: %v %+v", err, page)
	}
	if summary := page.Accounts[0]; !summary.Registered || summary.DiscordVerified || !summary.AppleLinked {
		t.Errorf("the admin list reads an Apple account wrong: %+v", summary)
	}
	apple := true
	if filtered, err := store.SearchAccounts(ctx, AccountFilter{AppleLinked: &apple}); err != nil ||
		filtered.Total != 1 {
		t.Errorf("the Apple filter found %d accounts, want 1: %v", filtered.Total, err)
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
		t.Errorf("an Apple account is missing from the human ladder; got %v", usernames(entries))
	}

	if _, err := store.PublicProfile(ctx, "Orchard", 5); err != nil {
		t.Errorf("an Apple account has no player page: %v", err)
	}
	listed, err := store.PublicProfiles(ctx, "orch", 10, 0)
	if err != nil || len(listed) != 1 {
		t.Errorf("the directory does not list an Apple account: %v %+v", err, listed)
	}

	if _, _, err := store.MintBotToken(ctx, userID); err != nil {
		t.Errorf("an Apple account cannot own a bot: %v", err)
	}
	earned, err := store.earnedTitles(ctx, userID)
	if err != nil {
		t.Fatal(err)
	}
	for _, title := range earned {
		if title == TitleDiscordVerified {
			t.Error("an Apple account earned Discord Verified")
		}
	}

	methods, err := store.SignInMethods(ctx, userID)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Join(methods.Methods, ",") != "apple" || methods.AwaitingLink || !methods.CanLink {
		t.Errorf("sign-in methods: %+v", methods)
	}
}

// The reason linking is written once: a player who signed up with Apple on the
// phone adds Discord on the website, and the other way round, and ends up with
// one account that either opens.
func TestAppleAndDiscordLinkToOneAccount(t *testing.T) {
	store := authTestStore(t)
	ctx := t.Context()

	anonymousAccount(t, store, "player", "Guest")
	if _, err := store.ClaimAccountWithIdentity(
		ctx, "player", "Yuki", AppleIdentity(testAppleSubject, "", ""),
	); err != nil {
		t.Fatalf("claim with apple: %v", err)
	}
	linked, err := store.LinkIdentity(ctx, "player", DiscordIdentity("80351110224678912", "yuki"))
	if err != nil {
		t.Fatalf("link discord: %v", err)
	}
	if !linked.DiscordVerified || linked.Discord != "yuki" || linked.Username != "Yuki" {
		t.Fatalf("adding Discord did not land on the account: %+v", linked)
	}

	for _, probe := range []struct{ provider, subject string }{
		{ProviderApple, testAppleSubject},
		{ProviderDiscord, "80351110224678912"},
	} {
		account, err := store.AccountForIdentity(ctx, probe.provider, probe.subject)
		if err != nil || account.UserID != "player" {
			t.Errorf("%s opens %q, want the one account: %v", probe.provider, account.UserID, err)
		}
	}
	methods, err := store.SignInMethods(ctx, "player")
	if err != nil {
		t.Fatal(err)
	}
	if strings.Join(methods.Methods, ",") != "discord,apple" {
		t.Errorf("methods are %v, want both in the listed order", methods.Methods)
	}
}

// One identity per provider per account. A second Apple ID would make "which
// Apple ID is this account" a question with two answers.
func TestAnAccountHoldsOneIdentityPerProvider(t *testing.T) {
	store := authTestStore(t)
	ctx := t.Context()

	anonymousAccount(t, store, "player", "Guest")
	if _, err := store.ClaimAccountWithIdentity(
		ctx, "player", "Yuki", AppleIdentity(testAppleSubject, "", ""),
	); err != nil {
		t.Fatal(err)
	}
	_, err := store.LinkIdentity(ctx, "player", AppleIdentity("000999.other.0001", "", ""))
	if !errors.Is(err, ErrIdentityAlreadyLinked) {
		t.Fatalf("a second Apple ID was linked: %v", err)
	}
	if !strings.Contains(err.Error(), "different Apple ID") {
		t.Errorf("the refusal does not say which: %q", err)
	}
}

// The refusal a player reads names what they pressed, so somebody with two
// sign-ins is not left guessing which one was meant.
func TestAnIdentityHeldElsewhereIsRefusedByName(t *testing.T) {
	store := authTestStore(t)
	ctx := t.Context()

	anonymousAccount(t, store, "first", "Guest")
	if _, err := store.ClaimAccountWithIdentity(
		ctx, "first", "First", AppleIdentity(testAppleSubject, "", ""),
	); err != nil {
		t.Fatal(err)
	}
	legacyPasswordAccount(t, store, "second", "Second", authTestPassword)

	_, err := store.LinkIdentity(ctx, "second", AppleIdentity(testAppleSubject, "", ""))
	if !errors.Is(err, ErrIdentityAlreadyLinked) {
		t.Fatalf("an Apple ID held by another account was linked: %v", err)
	}
	if !strings.Contains(err.Error(), "that Apple ID is already linked") {
		t.Errorf("the refusal does not name the Apple ID: %q", err)
	}
	// And the refused account is untouched: the password is still its way in.
	if _, err := store.AuthenticateAccount(ctx, "Second", authTestPassword); err != nil {
		t.Errorf("a refused link took the password anyway: %v", err)
	}
}

// A naming step sent twice — a double-tap, a retried request — must not rename
// the account the first one made.
func TestClaimingTheSameIdentityAgainChangesNothing(t *testing.T) {
	store := authTestStore(t)
	ctx := t.Context()

	anonymousAccount(t, store, "player", "Guest")
	first, err := store.ClaimAccountWithIdentity(
		ctx, "player", "Yuki", AppleIdentity(testAppleSubject, "", ""),
	)
	if err != nil {
		t.Fatal(err)
	}
	again, err := store.ClaimAccountWithIdentity(
		ctx, "player", "Someone", AppleIdentity(testAppleSubject, "", ""),
	)
	if err != nil {
		t.Fatalf("the repeated claim was refused: %v", err)
	}
	if again.Username != first.Username {
		t.Fatalf("the repeated claim renamed the account to %q", again.Username)
	}
}

// A device key proves a guest. AccountHoldsIdentity is what tells the sign-in
// routes that the key in hand no longer does.
func TestAccountHoldsIdentityTellsAGuestFromAnUpgradedAccount(t *testing.T) {
	store := authTestStore(t)
	ctx := t.Context()

	anonymousAccount(t, store, "guest", "Guest")
	anonymousAccount(t, store, "upgraded", "Guest")
	if _, err := store.ClaimAccountWithIdentity(
		ctx, "upgraded", "Yuki", AppleIdentity(testAppleSubject, "", ""),
	); err != nil {
		t.Fatal(err)
	}
	legacyPasswordAccount(t, store, "legacy", "Ada", authTestPassword)

	for userID, want := range map[string]bool{"guest": false, "upgraded": true, "legacy": false} {
		got, err := store.AccountHoldsIdentity(ctx, userID)
		if err != nil || got != want {
			t.Errorf("%s: got %v (%v), want %v", userID, got, err, want)
		}
	}
	if _, err := store.AccountHoldsIdentity(ctx, "nobody"); !errors.Is(err, ErrAccountNotFound) {
		t.Errorf("an unknown account: %v", err)
	}
}

// A returning sign-in brings a new refresh token, and the newest is the one
// worth revoking with: Apple may have retired the older ones.
func TestARefreshTokenIsKeptAndReplaced(t *testing.T) {
	store := authTestStore(t)
	ctx := t.Context()

	anonymousAccount(t, store, "player", "Guest")
	if _, err := store.ClaimAccountWithIdentity(
		ctx, "player", "Yuki", AppleIdentity(testAppleSubject, "first-token", testAppleClientID),
	); err != nil {
		t.Fatal(err)
	}
	if err := store.RecordIdentityToken(
		ctx, AppleIdentity(testAppleSubject, "second-token", testAppleClientID),
	); err != nil {
		t.Fatal(err)
	}
	// An exchange that failed brings no token, and must not erase the one there.
	if err := store.RecordIdentityToken(ctx, AppleIdentity(testAppleSubject, "", "")); err != nil {
		t.Fatal(err)
	}
	var token, client string
	if err := store.db.QueryRowContext(ctx, `
SELECT refresh_token, token_client_id FROM account_identities WHERE provider = 'apple'
`).Scan(&token, &client); err != nil {
		t.Fatal(err)
	}
	if token != "second-token" || client != testAppleClientID {
		t.Fatalf("stored %q for %q, want the newest token", token, client)
	}
}

// openLegacyDiscordDatabase builds the database an older build left behind:
// the Discord link in the old columns, and no identity table at all.
func openLegacyDiscordDatabase(t *testing.T) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "legacy.sqlite")
	store, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	ctx := t.Context()
	anonymousAccount(t, store, "linked", "Yuki")
	if _, err := store.db.ExecContext(ctx, `
UPDATE accounts SET username_lower = 'yuki', discord = 'yuki',
    discord_user_id = '80351110224678912', discord_linked_at_unix_ms = 1700000000000
WHERE user_id = 'linked'
`); err != nil {
		t.Fatal(err)
	}
	if _, err := store.db.ExecContext(ctx, `
DROP TRIGGER account_identities_queue_revocation;
DROP TABLE account_identities;
`); err != nil {
		t.Fatal(err)
	}
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}
	return path
}

// The first boot of this build is the migration: every Discord link moves into
// the table, and the account reads exactly as it did.
func TestTheMigrationCarriesDiscordLinksForward(t *testing.T) {
	path := openLegacyDiscordDatabase(t)

	for boot := 1; boot <= 2; boot++ {
		store, err := Open(path)
		if err != nil {
			t.Fatalf("boot %d: %v", boot, err)
		}
		account, err := store.AccountForIdentity(t.Context(), ProviderDiscord, "80351110224678912")
		if err != nil || account.UserID != "linked" {
			t.Fatalf("boot %d: the Discord link did not come across: %v", boot, err)
		}
		if !account.Registered || !account.DiscordVerified || account.Discord != "yuki" {
			t.Fatalf("boot %d: the account reads differently: %+v", boot, account)
		}
		var rows int
		var linkedAt int64
		if err := store.db.QueryRowContext(t.Context(), `
SELECT COUNT(*), MAX(linked_at_unix_ms) FROM account_identities
`).Scan(&rows, &linkedAt); err != nil {
			t.Fatal(err)
		}
		// A second boot must change nothing.
		if rows != 1 || linkedAt != 1700000000000 {
			t.Fatalf("boot %d: %d rows linked at %d, want one at the original time",
				boot, rows, linkedAt)
		}
		if err := store.Close(); err != nil {
			t.Fatal(err)
		}
	}
}

// While both are written, the columns are the truth for Discord. Whatever an
// older build did to them in between — here, unlinking somebody by clearing the
// column, and linking somebody else — is what the table becomes.
func TestABootFollowsWhatAnOlderBuildDidToTheColumns(t *testing.T) {
	path := filepath.Join(t.TempDir(), "rollback.sqlite")
	store, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	ctx := t.Context()
	anonymousAccount(t, store, "left", "Guest")
	if _, err := store.ClaimAccountWithIdentity(
		ctx, "left", "Leaver", DiscordIdentity("111", "leaver"),
	); err != nil {
		t.Fatal(err)
	}
	anonymousAccount(t, store, "joined", "Guest")
	// What the older build would have written, and nothing else.
	if _, err := store.db.ExecContext(ctx, `
UPDATE accounts SET discord_user_id = '' WHERE user_id = 'left';
UPDATE accounts SET discord_user_id = '222', username_lower = 'joiner', username = 'Joiner'
WHERE user_id = 'joined';
`); err != nil {
		t.Fatal(err)
	}
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}

	store, err = Open(path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	if _, err := store.AccountForIdentity(ctx, ProviderDiscord, "111"); !errors.Is(err, ErrAccountNotFound) {
		t.Errorf("a link the old build cleared survived the boot: %v", err)
	}
	if account, err := store.AccountForIdentity(ctx, ProviderDiscord, "222"); err != nil ||
		account.UserID != "joined" {
		t.Errorf("a link the old build made was not carried in: %v", err)
	}
}

// Apple's link survives a boot untouched: the reconciliation is about Discord's
// columns and nothing else.
func TestABootLeavesAppleLinksAlone(t *testing.T) {
	path := filepath.Join(t.TempDir(), "apple.sqlite")
	store, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	ctx := t.Context()
	anonymousAccount(t, store, "player", "Guest")
	if _, err := store.ClaimAccountWithIdentity(
		ctx, "player", "Yuki", AppleIdentity(testAppleSubject, "token", testAppleClientID),
	); err != nil {
		t.Fatal(err)
	}
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}
	store, err = Open(path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	if account, err := store.AccountForIdentity(ctx, ProviderApple, testAppleSubject); err != nil ||
		account.UserID != "player" {
		t.Fatalf("the Apple link did not survive a boot: %v", err)
	}
}
