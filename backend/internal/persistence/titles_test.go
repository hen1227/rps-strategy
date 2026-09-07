package persistence

import (
	"errors"
	"fmt"
	"testing"

	"rps-strategy/backend/internal/game"
)

// titleIDs is what a collection reads as, so a test can state the expected
// answer as a list rather than by searching the slice.
func titleIDs(awards []TitleAward) []TitleID {
	ids := make([]TitleID, 0, len(awards))
	for _, award := range awards {
		ids = append(ids, award.ID)
	}
	return ids
}

func holds(t *testing.T, store *Store, userID string, id TitleID) bool {
	t.Helper()
	awards, err := store.AccountTitles(t.Context(), userID)
	if err != nil {
		t.Fatalf("read titles for %s: %v", userID, err)
	}
	for _, award := range awards {
		if award.ID == id {
			return true
		}
	}
	return false
}

func evaluate(t *testing.T, store *Store, userID string) []TitleID {
	t.Helper()
	awarded, err := store.EvaluateTitles(t.Context(), userID)
	if err != nil {
		t.Fatalf("evaluate titles for %s: %v", userID, err)
	}
	return besidesDiscordVerified(titleIDs(awarded))
}

// besidesDiscordVerified drops D from a list of awards.
//
// Every fixture in this file registers through Discord, because that is how an
// account is registered — so every one of them earns D on top of whatever the
// test is about, and a ladder test that had to name it would be stating
// something it is not checking. The D rule has its own tests below, and they do
// not go through this.
func besidesDiscordVerified(ids []TitleID) []TitleID {
	kept := make([]TitleID, 0, len(ids))
	for _, id := range ids {
		if id != TitleDiscordVerified {
			kept = append(kept, id)
		}
	}
	return kept
}

// The tag is rendered inside a name row that has budgeted three characters for
// it, and the catalogue is a constant — so this is the check that a new entry
// cannot quietly break every layout that draws one.
func TestEveryTitleFitsItsSlotAndIsUnique(t *testing.T) {
	seen := make(map[TitleID]bool)
	for _, title := range TitleCatalogue() {
		if title.ID == "" || len(title.ID) > MaximumTitleLength {
			t.Errorf("title %q must be 1 to %d characters", title.ID, MaximumTitleLength)
		}
		if seen[title.ID] {
			t.Errorf("duplicate title id %q", title.ID)
		}
		seen[title.ID] = true
		if title.Name == "" || title.Requirement == "" {
			t.Errorf("title %q needs a name and a requirement: %#v", title.ID, title)
		}
	}
	if len(seen) != len(titleCatalogue) {
		t.Fatalf("catalogue lost entries to duplicate ids")
	}
}

// Clearing a rung awards it *and* everything below it, which is what makes the
// ladder a collection rather than one slot: a player who would rather wear the
// modest tag can, and the picker has something to pick from.
func TestRatingLadderAwardsEveryRungCleared(t *testing.T) {
	store := authTestStore(t)
	registeredOwner(t, store, "ada", "Ada")
	seedModeRating(t, store, "ada", game.ModeTotalWar, 1850, 12)

	awarded := evaluate(t, store, "ada")
	if len(awarded) != 3 ||
		awarded[0] != TitleInternationalMaster ||
		awarded[1] != TitleMaster ||
		awarded[2] != TitleCandidateMaster {
		t.Fatalf("expected IM, FM and CM in that order, got %v", awarded)
	}
	if holds(t, store, "ada", TitleGrandmaster) {
		t.Fatal("1850 is not a Grandmaster rating")
	}
	// Idempotent: the second pass has nothing new to say.
	if again := evaluate(t, store, "ada"); len(again) != 0 {
		t.Fatalf("re-evaluating awarded titles again: %v", again)
	}
}

// A rating nobody has tested is a starting value, not an achievement — the same
// rule the leaderboard applies before it will list somebody.
func TestRatingLadderIgnoresAnUntestedRating(t *testing.T) {
	store := authTestStore(t)
	registeredOwner(t, store, "ada", "Ada")
	seedModeRating(t, store, "ada", game.ModeTotalWar, 2400, titleLadderMinimumGames-1)

	if awarded := evaluate(t, store, "ada"); len(awarded) != 0 {
		t.Fatalf("a rating with too few games behind it earns nothing, got %v", awarded)
	}
}

