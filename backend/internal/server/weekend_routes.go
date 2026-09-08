package server

import (
	"context"
	"errors"
	"log"
	"net/http"
	"slices"
	"strings"
	"time"

	"rps-strategy/backend/internal/persistence"
)

// The weekend arena's own API: one read for the page, one write per vote, and
// the host's settings behind adminOnly.
//
// The page needs a lot at once — a countdown, this weekend's plan, two polls,
// the engines expected to turn up — and every part of it is cheap. One request
// rather than six keeps the page from showing a countdown before it knows what
// it is counting down to.

// WeekendPollView is one poll as a page draws it.
type WeekendPollView struct {
	// Options is the whole ballot in its fixed order, so a choice with no votes
	// is still something you can click.
	Options []string                   `json:"options"`
	Tallies []persistence.WeekendTally `json:"tallies"`
	// Mine is this account's current choice, empty when they have not voted.
	Mine string `json:"mine"`
	// Leading is what would win if the poll closed now, which is not always the
	// top tally: a thin turnout or a tie falls back to the host's default.
	Leading string `json:"leading"`
	Votes   int    `json:"votes"`
	// MinimumVotes is the turnout the ballot has to reach before it carries.
	// Published because a page that shows a vote not counting has to be able to
	// say why — otherwise the fallback looks like the site ignoring you.
	MinimumVotes int  `json:"minimumVotes"`
	Open         bool `json:"open"`
	// ClosesAtUnixMs is when it locks, and zero for a poll that never closes.
	ClosesAtUnixMs int64 `json:"closesAtUnixMs,omitempty"`
}

// WeekendEngine is one entry in the expected field.
type WeekendEngine struct {
	Name   string `json:"name"`
	UserID string `json:"userId"`
	Author string `json:"author"`
	Online bool   `json:"online"`
	// Reason is why this engine will not be entered, and empty when it will be.
	Reason string `json:"reason,omitempty"`
}

// WeekendView is everything the page shows.
type WeekendView struct {
	Enabled bool `json:"enabled"`
	// Zone, StartDay and StartLocal say when it meets, in the host's own terms,
	// which a page can print without re-deriving them from a timestamp. Every
	// *slot* is published as an instant instead — see WeekendSlotView.
	Zone       string `json:"zone"`
	StartLocal string `json:"startLocal"`
	StartDay   int    `json:"startDay"`
	ModeID     string `json:"modeId"`
	ModeName   string `json:"modeName"`
	// DoorsAtUnixMs and StartsAtUnixMs are this weekend's, or next weekend's
	// once this one has been and gone.
	DoorsAtUnixMs  int64 `json:"doorsAtUnixMs,omitempty"`
	StartsAtUnixMs int64 `json:"startsAtUnixMs,omitempty"`
	// EventDate is the local date the countdown belongs to.
	EventDate     string `json:"eventDate,omitempty"`
	MinimumField  int    `json:"minimumField"`
	GamesPerMatch int    `json:"gamesPerMatch"`
	RoundRobinMax int    `json:"roundRobinMax"`
	// Tournament is this weekend's event once its doors are open, and absent
	// before.
	Tournament *TournamentSnapshot `json:"tournament,omitempty"`
	// Expected is the field as it stands: every engine on the roster, with the
	// reason beside any that will not be entered.
	Expected []WeekendEngine `json:"expected"`
	// Clock is this weekend's ballot.
	Clock WeekendPollView `json:"clock"`
	// Availability is the standing answer to "when can you make it": every slot
	// of the window, how many people can play it, and whether you are one of
	// them.
	Availability WeekendAvailabilityView `json:"availability"`
	// Recent is the series' own history, most recent first.
	Recent []persistence.Tournament `json:"recent"`
	// Crown is who holds the rolling weekend title, and how many wins it took.
	Crown []WeekendCrown `json:"crown"`
}

