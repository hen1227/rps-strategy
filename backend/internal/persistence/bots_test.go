package persistence

import (
	"errors"
	"strings"
	"testing"

	"rps-strategy/backend/internal/game"
)

// registeredOwner creates an account and claims it, which is the precondition
// for owning a bot.
//
// The snowflake is derived from the user ID rather than passed in, so that
// every caller of this helper — and there are dozens across the package —
// stayed unchanged when registration moved from passwords to Discord.
func registeredOwner(t *testing.T, store *Store, userID string, username string) {
	t.Helper()
	ctx := t.Context()
	key := strings.Repeat(userID+"0", 64)[:64]
	if _, err := store.EnsureAccountWithProfileKey(ctx, userID, username, key); err != nil {
		t.Fatalf("create owner account: %v", err)
	}
	if _, err := store.ClaimAccountWithDiscord(
		ctx, userID, username, "discord-"+userID, username,
	); err != nil {
		t.Fatalf("claim owner: %v", err)
	}
}

func TestMintingRequiresARegisteredOwner(t *testing.T) {
	store := authTestStore(t)
	ctx := t.Context()

	// Anonymous accounts are free and unlimited, so allowing them to own bots
	// would make the whole registration requirement pointless.
	if _, err := store.EnsureAccountWithProfileKey(ctx, "anon", "Anon", testProfileKey); err != nil {
		t.Fatalf("create anonymous account: %v", err)
	}
	if _, _, err := store.MintBotToken(ctx, "anon"); !errors.Is(err, ErrNotRegistered) {
		t.Fatalf("an anonymous account must not own bots, got %v", err)
	}

	registeredOwner(t, store, "owner", "Owner")
	if _, _, err := store.MintBotToken(ctx, "owner"); err != nil {
		t.Fatalf("a registered owner should be able to mint: %v", err)
	}
}

func TestBotLimitIsEnforcedWhenMinting(t *testing.T) {
	store := authTestStore(t)
	ctx := t.Context()
	registeredOwner(t, store, "owner", "Owner")

	for index := range MaximumBotsPerAccount {
		if _, _, err := store.MintBotToken(ctx, "owner"); err != nil {
			t.Fatalf("mint %d: %v", index, err)
		}
	}
	if _, _, err := store.MintBotToken(ctx, "owner"); !errors.Is(err, ErrBotLimitReached) {
		t.Fatalf("the cap must be enforced, got %v", err)
	}

	// Retiring one frees a slot, so an author is never permanently stuck.
	bots, err := store.BotsForOwner(ctx, "owner")
	if err != nil {
		t.Fatalf("list bots: %v", err)
	}
	if err := store.RetireBot(ctx, bots[0].BotID); err != nil {
		t.Fatalf("retire: %v", err)
	}
	if _, _, err := store.MintBotToken(ctx, "owner"); err != nil {
		t.Fatalf("retiring should free a slot: %v", err)
	}
}

// The central behaviour: the same token used twice is the same bot, not two.
func TestClaimingTwiceIsARebootNotASecondBot(t *testing.T) {
	store := authTestStore(t)
	ctx := t.Context()
	registeredOwner(t, store, "owner", "Owner")

	_, token, err := store.MintBotToken(ctx, "owner")
	if err != nil {
		t.Fatalf("mint: %v", err)
	}
	settings := BotSettings{Name: "MyBot", AllowPublicPlay: true, EnterTournaments: true}

	first, err := store.ClaimBot(ctx, token, settings)
	if err != nil {
		t.Fatalf("first claim: %v", err)
	}
	if !first.Claimed || first.UserID == "" || first.Name != "MyBot" {
		t.Fatalf("first claim should have created the account: %#v", first)
	}

	// Give the bot a rating, so "same bot" is checkable rather than asserted.
	if _, err := store.db.ExecContext(ctx, `
INSERT INTO account_mode_ratings (user_id, mode_id, elo, created_at_unix_ms, updated_at_unix_ms)
VALUES (?, ?, ?, ?, ?)
`, first.UserID, game.ModeInfiltration, 1720, 1, 1); err != nil {
		t.Fatalf("seed rating: %v", err)
	}

	second, err := store.ClaimBot(ctx, token, settings)
	if err != nil {
		t.Fatalf("second claim: %v", err)
	}
	if second.BotID != first.BotID || second.UserID != first.UserID {
		t.Fatalf("a restart produced a different bot: %#v then %#v", first, second)
	}
	account, err := store.Account(ctx, second.UserID)
	if err != nil {
		t.Fatalf("read bot account: %v", err)
	}
	if account.ModeRatings[game.ModeInfiltration].Elo != 1720 {
		t.Fatal("a restart must not reset the bot's rating")
	}
	if account.Kind != AccountKindBot {
		t.Fatalf("a bot's account must be marked as one, got %q", account.Kind)
	}
}

