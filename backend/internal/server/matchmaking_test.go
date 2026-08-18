package server

import (
	"testing"
	"time"

	"rps-strategy/backend/internal/game"
	"rps-strategy/backend/internal/persistence"
)

func TestMatchmakingPairsPlayersInSameMode(t *testing.T) {
	baseTime := time.Date(2026, time.August, 17, 12, 0, 0, 0, time.UTC)
	first := &Client{profile: game.PlayerProfile{UserID: "first"}}
	second := &Client{profile: game.PlayerProfile{UserID: "second"}}
	matchCount := 0
	queue := NewMatchmakingQueue(func(QueueEntry, QueueEntry) { matchCount++ })
	queue.now = func() time.Time { return baseTime }
	queue.Add(first, game.ModeAnnihilation)
	queue.Add(second, game.ModeAnnihilation)

	queue.match()
	if matchCount != 1 {
		t.Fatalf("expected one match, got %d", matchCount)
	}
}

func TestMatchmakingNeverPairsDifferentModes(t *testing.T) {
	baseTime := time.Date(2026, time.August, 17, 12, 0, 0, 0, time.UTC)
	first := &Client{profile: game.PlayerProfile{UserID: "first"}}
	second := &Client{profile: game.PlayerProfile{UserID: "second"}}
	matchCount := 0
	queue := NewMatchmakingQueue(func(QueueEntry, QueueEntry) { matchCount++ })
	queue.now = func() time.Time { return baseTime }
	queue.Add(first, game.ModeAnnihilation)
	queue.Add(second, game.ModeID("different-mode"))

	queue.match()
	if matchCount != 0 {
		t.Fatal("players searching for different opaque mode IDs must never match")
	}
}

func TestMatchmakingNeverPairsDifferentTimeControls(t *testing.T) {
	first := &Client{profile: game.PlayerProfile{UserID: "first"}}
	second := &Client{profile: game.PlayerProfile{UserID: "second"}}
	matchCount := 0
	queue := NewMatchmakingQueue(func(QueueEntry, QueueEntry) { matchCount++ })
	queue.AddWithTimeControl(
		first,
		game.ModeAnnihilation,
		game.TimeControl{InitialTimeMs: 60_000, IncrementMs: 1_000},
	)
	queue.AddWithTimeControl(
		second,
		game.ModeAnnihilation,
		game.TimeControl{InitialTimeMs: 60_000, IncrementMs: 2_000},
	)

	queue.match()
	if matchCount != 0 {
		t.Fatal("players requesting different time controls must never match")
	}
}

func TestMatchmakingPairsIdenticalCustomTimeControls(t *testing.T) {
	first := &Client{profile: game.PlayerProfile{UserID: "first"}}
	second := &Client{profile: game.PlayerProfile{UserID: "second"}}
	control := game.TimeControl{InitialTimeMs: 60_000, IncrementMs: 1_000}
	var matched [2]QueueEntry
	queue := NewMatchmakingQueue(func(first, second QueueEntry) {
		matched = [2]QueueEntry{first, second}
	})
	queue.AddWithTimeControl(first, game.ModeAnnihilation, control)
	queue.AddWithTimeControl(second, game.ModeAnnihilation, control)

	queue.match()
	if matched[0].Client == nil || matched[1].Client == nil {
		t.Fatal("expected players with the same custom control to match")
	}
	if matched[0].TimeControl != control || matched[1].TimeControl != control {
		t.Fatalf("expected matched control %#v, got %#v", control, matched)
	}
}

func TestMatchmakingDoesNotPairTwoConnectionsForSameAccount(t *testing.T) {
	first := &Client{profile: game.PlayerProfile{UserID: "shared-account"}}
	second := &Client{profile: game.PlayerProfile{UserID: "shared-account"}}
	matchCount := 0
	queue := NewMatchmakingQueue(func(QueueEntry, QueueEntry) { matchCount++ })
	queue.Add(first, game.ModeAnnihilation)
	queue.Add(second, game.ModeAnnihilation)

	queue.match()
	if matchCount != 0 {
		t.Fatal("two browser connections for one account must not play each other")
	}
}

func TestMatchmakingAddUsesDefaultTimeControl(t *testing.T) {
	queue := NewMatchmakingQueue(func(QueueEntry, QueueEntry) {})
	entry := queue.Add(&Client{}, game.ModeAnnihilation)
	if entry.TimeControl != game.DefaultTimeControl() {
		t.Fatalf("expected default time control, got %#v", entry.TimeControl)
	}
}

