package persistence

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"rps-strategy/backend/internal/game"
)

// The weekend bot arena: the settings that outlive one event, and the votes
// that decide the next one.
//
// Everything here is *about* weekend events rather than part of them. One is an
// ordinary tournament — created, published, started and scored by the same code
// as any other — and what this file adds is the two things a recurring event
// needs that a one-off does not: a schedule that survives a restart, and a way
// for the people watching to decide what it plays.
//
// # Why a wall clock and a zone
//
// bot_bench.go makes the case for exact UTC instants over "a wall clock plus a
// location", and it is right for a one-off window. It is precisely wrong for a
// recurring one: "every Saturday at eight" has to mean eight o'clock in
// November as well as in July, and a stored UTC instant means seven o'clock for
// half the year. So the schedule is a weekday plus a local time plus an IANA
// zone, and cmd/server imports time/tzdata so the zone resolves from the binary
// rather than from whatever the host happens to have in /usr/share/zoneinfo.
//
// # Why the vote is a window and not an hour
//
// This ran nightly once, and an hour of the day was enough to name a slot: the
// event came round again tomorrow, so "20:00" meant the next 20:00 and every
// reader's own evening was the same evening. Weekly on a weekend breaks that.
// An hour on its own no longer says *which* night, and it cannot be made to:
// Saturday 21:00 in New York is already Sunday in Berlin, so a grid of
// twenty-four bare hours would have half the world voting for a day it did not
// mean.
//
// So the ballot is a window of consecutive hours rather than a day of them —
// WeekendSlots of them, laid end to end from the hour the window opens. A slot
// is a fixed weekday-and-hour in the host's zone, and the server hands each one
// out with the instant it next falls on. Every client formats that one instant
// in its own zone, weekday and all, and is correct by construction: a reader in
// Auckland sees "Sunday 14:00" for the slot a reader in New York sees as
// "Saturday 21:00", and they are both looking at the same moment.
//
// # Storage names
//
// The tables, the tournament kind and the tournament id prefix all still say
// "nightly". They are the stored vocabulary of events already in the archive,
// which titles.go and the rolling crown read, and renaming them would rewrite
// history to no one's benefit. Everything a person reads, and everything the
// code calls itself, says "weekend".

// WeekendControl is one option on the clock ballot.
//
// Fixed in code rather than configured: they are the ballot, and a ballot whose
// options can change while it is open is not one. The host picks the default
// among them and can turn the vote off entirely.
type WeekendControl struct {
	Key         string `json:"key"`
	InitialTime int    `json:"initialTimeMs"`
	Increment   int    `json:"incrementMs"`
}

// WeekendControls is the ballot, fastest first.
var WeekendControls = []WeekendControl{
	{Key: "10s+1", InitialTime: 10_000, Increment: 1_000},
	{Key: "1+1", InitialTime: 60_000, Increment: 1_000},
	{Key: "3+1", InitialTime: 180_000, Increment: 1_000},
	{Key: "3+5", InitialTime: 180_000, Increment: 5_000},
	{Key: "5+2", InitialTime: 300_000, Increment: 2_000},
}

// WeekendControlFor resolves a ballot key, and reports whether it is one.
func WeekendControlFor(key string) (WeekendControl, bool) {
	for _, control := range WeekendControls {
		if control.Key == strings.TrimSpace(key) {
			return control, true
		}
	}
	return WeekendControl{}, false
}

// WeekendSlots is how many hours long the voting window is.
//
// Thirty-six rather than twenty-four, because a weekly event has to name a
// night as well as an hour and a day of hours cannot. Thirty-six rather than
// the whole forty-eight because a window that opens mid-morning on Saturday and
// closes on Sunday evening holds both of the evenings anybody would actually
// schedule this at, in most of the zones anybody actually plays from, without
// asking people to scan two full days of empty small hours.
//
// It is not neutral and cannot be: wherever thirty-six hours sit, some zone
// loses one of its two evenings. That is why the window's opening hour is a
// setting rather than a constant — see WeekendConfig.WindowOpensDay.
const WeekendSlots = 36

// hoursInWeek is the modulus every slot calculation works in.
const hoursInWeek = 7 * 24

const (
	// WeekendVoteClock is the ballot for one event's time control. It belongs to
	// a date and closes before that event starts.
	WeekendVoteClock = "clock"
	// WeekendVoteGame is the vote for the best game of a finished weekend.
	WeekendVoteGame = "game"
)

var (
	// ErrWeekendVoteInvalid covers a choice that is not on the ballot.
	ErrWeekendVoteInvalid = errors.New("that is not one of the options")
	// ErrWeekendPollClosed is the answer to voting on an event that has started.
	ErrWeekendPollClosed = errors.New("voting for that event has closed")
)

