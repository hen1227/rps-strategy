package persistence

import (
	"context"
	"strconv"
	"testing"

	"rps-strategy/backend/internal/game"
)

// openTournament creates an event and publishes it, which is what
// CreateTournament alone used to do.
//
// The builder split those two steps — see the lifecycle note at the top of
// tournament_admin.go — and almost every test here is about what happens to an
// event that is taking signups rather than about the draft stage. This is that
// starting state in one call, so a test that cares about drafts can still use
// CreateTournament directly and the rest do not have to mention publication.
func openTournament(
	t *testing.T,
	store *Store,
	tournamentID string,
	name string,
	modeID game.ModeID,
	modeName string,
) Tournament {
	t.Helper()
	config := DefaultTournamentConfig(modeID, modeName)
	config.Name = name
	if _, err := store.CreateTournament(context.Background(), tournamentID, config); err != nil {
		t.Fatalf("create tournament %s: %v", tournamentID, err)
	}
	tournament, err := store.PublishTournament(context.Background(), tournamentID)
	if err != nil {
		t.Fatalf("publish tournament %s: %v", tournamentID, err)
	}
	return tournament
}

// verifiedField makes a list of entrant ids into Discord-verified accounts.
//
// Every entrant in every event has to be verified — see the door in
// SignupForTournament — and almost nothing in these files is about that door.
// This is the one line that gets a test's field through it, so the test can go
// on being about pairing, seeding or standings.
//
// The username is generated rather than taken from the id, because ids here are
// things like "user-a" and the username rules would refuse half of them. The
// verified Discord handle ends up being that username, which is what a test
// asserting on `Player.Discord` will see.
func verifiedField(t *testing.T, store *Store, ids ...string) {
	t.Helper()
	for index, id := range ids {
		registeredOwner(t, store, id, "Entrant"+strconv.Itoa(index+1))
	}
}

// legacyOwner is a registered account with a password and no Discord.
//
// The shape every account had before Discord sign-in, still held by the last
// few, and the one the verification door turns away — including, now, the
// engines hanging off it. Written directly because the only claim path left
// goes through Discord, which is exactly what this account has not done.
func legacyOwner(t *testing.T, store *Store, userID string, username string) {
	t.Helper()
	if _, err := store.EnsureAccount(t.Context(), userID, username); err != nil {
		t.Fatalf("create legacy owner %s: %v", userID, err)
	}
	if _, err := store.db.ExecContext(t.Context(),
		`UPDATE accounts SET username = ?, password_hash = 'legacy' WHERE user_id = ?`,
		username, userID,
	); err != nil {
		t.Fatalf("register legacy owner %s: %v", userID, err)
	}
}
