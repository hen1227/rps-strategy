package server

// Compiling what people actually play.
//
// The opening book says what is good; this says what happens. Both are on the
// openings page and they are different kinds of claim, which is why they are
// computed by different things: the book is the engine's, published from a
// shell, and this is the archive's, recompiled here every day.
//
// The whole thing is a replay. Every archived game in a mode is parsed, its
// moves are played onto a scratch game under *this server's current rules*,
// and the first few plies become the line it opened with. Counting a stored
// move list instead would be faster and would be wrong in a way nothing would
// catch: the rules changed on 2026-09-03 -- Blue moves first now, where Red
// used to -- so most of the archive is a record of a game whose opening moves
// are not legal opening moves any more. Replaying is what notices.
//
// A record today's rules refuse is tried again through the rank flip: reverse
// the ranks and swap the colours and a game Red opened from the top of the
// board is the same game with Blue opening from the bottom, which is a legal
// game now. That relabels rather than reinterprets -- see game.RankFlipGrid --
// so a game from before the change contributes the opening it actually played,
// named from the end of the board an opener plays from today. Its result is
// turned with it, because the side that won is now the other colour. Turned
// games are counted and reported as turned; a game that will not replay either
// way is skipped and counted as skipped, and the page says both.
//
// The flip and not the half turn, which is the subtle part. Two things changed
// on 2026-09-03: the first mover, and Intransitive's board, which was flipped
// end for end so that the corner Red runs for moved from i1 to a1. A half turn
// is a symmetry of today's rules and carries today's Intransitive onto itself;
// what an old record needs is the map from yesterday's Intransitive onto
// today's, and that is the rank flip. The two agree on Total War and
// Infiltration, so reaching for the wrong one skipped every pre-change V6 game
// and nothing else -- see game/rank_flip.go.

import (
	"context"
	"errors"
	"fmt"
	"hash/fnv"
	"log"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"rps-strategy/backend/internal/game"
	"rps-strategy/backend/internal/notation"
	"rps-strategy/backend/internal/persistence"
)

// openingStatsInterval is how often the statistics are recompiled.
//
// Daily, because that is what the numbers are worth: an opening share moves
// over weeks, and nobody watching the page needs to see a percentage tick.
const openingStatsInterval = 24 * time.Hour

// openingStatsPopular is how many "most played" lines the condensed payload
// carries. Enough to be a list worth reading, short enough to stay condensed.
const openingStatsPopular = 25

// compileOpeningStats recompiles one mode's statistics from every source.
//
// One tally per segment, and every game lands in exactly one of them. Nothing
// is pre-mixed: a reader who wants humans and meaf.us together gets the two
// counts added when they ask, which is what lets four checkboxes offer fifteen
// combinations without compiling fifteen of anything. See the segment
// constants in persistence for why the arithmetic is sound.
func (server *Server) compileOpeningStats(ctx context.Context, modeID game.ModeID) error {
	segments := map[string]*persistence.OpeningStatsCohort{}
	segmentFor := func(name string) *persistence.OpeningStatsCohort {
		if existing, ok := segments[name]; ok {
			return existing
		}
		created := &persistence.OpeningStatsCohort{
			Cohort:    name,
			Lines:     map[string]*persistence.OpeningStatsLine{},
			Positions: map[string]*persistence.OpeningStatsPosition{},
		}
		segments[name] = created
		return created
	}
	// Every segment exists even when empty, so a compile that found no human
	// games stores "0 games, compiled just now" rather than nothing. The page
	// tells those two apart and they read very differently.
	for _, name := range persistence.OpeningSegments {
		segmentFor(name)
	}

	err := server.data.EachArchivedGameOpening(
		ctx, string(modeID),
		func(archived persistence.ArchivedGameOpening) error {
			segment := segmentFor(openingSegmentOf(archived))
			replay, ok := server.replayArchivedOpening(modeID, archived.PGN)
			if !ok {
				segment.Skipped++
				return nil
			}
			// Everything downstream counts colours, so the game is relabelled
			// once here rather than at the tally: a turned record's Red win is
			// a Blue win in the statistics, and its two seats change hands.
			if replay.turned {
				archived = rankFlipArchivedGame(archived)
				segment.Turned++
			}
			countOpeningGame(segment, replay, archived)
			return nil
		},
	)
	if err != nil {
		return fmt.Errorf("compile opening statistics for %s: %w", modeID, err)
	}
	if err := server.compileMeafOpenings(modeID, segmentFor(persistence.OpeningSegmentMeaf)); err != nil {
		return fmt.Errorf("compile opening statistics for %s: %w", modeID, err)
	}

	ordered := make([]persistence.OpeningStatsCohort, 0, len(segments))
	for _, segment := range segments {
		ordered = append(ordered, *segment)
	}
	return server.data.ReplaceOpeningStats(ctx, string(modeID), ordered)
}

