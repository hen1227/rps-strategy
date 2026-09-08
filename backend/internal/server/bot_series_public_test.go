package server

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"testing"

	"rps-strategy/backend/internal/game"
	"rps-strategy/backend/internal/persistence"
)

// The public path: anybody may pit two bots against each other.
//
// What these tests are about is not that it works — bot_series_test.go covers
// the run itself — but that opening it up did not open anything else: the bot's
// own public-play switch is still the consent, the ceilings hold, and an abort
// is still the requester's alone.

// openToPlay turns a claimed bot's public-play switch on through the route the
// website uses, so the in-memory record the series check reads is the one a real
// toggle would have left behind.
func openToPlay(t *testing.T, server *Server, bot persistence.Bot) {
	t.Helper()
	updated, err := server.data.UpdateBotSettings(t.Context(), bot.BotID, true, false, "")
	if err != nil {
		t.Fatalf("open %s to public play: %v", bot.Name, err)
	}
	server.refreshBotRecord(updated)
}

// visitorSeries is one pair at a short clock: what the public form can ask for.
func visitorSeries(
	first persistence.Bot,
	second persistence.Bot,
	requestedBy string,
) BotSeriesRequest {
	return BotSeriesRequest{
		FirstBotID:   first.BotID,
		SecondBotID:  second.BotID,
		ModeID:       game.ModeTotalWar,
		Pairs:        1,
		OpeningPlies: 4,
		Seed:         11,
		Control:      game.TimeControl{InitialTimeMs: 60_000},
		RequestedBy:  requestedBy,
	}
}

func TestAVisitorCanPitTwoPublicBotsAgainstEachOther(t *testing.T) {
	server, alpha, beta := seriesTestBots(t)
	openToPlay(t, server, alpha)
	openToPlay(t, server, beta)

	series, err := server.StartBotSeries(t.Context(), visitorSeries(alpha, beta, "owner"))
	if err != nil {
		t.Fatalf("a visitor should be able to start a series: %v", err)
	}
	// The row has to say who asked, both so the scoreboard can show it and so
	// the abort below has something to check against.
	if series.RequestedByUserID != "owner" || series.RequestedByName != "Owner" {
		t.Fatalf("the run should record its requester: %#v", series)
	}

	if err := server.AbortBotSeries(series.SeriesID, "owner", false); err != nil {
		t.Fatalf("the requester should be able to stop their own run: %v", err)
	}
}

func TestASeriesNeedsBothBotsOpenToPublicPlay(t *testing.T) {
	server, alpha, beta := seriesTestBots(t)
	openToPlay(t, server, alpha)

	// Beta's owner has not said strangers may play it, and a series is strangers
	// playing it. The switch that answers "may somebody challenge this bot" is
	// the same question, so it is the switch that answers this one.
	_, err := server.StartBotSeries(t.Context(), visitorSeries(alpha, beta, "stranger"))
	if !errors.Is(err, errSeriesBotPrivate) {
		t.Fatalf("a private bot must not be conscripted, got %v", err)
	}

	// Its owner is exempt from their own switch: running a new version against
	// the old one is why an account may hold five bots.
	if _, err := server.StartBotSeries(
		t.Context(), visitorSeries(alpha, beta, "owner"),
	); err != nil {
		t.Fatalf("the owner should be able to run their own bots: %v", err)
	}
}

func TestPublicSeriesAreBoundedInLengthAndClock(t *testing.T) {
	server, alpha, beta := seriesTestBots(t)
	openToPlay(t, server, alpha)
	openToPlay(t, server, beta)

	long := visitorSeries(alpha, beta, "owner")
	long.Pairs = publicSeriesMaxPairs + 1
	if _, err := server.StartBotSeries(t.Context(), long); !errors.Is(err, errSeriesPublicPairs) {
		t.Fatalf("a visitor's run is bounded in length, got %v", err)
	}

	slow := visitorSeries(alpha, beta, "owner")
	slow.Control = game.TimeControl{InitialTimeMs: publicSeriesMaxInitialMs + 1}
	if _, err := server.StartBotSeries(t.Context(), slow); !errors.Is(err, errSeriesPublicClock) {
		t.Fatalf("a visitor's run is bounded in clock, got %v", err)
	}

	// The host is exempt from both: deciding which of two engines is stronger is
	// what a fifty-pair run at a real time control is for.
	host := hostSeries(alpha, beta, game.ModeTotalWar, 50, 4, 5)
	if _, err := server.StartBotSeries(t.Context(), host); err != nil {
		t.Fatalf("an administrator is not held to the public ceiling: %v", err)
	}
}

