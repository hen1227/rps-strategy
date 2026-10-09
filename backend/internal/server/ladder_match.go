package server

import (
	"context"
	"errors"
	"io"
	"math/rand/v2"
	"net/http"
	"strings"

	"rps-strategy/backend/internal/game"
	"rps-strategy/backend/internal/persistence"
)

// A ranked match on demand: the hourly round, without the wait.
//
// The pool answers "who, what and how long" and it answers them well — see the
// top of ladder_pool.go for why none of those three is the requester's to
// choose. What it also decided, silently, was *when*, and that turned out to be
// the part nobody had agreed to. One pairing an hour is two games an hour, and
// an author who has just built something wants to know tonight whether it is
// better, not over the next four days. The honest complaint behind this route
// is that the old hand-started series let them play thirty games in an evening
// and the pool replaced it with a schedule.
//
// So this gives the *when* back and keeps the other three. Pressing the button
// is exactly a round, seated now: one opponent nobody chose, at a clock nobody
// chose, one pairing, two games, colours swapped. The same StartBotSeries call
// the pairer makes, with the same Ladder flag, through the same eligibility
// questions — the whole of the difference from runLadderRound is that a person
// asked for it instead of the clock striking.
//
// # What is deliberately not here
//
// No quota, no allowance, no cooling-off period. A press costs the two engines
// a pairing and nothing else, and somebody who wants to spend their evening
// playing ranked games may. What bounds it is the rule every series has — one
// running at a time per person, and a ceiling across the server — and the fact
// that an engine can only be in one game at a time: `ladderBotStanding` refuses
// a bot that is mid-run, and the round at the top of the hour skips an engine
// that is still in one. The HTTP throttle on the route is about somebody
// rattling the door, not about how many ranked games anybody is allowed.
//
// The thing that keeps this from being the old farmable series is that the
// requester still names nobody. Opponent selection is the property the whole
// rating rests on, and it is not weakened here by a press being what starts the
// match rather than an hour.
//
// # Random, rather than by information
//
// The pairer scores each candidate by how much the ratings would learn from it —
// see ladderPairValue — and this picks uniformly instead. That is a real cost
// and it is worth writing down where somebody will find it: a game teaches most
// at even odds, so a lopsided draw is worth a fraction of an even one, and a
// uniform pick on a spread board draws lopsided most of the time. An author
// pressing this fifty times will learn less about their engine than fifty
// rounds would.
//
// It is uniform because that is what was asked for and because it is the thing
// that is easy to describe on a button: *play somebody*. If ratings still feel
// slow to settle, swapping this for chooseLadderPairings restricted to the one
// engine is a small change and the rest of the route is unaffected.
//
// # Between any two engines
//
// The same match with the opponent named, from the same button, and pressed by
// anybody signed in — neither engine has to be theirs. It was refused for a long
// time on the reasoning at the top of ladder_pool.go — an author who picks their
// own opponents picks the ones they beat — and then allowed only once the other
// owner had accepted, with a day to answer and a day to seat. That was more
// machinery than the risk it guarded against, and nobody could tell from the
// page which of three ranked buttons did what.
//
// What bounds the risk is the rating rather than a question to anybody. A win
// is worth less the more the winner was expected to win, and an opponent that
// keeps losing stops paying almost at once, because its own rating falls with
// every loss; a freshly registered one is worth little too, because a result
// against an unmeasured opponent is discounted. One owner's engines never rate
// each other. And everything but the names stays the rotation's — one pair,
// colours swapped, a drawn mode and clock — so a named match cannot also be a
// chosen clock, and it cannot be stopped after a bad first game (see
// AbortBotSeries).
//
// Both engines have to be entered in the ranked ladder. That switch is the
// consent: it already lets the hour pair an engine with anyone, and a named
// match asks nothing more of it. What a person pressing the button adds is
// themselves, so that is what StartRankedMatch checks: a block between them and
// either engine's owner refuses it, and so does a ranked-play sanction on them.

// errLadderMatchNotEntered is a bot whose owner has not entered it in the pool.
//
// Refused rather than quietly entering it, because the switch is the consent to
// be rated and it is also the consent to spend the machine — and because a
// running client re-asserts its own `ladder` setting from rpsbot.conf on the
// next connect, so entering somebody's engine from here would be a state that
// silently reverts.
var errLadderMatchNotEntered = errors.New(
	"this bot isn't in the ranked ladder",
)