// openingReplay is one archived game as today's rules read it.
type openingReplay struct {
	// line is the opening it played, in the book's notation, spelled exactly as
	// it was played. This is what the line-keyed statistics count, and it is
	// deliberately not folded: a line is a path somebody walked.
	line []string
	// moves is the same moves named for the *canonical* board each was played
	// from -- see game.CanonicalMoveName. One per entry in line, and the
	// spelling the position-keyed statistics store, so that a game that played
	// `e3-f3` and a game that played its reflection `c5-c6` write to one row
	// instead of two.
	moves []string
	// boards is one key per position the line passed through, starting with
	// the board it opened from. Canonical keys: a board and its reflection are
	// one position, so they are one key. See game.CanonicalBoard.
	boards []string
	// turned records that the game only replayed once its ranks were reversed
	// and its colours swapped -- which is to say it was played before
	// 2026-09-03, when Red moved first and Intransitive ran the other way. The
	// line and boards here are the flipped game's, so they are the same
	// openings the rest of the archive is counted in; the caller has the result
	// and the seats left to turn.
	turned bool
}

// replayArchivedOpening reads a game's opening line out of its PGN.
//
// Twice, at most: as recorded, and then through the rank flip for a record
// today's rules refuse. Nothing here asks the mode's permission first. The
// record's own declared starting board is the evidence -- it has to flip onto
// exactly this mode's opening position, side to move included, or the reading
// is refused -- and every move then has to be legal from there. A relabelling
// that does not suit a mode fails that on the first move, which is what it did
// for Intransitive for as long as this reached for the half turn.
func (server *Server) replayArchivedOpening(
	modeID game.ModeID,
	pgn string,
) (openingReplay, bool) {
	parsed, err := notation.Parse(pgn)
	if err != nil {
		return openingReplay{}, false
	}
	if replay, ok := server.replayOpening(modeID, parsed, false); ok {
		return replay, true
	}
	return server.replayOpening(modeID, parsed, true)
}

// replayOpening plays one record onto a scratch game, optionally turned.
//
// The moves are replayed rather than trusted, so the line is one this server's
// rules agree is playable. The clock is irrelevant here and generous for that
// reason: a replay consumes no time, and TimeControl still insists on a
// positive allowance.
func (server *Server) replayOpening(
	modeID game.ModeID,
	parsed notation.ParsedGame,
	turned bool,
) (openingReplay, bool) {
	// A game that began from a drawn board is not this mode's opening. The
	// same rule the live board applies before it reports an openingLine at
	// all: a line measured from somebody's own position would name openings
	// nobody played.
	if parsed.Tag("SetUp") == "1" {
		start := parsed.Tag("FEN")
		if start != "" && !server.isStandardStartingPosition(modeID, start, turned) {
			return openingReplay{}, false
		}
	}
	scratch, err := server.newOpeningScratchGame(modeID)
	if err != nil {
		return openingReplay{}, false
	}
	group := server.openingSymmetryFor(modeID)
	replay := openingReplay{
		line:  make([]string, 0, persistence.OpeningStatsPlies),
		moves: make([]string, 0, persistence.OpeningStatsPlies),
		// One more board than there are moves: the starting position, then the
		// board after each move. `boards[n]` is the board the line's move `n`
		// was played from, which is what pairs a move with the position it came
		// out of.
		boards: make([]string, 0, persistence.OpeningStatsPlies+1),
		turned: turned,
	}
	key, transforms := openingPosition(scratch.Snapshot(), group)
	replay.boards = append(replay.boards, key)
	for _, event := range parsed.Record.Events {
		if event.Kind != game.EventMove {
			continue
		}
		if len(replay.line) >= persistence.OpeningStatsPlies {
			break
		}
		state := scratch.Snapshot()
		if state.Status != game.InProgress {
			break
		}
		player, from, to := event.Player, event.From, event.To
		if turned {
			width, height := state.Grid.Width(), state.Grid.Height()
			player = game.OtherColor(player)
			from = game.RankFlipSquare(width, height, from)
			to = game.RankFlipSquare(width, height, to)
		}
		// The colour the archive recorded, not the colour whose turn it is: a
		// record from before the first mover changed replays its first move as
		// Red, this game says Blue, and the mismatch is exactly the signal that
		// this game is not describing today's rules -- and, turned, that it is
		// not describing yesterday's either.
		if player != state.CurrentTurn {
			return openingReplay{}, false
		}
		if _, err := scratch.Move(player, from, to); err != nil {
			return openingReplay{}, false
		}
		replay.line = append(replay.line, game.OpeningMoveName(from, to))
		// Named on the board it was played *from*, which is why `transforms` is
		// the one carried in from the previous ply rather than the one the move
		// arrives at.
		replay.moves = append(replay.moves, game.CanonicalMoveName(
			state.Grid.Width(), state.Grid.Height(), transforms, from, to,
		))
		key, transforms = openingPosition(scratch.Snapshot(), group)
		replay.boards = append(replay.boards, key)
	}
	// A game with no moves is not an opening. It is still a game that was
	// played, so the caller counts it in the total and stores no line.
	return replay, true
}