// Modes rate independently, so a specialist is titled for the mode they
// specialise in. Requiring the bar everywhere would title nobody.
func TestRatingLadderReadsTheStrongestMode(t *testing.T) {
	store := authTestStore(t)
	registeredOwner(t, store, "ada", "Ada")
	seedModeRating(t, store, "ada", game.ModeTotalWar, 1250, 30)
	seedModeRating(t, store, "ada", game.ModeInfiltration, 1650, 11)

	if awarded := evaluate(t, store, "ada"); len(awarded) != 2 ||
		awarded[0] != TitleMaster || awarded[1] != TitleCandidateMaster {
		t.Fatalf("expected FM and CM from the stronger mode, got %v", awarded)
	}
}

// Like a chess title: earned once, held for life. A bad month does not take it
// back, which is the whole reason it is worth collecting.
func TestATitleSurvivesTheRatingThatEarnedIt(t *testing.T) {
	store := authTestStore(t)
	registeredOwner(t, store, "ada", "Ada")
	seedModeRating(t, store, "ada", game.ModeTotalWar, 1620, 25)
	if awarded := evaluate(t, store, "ada"); len(awarded) != 2 {
		t.Fatalf("expected FM and CM, got %v", awarded)
	}

	if _, err := store.db.ExecContext(t.Context(), `
UPDATE account_mode_ratings SET elo = 1100 WHERE user_id = 'ada'
`); err != nil {
		t.Fatalf("drop rating: %v", err)
	}
	if awarded := evaluate(t, store, "ada"); len(awarded) != 0 {
		t.Fatalf("a fallen rating should award nothing new, got %v", awarded)
	}
	if !holds(t, store, "ada", TitleMaster) {
		t.Fatal("a title earned is a title kept")
	}
}

// Without the ownership clause the title is bought rather than won: register a
// bot, tell it to lose, and the tag is yours.
func TestBotSlayerNeedsSomebodyElsesEngine(t *testing.T) {
	store := authTestStore(t)
	registeredOwner(t, store, "ada", "Ada")
	registeredOwner(t, store, "grace", "Grace")

	mine := claimedBot(t, store, "ada", "Mine")
	theirs := claimedBot(t, store, "grace", "Theirs")
	adaAccount := account(t, store, "ada")

	seedGame(t, store, "farm", adaAccount, account(t, store, mine.UserID), 1_000)
	if awarded := evaluate(t, store, "ada"); len(awarded) != 0 {
		t.Fatalf("beating your own engine earns nothing, got %v", awarded)
	}

	seedGame(t, store, "real", adaAccount, account(t, store, theirs.UserID), 2_000)
	if awarded := evaluate(t, store, "ada"); len(awarded) != 1 ||
		awarded[0] != TitleBotSlayer {
		t.Fatalf("expected Bot Slayer, got %v", awarded)
	}
}

// Losing to an engine is not beating one. seedGame always files a Red win, so
// the person sits Blue here.
func TestBotSlayerNeedsAWin(t *testing.T) {
	store := authTestStore(t)
	registeredOwner(t, store, "ada", "Ada")
	registeredOwner(t, store, "grace", "Grace")
	theirs := claimedBot(t, store, "grace", "Theirs")

	seedGame(t, store, "loss", account(t, store, theirs.UserID), account(t, store, "ada"), 1_000)
	if awarded := evaluate(t, store, "ada"); len(awarded) != 0 {
		t.Fatalf("losing to an engine earns nothing, got %v", awarded)
	}
}

