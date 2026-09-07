package persistence

import (
	"errors"
	"testing"

	"rps-strategy/backend/internal/game"
)

// draft builds an unpublished event with a configuration, which is what the
// format tests are actually about.
func draft(t *testing.T, store *Store, id string, config TournamentConfig) Tournament {
	t.Helper()
	config.ModeID = game.ModeTotalWar
	config.ModeName = "Total War"
	if config.Name == "" {
		config.Name = "Cup " + id
	}
	tournament, err := store.CreateTournament(t.Context(), id, config)
	if err != nil {
		t.Fatalf("create %s: %v", id, err)
	}
	return tournament
}

// enter signs a field up, in the order given, which becomes the signup order.
//
// Each name gets a Discord-verified account first, because every entrant needs
// one and none of the tests using this are about that door. The handle stored
// on the signup is therefore the verified one rather than the `name.discord`
// passed here — see the substitution in SignupForTournament.
func enter(t *testing.T, store *Store, id string, names ...string) {
	t.Helper()
	for _, name := range names {
		userID := "user-" + name
		// Claiming upgrades an anonymous account in place, so a test that made
		// one first — to hang a rating off it — still ends up verified.
		if account, err := store.Account(t.Context(), userID); err != nil ||
			!account.DiscordVerified {
			registeredOwner(t, store, userID, name)
		}
		if _, err := store.SignupForTournament(
			t.Context(), id, userID, name, name+".discord", true,
		); err != nil {
			t.Fatalf("sign up %s: %v", name, err)
		}
	}
}

// win records a result for one match, by match id.
func win(t *testing.T, store *Store, id string, matchID int64, result TournamentMatchResult) Tournament {
	t.Helper()
	tournament, err := store.SetTournamentMatchResult(t.Context(), id, matchID, result)
	if err != nil {
		t.Fatalf("set result on match %d: %v", matchID, err)
	}
	return tournament
}

// roundOf is the matches of one round.
func roundOf(tournament Tournament, round int) []TournamentMatch {
	matches := make([]TournamentMatch, 0)
	for _, match := range tournament.Matches {
		if match.RoundNumber == round {
			matches = append(matches, match)
		}
	}
	return matches
}

// A draft takes no signups, and publishing is what opens the door.
//
// The single most important behaviour of the builder: the reason it exists is
// that an event used to be public the instant it was created.
func TestADraftIsNotOpenForSignups(t *testing.T) {
	store, err := Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()

	tournament := draft(t, store, "quiet", TournamentConfig{Name: "Quiet Cup"})
	if tournament.Status != TournamentDraft {
		t.Fatalf("a new tournament should be a draft, got %q", tournament.Status)
	}
	if _, err := store.SignupForTournament(
		t.Context(), "quiet", "user-a", "Ada", "ada.discord", true,
	); !errors.Is(err, ErrTournamentClosed) {
		t.Fatalf("expected a draft to refuse signups, got %v", err)
	}
	if _, err := store.StartTournament(t.Context(), "quiet"); !errors.Is(
		err, ErrInvalidTournament,
	) {
		t.Fatalf("expected a draft to refuse to start, got %v", err)
	}

	published, err := store.PublishTournament(t.Context(), "quiet")
	if err != nil {
		t.Fatalf("publish: %v", err)
	}
	if published.Status != TournamentRegistration || published.PublishedAtUnixMs == nil {
		t.Fatalf("unexpected published tournament: %#v", published)
	}
	enter(t, store, "quiet", "Ada")
}

