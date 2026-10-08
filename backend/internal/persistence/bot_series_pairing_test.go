package persistence

import (
	"testing"

	"rps-strategy/backend/internal/game"
)

// Every run reads back who picked its engines and whether it counts — the two
// things a card leads with — from what its row already records, so a run
// played before either answer was on the wire reads right too, with no
// migration to fill it in.
func TestARunReadsBackHowItCameToBePlayed(t *testing.T) {
	store := authTestStore(t)
	ctx := t.Context()
	registeredOwner(t, store, "owner", "Owner")
	registeredOwner(t, store, "rival", "Rival")
	alpha := claimedBot(t, store, "owner", "Alpha")
	beta := claimedBot(t, store, "owner", "Beta")
	gamma := claimedBot(t, store, "rival", "Gamma")

	cases := []struct {
		name        string
		second      Bot
		ladder      bool
		ranked      bool
		requestedBy string
		pairing     BotSeriesPairing
		casual      bool
	}{
		// The pool's own rounds are the only runs nobody asks for.
		{"round", gamma, true, true, "", BotSeriesPairingRound, false},
		{"random", gamma, true, true, "owner", BotSeriesPairingRandom, false},
		{"chosen", gamma, false, true, "owner", BotSeriesPairingChosen, false},
		{"casual", gamma, false, false, "owner", BotSeriesPairingChosen, true},
		// A round a host moved to casual afterwards is still a round, and says
		// both.
		{"moved", gamma, true, false, "", BotSeriesPairingRound, true},
		// One owner's two engines never rate each other, however the run was
		// seated — which is what a run started before that rule looks like.
		{"one-owner", beta, false, true, "owner", BotSeriesPairingChosen, true},
	}
	for _, entry := range cases {
		created, err := store.CreateBotSeries(ctx, BotSeries{
			SeriesID: "run-" + entry.name, ModeID: game.ModeIntransitive,
			FirstBotID: alpha.BotID, SecondBotID: entry.second.BotID,
			Pairs: 1, InitialTimeMs: 60_000,
			Ladder: entry.ladder, Ranked: entry.ranked, RequestedByUserID: entry.requestedBy,
		})
		if err != nil {
			t.Fatalf("create %s: %v", entry.name, err)
		}
		if created.Pairing != entry.pairing || created.Casual != entry.casual {
			t.Errorf("%s read back as pairing %q, casual %v; want %q, %v",
				entry.name, created.Pairing, created.Casual, entry.pairing, entry.casual)
		}
	}

	// The list the Bots page reads says the same.
	listed, err := store.BotSeriesList(ctx, 20)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(listed) != len(cases) {
		t.Fatalf("listed %d runs, want %d", len(listed), len(cases))
	}
	for _, run := range listed {
		for _, entry := range cases {
			if run.SeriesID == "run-"+entry.name &&
				(run.Pairing != entry.pairing || run.Casual != entry.casual) {
				t.Errorf("listed %s as pairing %q, casual %v; want %q, %v",
					entry.name, run.Pairing, run.Casual, entry.pairing, entry.casual)
			}
		}
	}
}
