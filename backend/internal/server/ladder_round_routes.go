package server

import (
	"context"
	"log"
	"net/http"
	"slices"
	"strings"
	"time"

	"rps-strategy/backend/internal/game"
	"rps-strategy/backend/internal/persistence"
)

// The hourly round, as a page rather than as a countdown.
//
// `/api/ladder-pool` publishes the schedule, and it publishes the field as a
// number: `entered: 7`. That number turned out to be the whole problem. Seven
// of what? An owner who had ticked the switch and left their engine running
// could not tell from anywhere on the site whether it was one of the seven,
// and if it was not, nothing said why — the engine was online, the switch was
// on, and the round went ahead without it. The three commonest answers (it is
// not connected, every slot is in a game, it does not play this round's mode)
// are all invisible from outside the server, and two of them look like the
// site being broken.
//
// So this route answers the two questions that count instead of counting:
//
//   - **Who is in the next one, and why is anybody not.** Every engine that has
//     consented, online or not, with the refusal beside it — which comes from
//     `ladderBotStanding`, the same function the pairer decides with.
//   - **What happened in the last one.** The runs it seated, with their scores.
//     A rating that moves on the hour with nothing to point at is a rating
//     nobody trusts.
//
// Public and unauthenticated like the schedule beside it, and for the same
// reason: "the conditions are not yours to choose" only reads as fair if
// anybody can check what they were. Nothing here is private — these are
// programs playing each other in front of whoever is watching.
//
// One read for the whole page, the shape `/api/weekend` already takes. The page
// is a countdown, a field and a scoreboard, and assembling it from three
// requests shows them disagreeing.

// ladderScheduleAhead is how many rounds the page is told about.
//
// Six hours, which is a horizon rather than a cycle: long enough for an author
// to see that the clock really does move and to find the next round at a
// setting their engine likes, short enough to stay a list rather than a table.
// Deliberately not tied to ladderRotationHours — a rotation that grew a mode
// back would be twelve hours long, and twelve rows of schedule is not a thing
// anybody reads.
const ladderScheduleAhead = 6

// LadderFieldEngine is one engine in the field for the next round.
type LadderFieldEngine struct {
	BotID      string `json:"botId"`
	UserID     string `json:"userId"`
	Name       string `json:"name"`
	IconSHA256 string `json:"iconSha256,omitempty"`
	// Author is whoever registered it, and empty for a reference engine the
	// host runs or an owner whose account has been anonymized.
	Author string `json:"author,omitempty"`
	// Reference marks a yardstick: in every round whatever anybody set, because
	// the scale is measured from it. Flagged rather than filtered out, so the
	// page can say that in words — an engine that is in the field for a reason
	// its owner did not choose is the single most confusing row here.
	Reference   bool                    `json:"reference"`
	Rating      int                     `json:"rating"`
	RatingState persistence.RatingState `json:"ratingState"`
	// Online is whether anybody is running this engine at all.
	//
	// Apart from Ready because the two are read differently. Every other reason
	// an engine will not be seated is about an engine that is *here* — playing,
	// shutting down, held for an event, not built for this mode — and is worth
	// a row, because it says something about the round. An engine nobody is
	// running is not news; it is a name the list would carry every hour until
	// its owner happened to start it. The page counts those instead of drawing
	// them, and still serves them, because an owner's own offline engine is
	// exactly what their own panel has to be able to explain.
	Online bool `json:"online"`
	// Ready is whether the round will use this engine at all, which is the
	// question the page is really asking. Reason says why not when it will not,
	// and is empty when it will.
	Ready bool `json:"ready"`
	// Waiting is an engine the round will use once it is free rather than at the
	// top of the hour, because it is in a game right now. Ready is true for
	// these, and they are what "the round waits for you" looks like from
	// outside: the pairing is made and held. See resumeHeldPairings.
	Waiting bool   `json:"waiting"`
	Reason  string `json:"reason,omitempty"`
}

