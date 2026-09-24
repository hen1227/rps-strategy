package persistence

import (
	"testing"
	"time"
)

// The series' history is ordered down to the last tie.
//
// Two events settled in the same millisecond -- what a sweep clearing a backlog
// produces -- would otherwise come back in whichever order the database chose,
// and that order is both what the weekend page lists and, at the hundredth
// event, which one the limit drops. The arena helpers this borrows live in
// bot_titles_test.go, the other reader of this history.
func TestTheWeekendHistoryOrdersEventsSettledTogether(t *testing.T) {
	store := authTestStore(t)
	alpha, beta := twoEngines(t, store)

	arena(t, store, "arena-1", alpha.UserID, beta.UserID)
	arena(t, store, "arena-2", beta.UserID, alpha.UserID)
	together := time.Now().UnixMilli()
	settledAt(t, store, "arena-1", together)
	settledAt(t, store, "arena-2", together)

	events, err := store.RecentWeekends(t.Context(), 10)
	if err != nil {
		t.Fatalf("read the history: %v", err)
	}
	if len(events) != 2 {
		t.Fatalf("expected both arenas in the history, got %d", len(events))
	}
	if events[0].TournamentID != "arena-2" {
		t.Errorf(
			"the later of two arenas settled together should head the history, got %q",
			events[0].TournamentID,
		)
	}
}

// The same order asked about a pair, which is the half of it that does not
// depend on a query plan: the crown sweep re-derives the last weekend from rows
// it already has, skipping the unfinished ones the history sorts in among them.
// One answer, whichever way round the two arrive.
func TestWeekendSettledLaterBreaksEveryTie(t *testing.T) {
	settled := func(id string, created, completed int64) Tournament {
		return Tournament{
			TournamentID:      id,
			CreatedAtUnixMs:   created,
			CompletedAtUnixMs: &completed,
		}
	}
	unfinished := func(id string, created int64) Tournament {
		return Tournament{TournamentID: id, CreatedAtUnixMs: created}
	}
	for _, testCase := range []struct {
		name    string
		later   Tournament
		earlier Tournament
	}{
		{"finished later", settled("a", 1, 200), settled("b", 1, 100)},
		{"finished together, opened later", settled("a", 2, 100), settled("b", 1, 100)},
		{"opened together too, so the id decides", settled("b", 1, 100), settled("a", 1, 100)},
		{"finished at all", settled("a", 1, 100), unfinished("b", 500)},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			if !weekendSettledLater(testCase.later, testCase.earlier) {
				t.Errorf(
					"%s should be the later of the two",
					testCase.later.TournamentID,
				)
			}
			if weekendSettledLater(testCase.earlier, testCase.later) {
				t.Errorf(
					"%s and %s are each the later of the two, so the answer depends on the asking",
					testCase.later.TournamentID, testCase.earlier.TournamentID,
				)
			}
		})
	}
}