// The clock ceiling is a ceiling and nothing else. 0.1+1 — six seconds each with
// a second back per move — is the shortest clock the website's form offers, and
// it is a real way to ask two engines a question: a run of it is over while
// somebody watches, and neither player is going to fumble a mouse.
func TestAVisitorMayRunABulletClock(t *testing.T) {
	server, alpha, beta := seriesTestBots(t)
	openToPlay(t, server, alpha)
	openToPlay(t, server, beta)

	quick := visitorSeries(alpha, beta, "owner")
	quick.Control = game.TimeControl{InitialTimeMs: 6_000, IncrementMs: 1_000}
	series, err := server.StartBotSeries(t.Context(), quick)
	if err != nil {
		t.Fatalf("a six-second clock is inside the public ceiling: %v", err)
	}
	if series.InitialTimeMs != 6_000 || series.IncrementMs != 1_000 {
		t.Fatalf("the run should be played at the clock asked for: %#v", series)
	}

	if err := server.AbortBotSeries(series.SeriesID, "owner", false); err != nil {
		t.Fatalf("stop the run: %v", err)
	}
}

func TestOneAccountHoldsOneSeriesSlot(t *testing.T) {
	server, alpha, beta := seriesTestBots(t)
	gamma := addSeriesBot(t, server, "Gamma")
	delta := addSeriesBot(t, server, "Delta")
	for _, bot := range []persistence.Bot{alpha, beta, gamma, delta} {
		openToPlay(t, server, bot)
	}

	first, err := server.StartBotSeries(t.Context(), visitorSeries(alpha, beta, "owner"))
	if err != nil {
		t.Fatalf("start the first series: %v", err)
	}

	// Two idle bots are available, so this is refused for the reason under test
	// rather than because the engines are busy.
	if _, err := server.StartBotSeries(
		t.Context(), visitorSeries(gamma, delta, "owner"),
	); !errors.Is(err, errSeriesAlreadyYours) {
		t.Fatalf("one account holds one slot, got %v", err)
	}

	// Somebody else may still start one, up to the server-wide ceiling.
	if _, err := server.StartBotSeries(
		t.Context(), visitorSeries(gamma, delta, "somebody-else"),
	); err != nil {
		t.Fatalf("a second person should get the second slot: %v", err)
	}

	// And the slot is a slot, not a quota: stopping the run frees it.
	if err := server.AbortBotSeries(first.SeriesID, "owner", false); err != nil {
		t.Fatalf("abort the first series: %v", err)
	}
	freed := &botSeries{seriesID: "probe", requestedBy: "owner"}
	if err := server.botSeriesRuns.claim(freed); err != nil {
		t.Fatalf("the slot should be free once the run has stopped: %v", err)
	}
	server.botSeriesRuns.drop(freed.seriesID)
}

func TestOnlyTheRequesterOrTheHostCanStopARun(t *testing.T) {
	server, alpha, beta := seriesTestBots(t)
	openToPlay(t, server, alpha)
	openToPlay(t, server, beta)

	series, err := server.StartBotSeries(t.Context(), visitorSeries(alpha, beta, "owner"))
	if err != nil {
		t.Fatalf("start series: %v", err)
	}

	// Otherwise the abort button is a way to spoil a series somebody else is
	// watching, which is worse than a run that has to be waited out.
	if err := server.AbortBotSeries(
		series.SeriesID, "somebody-else", false,
	); !errors.Is(err, errSeriesNotYours) {
		t.Fatalf("a stranger must not stop somebody's run, got %v", err)
	}
	// An anonymous caller is not "the run with no requester".
	if err := server.AbortBotSeries(series.SeriesID, "", false); !errors.Is(err, errSeriesNotYours) {
		t.Fatalf("an unidentified caller must not stop a run, got %v", err)
	}
	if err := server.AbortBotSeries(series.SeriesID, "", true); err != nil {
		t.Fatalf("the host should be able to stop any run: %v", err)
	}
	if err := server.AbortBotSeries(
		series.SeriesID, "owner", false,
	); !errors.Is(err, errSeriesNotRunning) {
		t.Fatalf("a stopped run is no longer running, got %v", err)
	}
}

