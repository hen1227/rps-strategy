package persistence

import (
	"testing"
	"time"

	"rps-strategy/backend/internal/game"
)

// arena runs a two-engine weekend event to the end with `winner` taking every
// game, and returns nothing: what the tests here read is the effect it had.
//
// A helper of its own rather than completedTournament with a flag, because the
// kind is the whole point of it — the crown reads weekend events and the cup
// reads everything else, and a test that could not tell them apart could not
// check either rule.
func arena(t *testing.T, store *Store, id string, winner string, loser string) {
	t.Helper()
	ctx := t.Context()
	config := DefaultTournamentConfig(game.ModeTotalWar, "Total War")
	config.Name = "Weekend " + id
	config.Kind = TournamentWeekend
	if _, err := store.CreateTournament(ctx, id, config); err != nil {
		t.Fatalf("create arena %s: %v", id, err)
	}
	if _, err := store.PublishTournament(ctx, id); err != nil {
		t.Fatalf("publish arena %s: %v", id, err)
	}
	runTwoPlayerEvent(t, store, id, winner, loser)
}

// runTwoPlayerEvent signs two entrants up to a published event and plays it out
// with `winner` taking every match.
func runTwoPlayerEvent(t *testing.T, store *Store, id string, winner string, loser string) {
	t.Helper()
	ctx := t.Context()
	for _, entrant := range []struct{ userID, ign string }{
		{winner, "Winner-" + id},
		{loser, "Loser-" + id},
	} {
		if _, err := store.SignupForTournament(
			ctx, id, entrant.userID, entrant.ign, "handle", true,
		); err != nil {
			t.Fatalf("sign %s up to %s: %v", entrant.userID, id, err)
		}
	}
	tournament, err := store.StartTournament(ctx, id)
	if err != nil {
		t.Fatalf("start %s: %v", id, err)
	}
	for _, match := range tournament.Matches {
		result := MatchPlayer1Win
		if match.Player2.UserID == winner {
			result = MatchPlayer2Win
		}
		if tournament, err = store.SetTournamentMatchResult(
			ctx, id, match.MatchID, result,
		); err != nil {
			t.Fatalf("set a result in %s: %v", id, err)
		}
	}
	if tournament.Status != TournamentCompleted {
		t.Fatalf("%s did not complete: %v", id, tournament.Status)
	}
}

// twoEngines is a pair of engines with different owners.
//
// Different owners is not decoration: an event allows one entry per party, and
// a party is an owner and all of their engines — so a single owner cannot field
// both sides of anything. See tournamentPartyID.
func twoEngines(t *testing.T, store *Store) (Bot, Bot) {
	t.Helper()
	registeredOwner(t, store, "ada", "Ada")
	registeredOwner(t, store, "grace", "Grace")
	return claimedBot(t, store, "ada", "Alpha"), claimedBot(t, store, "grace", "Beta")
}

// completedAgo backdates an event, which is the only way to ask what months of
// silence do to a rule.
func completedAgo(t *testing.T, store *Store, id string, ago time.Duration) {
	t.Helper()
	settledAt(t, store, id, time.Now().Add(-ago).UnixMilli())
}

// settledAt pins an event's completion to an exact instant, which is how two of
// them are made to land in the same millisecond on purpose.
func settledAt(t *testing.T, store *Store, id string, when int64) {
	t.Helper()
	if _, err := store.db.ExecContext(t.Context(), `
UPDATE tournaments SET completed_at_unix_ms = ? WHERE tournament_id = ?
`, when, id); err != nil {
		t.Fatalf("backdate %s: %v", id, err)
	}
}

// syncBots runs the sweep and reports what each engine holds afterwards.
func syncBots(t *testing.T, store *Store) {
	t.Helper()
	if _, err := store.SyncBotTitles(t.Context()); err != nil {
		t.Fatalf("sync bot titles: %v", err)
	}
}

// wears is the tag actually in front of the name, which is the half of this
// feature a player sees.
func wears(t *testing.T, store *Store, userID string) TitleID {
	t.Helper()
	return account(t, store, userID).Title
}

