package persistence

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"
)

// Engine titles: the tags an engine wears, and the one way they are not like
// a person's.
//
// The catalogue is in titles.go beside the player one, because the whole of
// what exists should be readable in one list. What is here is the rulebook, and
// the reason it needed a file of its own.
//
// # A reflection, not a collection
//
// titles.go opens by saying that owning a title is permanent: a Grandmaster who
// has a bad month is still a Grandmaster, and nothing there ever deletes an
// earned row. That is exactly right for a person and exactly wrong for an
// engine, because one of the two engine titles is a superlative: *the* reigning
// champion, of which there is one. A superlative kept after it stops being true
// is not a memento, it is a false claim standing in front of a name on the
// ladder.
//
// So an engine's tags are recomputed rather than accumulated. SyncBotTitles
// works out what is true now and makes the rows say that, deleting what has
// lapsed. Two consequences worth stating out loud:
//
//   - Deleting a tournament takes its crown back with it, the same way it
//     already takes back the weekend win it produced — see WeekendWins.
//   - An administrator's grant is still permanent. The rows it writes carry
//     `granted`, and nothing here removes one; the grant outlives the rule, as
//     it does for a person.
//
// # Nobody picks
//
// A person chooses which of their titles to wear. An engine has no account page
// and nobody sitting at it, so the tag is chosen for it: the best thing in its
// own pool, or an administrator's grant when it holds nothing of its own. That
// is also what makes the crown worth having — the engine that just won the
// arena is wearing it before its author has finished reading the standings.

// botWeekendScan is how many weekend arenas the crown looks back over. The same
// bound WeekendWins uses, and about two years of a weekly event.
const botWeekendScan = 100

// BotTitleChange is what one sync did to one engine.
//
// Losses are reported alongside gains because they are the half a caller most
// wants in the log: a crown appearing is explained by the event that just
// finished, and a crown disappearing is explained by nothing unless this says
// so.
type BotTitleChange struct {
	Gained []TitleID
	Lost   []TitleID
	// Worn is the tag the engine ended up with, and "" for none.
	Worn TitleID
}

// SyncBotTitles brings every engine's tags into line with the record, and
// reports the engines that changed.
//
// Whole-fleet rather than per-engine, because that is the shape of the
// questions: "who is top of this ladder" and "who won the last arena" both have
// answers that move somebody else's tag as well as this one's. An engine that
// loses the crown loses it because another engine took it, and a sync that only
// looked at the winner would leave two of them wearing it.
//
// Cheap enough for the lobby ticker: a handful of queries for the facts, then
// one small transaction per engine that has anything to change.
func (store *Store) SyncBotTitles(ctx context.Context) (map[string]BotTitleChange, error) {
	engines, err := store.botAccountIDs(ctx)
	if err != nil {
		return nil, err
	}
	if len(engines) == 0 {
		return nil, nil
	}
	deserved, err := store.deservedBotTitles(ctx, engines)
	if err != nil {
		return nil, err
	}

	changes := make(map[string]BotTitleChange)
	for _, userID := range engines {
		change, changed, err := store.syncOneBotTitles(ctx, userID, deserved[userID])
		if err != nil {
			return nil, err
		}
		if changed {
			changes[userID] = change
		}
	}
	return changes, nil
}

// botAccountIDs is every engine there is, in a stable order so a sweep and its
// log read the same way twice.
func (store *Store) botAccountIDs(ctx context.Context) ([]string, error) {
	rows, err := store.db.QueryContext(ctx, `
SELECT user_id FROM accounts WHERE kind = ? ORDER BY user_id
`, AccountKindBot)
	if err != nil {
		return nil, fmt.Errorf("sync bot titles: read engines: %w", err)
	}
	defer rows.Close()
	engines := make([]string, 0, 16)
	for rows.Next() {
		var userID string
		if err := rows.Scan(&userID); err != nil {
			return nil, fmt.Errorf("sync bot titles: read engines: %w", err)
		}
		engines = append(engines, userID)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("sync bot titles: read engines: %w", err)
	}
	return engines, nil
}

// deservedBotTitles is the whole engine rulebook, answered for the fleet at
// once: which titles each engine's record justifies right now.
//
// One pass for all of them rather than a rulebook run per engine, because the
// answer for one engine is read out of the same scan that answers for the rest
// — the crown in particular is comparative, and moves from one engine to
// another.
func (store *Store) deservedBotTitles(
	ctx context.Context,
	engines []string,
) (map[string]map[TitleID]struct{}, error) {
	isEngine := make(map[string]struct{}, len(engines))
	for _, userID := range engines {
		isEngine[userID] = struct{}{}
	}

	deserved := make(map[string]map[TitleID]struct{}, len(engines))
	award := func(userID string, id TitleID) {
		if _, engine := isEngine[userID]; !engine {
			return
		}
		if deserved[userID] == nil {
			deserved[userID] = make(map[TitleID]struct{}, 2)
		}
		deserved[userID][id] = struct{}{}
	}

	if err := store.awardBotCrown(ctx, award); err != nil {
		return nil, err
	}
	if err := store.awardBotCupWinners(ctx, award); err != nil {
		return nil, err
	}
	return deserved, nil
}

