package persistence

import (
	"errors"
	"strings"
	"testing"

	"rps-strategy/backend/internal/game"
)

// The party rule, at the level that enforces it.
//
// The server decides *who may enter what* — see registerBotForTournament. This
// is the other half: whatever route it arrives on, one owner cannot end up
// holding two places in a field, and the entry they hold can be found and
// removed from either end of the owner/engine pair.

func TestOneEntryPerOwnerHoweverItArrives(t *testing.T) {
	store := authTestStore(t)
	ctx := t.Context()
	registeredOwner(t, store, "owner", "Owner")
	registeredOwner(t, store, "rival", "Rival")
	fishy := claimedBot(t, store, "owner", "Fishy")
	chippy := claimedBot(t, store, "owner", "Chippy")
	openTournament(t, store, "cup", "Engine Cup", game.ModeTotalWar, "Total War")

	if _, err := store.SignupForTournament(
		ctx, "cup", fishy.UserID, "Fishy", "owner.discord", true,
	); err != nil {
		t.Fatalf("enter the first engine: %v", err)
	}

	// A second engine of the same owner, which is the case the rule exists for
	// and the one a field of four all authored by the same person used to be.
	_, err := store.SignupForTournament(ctx, "cup", chippy.UserID, "Chippy", "owner.discord", true)
	if !errors.Is(err, ErrTournamentAlreadyEntered) {
		t.Fatalf("expected a second engine to be refused, got %v", err)
	}
	// The refusal says which name is already in it.
	if err == nil || !strings.Contains(err.Error(), "Fishy") {
		t.Fatalf("expected the refusal to name Fishy, got %v", err)
	}

	// The owner in person is the same party as their engine.
	if _, err := store.SignupForTournament(
		ctx, "cup", "owner", "Owner", "owner.discord", true,
	); !errors.Is(err, ErrTournamentAlreadyEntered) {
		t.Fatalf("expected the owner to be refused, got %v", err)
	}

	// Somebody else's engine is a different party and is unaffected.
	stray := claimedBot(t, store, "rival", "Stray")
	if _, err := store.SignupForTournament(
		ctx, "cup", stray.UserID, "Stray", "rival.discord", true,
	); err != nil {
		t.Fatalf("expected another owner's engine to enter, got %v", err)
	}
}

func TestEntryLookupAndWithdrawalAnswerToEitherEndOfThePair(t *testing.T) {
	store := authTestStore(t)
	ctx := t.Context()
	registeredOwner(t, store, "owner", "Owner")
	registeredOwner(t, store, "rival", "Rival")
	fishy := claimedBot(t, store, "owner", "Fishy")
	stray := claimedBot(t, store, "rival", "Stray")
	openTournament(t, store, "cup", "Engine Cup", game.ModeTotalWar, "Total War")

	for _, bot := range []Bot{fishy, stray} {
		if _, err := store.SignupForTournament(
			ctx, "cup", bot.UserID, bot.Name, "bot."+bot.Name, true,
		); err != nil {
			t.Fatalf("enter %s: %v", bot.Name, err)
		}
	}

	// The owner's id and the engine's id are two ways of naming one entry, so a
	// caller holding either does not have to work out which it is holding.
	for _, id := range []string{"owner", fishy.UserID} {
		entry, err := store.TournamentEntryFor(ctx, "cup", id)
		if err != nil {
			t.Fatalf("entry for %s: %v", id, err)
		}
		if entry.IGN != "Fishy" {
			t.Fatalf("expected Fishy for %s, got %q", id, entry.IGN)
		}
	}
	if _, err := store.TournamentEntryFor(ctx, "cup", "nobody"); !errors.Is(
		err, ErrTournamentEntryNotFound,
	) {
		t.Fatalf("expected no entry for a stranger, got %v", err)
	}

	// Withdrawing by the owner's id removes the engine's row and leaves the
	// other party's alone.
	after, removed, err := store.WithdrawTournamentEntry(ctx, "cup", "owner")
	if err != nil {
		t.Fatalf("withdraw: %v", err)
	}
	if removed.IGN != "Fishy" {
		t.Fatalf("expected Fishy to be removed, got %q", removed.IGN)
	}
	if len(after.Players) != 1 || after.Players[0].IGN != "Stray" {
		t.Fatalf("expected only Stray left, got %#v", after.Players)
	}
	if _, _, err := store.WithdrawTournamentEntry(ctx, "cup", "owner"); !errors.Is(
		err, ErrTournamentEntryNotFound,
	) {
		t.Fatalf("expected a second withdrawal to find nothing, got %v", err)
	}

	// Once the pairings exist the field is frozen: an entrant leaving would
	// rewrite a schedule every other entrant is playing to.
	if _, err := store.SignupForTournament(
		ctx, "cup", "owner", "Owner", "owner.discord", true,
	); err != nil {
		t.Fatalf("re-enter as the owner: %v", err)
	}
	if _, err := store.StartTournament(ctx, "cup"); err != nil {
		t.Fatalf("start: %v", err)
	}
	if _, _, err := store.WithdrawTournamentEntry(ctx, "cup", "owner"); !errors.Is(
		err, ErrTournamentAlreadyStarted,
	) {
		t.Fatalf("expected a started event to refuse a withdrawal, got %v", err)
	}
}