// WeekendConfig is every decision a host makes about the recurring event.
//
// One row, and it outlives every tournament it creates — which is the whole
// point: "Saturday at eight, Intransitive, six engines minimum" is a property
// of the series, not of this weekend.
type WeekendConfig struct {
	Enabled bool `json:"enabled"`
	// Zone is an IANA name. StartLocal is "HH:MM" in it, and StartDay the
	// weekday it falls on, 0 = Sunday.
	Zone       string `json:"zone"`
	StartLocal string `json:"startLocal"`
	StartDay   int    `json:"startDay"`
	// WindowOpensDay and WindowOpensHour are the first slot of the voting
	// window, in the host's zone; it runs WeekendSlots hours from there.
	//
	// A setting rather than a constant because no thirty-six hours are fair to
	// everybody, and which continent gets both of its evenings is a decision
	// about who the event is for. The host can slide it once they see who turns
	// up.
	WindowOpensDay  int         `json:"windowOpensDay"`
	WindowOpensHour int         `json:"windowOpensHour"`
	ModeID          game.ModeID `json:"modeId"`
	// MinimumField is how many engines have to be online at the start for the
	// event to happen at all. Below it the event is called off with the reason
	// said out loud rather than quietly not appearing.
	MinimumField int `json:"minimumField"`
	// DoorsMinutes is how long before the start registration opens, and
	// PollClosesMinutes how long before it the clock ballot locks.
	DoorsMinutes      int `json:"doorsMinutes"`
	PollClosesMinutes int `json:"pollClosesMinutes"`
	GamesPerMatch     int `json:"gamesPerMatch"`
	// RoundRobinMax is the largest field that still plays everybody. Above it
	// the event is a Swiss, which is the right tool for a big field rather than
	// a truncated round robin.
	RoundRobinMax int `json:"roundRobinMax"`
	// PollEnabled turns the clock ballot on. Off, every weekend plays
	// DefaultControl.
	PollEnabled    bool   `json:"pollEnabled"`
	DefaultControl string `json:"defaultControl"`
	// MinimumVotes is the turnout below which the ballot is ignored. Two people
	// should not pick the clock for everybody.
	MinimumVotes int `json:"minimumVotes"`
	// GraceSeconds is how long a match waits for an engine that has gone away
	// before its unplayed games are forfeited.
	GraceSeconds int `json:"graceSeconds"`
	// SkipDate is a single local date the host has called off, "YYYY-MM-DD".
	SkipDate string `json:"skipDate"`
	// LastRunDate is the last local date this opened its doors, which is what
	// makes the scheduler idempotent across a restart.
	LastRunDate     string `json:"lastRunDate"`
	UpdatedAtUnixMs int64  `json:"updatedAtUnixMs"`
}

// DefaultWeekendConfig is what a server that has never been configured holds.
//
// Disabled, because a server that starts running tournaments on Saturday night
// because somebody deployed it is not a good surprise.
func DefaultWeekendConfig() WeekendConfig {
	return WeekendConfig{
		Enabled:    false,
		Zone:       "America/New_York",
		StartLocal: "20:00",
		StartDay:   int(time.Saturday),
		// Saturday morning through Sunday evening. It holds both Saturday 20:00
		// and Sunday 20:00 in the host's zone — the two slots this would ever be
		// scheduled at by hand — and it reaches far enough east that Europe gets
		// both of its evenings and Asia gets Sunday.
		WindowOpensDay:  int(time.Saturday),
		WindowOpensHour: 9,
		// Intransitive, which is the game this event is for. Total War was the
		// seed value on the day this shipped and was never a choice.
		ModeID:            game.ModeIntransitive,
		MinimumField:      6,
		DoorsMinutes:      30,
		PollClosesMinutes: 60,
		GamesPerMatch:     2,
		RoundRobinMax:     10,
		PollEnabled:       true,
		DefaultControl:    "3+1",
		MinimumVotes:      3,
		GraceSeconds:      90,
	}
}

func (store *Store) ensureWeekendSchema(ctx context.Context) error {
	const schema = `
CREATE TABLE IF NOT EXISTS nightly_config (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    enabled INTEGER NOT NULL DEFAULT 0,
    zone TEXT NOT NULL,
    start_local TEXT NOT NULL,
    days TEXT NOT NULL,
    mode_id TEXT NOT NULL,
    minimum_field INTEGER NOT NULL,
    doors_minutes INTEGER NOT NULL,
    poll_closes_minutes INTEGER NOT NULL,
    games_per_match INTEGER NOT NULL,
    round_robin_max INTEGER NOT NULL,
    poll_enabled INTEGER NOT NULL,
    default_control TEXT NOT NULL,
    minimum_votes INTEGER NOT NULL,
    grace_seconds INTEGER NOT NULL,
    skip_date TEXT NOT NULL DEFAULT '',
    last_run_date TEXT NOT NULL DEFAULT '',
    updated_at_unix_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS nightly_votes (
    kind TEXT NOT NULL,
    night_date TEXT NOT NULL,
    user_id TEXT NOT NULL,
    choice TEXT NOT NULL,
    cast_at_unix_ms INTEGER NOT NULL,
    PRIMARY KEY (kind, night_date, user_id)
);
`
	if _, err := store.db.ExecContext(ctx, schema); err != nil {
		return fmt.Errorf("migrate weekend schema: %w", err)
	}
	if err := store.ensureWeekendScheduleColumns(ctx); err != nil {
		return err
	}
	if err := store.ensureWeekendAvailabilitySchema(ctx); err != nil {
		return err
	}

	// A one-time correction, for the rows this feature seeded on the single day
	// it defaulted to Total War.
	//
	// Once, and the flag is what makes it once. Re-running it every boot would
	// mean a host who deliberately picks Total War from the admin tab has their
	// choice quietly undone by the next restart — which is precisely the thing
	// "unless an administrator says otherwise" rules out.
	columns, err := tableColumns(ctx, store.db, "nightly_config")
	if err != nil {
		return fmt.Errorf("inspect weekend config schema: %w", err)
	}
	if !columns["mode_default_corrected"] {
		if _, err := store.db.ExecContext(ctx,
			`ALTER TABLE nightly_config ADD COLUMN mode_default_corrected INTEGER NOT NULL DEFAULT 0`,
		); err != nil {
			return fmt.Errorf("add weekend mode correction flag: %w", err)
		}
		if _, err := store.db.ExecContext(ctx, `
UPDATE nightly_config SET mode_id = ?, mode_default_corrected = 1
WHERE id = 1 AND mode_id = ?
`, string(game.ModeIntransitive), string(game.ModeTotalWar)); err != nil {
			return fmt.Errorf("default the weekend arena to intransitive: %w", err)
		}
	}

	config := DefaultWeekendConfig()
	if _, err := store.db.ExecContext(ctx, `
INSERT OR IGNORE INTO nightly_config (
    id, enabled, zone, start_local, start_day, window_opens_day,
    window_opens_hour, days, mode_id, minimum_field, doors_minutes,
    poll_closes_minutes, games_per_match, round_robin_max, poll_enabled,
    default_control, minimum_votes, grace_seconds, updated_at_unix_ms
) VALUES (1, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)
`,
		config.Zone, config.StartLocal, config.StartDay, config.WindowOpensDay,
		config.WindowOpensHour, strconv.Itoa(config.StartDay), string(config.ModeID),
		config.MinimumField, config.DoorsMinutes, config.PollClosesMinutes,
		config.GamesPerMatch, config.RoundRobinMax, config.DefaultControl,
		config.MinimumVotes, config.GraceSeconds, time.Now().UnixMilli(),
	); err != nil {
		return fmt.Errorf("seed weekend config: %w", err)
	}
	return nil
}