func TestBotAccountIsSealedAgainstProfileKeyClaims(t *testing.T) {
	store := authTestStore(t)
	ctx := t.Context()
	registeredOwner(t, store, "owner", "Owner")

	_, token, err := store.MintBotToken(ctx, "owner")
	if err != nil {
		t.Fatalf("mint: %v", err)
	}
	bot, err := store.ClaimBot(ctx, token, BotSettings{Name: "SealedBot"})
	if err != nil {
		t.Fatalf("claim: %v", err)
	}

	// A bot's user ID is published in live-game rows and PGN tags, so the
	// account must be sealed at creation rather than left claimable.
	var storedHash string
	if err := store.db.QueryRowContext(ctx,
		`SELECT profile_key_hash FROM accounts WHERE user_id = ?`, bot.UserID,
	).Scan(&storedHash); err != nil {
		t.Fatalf("read bot account: %v", err)
	}
	if storedHash == "" {
		t.Fatal("a bot account must not be left with an empty profile key")
	}
	if _, err := store.EnsureAccountWithProfileKey(ctx, bot.UserID, "Guest", testProfileKey); !errors.Is(err, ErrInvalidProfileKey) {
		t.Fatalf("a bot account must not be connectable with an arbitrary key: %v", err)
	}
}

func TestBotNamesShareOneNamespaceWithPlayerNames(t *testing.T) {
	store := authTestStore(t)
	ctx := t.Context()
	registeredOwner(t, store, "owner", "Owner")

	_, token, err := store.MintBotToken(ctx, "owner")
	if err != nil {
		t.Fatalf("mint: %v", err)
	}
	if _, err := store.ClaimBot(ctx, token, BotSettings{Name: "Rival"}); err != nil {
		t.Fatalf("claim: %v", err)
	}

	// Challenges are addressed by display name, so a person able to take a
	// bot's name could intercept games meant for it.
	const otherKey = "cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd"
	if _, err := store.EnsureAccountWithProfileKey(ctx, "impostor", "Nobody", otherKey); err != nil {
		t.Fatalf("create account: %v", err)
	}
	if _, err := store.ClaimAccountWithDiscord(
		ctx, "impostor", "rival", "discord-impostor", "rival",
	); !errors.Is(err, ErrUsernameTaken) {
		t.Fatalf("a bot's name must not be registrable by a person: %v", err)
	}

	// And the reverse: a second bot cannot take the first one's name.
	_, secondToken, err := store.MintBotToken(ctx, "owner")
	if err != nil {
		t.Fatalf("mint second: %v", err)
	}
	if _, err := store.ClaimBot(ctx, secondToken, BotSettings{Name: "RIVAL"}); !errors.Is(err, ErrUsernameTaken) {
		t.Fatalf("two bots must not share a name: %v", err)
	}
}

func TestRotatingATokenKeepsTheBotAndInvalidatesTheOldSecret(t *testing.T) {
	store := authTestStore(t)
	ctx := t.Context()
	registeredOwner(t, store, "owner", "Owner")

	_, token, err := store.MintBotToken(ctx, "owner")
	if err != nil {
		t.Fatalf("mint: %v", err)
	}
	before, err := store.ClaimBot(ctx, token, BotSettings{Name: "Keeper"})
	if err != nil {
		t.Fatalf("claim: %v", err)
	}

	rotated, err := store.RotateBotToken(ctx, before.BotID)
	if err != nil {
		t.Fatalf("rotate: %v", err)
	}
	if _, err := store.ClaimBot(ctx, token, BotSettings{Name: "Keeper"}); !errors.Is(err, ErrBotNotFound) {
		t.Fatalf("the old token must stop working: %v", err)
	}
	after, err := store.ClaimBot(ctx, rotated, BotSettings{Name: "Keeper"})
	if err != nil {
		t.Fatalf("claim with rotated token: %v", err)
	}
	// This is what makes losing the config file survivable rather than fatal.
	if after.UserID != before.UserID {
		t.Fatalf("rotation must keep the same bot: %q then %q", before.UserID, after.UserID)
	}
}

