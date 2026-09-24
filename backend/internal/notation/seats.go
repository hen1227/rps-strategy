package notation

import (
	"fmt"
	"strings"

	"rps-strategy/backend/internal/game"
)

// ParseTags reads a record's tag block without replaying its moves.
//
// Parse is the right call when the caller wants the game. This is for callers
// that only want what the record says about itself -- who played, what it was
// for, the ratings -- and should not fail because a movetext written under an
// older rule set no longer replays. The archive is kept precisely so old games
// survive rule changes, so reading their headers must not depend on the rules
// still accepting their moves.
func ParseTags(text string) ([]Tag, error) {
	tags, _, err := splitSections(text)
	if err != nil {
		return nil, err
	}
	return tags, nil
}

// TagValue reads one tag out of a parsed block, or "" when it is absent.
func TagValue(tags []Tag, name string) string {
	for _, tag := range tags {
		if tag.Name == name {
			return tag.Value
		}
	}
	return ""
}

// SetSeat rewrites one seat's name and id, addressed by colour rather than by
// the id already written in the record.
//
// ReseatParticipant answers a different question -- "which seat did this
// account hold, and rename it" -- and answers it by matching the id in the
// tag block. That is right for anonymizing and for merging, where the account
// is what is known. It is wrong for exporting, because a record's [RedId] tag
// and its red_player_id column can disagree: AnonymizeAccount rewrites the tag
// to "Deleted player" and leaves the column holding the real id, so every game
// a deleted account played is one ReseatParticipant would silently decline to
// touch. A publisher must never silently decline.
//
// The Id tag is inserted when the record has none, so the caller is guaranteed
// the seat ends up saying what it asked for rather than merely not
// contradicting it.
//
// Tag block only. The movetext is returned byte-identical -- the same promise
// ReseatParticipant makes, and the property that keeps a rewritten record
// replayable.
func SetSeat(pgn string, seat game.PlayerColor, name string, userID string) string {
	colour := string(seat)
	if colour != string(game.Red) && colour != string(game.Blue) {
		return pgn
	}
	lines := strings.Split(pgn, "\n")

	idTag := colour + "Id"
	wroteID := false
	end := len(lines)
	for index, line := range lines {
		// The tag block ends at the first blank line; everything after it is
		// movetext and must not be touched.
		if strings.TrimSpace(line) == "" {
			end = index
			break
		}
		switch {
		case strings.HasPrefix(line, "["+colour+" \""):
			lines[index] = fmt.Sprintf("[%s %q]", colour, name)
		case strings.HasPrefix(line, "["+idTag+" \""):
			lines[index] = fmt.Sprintf("[%s %q]", idTag, userID)
			wroteID = true
		}
	}
	if wroteID {
		return strings.Join(lines, "\n")
	}
	// No id tag to rewrite, so add one at the end of the block. Appending
	// rather than placing it beside the name keeps this a single insertion
	// with no assumption about the order buildTags happens to use.
	inserted := make([]string, 0, len(lines)+1)
	inserted = append(inserted, lines[:end]...)
	inserted = append(inserted, fmt.Sprintf("[%s %q]", idTag, userID))
	inserted = append(inserted, lines[end:]...)
	return strings.Join(inserted, "\n")
}