// One crown at a time, and it is on the engine that won the last arena. A win
// the weekend before is in the archive and on the weekend page; what it is not
// is a tag in front of a name.
func TestTheCrownFollowsTheLatestArena(t *testing.T) {
	store := authTestStore(t)
	alpha, beta := twoEngines(t, store)

	arena(t, store, "arena-1", alpha.UserID, beta.UserID)
	completedAgo(t, store, "arena-1", 7*24*time.Hour)
	arena(t, store, "arena-2", beta.UserID, alpha.UserID)
	syncBots(t, store)

	if !holds(t, store, beta.UserID, TitleReigningChampion) {
		t.Error("the latest winner should be reigning champion")
	}
	if holds(t, store, alpha.UserID, TitleReigningChampion) {
		t.Error("last weekend's winner does not still reign")
	}
	if worn := wears(t, store, beta.UserID); worn != TitleReigningChampion {
		t.Errorf("the reigning champion should be wearing the crown, got %q", worn)
	}
	if worn := wears(t, store, alpha.UserID); worn != "" {
		t.Errorf("a succeeded champion wears nothing of its own, got %q", worn)
	}
}

// The crown is taken off again, which is the one way the engine pool is not
// like a person's: two of its three titles are claims about now.
func TestLosingTheArenaTakesTheCrownBack(t *testing.T) {
	store := authTestStore(t)
	alpha, beta := twoEngines(t, store)

	arena(t, store, "arena-1", alpha.UserID, beta.UserID)
	syncBots(t, store)
	if !holds(t, store, alpha.UserID, TitleReigningChampion) {
		t.Fatal("the first winner should reign to begin with")
	}

	arena(t, store, "arena-2", beta.UserID, alpha.UserID)
	syncBots(t, store)
	if holds(t, store, alpha.UserID, TitleReigningChampion) {
		t.Error("a beaten champion keeps nothing; the crown is not a memento")
	}
	if worn := wears(t, store, alpha.UserID); worn != "" {
		t.Errorf("the old champion is left with nothing, got %q", worn)
	}
}

// A series that has not run since the spring still has a champion: the crown is
// about the last field that was beaten, not about when. Taking it off would
// say an engine had lost an arena nobody has played.
func TestADormantSeriesKeepsItsChampion(t *testing.T) {
	store := authTestStore(t)
	alpha, beta := twoEngines(t, store)

	arena(t, store, "old", alpha.UserID, beta.UserID)
	completedAgo(t, store, "old", 300*24*time.Hour)
	syncBots(t, store)

	if !holds(t, store, alpha.UserID, TitleReigningChampion) {
		t.Error("the latest winner is the latest winner however long ago it was")
	}
	if worn := wears(t, store, alpha.UserID); worn != TitleReigningChampion {
		t.Errorf("and it is still wearing the crown, got %q", worn)
	}
}

// Everybody level at the top won it, the same rule the standings use, so a
// crown never turns on who registered first.
func TestASharedArenaCrownsBoth(t *testing.T) {
	store := authTestStore(t)
	alpha, beta := twoEngines(t, store)

	ctx := t.Context()
	config := DefaultTournamentConfig(game.ModeTotalWar, "Total War")
	config.Name = "Drawn"
	config.Kind = TournamentWeekend
	if _, err := store.CreateTournament(ctx, "drawn", config); err != nil {
		t.Fatalf("create arena: %v", err)
	}
	if _, err := store.PublishTournament(ctx, "drawn"); err != nil {
		t.Fatalf("publish arena: %v", err)
	}
	for _, entrant := range []struct{ userID, ign string }{
		{alpha.UserID, "Alpha"}, {beta.UserID, "Beta"},
	} {
		if _, err := store.SignupForTournament(
			ctx, "drawn", entrant.userID, entrant.ign, "handle", true,
		); err != nil {
			t.Fatalf("sign up: %v", err)
		}
	}
	tournament, err := store.StartTournament(ctx, "drawn")
	if err != nil {
		t.Fatalf("start arena: %v", err)
	}
	for _, match := range tournament.Matches {
		if _, err := store.SetTournamentMatchResult(
			ctx, "drawn", match.MatchID, MatchDraw,
		); err != nil {
			t.Fatalf("draw a match: %v", err)
		}
	}
	syncBots(t, store)

	for _, engine := range []string{alpha.UserID, beta.UserID} {
		if !holds(t, store, engine, TitleReigningChampion) {
			t.Errorf("%s finished level at the top and should share the crown", engine)
		}
	}
}

