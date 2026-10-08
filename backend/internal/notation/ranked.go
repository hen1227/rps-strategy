package notation

import (
	"fmt"
	"strconv"
	"strings"
)

// SetRanked rewrites whether a stored record says it was ranked.
//
// For an administrator moving a finished game between ranked and casual. The
// archive's `ranked` column is what selects games, but the record carries its
// own copy in the tag block, and the copy is the one that leaves the building:
// an export, a download and the review screen all read the file. A column that
// said casual over a file that said ranked would be two answers to one
// question, and the published one would be wrong.
//
// Two tags say it. `Ranked` always does, and is inserted when a record has none.
// `Event` does only when it is one of the two words sessionMetadata derives from
// the flag; a "Bot Match", a "Tournament" or an "Interrupted" game names what the
// game was *for*, which moving it between ranked and casual does not change.
//
// Tag block only. The movetext is returned byte-identical — the promise SetSeat
// makes, and the property that keeps a rewritten record replayable.
func SetRanked(pgn string, ranked bool) string {
	lines := strings.Split(pgn, "\n")
	flag := fmt.Sprintf("[Ranked %q]", strconv.FormatBool(ranked))
	event, stale := "Casual", "Ranked"
	if ranked {
		event, stale = "Ranked", "Casual"
	}

	wroteFlag := false
	end := len(lines)
	for index, line := range lines {
		// The tag block ends at the first blank line; everything after it is
		// movetext and must not be touched.
		if strings.TrimSpace(line) == "" {
			end = index
			break
		}
		switch {
		case strings.HasPrefix(line, `[Ranked "`):
			lines[index] = flag
			wroteFlag = true
		case strings.HasPrefix(line, `[Event "`) && tagValue(line) == stale:
			lines[index] = fmt.Sprintf("[Event %q]", event)
		}
	}
	if wroteFlag {
		return strings.Join(lines, "\n")
	}
	// Every record written since the tag existed carries it, so this is an old
	// file. Appended at the end of the block for the reason SetSeat gives.
	inserted := make([]string, 0, len(lines)+1)
	inserted = append(inserted, lines[:end]...)
	inserted = append(inserted, flag)
	inserted = append(inserted, lines[end:]...)
	return strings.Join(inserted, "\n")
}
