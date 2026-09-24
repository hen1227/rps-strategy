package server

import (
	"context"
	"errors"
	"math/rand/v2"
	"net/http"

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
// a pairing and nothing else, and an author who wants to spend their evening
// playing ranked games may. What bounds it is not a budget but the fact that an
// engine can only be in one game at a time: `ladderBotStanding` refuses a bot
// that is mid-run, so pressing again while a match is playing does nothing, and
// the round at the top of the hour skips an engine that is still in one. The
// HTTP throttle on the route is about somebody rattling the door, not about how
// many ranked games anybody is allowed.
//
// The thing that keeps this from being the old farmable series is that the
// requester still names nobody. Opponent selection is the property the whole
// rating rests on, and it is not weakened here by a press being what starts the
// match rather than an hour.
//
// # Random, rather than by information
//
// The pairer scores each candidate by how much the fit would learn from it —
// see ladderPairValue — and this picks uniformly instead. That is a real cost
// and it is worth writing down where somebody will find it: information per
// game is p(1-p), so a lopsided draw is worth a fraction of an even one, and a
// uniform pick on a spread board draws lopsided most of the time. An author
// pressing this fifty times will move their rating less than fifty rounds
// would.
//
// It is uniform because that is what was asked for and because it is the thing
// that is easy to describe on a button: *play somebody*. If ratings still feel
// slow to settle, swapping this for chooseLadderPairings restricted to the one
// engine is a small change and the rest of the route is unaffected.

// errLadderMatchNotEntered is a bot whose owner has not entered it in the pool.
//
// Refused rather than quietly entering it, because the switch is the consent to
// be rated and it is also the consent to spend the machine — and because a
// running client re-asserts its own `ladder` setting from rpsbot.conf on the
// next connect, so entering somebody's engine from here would be a state that
// silently reverts.
var errLadderMatchNotEntered = errors.New(
	"this bot is not entered in the hourly rounds",
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
			// Privileged, for the same reason startLadderPairing is: the public
			// ceilings in bot_series.go are about one visitor not monopolising
			// other people's engines, and the consent being spent here is the
			// ladder switch rather than the public-play one. It lifts no check
			// that matters to this route — a busy engine is still busy, since
			// freeBotConnection is not privilege-gated.
			Privileged: true,
			// And the flag that makes it count. Set by the pairer and by here,
			// and still by nothing a client can send.
			Ladder: true,
		})
	}
	return persistence.BotSeries{}, errLadderMatchNoOpponent
}

// shuffledLadderModes is the rotation in a random order.
func shuffledLadderModes() []game.ModeID {
	modes := append([]game.ModeID(nil), ladderModes...)
	rand.Shuffle(len(modes), func(one, other int) {
		modes[one], modes[other] = modes[other], modes[one]
	})
	return modes
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
	// is exactly "not entered": LadderEntrants is every consenting engine plus
	// the yardsticks, read from the database rather than from the connected
	// roster, so a switch flipped on the website a second ago is already here.
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
		// Two engines one person owns produce no rating — the fit drops the
		// pair whatever the flag on the game says — so seating them would be a
		// press that visibly played two games and moved nothing. The pairer
		// skips these for the same reason; see chooseLadderPairings.
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

// startLadderMatch is the button.
//
// Owner-only, through the same requireBotOwner every other write about a bot
// goes through — a press spends this engine's owner's machine, and the switch
// that consents to that is theirs. Throttled by the series limiter next door,
// which is the door-rattling guard the public series route already uses and not
// a ceiling on ranked games: six presses in five minutes is far more than an
// engine playing two games at a time can consume.
func (server *Server) startLadderMatch(writer http.ResponseWriter, request *http.Request) {
	bot, ok := server.requireBotOwner(writer, request)
	if !ok {
		return
	}
	if !server.allowSeriesRequest(writer, request, bot.OwnerUserID) {
		return
	}
	series, err := server.StartLadderMatch(request.Context(), bot.BotID, bot.OwnerUserID)
	if err != nil {
		writeSeriesError(writer, err)
		return
	}
	writeJSON(writer, http.StatusCreated, series)
}