// The two events an engine can win are told apart, and each earns only its own
// tag: a weekend arena is a weekly fixture and a cup is not.
func TestCupWinnerExcludesTheWeekendArena(t *testing.T) {
	store := authTestStore(t)
	alpha, beta := twoEngines(t, store)

	arena(t, store, "weekly", alpha.UserID, beta.UserID)
	syncBots(t, store)
	if holds(t, store, alpha.UserID, TitleCupWinner) {
		t.Error("a weekend arena is not a cup; it has the crowns instead")
	}

	completedTournament(t, store, "cup", beta.UserID, alpha.UserID)
	syncBots(t, store)
	if !holds(t, store, beta.UserID, TitleCupWinner) {
		t.Error("winning an organised tournament should earn Cup Winner")
	}
	// And the same event still makes its owner Bot Master, which is this fact
	// seen from the other side.
	if _, err := store.EvaluateTitlesFor(t.Context(), beta.UserID); err != nil {
		t.Fatalf("evaluate for the owner: %v", err)
	}
	if !holds(t, store, "grace", TitleBotMaster) {
		t.Error("Beta's owner should still collect Bot Master for the engine's win")
	}
}

// The sweep is the whole fleet, and the fleet is engines. A person who somehow
// appears in an engine's event is not given an engine's tag, and no person's
// chosen tag is overwritten by a sweep they had nothing to do with.
func TestTheSweepLeavesPeopleAlone(t *testing.T) {
	store := authTestStore(t)
	registeredOwner(t, store, "ada", "Ada")
	registeredOwner(t, store, "grace", "Grace")
	alpha := claimedBot(t, store, "ada", "Alpha")

	arena(t, store, "mixed", "grace", alpha.UserID)
	if err := store.GrantTitle(t.Context(), "ada", TitleDeveloper); err != nil {
		t.Fatalf("grant DEV: %v", err)
	}
	if _, err := store.SetAccountTitle(t.Context(), "ada", TitleDeveloper); err != nil {
		t.Fatalf("wear DEV: %v", err)
	}
	syncBots(t, store)

	if holds(t, store, "grace", TitleReigningChampion) {
		t.Error("a person cannot hold an engine title, however they came by the win")
	}
	if worn := wears(t, store, "ada"); worn != TitleDeveloper {
		t.Errorf("a person's own choice is theirs; got %q", worn)
	}
}

// A grant is deliberate and outlives the rule, for an engine exactly as it does
// for a person. It is also the one thing an engine wears that no rule chose.
func TestAGrantedTagSurvivesTheSweep(t *testing.T) {
	store := authTestStore(t)
	registeredOwner(t, store, "ada", "Ada")
	registeredOwner(t, store, "grace", "Grace")
	house := claimedBot(t, store, "ada", "House")

	if err := store.GrantTitle(t.Context(), house.UserID, TitleDeveloper); err != nil {
		t.Fatalf("grant DEV to the engine: %v", err)
	}
	syncBots(t, store)
	if !holds(t, store, house.UserID, TitleDeveloper) {
		t.Fatal("the sweep must not delete what an administrator handed out")
	}
	if worn := wears(t, store, house.UserID); worn != TitleDeveloper {
		t.Errorf("an engine with nothing of its own wears the grant, got %q", worn)
	}

	// A crown beats it, because the crown is the thing that is true this week.
	beta := claimedBot(t, store, "grace", "Beta")
	arena(t, store, "arena", house.UserID, beta.UserID)
	syncBots(t, store)
	if worn := wears(t, store, house.UserID); worn != TitleReigningChampion {
		t.Errorf("the crown should outrank a grant, got %q", worn)
	}
}

