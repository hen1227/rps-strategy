package persistence

import (
	"errors"
	"strings"
	"testing"

	"rps-strategy/backend/internal/game"
)

// Whose place is whose, at the level that enforces it.
//
// One entry per *account*, on whatever route it arrives. It used to be one per
// party — an owner and all their engines sharing a single place, so that an
// author with four engines could not fill a field of six. Engines are entered by
// their switch and a sweep now (see enrolOnlineBots), several at a time and
// without anybody choosing, so the only thing the party version still did was
// refuse a person a place because a bot of theirs had been swept into it.
//
// The read is still party-wide, and that is not an inconsistency: an owner is
// answerable for their engine's entry — they are the one a host chases about it
// — they simply cannot delete it. Turning the switch off is how it leaves.

func TestOneEntryPerAccountHoweverItArrives(t *testing.T) {
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

	// The same account twice is the rule, and the whole of it. The refusal says
	// which name is already in, because "you are already in" is no help to
	// somebody who has forgotten what they entered under.
	_, err := store.SignupForTournament(ctx, "cup", fishy.UserID, "Fishy II", "owner.discord", true)
	if !errors.Is(err, ErrTournamentAlreadyEntered) {
		t.Fatalf("expected the same account to be refused twice, got %v", err)
	}
	if err == nil || !strings.Contains(err.Error(), "Fishy") {
		t.Fatalf("expected the refusal to name Fishy, got %v", err)
	}

	// A second engine of the same owner is a second entrant, because a sweep
	// that enters everything online will produce exactly this and nobody chose
	// it. The old rule refused it.
	if _, err := store.SignupForTournament(
		ctx, "cup", chippy.UserID, "Chippy", "owner.discord", true,
	); err != nil {
		t.Fatalf("expected a second engine of the same owner to enter, got %v", err)
	}

	// And the owner in person, who is not competing with their own bots for a
	// place. Being locked out of an event by a bot of yours that a sweep entered
	// is what this is here to stop.
	if _, err := store.SignupForTournament(
		ctx, "cup", "owner", "Owner", "owner.discord", true,
	); err != nil {
		t.Fatalf("expected the owner to enter beside their engines, got %v", err)
	}

	// Somebody else's engine is a different party and is unaffected.
	stray := claimedBot(t, store, "rival", "Stray")
	if _, err := store.SignupForTournament(
		ctx, "cup", stray.UserID, "Stray", "rival.discord", true,
	); err != nil {
		t.Fatalf("expected another owner's engine to enter, got %v", err)
	}
}

func TestEntryLookupAnswersEitherEndAndWithdrawalTakesYourOwn(t *testing.T) {
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

	// The withdrawal is the half that is *not* party-wide. The owner holds no
	// entry of their own here, so there is nothing for them to take out — their
	// engine's place is not theirs to delete, and deleting it would achieve
	// nothing anyway, because the next sweep puts it straight back.
	if _, _, err := store.WithdrawTournamentEntry(ctx, "cup", "owner"); !errors.Is(
		err, ErrTournamentEntryNotFound,
	) {
		t.Fatalf("expected the owner to have no entry of their own, got %v", err)
	}

	// The engine's own account does hold one, and removing it leaves the other
	// party's alone. Nothing an owner can press reaches this; it is here for the
	// host's door and the bot drain, which both name an account from outside.
	after, removed, err := store.WithdrawTournamentEntry(ctx, "cup", fishy.UserID)
	if err != nil {
		t.Fatalf("withdraw: %v", err)
	}
	if removed.IGN != "Fishy" {
		t.Fatalf("expected Fishy to be removed, got %q", removed.IGN)
	}
	if len(after.Players) != 1 || after.Players[0].IGN != "Stray" {
		t.Fatalf("expected only Stray left, got %#v", after.Players)
	}
	if _, _, err := store.WithdrawTournamentEntry(ctx, "cup", fishy.UserID); !errors.Is(
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