// newOpeningScratchGame is the board every replay in here is played onto.
//
// The clock is irrelevant to a replay and generous for that reason: replaying
// consumes no time, and TimeControl still insists on a positive allowance.
func (server *Server) newOpeningScratchGame(modeID game.ModeID) (*game.Game, error) {
	return game.NewGameWithRegistryAndTimeControl(
		server.registry, "opening-stats", modeID,
		game.PlayerProfile{UserID: "stats-red"},
		game.PlayerProfile{UserID: "stats-blue"},
		game.TimeControl{InitialTimeMs: int64(time.Hour / time.Millisecond)},
	)
}

// rankFlipArchivedGame relabels an archived game for a record that only
// replayed flipped.
//
// The two seats change hands and so does the result: the game a pre-change
// record says Red won is one Blue won, played from the other end of the board.
func rankFlipArchivedGame(
	archived persistence.ArchivedGameOpening,
) persistence.ArchivedGameOpening {
	archived.RedPlayerID, archived.BluePlayerID = archived.BluePlayerID, archived.RedPlayerID
	switch archived.Outcome {
	case "red_win":
		archived.Outcome = "blue_win"
	case "blue_win":
		archived.Outcome = "red_win"
	}
	return archived
}

// openingPosition names a board for the explorer, and says how it was named.
//
// The same fact `positionForRepetition` uses -- the board plus the side to
// move is what makes a position the same picture twice -- with the board folded
// onto its canonical reflection first, and the result hashed because Grid.Key
// spells out every tile and runs to about a kilobyte on a nine by nine.
//
// The fold is what makes the explorer's counts honest. Nothing in Intransitive
// can tell a board from its reflection about the a1-i9 diagonal, so a game that
// opened `e3-f3` and a game that opened `c5-c6` reached the same position; two
// keys would have split one position's games in half and shown a reader two
// half-sized boards that are the same board. See game/symmetry.go, and
// game.ModeDefinition.Symmetries for why the mode is asked rather than assumed.
//
// The second return is the set of relabellings that produced this key, which
// the caller needs in order to name a *move* out of this board the same way
// twice. Nothing reverses the key itself: a caller asks about a board by
// replaying a line, and the rules live here, so a key the client computed is
// one this server could not check anyway.
func openingPosition(
	state game.GameState,
	group []game.BoardSymmetry,
) (string, []game.BoardSymmetry) {
	spelling, transforms := game.CanonicalBoard(state.Grid, group)
	digest := fnv.New64a()
	_, _ = digest.Write([]byte(spelling))
	_, _ = digest.Write([]byte{' '})
	_, _ = digest.Write([]byte(state.CurrentTurn))
	return strconv.FormatUint(digest.Sum64(), 16), transforms
}