// ensureWeekendScheduleColumns adds the weekday and window this needs and the
// nightly schedule did not.
//
// A row written by the nightly build has an hour and a set of weekdays, and the
// set is the part that stops meaning anything: a weekly event runs on one day.
// Saturday is the day such a row is moved to, and the default window is the one
// that holds the hour it was already running at.
func (store *Store) ensureWeekendScheduleColumns(ctx context.Context) error {
	columns, err := tableColumns(ctx, store.db, "nightly_config")
	if err != nil {
		return fmt.Errorf("inspect weekend config schema: %w", err)
	}
	defaults := DefaultWeekendConfig()
	added := []struct {
		name       string
		definition string
	}{
		{"start_day", fmt.Sprintf("INTEGER NOT NULL DEFAULT %d", defaults.StartDay)},
		{"window_opens_day", fmt.Sprintf("INTEGER NOT NULL DEFAULT %d", defaults.WindowOpensDay)},
		{"window_opens_hour", fmt.Sprintf("INTEGER NOT NULL DEFAULT %d", defaults.WindowOpensHour)},
	}
	for _, column := range added {
		if columns[column.name] {
			continue
		}
		if _, err := store.db.ExecContext(ctx,
			"ALTER TABLE nightly_config ADD COLUMN "+column.name+" "+column.definition,
		); err != nil {
			return fmt.Errorf("add weekend column %s: %w", column.name, err)
		}
	}
	return nil
}

// ensureWeekendAvailabilitySchema builds the slot grid, replacing the hour grid
// the nightly voted on, and carries the old answers onto it.
//
// The carry is a projection rather than a copy, because the two grids ask
// different questions. "I can play at nine" was an answer about every day at
// once — the nightly grid had no day in it to name — so the faithful reading is
// that nine o'clock works on whichever days of the window it falls on. Hour 20
// becomes Saturday 20:00 *and* Sunday 20:00; hour 3, which the window only
// reaches on the Sunday, becomes the one slot.
//
// Dropping them instead would be the tidier migration and the wrong one: it
// would reset every standing answer to nothing, and `minimumVotes` gates on
// turnout, so the grid would stop carrying at all until the field re-answered a
// question it had already answered.
//
// The rebuild is also the only way to be rid of the CHECK that pinned the column
// to 0–23, which SQLite cannot alter in place.
func (store *Store) ensureWeekendAvailabilitySchema(ctx context.Context) error {
	columns, err := tableColumns(ctx, store.db, "nightly_availability")
	if err != nil {
		return fmt.Errorf("inspect weekend availability schema: %w", err)
	}
	legacy := len(columns) > 0 && !columns["slot"] && columns["hour"]

	type answer struct {
		userID  string
		hour    int
		updated int64
	}
	var carried []answer
	window := DefaultWeekendConfig()
	if legacy {
		// The window these hours are being projected onto. Read from the row
		// rather than assumed, since ensureWeekendScheduleColumns has already
		// run and a host may have moved it.
		if err := store.db.QueryRowContext(ctx,
			`SELECT window_opens_day, window_opens_hour FROM nightly_config WHERE id = 1`,
		).Scan(&window.WindowOpensDay, &window.WindowOpensHour); err != nil &&
			!errors.Is(err, sql.ErrNoRows) {
			return fmt.Errorf("read the weekend window: %w", err)
		}

		rows, err := store.db.QueryContext(ctx,
			`SELECT user_id, hour, updated_at_unix_ms FROM nightly_availability`)
		if err != nil {
			return fmt.Errorf("read the hour-of-day availability grid: %w", err)
		}
		for rows.Next() {
			var row answer
			if err := rows.Scan(&row.userID, &row.hour, &row.updated); err != nil {
				rows.Close()
				return fmt.Errorf("read the hour-of-day availability grid: %w", err)
			}
			carried = append(carried, row)
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			return fmt.Errorf("read the hour-of-day availability grid: %w", err)
		}
		// Closed before the writes below: one SQLite connection, and an open
		// cursor holds it.
		if err := rows.Close(); err != nil {
			return fmt.Errorf("read the hour-of-day availability grid: %w", err)
		}
		if _, err := store.db.ExecContext(ctx, `DROP TABLE nightly_availability`); err != nil {
			return fmt.Errorf("drop the hour-of-day availability grid: %w", err)
		}
	}

	// Who can make which slot, as a set per person.
	//
	// A row per person per slot, because this is approval voting rather than a
	// ballot: with a field spread across every continent, asking each person for
	// their one favourite slot splits thirty-six ways and settles nothing, while
	// asking which slots they *can make* and taking the fullest one is the
	// question everybody is actually answering. See WeekendAvailabilityWinner.
	//
	// The slot is an offset into the host's window, which is where the schedule
	// lives. Clients never see it in those terms — the server hands each slot
	// out with the instant it next falls on, and the page prints that in the
	// reader's own time, weekday and all.
	if _, err := store.db.ExecContext(ctx, fmt.Sprintf(`
CREATE TABLE IF NOT EXISTS nightly_availability (
    user_id TEXT NOT NULL,
    slot INTEGER NOT NULL CHECK (slot BETWEEN 0 AND %d),
    updated_at_unix_ms INTEGER NOT NULL,
    PRIMARY KEY (user_id, slot)
);
`, WeekendSlots-1)); err != nil {
		return fmt.Errorf("migrate weekend availability schema: %w", err)
	}

	for _, row := range carried {
		for _, slot := range window.slotsAtHour(row.hour) {
			if _, err := store.db.ExecContext(ctx, `
INSERT OR IGNORE INTO nightly_availability (user_id, slot, updated_at_unix_ms)
VALUES (?, ?, ?)
`, row.userID, slot, row.updated); err != nil {
				return fmt.Errorf("carry availability onto the weekend window: %w", err)
			}
		}
	}
	return nil
}