// The title and the bot board have to agree about who is top, so this reads the
// same rows the ladder ranks.
func TestBotArchitectFollowsTheTopOfTheBotLadder(t *testing.T) {
	store := authTestStore(t)
	registeredOwner(t, store, "ada", "Ada")
	registeredOwner(t, store, "grace", "Grace")
	mine := claimedBot(t, store, "ada", "Mine")
	theirs := claimedBot(t, store, "grace", "Theirs")

	seedModeRating(t, store, mine.UserID, game.ModeTotalWar, 1400, 20)
	seedModeRating(t, store, theirs.UserID, game.ModeTotalWar, 1900, 20)

	if awarded := evaluate(t, store, "ada"); len(awarded) != 0 {
		t.Fatalf("owning the second-best engine earns nothing, got %v", awarded)
	}
	if awarded := evaluate(t, store, "grace"); len(awarded) != 1 ||
		awarded[0] != TitleBotArchitect {
		t.Fatalf("expected Bot Architect for the top engine's owner, got %v", awarded)
	}

	// An engine does not collect anything itself. Its rating comes from a fit
	// across every pair's record and is not on a person's scale.
	if awarded := evaluate(t, store, theirs.UserID); len(awarded) != 0 {
		t.Fatalf("a bot account earns nothing, got %v", awarded)
	}
}

// completedTournament runs a two-player tournament to the end with `winner`
// taking every game, and returns its id.
func completedTournament(t *testing.T, store *Store, id string, winner string, loser string) {
	t.Helper()
	ctx := t.Context()
	openTournament(t, store, id, "Cup "+id, game.ModeTotalWar, "Total War")
	for _, entrant := range []struct{ userID, ign string }{
		{winner, "Winner-" + id},
		{loser, "Loser-" + id},
	} {
		if _, err := store.SignupForTournament(
			ctx, id, entrant.userID, entrant.ign, "handle", true,
		); err != nil {
			t.Fatalf("sign %s up: %v", entrant.userID, err)
		}
	}
	tournament, err := store.StartTournament(ctx, id)
	if err != nil {
		t.Fatalf("start tournament: %v", err)
	}
	for _, match := range tournament.Matches {
		result := MatchPlayer1Win
		if match.Player2.UserID == winner {
			result = MatchPlayer2Win
		}
		if tournament, err = store.SetTournamentMatchResult(
			ctx, id, match.MatchID, result,
		); err != nil {
			t.Fatalf("set match result: %v", err)
		}
	}
	if tournament.Status != TournamentCompleted {
		t.Fatalf("tournament did not complete: %#v", tournament.Status)
	}
}

func TestTournamentChampionIsAwardedOnceTheTournamentEnds(t *testing.T) {
	store := authTestStore(t)
	registeredOwner(t, store, "ada", "Ada")
	registeredOwner(t, store, "grace", "Grace")

	openTournament(t, store, "cup", "Cup", game.ModeTotalWar, "Total War")
	for _, entrant := range []struct{ userID, ign string }{{"ada", "Ada"}, {"grace", "Grace"}} {
		if _, err := store.SignupForTournament(
			t.Context(), "cup", entrant.userID, entrant.ign, "handle", true,
		); err != nil {
			t.Fatalf("sign up: %v", err)
		}
	}
	// Leading a tournament is not winning one, and a title cannot be taken
	// back — so nothing is awarded until the last result is in.
	if _, err := store.StartTournament(t.Context(), "cup"); err != nil {
		t.Fatalf("start tournament: %v", err)
	}
	if awarded := evaluate(t, store, "ada"); len(awarded) != 0 {
		t.Fatalf("an unfinished tournament crowns nobody, got %v", awarded)
	}

	completedTournament(t, store, "cup-2", "ada", "grace")
	if awarded := evaluate(t, store, "ada"); len(awarded) != 1 ||
		awarded[0] != TitleTournamentChampion {
		t.Fatalf("expected Tournament Champion, got %v", awarded)
	}
	if awarded := evaluate(t, store, "grace"); len(awarded) != 0 {
		t.Fatalf("the runner-up wins nothing, got %v", awarded)
	}
}