// A granted engine title is an override of the rule that would otherwise decide
// it, so the sweep leaves it where a rule-awarded one would be taken back.
func TestAGrantedCrownIsNotSweptAway(t *testing.T) {
	store := authTestStore(t)
	registeredOwner(t, store, "ada", "Ada")
	honorary := claimedBot(t, store, "ada", "Honorary")

	if err := store.GrantTitle(t.Context(), honorary.UserID, TitleReigningChampion); err != nil {
		t.Fatalf("grant the crown: %v", err)
	}
	syncBots(t, store)
	if !holds(t, store, honorary.UserID, TitleReigningChampion) {
		t.Error("a granted crown is the administrator's to remove, not the sweep's")
	}
}

// Nothing to do is nothing reported, which is what lets the caller log every
// change it is handed.
func TestASweepWithNothingToSayReportsNothing(t *testing.T) {
	store := authTestStore(t)
	alpha, beta := twoEngines(t, store)
	arena(t, store, "arena", alpha.UserID, beta.UserID)

	first, err := store.SyncBotTitles(t.Context())
	if err != nil {
		t.Fatalf("first sweep: %v", err)
	}
	if len(first) == 0 {
		t.Fatal("the first sweep after an arena should have something to say")
	}
	second, err := store.SyncBotTitles(t.Context())
	if err != nil {
		t.Fatalf("second sweep: %v", err)
	}
	if len(second) != 0 {
		t.Errorf("a sweep that changed nothing should report nothing, got %v", second)
	}
}

// The two pools share a table and nothing else. This is the check that no id
// belongs to both, and that no engine rule can hand out a person's title.
func TestThePoolsDoNotOverlap(t *testing.T) {
	pools := make(map[TitleID]TitlePool)
	for _, title := range TitleCatalogue() {
		if title.Pool != TitlePoolPlayer && title.Pool != TitlePoolBot {
			t.Errorf("title %q has no pool", title.ID)
		}
		if seen, found := pools[title.ID]; found {
			t.Errorf("title %q is in both %s and %s", title.ID, seen, title.Pool)
		}
		pools[title.ID] = title.Pool
	}
	for _, id := range []TitleID{TitleReigningChampion, TitleCupWinner} {
		if pools[id] != TitlePoolBot {
			t.Errorf("%q should be an engine title, got pool %q", id, pools[id])
		}
	}
	for _, id := range []TitleID{TitleGrandmaster, TitleBotArchitect, TitleDiscordVerified} {
		if pools[id] != TitlePoolPlayer {
			t.Errorf("%q should be a player title, got pool %q", id, pools[id])
		}
	}
}

// Two arenas that settle in the same millisecond still crown exactly one
// engine, and it is the later of the two.
//
// A tie is not hypothetical -- a millisecond is a long time, and two events
// settled by the same sweep share one. Left to the timestamp alone the answer
// is whichever row the database happened to hand back first, so the crown on
// the ladder would turn on a query plan.
func TestTwoArenasSettledTogetherCrownTheLaterOne(t *testing.T) {
	store := authTestStore(t)
	alpha, beta := twoEngines(t, store)

	arena(t, store, "arena-1", alpha.UserID, beta.UserID)
	arena(t, store, "arena-2", beta.UserID, alpha.UserID)
	together := time.Now().UnixMilli()
	settledAt(t, store, "arena-1", together)
	settledAt(t, store, "arena-2", together)
	syncBots(t, store)

	if !holds(t, store, beta.UserID, TitleReigningChampion) {
		t.Error("the winner of the later arena should reign")
	}
	if holds(t, store, alpha.UserID, TitleReigningChampion) {
		t.Error("the winner of the earlier arena should not reign")
	}
	if worn := wears(t, store, alpha.UserID); worn != "" {
		t.Errorf("the earlier champion is left with nothing, got %q", worn)
	}
}