// WeekendSlotView is one slot of the availability window.
type WeekendSlotView struct {
	// Slot is an offset into the host's window, and is what a vote sends back.
	// AtUnixMs is the next instant it falls on, which is what a page prints — in
	// its reader's own time and on its reader's own weekday, because the field is
	// worldwide and "Saturday 20:00" is not only meaningless to everybody but the
	// host, it is wrong for anybody far enough east to be into Sunday by then.
	Slot     int   `json:"slot"`
	AtUnixMs int64 `json:"atUnixMs"`
	People   int   `json:"people"`
	Mine     bool  `json:"mine"`
}

// WeekendAvailabilityView is the whole window, plus what it currently decides.
type WeekendAvailabilityView struct {
	Slots []WeekendSlotView `json:"slots"`
	// Answered is how many people have said anything at all, which is the
	// denominator the page shows beside each slot.
	Answered int `json:"answered"`
	// Leading is the slot that would be chosen now — not always the fullest one,
	// since a tie or a thin turnout keeps the slot we already meet at.
	Leading int `json:"leading"`
	// LeadingAtUnixMs is that slot as an instant, for the same reason as above.
	LeadingAtUnixMs int64 `json:"leadingAtUnixMs"`
	// Mine is how many slots this reader has marked, so the page can tell
	// "answered none" from "answered, and none of these".
	Mine int `json:"mine"`
}

// WeekendCrown is a holder of the rolling weekend title.
type WeekendCrown struct {
	UserID string `json:"userId"`
	Name   string `json:"name"`
	Wins   int    `json:"wins"`
}

// weekendCrownWindow is how far back the rolling crown looks.
//
// Ninety days rather than for ever, which is the whole difference between this
// and Tournament Champion: a crown you can lose is one worth watching, and a
// badge everybody eventually holds is not a badge. Three months where the
// nightly used one, so the window still spans a dozen events rather than four.
const weekendCrownWindow = 90 * 24 * time.Hour

// nextWeekendDate is the local date of the next weekend the schedule runs.
//
// Today if it has not started yet, otherwise the next occurrence of the day it
// runs on. Bounded at a fortnight so a skipped date cannot spin.
func nextWeekendDate(config persistence.WeekendConfig, now time.Time) (string, time.Time, bool) {
	location, err := time.LoadLocation(strings.TrimSpace(config.Zone))
	if err != nil {
		return "", time.Time{}, false
	}
	local := now.In(location)
	for offset := range 15 {
		day := local.AddDate(0, 0, offset)
		date := day.Format("2006-01-02")
		if !config.RunsOn(day) || config.SkipDate == date {
			continue
		}
		startAt, err := config.WeekendStartFor(date)
		if err != nil {
			continue
		}
		// Today only counts while it is still ahead of us.
		if offset == 0 && !local.Before(startAt) {
			continue
		}
		return date, startAt, true
	}
	return "", time.Time{}, false
}