// Cancelling keeps the record; hiding tidies it off the board; deleting
// removes it. The three are different operations and this is the difference.
func TestCancelHideAndDelete(t *testing.T) {
	store, err := Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()

	draft(t, store, "scrap", TournamentConfig{Name: "Scrap"})
	if _, err := store.DeleteTournament(t.Context(), "scrap"); err != nil {
		t.Fatalf("delete draft: %v", err)
	}
	if _, err := store.Tournament(t.Context(), "scrap"); !errors.Is(err, ErrTournamentNotFound) {
		t.Fatalf("expected the draft to be gone, got %v", err)
	}

	draft(t, store, "real", TournamentConfig{Name: "Real"})
	if _, err := store.PublishTournament(t.Context(), "real"); err != nil {
		t.Fatal(err)
	}
	// An event people can still enter is one they need to find, so it cannot be
	// hidden out from under them. Cancel it first.
	if _, err := store.SetTournamentHidden(t.Context(), "real", true); !errors.Is(
		err, ErrTournamentNotHideable,
	) {
		t.Fatalf("expected an open event to refuse hiding, got %v", err)
	}

	cancelled, err := store.CancelTournament(t.Context(), "real", "venue fell through")
	if err != nil {
		t.Fatalf("cancel: %v", err)
	}
	if cancelled.Status != TournamentCancelled {
		t.Fatalf("expected cancellation, got %q", cancelled.Status)
	}
	// The reason survives where somebody will read it.
	if want := "Cancelled: venue fell through"; cancelled.Description != want {
		t.Fatalf("expected %q in the description, got %q", want, cancelled.Description)
	}
	if _, err := store.SignupForTournament(
		t.Context(), "real", "user-a", "Ada", "ada.discord", true,
	); !errors.Is(err, ErrTournamentCancelled) {
		t.Fatalf("expected a cancelled event to refuse signups, got %v", err)
	}

	// Now it can be hidden, and hiding is reversible and keeps the row.
	hidden, err := store.SetTournamentHidden(t.Context(), "real", true)
	if err != nil {
		t.Fatalf("hide: %v", err)
	}
	if hidden.HiddenAtUnixMs == nil {
		t.Fatal("hiding did not record when")
	}
	// Still there, still readable by id: hiding is a listing decision, not a
	// record decision. What drops it from the board is publicTournaments, on
	// the server side.
	if _, err := store.Tournament(t.Context(), "real"); err != nil {
		t.Fatalf("a hidden event should still be readable: %v", err)
	}
	shown, err := store.SetTournamentHidden(t.Context(), "real", false)
	if err != nil {
		t.Fatalf("unhide: %v", err)
	}
	if shown.HiddenAtUnixMs != nil {
		t.Fatal("unhiding left it hidden")
	}

	// And deleting it works whatever stage it is at, reporting what went.
	deletion, err := store.DeleteTournament(t.Context(), "real")
	if err != nil {
		t.Fatalf("delete: %v", err)
	}
	if deletion.Name != "Real" {
		t.Fatalf("unexpected deletion report: %#v", deletion)
	}
	if _, err := store.Tournament(t.Context(), "real"); !errors.Is(err, ErrTournamentNotFound) {
		t.Fatalf("expected the event to be gone, got %v", err)
	}
}

// The field rule is enforced against the account's kind.
func TestABotsOnlyEventRefusesPeople(t *testing.T) {
	store, err := Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()

	if _, err := store.EnsureAccount(t.Context(), "human-one", "Ada"); err != nil {
		t.Fatal(err)
	}
	draft(t, store, "engines", TournamentConfig{Name: "Engine Cup", Field: FieldBots})
	if _, err := store.PublishTournament(t.Context(), "engines"); err != nil {
		t.Fatal(err)
	}
	if _, err := store.SignupForTournament(
		t.Context(), "engines", "human-one", "Ada", "ada.discord", true,
	); !errors.Is(err, ErrTournamentFieldClosed) {
		t.Fatalf("expected a person to be refused from a bots-only event, got %v", err)
	}
}

// The cap holds, and it cannot be lowered under a field that has already
// entered.
func TestThePlayerCapHolds(t *testing.T) {
	store, err := Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()

	draft(t, store, "small", TournamentConfig{Name: "Small", MaxPlayers: 2})
	if _, err := store.PublishTournament(t.Context(), "small"); err != nil {
		t.Fatal(err)
	}
	enter(t, store, "small", "Ada", "Grace")
	registeredOwner(t, store, "user-Kay", "Kay")
	if _, err := store.SignupForTournament(
		t.Context(), "small", "user-Kay", "Kay", "kay.discord", true,
	); !errors.Is(err, ErrTournamentFull) {
		t.Fatalf("expected the third entrant to be refused, got %v", err)
	}

	config := DefaultTournamentConfig(game.ModeTotalWar, "Total War")
	config.Name = "Small"
	config.MaxPlayers = 1
	if _, err := store.UpdateTournament(t.Context(), "small", config); !errors.Is(
		err, ErrInvalidTournament,
	) {
		t.Fatalf("expected the cap to refuse going below the field, got %v", err)
	}
}

