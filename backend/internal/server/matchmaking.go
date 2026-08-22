package server

import (
	"context"
	"sort"
	"sync"
	"time"

	"rps-strategy/backend/internal/game"
	"rps-strategy/backend/internal/persistence"
)

const (
	matchmakingTick            = 2 * time.Second
	matchmakingInitialEloRange = 100
	matchmakingMaximumEloRange = 10000
	matchmakingFullyOpenAfter  = 2 * time.Minute
)

type QueueEntry struct {
	Client      *Client
	ModeID      game.ModeID
	TimeControl game.TimeControl
	Elo         int
	JoinedAt    time.Time
}

func (entry QueueEntry) SearchRange(now time.Time) int {
	elapsed := now.Sub(entry.JoinedAt)
	if elapsed <= 0 {
		return matchmakingInitialEloRange
	}
	if elapsed >= matchmakingFullyOpenAfter {
		return matchmakingMaximumEloRange
	}

	// Expand slowly near the start, when a close opponent is most valuable,
	// then accelerate as waiting time becomes the more important signal.
	elapsedMilliseconds := elapsed.Milliseconds()
	fullSearchMilliseconds := matchmakingFullyOpenAfter.Milliseconds()
	additionalRange := int64(matchmakingMaximumEloRange-matchmakingInitialEloRange) *
		elapsedMilliseconds * elapsedMilliseconds /
		(fullSearchMilliseconds * fullSearchMilliseconds)
	return matchmakingInitialEloRange + int(additionalRange)
}

type MatchmakingQueue struct {
	mu      sync.Mutex
	entries map[*Client]QueueEntry
	onMatch func(QueueEntry, QueueEntry)
	now     func() time.Time
}

func NewMatchmakingQueue(onMatch func(QueueEntry, QueueEntry)) *MatchmakingQueue {
	return &MatchmakingQueue{
		entries: make(map[*Client]QueueEntry),
		onMatch: onMatch,
		now:     time.Now,
	}
}

func (queue *MatchmakingQueue) Add(client *Client, modeID game.ModeID) QueueEntry {
	return queue.AddWithTimeControl(client, modeID, game.DefaultTimeControl())
}

func (queue *MatchmakingQueue) AddWithTimeControl(
	client *Client,
	modeID game.ModeID,
	timeControl game.TimeControl,
) QueueEntry {
	queue.mu.Lock()
	defer queue.mu.Unlock()
	entry := QueueEntry{
		Client:      client,
		ModeID:      modeID,
		TimeControl: timeControl,
		Elo:         matchmakingElo(client, modeID),
		JoinedAt:    queue.now(),
	}
	queue.entries[client] = entry
	return entry
}

func (queue *MatchmakingQueue) Remove(client *Client) {
	queue.mu.Lock()
	delete(queue.entries, client)
	queue.mu.Unlock()
}

func (queue *MatchmakingQueue) Status(client *Client) (QueueEntry, bool) {
	queue.mu.Lock()
	defer queue.mu.Unlock()
	entry, ok := queue.entries[client]
	return entry, ok
}

func (queue *MatchmakingQueue) PlayerCountsByMode() map[game.ModeID]int {
	queue.mu.Lock()
	defer queue.mu.Unlock()
	counts := make(map[game.ModeID]int)
	for _, entry := range queue.entries {
		counts[entry.ModeID]++
	}
	return counts
}

func (queue *MatchmakingQueue) Run(ctx context.Context) {
	ticker := time.NewTicker(matchmakingTick)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			queue.match()
		}
	}
}

func (queue *MatchmakingQueue) match() {
	queue.mu.Lock()
	now := queue.now()
	entries := make([]QueueEntry, 0, len(queue.entries))
	for _, entry := range queue.entries {
		entries = append(entries, entry)
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].JoinedAt.Before(entries[j].JoinedAt) })

	matched := make(map[*Client]bool)
	pairs := make([][2]QueueEntry, 0)
	for i, first := range entries {
		if matched[first.Client] {
			continue
		}
		bestIndex := -1
		bestDifference := 0
		for candidateIndex, second := range entries[i+1:] {
			if matched[second.Client] || first.ModeID != second.ModeID ||
				first.TimeControl != second.TimeControl ||
				(first.Client.profile.UserID != "" &&
					first.Client.profile.UserID == second.Client.profile.UserID) {
				continue
			}
			difference := absoluteDifference(first.Elo, second.Elo)
			allowedDifference := max(first.SearchRange(now), second.SearchRange(now))
			if !first.searchIsFullyOpen(now) && !second.searchIsFullyOpen(now) &&
				difference > allowedDifference {
				continue
			}
			if bestIndex == -1 || difference < bestDifference {
				bestIndex = i + 1 + candidateIndex
				bestDifference = difference
			}
		}
		if bestIndex != -1 {
			second := entries[bestIndex]
			matched[first.Client] = true
			matched[second.Client] = true
			pairs = append(pairs, [2]QueueEntry{first, second})
		}
	}
	for client := range matched {
		delete(queue.entries, client)
	}
	queue.mu.Unlock()

	for _, pair := range pairs {
		queue.onMatch(pair[0], pair[1])
	}
}

func (entry QueueEntry) searchIsFullyOpen(now time.Time) bool {
	return now.Sub(entry.JoinedAt) >= matchmakingFullyOpenAfter
}

// matchmakingElo reads the rating for the mode being queued, so a player's
// results in one mode never decide who they meet in another.
func matchmakingElo(client *Client, modeID game.ModeID) int {
	if client.account.UserID == "" {
		return persistence.DefaultElo
	}
	return client.account.ModeElo(modeID)
}

func absoluteDifference(first int, second int) int {
	if first < second {
		return second - first
	}
	return first - second
}