// LadderRoundReport is one round that has run, with what it produced.
type LadderRoundReport struct {
	AtUnixMs      int64       `json:"atUnixMs"`
	ModeID        game.ModeID `json:"modeId"`
	InitialTimeMs int64       `json:"initialTimeMs"`
	IncrementMs   int64       `json:"incrementMs"`
	// Series is what it seated, newest first, each with its games. Empty for a
	// round that found nobody online — which is a real outcome and is drawn as
	// one, rather than as a round that did not happen.
	Series []persistence.BotSeries `json:"series"`
}

// LadderRoundsView is the page.
type LadderRoundsView struct {
	IntervalMs int64 `json:"intervalMs"`
	// GraceMs is how late a slot may still be seated. Published for the reason
	// getLadderPool gives: it is what lets a client decide whether the head of
	// the schedule is a round still owed or one that has already run, and the
	// field below is computed for whichever of those the server picked.
	GraceMs int64 `json:"graceMs"`
	// RotationHours is how long the published schedule takes to repeat.
	//
	// Served rather than restated in the client for the same reason the rating
	// scale's two constants are: it is derived from two lists that live in the
	// server, and a page that wrote the number down would go on claiming the
	// old one after either list changed. That has a shape — a sentence saying
	// twelve hours above a list that visibly repeats every four.
	RotationHours int `json:"rotationHours"`
	GamesPerRound int `json:"gamesPerRound"`
	RoundsRun     int `json:"roundsRun"`
	// MinimumField is how many engines have to be available for a round to seat
	// anything. Published because a field of one is a round that will not run,
	// and the page should be able to say so before the hour rather than leaving
	// somebody to conclude the pool is broken.
	MinimumField      int   `json:"minimumField"`
	LastRoundAtUnixMs int64 `json:"lastRoundAtUnixMs"`
	// Schedule is this round and the next few, soonest first, exactly as
	// `/api/ladder-pool` serves it.
	Schedule []LadderRoundPreview `json:"schedule"`
	// Field is for the head of that schedule — the round being counted down to
	// — because availability is a question about one mode and the mode changes
	// every hour.
	Field []LadderFieldEngine `json:"field"`
	Last  *LadderRoundReport  `json:"last,omitempty"`
	// AnchorBotID is empty when no reference engine is designated, in which case
	// the board is measured from its own weakest engine rather than from chance.
	// See LadderRoundView.relativeScale on the client.
	AnchorBotID             string  `json:"anchorBotId"`
	RatingFloor             int     `json:"ratingFloor"`
	RatingPointsPerDoubling float64 `json:"ratingPointsPerDoubling"`
}

// getLadderRounds publishes the field and the last round's results.
func (server *Server) getLadderRounds(writer http.ResponseWriter, request *http.Request) {
	ctx := request.Context()
	state, err := server.data.LadderPool(ctx)
	if err != nil {
		writeAPIError(writer, http.StatusInternalServerError, "could not read the ladder pool")
		return
	}
	yardsticks, err := server.data.BotYardsticks(ctx)
	if err != nil {
		writeAPIError(writer, http.StatusInternalServerError, "could not read the yardsticks")
		return
	}

	now := time.Now()
	// The round the countdown points at, which during the few minutes of grace
	// after an hour is the one still owed rather than the next one. Taken from
	// the same function the pairer uses so the field cannot be computed for a
	// different round than the one the page is counting down to.
	next := nextLadderRound(now, time.UnixMilli(state.LastRoundAtUnixMs))
	nextMode, _ := ladderConditions(next)

	view := LadderRoundsView{
		IntervalMs:              ladderRoundInterval.Milliseconds(),
		GraceMs:                 ladderRoundGrace.Milliseconds(),
		RotationHours:           ladderRotationHours(),
		GamesPerRound:           2 * ladderMaxRoundsPerBot,
		RoundsRun:               state.RoundsRun,
		MinimumField:            ladderMinimumField,
		LastRoundAtUnixMs:       state.LastRoundAtUnixMs,
		Schedule:                server.ladderSchedule(ctx, now, ladderScheduleAhead),
		Field:                   server.ladderField(ctx, nextMode),
		Last:                    server.lastLadderRound(ctx, state.LastRoundAtUnixMs),
		AnchorBotID:             yardsticks.AnchorBotID,
		RatingFloor:             persistence.RatingFloor,
		RatingPointsPerDoubling: persistence.RatingPointsPerDoubling,
	}
	writeJSON(writer, http.StatusOK, view)
}

