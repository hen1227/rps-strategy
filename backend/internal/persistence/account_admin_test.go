package persistence

import (
	"errors"
	"strings"
	"testing"

	"rps-strategy/backend/internal/game"
	"time"

	"rps-strategy/backend/internal/notation"
)

func TestSearchAccountsFindsByNameAndUserID(t *testing.T) {
	store := authTestStore(t)
	ctx := t.Context()
	registeredOwner(t, store, "owner", "Ada")
	if _, err := store.EnsureAccountWithProfileKey(ctx, "anon", "Grace", testProfileKey); err != nil {
		t.Fatalf("create account: %v", err)
	}

	all, err := store.SearchAccounts(ctx, AccountFilter{})
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	// The zero filter is the unfiltered list, which is the property every
	// widening default below depends on.
	if len(all.Accounts) != 2 || all.Total != 2 {
		t.Fatalf("expected both accounts, got %d of %d", len(all.Accounts), all.Total)
	}

	byName, err := store.SearchAccounts(ctx, AccountFilter{Query: "ad"})
	if err != nil {
		t.Fatalf("search: %v", err)
	}
	if len(byName.Accounts) != 1 || byName.Accounts[0].Username != "Ada" {
		t.Fatalf("substring search: %#v", byName)
	}
	byID, err := store.SearchAccounts(ctx, AccountFilter{Query: "anon"})
	if err != nil {
		t.Fatalf("search: %v", err)
	}
	if len(byID.Accounts) != 1 || byID.Accounts[0].UserID != "anon" {
		t.Fatalf("user id search: %#v", byID)
	}
	if !byName.Accounts[0].Registered || byID.Accounts[0].Registered {
		t.Fatal("registration state should distinguish the two")
	}
}

// The filter this whole struct exists for: hiding the Guests.
func TestSearchAccountsFilters(t *testing.T) {
	store := authTestStore(t)
	ctx := t.Context()
	registeredOwner(t, store, "owner", "Ada")
	for _, id := range []string{"anon-1", "anon-2", "anon-3"} {
		if _, err := store.EnsureAccountWithProfileKey(
			ctx, id, "Guest", testProfileKey,
		); err != nil {
			t.Fatalf("create account: %v", err)
		}
	}

	yes, no := true, false
	registered, err := store.SearchAccounts(ctx, AccountFilter{Registered: &yes})
	if err != nil {
		t.Fatalf("search: %v", err)
	}
	if len(registered.Accounts) != 1 || registered.Accounts[0].Username != "Ada" {
		t.Fatalf("expected only the registered account: %#v", registered.Accounts)
	}
	// The count is of what matched, which is what makes "1 of 4" readable.
	if registered.Total != 1 {
		t.Fatalf("expected a total of 1, got %d", registered.Total)
	}

	guests, err := store.SearchAccounts(ctx, AccountFilter{Registered: &no})
	if err != nil {
		t.Fatalf("search: %v", err)
	}
	if len(guests.Accounts) != 3 {
		t.Fatalf("expected the three guests, got %d", len(guests.Accounts))
	}

	// Nil is a third answer, and has to stay distinct from false.
	either, err := store.SearchAccounts(ctx, AccountFilter{Registered: nil})
	if err != nil {
		t.Fatalf("search: %v", err)
	}
	if len(either.Accounts) != 4 {
		t.Fatalf("nil should not filter, got %d", len(either.Accounts))
	}

	// Nobody has played, so an activity filter empties the list rather than
	// falling back to everybody — which is the mistake a widening default
	// invites if it is applied to the wrong field.
	active, err := store.SearchAccounts(ctx, AccountFilter{
		ActiveSinceUnixMs: time.Now().Add(-time.Hour).UnixMilli(),
	})
	if err != nil {
		t.Fatalf("search: %v", err)
	}
	if len(active.Accounts) != 0 {
		t.Fatalf("expected nobody active, got %#v", active.Accounts)
	}

	if _, err := store.SearchAccounts(ctx, AccountFilter{MinGames: 1}); err != nil {
		t.Fatalf("min games: %v", err)
	}

	// Every sort has to produce valid SQL, including one nobody asked for.
	for _, sort := range []AccountSort{
		SortAccountsNewest, SortAccountsActive, SortAccountsRating,
		SortAccountsGames, SortAccountsName, AccountSort("nonsense"),
	} {
		if _, err := store.SearchAccounts(ctx, AccountFilter{Sort: sort}); err != nil {
			t.Fatalf("sort %q: %v", sort, err)
		}
	}
}