// slotsAtHour is every slot of the window that falls at an hour of the day.
//
// Two of them for an hour the window covers on both days, one for an hour it
// only reaches on one, and none for an hour it misses entirely — which is the
// honest answer for somebody whose only workable hours are outside it.
func (config WeekendConfig) slotsAtHour(hour int) []int {
	slots := make([]int, 0, 2)
	for slot := range WeekendSlots {
		if (config.WindowOpensHour+slot)%24 == hour {
			slots = append(slots, slot)
		}
	}
	return slots
}

// WeekendConfiguration reads the one row.
func (store *Store) WeekendConfiguration(ctx context.Context) (WeekendConfig, error) {
	var config WeekendConfig
	var modeID string
	var enabled, pollEnabled int
	err := store.db.QueryRowContext(ctx, `
SELECT enabled, zone, start_local, start_day, window_opens_day, window_opens_hour,
       mode_id, minimum_field, doors_minutes, poll_closes_minutes, games_per_match,
       round_robin_max, poll_enabled, default_control, minimum_votes, grace_seconds,
       skip_date, last_run_date, updated_at_unix_ms
FROM nightly_config WHERE id = 1
`).Scan(
		&enabled, &config.Zone, &config.StartLocal, &config.StartDay,
		&config.WindowOpensDay, &config.WindowOpensHour, &modeID,
		&config.MinimumField, &config.DoorsMinutes, &config.PollClosesMinutes,
		&config.GamesPerMatch, &config.RoundRobinMax, &pollEnabled,
		&config.DefaultControl, &config.MinimumVotes, &config.GraceSeconds,
		&config.SkipDate, &config.LastRunDate, &config.UpdatedAtUnixMs,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return DefaultWeekendConfig(), nil
	}
	if err != nil {
		return WeekendConfig{}, fmt.Errorf("read weekend config: %w", err)
	}
	config.Enabled = enabled == 1
	config.PollEnabled = pollEnabled == 1
	config.ModeID = game.ModeID(modeID)
	// Healed on the way out as well as on the way in. A row written by the
	// nightly build carries an hour that need not sit anywhere near the window
	// this one votes in, and a start no slot can name is a start nobody can vote
	// to move. See clampStartIntoWindow.
	return clampStartIntoWindow(config), nil
}

// SaveWeekendConfiguration writes the whole row.
//
// Validated rather than trusted, and clamped rather than refused wherever a
// silly answer has an obvious sane neighbour: this is a control panel, and a
// host who types 0 for the minimum field wants "no minimum", not an error.
func (store *Store) SaveWeekendConfiguration(
	ctx context.Context,
	config WeekendConfig,
) (WeekendConfig, error) {
	if _, err := time.LoadLocation(strings.TrimSpace(config.Zone)); err != nil {
		return WeekendConfig{}, fmt.Errorf(
			"%w: %q is not a time zone this server knows", ErrInvalidTournament, config.Zone)
	}
	if _, _, err := parseLocalClock(config.StartLocal); err != nil {
		return WeekendConfig{}, fmt.Errorf(
			"%w: the start time must be HH:MM", ErrInvalidTournament)
	}
	if config.StartDay < 0 || config.StartDay > 6 {
		return WeekendConfig{}, fmt.Errorf(
			"%w: the start day must be a day of the week", ErrInvalidTournament)
	}
	if config.WindowOpensDay < 0 || config.WindowOpensDay > 6 {
		return WeekendConfig{}, fmt.Errorf(
			"%w: the window has to open on a day of the week", ErrInvalidTournament)
	}
	if config.WindowOpensHour < 0 || config.WindowOpensHour > 23 {
		return WeekendConfig{}, fmt.Errorf(
			"%w: the window has to open at an hour of the day", ErrInvalidTournament)
	}
	if _, ok := WeekendControlFor(config.DefaultControl); !ok {
		return WeekendConfig{}, fmt.Errorf(
			"%w: %q is not one of the time controls", ErrInvalidTournament, config.DefaultControl)
	}
	if config.SkipDate != "" {
		if _, err := time.Parse("2006-01-02", config.SkipDate); err != nil {
			return WeekendConfig{}, fmt.Errorf(
				"%w: the skipped date must be YYYY-MM-DD", ErrInvalidTournament)
		}
	}

	clamp := func(value, low, high int) int {
		if value < low {
			return low
		}
		if value > high {
			return high
		}
		return value
	}
	config.MinimumField = clamp(config.MinimumField, 2, 64)
	config.DoorsMinutes = clamp(config.DoorsMinutes, 5, 24*60)
	config.PollClosesMinutes = clamp(config.PollClosesMinutes, 0, config.DoorsMinutes)
	config.GamesPerMatch = normalizeGamesPerMatch(config.GamesPerMatch)
	config.RoundRobinMax = clamp(config.RoundRobinMax, 2, 64)
	config.MinimumVotes = clamp(config.MinimumVotes, 0, 1000)
	config.GraceSeconds = clamp(config.GraceSeconds, 0, 15*60)
	// A start outside the window is dragged to the nearer end of it rather than
	// refused, which is the same clamping rule as the numbers above and matters
	// more: a host sliding the window to suit the field should not have to
	// re-enter the start time to be allowed to save.
	config = clampStartIntoWindow(config)

	if _, err := store.db.ExecContext(ctx, `
UPDATE nightly_config SET
    enabled = ?, zone = ?, start_local = ?, start_day = ?, window_opens_day = ?,
    window_opens_hour = ?, days = ?, mode_id = ?, minimum_field = ?,
    doors_minutes = ?, poll_closes_minutes = ?, games_per_match = ?,
    round_robin_max = ?, poll_enabled = ?, default_control = ?, minimum_votes = ?,
    grace_seconds = ?, skip_date = ?, updated_at_unix_ms = ?
WHERE id = 1
`,
		boolToInt(config.Enabled), strings.TrimSpace(config.Zone),
		strings.TrimSpace(config.StartLocal), config.StartDay, config.WindowOpensDay,
		config.WindowOpensHour,
		// `days` is vestigial: this runs on one day a week now, and start_day is
		// the setting. It is still written because SQLite cannot drop a NOT NULL
		// column without rebuilding the table, and what it is written with is the
		// start day — so the column stays true rather than becoming a stale list
		// somebody trusts later.
		strconv.Itoa(config.StartDay),
		string(config.ModeID), config.MinimumField, config.DoorsMinutes,
		config.PollClosesMinutes, config.GamesPerMatch, config.RoundRobinMax,
		boolToInt(config.PollEnabled), config.DefaultControl, config.MinimumVotes,
		config.GraceSeconds, config.SkipDate, time.Now().UnixMilli(),
	); err != nil {
		return WeekendConfig{}, fmt.Errorf("save weekend config: %w", err)
	}
	return store.WeekendConfiguration(ctx)
}