// A double round robin plays every pairing twice, with the seats swapped.
//
// The swap is the assertion that matters: in a game where the first move is an
// advantage, playing the same pairing twice from the same side hands one player
// both openings.
func TestDoubleRoundRobinReversesTheSeats(t *testing.T) {
	store, err := Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()

	draft(t, store, "double", TournamentConfig{Format: FormatDoubleRoundRobin})
	if _, err := store.PublishTournament(t.Context(), "double"); err != nil {
		t.Fatal(err)
	}
	enter(t, store, "double", "Ada", "Grace", "Kay")

	tournament, err := store.StartTournament(t.Context(), "double")
	if err != nil {
		t.Fatalf("start: %v", err)
	}
	// Three players, so three pairings each way.
	if len(tournament.Matches) != 6 {
		t.Fatalf("expected 6 matches, got %d", len(tournament.Matches))
	}
	seats := make(map[[2]int64]int)
	for _, match := range tournament.Matches {
		seats[[2]int64{match.Player1.PlayerID, match.Player2.PlayerID}]++
	}
	if len(seats) != 6 {
		t.Fatalf("expected 6 distinct seatings, got %d: %v", len(seats), seats)
	}
	for pair, count := range seats {
		if count != 1 {
			t.Fatalf("pairing %v was seated the same way %d times", pair, count)
		}
		if seats[[2]int64{pair[1], pair[0]}] != 1 {
			t.Fatalf("pairing %v never had its seats reversed", pair)
		}
	}
}

// A six-player bracket byes its top two seeds and then re-seeds each round.
//
// Six is the interesting size: not a power of two, so the byes have to go
// somewhere, and the whole point of seeding is that they go to the favourites.
func TestSingleEliminationByesTheTopSeeds(t *testing.T) {
	store, err := Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()

	draft(t, store, "bracket", TournamentConfig{Format: FormatSingleElimination})
	if _, err := store.PublishTournament(t.Context(), "bracket"); err != nil {
		t.Fatal(err)
	}
	enter(t, store, "bracket", "One", "Two", "Three", "Four", "Five", "Six")

	tournament, err := store.StartTournament(t.Context(), "bracket")
	if err != nil {
		t.Fatalf("start: %v", err)
	}
	if tournament.Rounds != 3 {
		t.Fatalf("expected a 3-round bracket for six players, got %d", tournament.Rounds)
	}
	if len(tournament.Byes) != 2 {
		t.Fatalf("expected two byes, got %d: %#v", len(tournament.Byes), tournament.Byes)
	}
	for _, bye := range tournament.Byes {
		if bye.Player.Seed > 2 {
			t.Fatalf("a bye went to seed %d rather than to a top seed", bye.Player.Seed)
		}
	}
	first := roundOf(tournament, 1)
	if len(first) != 2 {
		t.Fatalf("expected two opening matches, got %d", len(first))
	}
	// Highest remaining seed against lowest: 3 v 6 and 4 v 5.
	if first[0].Player1.Seed != 3 || first[0].Player2.Seed != 6 {
		t.Fatalf("unexpected opening pairing: %d v %d", first[0].Player1.Seed, first[0].Player2.Seed)
	}

	// Play round one out. The next round should appear by itself.
	for _, match := range first {
		tournament = win(t, store, "bracket", match.MatchID, MatchPlayer1Win)
	}
	second := roundOf(tournament, 2)
	if len(second) != 2 {
		t.Fatalf("expected two semi-finals, got %d: %#v", len(second), tournament.Matches)
	}
	if tournament.Status != TournamentInProgress {
		t.Fatalf("the bracket finished at the semi-finals: %q", tournament.Status)
	}
	// Re-seeded: seed one draws the weakest survivor, which is seed 4.
	if second[0].Player1.Seed != 1 || second[0].Player2.Seed != 4 {
		t.Fatalf("unexpected semi-final: %d v %d", second[0].Player1.Seed, second[0].Player2.Seed)
	}

	for _, match := range second {
		tournament = win(t, store, "bracket", match.MatchID, MatchPlayer1Win)
	}
	final := roundOf(tournament, 3)
	if len(final) != 1 {
		t.Fatalf("expected one final, got %d", len(final))
	}
	tournament = win(t, store, "bracket", final[0].MatchID, MatchPlayer1Win)
	if tournament.Status != TournamentCompleted {
		t.Fatalf("expected the bracket to finish, got %q", tournament.Status)
	}
	// Ranked by how far each entrant got, not by points: the runner-up is
	// second, and everybody knocked out in round one is below the two who lost
	// in the semis.
	if tournament.Standings[0].Seed != 1 {
		t.Fatalf("expected seed 1 to win: %#v", tournament.Standings[0])
	}
	if tournament.Standings[1].Seed != 2 {
		t.Fatalf("expected seed 2 to be runner-up: %#v", tournament.Standings[1])
	}
	if tournament.Standings[0].EliminatedInRound != nil {
		t.Fatal("the champion was marked as eliminated")
	}
	last := tournament.Standings[len(tournament.Standings)-1]
	if last.EliminatedInRound == nil || *last.EliminatedInRound != 1 {
		t.Fatalf("expected the last-placed entrant to go out in round one: %#v", last)
	}
}