func TestMatchmakingPlayerCountsAreGroupedByMode(t *testing.T) {
	queue := NewMatchmakingQueue(func(QueueEntry, QueueEntry) {})
	queue.Add(&Client{}, game.ModeAnnihilation)
	queue.Add(&Client{}, game.ModeAnnihilation)
	queue.Add(&Client{}, game.ModeInfiltration)

	counts := queue.PlayerCountsByMode()
	if counts[game.ModeAnnihilation] != 2 || counts[game.ModeInfiltration] != 1 {
		t.Fatalf("unexpected queued player counts: %#v", counts)
	}
	if counts[game.ModeTotalWar] != 0 {
		t.Fatalf("expected no queued Total War players, got %d", counts[game.ModeTotalWar])
	}
}

func TestSearchRangeWidensUntilItIsFullyOpen(t *testing.T) {
	joinedAt := time.Date(2026, time.August, 17, 12, 0, 0, 0, time.UTC)
	entry := QueueEntry{JoinedAt: joinedAt}
	if got := entry.SearchRange(joinedAt); got != matchmakingInitialEloRange {
		t.Fatalf("expected initial range %d, got %d", matchmakingInitialEloRange, got)
	}
	midpoint := joinedAt.Add(matchmakingFullyOpenAfter / 2)
	if got := entry.SearchRange(midpoint); got != 2575 {
		t.Fatalf("expected quadratic midpoint range 2575, got %d", got)
	}
	fullyOpen := joinedAt.Add(matchmakingFullyOpenAfter)
	if got := entry.SearchRange(fullyOpen); got != matchmakingMaximumEloRange ||
		!entry.searchIsFullyOpen(fullyOpen) {
		t.Fatalf("expected a fully open search, got range=%d", got)
	}
}

func TestMatchmakingWaitsBeforePairingDistantRatings(t *testing.T) {
	baseTime := time.Date(2026, time.August, 17, 12, 0, 0, 0, time.UTC)
	first := ratedClient("first", 1200)
	second := ratedClient("second", 1800)
	matchCount := 0
	queue := NewMatchmakingQueue(func(QueueEntry, QueueEntry) { matchCount++ })
	queue.now = func() time.Time { return baseTime }
	queue.Add(first, game.ModeAnnihilation)
	queue.Add(second, game.ModeAnnihilation)

	queue.match()
	if matchCount != 0 {
		t.Fatal("distant ratings must not match inside the initial search range")
	}
	queue.now = func() time.Time { return baseTime.Add(matchmakingFullyOpenAfter / 2) }
	queue.match()
	if matchCount != 1 {
		t.Fatal("the widening range should eventually admit a distant opponent")
	}
}

func TestFullyOpenSearchIsNotConfinedByElo(t *testing.T) {
	baseTime := time.Date(2026, time.August, 17, 12, 0, 0, 0, time.UTC)
	first := ratedClient("first", 1200)
	second := ratedClient("second", 25000)
	matchCount := 0
	queue := NewMatchmakingQueue(func(QueueEntry, QueueEntry) { matchCount++ })
	queue.now = func() time.Time { return baseTime }
	queue.Add(first, game.ModeAnnihilation)
	queue.Add(second, game.ModeAnnihilation)
	queue.now = func() time.Time { return baseTime.Add(matchmakingFullyOpenAfter) }

	queue.match()
	if matchCount != 1 {
		t.Fatal("after two minutes, waiting time must take precedence over Elo")
	}
}

func TestMatchmakingChoosesClosestEligibleRating(t *testing.T) {
	baseTime := time.Date(2026, time.August, 17, 12, 0, 0, 0, time.UTC)
	first := ratedClient("first", 1200)
	farther := ratedClient("farther", 1280)
	closer := ratedClient("closer", 1210)
	var opponent *Client
	queue := NewMatchmakingQueue(func(first, second QueueEntry) { opponent = second.Client })
	joinTime := baseTime
	queue.now = func() time.Time {
		joinTime = joinTime.Add(time.Millisecond)
		return joinTime
	}
	queue.Add(first, game.ModeAnnihilation)
	queue.Add(farther, game.ModeAnnihilation)
	queue.Add(closer, game.ModeAnnihilation)
	queue.now = func() time.Time { return baseTime.Add(time.Second) }

	queue.match()
	if opponent != closer {
		t.Fatal("the oldest player should be paired with the closest eligible rating")
	}
}

func ratedClient(userID string, elo int) *Client {
	return &Client{
		profile: game.PlayerProfile{UserID: userID},
		account: persistence.Account{UserID: userID, Elo: elo},
	}
}