// errLadderMatchNoOpponent is nobody to play: an empty field, or one where
// everybody free is owned by the same person.
var errLadderMatchNoOpponent = errors.New(
	"no other engine is free to play right now; try again in a minute",
)

// ladderMatchBusy is the asking engine itself being unavailable, carrying the
// pairer's own words for why.
//
// A type rather than a wrapped sentinel so that the reason is the whole message
// — "playing this hour's round", "shutting down", "held in reserve for the
// Sunday cup" are already sentences written for an owner to read, and prefixing
// them with a second clause of our own would make the button's error worse than
// the page's. See ladderBotStanding, which is where every one of them comes
// from.
type ladderMatchBusy struct{ reason string }

func (busy ladderMatchBusy) Error() string { return busy.reason }

// Refusals of a ranked match, each worded for whoever pressed the button.
var (
	errRankedEngineGone = errors.New("that engine is not playing any more")
	errRankedOneOwner   = errors.New("one person's engines can't play each other ranked")
	errRankedNotEntered = errors.New("that engine isn't in the ranked ladder")
	errRankedBlocked    = errors.New("you can't start a ranked match with that engine")
	errRankedBarred     = errors.New("this account can't start ranked matches right now")
)

// StartLadderMatch seats one ranked pairing for this bot, now.
//
// Mode and clock are drawn rather than passed, which is the anti-specialisation
// rule from ladder_pool.go surviving the move to an on-demand route: an engine
// tuned for one clock must not be able to be rated only ever at that clock, and
// "the requester picks the conditions" would be exactly that. Drawn per press
// rather than taken from the current hour for the same reason — with the hour's
// conditions, spending an evening's presses inside a favourable hour is the
// same specialisation by another road.
func (server *Server) StartLadderMatch(
	ctx context.Context,
	botID string,
	requestedBy string,
) (persistence.BotSeries, error) {
	// The modes in a random order, taking the first that yields an opponent.
	// With one mode in the rotation this is a draw of one and the loop runs
	// once; it is a loop so that adding a mode back to ladderModes does not turn
	// "your engine does not play this one" into a dead button every other press.
	for _, modeID := range shuffledLadderModes() {
		opponent, err := server.pickLadderOpponent(ctx, botID, modeID)
		if errors.Is(err, errLadderMatchNoOpponent) {
			continue
		}
		if err != nil {
			return persistence.BotSeries{}, err
		}
		return server.StartBotSeries(ctx, BotSeriesRequest{
			FirstBotID:   botID,
			SecondBotID:  opponent,
			ModeID:       modeID,
			Pairs:        1,
			OpeningPlies: ladderOpeningPlies,
			Control:      ladderClocks[rand.IntN(len(ladderClocks))],
			RequestedBy:  requestedBy,
			// Not privileged: anybody may press this for any entered engine, so
			// the ceiling that keeps one visitor from holding every engine at
			// once applies to it as it does to a casual run. The consent it
			// spends is the ladder switch rather than the public-play one, which
			// StartBotSeries reads off this flag.
			//
			// And the flag that makes it count. Set by the pairer and by here,
			// and still by nothing a client can send.
			Ladder: true,
		})
	}
	return persistence.BotSeries{}, errLadderMatchNoOpponent
}

// RankedMatchTerms is what every ranked match is played at, published so the
// Bots page can say so before anybody presses for one.
type RankedMatchTerms struct {
	// Modes are the ones a match can be played at. One is drawn when it is
	// seated, among those both engines play.
	Modes []game.ModeID `json:"modes"`
	// Clocks is the rotation one is drawn from, at the same moment.
	Clocks []game.TimeControl `json:"clocks"`
	// Pairs is always one: two games, colours swapped.
	Pairs int `json:"pairs"`
}

func rankedMatchTerms() *RankedMatchTerms {
	return &RankedMatchTerms{
		Modes:  append([]game.ModeID(nil), ladderModes...),
		Clocks: append([]game.TimeControl(nil), ladderClocks...),
		Pairs:  1,
	}
}

// shuffledLadderModes is the rotation in a random order.
func shuffledLadderModes() []game.ModeID {
	modes := append([]game.ModeID(nil), ladderModes...)
	rand.Shuffle(len(modes), func(one, other int) {
		modes[one], modes[other] = modes[other], modes[one]
	})
	return modes
}