// An elimination result cannot be edited once the round it fed has been paired.
func TestAPairedBracketRoundLocksItsResults(t *testing.T) {
	store, err := Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()

	draft(t, store, "locked", TournamentConfig{Format: FormatSingleElimination})
	if _, err := store.PublishTournament(t.Context(), "locked"); err != nil {
		t.Fatal(err)
	}
	enter(t, store, "locked", "One", "Two", "Three", "Four")

	tournament, err := store.StartTournament(t.Context(), "locked")
	if err != nil {
		t.Fatal(err)
	}
	first := roundOf(tournament, 1)
	for _, match := range first {
		tournament = win(t, store, "locked", match.MatchID, MatchPlayer1Win)
	}
	if _, err := store.SetTournamentMatchResult(
		t.Context(), "locked", first[0].MatchID, MatchPlayer2Win,
	); !errors.Is(err, ErrInvalidTournament) {
		t.Fatalf("expected a paired round to lock its results, got %v", err)
	}
}

// Swiss pairs by score, avoids rematches, and byes an odd field once each.
func TestSwissPairsByScoreAndAvoidsRematches(t *testing.T) {
	store, err := Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()

	draft(t, store, "swiss", TournamentConfig{Format: FormatSwiss, SwissRounds: 3})
	if _, err := store.PublishTournament(t.Context(), "swiss"); err != nil {
		t.Fatal(err)
	}
	enter(t, store, "swiss", "One", "Two", "Three", "Four", "Five")

	tournament, err := store.StartTournament(t.Context(), "swiss")
	if err != nil {
		t.Fatalf("start: %v", err)
	}
	if tournament.Rounds != 3 {
		t.Fatalf("expected three rounds, got %d", tournament.Rounds)
	}
	met := make(map[[2]int64]bool)
	byes := make(map[int64]int)
	for round := 1; round <= 3; round++ {
		matches := roundOf(tournament, round)
		if len(matches) != 2 {
			t.Fatalf("round %d has %d matches, expected 2", round, len(matches))
		}
		for _, match := range matches {
			key := pairKey(match.Player1.PlayerID, match.Player2.PlayerID)
			if met[key] {
				t.Fatalf("round %d repeated a pairing", round)
			}
			met[key] = true
			tournament = win(t, store, "swiss", match.MatchID, MatchPlayer1Win)
		}
		for _, bye := range tournament.Byes {
			if bye.RoundNumber == round {
				byes[bye.PlayerID]++
			}
		}
	}
	if tournament.Status != TournamentCompleted {
		t.Fatalf("expected the event to finish after three rounds, got %q", tournament.Status)
	}
	// One bye a round in a five-player field, and never twice to the same
	// player while somebody has not had one.
	if len(byes) != 3 {
		t.Fatalf("expected three different players to take a bye, got %v", byes)
	}
	for playerID, count := range byes {
		if count != 1 {
			t.Fatalf("player %d took %d byes", playerID, count)
		}
	}
	// A bye is a full point, so the standings have to account for it: total
	// wins across the field is two per round plus one bye per round.
	totalWins := 0
	for _, standing := range tournament.Standings {
		totalWins += standing.Wins
	}
	if totalWins != 9 {
		t.Fatalf("expected 9 wins across the field (6 played, 3 byes), got %d", totalWins)
	}
}