// MarkWeekendRun records the local date whose doors have been opened.
//
// The whole of the scheduler's idempotence: a restart at one minute past eight
// reads this, sees today's date, and does not open a second event.
func (store *Store) MarkWeekendRun(ctx context.Context, localDate string) error {
	if _, err := store.db.ExecContext(ctx,
		`UPDATE nightly_config SET last_run_date = ? WHERE id = 1`, localDate,
	); err != nil {
		return fmt.Errorf("mark weekend run: %w", err)
	}
	return nil
}

// parseLocalClock reads "HH:MM".
func parseLocalClock(value string) (int, int, error) {
	parts := strings.Split(strings.TrimSpace(value), ":")
	if len(parts) != 2 {
		return 0, 0, errors.New("expected HH:MM")
	}
	hour, err := strconv.Atoi(parts[0])
	if err != nil || hour < 0 || hour > 23 {
		return 0, 0, errors.New("hour out of range")
	}
	minute, err := strconv.Atoi(parts[1])
	if err != nil || minute < 0 || minute > 59 {
		return 0, 0, errors.New("minute out of range")
	}
	return hour, minute, nil
}

// WeekendStartFor is when an event whose local date is `localDate` begins.
func (config WeekendConfig) WeekendStartFor(localDate string) (time.Time, error) {
	location, err := time.LoadLocation(strings.TrimSpace(config.Zone))
	if err != nil {
		return time.Time{}, fmt.Errorf("weekend zone: %w", err)
	}
	day, err := time.ParseInLocation("2006-01-02", localDate, location)
	if err != nil {
		return time.Time{}, fmt.Errorf("weekend date: %w", err)
	}
	hour, minute, err := parseLocalClock(config.StartLocal)
	if err != nil {
		return time.Time{}, fmt.Errorf("weekend time: %w", err)
	}
	// Built from the parsed day rather than by adding hours to midnight, so a
	// clock change in the middle of the night lands on the wall clock the host
	// asked for rather than an hour either side of it.
	return time.Date(
		day.Year(), day.Month(), day.Day(), hour, minute, 0, 0, location,
	), nil
}

// RunsOn reports whether a local date is the weekday this runs on.
func (config WeekendConfig) RunsOn(when time.Time) bool {
	return int(when.Weekday()) == config.StartDay
}

/* ------------------------------------------------------------------ votes -- */

// WeekendTally is one option's standing in a poll.
type WeekendTally struct {
	Choice string `json:"choice"`
	Votes  int    `json:"votes"`
}

// CastWeekendVote records or changes one account's vote.
//
// Changeable up to the moment the poll closes, because a poll you cannot change
// your mind in is one people vote in late and grudgingly. The caller decides
// whether the poll is open; this stores what it is told.
func (store *Store) CastWeekendVote(
	ctx context.Context,
	kind string,
	eventDate string,
	userID string,
	choice string,
) error {
	userID = strings.TrimSpace(userID)
	choice = strings.TrimSpace(choice)
	if userID == "" || choice == "" {
		return fmt.Errorf("%w: a vote needs a voter and a choice", ErrInvalidTournament)
	}
	if _, err := store.db.ExecContext(ctx, `
INSERT INTO nightly_votes (kind, night_date, user_id, choice, cast_at_unix_ms)
VALUES (?, ?, ?, ?, ?)
ON CONFLICT (kind, night_date, user_id)
DO UPDATE SET choice = excluded.choice, cast_at_unix_ms = excluded.cast_at_unix_ms
`, kind, eventDate, userID, choice, time.Now().UnixMilli()); err != nil {
		return fmt.Errorf("cast weekend vote: %w", err)
	}
	return nil
}

// WeekendPoll is the standing of one poll, and what this account voted for.
//
// Ordered by votes and then by choice, so a tie is not a different picture on
// every read.
func (store *Store) WeekendPoll(
	ctx context.Context,
	kind string,
	eventDate string,
	userID string,
) ([]WeekendTally, string, error) {
	rows, err := store.db.QueryContext(ctx, `
SELECT choice, COUNT(*) FROM nightly_votes
WHERE kind = ? AND night_date = ?
GROUP BY choice
ORDER BY COUNT(*) DESC, choice
`, kind, eventDate)
	if err != nil {
		return nil, "", fmt.Errorf("read weekend poll: %w", err)
	}
	defer rows.Close()
	tallies := make([]WeekendTally, 0)
	for rows.Next() {
		var tally WeekendTally
		if err := rows.Scan(&tally.Choice, &tally.Votes); err != nil {
			return nil, "", fmt.Errorf("read weekend poll: %w", err)
		}
		tallies = append(tallies, tally)
	}
	if err := rows.Err(); err != nil {
		return nil, "", fmt.Errorf("read weekend poll: %w", err)
	}
	// Closed before the second read: one SQLite connection, and an open cursor
	// holds it.
	if err := rows.Close(); err != nil {
		return nil, "", fmt.Errorf("read weekend poll: %w", err)
	}

	var mine string
	if strings.TrimSpace(userID) != "" {
		err := store.db.QueryRowContext(ctx, `
SELECT choice FROM nightly_votes WHERE kind = ? AND night_date = ? AND user_id = ?
`, kind, eventDate, strings.TrimSpace(userID)).Scan(&mine)
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			return nil, "", fmt.Errorf("read own weekend vote: %w", err)
		}
	}
	return tallies, mine, nil
}

