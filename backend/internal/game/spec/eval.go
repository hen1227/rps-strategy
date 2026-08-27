package spec

// Conditions, over a board.
//
// The mirror of `evaluate`, `evalTerm`, `matchesFilter` and `inRegion` in
// `frontend/src/engine/spec/interpret.ts`, deliberately function for function so
// the two can be read side by side. Where one of them decides something subtle,
// the comment marking it is in both.
//
// Everything here reads the board and nothing writes it. The one exception —
// effects — lives in mode.go, because "what does this move do" is a different
// question from "is this true".

import "rps-strategy/backend/internal/game"

// context is everything a condition can ask about.
//
// One value carried through terms, filters, regions and predicates alike, so
// "the square it landed on" means the same thing in a win condition as in an
// effect. Grid is the board the question is about, which is *after* the move
// everywhere except a movement rule's own `when`.
type context struct {
	spec       RuleSpec
	grid       game.Grid
	mover      game.PlayerColor
	from       game.Position
	to         game.Position
	captured   bool
	moved      game.Piece
	moveNumber int
}

func (ctx context) opponent() game.PlayerColor { return game.OtherColor(ctx.mover) }

// resolveSide is which concrete colour a rule means, from where the mover is
// standing. The empty string is "any", which matches whatever it is compared to.
func (ctx context) resolveSide(ref string) game.PlayerColor {
	switch ref {
	case "mover":
		return ctx.mover
	case "opponent":
		return ctx.opponent()
	case "red":
		return game.Red
	case "blue":
		return game.Blue
	case "neutral":
		return game.Neutral
	default:
		return ""
	}
}

func (ctx context) sideMatches(ref string, actual game.PlayerColor) bool {
	wanted := ctx.resolveSide(ref)
	return wanted == "" || wanted == actual
}

// homeRow is the rank a side starts behind.
//
// Blue's home is rank 1 and Red's is the last, which is the orientation every
// board, record and coordinate in this project already uses. Reaching the
// *opponent's* home is what Infiltration is won by, and stating it this way is
// why that rule needs no board size in it.
func (ctx context) homeRow(side game.PlayerColor) int {
	if side == game.Blue {
		return 0
	}
	return ctx.spec.Board.Height - 1
}

func (ctx context) inRegion(region Node, position game.Position) bool {
	switch {
	case region["rows"] != nil:
		for _, value := range asList(region["rows"]) {
			if index, ok := wholeNumber(value); ok && index == position.Y {
				return true
			}
		}
		return false
	case region["columns"] != nil:
		for _, value := range asList(region["columns"]) {
			if index, ok := wholeNumber(value); ok && index == position.X {
				return true
			}
		}
		return false
	case region["squares"] != nil:
		for _, entry := range asList(region["squares"]) {
			square := asList(entry)
			if len(square) != 2 {
				continue
			}
			x, xOK := wholeNumber(square[0])
			y, yOK := wholeNumber(square[1])
			if xOK && yOK && x == position.X && y == position.Y {
				return true
			}
		}
		return false
	case region["rect"] != nil:
		rect := asNode(region["rect"])
		x, _ := wholeNumber(rect["x"])
		y, _ := wholeNumber(rect["y"])
		width, _ := wholeNumber(rect["width"])
		height, _ := wholeNumber(rect["height"])
		return position.X >= x && position.X < x+width &&
			position.Y >= y && position.Y < y+height
	case region["home"] != nil:
		name, _ := region["home"].(string)
		side := ctx.resolveSide(name)
		if name == "mover" {
			side = ctx.mover
		} else if name == "opponent" {
			side = ctx.opponent()
		}
		return position.Y == ctx.homeRow(side)
	case region["corners"] != nil:
		lastColumn := ctx.grid.Width() - 1
		lastRow := ctx.grid.Height() - 1
		return (position.X == 0 || position.X == lastColumn) &&
			(position.Y == 0 || position.Y == lastRow)
	case region["edge"] != nil:
		return position.X == 0 || position.Y == 0 ||
			position.X == ctx.grid.Width()-1 || position.Y == ctx.grid.Height()-1
	case region["destination"] != nil:
		return position == ctx.to
	case region["origin"] != nil:
		return position == ctx.from
	default:
		return true
	}
}

func (ctx context) matchesFilter(filter Node, tile game.Tile) bool {
	if region, present := filter["region"]; present {
		if !ctx.inRegion(asNode(region), game.Position{X: tile.X, Y: tile.Y}) {
			return false
		}
	}
	if empty, present := filter["empty"]; present {
		wanted, _ := empty.(bool)
		if (tile.Occupant == game.Empty) != wanted {
			return false
		}
	}
	if owner, present := filter["owner"]; present {
		name, _ := owner.(string)
		if !ctx.sideMatches(name, tile.OccupantOwner) {
			return false
		}
	}
	if territory, present := filter["territory"]; present {
		name, _ := territory.(string)
		if !ctx.sideMatches(name, tile.OwnerColor) {
			return false
		}
	}
	if piece, present := filter["piece"]; present {
		found := false
		for _, kind := range asStrings(piece) {
			if game.Piece(kind) == tile.Occupant {
				found = true
			}
		}
		if !found {
			return false
		}
	}
	return true
}