// ladderField is who is entered for a round in this mode, and who among them
// would actually be seated.
//
// Every consenting engine, connected or not, which is the difference from
// `ladderFieldSize` next door: that one counts what a round would find, and
// this one has to include the engines a round would *not* find, because "mine
// is not in the list and I do not know why" is the complaint it exists to
// answer.
func (server *Server) ladderField(
	ctx context.Context,
	modeID game.ModeID,
) []LadderFieldEngine {
	entrants, err := server.data.LadderEntrants(ctx, modeID)
	if err != nil {
		log.Printf("ladder pool: read entrants: %v", err)
		return []LadderFieldEngine{}
	}

	field := make([]LadderFieldEngine, 0, len(entrants))
	for _, entrant := range entrants {
		standing := server.ladderBotStanding(entrant.BotID, modeID)
		field = append(field, LadderFieldEngine{
			BotID:      entrant.BotID,
			UserID:     entrant.UserID,
			Name:       entrant.Name,
			IconSHA256: entrant.IconSHA256,
			Author:     entrant.Owner,
			Reference:  entrant.Reference,
			Rating:     entrant.Rating,
			// The mode's own rating, which is what the pairer reads: a rating is
			// only worth reading against the game it is being earned in, and
			// this round is one game.
			RatingState: entrant.State,
			// Read through the same call the refusal above went through rather
			// than off the reason string. The words are for a person and are
			// free to change; whether a socket exists is a fact, and a client
			// deciding what to draw should not be matching on prose.
			Online:  server.readyBot(entrant.BotID) != nil,
			Ready:   standing.In,
			Waiting: standing.Waiting,
			Reason:  standing.Reason,
		})
	}

	// In the round first, then strongest, then by name — the order the round
	// itself would be built in, so the top of the list is the part that is news.
	// Engines that are waiting for a game to finish sort with the rest of the
	// field rather than below it, because they are in the round: the tag on the
	// row is what says their games start late.
	// Unrated below measured whatever the numbers say, for the reason the
	// leaderboard's own ordering gives: both print the floor, and an engine
	// nobody has placed sorting above a measured one because of that is the
	// exact thing RatingState exists to stop.
	slices.SortFunc(field, func(left, right LadderFieldEngine) int {
		if left.Ready != right.Ready {
			if left.Ready {
				return -1
			}
			return 1
		}
		if left.RatingState.Ranked() != right.RatingState.Ranked() {
			if left.RatingState.Ranked() {
				return -1
			}
			return 1
		}
		if left.Rating != right.Rating {
			return right.Rating - left.Rating
		}
		return strings.Compare(strings.ToLower(left.Name), strings.ToLower(right.Name))
	})
	return field
}

// lastLadderRound is the round that ran most recently, and what came of it.
//
// Nil before the pool has ever run one, which is a real state on a new server
// and on one whose database was just reset. A page with no last round says so;
// a page handed a round at the epoch would draw January 1970.
func (server *Server) lastLadderRound(
	ctx context.Context,
	lastRoundAtUnixMs int64,
) *LadderRoundReport {
	if lastRoundAtUnixMs <= 0 {
		return nil
	}
	at := time.UnixMilli(lastRoundAtUnixMs)
	// Derived from the hour rather than stored, the same way the round itself
	// derived them when it ran — so these are the conditions that round was
	// played under and not a guess at them. See ladderConditions.
	modeID, clock := ladderConditions(at)
	// The window is the round's own hour. See LadderSeriesBetween for why that
	// identifies a round, and why the ladder flag is the other half of it.
	series, err := server.data.LadderSeriesBetween(
		ctx, lastRoundAtUnixMs, at.Add(ladderRoundInterval).UnixMilli(),
	)
	if err != nil {
		log.Printf("ladder pool: read last round: %v", err)
		series = nil
	}
	if series == nil {
		series = []persistence.BotSeries{}
	}
	return &LadderRoundReport{
		AtUnixMs:      lastRoundAtUnixMs,
		ModeID:        modeID,
		InitialTimeMs: clock.InitialTimeMs,
		IncrementMs:   clock.IncrementMs,
		Series:        series,
	}
}
