package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"rps-strategy/backend/internal/game"
	"rps-strategy/backend/internal/persistence"
)

// Owners entering their own engines, which is the only way an engine gets into
// an event since the host's enrolment sweep was removed.
//
// The rule under test throughout is one entry per *party*: an account and every
// bot it owns share a single place in the field. Every case below is that rule
// approached from a different side.

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

// registerBot is the owner-facing call: POST a botId with a session token.
func registerBot(
	t *testing.T,
	handler http.Handler,
	tournamentID string,
	botID string,
	sessionToken string,
) *httptest.ResponseRecorder {
	t.Helper()
	return tournamentRequest(
		t, handler, http.MethodPost,
		"/api/tournaments/"+tournamentID+"/signups",
		map[string]any{"botId": botID},
		sessionToken,
	)
}

func TestOwnerRegistersOneBotAndOnlyOne(t *testing.T) {
	data, err := persistence.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer data.Close()
	handler := NewWithStore(data, nil).Routes()

	session := registeredSession(t, data, "author", "Author")
	first := ownedEngine(t, data, "author", "Fishy", []game.ModeID{game.ModeTotalWar})
	second := ownedEngine(t, data, "author", "Chippy", []game.ModeID{game.ModeTotalWar})
	cup := openTournament(t, data, "cup", "Engine Cup", game.ModeTotalWar, "Total War")

	// No session at all is the same answer as an expired one: entering an
	// engine means proving you own it, and there is nobody here to own it.
	anonymous := registerBot(t, handler, cup.TournamentID, first.BotID, "")
	if anonymous.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401 without a session, got %d: %s", anonymous.Code, anonymous.Body)
	}

	entered := registerBot(t, handler, cup.TournamentID, first.BotID, session)
	if entered.Code != http.StatusCreated {
		t.Fatalf("expected the owner's bot to enter, got %d: %s", entered.Code, entered.Body)
	}
	var tournament persistence.Tournament
	if err := json.NewDecoder(entered.Body).Decode(&tournament); err != nil {
		t.Fatal(err)
	}
	if len(tournament.Players) != 1 {
		t.Fatalf("expected one entrant, got %d", len(tournament.Players))
	}
	// Under the engine's own name and account — the bracket says Fishy, not
	// Author — and reachable at the owner's handle, because the host chasing a
	// missing engine has to reach a person.
	player := tournament.Players[0]
	if player.IGN != "Fishy" || player.UserID != first.UserID {
		t.Fatalf("expected the bot's own name and account, got %#v", player)
	}
	if player.Discord != "Author" {
		t.Fatalf("expected the owner's Discord handle, got %q", player.Discord)
	}

	// The second engine is the whole point of the rule. One account, one place.
	crowded := registerBot(t, handler, cup.TournamentID, second.BotID, session)
	if crowded.Code != http.StatusConflict {
		t.Fatalf("expected a second bot to be refused, got %d: %s", crowded.Code, crowded.Body)
	}
	// And the refusal names what is already in, because "you are already in" is
	// no help to somebody who has forgotten which engine they entered.
	if body := crowded.Body.String(); !jsonErrorContains(body, "Fishy") {
		t.Fatalf("expected the refusal to name the entered bot, got %s", body)
	}

	// The owner cannot enter themselves either: their place is taken by their
	// own engine.
	self := tournamentRequest(
		t, handler, http.MethodPost,
		"/api/tournaments/"+cup.TournamentID+"/signups",
		map[string]any{
			"userId": "author", "ign": "Author", "discord": "author.discord",
			"agreedToUnfilteredChat": true,
		},
		"",
	)
	if self.Code != http.StatusConflict {
		t.Fatalf("expected the owner to be refused their own second place, got %d: %s",
			self.Code, self.Body)
	}
}

func TestRegisteringSomebodyElsesBotIsRefused(t *testing.T) {
	data, err := persistence.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer data.Close()
	handler := NewWithStore(data, nil).Routes()

	registeredSession(t, data, "author", "Author")
	stranger := registeredSession(t, data, "stranger", "Stranger")
	bot := ownedEngine(t, data, "author", "Fishy", []game.ModeID{game.ModeTotalWar})
	cup := openTournament(t, data, "cup", "Engine Cup", game.ModeTotalWar, "Total War")

	refused := registerBot(t, handler, cup.TournamentID, bot.BotID, stranger)
	if refused.Code != http.StatusForbidden {
		t.Fatalf("expected 403 for another owner's bot, got %d: %s", refused.Code, refused.Body)
	}

	// The other half of the same door. The engine plays under an account of its
	// own, and that account id is on every game it has played, so the plain
	// signup route must not take it either — otherwise the ownership check
	// above is decoration.
	viaAccount := tournamentRequest(
		t, handler, http.MethodPost,
		"/api/tournaments/"+cup.TournamentID+"/signups",
		map[string]any{
			"userId": bot.UserID, "ign": "Fishy", "discord": "bot.fishy",
			"agreedToUnfilteredChat": true,
		},
		"",
	)
	if viaAccount.Code != http.StatusForbidden {
		t.Fatalf("expected 403 entering a bot account directly, got %d: %s",
			viaAccount.Code, viaAccount.Body)
	}
	if entered, err := data.Tournament(t.Context(), cup.TournamentID); err != nil {
		t.Fatal(err)
	} else if len(entered.Players) != 0 {
		t.Fatalf("expected an empty field, got %#v", entered.Players)
	}
}