// awardBotCrown hands the arena crown to whoever won the last one.
//
// The last *completed* one, and nothing about how long ago that was. A series
// that has not run since the spring still has a champion — it is the engine
// that beat the field the last time there was a field to beat, and taking the
// tag off it would say an arena nobody has played has somehow been lost.
//
// The whole archive is read rather than the newest row, because "newest" here
// means settled last and the archive is ordered by neither that nor status.
func (store *Store) awardBotCrown(
	ctx context.Context,
	award func(userID string, id TitleID),
) error {
	events, err := store.RecentWeekends(ctx, botWeekendScan)
	if err != nil {
		return err
	}
	var latest *Tournament
	for index := range events {
		event := &events[index]
		if event.Status != TournamentCompleted || event.CompletedAtUnixMs == nil {
			continue
		}
		// By completion rather than by the order the archive came back in,
		// which sorts an unfinished event that was created later above a
		// finished one. Down to the tie, because two arenas settled in the same
		// millisecond would otherwise leave the crown to whichever row the
		// database returned first -- see weekendSettledLater.
		if latest == nil || weekendSettledLater(*event, *latest) {
			latest = event
		}
	}
	if latest == nil {
		return nil
	}
	for userID := range tournamentChampions(*latest) {
		award(userID, TitleReigningChampion)
	}
	return nil
}

// awardBotCupWinners hands out the tag for a tournament somebody organised.
//
// Weekend arenas are excluded for the reason titles.go gives about Tournament
// Champion: a series that crowns an engine every week would hand this to every
// active engine inside a season. The crowns above are what a weekend win earns,
// and they lapse, which is what keeps them worth something.
//
// Only events an engine actually entered are loaded, and the standings are
// recomputed through Tournament rather than queried, so this and the tournament
// page cannot disagree about who won.
func (store *Store) awardBotCupWinners(
	ctx context.Context,
	award func(userID string, id TitleID),
) error {
	rows, err := store.db.QueryContext(ctx, `
SELECT DISTINCT t.tournament_id
FROM tournaments t
JOIN tournament_players p ON p.tournament_id = t.tournament_id
JOIN accounts a ON a.user_id = p.user_id
WHERE t.status = ? AND t.kind <> ? AND a.kind = ?
`, TournamentCompleted, string(TournamentWeekend), AccountKindBot)
	if err != nil {
		return fmt.Errorf("sync bot titles: read tournaments: %w", err)
	}
	ids := make([]string, 0, 8)
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return fmt.Errorf("sync bot titles: read tournaments: %w", err)
		}
		ids = append(ids, id)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return fmt.Errorf("sync bot titles: read tournaments: %w", err)
	}
	// Closed before the per-event reads below, which need the connection this
	// cursor is holding. See RecentWeekends for the same dance.
	if err := rows.Close(); err != nil {
		return fmt.Errorf("sync bot titles: read tournaments: %w", err)
	}

	for _, id := range ids {
		tournament, err := store.Tournament(ctx, id)
		if err != nil {
			return err
		}
		for userID := range tournamentChampions(tournament) {
			award(userID, TitleCupWinner)
		}
	}
	return nil
}

