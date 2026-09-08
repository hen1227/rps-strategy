package notation_test

// Throwaway audit: does the archive still parse and replay under current rules?
//
// Inert unless RPS_ARCHIVE_DIR names a directory of *.pgn files. Verify
// compares the replayed winner and endReason as well as the board, so a mode
// whose terminal conditions changed shows up here even when every move in the
// file is still legal.
//
//   RPS_ARCHIVE_DIR=/path/to/pgns go test ./internal/notation/ \
//     -run TestArchiveAudit -count=1 -v

import (
	"os"
	"path/filepath"
	"sort"
	"testing"

	"rps-strategy/backend/internal/game"
	"rps-strategy/backend/internal/notation"
)

func TestArchiveAudit(t *testing.T) {
	dir := os.Getenv("RPS_ARCHIVE_DIR")
	if dir == "" {
		t.Skip("set RPS_ARCHIVE_DIR to a directory of .pgn files")
	}
	type tally struct {
		files, parsed, verified int
		reasons, dialects       map[string]int
	}
	byMode := map[string]*tally{}
	get := func(mode string) *tally {
		if existing, ok := byMode[mode]; ok {
			return existing
		}
		created := &tally{reasons: map[string]int{}, dialects: map[string]int{}}
		byMode[mode] = created
		return created
	}

	paths, _ := filepath.Glob(filepath.Join(dir, "*.pgn"))
	for _, path := range paths {
		text, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		parsed, err := notation.Parse(string(text))
		if err != nil {
			counter := get("UNPARSEABLE")
			counter.files++
			counter.reasons[err.Error()]++
			continue
		}
		counter := get(parsed.Tag("ModeId"))
		counter.files++
		counter.parsed++
		generator := parsed.Tag("Generator")
		if generator == "" {
			generator = "(none)"
		}
		counter.dialects[generator]++
		if err := game.Verify(parsed.Record); err != nil {
			counter.reasons[err.Error()]++
			continue
		}
		counter.verified++
	}

	modes := make([]string, 0, len(byMode))
	for mode := range byMode {
		modes = append(modes, mode)
	}
	sort.Strings(modes)
	for _, mode := range modes {
		counter := byMode[mode]
		t.Logf("%s: %d files, %d parsed, %d replay under current rules",
			mode, counter.files, counter.parsed, counter.verified)
		for generator, count := range counter.dialects {
			t.Logf("    Generator %-22s %d", generator, count)
		}
		for reason, count := range counter.reasons {
			if len(reason) > 120 {
				reason = reason[:120] + "..."
			}
			t.Logf("    x%-4d %s", count, reason)
		}
	}
}