func TestBotRegistrationChecksTheRegistryBeforeTheField(t *testing.T) {
	data, err := persistence.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer data.Close()
	handler := NewWithStore(data, nil).Routes()

	session := registeredSession(t, data, "author", "Author")
	cup := openTournament(t, data, "cup", "Engine Cup", game.ModeTotalWar, "Total War")

	// An engine that has never connected has no account and no name, so there
	// is nothing to write in the bracket.
	unclaimed, _, err := data.MintBotToken(t.Context(), "author")
	if err != nil {
		t.Fatal(err)
	}
	if reply := registerBot(t, handler, cup.TournamentID, unclaimed.BotID, session); reply.Code !=
		http.StatusConflict {
		t.Fatalf("expected an unclaimed slot to be refused, got %d: %s", reply.Code, reply.Body)
	}

	// An engine that does not play the event's game would forfeit every match.
	wrongMode := ownedEngine(t, data, "author", "Narrow", []game.ModeID{game.ModeInfiltration})
	if reply := registerBot(t, handler, cup.TournamentID, wrongMode.BotID, session); reply.Code !=
		http.StatusConflict {
		t.Fatalf("expected a mode refusal, got %d: %s", reply.Code, reply.Body)
	}

	// The owner's own switch, which is the one remaining thing that reads it.
	off := ownedEngine(t, data, "author", "Resting", []game.ModeID{game.ModeTotalWar})
	if _, err := data.UpdateBotSettings(t.Context(), off.BotID, true, false, ""); err != nil {
		t.Fatal(err)
	}
	if reply := registerBot(t, handler, cup.TournamentID, off.BotID, session); reply.Code !=
		http.StatusConflict {
		t.Fatalf("expected an opted-out bot to be refused, got %d: %s", reply.Code, reply.Body)
	}

	if entered, err := data.Tournament(t.Context(), cup.TournamentID); err != nil {
		t.Fatal(err)
	} else if len(entered.Players) != 0 {
		t.Fatalf("expected an empty field, got %#v", entered.Players)
	}
}

func TestOwnerWithdrawsAndSwapsEngines(t *testing.T) {
	data, err := persistence.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer data.Close()
	handler := NewWithStore(data, nil).Routes()

	session := registeredSession(t, data, "author", "Author")
	first := ownedEngine(t, data, "author", "Fishy", []game.ModeID{game.ModeTotalWar})
	second := ownedEngine(t, data, "author", "Chippy", []game.ModeID{game.ModeTotalWar})
	cup := openTournament(t, data, "cup", "Engine Cup", game.ModeTotalWar, "Total War")
	path := "/api/tournaments/" + cup.TournamentID + "/signups"

	if reply := registerBot(t, handler, cup.TournamentID, first.BotID, session); reply.Code !=
		http.StatusCreated {
		t.Fatalf("expected the first bot to enter, got %d: %s", reply.Code, reply.Body)
	}
	// The owner's own door, so it is signed in and takes no player id: it
	// removes whatever this account is answerable for.
	if reply := tournamentRequest(
		t, handler, http.MethodDelete, path, nil, session,
	); reply.Code != http.StatusOK {
		t.Fatalf("expected the withdrawal to be accepted, got %d: %s", reply.Code, reply.Body)
	}
	if reply := registerBot(t, handler, cup.TournamentID, second.BotID, session); reply.Code !=
		http.StatusCreated {
		t.Fatalf("expected the swap to be accepted, got %d: %s", reply.Code, reply.Body)
	}
	entered, err := data.Tournament(t.Context(), cup.TournamentID)
	if err != nil {
		t.Fatal(err)
	}
	if len(entered.Players) != 1 || entered.Players[0].IGN != "Chippy" {
		t.Fatalf("expected only Chippy in the field, got %#v", entered.Players)
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

	// Once the pairings exist, every other entrant's schedule is built around
	// that name being in the field.
	registeredSession(t, data, "rival-author", "RivalAuthor")
	other := ownedEngine(t, data, "rival-author", "Rival", []game.ModeID{game.ModeTotalWar})
	if _, err := data.SignupForTournament(
		t.Context(), cup.TournamentID, other.UserID, other.Name, "bot.rival", true,
	); err != nil {
		t.Fatal(err)
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
	handler := NewWithStore(data, nil).Routes()

	session := registeredSession(t, data, "author", "Author")
	bot := ownedEngine(t, data, "author", "Fishy", []game.ModeID{game.ModeTotalWar})

	config := persistence.DefaultTournamentConfig(game.ModeTotalWar, "Total War")
	config.Name = "Engines Only"
	config.Field = persistence.FieldBots
	if _, err := data.CreateTournament(t.Context(), "engines", config); err != nil {
		t.Fatal(err)
	}
	if _, err := data.PublishTournament(t.Context(), "engines"); err != nil {
		t.Fatal(err)
	}

	if reply := registerBot(t, handler, "engines", bot.BotID, session); reply.Code !=
		http.StatusCreated {
		t.Fatalf("expected the engine to enter, got %d: %s", reply.Code, reply.Body)
	}
	person := tournamentRequest(
		t, handler, http.MethodPost, "/api/tournaments/engines/signups",
		map[string]any{
			"userId": "watcher", "ign": "Watcher", "discord": "watcher.discord",
			"agreedToUnfilteredChat": true,
		},
		"",
	)
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