// Seeding by rating puts the strongest first, using the event's own mode.
func TestSeedingByRatingOrdersTheField(t *testing.T) {
	store, err := Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()

	// Three accounts with different ratings in the event's mode.
	for name, elo := range map[string]int{"Ada": 1400, "Grace": 1600, "Kay": 1500} {
		if _, err := store.EnsureAccount(t.Context(), "user-"+name, name); err != nil {
			t.Fatal(err)
		}
		// Written directly, the way the leaderboard tests seed a ladder: the
		// public path to a mode rating is playing a rated game, and three
		// games between three people is a great deal of scaffolding for one
		// question about ordering.
		if _, err := store.db.ExecContext(t.Context(), `
INSERT INTO account_mode_ratings (user_id, mode_id, elo, created_at_unix_ms, updated_at_unix_ms)
VALUES (?, ?, ?, 1, 1)
`, "user-"+name, game.ModeTotalWar, elo); err != nil {
			t.Fatalf("seed rating for %s: %v", name, err)
		}
	}

	draft(t, store, "seeded", TournamentConfig{Seeding: SeedByRating})
	if _, err := store.PublishTournament(t.Context(), "seeded"); err != nil {
		t.Fatal(err)
	}
	// Entered weakest first, so signup order and rating order disagree.
	enter(t, store, "seeded", "Ada", "Kay", "Grace")

	tournament, err := store.StartTournament(t.Context(), "seeded")
	if err != nil {
		t.Fatalf("start: %v", err)
	}
	seedOf := make(map[string]int, 3)
	for _, player := range tournament.Players {
		seedOf[player.IGN] = player.Seed
	}
	if seedOf["Grace"] != 1 || seedOf["Kay"] != 2 || seedOf["Ada"] != 3 {
		t.Fatalf("expected seeding by rating, got %v", seedOf)
	}
}

// Deleting a completed event names the champion it is about to un-crown.
//
// The Tournament Champion title is recomputed from this table rather than
// stored — see tournamentTitles — so deleting the event takes the title away at
// the next evaluation. That is invisible unless the deletion says so, which is
// what the report is for.
func TestDeletingACompletedEventReportsItsChampion(t *testing.T) {
	store, err := Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()

	draft(t, store, "crowned", TournamentConfig{Name: "Crowned"})
	if _, err := store.PublishTournament(t.Context(), "crowned"); err != nil {
		t.Fatal(err)
	}
	enter(t, store, "crowned", "Ada", "Grace")
	tournament, err := store.StartTournament(t.Context(), "crowned")
	if err != nil {
		t.Fatal(err)
	}
	// One pairing, one result: Ada wins the event.
	winner := tournament.Matches[0].Player1
	tournament = win(t, store, "crowned", tournament.Matches[0].MatchID, MatchPlayer1Win)
	if tournament.Status != TournamentCompleted {
		t.Fatalf("expected the event to finish, got %q", tournament.Status)
	}

	deletion, err := store.DeleteTournament(t.Context(), "crowned")
	if err != nil {
		t.Fatalf("delete: %v", err)
	}
	if len(deletion.ChampionUserIDs) != 1 || deletion.ChampionUserIDs[0] != winner.UserID {
		t.Fatalf(
			"expected the champion %q to be named, got %v",
			winner.UserID, deletion.ChampionUserIDs,
		)
	}
	if deletion.PlayersDeleted != 2 || deletion.MatchesDeleted != 1 {
		t.Fatalf("unexpected deletion scope: %#v", deletion)
	}
}

