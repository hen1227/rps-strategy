package persistence

import (
	"errors"
	"regexp"
	"strings"
	"testing"

	"rps-strategy/backend/internal/game"
	"rps-strategy/backend/internal/notation"
)

// Four groups of four from the unambiguous alphabet, and nothing else.
var storeReviewPasswordShape = regexp.MustCompile(
	`^[a-hjkmnp-z2-9]{4}-[a-hjkmnp-z2-9]{4}-[a-hjkmnp-z2-9]{4}-[a-hjkmnp-z2-9]{4}$`,
)

func resetStoreReview(
	t *testing.T,
	store *Store,
	label string,
	options StoreReviewOptions,
) StoreReviewReset {
	t.Helper()
	reset, err := store.ResetStoreReviewAccount(t.Context(), label, options)
	if err != nil {
		t.Fatalf("reset %s: %v", label, err)
	}
	return reset
}

func storeReviewListing(t *testing.T, store *Store, label string) StoreReviewAccount {
	t.Helper()
	accounts, err := store.StoreReviewAccounts(t.Context())
	if err != nil {
		t.Fatalf("list store review accounts: %v", err)
	}
	for _, account := range accounts {
		if account.Label == label {
			return account
		}
	}
	t.Fatalf("no store review account labelled %s in %#v", label, accounts)
	return StoreReviewAccount{}
}

func TestStoreReviewAccountSignsInWithTheGeneratedPassword(t *testing.T) {
	store := authTestStore(t)
	ctx := t.Context()

	reset := resetStoreReview(t, store, "apple", StoreReviewOptions{Username: "ReviewAda"})
	if !reset.Created || reset.UserID == "" || !reset.SignsIn {
		t.Fatalf("the first reset should make a working account: %#v", reset)
	}
	if !storeReviewPasswordShape.MatchString(reset.Password) {
		t.Fatalf("password %q is not four groups of four", reset.Password)
	}

	account, err := store.AuthenticateAccount(ctx, "reviewada", reset.Password)
	if err != nil {
		t.Fatalf("the generated password should sign in: %v", err)
	}
	if account.UserID != reset.UserID || account.Username != "ReviewAda" {
		t.Fatalf("signed in to the wrong account: %#v", account)
	}
	if !account.Registered || account.IsAdmin || account.DiscordVerified {
		t.Fatalf("a review account is registered, not an admin, not on Discord: %#v", account)
	}
	// No browser owns it, so no browser key may adopt it.
	if _, err := store.EnsureAccountWithProfileKey(
		ctx, reset.UserID, "Guest", testProfileKey,
	); err == nil {
		t.Fatal("a store review account must not be claimable by a profile key")
	}
	if review, err := store.IsStoreReviewAccount(ctx, reset.UserID); err != nil || !review {
		t.Fatalf("IsStoreReviewAccount = %v, %v", review, err)
	}
	if listed := storeReviewListing(t, store, "apple"); !listed.SignsIn ||
		listed.Username != "ReviewAda" || listed.UserID != reset.UserID {
		t.Fatalf("listing: %#v", listed)
	}
}