func TestDisablingAnAccountRevokesItsSessions(t *testing.T) {
	store := authTestStore(t)
	ctx := t.Context()
	registeredOwner(t, store, "player", "Ada")

	token, err := store.CreateSession(ctx, "player")
	if err != nil {
		t.Fatalf("session: %v", err)
	}
	if err := store.SetAccountDisabled(ctx, "player", true); err != nil {
		t.Fatalf("disable: %v", err)
	}
	if _, err := store.SessionAccount(ctx, token); err == nil {
		t.Fatal("a disabled account's session must stop working")
	}
	if err := store.SetAccountDisabled(ctx, "nobody", true); !errors.Is(err, ErrAccountNotFound) {
		t.Fatalf("unknown account: %v", err)
	}
}

func TestAdminToolsRefuseToLockEveryoneOut(t *testing.T) {
	store := authTestStore(t)
	ctx := t.Context()
	registeredOwner(t, store, "boss", "Boss")
	if err := store.SetAccountAdmin(ctx, "boss", true); err != nil {
		t.Fatalf("grant: %v", err)
	}
	// Disabling and anonymizing both remove an administrator's access, so both
	// have to refuse when they are the last one.
	if err := store.SetAccountDisabled(ctx, "boss", true); !errors.Is(err, ErrLastAdministrator) {
		t.Fatalf("disable the only admin: %v", err)
	}
	if _, err := store.AnonymizeAccount(ctx, "boss"); !errors.Is(err, ErrLastAdministrator) {
		t.Fatalf("anonymize the only admin: %v", err)
	}
}

func TestAnonymizeHardDeletesOnlyWhenNothingRefersToTheAccount(t *testing.T) {
	store := authTestStore(t)
	ctx := t.Context()
	registeredOwner(t, store, "ghost", "Ghost")

	rewritten, err := store.AnonymizeAccount(ctx, "ghost")
	if err != nil {
		t.Fatalf("anonymize: %v", err)
	}
	if rewritten != 0 {
		t.Fatalf("nothing to rewrite, got %d", rewritten)
	}
	if _, err := store.Account(ctx, "ghost"); !errors.Is(err, ErrAccountNotFound) {
		t.Fatalf("an account that never played should be deleted outright: %v", err)
	}
	// The name is free again.
	registeredOwner(t, store, "someone-else", "Ghost")
}

// The privacy promise is about the archive, not only the columns beside it.
func TestAnonymizeStripsTheNameFromTheStoredRecordToo(t *testing.T) {
	store := authTestStore(t)
	ctx := t.Context()
	registeredOwner(t, store, "leaver", "Leaver")
	registeredOwner(t, store, "stayer", "Stayer")

	played, err := game.NewGame(
		"archived-1", game.ModeTotalWar,
		game.PlayerProfile{UserID: "leaver", Username: "Leaver"},
		game.PlayerProfile{UserID: "stayer", Username: "Stayer"},
	)
	if err != nil {
		t.Fatalf("new game: %v", err)
	}
	moves := played.LegalMoves()
	if _, err := played.Move(game.FirstToMove, moves[0].From, moves[0].To); err != nil {
		t.Fatalf("play a move: %v", err)
	}
	if _, err := played.Resign(game.Blue); err != nil {
		t.Fatalf("resign: %v", err)
	}
	record := played.Record()
	if _, err := store.ArchiveGame(ctx, record, notation.Metadata{Event: "Casual"}, ""); err != nil {
		t.Fatalf("archive: %v", err)
	}

	rewritten, err := store.AnonymizeAccount(ctx, "leaver")
	if err != nil {
		t.Fatalf("anonymize: %v", err)
	}
	if rewritten != 1 {
		t.Fatalf("expected one record rewritten, got %d", rewritten)
	}

	stored, err := store.ArchivedGame(ctx, record.GameID)
	if err != nil {
		t.Fatalf("read record: %v", err)
	}
	if strings.Contains(stored.PGN, "Leaver") || strings.Contains(stored.PGN, "leaver") {
		t.Fatalf("the departed player is still named in the record:\n%s", stored.PGN)
	}
	if !strings.Contains(stored.PGN, "Stayer") {
		t.Fatal("the other player must be left alone")
	}
	// And the record must still be a record: same game, still replayable.
	parsed, err := notation.Parse(stored.PGN)
	if err != nil {
		t.Fatalf("a rewritten record must still parse: %v", err)
	}
	if err := game.Verify(parsed.Record); err != nil {
		t.Fatalf("a rewritten record must still verify: %v", err)
	}
	// The account survives, because the game it played still refers to it.
	remaining, err := store.Account(ctx, "leaver")
	if err != nil {
		t.Fatalf("the account row must survive: %v", err)
	}
	if !remaining.Disabled || remaining.Registered {
		t.Fatalf("the account should be disabled and stripped: %#v", remaining)
	}
	// And it must not be adoptable by the next key that turns up.
	if _, err := store.EnsureAccountWithProfileKey(
		ctx, "leaver", "Guest", "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
	); err == nil {
		t.Fatal("an anonymized account must not be claimable")
	}
}

