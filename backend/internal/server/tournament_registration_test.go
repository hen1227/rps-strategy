package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"

	"rps-strategy/backend/internal/game"
	"rps-strategy/backend/internal/persistence"
	"rps-strategy/backend/internal/rpsi"
)

// How an engine gets into an event, which is not by registering for one.
//
// An engine has a standing switch — `enterTournaments` — and a sweep that reads
// it. There is no per-event door for one at all: the tests below are the two
// halves of that, the doors that are shut and the sweep that is open.
//
// The rule the old per-event door carried, one place per party, is gone with it.
// It was there to stop an author with three engines taking three of six places
// by choosing three times; nobody chooses now, and the sweep enters whatever is
// online because that is what a bots-only field is.

// ownedEngine mints, claims and describes a bot for an owner, in the state a
// bot is in after it has connected once.
func ownedEngine(
	t *testing.T,
	data *persistence.Store,
	owner string,
	name string,
	modes []game.ModeID,
) persistence.Bot {
	t.Helper()
	_, token, err := data.MintBotToken(t.Context(), owner)
	if err != nil {
		t.Fatalf("mint %s: %v", name, err)
	}
	bot, err := data.ClaimBot(t.Context(), token, persistence.BotSettings{
		Name: name, EnterTournaments: true, AllowPublicPlay: true,
	})
	if err != nil {
		t.Fatalf("claim %s: %v", name, err)
	}
	if err := data.RecordBotEngineIdentity(t.Context(), bot.BotID, persistence.BotEngineIdentity{
		Name: name, Author: owner, Modes: modes,
	}); err != nil {
		t.Fatalf("engine identity for %s: %v", name, err)
	}
	reread, err := data.Bot(t.Context(), bot.BotID)
	if err != nil {
		t.Fatalf("read %s back: %v", name, err)
	}
	return reread
}

// connectEngine puts a registry bot on the roster, the way its client does.
//
// The sweep only ever looks at connected engines, so a test about the sweep has
// to have some. The record and the handshake are the two things it reads: the
// switch lives on the first and the modes on the second.
func connectEngine(
	t *testing.T,
	server *Server,
	bot persistence.Bot,
	modes []game.ModeID,
) *Client {
	t.Helper()
	client := &Client{
		send:    make(chan []byte, 64),
		done:    make(chan struct{}),
		profile: game.PlayerProfile{UserID: bot.UserID, Username: bot.Name},
		server:  server,
		bot: &botClient{
			botID:     bot.BotID,
			record:    bot,
			handshake: rpsi.Handshake{Modes: modes},
			ready:     true,
		},
	}
	server.hub.Register(client)
	t.Cleanup(func() { server.hub.Unregister(client) })
	server.registerBot(client)
	return client
}

// signupRequest posts a signup body, which is the only door left on this route.
func signupRequest(
	t *testing.T,
	handler http.Handler,
	tournamentID string,
	body map[string]any,
	sessionToken string,
) *httptest.ResponseRecorder {
	t.Helper()
	return tournamentRequest(
		t, handler, http.MethodPost,
		"/api/tournaments/"+tournamentID+"/signups",
		body, sessionToken,
	)
}

// Neither door an engine used to be entered through is open.
//
// The first is the one an owner pressed — a botId on the signup route. The
// second is the one that made the first worth checking ownership on: an engine
// plays under an account of its own, and that account id is on every game it
// has played, so anybody could read one off a game record and enter it.
//
// Both now answer with the same sentence, and it is the sentence that says where
// the switch is. A refusal that only said "no" would leave an author who has
// just been told their engine is not in the field with nowhere to go.
func TestAnEngineIsNotEnteredOneEventAtATime(t *testing.T) {
	data, err := persistence.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer data.Close()
	handler := NewWithStore(data, nil).Routes()

	session := registeredSession(t, data, "author", "Author")
	bot := ownedEngine(t, data, "author", "Fishy", []game.ModeID{game.ModeTotalWar})
	cup := openTournament(t, data, "cup", "Engine Cup", game.ModeTotalWar, "Total War")

	byBotID := signupRequest(t, handler, cup.TournamentID, map[string]any{
		"botId": bot.BotID,
	}, session)
	if byBotID.Code != http.StatusConflict {
		t.Fatalf("expected a botId signup to be refused, got %d: %s", byBotID.Code, byBotID.Body)
	}
	if body := byBotID.Body.String(); !jsonErrorContains(body, "Tournaments") {
		t.Fatalf("expected the refusal to name the switch, got %s", body)
	}

	byAccount := signupRequest(t, handler, cup.TournamentID, map[string]any{
		"userId": bot.UserID, "ign": "Fishy", "discord": "bot.fishy",
		"agreedToUnfilteredChat": true,
	}, "")
	if byAccount.Code != http.StatusForbidden {
		t.Fatalf("expected 403 entering a bot account directly, got %d: %s",
			byAccount.Code, byAccount.Body)
	}

	if entered, err := data.Tournament(t.Context(), cup.TournamentID); err != nil {
		t.Fatal(err)
	} else if len(entered.Players) != 0 {
		t.Fatalf("expected an empty field, got %#v", entered.Players)
	}
}

