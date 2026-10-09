package notation

import (
	"fmt"
	"strconv"
	"strings"
)

// Ratings is what a record says about the two seats' ratings: each one before
// the game and after it, on the scale RatingSystem names.
type Ratings struct {
	RedBefore  int
	RedAfter   int
	BlueBefore int
	BlueAfter  int
}

// ratingTagNames is every tag ratingTags can write, which is what SetRatings
// clears before writing them again.
var ratingTagNames = []string{
	"RedElo", "BlueElo",
	"RedEloAfter", "RedRatingDiff",
	"BlueEloAfter", "BlueRatingDiff",
	"RatingSystem",
}

// ratingTags is the rating half of a record's tag block, in the order Encode
// writes it. A rating of zero is left out rather than written, which is how a
// record says it has no number for a seat.
//
// The scale travels with the numbers because the tag names are standard PGN
// and the numbers under them are not comparable across a change of scale. The
// archive is published and the scales overlap, so nothing in a file would look
// wrong to a reader that mixed them. It is its own tag rather than part of
// Generator, which is about how the moves are numbered: a rating change must
// not claim the moves moved too.
func ratingTags(ratings Ratings) []Tag {
	tags := make([]Tag, 0, len(ratingTagNames))
	if ratings.RedBefore > 0 {
		tags = append(tags, Tag{"RedElo", strconv.Itoa(ratings.RedBefore)})
	}
	if ratings.BlueBefore > 0 {
		tags = append(tags, Tag{"BlueElo", strconv.Itoa(ratings.BlueBefore)})
	}
	if ratings.RedAfter > 0 {
		tags = append(tags, Tag{"RedEloAfter", strconv.Itoa(ratings.RedAfter)})
		tags = append(tags, Tag{"RedRatingDiff", signed(ratings.RedAfter - ratings.RedBefore)})
	}
	if ratings.BlueAfter > 0 {
		tags = append(tags, Tag{"BlueEloAfter", strconv.Itoa(ratings.BlueAfter)})
		tags = append(tags, Tag{"BlueRatingDiff", signed(ratings.BlueAfter - ratings.BlueBefore)})
	}
	if ratings.RedBefore > 0 || ratings.BlueBefore > 0 {
		tags = append(tags, Tag{"RatingSystem", RatingSystem})
	}
	return tags
}

// SetRatings restates the ratings a stored record carries, for a rebuild that
// has worked out new ones for a game already in the archive.
//
// Every rating tag is removed and the current set written where the first of
// them stood, or just before [Ranked] in a record that had none, which is
// where Encode puts them. A record restated this way is byte for byte the one
// Encode would write today with the same numbers.
//
// Tag block only. The movetext is returned byte-identical, the promise SetSeat
// and SetRanked make, and the property that keeps a rewritten record
// replayable.
func SetRatings(pgn string, ratings Ratings) string {
	lines := strings.Split(pgn, "\n")
	end := len(lines)
	for index, line := range lines {
		// The tag block ends at the first blank line; everything after it is
		// movetext and must not be touched.
		if strings.TrimSpace(line) == "" {
			end = index
			break
		}
	}

	kept := make([]string, 0, end)
	insertAt, ranked := -1, -1
	for _, line := range lines[:end] {
		if isRatingTag(line) {
			if insertAt < 0 {
				insertAt = len(kept)
			}
			continue
		}
		if ranked < 0 && strings.HasPrefix(line, `[Ranked "`) {
			ranked = len(kept)
		}
		kept = append(kept, line)
	}
	switch {
	case insertAt >= 0:
	case ranked >= 0:
		insertAt = ranked
	default:
		insertAt = len(kept)
	}

	written := make([]string, 0, len(ratingTagNames))
	for _, tag := range ratingTags(ratings) {
		written = append(written, fmt.Sprintf("[%s %q]", tag.Name, tag.Value))
	}
	block := make([]string, 0, len(kept)+len(written))
	block = append(block, kept[:insertAt]...)
	block = append(block, written...)
	block = append(block, kept[insertAt:]...)
	return strings.Join(append(block, lines[end:]...), "\n")
}

// isRatingTag reports whether a tag-block line is one ratingTags writes.
func isRatingTag(line string) bool {
	for _, name := range ratingTagNames {
		if strings.HasPrefix(line, "["+name+` "`) {
			return true
		}
	}
	return false
}