func TestAnonymizeRefusesWhileTheAccountStillOwnsBots(t *testing.T) {
	store := authTestStore(t)
	ctx := t.Context()
	registeredOwner(t, store, "owner", "Owner")
	if _, _, err := store.MintBotToken(ctx, "owner"); err != nil {
		t.Fatalf("mint: %v", err)
	}
	// A bot with no owner has nobody answering for it, and the foreign key
	// would refuse anyway — better a sentence than a constraint error.
	if _, err := store.AnonymizeAccount(ctx, "owner"); err == nil {
		t.Fatal("expected a refusal while bots are live")
	} else if !strings.Contains(err.Error(), "bot") {
		t.Fatalf("the refusal should say why: %v", err)
	}
}

// The owner handle is gated behind the host token everywhere it can be
// claimed, so holding it is the proof of being the host — and both places that
// claim a name have to say so, not just the one that was written first.
func TestTheOwnerHandleCarriesAdminByBothClaimingPaths(t *testing.T) {
	store := authTestStore(t)
	ctx := t.Context()

	// The claiming path, which is now signing in with Discord rather than
	// registering a password. The grant had to move with the door: registration
	// was one of the two places that wrote username_lower, and a rule enforced
	// at one of two doors is not enforced.
	registeredOwner(t, store, "by-claiming", OwnerUsername)
	account, err := store.Account(ctx, "by-claiming")
	if err != nil {
		t.Fatalf("read account: %v", err)
	}
	if !account.IsAdmin {
		t.Fatalf("claiming the owner handle should grant admin: %#v", account)
	}

	// Ordinary accounts are unaffected, which is the other half of the claim.
	registeredOwner(t, store, "ordinary", "Ordinary")
	if plain, err := store.Account(ctx, "ordinary"); err != nil {
		t.Fatalf("read account: %v", err)
	} else if plain.IsAdmin {
		t.Fatalf("an ordinary name must not grant admin: %#v", plain)
	}

	// The rename path. The owner has to give the name up first, since it is
	// unique — which also checks that the flag survives losing it: dropping
	// admin on rename would turn a profile edit into a self-demotion.
	if _, err := store.UpdateAccountProfile(ctx, "by-claiming", "FormerOwner", ""); err != nil {
		t.Fatalf("rename away: %v", err)
	}
	if former, err := store.Account(ctx, "by-claiming"); err != nil {
		t.Fatalf("read account: %v", err)
	} else if !former.IsAdmin {
		t.Fatalf("renaming away must not demote: %#v", former)
	}
	// Case-insensitively, because that is how the name's uniqueness works.
	if _, err := store.UpdateAccountProfile(ctx, "ordinary", "hEnHeN1227", ""); err != nil {
		t.Fatalf("rename to the owner handle: %v", err)
	}
	renamed, err := store.Account(ctx, "ordinary")
	if err != nil {
		t.Fatalf("read account: %v", err)
	}
	if !renamed.IsAdmin {
		t.Fatalf("renaming to the owner handle should grant admin: %#v", renamed)
	}
}

// An installation where the owner registered before this rule existed is the
// one case the two claiming paths cannot reach.
func TestTheOwnerIsGrantedAdminOnStartup(t *testing.T) {
	store := authTestStore(t)
	ctx := t.Context()
	registeredOwner(t, store, "owner", OwnerUsername)
	if _, err := store.db.ExecContext(ctx,
		`UPDATE accounts SET is_admin = 0 WHERE user_id = ?`, "owner",
	); err != nil {
		t.Fatalf("simulate an older database: %v", err)
	}

	if err := store.ensureOwnerIsAdmin(ctx); err != nil {
		t.Fatalf("reconcile: %v", err)
	}
	account, err := store.Account(ctx, "owner")
	if err != nil {
		t.Fatalf("read account: %v", err)
	}
	if !account.IsAdmin {
		t.Fatalf("startup should have granted admin: %#v", account)
	}
	// A database with nobody holding the name is not an error.
	empty := authTestStore(t)
	if err := empty.ensureOwnerIsAdmin(ctx); err != nil {
		t.Fatalf("no owner account: %v", err)
	}
}