// getWeekend is the page's one read.
func (server *Server) getWeekend(writer http.ResponseWriter, request *http.Request) {
	ctx := request.Context()
	config, err := server.data.WeekendConfiguration(ctx)
	if err != nil {
		writeAPIError(writer, http.StatusInternalServerError, "the weekend arena is unavailable")
		return
	}
	// Signed in or not: the page is readable by anybody, and a session only
	// decides whether it can show you your own vote.
	viewer := ""
	if account, ok := server.optionalSession(request); ok {
		viewer = account.UserID
	}

	view := WeekendView{
		Enabled:       config.Enabled,
		Zone:          config.Zone,
		StartLocal:    config.StartLocal,
		StartDay:      config.StartDay,
		ModeID:        string(config.ModeID),
		ModeName:      server.modeNameFor(config.ModeID),
		MinimumField:  config.MinimumField,
		GamesPerMatch: config.GamesPerMatch,
		RoundRobinMax: config.RoundRobinMax,
		Expected:      server.expectedWeekendField(ctx, config),
	}

	now := time.Now()
	eventDate, startAt, scheduled := nextWeekendDate(config, now)
	if scheduled {
		view.EventDate = eventDate
		view.StartsAtUnixMs = startAt.UnixMilli()
		view.DoorsAtUnixMs = startAt.
			Add(-time.Duration(config.DoorsMinutes) * time.Minute).UnixMilli()
	}

	// This weekend's event, if its doors are open. Read through the same
	// snapshot the socket broadcasts, so the page sees live match state without
	// a second shape to understand.
	if open, err := server.data.OpenWeekend(ctx); err == nil {
		for _, snapshot := range server.tournamentSnapshots(ctx) {
			if snapshot.TournamentID == open.TournamentID {
				view.Tournament = &snapshot
				break
			}
		}
		// The ballot belongs to the open event's own date rather than to the
		// next scheduled one, or a vote cast during doors would land on next
		// weekend.
		eventDate = strings.TrimPrefix(open.TournamentID, "nightly-")
		view.EventDate = eventDate
		// And so does the countdown. An open event carries the hour it means to
		// start, which is not always the next one on the calendar — an event the
		// host opened by hand at half past ten starts tonight, and pointing the
		// countdown at next weekend's slot would be a page confidently counting
		// down to the wrong thing.
		if open.StartsAtUnixMs != nil {
			view.StartsAtUnixMs = *open.StartsAtUnixMs
			startAt = time.UnixMilli(*open.StartsAtUnixMs)
			scheduled = true
		}
	}

	pollCloses := int64(0)
	if scheduled {
		pollCloses = startAt.
			Add(-time.Duration(config.PollClosesMinutes) * time.Minute).UnixMilli()
	}
	view.Clock = server.weekendPollView(
		ctx, persistence.WeekendVoteClock, eventDate, viewer,
		controlKeys(), config.DefaultControl, config.MinimumVotes,
		config.PollEnabled && server.clockPollOpen(ctx, config, now),
		pollCloses,
	)
	// Availability has no deadline: it is a thing people drift, and the schedule
	// follows it a week behind.
	view.Availability = server.weekendAvailabilityView(ctx, config, viewer, now)

	// Every list here is an empty slice rather than a nil one, all the way out.
	// A nil slice marshals as `null`, and a client reading `.length` off it
	// crashes — which is not a hypothetical: it is what this page did the first
	// time it was rendered, with no votes cast and no crown to show.
	view.Recent = make([]persistence.Tournament, 0)
	if recent, err := server.data.RecentWeekends(ctx, 10); err == nil && recent != nil {
		view.Recent = recent
	}
	view.Crown = server.weekendCrown(ctx)
	writeJSON(writer, http.StatusOK, view)
}

// clockPollOpen reports whether the ballot is still taking votes.
//
// Measured against the event that is actually open where there is one, and
// against the calendar otherwise. The two disagree whenever a host opens an
// event by hand, and the open event is the one people are voting on.
func (server *Server) clockPollOpen(
	ctx context.Context,
	config persistence.WeekendConfig,
	now time.Time,
) bool {
	startAt := time.Time{}
	if open, err := server.data.OpenWeekend(ctx); err == nil {
		if open.Status != persistence.TournamentRegistration {
			// It has started. Nothing left to vote on.
			return false
		}
		if open.StartsAtUnixMs != nil {
			startAt = time.UnixMilli(*open.StartsAtUnixMs)
		}
	}
	if startAt.IsZero() {
		next, scheduled := time.Time{}, false
		_, next, scheduled = nextWeekendDate(config, now)
		if !scheduled {
			return false
		}
		startAt = next
	}
	closesAt := startAt.Add(-time.Duration(config.PollClosesMinutes) * time.Minute)
	return now.Before(closesAt)
}

func controlKeys() []string {
	keys := make([]string, 0, len(persistence.WeekendControls))
	for _, control := range persistence.WeekendControls {
		keys = append(keys, control.Key)
	}
	return keys
}