// The sweep is the whole mechanism, and the switch is the whole of the choice.
//
// Each engine here is a different answer to "why is my bot not in the field",
// and the sweep has to give each of them separately: they have different fixes,
// and neither is a thing the author can see from the bracket.
func TestTheSweepEntersEveryOnlineEngineWithTheSwitchOn(t *testing.T) {
	data, err := persistence.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer data.Close()
	server := NewWithStore(data, nil)

	registeredSession(t, data, "author", "Author")
	registeredSession(t, data, "rival", "Rival")

	// Two from one author, which the old per-event door would have made them
	// choose between. The sweep takes both: nobody is choosing, so there is no
	// choice to hold anybody to.
	first := ownedEngine(t, data, "author", "Fishy", []game.ModeID{game.ModeTotalWar})
	second := ownedEngine(t, data, "author", "Chippy", []game.ModeID{game.ModeTotalWar})
	connectEngine(t, server, first, []game.ModeID{game.ModeTotalWar})
	connectEngine(t, server, second, []game.ModeID{game.ModeTotalWar})

	// The switch off. The one thing an author says about this, and the sweep is
	// the only thing that reads it.
	resting := ownedEngine(t, data, "rival", "Resting", []game.ModeID{game.ModeTotalWar})
	if _, err := data.UpdateBotSettings(t.Context(), resting.BotID, true, false, false, ""); err != nil {
		t.Fatal(err)
	}
	resting.EnterTournaments = false
	connectEngine(t, server, resting, []game.ModeID{game.ModeTotalWar})

	// An engine that does not play the event's game would forfeit every match.
	narrow := ownedEngine(t, data, "rival", "Narrow", []game.ModeID{game.ModeInfiltration})
	connectEngine(t, server, narrow, []game.ModeID{game.ModeInfiltration})

	cup := openTournament(t, data, "cup", "Engine Cup", game.ModeTotalWar, "Total War")
	enrolled, skipped := server.enrolOnlineBots(t.Context(), cup)

	slices.Sort(enrolled)
	if got := strings.Join(enrolled, ","); got != "Chippy,Fishy" {
		t.Fatalf("expected both of the author's engines and nothing else, got %q", got)
	}
	for name, want := range map[string]string{
		"Resting": "not entering tournaments",
		"Narrow":  "does not play",
	} {
		if !strings.Contains(skipped[name], want) {
			t.Fatalf("expected %s to be skipped for %q, got %q", name, want, skipped[name])
		}
	}

	entered, err := data.Tournament(t.Context(), cup.TournamentID)
	if err != nil {
		t.Fatal(err)
	}
	if len(entered.Players) != 2 {
		t.Fatalf("expected two engines in the field, got %#v", entered.Players)
	}
	// Under their own names and accounts — the bracket says Fishy, not Author —
	// and reachable at the owner's handle, because a host chasing a missing
	// engine has to reach a person.
	for _, player := range entered.Players {
		if player.Discord != "Author" {
			t.Fatalf("expected the owner's Discord handle on %s, got %q", player.IGN, player.Discord)
		}
	}

	// And it is safe to run twice. The scheduler's minute tick and a host's
	// button can both land on the same event, and the second one must not
	// double-enter anybody or report the first one's work as its own.
	again, _ := server.enrolOnlineBots(t.Context(), cup)
	if len(again) != 0 {
		t.Fatalf("a second sweep should have nothing to add, got %#v", again)
	}
	if reread, err := data.Tournament(t.Context(), cup.TournamentID); err != nil {
		t.Fatal(err)
	} else if len(reread.Players) != 2 {
		t.Fatalf("a second sweep changed the field: %#v", reread.Players)
	}
}