// An engine's tournament win belongs to whoever wrote it, which is who turns up
// in chat wearing the tag.
func TestBotMasterFollowsAnEnginesTournamentWin(t *testing.T) {
	store := authTestStore(t)
	registeredOwner(t, store, "ada", "Ada")
	registeredOwner(t, store, "grace", "Grace")
	mine := claimedBot(t, store, "ada", "Mine")

	completedTournament(t, store, "engine-cup", mine.UserID, "grace")

	awarded, err := store.EvaluateTitlesFor(t.Context(), mine.UserID)
	if err != nil {
		t.Fatalf("evaluate for the bot: %v", err)
	}
	titles := besidesDiscordVerified(titleIDs(awarded["ada"]))
	if len(titles) != 1 || titles[0] != TitleBotMaster {
		t.Fatalf("expected the owner to be made Bot Master, got %v", awarded)
	}
	// The owner did not play, so they are not the champion themselves.
	if holds(t, store, "ada", TitleTournamentChampion) {
		t.Fatal("an engine's win is not its owner's own championship")
	}
	if holds(t, store, mine.UserID, TitleBotMaster) {
		t.Fatal("the engine itself collects nothing")
	}
}

func TestWearingATitleRequiresOwningIt(t *testing.T) {
	store := authTestStore(t)
	registeredOwner(t, store, "ada", "Ada")
	ctx := t.Context()

	if _, err := store.SetAccountTitle(ctx, "ada", TitleGrandmaster); !errors.Is(
		err, ErrTitleNotOwned,
	) {
		t.Fatalf("expected an unowned title to be refused, got %v", err)
	}
	if _, err := store.SetAccountTitle(ctx, "ada", "WHO"); !errors.Is(err, ErrUnknownTitle) {
		t.Fatalf("expected an unknown title to be refused, got %v", err)
	}

	if err := store.GrantTitle(ctx, "ada", TitleDeveloper); err != nil {
		t.Fatalf("grant: %v", err)
	}
	worn, err := store.SetAccountTitle(ctx, "ada", TitleDeveloper)
	if err != nil {
		t.Fatalf("wear a granted title: %v", err)
	}
	if worn.Title != TitleDeveloper {
		t.Fatalf("title was not worn: %#v", worn.Title)
	}
	// Wearing none is always allowed, and is the default.
	bare, err := store.SetAccountTitle(ctx, "ada", "")
	if err != nil {
		t.Fatalf("clear the title: %v", err)
	}
	if bare.Title != "" {
		t.Fatalf("title was not cleared: %#v", bare.Title)
	}
}

func TestRevokingTakesTheTitleOffTheName(t *testing.T) {
	store := authTestStore(t)
	registeredOwner(t, store, "ada", "Ada")
	ctx := t.Context()

	if err := store.GrantTitle(ctx, "ada", TitleModerator); err != nil {
		t.Fatalf("grant: %v", err)
	}
	if _, err := store.SetAccountTitle(ctx, "ada", TitleModerator); err != nil {
		t.Fatalf("wear: %v", err)
	}
	if err := store.RevokeTitle(ctx, "ada", TitleModerator); err != nil {
		t.Fatalf("revoke: %v", err)
	}
	after := account(t, store, "ada")
	if after.Title != "" {
		t.Fatalf("a revoked title must come off the name, got %q", after.Title)
	}
	if len(after.Titles) != 0 {
		t.Fatalf("expected an empty collection, got %v", titleIDs(after.Titles))
	}
	// Nothing earns MOD, so re-evaluating cannot hand it back.
	if awarded := evaluate(t, store, "ada"); len(awarded) != 0 {
		t.Fatalf("a granted title must stay revoked, got %v", awarded)
	}
}

// A grant is a decision, not a shortcut to the rules: once an administrator has
// said somebody holds a title, a later evaluation must not be able to reclassify
// the row and let a revocation be undone by the next finished game.
func TestAGrantOutlivesTheRuleThatWouldAlsoAwardIt(t *testing.T) {
	store := authTestStore(t)
	registeredOwner(t, store, "ada", "Ada")
	ctx := t.Context()

	if err := store.GrantTitle(ctx, "ada", TitleCandidateMaster); err != nil {
		t.Fatalf("grant: %v", err)
	}
	seedModeRating(t, store, "ada", game.ModeTotalWar, 1450, 20)
	if awarded := evaluate(t, store, "ada"); len(awarded) != 0 {
		t.Fatalf("a held title is not awarded twice, got %v", awarded)
	}
	held, err := store.AccountTitles(ctx, "ada")
	if err != nil {
		t.Fatalf("read titles: %v", err)
	}
	granted := false
	for _, award := range held {
		if award.ID == TitleCandidateMaster {
			granted = award.Source == TitleSourceGranted
		}
	}
	if !granted {
		t.Fatalf("the grant should have survived the evaluation: %#v", held)
	}
}