func (server *Server) weekendPollView(
	ctx context.Context,
	kind string,
	eventDate string,
	viewer string,
	options []string,
	fallback string,
	minimum int,
	open bool,
	closesAt int64,
) WeekendPollView {
	tallies, mine, err := server.data.WeekendPoll(ctx, kind, eventDate, viewer)
	if err != nil || tallies == nil {
		tallies = make([]persistence.WeekendTally, 0)
	}
	votes := 0
	for _, tally := range tallies {
		votes += tally.Votes
	}
	return WeekendPollView{
		Options:        options,
		Tallies:        tallies,
		Mine:           mine,
		Leading:        persistence.WeekendWinner(tallies, minimum, fallback),
		Votes:          votes,
		MinimumVotes:   minimum,
		Open:           open,
		ClosesAtUnixMs: closesAt,
	}
}

// weekendAvailabilityView is the window, with every slot carrying the instant
// it next falls on.
//
// The instant is the whole trick, and it is what makes a weekly event possible
// at all. Sending "slot 11" and letting each client work out what that means in
// its own zone would mean twenty-four clients getting daylight saving right
// independently, and every one of them also having to decide which *day* it
// landed on. Sending the moment it happens means every page formats one
// timestamp — weekday and hour together — and is correct by construction.
func (server *Server) weekendAvailabilityView(
	ctx context.Context,
	config persistence.WeekendConfig,
	viewer string,
	now time.Time,
) WeekendAvailabilityView {
	counts, mine, answered, err := server.data.WeekendAvailability(ctx, viewer)
	if err != nil {
		log.Printf("weekend: read availability: %v", err)
	}
	view := WeekendAvailabilityView{
		Slots:    make([]WeekendSlotView, 0, persistence.WeekendSlots),
		Answered: answered,
	}
	for slot := range persistence.WeekendSlots {
		entry := WeekendSlotView{Slot: slot, People: counts[slot], Mine: mine[slot]}
		if at, err := config.SlotAt(slot, now); err == nil {
			entry.AtUnixMs = at.UnixMilli()
		}
		if mine[slot] {
			view.Mine++
		}
		view.Slots = append(view.Slots, entry)
	}
	view.Leading = persistence.WeekendAvailabilityWinner(
		counts, answered, config.MinimumVotes, config.SlotOf(),
	)
	if at, err := config.SlotAt(view.Leading, now); err == nil {
		view.LeadingAtUnixMs = at.UnixMilli()
	}
	return view
}

// expectedWeekendField is the roster as the sweep would see it right now.
//
// The same questions enrolOnlineBots asks, asked without entering anybody, so
// the page can show an author why their engine is not on the list before the
// event starts rather than after it has been left out.
func (server *Server) expectedWeekendField(
	ctx context.Context,
	config persistence.WeekendConfig,
) []WeekendEngine {
	field := make([]WeekendEngine, 0)
	for _, presence := range server.botRoster() {
		client := server.readyBot(presence.BotID)
		if client == nil {
			continue
		}
		client.bot.mu.Lock()
		record := client.bot.record
		handshake := client.bot.handshake
		client.bot.mu.Unlock()

		engine := WeekendEngine{Name: record.Name, UserID: record.UserID, Online: true}
		if owner, err := server.data.Account(ctx, record.OwnerUserID); err == nil {
			engine.Author = owner.Username
			if !owner.DiscordVerified {
				engine.Reason = "its owner has not verified with Discord"
			}
		}
		switch {
		case engine.Reason != "":
		case !record.EnterTournaments:
			engine.Reason = "set not to enter tournaments"
		case botIsDraining(client):
			engine.Reason = "shutting down"
		case !handshake.Supports(config.ModeID):
			engine.Reason = "does not play " + server.modeNameFor(config.ModeID)
		case server.tournamentRefusal(record.UserID) != "":
			engine.Reason = server.tournamentRefusal(record.UserID)
		}
		field = append(field, engine)
	}
	// Eligible first, then by name, so the list reads as "here is the field" and
	// not as a roster dump.
	slices.SortFunc(field, func(left, right WeekendEngine) int {
		if (left.Reason == "") != (right.Reason == "") {
			if left.Reason == "" {
				return -1
			}
			return 1
		}
		return strings.Compare(strings.ToLower(left.Name), strings.ToLower(right.Name))
	})
	return field
}