func TestThePublicSeriesRouteTakesABrowsersOwnIdentity(t *testing.T) {
	server, alpha, beta := seriesTestBots(t)
	openToPlay(t, server, alpha)
	openToPlay(t, server, beta)
	handler := server.Routes()

	// A visitor who has never registered. This is the identity most of the
	// people watching bots play have, so the route has to accept it: the
	// alternative is a feature only the people who need it least can use.
	const guestKey = "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210"
	if _, err := server.data.EnsureAccountWithProfileKey(
		t.Context(), "guest", "Guest", guestKey,
	); err != nil {
		t.Fatalf("guest account: %v", err)
	}

	body := map[string]any{
		"firstBotId":   alpha.BotID,
		"secondBotId":  beta.BotID,
		"modeId":       game.ModeTotalWar,
		"pairs":        1,
		"openingPlies": 4,
		"timeControl":  map[string]any{"initialTimeMs": 60_000, "incrementMs": 0},
	}

	anonymous := tournamentRequest(t, handler, "POST", "/api/bot-series", body, "")
	if anonymous.Code != http.StatusUnauthorized {
		t.Fatalf("a request with no identity at all should be refused, got %d", anonymous.Code)
	}

	started := tournamentRequest(
		t, handler, "POST", "/api/bot-series?userId=guest", body, guestKey,
	)
	if started.Code != http.StatusCreated {
		t.Fatalf("a guest should be able to start a series, got %d: %s", started.Code, started.Body)
	}
	var series persistence.BotSeries
	if err := json.Unmarshal(started.Body.Bytes(), &series); err != nil {
		t.Fatalf("decode series: %v", err)
	}
	if series.RequestedByUserID != "guest" {
		t.Fatalf("the run should be attributed to the guest: %#v", series)
	}

	// A second run from the same browser is refused with a conflict rather than
	// silently queued, so the form can say why.
	again := tournamentRequest(
		t, handler, "POST", "/api/bot-series?userId=guest", body, guestKey,
	)
	if again.Code != http.StatusConflict {
		t.Fatalf("a second run should conflict, got %d: %s", again.Code, again.Body)
	}

	stranger := tournamentRequest(
		t, handler, "POST",
		"/api/bot-series/"+series.SeriesID+"/abort?userId=owner",
		nil, "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
	)
	if stranger.Code != http.StatusForbidden {
		t.Fatalf("only the requester may abort, got %d: %s", stranger.Code, stranger.Body)
	}
	aborted := tournamentRequest(
		t, handler, "POST",
		"/api/bot-series/"+series.SeriesID+"/abort?userId=guest", nil, guestKey,
	)
	if aborted.Code != http.StatusOK {
		t.Fatalf("the requester may abort, got %d: %s", aborted.Code, aborted.Body)
	}
}

func TestASeedSurvivesTheRoundTripThroughJavaScript(t *testing.T) {
	server, alpha, beta := seriesTestBots(t)
	openToPlay(t, server, alpha)
	openToPlay(t, server, beta)
	handler := server.Routes()

	const guestKey = "aaaabbbbccccddddaaaabbbbccccddddaaaabbbbccccddddaaaabbbbccccdddd"
	if _, err := server.data.EnsureAccountWithProfileKey(
		t.Context(), "seed-guest", "Guest", guestKey,
	); err != nil {
		t.Fatalf("guest account: %v", err)
	}

	// Past 2^53, which is where a JSON number stops being able to hold an
	// integer exactly. A seed exists to be pasted back, so a value that arrives
	// rounded is a value that reproduces a different run.
	const seed = "9007199254740993"
	response := tournamentRequest(
		t, handler, "POST", "/api/bot-series?userId=seed-guest",
		map[string]any{
			"firstBotId":   alpha.BotID,
			"secondBotId":  beta.BotID,
			"modeId":       game.ModeTotalWar,
			"pairs":        1,
			"openingPlies": 2,
			"seed":         seed,
			"timeControl":  map[string]any{"initialTimeMs": 60_000},
		},
		guestKey,
	)
	if response.Code != http.StatusCreated {
		t.Fatalf("start series: %d: %s", response.Code, response.Body)
	}
	// Checked on the wire rather than through the struct: decoding into Go would
	// hide the very thing at issue, which is how the number is written down.
	if !strings.Contains(response.Body.String(), `"seed":"`+seed+`"`) {
		t.Fatalf("the seed should come back as a string, unrounded: %s", response.Body)
	}
}

func TestTheBotMatchesRouteIsPublicAndFilterable(t *testing.T) {
	server, alpha, beta := seriesTestBots(t)
	handler := server.Routes()

	all := tournamentRequest(t, handler, "GET", "/api/bot-matches", nil, "")
	if all.Code != http.StatusOK {
		t.Fatalf("the record should be readable by anybody, got %d: %s", all.Code, all.Body)
	}
	var matches []persistence.BotMatch
	if err := json.Unmarshal(all.Body.Bytes(), &matches); err != nil {
		t.Fatalf("decode matches: %v", err)
	}
	if len(matches) != 0 {
		t.Fatalf("no games have been played yet: %#v", matches)
	}

	filtered := tournamentRequest(
		t, handler, "GET",
		"/api/bot-matches?botId="+alpha.UserID+"&botId="+beta.UserID+"&limit=5",
		nil, "",
	)
	if filtered.Code != http.StatusOK {
		t.Fatalf("repeated botId is the leaderboard's query, got %d: %s", filtered.Code, filtered.Body)
	}

	// A negative page is a client bug, and answering it with an empty list would
	// hide that rather than report it.
	bad := tournamentRequest(t, handler, "GET", "/api/bot-matches?limit=-4", nil, "")
	if bad.Code != http.StatusBadRequest {
		t.Fatalf("a negative limit should be rejected, got %d: %s", bad.Code, bad.Body)
	}
}