func TestUnknownStoredTitlesAreSkippedRatherThanRendered(t *testing.T) {
	store := authTestStore(t)
	registeredOwner(t, store, "ada", "Ada")

	// The shape a renamed or retired title leaves behind.
	if _, err := store.db.ExecContext(t.Context(), `
INSERT INTO account_titles (user_id, title_id, source, awarded_at_unix_ms)
VALUES ('ada', 'XYZ', 'earned', 1)
`); err != nil {
		t.Fatalf("seed a stale title: %v", err)
	}
	held, err := store.AccountTitles(t.Context(), "ada")
	if err != nil {
		t.Fatalf("read titles: %v", err)
	}
	if len(held) != 0 {
		t.Fatalf("a title the catalogue no longer knows must not be shown: %v", titleIDs(held))
	}
}

func TestGrantingAnUnknownTitleOrAMissingAccountIsRefused(t *testing.T) {
	store := authTestStore(t)
	registeredOwner(t, store, "ada", "Ada")
	ctx := t.Context()

	if err := store.GrantTitle(ctx, "ada", "NOPE"); !errors.Is(err, ErrUnknownTitle) {
		t.Fatalf("expected an unknown title to be refused, got %v", err)
	}
	if err := store.GrantTitle(ctx, "nobody", TitleDeveloper); !errors.Is(
		err, ErrAccountNotFound,
	) {
		t.Fatalf("expected a missing account to be refused, got %v", err)
	}
}

// Titles are part of the public identity anonymization exists to remove. A
// "Deleted player" still wearing GM is recognisable to everyone who was there.
func TestAnonymizingAnAccountTakesItsTitlesWithIt(t *testing.T) {
	store := authTestStore(t)
	registeredOwner(t, store, "ada", "Ada")
	registeredOwner(t, store, "grace", "Grace")
	ctx := t.Context()

	seedModeRating(t, store, "ada", game.ModeTotalWar, 1700, 30)
	if awarded := evaluate(t, store, "ada"); len(awarded) != 2 {
		t.Fatalf("expected FM and CM, got %v", awarded)
	}
	if err := store.GrantTitle(ctx, "ada", TitleDeveloper); err != nil {
		t.Fatal(err)
	}
	if _, err := store.SetAccountTitle(ctx, "ada", TitleMaster); err != nil {
		t.Fatal(err)
	}
	// Anonymization keeps an account that has played, so give it a game to
	// keep: the branch that deletes outright never reaches the stripping.
	seedGame(t, store, "played", account(t, store, "ada"), account(t, store, "grace"), 1_000)

	if _, err := store.AnonymizeAccount(ctx, "ada"); err != nil {
		t.Fatalf("anonymize: %v", err)
	}
	after := account(t, store, "ada")
	if after.Title != "" {
		t.Fatalf("an anonymized account must wear nothing, got %q", after.Title)
	}
	if len(after.Titles) != 0 {
		t.Fatalf("an anonymized account must hold nothing, got %v", titleIDs(after.Titles))
	}
}

// titleGame is one finished rated game with the two things the streak rule
// reads: who won it, and when. seedGame files a Red win every time, and a run
// of wins is only a run because of what sits between them.
type titleGame struct {
	id   string
	red  string
	blue string
	// winner is a user id, or "" for a draw.
	winner     string
	finishedAt int64
}

func seedTitleGame(t *testing.T, store *Store, seed titleGame) {
	t.Helper()
	outcome, winnerColor := "draw", "Neutral"
	var winner any
	switch seed.winner {
	case seed.red:
		outcome, winnerColor, winner = "red_win", "Red", seed.red
	case seed.blue:
		outcome, winnerColor, winner = "blue_win", "Blue", seed.blue
	}
	if _, err := store.db.ExecContext(t.Context(), `
INSERT INTO game_history (
    game_id, mode_id, mode_name,
    red_player_id, red_username, blue_player_id, blue_username,
    winner_player_id, winner_color, outcome, end_reason, ranked,
    red_elo_before, red_elo_after, blue_elo_before, blue_elo_after,
    move_number, initial_time_ms, increment_ms,
    started_at_unix_ms, finished_at_unix_ms
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'resignation', 1,
          1200, 1200, 1200, 1200, 30, 60000, 0, ?, ?)
`,
		seed.id, game.ModeTotalWar, "Total War",
		seed.red, seed.red, seed.blue, seed.blue,
		winner, winnerColor, outcome,
		seed.finishedAt, seed.finishedAt,
	); err != nil {
		t.Fatalf("seed game %s: %v", seed.id, err)
	}
}