// openingSymmetryFor reads the fold off a mode.
//
// A mode this server does not know gets the identity, which is the answer that
// folds nothing -- and the compile that asked has bigger problems than its
// position keys.
func (server *Server) openingSymmetryFor(modeID game.ModeID) []game.BoardSymmetry {
	mode, err := server.registry.New(modeID)
	if err != nil {
		return []game.BoardSymmetry{game.SymmetryNone}
	}
	return mode.Definition().SymmetryGroup()
}

// countOpeningGame folds one replayed game into one segment.
//
// Separate from the walk over the archive because more than one walk feeds it:
// this site's own games and the meaf.us import land in different segments by
// different routes and are counted by the same code.
func countOpeningGame(
	cohort *persistence.OpeningStatsCohort,
	replay openingReplay,
	archived persistence.ArchivedGameOpening,
) {
	line := replay.line
	cohort.Games++
	countOpeningBoards(cohort, replay.boards, replay.moves, archived)
	// Every prefix, which is what makes a share a lookup. A game with no legal
	// opening moves at all still counts toward the total: it is a game that
	// was played, and leaving it out of the denominator would inflate every
	// share above it.
	for length := 1; length <= len(line); length++ {
		key := strings.Join(line[:length], " ")
		entry, ok := cohort.Lines[key]
		if !ok {
			entry = &persistence.OpeningStatsLine{
				Line: append([]string(nil), line[:length]...),
				Move: line[length-1],
			}
			cohort.Lines[key] = entry
		}
		entry.Games++
		addOpeningOutcome(archived.Outcome,
			&entry.RedWins, &entry.BlueWins, &entry.Draws)
		if archived.FinishedAtUnixMs > entry.LastPlayedUnixMs {
			entry.LastPlayedUnixMs = archived.FinishedAtUnixMs
		}
	}
}

// countOpeningBoards folds one game into a segment's position counts.
//
// A board is counted once per game however often the game returned to it: a
// line that shuffles a piece out and back has not been reached twice by two
// games, and counting it twice would let one game outvote another. Under the
// symmetry fold that also covers a game that shuffles a piece out and plays the
// reflection back, which is the same board by the same argument.
//
// `moves` is the canonically named move out of each board, not the line as
// played: both keys here are the folded ones, so a reflected game lands on the
// same position row *and* the same move row as its twin.
func countOpeningBoards(
	cohort *persistence.OpeningStatsCohort,
	boards []string,
	moves []string,
	archived persistence.ArchivedGameOpening,
) {
	counted := make(map[string]struct{}, len(boards))
	for index, key := range boards {
		position, ok := cohort.Positions[key]
		if !ok {
			position = &persistence.OpeningStatsPosition{
				Ply:   index,
				Moves: map[string]*persistence.OpeningStatsMove{},
			}
			cohort.Positions[key] = position
		}
		// The shallowest route wins: an explorer says "four moves in", and the
		// shortest way anybody got there is the honest answer to that.
		if index < position.Ply {
			position.Ply = index
		}
		if _, already := counted[key]; !already {
			counted[key] = struct{}{}
			position.Games++
			addOpeningOutcome(archived.Outcome,
				&position.RedWins, &position.BlueWins, &position.Draws)
			if archived.FinishedAtUnixMs > position.LastPlayedUnixMs {
				position.LastPlayedUnixMs = archived.FinishedAtUnixMs
			}
		}
		// The move this game played out of this board. The last board has none:
		// it is where the counted part of the game stopped.
		if index >= len(moves) {
			continue
		}
		move, ok := position.Moves[moves[index]]
		if !ok {
			move = &persistence.OpeningStatsMove{}
			position.Moves[moves[index]] = move
		}
		move.Games++
		addOpeningOutcome(archived.Outcome, &move.RedWins, &move.BlueWins, &move.Draws)
	}
}

// addOpeningOutcome tallies one archived result.
func addOpeningOutcome(outcome string, red, blue, draws *int) {
	switch outcome {
	case "red_win":
		*red++
	case "blue_win":
		*blue++
	case "draw":
		*draws++
	}
}

