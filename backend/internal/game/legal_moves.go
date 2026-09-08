package game

// Move is one legal move: the square a piece leaves and the square it enters.
//
// The piece and anything it captures are deliberately absent. Both are facts
// about the position, readable from the board, and carrying copies of them
// here would create two things that can disagree.
type Move struct {
	From Position `json:"from"`
	To   Position `json:"to"`
}

// LegalMoves returns every move available to the player whose turn it is.
//
// Order is fixed — rank by rank, then file by file, then whatever order the
// mode returns destinations in — and that matters more than it looks. A seeded
// random opening is only reproducible if "the seventh legal move" means the
// same thing on every run and every machine.
func (game *Game) LegalMoves() []Move {
	game.mu.Lock()
	defer game.mu.Unlock()
	return game.legalMovesLocked(game.state.CurrentTurn)
}

// LegalMovesFor returns every move available to one player.
//
// Only meaningful for the player to move, because a mode's ValidMoves is
// defined for the active player; asking about the other side returns whatever
// that mode makes of the question.
func (game *Game) LegalMovesFor(player PlayerColor) []Move {
	game.mu.Lock()
	defer game.mu.Unlock()
	return game.legalMovesLocked(player)
}

// legalMovesLocked is the scan hasLegalMoveLocked short-circuits.
//
// They are kept separate on purpose: the stalemate check runs after every
// single move and wants to stop at the first move it finds, while this one has
// to see them all. Collapsing them would make the common path pay for the rare
// one. Both walk the board the same way, so a divergence between them would be
// a rules bug, which is what the test cross-checking the two is for.
func (game *Game) legalMovesLocked(player PlayerColor) []Move {
	moves := make([]Move, 0, 32)
	// The mode is handed a state whose grid is its own copy. A GameState is
	// passed by value but its grid is a slice, so without this a mode could
	// scribble on the live board from what is meant to be a read-only question.
	view := game.stateCopyLocked()
	for y, row := range game.state.Grid {
		for x, tile := range row {
			if tile.OccupantOwner != player {
				continue
			}
			from := Position{X: x, Y: y}
			for _, to := range game.mode.ValidMoves(view, player, from) {
				moves = append(moves, Move{From: from, To: to})
			}
		}
	}
	return moves
}
