package persistence

import (
	"database/sql"
	"path/filepath"
	"testing"
)

// A database compiled before pre-change games were counted has an
// opening_stats_meta with no `turned` column, and CREATE TABLE IF NOT EXISTS
// does nothing to a table that is already there. Its stored counts have to
// survive the column arriving and read as "nothing turned", which is the
// truthful account of a compile taken before anything was.
func TestOpeningStatsMigrationAddsTurnedToAnExistingDatabase(t *testing.T) {
	path := filepath.Join(t.TempDir(), "legacy.sqlite")
	database, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := database.Exec(`
CREATE TABLE opening_stats_meta (
    mode_id TEXT NOT NULL,
    cohort  TEXT NOT NULL,
    games   INTEGER NOT NULL,
    skipped INTEGER NOT NULL,
    plies   INTEGER NOT NULL,
    computed_at_unix_ms INTEGER NOT NULL,
    PRIMARY KEY (mode_id, cohort)
);
INSERT INTO opening_stats_meta (
    mode_id, cohort, games, skipped, plies, computed_at_unix_ms
) VALUES ('V3', 'human', 3, 40, 12, 1);
`); err != nil {
		t.Fatal(err)
	}
	if err := database.Close(); err != nil {
		t.Fatal(err)
	}

	store, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()

	stored, err := store.OpeningStatsAt(t.Context(), "V3", []string{OpeningSegmentHuman}, nil, 0)
	if err != nil {
		t.Fatal(err)
	}
	if stored.Games != 3 || stored.Skipped != 40 || stored.Turned != 0 {
		t.Fatalf(
			"the old compile read back as %d counted, %d skipped, %d turned",
			stored.Games, stored.Skipped, stored.Turned,
		)
	}

	// And a compile written afterwards carries the new count.
	if err := store.ReplaceOpeningStats(t.Context(), "V3", []OpeningStatsCohort{{
		Cohort:    OpeningSegmentHuman,
		Games:     43,
		Turned:    40,
		Lines:     map[string]*OpeningStatsLine{},
		Positions: map[string]*OpeningStatsPosition{},
	}}); err != nil {
		t.Fatal(err)
	}
	recompiled, err := store.OpeningStatsAt(t.Context(), "V3", []string{OpeningSegmentHuman}, nil, 0)
	if err != nil {
		t.Fatal(err)
	}
	if recompiled.Games != 43 || recompiled.Turned != 40 {
		t.Fatalf(
			"the new compile read back as %d counted, %d turned",
			recompiled.Games, recompiled.Turned,
		)
	}
}

// A database compiled before the compiler was versioned has to read as version
// zero rather than as the current one.
//
// This is what makes a deploy that changes the meaning of a position key
// recompile instead of leaving unreadable rows on the page. Getting it backwards
// -- defaulting an old row to today's version -- would produce a page that says
// no game has ever reached any position, which looks like an empty archive
// rather than like a compile that has not been run.
func TestOpeningStatsMigrationReadsAnUnversionedCompileAsOld(t *testing.T) {
	path := filepath.Join(t.TempDir(), "unversioned.sqlite")
	database, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := database.Exec(`
CREATE TABLE opening_stats_meta (
    mode_id TEXT NOT NULL,
    cohort  TEXT NOT NULL,
    games   INTEGER NOT NULL,
    skipped INTEGER NOT NULL,
    plies   INTEGER NOT NULL,
    computed_at_unix_ms INTEGER NOT NULL,
    turned  INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (mode_id, cohort)
);
INSERT INTO opening_stats_meta (
    mode_id, cohort, games, skipped, plies, computed_at_unix_ms
) VALUES ('V3', 'human', 3, 0, 12, 1);
`); err != nil {
		t.Fatal(err)
	}
	if err := database.Close(); err != nil {
		t.Fatal(err)
	}

	store, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()

	_, compiler, err := store.OpeningStatsCompiledAt(t.Context(), "V3")
	if err != nil {
		t.Fatal(err)
	}
	if compiler != 0 {
		t.Fatalf("an unversioned compile reads as version %d, want 0", compiler)
	}

	if err := store.ReplaceOpeningStats(t.Context(), "V3", []OpeningStatsCohort{{
		Cohort:    OpeningSegmentHuman,
		Games:     3,
		Lines:     map[string]*OpeningStatsLine{},
		Positions: map[string]*OpeningStatsPosition{},
	}}); err != nil {
		t.Fatal(err)
	}
	_, compiler, err = store.OpeningStatsCompiledAt(t.Context(), "V3")
	if err != nil {
		t.Fatal(err)
	}
	if compiler != OpeningStatsCompiler {
		t.Fatalf("a fresh compile stored version %d, want %d", compiler, OpeningStatsCompiler)
	}
}
