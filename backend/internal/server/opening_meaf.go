package server

// The meaf.us archive, folded into the opening statistics.
//
// meaf.us runs its own server for this game and shared its games -- several
// thousand of them, all human, from players this site has never seen. They are
// worth counting beside this site's own, and worth counting *separately*: an
// opening that is popular in both places is popular for a better reason than
// one community's habit, and the explorer can only show that if the two are
// distinguishable. So they compile into their own segment.
//
// Everything else is the ordinary compile. The games are replayed under this
// server's rules exactly as archived games are, they contribute the same lines
// and the same position counts, and a game that will not replay is skipped and
// counted as skipped. Nothing about being an import earns a game a pass.

import (
	"fmt"

	"rps-strategy/backend/internal/game"
	"rps-strategy/backend/internal/meafarchive"
	"rps-strategy/backend/internal/persistence"
)

// meafModeID is the mode the meaf.us export is games of.
//
// The export carries no mode marker -- it is one server's games and that server
// plays one game -- so the association is declared here rather than guessed. It
// is checked rather than trusted: every game is replayed under this mode's
// rules, and TestMeafExportPlaysUnderIntransitiveRules is what would notice if
// meaf.us ever changed what it runs.
const meafModeID = game.ModeIntransitive

// compileMeafOpenings folds the meaf.us export into one segment's tally.
//
// A mode the export is not games of leaves the segment empty rather than
// filling it with skips. An empty segment and a segment of four thousand
// unreadable games are different claims, and "meaf.us has no Total War games"
// is the true one.
func (server *Server) compileMeafOpenings(
	modeID game.ModeID,
	segment *persistence.OpeningStatsCohort,
) error {
	if modeID != meafModeID {
		return nil
	}
	for index, played := range meafarchive.Games() {
		replay, ok := server.replayMeafGame(modeID, played)
		if !ok {
			segment.Skipped++
			continue
		}
		countOpeningGame(segment, replay, persistence.ArchivedGameOpening{
			// A synthetic identity, because the tally wants one and the export
			// has none. Nothing downstream reads it -- the counts are what
			// survive a compile -- but a duplicate would be a bug worth being
			// able to point at.
			GameID:  fmt.Sprintf("meaf-%d", index),
			Outcome: string(played.Result),
			// No timestamp. The export does not carry one, and a made-up date
			// would show up on the page as "last played" -- a claim about when
			// people play a line, invented. Zero reads as "not known", and a
			// line played on both servers takes this site's date, which is the
			// only real one either way.
			FinishedAtUnixMs: 0,
		})
	}
	return nil
}

// replayMeafGame reads one export game's opening line.
//
// The archive's own replay does this from a PGN; this does it from a move list,
// and the two agree about what they are producing because they end in the same
// place -- a line in the book's notation and the boards it passed through.
// Neither trusts the record: the moves are played onto a scratch game under
// this server's current rules, and a move the rules refuse ends the game's
// contribution rather than being written down.
//
// No relabelling is offered here. The export is Blue-first play on today's
// board -- it was checked that way, game by game, when it was imported -- so a
// record that will not replay as written is a record something is wrong with,
// not one from before the rules changed.
func (server *Server) replayMeafGame(
	modeID game.ModeID,
	played meafarchive.Game,
) (openingReplay, bool) {
	scratch, err := server.newOpeningScratchGame(modeID)
	if err != nil {
		return openingReplay{}, false
	}
	group := server.openingSymmetryFor(modeID)
	replay := openingReplay{
		line:   make([]string, 0, persistence.OpeningStatsPlies),
		moves:  make([]string, 0, persistence.OpeningStatsPlies),
		boards: make([]string, 0, persistence.OpeningStatsPlies+1),
	}
	key, transforms := openingPosition(scratch.Snapshot(), group)
	replay.boards = append(replay.boards, key)
	for _, text := range played.Moves {
		if len(replay.line) >= persistence.OpeningStatsPlies {
			break
		}
		state := scratch.Snapshot()
		if state.Status != game.InProgress {
			break
		}
		movement, ok := parseOpeningBookMove(text)
		if !ok {
			return openingReplay{}, false
		}
		if _, err := scratch.Move(state.CurrentTurn, movement.From, movement.To); err != nil {
			return openingReplay{}, false
		}
		replay.line = append(replay.line, game.OpeningMoveName(movement.From, movement.To))
		replay.moves = append(replay.moves, game.CanonicalMoveName(
			state.Grid.Width(), state.Grid.Height(), transforms, movement.From, movement.To,
		))
		key, transforms = openingPosition(scratch.Snapshot(), group)
		replay.boards = append(replay.boards, key)
	}
	return replay, true
}