// WeekendWinner is the leading choice of a poll, or the fallback.
//
// The fallback wins on a tie as well as on a thin turnout, which is the honest
// reading of both: neither says the field chose something.
func WeekendWinner(tallies []WeekendTally, minimum int, fallback string) string {
	total := 0
	for _, tally := range tallies {
		total += tally.Votes
	}
	if total < minimum || len(tallies) == 0 {
		return fallback
	}
	if len(tallies) > 1 && tallies[0].Votes == tallies[1].Votes {
		return fallback
	}
	return tallies[0].Choice
}

// PurgeWeekendVotes drops a finished event's ballot.
//
// The clock ballot is spent once the event has played; the slot preference and
// the game-of-the-weekend vote are not, so only the named kind goes.
func (store *Store) PurgeWeekendVotes(ctx context.Context, kind string, before string) error {
	if _, err := store.db.ExecContext(ctx,
		`DELETE FROM nightly_votes WHERE kind = ? AND night_date < ? AND night_date <> ''`,
		kind, before,
	); err != nil {
		return fmt.Errorf("purge weekend votes: %w", err)
	}
	return nil
}

/* ------------------------------------------------------- weekend events -- */

// NextWeekendNumber is the serial the next event gets.
//
// Counted from the events themselves rather than kept in the config row, so a
// deleted event leaves a gap rather than making the next one repeat a number
// somebody has already seen.
func (store *Store) NextWeekendNumber(ctx context.Context) (int, error) {
	var highest int
	if err := store.db.QueryRowContext(ctx,
		`SELECT COALESCE(MAX(nightly_number), 0) FROM tournaments WHERE kind = ?`,
		string(TournamentWeekend),
	).Scan(&highest); err != nil {
		return 0, fmt.Errorf("read weekend number: %w", err)
	}
	return highest + 1, nil
}

// OpenWeekend is this weekend's event, whatever stage it is at, or not found.
//
// "Open" meaning not yet finished: the one a page has to show, whether it is
// taking entries or being played.
func (store *Store) OpenWeekend(ctx context.Context) (Tournament, error) {
	var tournamentID string
	err := store.db.QueryRowContext(ctx, `
SELECT tournament_id FROM tournaments
WHERE kind = ? AND completed_at_unix_ms IS NULL AND cancelled_at_unix_ms IS NULL
ORDER BY created_at_unix_ms DESC
LIMIT 1
`, string(TournamentWeekend)).Scan(&tournamentID)
	if errors.Is(err, sql.ErrNoRows) {
		return Tournament{}, ErrTournamentNotFound
	}
	if err != nil {
		return Tournament{}, fmt.Errorf("read open weekend: %w", err)
	}
	return store.Tournament(ctx, tournamentID)
}

// RecentWeekends is the series' own history, most recent first.
func (store *Store) RecentWeekends(ctx context.Context, limit int) ([]Tournament, error) {
	if limit <= 0 || limit > 100 {
		limit = 20
	}
	rows, err := store.db.QueryContext(ctx, `
SELECT tournament_id FROM tournaments
WHERE kind = ?
ORDER BY COALESCE(completed_at_unix_ms, created_at_unix_ms) DESC
LIMIT ?
`, string(TournamentWeekend), limit)
	if err != nil {
		return nil, fmt.Errorf("read weekend history: %w", err)
	}
	ids := make([]string, 0, limit)
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return nil, fmt.Errorf("read weekend history: %w", err)
		}
		ids = append(ids, id)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, fmt.Errorf("read weekend history: %w", err)
	}
	// Closed before the per-event reads below, which need the connection this
	// cursor is holding.
	if err := rows.Close(); err != nil {
		return nil, fmt.Errorf("read weekend history: %w", err)
	}

	events := make([]Tournament, 0, len(ids))
	for _, id := range ids {
		tournament, err := store.Tournament(ctx, id)
		if err != nil {
			return nil, err
		}
		events = append(events, tournament)
	}
	return events, nil
}

// ConfigureWeekendStart writes the decisions that could not be made when the
// doors opened.
//
// The format depends on how many engines turned up and the clock on how the
// poll went, and neither is known until the moment the field closes. That is
// why this exists rather than the scheduler calling UpdateTournament, which
// freezes both once an event is published — and rightly so for a host editing
// an event people have entered. This is the same event settling the two things
// it always said it would settle at the start.
func (store *Store) ConfigureWeekendStart(
	ctx context.Context,
	tournamentID string,
	format TournamentFormat,
	initialTimeMs int,
	incrementMs int,
) (Tournament, error) {
	if !format.Valid() {
		return Tournament{}, fmt.Errorf("%w: unknown format %q", ErrInvalidTournament, format)
	}
	var kind, stored string
	var publishedAt, cancelledAt *int64
	if err := store.db.QueryRowContext(ctx, `
SELECT kind, status, published_at_unix_ms, cancelled_at_unix_ms
FROM tournaments WHERE tournament_id = ?
`, tournamentID).Scan(&kind, &stored, &publishedAt, &cancelledAt); errors.Is(err, sql.ErrNoRows) {
		return Tournament{}, ErrTournamentNotFound
	} else if err != nil {
		return Tournament{}, fmt.Errorf("configure weekend: read tournament: %w", err)
	}
	if TournamentKind(kind).Normalized() != TournamentWeekend {
		return Tournament{}, fmt.Errorf(
			"%w: only a weekend arena settles its format at the start", ErrInvalidTournament)
	}
	if derivedStatus(TournamentStatus(stored), publishedAt, cancelledAt) != TournamentRegistration {
		return Tournament{}, ErrTournamentClosed
	}
	if _, err := store.db.ExecContext(ctx, `
UPDATE tournaments SET format = ?, initial_time_ms = ?, increment_ms = ?
WHERE tournament_id = ?
`, string(format), initialTimeMs, incrementMs, tournamentID); err != nil {
		return Tournament{}, fmt.Errorf("configure weekend: %w", err)
	}
	return store.Tournament(ctx, tournamentID)
}