// weekendCrown is who leads the rolling title, and by how much.
func (server *Server) weekendCrown(ctx context.Context) []WeekendCrown {
	crown := make([]WeekendCrown, 0, 1)
	wins, err := server.data.WeekendWins(
		ctx, time.Now().Add(-weekendCrownWindow).UnixMilli(),
	)
	if err != nil || len(wins) == 0 {
		return crown
	}
	best := 0
	for _, count := range wins {
		if count > best {
			best = count
		}
	}
	for userID, count := range wins {
		if count < best {
			continue
		}
		holder := WeekendCrown{UserID: userID, Wins: count, Name: userID}
		if account, err := server.data.Account(ctx, userID); err == nil {
			holder.Name = account.Username
		}
		crown = append(crown, holder)
	}
	// Shared on a tie, and in a stable order — the same rule the champion set
	// uses, for the same reason: nobody should hold it because of a sort.
	slices.SortFunc(crown, func(left, right WeekendCrown) int {
		return strings.Compare(strings.ToLower(left.Name), strings.ToLower(right.Name))
	})
	return crown
}

/* ------------------------------------------------------------- voting -- */

type weekendVoteRequest struct {
	Kind   string `json:"kind"`
	Choice string `json:"choice"`
}

// castWeekendVote records one account's answer to one of the polls.
func (server *Server) castWeekendVote(writer http.ResponseWriter, request *http.Request) {
	account, ok := server.requireSession(writer, request)
	if !ok {
		return
	}
	var input weekendVoteRequest
	if err := decodeAPIRequest(writer, request, &input); err != nil {
		writeAPIError(writer, http.StatusBadRequest, err.Error())
		return
	}
	ctx := request.Context()
	config, err := server.data.WeekendConfiguration(ctx)
	if err != nil {
		writeAPIError(writer, http.StatusInternalServerError, "the weekend arena is unavailable")
		return
	}

	now := time.Now()
	eventDate := ""
	switch strings.TrimSpace(input.Kind) {
	case persistence.WeekendVoteClock:
		if !config.PollEnabled {
			writeAPIError(writer, http.StatusConflict, "the clock is not being voted on")
			return
		}
		if _, valid := persistence.WeekendControlFor(input.Choice); !valid {
			writeAPIError(writer, http.StatusBadRequest, persistence.ErrWeekendVoteInvalid.Error())
			return
		}
		if !server.clockPollOpen(ctx, config, now) {
			writeAPIError(writer, http.StatusConflict, persistence.ErrWeekendPollClosed.Error())
			return
		}
		date, _, scheduled := nextWeekendDate(config, now)
		if !scheduled {
			writeAPIError(writer, http.StatusConflict, "no event is scheduled")
			return
		}
		eventDate = date
		// A ballot cast while this weekend's doors are open belongs to this
		// weekend, not to the next one the calendar offers.
		if open, err := server.data.OpenWeekend(ctx); err == nil &&
			open.Status == persistence.TournamentRegistration {
			eventDate = strings.TrimPrefix(open.TournamentID, "nightly-")
		}
	default:
		writeAPIError(writer, http.StatusBadRequest, "unknown poll")
		return
	}

	if err := server.data.CastWeekendVote(
		ctx, strings.TrimSpace(input.Kind), eventDate, account.UserID, input.Choice,
	); err != nil {
		writeTournamentError(writer, err)
		return
	}
	server.getWeekend(writer, request)
}

type weekendAvailabilityRequest struct {
	// Slots of the host's window. The whole set, every time: a slot left out is
	// one you cannot make, which is why there is nothing to delete.
	Slots []int `json:"slots"`
}

