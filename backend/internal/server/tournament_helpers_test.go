package server

import (
	"context"
	"testing"

	"rps-strategy/backend/internal/game"
	"rps-strategy/backend/internal/persistence"
)

// openTournament creates an event and publishes it, which is what
// CreateTournament alone used to do. See the twin in the persistence package
// for why the two steps are now separate.
func openTournament(
	t *testing.T,
	data *persistence.Store,
	tournamentID string,
	name string,
	modeID game.ModeID,
	modeName string,
) persistence.Tournament {
	t.Helper()
	config := persistence.DefaultTournamentConfig(modeID, modeName)
	config.Name = name
	if _, err := data.CreateTournament(context.Background(), tournamentID, config); err != nil {
		t.Fatalf("create tournament %s: %v", tournamentID, err)
	}
	tournament, err := data.PublishTournament(context.Background(), tournamentID)
	if err != nil {
		t.Fatalf("publish tournament %s: %v", tournamentID, err)
	}
	return tournament
}

// verifiedEntrants makes a list of account ids into Discord-verified accounts.
//
// Every entrant in every event has to be verified — see the door in
// SignupForTournament — and none of the tests reaching for this are about that
// door. Claiming upgrades an existing anonymous account in place, so it is safe
// on ids a test has already created.
func verifiedEntrants(t *testing.T, data *persistence.Store, ids ...string) {
	t.Helper()
	for _, id := range ids {
		if account, err := data.Account(t.Context(), id); err == nil && account.DiscordVerified {
			continue
		}
		registeredSession(t, data, id, id)
	}
}