func TestRetiredAndDisabledBotsCannotConnect(t *testing.T) {
	store := authTestStore(t)
	ctx := t.Context()
	registeredOwner(t, store, "owner", "Owner")

	_, disabledToken, err := store.MintBotToken(ctx, "owner")
	if err != nil {
		t.Fatalf("mint: %v", err)
	}
	disabled, err := store.ClaimBot(ctx, disabledToken, BotSettings{Name: "Naughty"})
	if err != nil {
		t.Fatalf("claim: %v", err)
	}
	if err := store.SetBotDisabled(ctx, disabled.BotID, true); err != nil {
		t.Fatalf("disable: %v", err)
	}
	if _, err := store.ClaimBot(ctx, disabledToken, BotSettings{Name: "Naughty"}); !errors.Is(err, ErrBotDisabled) {
		t.Fatalf("a disabled bot must not connect: %v", err)
	}

	_, retiredToken, err := store.MintBotToken(ctx, "owner")
	if err != nil {
		t.Fatalf("mint: %v", err)
	}
	retired, err := store.ClaimBot(ctx, retiredToken, BotSettings{Name: "Gone"})
	if err != nil {
		t.Fatalf("claim: %v", err)
	}
	if err := store.RetireBot(ctx, retired.BotID); err != nil {
		t.Fatalf("retire: %v", err)
	}
	if _, err := store.ClaimBot(ctx, retiredToken, BotSettings{Name: "Gone"}); !errors.Is(err, ErrBotRetired) {
		t.Fatalf("a retired bot must not connect: %v", err)
	}
	// Retiring releases the name for somebody else.
	_, freshToken, err := store.MintBotToken(ctx, "owner")
	if err != nil {
		t.Fatalf("mint: %v", err)
	}
	if _, err := store.ClaimBot(ctx, freshToken, BotSettings{Name: "Gone"}); err != nil {
		t.Fatalf("a retired bot's name should be free again: %v", err)
	}
}

func TestUnknownTokenIsRejected(t *testing.T) {
	store := authTestStore(t)
	if _, err := store.ClaimBot(t.Context(), "rps_b_nope", BotSettings{Name: "Ghost"}); !errors.Is(err, ErrBotNotFound) {
		t.Fatalf("unknown token: %v", err)
	}
}

func TestDirectoryListsOnlyClaimedEnabledBots(t *testing.T) {
	store := authTestStore(t)
	ctx := t.Context()
	registeredOwner(t, store, "owner", "Owner")

	_, claimedToken, err := store.MintBotToken(ctx, "owner")
	if err != nil {
		t.Fatalf("mint: %v", err)
	}
	if _, err := store.ClaimBot(ctx, claimedToken, BotSettings{Name: "Listed"}); err != nil {
		t.Fatalf("claim: %v", err)
	}
	// An unclaimed slot exists but is nobody's opponent yet.
	if _, _, err := store.MintBotToken(ctx, "owner"); err != nil {
		t.Fatalf("mint unclaimed: %v", err)
	}

	listed, err := store.Bots(ctx)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(listed) != 1 || listed[0].Name != "Listed" {
		t.Fatalf("the directory should hold exactly the claimed bot, got %#v", listed)
	}
	// The owner still sees both, because an unclaimed slot is what they need
	// to finish setting up.
	owned, err := store.BotsForOwner(ctx, "owner")
	if err != nil {
		t.Fatalf("list owned: %v", err)
	}
	if len(owned) != 2 {
		t.Fatalf("owner should see the unclaimed slot too, got %d", len(owned))
	}
}