// setWeekendAvailability records when one account can play.
//
// A set rather than a choice, and that is the point. With a field spread across
// every continent, "which single slot do you want" splits thirty-six ways and
// picks whichever corner of the world happened to show up; "which can you make"
// is answerable by everybody and has a fullest answer.
func (server *Server) setWeekendAvailability(
	writer http.ResponseWriter,
	request *http.Request,
) {
	account, ok := server.requireSession(writer, request)
	if !ok {
		return
	}
	var input weekendAvailabilityRequest
	if err := decodeAPIRequest(writer, request, &input); err != nil {
		writeAPIError(writer, http.StatusBadRequest, err.Error())
		return
	}
	if len(input.Slots) > persistence.WeekendSlots {
		writeAPIError(writer, http.StatusBadRequest, "the window is thirty-six hours long")
		return
	}
	if err := server.data.SetWeekendAvailability(
		request.Context(), account.UserID, input.Slots,
	); err != nil {
		if errors.Is(err, persistence.ErrWeekendVoteInvalid) {
			writeAPIError(writer, http.StatusBadRequest, err.Error())
			return
		}
		writeTournamentError(writer, err)
		return
	}
	server.getWeekend(writer, request)
}

/* -------------------------------------------------------------- admin -- */

func (server *Server) getWeekendConfig(writer http.ResponseWriter, request *http.Request) {
	config, err := server.data.WeekendConfiguration(request.Context())
	if err != nil {
		writeAPIError(writer, http.StatusInternalServerError, "the weekend arena is unavailable")
		return
	}
	writeJSON(writer, http.StatusOK, map[string]any{
		"config":   config,
		"controls": persistence.WeekendControls,
		// Published so the admin panel can label the window it is sliding
		// without hard-coding a length the server owns.
		"windowHours": persistence.WeekendSlots,
	})
}

func (server *Server) saveWeekendConfig(writer http.ResponseWriter, request *http.Request) {
	var input persistence.WeekendConfig
	if err := decodeAPIRequest(writer, request, &input); err != nil {
		writeAPIError(writer, http.StatusBadRequest, err.Error())
		return
	}
	// LastRunDate is the scheduler's own bookkeeping, not a setting. Taking it
	// from the request would let a save re-open an event that has already run.
	current, err := server.data.WeekendConfiguration(request.Context())
	if err != nil {
		writeAPIError(writer, http.StatusInternalServerError, "the weekend arena is unavailable")
		return
	}
	input.LastRunDate = current.LastRunDate
	if !server.registry.Has(input.ModeID) {
		writeAPIError(writer, http.StatusBadRequest, "unknown game mode")
		return
	}
	saved, err := server.data.SaveWeekendConfiguration(request.Context(), input)
	if err != nil {
		writeTournamentError(writer, err)
		return
	}
	writeJSON(writer, http.StatusOK, saved)
}

// runWeekendNow opens this weekend's doors immediately, for a host testing it.
//
// It does not skip the start: the event carries its own start time and waits
// for it — see the guard in beginWeekend — so what this tests is the half that
// is hard to wait for. Starting it early is the "start" button the tournament
// board already has.
func (server *Server) runWeekendNow(writer http.ResponseWriter, request *http.Request) {
	ctx := request.Context()
	config, err := server.data.WeekendConfiguration(ctx)
	if err != nil {
		writeAPIError(writer, http.StatusInternalServerError, "the weekend arena is unavailable")
		return
	}
	if _, err := server.data.OpenWeekend(ctx); err == nil {
		writeAPIError(writer, http.StatusConflict, "a weekend arena is already open")
		return
	}
	location, err := time.LoadLocation(strings.TrimSpace(config.Zone))
	if err != nil {
		writeAPIError(writer, http.StatusBadRequest, "the configured time zone is unknown")
		return
	}
	now := time.Now().In(location)
	today := now.Format("2006-01-02")
	startAt, err := config.WeekendStartFor(today)
	if err != nil {
		writeAPIError(writer, http.StatusBadRequest, "the configured start time is unreadable")
		return
	}
	// A test run an hour before the scheduled start should still count down to
	// something in the future.
	if !now.Before(startAt) {
		startAt = now.Add(time.Duration(config.DoorsMinutes) * time.Minute)
	}
	server.openWeekendDoors(ctx, config, today, startAt)
	opened, err := server.data.OpenWeekend(ctx)
	if err != nil {
		writeAPIError(writer, http.StatusInternalServerError, "the event could not be opened")
		return
	}
	writeJSON(writer, http.StatusCreated, opened)
}
