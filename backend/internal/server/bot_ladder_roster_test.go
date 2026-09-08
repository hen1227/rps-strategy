package server

import (
	"fmt"
	"strings"
	"testing"
	"time"

	"rps-strategy/backend/internal/game"
	"rps-strategy/backend/internal/persistence"
)

// ladderTestServer is a server with one registered owner to mint engines for.
func ladderTestServer(t *testing.T) *Server {
	t.Helper()
	server := New(nil)
	if _, err := server.data.ClaimAccountWithDiscord(
		t.Context(), "owner", "Owner", "discord-owner", "owner",
	); err != nil {
		t.Fatalf("register owner: %v", err)
	}
	return server
}

// connectLadderBot claims an engine and seats it the way acceptBotConnection
// does — with the account read once, at connect time, which is the copy the
// roster is published from.
//
// Each engine gets an owner of its own, because the ladder does not count games
// between two bots one person registered and a roster of one owner's engines
// would never move at all.
func connectLadderBot(t *testing.T, server *Server, name string) (persistence.Bot, *Client) {
	t.Helper()
	owner := "owner-" + strings.ToLower(name)
	if _, err := server.data.ClaimAccountWithDiscord(
		t.Context(), owner, "Owner_"+name, "discord-"+owner, owner,
	); err != nil {
		t.Fatalf("register owner for %s: %v", name, err)
	}
	_, token, err := server.data.MintBotToken(t.Context(), owner)
	if err != nil {
		t.Fatalf("mint %s: %v", name, err)
	}
	bot, err := server.data.ClaimBot(t.Context(), token, persistence.BotSettings{Name: name})
	if err != nil {
		t.Fatalf("claim %s: %v", name, err)
	}
	account, err := server.data.Account(t.Context(), bot.UserID)
	if err != nil {
		t.Fatalf("load account for %s: %v", name, err)
	}
	client := &Client{
		send:    make(chan []byte, 256),
		done:    make(chan struct{}),
		profile: game.PlayerProfile{UserID: bot.UserID, Username: bot.Name},
		account: account,
		server:  server,
		bot:     &botClient{botID: bot.BotID, record: bot, ready: true},
	}
	server.hub.Register(client)
	t.Cleanup(func() { server.hub.Unregister(client) })
	server.mu.Lock()
	server.bots[bot.BotID] = []*Client{client}
	server.mu.Unlock()
	return bot, client
}

// finishLadderGame plays one ranked engine-versus-engine game to a resignation
// through the server's own completion path, so everything a finished game sets
// off runs the way it does in production.
func finishLadderGame(t *testing.T, server *Server, id string, red, blue *Client, redWins bool) {
	t.Helper()
	played, err := game.NewGame(id, game.ModeTotalWar, red.profile, blue.profile)
	if err != nil {
		t.Fatalf("new game %s: %v", id, err)
	}
	session := &GameSession{
		gameID:     id,
		modeID:     game.ModeTotalWar,
		game:       played,
		redClient:  red,
		blueClient: blue,
		chat:       newChatRoom(id),
		startedAt:  time.Now().Add(-time.Minute),
		ranked:     true,
	}
	server.mu.Lock()
	server.games[id] = session
	server.mu.Unlock()

	loser := game.Blue
	if !redWins {
		loser = game.Red
	}
	state, err := played.Resign(loser)
	if err != nil {
		t.Fatalf("resign %s: %v", id, err)
	}
	server.finishSession(session, state)
}

func ladderRating(t *testing.T, server *Server, userID string) int {
	t.Helper()
	account, err := server.data.Account(t.Context(), userID)
	if err != nil {
		t.Fatalf("load account %s: %v", userID, err)
	}
	return account.ModeElo(game.ModeTotalWar)
}