// syncOneBotTitles makes one engine's rows say what is currently true, and
// picks the tag it wears. It reports whether anything moved.
//
// Read and write in one transaction, so a sweep that crosses a finishing game
// cannot award out of one picture and delete out of another.
func (store *Store) syncOneBotTitles(
	ctx context.Context,
	userID string,
	deserved map[TitleID]struct{},
) (BotTitleChange, bool, error) {
	transaction, err := store.db.BeginTx(ctx, nil)
	if err != nil {
		return BotTitleChange{}, false, fmt.Errorf("sync bot titles: begin transaction: %w", err)
	}
	defer func() { _ = transaction.Rollback() }()

	held, err := accountTitlesTx(ctx, transaction, userID)
	if err != nil {
		return BotTitleChange{}, false, err
	}
	var worn TitleID
	err = transaction.QueryRowContext(ctx, `
SELECT title FROM accounts WHERE user_id = ?
`, userID).Scan(&worn)
	// Deleted between the fleet being listed and its turn coming round. Nothing
	// to correct, and not worth failing the rest of the sweep over.
	if errors.Is(err, sql.ErrNoRows) {
		return BotTitleChange{}, false, nil
	}
	if err != nil {
		return BotTitleChange{}, false, fmt.Errorf("sync bot titles: read worn tag: %w", err)
	}

	now := time.Now().UnixMilli()
	change := BotTitleChange{}
	byID := make(map[TitleID]TitleAward, len(held))
	for _, award := range held {
		byID[award.ID] = award
	}

	for id := range deserved {
		if _, have := byID[id]; have {
			continue
		}
		if _, known := LookupTitle(id); !known {
			continue
		}
		if _, err := transaction.ExecContext(ctx, `
INSERT INTO account_titles (user_id, title_id, source, awarded_at_unix_ms)
VALUES (?, ?, ?, ?)
ON CONFLICT(user_id, title_id) DO NOTHING
`, userID, id, TitleSourceEarned, now); err != nil {
			return BotTitleChange{}, false, fmt.Errorf("sync bot titles: award %s: %w", id, err)
		}
		change.Gained = append(change.Gained, id)
	}

	for _, award := range held {
		// Only this pool, and only what a rule handed out. A player title an
		// administrator put on an engine is theirs to take off again, and a
		// grant of an engine title is a deliberate override of the rule that
		// would otherwise decide it.
		if award.Pool != TitlePoolBot || award.Source != TitleSourceEarned {
			continue
		}
		if _, still := deserved[award.ID]; still {
			continue
		}
		if _, err := transaction.ExecContext(ctx, `
DELETE FROM account_titles WHERE user_id = ? AND title_id = ?
`, userID, award.ID); err != nil {
			return BotTitleChange{}, false, fmt.Errorf("sync bot titles: retire %s: %w", award.ID, err)
		}
		change.Lost = append(change.Lost, award.ID)
	}

	change.Worn = botTag(held, change)
	if change.Worn != worn {
		if _, err := transaction.ExecContext(ctx, `
UPDATE accounts SET title = ?, updated_at_unix_ms = ? WHERE user_id = ?
`, change.Worn, now, userID); err != nil {
			return BotTitleChange{}, false, fmt.Errorf("sync bot titles: wear %s: %w", change.Worn, err)
		}
	} else if len(change.Gained) == 0 && len(change.Lost) == 0 {
		return BotTitleChange{}, false, nil
	}

	if err := transaction.Commit(); err != nil {
		return BotTitleChange{}, false, fmt.Errorf("sync bot titles: commit: %w", err)
	}
	sortTitleIDs(change.Gained)
	sortTitleIDs(change.Lost)
	return change, true, nil
}

// botTag is the tag an engine ends up wearing: the best title in its own pool,
// and otherwise the best of whatever else it holds.
//
// The fallback is what keeps an administrator's grant meaningful. Without it, a
// DEV handed to a house engine would sit in its collection and never appear on
// its name — but a crown still has to beat one, because the crown is the thing
// that is true this week.
func botTag(held []TitleAward, change BotTitleChange) TitleID {
	gained := make(map[TitleID]struct{}, len(change.Gained))
	for _, id := range change.Gained {
		gained[id] = struct{}{}
	}
	lost := make(map[TitleID]struct{}, len(change.Lost))
	for _, id := range change.Lost {
		lost[id] = struct{}{}
	}

	// held is already in catalogue order, and the additions are folded back
	// into it rather than appended, so "best" means the same thing whether a
	// title was earned a moment ago or a year ago.
	after := make([]Title, 0, len(held)+len(change.Gained))
	for _, award := range held {
		if _, gone := lost[award.ID]; gone {
			continue
		}
		if title, known := LookupTitle(award.ID); known {
			after = append(after, title)
		}
	}
	for id := range gained {
		if title, known := LookupTitle(id); known {
			after = append(after, title)
		}
	}
	sort.SliceStable(after, func(first, second int) bool {
		return titleIndex[after[first].ID].order < titleIndex[after[second].ID].order
	})

	for _, title := range after {
		if title.Pool == TitlePoolBot {
			return title.ID
		}
	}
	if len(after) > 0 {
		return after[0].ID
	}
	return ""
}

// sortTitleIDs puts a change into catalogue order, so a log line reads the same
// way the tags do rather than in whatever order a map handed them over.
func sortTitleIDs(ids []TitleID) {
	sort.SliceStable(ids, func(first, second int) bool {
		return titleIndex[ids[first]].order < titleIndex[ids[second]].order
	})
}

// String is one line of a change, for a log: what an engine gained, lost, and
// ended up wearing.
func (change BotTitleChange) String() string {
	parts := make([]string, 0, 3)
	if len(change.Gained) > 0 {
		parts = append(parts, "+"+joinTitleIDs(change.Gained))
	}
	if len(change.Lost) > 0 {
		parts = append(parts, "-"+joinTitleIDs(change.Lost))
	}
	if change.Worn == "" {
		parts = append(parts, "wearing nothing")
	} else {
		parts = append(parts, "wearing "+string(change.Worn))
	}
	return strings.Join(parts, ", ")
}

func joinTitleIDs(ids []TitleID) string {
	names := make([]string, 0, len(ids))
	for _, id := range ids {
		names = append(names, string(id))
	}
	return strings.Join(names, " ")
}