// StartRankedMatch seats one ranked pairing now, for whoever pressed the
// button: between the two engines named, or between the first and an opponent
// the server draws. Neither engine has to be the requester's; see "Between any
// two engines" at the top of this file for why.
func (server *Server) StartRankedMatch(
	ctx context.Context,
	requestedBy string,
	botID string,
	opponentBotID string,
) (persistence.BotSeries, error) {
	bot, err := server.rankedEngine(ctx, botID)
	if err != nil {
		return persistence.BotSeries{}, err
	}
	if server.restrictionOn(requestedBy, persistence.RestrictRanked) != nil {
		return persistence.BotSeries{}, errRankedBarred
	}
	// A block is the owner having already said no to this person, and it
	// covers their engines as much as their messages. See blocks.go.
	if server.blockedBetween(requestedBy, bot.OwnerUserID) {
		return persistence.BotSeries{}, errRankedBlocked
	}
	if strings.TrimSpace(opponentBotID) == "" {
		return server.StartLadderMatch(ctx, bot.BotID, requestedBy)
	}
	opponent, err := server.rankedEngine(ctx, opponentBotID)
	if err != nil {
		return persistence.BotSeries{}, err
	}
	if opponent.BotID == bot.BotID {
		return persistence.BotSeries{}, errSeriesSameBot
	}
	// Two engines one person owns produce no rating — see pickLadderOpponent.
	if opponent.OwnerUserID == bot.OwnerUserID {
		return persistence.BotSeries{}, errRankedOneOwner
	}
	if server.blockedBetween(requestedBy, opponent.OwnerUserID) {
		return persistence.BotSeries{}, errRankedBlocked
	}

	// Entered-ness is the same whichever mode is asked about; the mode only
	// decides which rating comes back with each row.
	entrants, err := server.data.LadderEntrants(ctx, ladderModes[0])
	if err != nil {
		return persistence.BotSeries{}, err
	}
	entered := func(botID string) bool {
		for _, entrant := range entrants {
			if entrant.BotID == botID {
				return true
			}
		}
		return false
	}
	if !entered(bot.BotID) || !entered(opponent.BotID) {
		return persistence.BotSeries{}, errRankedNotEntered
	}

	// The modes in a random order, taking the first both engines can play now.
	// With one mode in the rotation the loop runs once and its refusal is the
	// answer; with more, a mode one of the two does not play is a reason to try
	// the next rather than to refuse. Each refusal carries the engine's name,
	// since "shutting down" alone would not say whose.
	var refusal error = errLadderMatchNoOpponent
	for _, modeID := range shuffledLadderModes() {
		if busy := busyRefusal(bot, server.ladderBotStanding(bot.BotID, modeID)); busy != nil {
			refusal = busy
			continue
		}
		if busy := busyRefusal(opponent, server.ladderBotStanding(opponent.BotID, modeID)); busy != nil {
			refusal = busy
			continue
		}
		return server.StartBotSeries(ctx, BotSeriesRequest{
			FirstBotID:   bot.BotID,
			SecondBotID:  opponent.BotID,
			ModeID:       modeID,
			Pairs:        1,
			OpeningPlies: ladderOpeningPlies,
			Control:      ladderClocks[rand.IntN(len(ladderClocks))],
			RequestedBy:  requestedBy,
			// Not privileged, for the reason StartLadderMatch is not; the
			// consent spent is the ladder switch, checked above.
			Chosen: true,
		})
	}
	return persistence.BotSeries{}, refusal
}

// rankedEngine is a registered engine that can still be seated, or the refusal
// to give whoever named it.
func (server *Server) rankedEngine(ctx context.Context, botID string) (persistence.Bot, error) {
	bot, err := server.data.Bot(ctx, strings.TrimSpace(botID))
	if errors.Is(err, persistence.ErrBotNotFound) {
		return persistence.Bot{}, errRankedEngineGone
	}
	if err != nil {
		return persistence.Bot{}, err
	}
	// An engine with no owner on record has nobody to answer for it.
	if !bot.Claimed || bot.UserID == "" || bot.OwnerUserID == "" || bot.Retired || bot.Disabled {
		return persistence.Bot{}, errRankedEngineGone
	}
	return bot, nil
}

// busyRefusal is why an engine cannot be seated right now, with its name on,
// or nil when it can.
func busyRefusal(bot persistence.Bot, standing ladderBotStanding) error {
	if standing.In && !standing.Waiting {
		return nil
	}
	return ladderMatchBusy{reason: bot.Name + " can't play right now: " + standingReason(standing)}
}