// An engine with the switch off stays out, and turning it on is the whole fix.
//
// The point of the pair: the same engine, the same event, the same sweep, and
// the only thing that changed is the switch its owner can reach from the app.
func TestTurningTheSwitchOnIsWhatEntersAnEngine(t *testing.T) {
	data, err := persistence.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer data.Close()
	server := NewWithStore(data, nil)
	handler := server.Routes()

	session := registeredSession(t, data, "author", "Author")
	bot := ownedEngine(t, data, "author", "Fishy", []game.ModeID{game.ModeTotalWar})
	if _, err := data.UpdateBotSettings(t.Context(), bot.BotID, true, false, false, ""); err != nil {
		t.Fatal(err)
	}
	bot.EnterTournaments = false
	connectEngine(t, server, bot, []game.ModeID{game.ModeTotalWar})
	cup := openTournament(t, data, "cup", "Engine Cup", game.ModeTotalWar, "Total War")

	if enrolled, _ := server.enrolOnlineBots(t.Context(), cup); len(enrolled) != 0 {
		t.Fatalf("an engine with the switch off should stay out, got %#v", enrolled)
	}

	// The owner's own door, which is the bot record rather than the event. The
	// connected session is updated with it, so the sweep does not have to wait
	// for a restart to see the change.
	flipped := tournamentRequest(
		t, handler, http.MethodPatch, "/api/bots/"+bot.BotID,
		map[string]any{
			"description": "", "allowPublicPlay": true,
			"enterTournaments": true, "enterLadder": false,
		},
		session,
	)
	if flipped.Code != http.StatusOK {
		t.Fatalf("expected the switch to be saved, got %d: %s", flipped.Code, flipped.Body)
	}

	enrolled, skipped := server.enrolOnlineBots(t.Context(), cup)
	if len(enrolled) != 1 || enrolled[0] != "Fishy" {
		t.Fatalf("expected Fishy to be swept in, got %#v (skipped %#v)", enrolled, skipped)
	}
}

// Withdrawing removes you, and never the engine standing beside you.
//
// The two used to be one door: it removed whatever the party held, earliest
// first, so an owner whose engine had been swept in ahead of them pressed
// Withdraw on their own name and took the engine out instead. And an engine
// taken out that way came straight back on the next sweep, which is the deeper
// reason the door is shut rather than merely aimed better.
func TestWithdrawingTakesYourOwnEntryAndNotYourEngines(t *testing.T) {
	data, err := persistence.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer data.Close()
	server := NewWithStore(data, nil)
	handler := server.Routes()

	session := registeredSession(t, data, "author", "Author")
	bot := ownedEngine(t, data, "author", "Fishy", []game.ModeID{game.ModeTotalWar})
	connectEngine(t, server, bot, []game.ModeID{game.ModeTotalWar})
	cup := openTournament(t, data, "cup", "Engine Cup", game.ModeTotalWar, "Total War")
	path := "/api/tournaments/" + cup.TournamentID + "/signups"

	// The engine first, so it holds the lower signup order. That ordering is
	// what the old party-wide withdrawal picked by.
	server.enrolOnlineBots(t.Context(), cup)
	if entered, err := data.Tournament(t.Context(), cup.TournamentID); err != nil {
		t.Fatal(err)
	} else if len(entered.Players) != 1 {
		t.Fatalf("expected the sweep to enter the engine, got %#v", entered.Players)
	}

	if reply := signupRequest(t, handler, cup.TournamentID, map[string]any{
		"userId": "author", "ign": "Author", "discord": "Author",
		"agreedToUnfilteredChat": true,
	}, session); reply.Code != http.StatusCreated {
		t.Fatalf("expected the owner to enter beside their engine, got %d: %s",
			reply.Code, reply.Body)
	}

	if reply := tournamentRequest(
		t, handler, http.MethodDelete, path, nil, session,
	); reply.Code != http.StatusOK {
		t.Fatalf("expected the withdrawal to be accepted, got %d: %s", reply.Code, reply.Body)
	}
	left, err := data.Tournament(t.Context(), cup.TournamentID)
	if err != nil {
		t.Fatal(err)
	}
	if len(left.Players) != 1 || left.Players[0].IGN != "Fishy" {
		t.Fatalf("expected only the engine left in the field, got %#v", left.Players)
	}

	// A stranger withdrawing has nothing of their own to remove, and must not
	// be able to reach anybody else's entry.
	stranger := registeredSession(t, data, "stranger", "Stranger")
	if reply := tournamentRequest(
		t, handler, http.MethodDelete, path, nil, stranger,
	); reply.Code != http.StatusNotFound {
		t.Fatalf("expected 404 withdrawing an entry you do not hold, got %d: %s",
			reply.Code, reply.Body)
	}
	// And the owner has nothing left either: their engine's entry is not theirs
	// to take out, which is the whole of the rule.
	if reply := tournamentRequest(
		t, handler, http.MethodDelete, path, nil, session,
	); reply.Code != http.StatusNotFound {
		t.Fatalf("expected the owner to have nothing left to withdraw, got %d: %s",
			reply.Code, reply.Body)
	}
}

