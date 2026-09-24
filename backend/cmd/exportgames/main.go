// Command exportgames writes finished games out of the archive as JSON Lines,
// in the shape they are published in.
//
// It is one half of the daily Hugging Face export that PRIVACY.md promises
// players. This half is stateless: it is handed a window and prints the games
// that finished inside it, with names and account ids already resolved to what
// the policy says may be published. The other half -- grouping into files,
// remembering what has already gone out, and uploading -- lives in
// tools/hf-export, because that is where the state and the network belong.
//
// It opens the database **read only**, and that is the whole reason it is a
// separate process rather than a goroutine in the server. persistence.Open sets
// SetMaxOpenConns(1) and runs migrations and a ladder refit on the way in, so
// going through the store would both write to the database and queue this scan
// ahead of live play. A second connection under WAL costs the running server
// nothing.
//
// Run it as the same user as the server, from a unit whose sandbox leaves the
// database's directory writable. A read-only connection to a WAL database has
// to attach the -shm shared memory index: while the server is up and holding
// that index the attach succeeds even on a read-only directory, but the moment
// the server exits cleanly -- which every deploy drain does -- the -shm is
// removed, and the next reader has to recreate it. On a read-only directory
// that fails with "attempt to write a readonly database", which is a confusing
// thing to read about a connection that opened read-only on purpose.
//
// mode=ro is still what guarantees this cannot write the archive; the writable
// directory is only what lets SQLite rebuild its index.
package main

import (
	"database/sql"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	_ "modernc.org/sqlite"
)

// keySecretVariable names the environment variable holding the secret the
// opaque player keys are derived from. It follows the RPS_ prefix every other
// setting on this server uses, and belongs in the same .env.
const keySecretVariable = "RPS_EXPORT_KEY_SECRET"

// excludeVariable names the environment variable holding the account ids that
// have asked to stay out, comma separated. PRIVACY.md offers that in as many
// words: "message me and I'll leave you out of future files."
const excludeVariable = "RPS_EXPORT_EXCLUDE"

func main() {
	if err := run(); err != nil {
		fmt.Fprintf(os.Stderr, "exportgames: %v\n", err)
		os.Exit(1)
	}
}

func run() error {
	databasePath := flag.String(
		"database",
		os.Getenv("RPS_DATABASE_PATH"),
		"path to the SQLite database (default $RPS_DATABASE_PATH)",
	)
	since := flag.Int64(
		"since", 0,
		"publish games that finished at or after this Unix millisecond timestamp",
	)
	until := flag.Int64(
		"until", 0,
		"publish games that finished before this Unix millisecond timestamp (default now)",
	)
	out := flag.String(
		"out", "",
		"write records here instead of stdout, so the timer needs no shell pipe",
	)
	flag.Parse()

	if strings.TrimSpace(*databasePath) == "" {
		return fmt.Errorf("no database: pass -database or set RPS_DATABASE_PATH")
	}
	// A missing secret is refused rather than defaulted. The alternative to a
	// secret is publishing raw account ids, and a run that quietly did that
	// could not be taken back -- so this is the half-configured case the rest
	// of this server also refuses loudly instead of limping on.
	secret := os.Getenv(keySecretVariable)
	if strings.TrimSpace(secret) == "" {
		return fmt.Errorf(
			"%s is not set: it is what makes the published player keys opaque, "+
				"and without it this would publish account ids",
			keySecretVariable,
		)
	}
	if *until == 0 {
		*until = time.Now().UnixMilli()
	}

	database, err := openReadOnly(*databasePath)
	if err != nil {
		return err
	}
	defer database.Close()

	// Written to a temporary file and renamed into place, so a run killed
	// halfway leaves the previous file rather than a truncated one the next
	// step would happily read as a complete day.
	destination := io.Writer(os.Stdout)
	var staged *os.File
	if *out != "" {
		staged, err = os.CreateTemp(filepath.Dir(*out), filepath.Base(*out)+".*")
		if err != nil {
			return fmt.Errorf("stage %s: %w", *out, err)
		}
		defer os.Remove(staged.Name())
		destination = staged
	}

	export := &exporter{
		secret:   []byte(secret),
		excluded: excludedFrom(os.Getenv(excludeVariable)),
	}
	written, skipped, err := writeGames(destination, database, export, *since, *until)
	if err != nil {
		return err
	}
	if staged != nil {
		if err := staged.Close(); err != nil {
			return fmt.Errorf("stage %s: %w", *out, err)
		}
		if err := os.Rename(staged.Name(), *out); err != nil {
			return fmt.Errorf("write %s: %w", *out, err)
		}
	}
	// Counts on stderr so stdout stays a clean stream of records, and so a
	// skip is visible rather than silently shrinking the day's file.
	fmt.Fprintf(os.Stderr, "exportgames: wrote %d game(s)", written)
	if skipped > 0 {
		fmt.Fprintf(os.Stderr, ", skipped %d", skipped)
	}
	fmt.Fprintln(os.Stderr)
	return nil
}