// isStandardStartingPosition reports whether a FEN is this mode's own start,
// seen through the rank flip if the caller is reading the record turned.
//
// The comparison is between re-encoded positions rather than between the
// strings, because a turned board has to be encoded to be compared at all and
// two spellings of one position must not read as two positions. It is the side
// to move that does the work here: every archived game carries a FEN, and one
// written before 2026-09-03 spells that day's opening board with Red to move,
// which is this mode's start flipped and nothing else. For Total War and
// Infiltration that is the same board with the other side to move; for
// Intransitive it is a different board, because that layout was flipped too.
// This is the check that makes the flip safe to apply without asking the mode
// first: a relabelling that lands anywhere but exactly this mode's opening
// position is refused here, before a single move is replayed.
func (server *Server) isStandardStartingPosition(
	modeID game.ModeID,
	fen string,
	turned bool,
) bool {
	mode, err := server.registry.New(modeID)
	if err != nil {
		return false
	}
	grid, turn, err := notation.DecodePosition(fen)
	if err != nil {
		return false
	}
	if turned {
		grid = game.RankFlipGrid(grid)
		turn = game.OtherColor(turn)
	}
	expected := notation.EncodeStartingPosition(mode.Definition().StartingPosition)
	return strings.EqualFold(notation.EncodePosition(grid, turn), expected)
}

// openingSegmentOf decides which of this site's three segments a game is in.
//
// A bot plays under an account whose ID carries persistence.BotAccountPrefix,
// which is the only marker that survives into the archive -- the PGN records
// usernames, and a username can be anything.
func openingSegmentOf(archived persistence.ArchivedGameOpening) string {
	return persistence.SegmentForSeats(archived.RedPlayerID, archived.BluePlayerID)
}

// runOpeningStats keeps the statistics fresh, on its own timer.
//
// Not on the lobby ticker, unlike the other housekeeping here: a compile
// replays every archived game in every mode, which is far too much work to put
// on the two-second tick the game loop shares. Its own goroutine can take as
// long as it takes without a game noticing.
//
// It compiles on startup when the stored set is older than a day, so a server
// that was down over a compile does not wait a further day for one, and a
// server restarted repeatedly does not recompile on every boot.
func (server *Server) runOpeningStats(ctx context.Context) {
	ticker := time.NewTicker(openingStatsInterval)
	defer ticker.Stop()

	server.compileStaleOpeningStats(ctx)
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			server.compileOpeningStatsForEveryMode(ctx)
		}
	}
}

func (server *Server) compileStaleOpeningStats(ctx context.Context) {
	for _, modeID := range server.registry.IDs() {
		computed, compiler, err := server.data.OpeningStatsCompiledAt(ctx, string(modeID))
		if err != nil {
			log.Printf("opening statistics: reading %s: %v", modeID, err)
			continue
		}
		// A set an older compiler produced is recompiled however fresh it is.
		// Age is the ordinary reason to recompile; this is the one where
		// waiting would leave numbers on the page that this server can no
		// longer read -- see persistence.OpeningStatsCompiler.
		if compiler == persistence.OpeningStatsCompiler &&
			time.Since(time.UnixMilli(computed)) < openingStatsInterval {
			continue
		}
		server.compileOneOpeningStats(ctx, modeID)
	}
}

func (server *Server) compileOpeningStatsForEveryMode(ctx context.Context) {
	for _, modeID := range server.registry.IDs() {
		server.compileOneOpeningStats(ctx, modeID)
	}
}

// compileOneOpeningStats compiles a mode and logs what it found.
//
// A failure is logged and dropped rather than propagated: the statistics are
// an ornament on the openings page, and no part of the server that runs games
// should stop because a count could not be taken.
func (server *Server) compileOneOpeningStats(ctx context.Context, modeID game.ModeID) {
	started := time.Now()
	if err := server.compileOpeningStats(ctx, modeID); err != nil {
		if !errors.Is(err, context.Canceled) {
			log.Printf("opening statistics: compiling %s: %v", modeID, err)
		}
		return
	}
	log.Printf("opening statistics: compiled %s in %s", modeID, time.Since(started).Round(time.Millisecond))
}