// Grandmaster is the top of the ladder, and no rating clears anything above it.
// The rung that used to sit there has been withdrawn, so this is the test that
// says the ladder ends here rather than merely that nobody has passed it.
func TestTheLadderTopsOutAtGrandmaster(t *testing.T) {
	store := authTestStore(t)
	registeredOwner(t, store, "ada", "Ada")
	seedModeRating(t, store, "ada", game.ModeTotalWar, 2500, 40)

	awarded := evaluate(t, store, "ada")
	if len(awarded) != 4 || awarded[0] != TitleGrandmaster {
		t.Fatalf("expected GM and the three below it, got %v", awarded)
	}
	if again := evaluate(t, store, "ada"); len(again) != 0 {
		t.Fatalf("there is nothing above GM to award, got %v", again)
	}
	for _, rung := range ratingLadder {
		if rung.minimumElo > 2000 {
			t.Fatalf("the ladder has a rung above Grandmaster: %s", rung.id)
		}
	}
}

// A title that has left the catalogue comes off the name that was wearing it.
// Owning it is another matter — reads drop what the catalogue cannot resolve —
// but the worn column is read straight into a tag, so a withdrawn id left there
// would be a mark nothing on the site could explain.
func TestAWithdrawnTitleComesOffTheName(t *testing.T) {
	store := authTestStore(t)
	registeredOwner(t, store, "ada", "Ada")
	ctx := t.Context()
	if _, err := store.db.ExecContext(ctx, `
UPDATE accounts SET title = 'SGM' WHERE user_id = 'ada'
`); err != nil {
		t.Fatalf("wear a withdrawn title: %v", err)
	}
	if err := store.retireWithdrawnTitles(ctx); err != nil {
		t.Fatalf("retire: %v", err)
	}
	if worn := account(t, store, "ada").Title; worn != "" {
		t.Fatalf("a withdrawn title must come off the name, got %q", worn)
	}

	// And a title that is still in the catalogue stays on.
	if err := store.GrantTitle(ctx, "ada", TitleGrandmaster); err != nil {
		t.Fatalf("grant: %v", err)
	}
	if _, err := store.SetAccountTitle(ctx, "ada", TitleGrandmaster); err != nil {
		t.Fatalf("wear GM: %v", err)
	}
	if err := store.retireWithdrawnTitles(ctx); err != nil {
		t.Fatalf("retire: %v", err)
	}
	if worn := account(t, store, "ada").Title; worn != TitleGrandmaster {
		t.Fatalf("GM is in the catalogue and must stay on, got %q", worn)
	}
}

// A run with nothing in between, and the longest run ever rather than the one
// happening now — a streak finished last week is still a streak.
func TestHotStreakCountsTheLongestUnbrokenRun(t *testing.T) {
	store := authTestStore(t)
	registeredOwner(t, store, "ada", "Ada")
	registeredOwner(t, store, "grace", "Grace")

	finished := int64(0)
	win := func(id string) {
		finished += 1_000
		seedTitleGame(t, store, titleGame{
			id: id, red: "ada", blue: "grace", winner: "ada", finishedAt: finished,
		})
	}

	for index := range titleWinStreakLength - 1 {
		win(fmt.Sprintf("first-%d", index))
	}
	if awarded := evaluate(t, store, "ada"); len(awarded) != 0 {
		t.Fatalf("one win short of the run earns nothing, got %v", awarded)
	}

	// A draw is not a win, so it ends the run rather than extending it.
	finished += 1_000
	seedTitleGame(t, store, titleGame{
		id: "drawn", red: "ada", blue: "grace", finishedAt: finished,
	})
	for index := range titleWinStreakLength - 1 {
		win(fmt.Sprintf("second-%d", index))
	}
	if awarded := evaluate(t, store, "ada"); len(awarded) != 0 {
		t.Fatalf("a draw breaks the run, got %v", awarded)
	}

	win("eighth")
	if awarded := evaluate(t, store, "ada"); len(awarded) != 1 ||
		awarded[0] != TitleHotStreak {
		t.Fatalf("expected Hot Streak, got %v", awarded)
	}
}