// openReadOnly opens the database in a mode that cannot write to it.
//
// mode=ro is doing real work here, not decoration: it is what stops this
// command running a migration against a live production database if it is ever
// pointed at one by a build that expects a newer schema.
func openReadOnly(path string) (*sql.DB, error) {
	database, err := sql.Open("sqlite", "file:"+path+"?mode=ro")
	if err != nil {
		return nil, fmt.Errorf("open %s read only: %w", path, err)
	}
	if err := database.Ping(); err != nil {
		database.Close()
		return nil, fmt.Errorf("open %s read only: %w", path, err)
	}
	return database, nil
}

// excludedFrom reads the opt-out list. Blank entries are dropped so a trailing
// comma cannot turn into an account id that matches every seat with no id.
func excludedFrom(list string) map[string]bool {
	excluded := map[string]bool{}
	for _, id := range strings.Split(list, ",") {
		if trimmed := strings.TrimSpace(id); trimmed != "" {
			excluded[trimmed] = true
		}
	}
	return excluded
}

// exportQuery orders by (finished_at_unix_ms, game_id), which is exactly
// game_pgn_finished_idx, so the window is an index seek rather than a scan over
// every stored PGN. The same ordering makes the output stable: two runs over
// the same window emit the same records in the same order.
//
// `outcome <> 'unfinished'` is the policy, not an optimisation. PRIVACY.md says
// *finished* games are published, and ArchiveLiveGames stores the games a
// shutdown interrupted with that outcome -- results nobody earned, on boards
// that were still being played. A row archived unfinished stays unfinished,
// because ArchiveGame inserts ON CONFLICT DO NOTHING and never revisits it, so
// leaving them out here leaves them out for good rather than for now.
//
// recorded_at_unix_ms is not selected. It is when this server happened to write
// the row, which is a fact about deploys and drains rather than about the game.
const exportQuery = `
SELECT game_id, mode_id, mode_name,
       red_player_id, red_username, blue_player_id, blue_username,
       winner_color, outcome, end_reason, ranked, tournament_id,
       ply_count, initial_time_ms, increment_ms,
       started_at_unix_ms, finished_at_unix_ms, pgn
FROM game_pgn
WHERE finished_at_unix_ms >= ? AND finished_at_unix_ms < ?
  AND outcome <> 'unfinished'
ORDER BY finished_at_unix_ms ASC, game_id ASC
`

// writeGames streams the window to out, one JSON object per line.
//
// Streamed rather than collected because the caller is a pipe: the backfill
// asks for the whole archive at once, and there is no reason to hold thirty
// megabytes of PGN in memory to write it out again.
func writeGames(
	out io.Writer,
	database *sql.DB,
	export *exporter,
	since int64,
	until int64,
) (int, int, error) {
	rows, err := database.Query(exportQuery, since, until)
	if err != nil {
		return 0, 0, fmt.Errorf("read archive: %w", err)
	}
	defer rows.Close()

	encoder := json.NewEncoder(out)
	written, skipped := 0, 0
	for rows.Next() {
		var row archivedRow
		if err := rows.Scan(
			&row.GameID, &row.ModeID, &row.ModeName,
			&row.RedPlayerID, &row.RedUsername, &row.BluePlayerID, &row.BlueUsername,
			&row.WinnerColor, &row.Outcome, &row.EndReason, &row.Ranked, &row.TournamentID,
			&row.PlyCount, &row.InitialTimeMs, &row.IncrementMs,
			&row.StartedAtUnixMs, &row.FinishedAtUnixMs, &row.PGN,
		); err != nil {
			return written, skipped, fmt.Errorf("read archived game: %w", err)
		}
		record, err := export.record(row)
		if err != nil {
			// One unpublishable game does not stop the day. It is reported and
			// left out, because the alternative -- guessing at what it should
			// have said -- is the mistake this whole path exists to avoid.
			fmt.Fprintf(os.Stderr, "exportgames: skipping %s: %v\n", row.GameID, err)
			skipped++
			continue
		}
		if err := encoder.Encode(record); err != nil {
			return written, skipped, fmt.Errorf("write record: %w", err)
		}
		written++
	}
	if err := rows.Err(); err != nil {
		return written, skipped, fmt.Errorf("read archive: %w", err)
	}
	if written == 0 && skipped == 0 && errors.Is(rows.Err(), sql.ErrNoRows) {
		return 0, 0, nil
	}
	return written, skipped, nil
}