// A review account is on a password for good, so it is not one of the accounts
// the Discord link paths and the boot-time count are about.
func TestStoreReviewAccountsAreNotLegacyPasswordAccounts(t *testing.T) {
	store := authTestStore(t)
	ctx := t.Context()
	legacyPasswordAccount(t, store, "legacy", "Legacy", authTestPassword)
	resetStoreReview(t, store, "apple", StoreReviewOptions{Username: "ReviewAda"})

	legacy, review, err := store.passwordAccountCounts(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if legacy != 1 || review != 1 {
		t.Fatalf("counts = %d legacy, %d review; want 1 and 1", legacy, review)
	}
	if linkable, err := store.UsernameCanLinkWithPassword(ctx, "Legacy"); err != nil || !linkable {
		t.Fatalf("the legacy account should still be offered a password link: %v %v", linkable, err)
	}
	if linkable, err := store.UsernameCanLinkWithPassword(ctx, "ReviewAda"); err != nil || linkable {
		t.Fatalf("the review account must not be offered a password link: %v %v", linkable, err)
	}
}

func TestResettingKeepsAPasswordThatStillWorks(t *testing.T) {
	store := authTestStore(t)
	ctx := t.Context()
	first := resetStoreReview(t, store, "apple", StoreReviewOptions{Username: "ReviewAda"})
	token, err := store.CreateSession(ctx, first.UserID)
	if err != nil {
		t.Fatal(err)
	}

	again := resetStoreReview(t, store, "apple", StoreReviewOptions{})
	if again.Created || again.Password != "" || again.UserID != first.UserID {
		t.Fatalf("a reset of a working account should change nothing the store holds: %#v", again)
	}
	if again.SessionsRevoked != 1 {
		t.Fatalf("expected the old reviewer's session signed out, got %d", again.SessionsRevoked)
	}
	if _, err := store.SessionAccount(ctx, token); !errors.Is(err, ErrSessionInvalid) {
		t.Fatalf("the old session should be gone: %v", err)
	}
	if _, err := store.AuthenticateAccount(ctx, "ReviewAda", first.Password); err != nil {
		t.Fatalf("the password the store holds should still work: %v", err)
	}

	rotated := resetStoreReview(t, store, "apple", StoreReviewOptions{NewPassword: true})
	if rotated.Password == "" || rotated.Password == first.Password {
		t.Fatalf("asking for a new password should give one: %#v", rotated)
	}
	if _, err := store.AuthenticateAccount(
		ctx, "ReviewAda", first.Password,
	); !errors.Is(err, ErrInvalidCredentials) {
		t.Fatalf("the replaced password should stop working: %v", err)
	}
	if _, err := store.AuthenticateAccount(ctx, "ReviewAda", rotated.Password); err != nil {
		t.Fatalf("the new password should work: %v", err)
	}
}

func TestResetPutsBackWhatAReviewerChanged(t *testing.T) {
	store := authTestStore(t)
	ctx := t.Context()
	made := resetStoreReview(t, store, "google", StoreReviewOptions{Username: "ReviewBo"})

	// A reviewer trying the profile editor, and a host switching it off.
	if _, err := store.UpdateAccountProfile(ctx, made.UserID, "SomethingElse", "reviewer.handle"); err != nil {
		t.Fatalf("rename: %v", err)
	}
	if err := store.SetAccountDisabled(ctx, made.UserID, true); err != nil {
		t.Fatalf("disable: %v", err)
	}
	if listed := storeReviewListing(t, store, "google"); listed.SignsIn {
		t.Fatalf("a renamed, disabled account does not sign in with the name on file: %#v", listed)
	}

	reset := resetStoreReview(t, store, "google", StoreReviewOptions{})
	if reset.RenamedFrom != "SomethingElse" || !reset.ReEnabled || reset.Created {
		t.Fatalf("reset: %#v", reset)
	}
	account, err := store.AuthenticateAccount(ctx, "ReviewBo", made.Password)
	if err != nil {
		t.Fatalf("the store's name and password should work again: %v", err)
	}
	if account.Username != "ReviewBo" || account.Discord != "" || account.Disabled {
		t.Fatalf("account after reset: %#v", account)
	}
	if listed := storeReviewListing(t, store, "google"); !listed.SignsIn {
		t.Fatalf("listing after reset: %#v", listed)
	}
}

func TestResetRemakesAnAccountAReviewerDeleted(t *testing.T) {
	store := authTestStore(t)
	ctx := t.Context()

	// Never played, so deleting it removes the row outright.
	first := resetStoreReview(t, store, "apple", StoreReviewOptions{Username: "ReviewAda"})
	if _, err := store.AnonymizeAccount(ctx, first.UserID); err != nil {
		t.Fatalf("delete: %v", err)
	}
	if listed := storeReviewListing(t, store, "apple"); listed.SignsIn || listed.UserID != "" {
		t.Fatalf("the label should survive its account, pointing at nothing: %#v", listed)
	}
	second := resetStoreReview(t, store, "apple", StoreReviewOptions{})
	if !second.Created || second.Password == "" || second.UserID == first.UserID {
		t.Fatalf("a deleted account should be made again, with a new password: %#v", second)
	}
	if _, err := store.AuthenticateAccount(ctx, "ReviewAda", second.Password); err != nil {
		t.Fatalf("the remade account should sign in: %v", err)
	}

	// Played, so deleting it anonymizes the row and keeps it. The deletion
	// stands: the reset makes a new account rather than reviving that one.
	anonymousAccount(t, store, "opponent", "Opponent")
	played, err := game.NewGame(
		"review-game", game.ModeTotalWar,
		game.PlayerProfile{UserID: second.UserID, Username: "ReviewAda"},
		game.PlayerProfile{UserID: "opponent", Username: "Opponent"},
	)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := played.Resign(game.Blue); err != nil {
		t.Fatal(err)
	}
	if _, err := store.ArchiveGame(
		ctx, played.Record(), notation.Metadata{Event: "Casual"}, "",
	); err != nil {
		t.Fatalf("archive: %v", err)
	}
	if _, err := store.AnonymizeAccount(ctx, second.UserID); err != nil {
		t.Fatalf("delete: %v", err)
	}
	if listed := storeReviewListing(t, store, "apple"); listed.SignsIn {
		t.Fatalf("an anonymized account does not sign in: %#v", listed)
	}
	third := resetStoreReview(t, store, "apple", StoreReviewOptions{})
	if !third.Created || third.UserID == second.UserID {
		t.Fatalf("an anonymized account should be replaced, not revived: %#v", third)
	}
	deleted, err := store.Account(ctx, second.UserID)
	if err != nil {
		t.Fatalf("the anonymized row should still exist: %v", err)
	}
	if deleted.Username == "ReviewAda" || !deleted.Disabled {
		t.Fatalf("the deleted account came back: %#v", deleted)
	}
	if _, err := store.AuthenticateAccount(ctx, "ReviewAda", third.Password); err != nil {
		t.Fatalf("the replacement should sign in: %v", err)
	}
}

func TestStoreReviewAccountsRefuseEveryIdentityAndAdmin(t *testing.T) {
	store := authTestStore(t)
	ctx := t.Context()
	reset := resetStoreReview(t, store, "apple", StoreReviewOptions{Username: "ReviewAda"})

	for _, probe := range []struct {
		identity Identity
		names    string
	}{
		{identity: DiscordIdentity("80351110224678912", "reviewer"), names: "Discord"},
		{identity: AppleIdentity("001234.reviewer.0001", "token", "com.henhen1227.rps-strategy"),
			names: "an Apple ID"},
	} {
		_, err := store.LinkIdentity(ctx, reset.UserID, probe.identity)
		if !errors.Is(err, ErrStoreReviewLink) {
			t.Fatalf("linking %s from a session should be refused: %v", probe.names, err)
		}
		// What a reviewer reads names what they pressed.
		if !strings.HasSuffix(err.Error(), "can't link "+probe.names) {
			t.Errorf("the refusal reads %q", err)
		}
		// The naming step's door: a reviewer who knows the password types the name.
		if _, err := store.LinkIdentityWithPassword(
			ctx, "ReviewAda", reset.Password, probe.identity,
		); !errors.Is(err, ErrStoreReviewLink) {
			t.Fatalf("linking %s with the password should be refused: %v", probe.names, err)
		}
	}
	methods, err := store.SignInMethods(ctx, reset.UserID)
	if err != nil {
		t.Fatal(err)
	}
	if methods.CanLink || methods.AwaitingLink {
		t.Fatalf("a review account is offered a link: %+v", methods)
	}
	if _, err := store.AuthenticateAccount(ctx, "ReviewAda", reset.Password); err != nil {
		t.Fatalf("a refused link must leave the password alone: %v", err)
	}
	if err := store.SetAccountAdmin(ctx, reset.UserID, true); !errors.Is(err, ErrStoreReviewAdmin) {
		t.Fatalf("promoting a review account should be refused: %v", err)
	}
}

func TestStoreReviewResetRefusesBadRequests(t *testing.T) {
	store := authTestStore(t)
	ctx := t.Context()
	registeredOwner(t, store, "real-player", "Taken")

	for _, label := range []string{"", "Apple", "app store", "../admin", "a-label-that-is-far-too-long-to-be-one"} {
		if _, err := store.ResetStoreReviewAccount(
			ctx, label, StoreReviewOptions{Username: "ReviewAda"},
		); !errors.Is(err, ErrInvalidStoreReview) {
			t.Errorf("label %q: want ErrInvalidStoreReview, got %v", label, err)
		}
	}
	if _, err := store.ResetStoreReviewAccount(
		ctx, "apple", StoreReviewOptions{},
	); !errors.Is(err, ErrInvalidStoreReview) {
		t.Errorf("a first reset with no name: %v", err)
	}
	for _, reserved := range []string{OwnerUsername, "WebGoatGuy"} {
		if _, err := store.ResetStoreReviewAccount(
			ctx, "apple", StoreReviewOptions{Username: reserved},
		); !errors.Is(err, ErrInvalidStoreReview) {
			t.Errorf("reserved name %q: %v", reserved, err)
		}
	}
	if _, err := store.ResetStoreReviewAccount(
		ctx, "apple", StoreReviewOptions{Username: "x"},
	); !errors.Is(err, ErrInvalidUsername) {
		t.Errorf("an invalid name: %v", err)
	}

	// A player's name is theirs, and a reset must never take it over.
	if _, err := store.ResetStoreReviewAccount(
		ctx, "apple", StoreReviewOptions{Username: "taken"},
	); !errors.Is(err, ErrUsernameTaken) {
		t.Errorf("a player's name: %v", err)
	}
	player, err := store.Account(ctx, "real-player")
	if err != nil {
		t.Fatal(err)
	}
	if !player.DiscordVerified || player.Username != "Taken" {
		t.Fatalf("the player's account was touched: %#v", player)
	}
	if review, _ := store.IsStoreReviewAccount(ctx, "real-player"); review {
		t.Fatal("a player's account became a review account")
	}

	// Nor another store's.
	resetStoreReview(t, store, "apple", StoreReviewOptions{Username: "ReviewAda"})
	if _, err := store.ResetStoreReviewAccount(
		ctx, "google", StoreReviewOptions{Username: "ReviewAda"},
	); !errors.Is(err, ErrUsernameTaken) {
		t.Errorf("another store's name: %v", err)
	}
	// And a refused first reset leaves no label behind.
	accounts, err := store.StoreReviewAccounts(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(accounts) != 1 || accounts[0].Label != "apple" {
		t.Fatalf("labels after the refusals: %#v", accounts)
	}
}