// The bot ladder is a fit over the whole board, so a game between two engines
// restates the rating of engines that were not in it. The roster is published
// from a copy of each account read when it connected, and nothing in one game's
// result can patch the rest of it — so without a refresh, an engine that
// connects once and plays all day keeps publishing the seed it started from.
func TestAFinishedBotGameRestatesEveryConnectedEngine(t *testing.T) {
	server := ladderTestServer(t)
	alpha, alphaClient := connectLadderBot(t, server, "Alpha")
	beta, betaClient := connectLadderBot(t, server, "Beta")
	gamma, gammaClient := connectLadderBot(t, server, "Gamma")

	// A graded round robin: the first of each pair takes six of every eight. Not
	// a sweep, which has no finite fit and collapses to the default — see the
	// note on the shrinkage in bot_rating.go.
	pairs := [][2]*Client{
		{alphaClient, betaClient},
		{alphaClient, gammaClient},
		{betaClient, gammaClient},
	}
	counter := 0
	for _, pair := range pairs {
		for index := range 8 {
			counter++
			finishLadderGame(
				t, server, fmt.Sprintf("ladder-%d", counter), pair[0], pair[1], index < 6,
			)
		}
	}

	// The record has to place them apart, or this proves nothing.
	if ladderRating(t, server, alpha.UserID) <= ladderRating(t, server, gamma.UserID) {
		t.Fatalf("expected a graded board, got alpha %d and gamma %d",
			ladderRating(t, server, alpha.UserID), ladderRating(t, server, gamma.UserID))
	}

	for _, bot := range []persistence.Bot{alpha, beta, gamma} {
		stored := ladderRating(t, server, bot.UserID)
		var published int
		var listed bool
		for _, presence := range server.botRoster() {
			if presence.UserID != bot.UserID {
				continue
			}
			listed = true
			published = presence.Elo
			if rating, found := presence.ModeRatings[game.ModeTotalWar]; found {
				published = rating
			}
		}
		if !listed {
			t.Fatalf("%s is connected but not on the roster", bot.Name)
		}
		if published != stored {
			t.Errorf("%s: the roster publishes %d, the ladder says %d",
				bot.Name, published, stored)
		}
	}
}

// The roster carries the account each engine is registered to, because the one
// thing the lobby has to work out from it is whether two of them are the same
// person's — the form that starts a series says the run will be casual before it
// is pressed, and it cannot know that without this.
func TestTheRosterPublishesWhoOwnsEachEngine(t *testing.T) {
	server := ladderTestServer(t)
	alpha, _ := connectLadderBot(t, server, "Alpha")
	beta, _ := connectLadderBot(t, server, "Beta")

	owners := make(map[string]string)
	for _, presence := range server.botRoster() {
		owners[presence.Name] = presence.OwnerUserID
	}
	if owners["Alpha"] == "" || owners["Beta"] == "" {
		t.Fatalf("the roster published no owner: %#v", owners)
	}
	if owners["Alpha"] != alpha.OwnerUserID || owners["Beta"] != beta.OwnerUserID {
		t.Fatalf("the roster published the wrong owners: %#v", owners)
	}
	// These two were minted under owners of their own, so the lobby must not
	// read them as a pair — an empty field compared against another empty field
	// is exactly how it would.
	if owners["Alpha"] == owners["Beta"] {
		t.Fatal("two separately owned engines came back sharing an owner")
	}
}

// The same copy decides who an engine is paired against, so a stale one would
// seat matchups by a rating from before the games that set it.
func TestMatchmakingReadsABotsCurrentLadderRating(t *testing.T) {
	server := ladderTestServer(t)
	alpha, alphaClient := connectLadderBot(t, server, "Alpha")
	_, betaClient := connectLadderBot(t, server, "Beta")
	_, gammaClient := connectLadderBot(t, server, "Gamma")

	pairs := [][2]*Client{
		{alphaClient, betaClient},
		{alphaClient, gammaClient},
		{betaClient, gammaClient},
	}
	counter := 0
	for _, pair := range pairs {
		for index := range 8 {
			counter++
			finishLadderGame(
				t, server, fmt.Sprintf("seat-%d", counter), pair[0], pair[1], index < 6,
			)
		}
	}

	stored := ladderRating(t, server, alpha.UserID)
	if stored == persistence.DefaultElo {
		t.Fatalf("the board did not move, so this proves nothing: %d", stored)
	}
	if seated := matchmakingElo(alphaClient, game.ModeTotalWar); seated != stored {
		t.Errorf("matchmaking seats Alpha at %d, the ladder says %d", seated, stored)
	}
}