// Veteran is handed out rather than counted. How much play deserves it is a
// judgement, and this is the test that stops somebody quietly turning it back
// into a threshold.
func TestVeteranIsGivenRatherThanEarned(t *testing.T) {
	store := authTestStore(t)
	registeredOwner(t, store, "ada", "Ada")
	registeredOwner(t, store, "grace", "Grace")

	// Losses throughout, so no other rule in the book fires either.
	for index := range 150 {
		seedTitleGame(t, store, titleGame{
			id: fmt.Sprintf("rated-%d", index), red: "grace", blue: "ada",
			winner: "grace", finishedAt: int64(index+1) * 1_000,
		})
	}
	if awarded := evaluate(t, store, "ada"); len(awarded) != 0 {
		t.Fatalf("no amount of play earns Veteran, got %v", awarded)
	}

	if err := store.GrantTitle(t.Context(), "ada", TitleVeteran); err != nil {
		t.Fatalf("grant Veteran: %v", err)
	}
	if !holds(t, store, "ada", TitleVeteran) {
		t.Fatal("an administrator is the only way to hold Veteran")
	}
}

// D is the one title with no bar to clear, so the only thing to check is that
// it follows the link rather than the account: an anonymous account holds
// nothing, and the same account holds D the moment Discord vouches for it.
func TestDiscordVerifiedFollowsTheLink(t *testing.T) {
	store := authTestStore(t)
	ctx := t.Context()
	if _, err := store.EnsureAccountWithProfileKey(ctx, "anon", "Anon", testProfileKey); err != nil {
		t.Fatalf("create anonymous account: %v", err)
	}
	if awarded, err := store.EvaluateTitles(ctx, "anon"); err != nil {
		t.Fatalf("evaluate: %v", err)
	} else if len(awarded) != 0 {
		t.Fatalf("an unlinked account is verified by nobody, got %v", titleIDs(awarded))
	}

	if _, err := store.ClaimAccountWithDiscord(
		ctx, "anon", "Anon", "80351110224678912", "anon",
	); err != nil {
		t.Fatalf("claim with discord: %v", err)
	}
	if awarded, err := store.EvaluateTitles(ctx, "anon"); err != nil {
		t.Fatalf("evaluate: %v", err)
	} else if ids := titleIDs(awarded); len(ids) != 1 || ids[0] != TitleDiscordVerified {
		t.Fatalf("expected D once the link exists, got %v", ids)
	}
	if !holds(t, store, "anon", TitleDiscordVerified) {
		t.Fatal("a verified account holds D")
	}
}

// Anonymizing clears the link along with the name, so the rulebook has nothing
// to award afterwards — which is what stops the deleted player's own next
// evaluation handing the tag straight back.
func TestDiscordVerifiedDoesNotSurviveAnonymization(t *testing.T) {
	store := authTestStore(t)
	registeredOwner(t, store, "ada", "Ada")
	registeredOwner(t, store, "grace", "Grace")
	ctx := t.Context()
	if _, err := store.EvaluateTitles(ctx, "ada"); err != nil {
		t.Fatalf("evaluate: %v", err)
	}
	seedGame(t, store, "played", account(t, store, "ada"), account(t, store, "grace"), 1_000)
	if _, err := store.AnonymizeAccount(ctx, "ada"); err != nil {
		t.Fatalf("anonymize: %v", err)
	}
	if awarded, err := store.EvaluateTitles(ctx, "ada"); err != nil {
		t.Fatalf("evaluate: %v", err)
	} else if len(awarded) != 0 {
		t.Fatalf("an anonymized account is verified by nobody, got %v", titleIDs(awarded))
	}
}