// WeekendWins counts each account's weekend victories since a cutoff.
//
// The rolling crown reads this. Counted from the events rather than stored,
// like every other title here, so deleting an event takes its win back with it.
func (store *Store) WeekendWins(
	ctx context.Context,
	since int64,
) (map[string]int, error) {
	events, err := store.RecentWeekends(ctx, 100)
	if err != nil {
		return nil, err
	}
	wins := make(map[string]int)
	for _, event := range events {
		if event.Status != TournamentCompleted {
			continue
		}
		if event.CompletedAtUnixMs == nil || *event.CompletedAtUnixMs < since {
			continue
		}
		// Everybody level at the top won it, the same rule tournamentChampions
		// uses: a lifetime marker should not turn on who registered first.
		for playerID := range tournamentChampions(event) {
			wins[playerID]++
		}
	}
	return wins, nil
}

/* ----------------------------------------------------- when we can meet -- */

// SetWeekendAvailability replaces one account's whole set of workable slots.
//
// The whole set rather than one slot at a time: the question is "when can you
// make it", and the answer is a shape somebody drags out in one go. Sending it
// whole also means an unchecked slot is expressed by its absence, so there is
// no delete endpoint and no way for the two halves to disagree.
//
// An empty set is legal and means "no longer answering", which is different
// from never having answered only in that it costs a row to say. Both read the
// same to the tally, which is the honest reading.
func (store *Store) SetWeekendAvailability(
	ctx context.Context,
	userID string,
	slots []int,
) error {
	userID = strings.TrimSpace(userID)
	if userID == "" {
		return fmt.Errorf("%w: availability needs a voter", ErrInvalidTournament)
	}
	wanted := make(map[int]bool, len(slots))
	for _, slot := range slots {
		if slot < 0 || slot >= WeekendSlots {
			return fmt.Errorf("%w: %d is not a slot in the window", ErrWeekendVoteInvalid, slot)
		}
		wanted[slot] = true
	}

	transaction, err := store.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("set weekend availability: begin transaction: %w", err)
	}
	defer func() { _ = transaction.Rollback() }()

	if _, err := transaction.ExecContext(ctx,
		`DELETE FROM nightly_availability WHERE user_id = ?`, userID,
	); err != nil {
		return fmt.Errorf("set weekend availability: clear: %w", err)
	}
	now := time.Now().UnixMilli()
	for slot := range wanted {
		if _, err := transaction.ExecContext(ctx, `
INSERT INTO nightly_availability (user_id, slot, updated_at_unix_ms) VALUES (?, ?, ?)
`, userID, slot, now); err != nil {
			return fmt.Errorf("set weekend availability: insert: %w", err)
		}
	}
	if err := transaction.Commit(); err != nil {
		return fmt.Errorf("set weekend availability: commit: %w", err)
	}
	return nil
}

// WeekendAvailability is how many people can make each slot, this account's own
// answer, and how many people have answered at all.
//
// The counts are indexed by slot, so a caller never has to reconcile a sparse
// list against the grid it is drawing.
func (store *Store) WeekendAvailability(
	ctx context.Context,
	userID string,
) (counts [WeekendSlots]int, mine [WeekendSlots]bool, people int, err error) {
	rows, queryErr := store.db.QueryContext(ctx, `
SELECT slot, COUNT(*) FROM nightly_availability GROUP BY slot
`)
	if queryErr != nil {
		return counts, mine, 0, fmt.Errorf("read weekend availability: %w", queryErr)
	}
	defer rows.Close()
	for rows.Next() {
		var slot, count int
		if scanErr := rows.Scan(&slot, &count); scanErr != nil {
			return counts, mine, 0, fmt.Errorf("read weekend availability: %w", scanErr)
		}
		if slot >= 0 && slot < WeekendSlots {
			counts[slot] = count
		}
	}
	if rowsErr := rows.Err(); rowsErr != nil {
		return counts, mine, 0, fmt.Errorf("read weekend availability: %w", rowsErr)
	}
	// Closed before the reads below: one connection, and an open cursor holds
	// it. See the note on readTournamentMatches.
	if closeErr := rows.Close(); closeErr != nil {
		return counts, mine, 0, fmt.Errorf("read weekend availability: %w", closeErr)
	}

	if scanErr := store.db.QueryRowContext(ctx,
		`SELECT COUNT(DISTINCT user_id) FROM nightly_availability`,
	).Scan(&people); scanErr != nil {
		return counts, mine, 0, fmt.Errorf("count weekend availability: %w", scanErr)
	}

	userID = strings.TrimSpace(userID)
	if userID == "" {
		return counts, mine, people, nil
	}
	own, queryErr := store.db.QueryContext(ctx,
		`SELECT slot FROM nightly_availability WHERE user_id = ?`, userID)
	if queryErr != nil {
		return counts, mine, people, fmt.Errorf("read own availability: %w", queryErr)
	}
	defer own.Close()
	for own.Next() {
		var slot int
		if scanErr := own.Scan(&slot); scanErr != nil {
			return counts, mine, people, fmt.Errorf("read own availability: %w", scanErr)
		}
		if slot >= 0 && slot < WeekendSlots {
			mine[slot] = true
		}
	}
	if rowsErr := own.Err(); rowsErr != nil {
		return counts, mine, people, fmt.Errorf("read own availability: %w", rowsErr)
	}
	return counts, mine, people, nil
}

