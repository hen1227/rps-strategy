package persistence

import (
	"database/sql"
	"path/filepath"
	"testing"
	"time"
)

// Opening a database the nightly build wrote.
//
// The schedule columns and the slot grid are both migrations that have to run
// against a real old file rather than a fresh one, and the availability grid is
// the one that can lose something: its column changed meaning, and a careless
// rebuild throws away every standing answer the field had given.

// legacyNightlyDatabase writes a database in the shape the nightly build left
// behind: an hour-of-day availability grid, a set of weekdays, and no window.
func legacyNightlyDatabase(t *testing.T, availability map[string][]int) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "legacy.sqlite")
	database, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()

	if _, err := database.Exec(`
CREATE TABLE nightly_config (
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
CREATE TABLE nightly_availability (
    user_id TEXT NOT NULL,
    hour INTEGER NOT NULL CHECK (hour BETWEEN 0 AND 23),
    updated_at_unix_ms INTEGER NOT NULL,
    PRIMARY KEY (user_id, hour)
);
INSERT INTO nightly_config VALUES (
    1, 1, 'America/New_York', '20:00', '0,1,2,3,4,5,6', 'V6', 6, 30, 60, 2, 10, 1,
    '3+1', 3, 90, '', '2026-09-06', 0
);
`); err != nil {
		t.Fatal(err)
	}
	for user, hours := range availability {
		for _, hour := range hours {
			if _, err := database.Exec(
				`INSERT INTO nightly_availability VALUES (?, ?, ?)`,
				user, hour, time.Now().UnixMilli(),
			); err != nil {
				t.Fatal(err)
			}
		}
	}
	return path
}

// The hours the field had already answered are carried onto the window rather
// than thrown away.
//
// An hour is an answer about every day at once, because the nightly grid had no
// day in it to name. So it lands on whichever days of the window it falls on —
// twice for an hour the window covers on both, once for an hour it only reaches
// on one. Dropping them would reset the turnout to nothing and stop the grid
// carrying at all until everybody answered again.
func TestOpeningANightlyDatabaseCarriesItsAvailability(t *testing.T) {
	path := legacyNightlyDatabase(t, map[string][]int{
		// 20:00 is inside the window on both days; 03:00 only on the Sunday;
		// 06:00 is before the window opens on the Saturday and so also lands
		// once, on the Sunday.
		"east": {20, 3},
		"west": {20, 6},
	})
	store, err := Open(path)
	if err != nil {
		t.Fatalf("a nightly database should still open: %v", err)
	}
	defer store.Close()
	ctx := t.Context()

	config, err := store.WeekendConfiguration(ctx)
	if err != nil {
		t.Fatal(err)
	}
	// The default window: Saturday 09:00 for thirty-six hours.
	if config.WindowOpensDay != int(time.Saturday) || config.WindowOpensHour != 9 {
		t.Fatalf("expected the default window, got day %d at %02d:00",
			config.WindowOpensDay, config.WindowOpensHour)
	}
	// A row that ran every night now runs on one, and its hour still sits on the
	// grid: Saturday 20:00 is slot 11.
	if config.StartDay != int(time.Saturday) || config.SlotOf() != 11 {
		t.Fatalf("expected Saturday at slot 11, got %s at %d",
			time.Weekday(config.StartDay), config.SlotOf())
	}

	counts, mine, people, err := store.WeekendAvailability(ctx, "east")
	if err != nil {
		t.Fatal(err)
	}
	if people != 2 {
		t.Fatalf("both answers should have survived, got %d people", people)
	}
	// 20:00 on the Saturday (slot 11) and on the Sunday (slot 35): both readers
	// said that hour works, and neither was ever asked which day.
	if counts[11] != 2 || counts[35] != 2 {
		t.Fatalf("expected 20:00 carried onto both days, got %d and %d",
			counts[11], counts[35])
	}
	// 03:00 is Sunday only — the window opens at 09:00 on the Saturday.
	if counts[18] != 1 {
		t.Fatalf("expected 03:00 on the Sunday, got %d", counts[18])
	}
	// And 06:00 likewise, at slot 21.
	if counts[21] != 1 {
		t.Fatalf("expected 06:00 on the Sunday, got %d", counts[21])
	}
	if !mine[11] || !mine[35] || !mine[18] || mine[21] {
		t.Fatalf("the reader's own marks did not follow the projection: %#v", mine[:])
	}

	// And the grid is writable at the new range, which the old CHECK forbade.
	if err := store.SetWeekendAvailability(ctx, "east", []int{35}); err != nil {
		t.Fatalf("slot 35 should be storable now: %v", err)
	}
}

// Opening it twice is not a second migration.
func TestOpeningANightlyDatabaseTwiceIsIdempotent(t *testing.T) {
	path := legacyNightlyDatabase(t, map[string][]int{"east": {20}})
	first, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := first.Close(); err != nil {
		t.Fatal(err)
	}

	second, err := Open(path)
	if err != nil {
		t.Fatalf("reopening should re-run the migrations cleanly: %v", err)
	}
	defer second.Close()
	counts, _, people, err := second.WeekendAvailability(t.Context(), "")
	if err != nil {
		t.Fatal(err)
	}
	if people != 1 || counts[11] != 1 || counts[35] != 1 {
		t.Fatalf("a second open changed the grid: %d people, %d and %d",
			people, counts[11], counts[35])
	}
}