// getOpeningStats serves what people play.
//
// With no `line`, the response is the whole condensed dataset for a mode: the
// totals, the first-move breakdown with a share on each, and the most played
// lines. That is deliberately one request -- the interesting version of this
// data is small, and anybody building against it should not have to walk a
// tree to see it.
//
// With a `line`, it is that position: how many games got there, what share of
// the mode that is, and where they went next.
func (server *Server) getOpeningStats(writer http.ResponseWriter, request *http.Request) {
	modeID, ok := server.openingMode(writer, request)
	if !ok {
		return
	}
	query := request.URL.Query()
	segments, ok := openingSegmentsFrom(writer, query)
	if !ok {
		return
	}
	line, err := parseOpeningLineQuery(query.Get("line"))
	if err != nil {
		writeAPIError(writer, http.StatusBadRequest, err.Error())
		return
	}
	// The popular list is the mode's, not the position's, so it is only worth
	// sending with the position that is asking about the whole mode.
	popular := 0
	if len(line) == 0 {
		popular = openingStatsPopular
	}
	node, err := server.data.OpeningStatsAt(
		request.Context(), string(modeID), segments, line, popular,
	)
	if err != nil {
		if errors.Is(err, persistence.ErrOpeningStatsNotFound) {
			writeAPIError(writer, http.StatusNotFound, err.Error())
			return
		}
		writeOpeningBookError(writer, err)
		return
	}
	writeJSON(writer, http.StatusOK, node)
}

// recompileOpeningStats forces a compile now, for a curator who has just
// archived something and does not want to wait a day to see it counted.
func (server *Server) recompileOpeningStats(writer http.ResponseWriter, request *http.Request) {
	modeID, ok := server.openingMode(writer, request)
	if !ok {
		return
	}
	if err := server.compileOpeningStats(request.Context(), modeID); err != nil {
		writeAPIError(writer, http.StatusInternalServerError, err.Error())
		return
	}
	node, err := server.data.OpeningStatsAt(
		request.Context(), string(modeID),
		[]string{persistence.OpeningSegmentHuman}, nil, 0,
	)
	if err != nil {
		writeOpeningBookError(writer, err)
		return
	}
	writeJSON(writer, http.StatusOK, node)
}

// exploreOpeningPosition answers "what happens from this board".
//
// The caller sends the *line* it walked, not a position key: the rules live
// here, so this replays the line to reach the board and derive its key. A key
// the client computed would be one this server could not check, and a line it
// could not legally play is a question with no honest answer.
func (server *Server) exploreOpeningPosition(writer http.ResponseWriter, request *http.Request) {
	modeID, ok := server.openingMode(writer, request)
	if !ok {
		return
	}
	query := request.URL.Query()
	segments, ok := openingSegmentsFrom(writer, query)
	if !ok {
		return
	}
	line, err := parseOpeningLineQuery(query.Get("line"))
	if err != nil {
		writeAPIError(writer, http.StatusBadRequest, err.Error())
		return
	}
	if len(line) > persistence.OpeningStatsPlies {
		writeAPIError(writer, http.StatusBadRequest, fmt.Sprintf(
			"the statistics only go %d moves deep", persistence.OpeningStatsPlies,
		))
		return
	}
	board, ok := server.exploredBoardFor(modeID, line)
	if !ok {
		writeAPIError(
			writer, http.StatusBadRequest,
			"those moves cannot be played from this mode's starting position",
		)
		return
	}
	explored, err := server.data.ExploreOpeningPosition(
		request.Context(), string(modeID), segments, board.key, line,
	)
	if err != nil {
		if errors.Is(err, persistence.ErrOpeningStatsNotFound) {
			writeAPIError(writer, http.StatusNotFound, err.Error())
			return
		}
		writeOpeningBookError(writer, err)
		return
	}
	board.spellMoves(explored.Moves)
	writeJSON(writer, http.StatusOK, explored)
}

// exploredBoard is the board a caller walked to, and how it was folded to reach
// the statistics.
//
// Both halves are needed and only one of them is stored. The counts live on the
// canonical board -- the smallest spelling of this position and its reflections
// -- while the visitor is standing on whichever image of it their own moves
// happened to produce. Handing them the canonical board's move names would name
// squares they are not looking at, so the fold is undone on the way out.
type exploredBoard struct {
	key           string
	width, height int
	// transforms is every symmetry that maps the caller's board onto the
	// canonical one. More than one exactly when the caller's board is left
	// alone by a symmetry, which is what makes two spellings of one move.
	transforms []game.BoardSymmetry
}