func (ctx context) tilesMatching(filter Node) []game.Tile {
	found := make([]game.Tile, 0, 16)
	for _, row := range ctx.grid {
		for _, tile := range row {
			if ctx.matchesFilter(filter, tile) {
				found = append(found, tile)
			}
		}
	}
	return found
}

func (ctx context) evalTerm(term any) float64 {
	if number, ok := term.(float64); ok {
		return number
	}
	node := asNode(term)
	switch {
	case node["count"] != nil:
		return float64(len(ctx.tilesMatching(asNode(node["count"]))))
	case node["row"] != nil:
		if which, _ := node["row"].(string); which == "to" {
			return float64(ctx.to.Y)
		}
		return float64(ctx.from.Y)
	case node["column"] != nil:
		if which, _ := node["column"].(string); which == "to" {
			return float64(ctx.to.X)
		}
		return float64(ctx.from.X)
	case node["moveNumber"] != nil:
		return float64(ctx.moveNumber)
	case node["share"] != nil:
		// Territory as a fraction of the whole board, so a mode can say "hold two
		// thirds of it" without knowing how big the board is.
		tiles := ctx.grid.Width() * ctx.grid.Height()
		if tiles == 0 {
			return 0
		}
		side, _ := node["share"].(string)
		return float64(len(ctx.tilesMatching(Node{"territory": side}))) / float64(tiles)
	default:
		return 0
	}
}

func (ctx context) evaluate(predicate any) bool {
	if value, ok := predicate.(bool); ok {
		return value
	}
	node := asNode(predicate)
	switch {
	case node["and"] != nil:
		for _, item := range asList(node["and"]) {
			if !ctx.evaluate(item) {
				return false
			}
		}
		return true
	case node["or"] != nil:
		for _, item := range asList(node["or"]) {
			if ctx.evaluate(item) {
				return true
			}
		}
		return false
	case node["not"] != nil:
		return !ctx.evaluate(node["not"])
	case node["eq"] != nil:
		pair := asList(node["eq"])
		return ctx.evalTerm(pair[0]) == ctx.evalTerm(pair[1])
	case node["lt"] != nil:
		pair := asList(node["lt"])
		return ctx.evalTerm(pair[0]) < ctx.evalTerm(pair[1])
	case node["lte"] != nil:
		pair := asList(node["lte"])
		return ctx.evalTerm(pair[0]) <= ctx.evalTerm(pair[1])
	case node["gt"] != nil:
		pair := asList(node["gt"])
		return ctx.evalTerm(pair[0]) > ctx.evalTerm(pair[1])
	case node["gte"] != nil:
		pair := asList(node["gte"])
		return ctx.evalTerm(pair[0]) >= ctx.evalTerm(pair[1])
	case node["in"] != nil:
		pair := asList(node["in"])
		which, _ := pair[0].(string)
		square := ctx.from
		if which == "to" {
			square = ctx.to
		}
		return ctx.inRegion(asNode(pair[1]), square)
	case node["captured"] != nil:
		return ctx.captured
	case node["moved"] != nil:
		for _, kind := range asStrings(node["moved"]) {
			if game.Piece(kind) == ctx.moved {
				return true
			}
		}
		return false
	case node["any"] != nil:
		quantifier := asNode(node["any"])
		tiles := ctx.tilesMatching(asNode(quantifier["tiles"]))
		where, present := quantifier["where"]
		if !present {
			return len(tiles) > 0
		}
		for range tiles {
			if ctx.evaluate(where) {
				return true
			}
		}
		return false
	case node["all"] != nil:
		quantifier := asNode(node["all"])
		tiles := ctx.tilesMatching(asNode(quantifier["tiles"]))
		where, present := quantifier["where"]
		if !present {
			return len(tiles) > 0
		}
		for range tiles {
			if !ctx.evaluate(where) {
				return false
			}
		}
		return true
	default:
		return false
	}
}

/* ------------------------------------------------------------------ helpers -- */

// A decoded spec is untyped JSON, so reading it is a series of small questions
// with an answer for "no". Every one of these returns a usable zero rather than
// panicking: Validate has already refused anything malformed, and a rule that
// slipped past it should make a move illegal, not take the server down.

func asNode(value any) Node {
	if node, ok := value.(Node); ok {
		return node
	}
	return Node{}
}

func asList(value any) []any {
	if list, ok := value.([]any); ok {
		return list
	}
	return nil
}

func asStrings(value any) []string {
	switch typed := value.(type) {
	case string:
		return []string{typed}
	case []any:
		found := make([]string, 0, len(typed))
		for _, entry := range typed {
			if name, ok := entry.(string); ok {
				found = append(found, name)
			}
		}
		return found
	default:
		return nil
	}
}

func asBool(value any) bool {
	flag, _ := value.(bool)
	return flag
}

// intOr reads a whole number with a default, for the fields that have one.
func intOr(value any, fallback int) int {
	if number, ok := wholeNumber(value); ok {
		return number
	}
	return fallback
}