// Once the pairings exist, every other entrant's schedule is built around that
// name being in the field.
func TestWithdrawingClosesWhenTheEventStarts(t *testing.T) {
	data, err := persistence.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer data.Close()
	handler := NewWithStore(data, nil).Routes()

	session := registeredSession(t, data, "author", "Author")
	verifiedEntrants(t, data, "rival")
	cup := openTournament(t, data, "cup", "Engine Cup", game.ModeTotalWar, "Total War")
	path := "/api/tournaments/" + cup.TournamentID + "/signups"

	for _, who := range []struct{ id, name string }{{"author", "Author"}, {"rival", "rival"}} {
		if _, err := data.SignupForTournament(
			t.Context(), cup.TournamentID, who.id, who.name, who.name, true,
		); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := data.StartTournament(t.Context(), cup.TournamentID); err != nil {
		t.Fatal(err)
	}
	if reply := tournamentRequest(
		t, handler, http.MethodDelete, path, nil, session,
	); reply.Code != http.StatusConflict {
		t.Fatalf("expected 409 withdrawing from a running event, got %d: %s",
			reply.Code, reply.Body)
	}
}

func TestBotsOnlyFieldStillAdmitsEnginesAndBarsPeople(t *testing.T) {
	data, err := persistence.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer data.Close()
	server := NewWithStore(data, nil)
	handler := server.Routes()

	registeredSession(t, data, "author", "Author")
	bot := ownedEngine(t, data, "author", "Fishy", []game.ModeID{game.ModeTotalWar})
	connectEngine(t, server, bot, []game.ModeID{game.ModeTotalWar})

	config := persistence.DefaultTournamentConfig(game.ModeTotalWar, "Total War")
	config.Name = "Engines Only"
	config.Field = persistence.FieldBots
	if _, err := data.CreateTournament(t.Context(), "engines", config); err != nil {
		t.Fatal(err)
	}
	engines, err := data.PublishTournament(t.Context(), "engines")
	if err != nil {
		t.Fatal(err)
	}

	if enrolled, skipped := server.enrolOnlineBots(t.Context(), engines); len(enrolled) != 1 {
		t.Fatalf("expected the engine to be swept in, got %#v (skipped %#v)", enrolled, skipped)
	}
	person := signupRequest(t, handler, "engines", map[string]any{
		"userId": "watcher", "ign": "Watcher", "discord": "watcher.discord",
		"agreedToUnfilteredChat": true,
	}, "")
	if person.Code != http.StatusForbidden {
		t.Fatalf("expected a person to be barred, got %d: %s", person.Code, person.Body)
	}
}

// jsonErrorContains reports whether an API error body mentions a substring.
func jsonErrorContains(body string, want string) bool {
	var payload struct {
		Error string `json:"error"`
	}
	if err := json.Unmarshal([]byte(body), &payload); err != nil {
		return false
	}
	return strings.Contains(payload.Error, want)
}