// spellMoves rewrites stored moves into the coordinates of the board the caller
// is standing on, in place.
//
// A move comes back with more than one spelling when the board is its own
// reflection: from Intransitive's opening position `e3-f3` and `c5-c6` are one
// move that can be played two ways, so they are one row with one set of counts,
// and the page draws the second as the first arrow's dashed twin. Which of the
// spellings leads is arbitrary and alphabetical -- what matters is that the row
// is one row.
func (board exploredBoard) spellMoves(moves []persistence.OpeningStatsExploredMove) {
	for index := range moves {
		movement, ok := parseOpeningBookMove(moves[index].Move)
		if !ok {
			continue
		}
		spellings := game.MoveSpellings(
			board.width, board.height, board.transforms, movement.From, movement.To,
		)
		moves[index].Move = spellings[0]
		moves[index].Twins = spellings[1:]
	}
}

// exploredBoardFor replays a line and describes the board it reaches.
//
// Named apart from openingBoardFor in opening_mirror.go, which answers a
// different question about a mode -- how its *names* are keyed -- and not about
// any particular board.
func (server *Server) exploredBoardFor(
	modeID game.ModeID,
	line []string,
) (exploredBoard, bool) {
	scratch, err := game.NewGameWithRegistryAndTimeControl(
		server.registry, "opening-explore", modeID,
		game.PlayerProfile{UserID: "explore-red"},
		game.PlayerProfile{UserID: "explore-blue"},
		game.TimeControl{InitialTimeMs: int64(time.Hour / time.Millisecond)},
	)
	if err != nil {
		return exploredBoard{}, false
	}
	for _, text := range line {
		movement, ok := parseOpeningBookMove(text)
		if !ok {
			return exploredBoard{}, false
		}
		state := scratch.Snapshot()
		if state.Status != game.InProgress {
			return exploredBoard{}, false
		}
		if _, err := scratch.Move(state.CurrentTurn, movement.From, movement.To); err != nil {
			return exploredBoard{}, false
		}
	}
	state := scratch.Snapshot()
	key, transforms := openingPosition(state, server.openingSymmetryFor(modeID))
	return exploredBoard{
		key:        key,
		width:      state.Grid.Width(),
		height:     state.Grid.Height(),
		transforms: transforms,
	}, true
}

// openingSegmentsFrom reads the set of sources a request asked for.
//
// Accepts them repeated (`?segment=human&segment=meaf`) or comma-separated
// (`?segments=human,meaf`), because the page builds one and a person typing a
// URL builds the other. `cohort=` is still honoured: it is what every caller
// sent before there was more than one source to pick from, and `cohort=all`
// still means everything, which is what it always meant.
//
// An empty selection is rejected rather than defaulted. Every box unticked is a
// question with no subject, and quietly answering a different question -- the
// default one -- would put numbers on screen that no checkbox explains.
func openingSegmentsFrom(writer http.ResponseWriter, query url.Values) ([]string, bool) {
	asked := make([]string, 0, len(persistence.OpeningSegments))
	for _, key := range []string{"segment", "segments", "cohort", "cohorts"} {
		for _, value := range query[key] {
			for _, name := range strings.Split(value, ",") {
				if trimmed := strings.TrimSpace(name); trimmed != "" {
					asked = append(asked, trimmed)
				}
			}
		}
	}
	if len(asked) == 0 {
		// Humans by default: bots outnumber them several to one in the archive
		// and play whatever book they were handed, so an unqualified "most
		// played" that included them would be a survey of bot configuration.
		return []string{persistence.OpeningSegmentHuman}, true
	}
	for _, name := range asked {
		// "all" is the one name that is not a segment. It predates the
		// checkboxes and meant "every game in the mode", which is now every
		// segment there is -- including meaf.us, which is a change in what the
		// word covers and the honest reading of it.
		if strings.EqualFold(name, "all") {
			return append([]string(nil), persistence.OpeningSegments...), true
		}
	}
	segments := persistence.NormalizeOpeningSegments(asked)
	if len(segments) == 0 {
		writeAPIError(writer, http.StatusBadRequest,
			"segments must be one or more of "+
				strings.Join(persistence.OpeningSegments, ", ")+", or all")
		return nil, false
	}
	return segments, true
}