// standingReason is why an engine cannot be seated, in the pairer's own words
// where it gave any. The pairer gives none for an engine whose every slot is
// taken.
func standingReason(standing ladderBotStanding) string {
	if standing.Reason != "" {
		return standing.Reason
	}
	return "it is in a game"
}

// pickLadderOpponent draws an engine for this bot to play at this mode.
//
// Every question the round would ask, asked through ladderBotStanding so that
// the answer is the pairer's and not a second opinion — and one question the
// round does not ask, which is that an opponent must be free *now* rather than
// merely in the round. A round can hold a pairing until an engine comes out of
// a game because it has an hour to play with; a press has a person waiting on
// it, and a button that appeared to do nothing for eleven minutes would be read
// as broken.
func (server *Server) pickLadderOpponent(
	ctx context.Context,
	botID string,
	modeID game.ModeID,
) (string, error) {
	entrants, err := server.data.LadderEntrants(ctx, modeID)
	if err != nil {
		return "", err
	}

	// The asking bot has to be in the field itself. Being absent from this list
	// is exactly "not entered": LadderEntrants is every consenting engine, read
	// from the database rather than from the connected roster, so a switch
	// flipped on the website a second ago is already here.
	var asking *persistence.LadderCandidate
	for index, entrant := range entrants {
		if entrant.BotID == botID {
			asking = &entrants[index]
			break
		}
	}
	if asking == nil {
		return "", errLadderMatchNotEntered
	}
	if standing := server.ladderBotStanding(botID, modeID); !standing.In || standing.Waiting {
		// Waiting is a refusal here even though the round treats it as a yes,
		// and the reason is worth the extra clause: an engine in a game is one
		// the round will pair and hold, but there is nothing for a press to
		// hold on to. The words come from the pairer where it gave any, so the
		// button says "playing this hour's round" rather than inventing a
		// second vocabulary for the same states.
		if standing.Reason != "" {
			return "", ladderMatchBusy{reason: standing.Reason}
		}
		return "", ladderMatchBusy{reason: "this bot is in a game"}
	}

	candidates := make([]string, 0, len(entrants))
	for _, entrant := range entrants {
		if entrant.BotID == botID {
			continue
		}
		// Two engines one person owns produce no rating — their games never
		// move one, whatever the flag on the game says — so seating them would
		// be a press that visibly played two games and moved nothing. The
		// pairer skips these for the same reason; see chooseLadderPairings.
		if asking.OwnerUserID != "" && asking.OwnerUserID == entrant.OwnerUserID {
			continue
		}
		if standing := server.ladderBotStanding(entrant.BotID, modeID); !standing.In ||
			standing.Waiting {
			continue
		}
		candidates = append(candidates, entrant.BotID)
	}
	if len(candidates) == 0 {
		return "", errLadderMatchNoOpponent
	}
	return candidates[rand.IntN(len(candidates))], nil
}

// rankedMatchRequest is the button's optional body.
type rankedMatchRequest struct {
	// OpponentBotID names the engine to play. Empty, or no body at all, lets
	// the server draw one — which is what the button sent before it could name
	// anybody, so an older client still gets PLAY NOW.
	OpponentBotID string `json:"opponentBotId"`
}

// startLadderMatch is the button.
//
// Anybody signed in, for any engine: the engines' consent is their ranked-ladder
// switch, which StartRankedMatch checks, and what the press needs from the
// person is an account that can be held to a block or a sanction. Throttled by
// the series limiter next door, which is the door-rattling guard the public
// series route already uses and not a ceiling on ranked games.
func (server *Server) startLadderMatch(writer http.ResponseWriter, request *http.Request) {
	var input rankedMatchRequest
	if err := decodeAPIRequest(writer, request, &input); err != nil && !errors.Is(err, io.EOF) {
		writeAPIError(writer, http.StatusBadRequest, err.Error())
		return
	}
	account, ok := server.requireSession(writer, request)
	if !ok {
		return
	}
	if !server.allowSeriesRequest(writer, request, account.UserID) {
		return
	}
	series, err := server.StartRankedMatch(
		request.Context(), account.UserID, request.PathValue("botID"), input.OpponentBotID,
	)
	if err != nil {
		writeSeriesError(writer, err)
		return
	}
	writeJSON(writer, http.StatusCreated, series)
}