// WeekendAvailabilityWinner is the slot the most people can make.
//
// Ties and thin turnouts both keep the slot we already meet at, and for the
// same reason the clock ballot falls back: neither is the field asking for a
// change, and an event that moves on one vote is one nobody can plan around.
// `current` is the configured slot, and is returned unchanged in both cases.
func WeekendAvailabilityWinner(
	counts [WeekendSlots]int,
	people int,
	minimum int,
	current int,
) int {
	if people < minimum {
		return current
	}
	best, bestSlot, tied := 0, current, false
	for slot, count := range counts {
		switch {
		case count > best:
			best, bestSlot, tied = count, slot, false
		case count == best && count > 0 && slot != bestSlot:
			tied = true
		}
	}
	if best == 0 || tied {
		return current
	}
	return bestSlot
}

/* -------------------------------------------------------- the window -- */

// HourOf is the hour component of the configured start, and MinuteOf its
// minutes.
//
// Split because the availability grid decides a weekday and an hour and nothing
// else: a host who scheduled 20:30 and whose field votes for Sunday 21:00 gets
// Sunday 21:30, because the half past was their decision and the grid was never
// asked about it.
func (config WeekendConfig) HourOf() int {
	hour, _, err := parseLocalClock(config.StartLocal)
	if err != nil {
		return 20
	}
	return hour
}

func (config WeekendConfig) MinuteOf() int {
	_, minute, err := parseLocalClock(config.StartLocal)
	if err != nil {
		return 0
	}
	return minute
}

// slotOffset is how many hours after the window opens a weekday-and-hour falls,
// measured the long way round the week rather than allowed to go negative.
func (config WeekendConfig) slotOffset(day, hour int) int {
	offset := (day*24 + hour) - (config.WindowOpensDay*24 + config.WindowOpensHour)
	return ((offset % hoursInWeek) + hoursInWeek) % hoursInWeek
}

// SlotOf is which slot of the window the configured start sits in, or -1 when
// it sits outside the window entirely.
//
// Outside is a real answer rather than an impossible one: the window is a
// setting, and a host can move it off the hour they meet at. Everything that
// reads this either heals the config first — see clampStartIntoWindow, which
// both the read and the save run — or leaves the schedule alone.
func (config WeekendConfig) SlotOf() int {
	offset := config.slotOffset(config.StartDay, config.HourOf())
	if offset >= WeekendSlots {
		return -1
	}
	return offset
}

// WithSlot is this configuration moved to a slot of the window, minutes kept.
func (config WeekendConfig) WithSlot(slot int) WeekendConfig {
	if slot < 0 || slot >= WeekendSlots {
		return config
	}
	total := config.WindowOpensDay*24 + config.WindowOpensHour + slot
	config.StartDay = (total / 24) % 7
	config.StartLocal = fmt.Sprintf("%02d:%02d", total%24, config.MinuteOf())
	return config
}

// clampStartIntoWindow drags a start that no slot can name to the nearer end of
// the window.
//
// A start outside the window is not wrong so much as unreachable: the grid is
// the only thing that can move the schedule, so an hour it cannot express is an
// hour nobody can vote away from. Both the read and the save run this, so a row
// written by the nightly build — which had a start hour and no weekend at all —
// comes back on the grid rather than stranded beside it.
func clampStartIntoWindow(config WeekendConfig) WeekendConfig {
	offset := config.slotOffset(config.StartDay, config.HourOf())
	if offset < WeekendSlots {
		return config
	}
	// Past the last slot by `offset - (WeekendSlots-1)` hours, or short of the
	// first by `hoursInWeek - offset`. Whichever is the shorter walk wins.
	if hoursInWeek-offset <= offset-(WeekendSlots-1) {
		return config.WithSlot(0)
	}
	return config.WithSlot(WeekendSlots - 1)
}

// windowOpensOn is the midnight the next voting window's opening day starts at.
//
// "Next" meaning the window whose first slot is still ahead of us. During the
// weekend itself that is the following week's, which is the honest one to show:
// the grid is a standing preference for an event that has not happened yet, and
// half a grid in the past is not something anybody can answer.
func (config WeekendConfig) windowOpensOn(now time.Time) (time.Time, error) {
	location, err := time.LoadLocation(strings.TrimSpace(config.Zone))
	if err != nil {
		return time.Time{}, fmt.Errorf("weekend zone: %w", err)
	}
	local := now.In(location)
	back := (int(local.Weekday()) - config.WindowOpensDay + 7) % 7
	day := local.AddDate(0, 0, -back)
	midnight := time.Date(day.Year(), day.Month(), day.Day(), 0, 0, 0, 0, location)
	if !config.slotFrom(midnight, 0).After(local) {
		midnight = midnight.AddDate(0, 0, 7)
	}
	return midnight, nil
}

// slotFrom is one slot of the window that opens on the given midnight.
//
// Built as a wall clock on the right day rather than by adding hours to the
// window's start, so a clock change inside the window moves the instant and
// leaves the label alone — which is the way round that matters, since the label
// is the promise.
func (config WeekendConfig) slotFrom(midnight time.Time, slot int) time.Time {
	total := config.WindowOpensHour + slot
	day := midnight.AddDate(0, 0, total/24)
	return time.Date(
		day.Year(), day.Month(), day.Day(),
		total%24, config.MinuteOf(), 0, 0, midnight.Location(),
	)
}

// SlotAt is when a slot of the window next comes round.
//
// Handed to clients so a page can print every option in its reader's own time —
// weekday and all — without doing zone arithmetic, and without getting it wrong
// twice a year. The field is worldwide; "Saturday 20:00" on its own is only
// useful to the host, and is actively misleading to anybody far enough east
// that it lands on their Sunday.
func (config WeekendConfig) SlotAt(slot int, now time.Time) (time.Time, error) {
	midnight, err := config.windowOpensOn(now)
	if err != nil {
		return time.Time{}, err
	}
	return config.slotFrom(midnight, slot), nil
}