// Requiring a verified Discord is a second door beside the field rule: it
// refuses a person who has not linked one, admits one who has, and is not
// asked of engines — which is the part that would otherwise make a bots-only
// event with the box ticked admit nobody at all.
func TestEveryEntrantMustBeVerifiedWithDiscord(t *testing.T) {
	store := authTestStore(t)

	// An account that has clicked around anonymously and never linked Discord.
	if _, err := store.EnsureAccount(t.Context(), "unlinked", "Ada"); err != nil {
		t.Fatal(err)
	}
	// One that has. registeredOwner is exactly that: an account claimed with a
	// Discord identity.
	registeredOwner(t, store, "linked", "Babbage")
	openTournament(t, store, "cup", "Verified Cup", game.ModeTotalWar, "Total War")

	if _, err := store.SignupForTournament(
		t.Context(), "cup", "unlinked", "Ada", "ada.discord", true,
	); !errors.Is(err, ErrTournamentDiscordRequired) {
		t.Fatalf("an unverified account must be refused, got %v", err)
	}
	// Somebody with no account at all has verified nothing either.
	if _, err := store.SignupForTournament(
		t.Context(), "cup", "nobody", "Nobody", "nobody.discord", true,
	); !errors.Is(err, ErrTournamentDiscordRequired) {
		t.Fatalf("an account with no record must be refused, got %v", err)
	}

	// The verified one is in, and carries the handle Discord vouched for rather
	// than the one typed into the form.
	tournament, err := store.SignupForTournament(
		t.Context(), "cup", "linked", "Babbage", "somebody.else", true,
	)
	if err != nil {
		t.Fatalf("a verified account must be admitted: %v", err)
	}
	if len(tournament.Players) != 1 {
		t.Fatalf("expected one entrant, got %d", len(tournament.Players))
	}
	if tournament.Players[0].Discord != "Babbage" {
		t.Fatalf(
			"the signup should carry the verified handle, got %q",
			tournament.Players[0].Discord,
		)
	}
}

// An engine has no Discord account and never will, so the question is asked of
// the person who entered it.
func TestAnEngineIsVerifiedThroughItsOwner(t *testing.T) {
	store := authTestStore(t)
	registeredOwner(t, store, "linked", "Owner")
	// An owner who never linked Discord — a legacy password account. Their
	// engine is as unreachable as they are, which is the whole reason the door
	// exists.
	legacyOwner(t, store, "unlinked", "Stranger")
	verified := claimedBot(t, store, "linked", "Engine")
	unverified := claimedBot(t, store, "unlinked", "Orphan")

	draft(t, store, "engines", TournamentConfig{Name: "Engine Cup", Field: FieldBots})
	if _, err := store.PublishTournament(t.Context(), "engines"); err != nil {
		t.Fatal(err)
	}

	if _, err := store.SignupForTournament(
		t.Context(), "engines", unverified.UserID, "Orphan", "bot.orphan", true,
	); !errors.Is(err, ErrTournamentDiscordRequired) {
		t.Fatalf("an engine whose owner is unverified must be refused, got %v", err)
	}

	tournament, err := store.SignupForTournament(
		t.Context(), "engines", verified.UserID, "Engine", "bot.engine", true,
	)
	if err != nil {
		t.Fatalf("an engine with a verified owner must be admitted: %v", err)
	}
	// And it is reachable at its author's handle rather than at a synthetic one
	// that reaches nobody.
	if len(tournament.Players) != 1 || tournament.Players[0].Discord != "Owner" {
		t.Fatalf("expected the owner's handle on the entry, got %#v", tournament.Players)
	}
}
