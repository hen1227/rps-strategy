package spec

// The rule half of the validator: movement, effects, win conditions, and the
// little language of regions, filters, terms and predicates they are built from.
//
// Kept in its own file because it is a recursive walk over untyped JSON and the
// checks above are flat reads of typed fields — two different shapes of code
// answering two different questions. The order of the checks, and their wording,
// deliberately match `frontend/src/engine/spec/validate.ts` function for
// function, so the two can be read side by side.

import (
	"fmt"
	"sort"
	"strings"
)

func (check *validator) node(value any, path string) (Node, bool) {
	node, ok := value.(Node)
	if !ok {
		return nil, false
	}
	_ = path
	return node, true
}

func (check *validator) list(value any) ([]any, bool) {
	list, ok := value.([]any)
	return list, ok
}

/* ------------------------------------------------------------------ regions -- */

func (check *validator) region(value any, path string) {
	node, ok := check.node(value, path)
	if !ok {
		check.fail(path, "a region is an object")
		return
	}
	key, sole := soleKey(node, regionKinds)
	if !sole {
		check.fail(path, "a region names exactly one kind")
		return
	}
	switch key {
	case "rows", "columns":
		limit := check.height
		if key == "columns" {
			limit = check.width
		}
		list, ok := check.list(node[key])
		if !ok || len(list) == 0 {
			check.fail(path, "%s is a non-empty list of indexes", key)
			return
		}
		for index, entry := range list {
			value, whole := wholeNumber(entry)
			if !whole || value < 0 || value >= limit {
				check.fail(fmt.Sprintf("%s.%s[%d]", path, key, index),
					"outside a board %d by %d", check.width, check.height)
			}
		}
	case "squares":
		list, ok := check.list(node[key])
		if !ok {
			check.fail(path, "squares is a list of [x, y]")
			return
		}
		if len(list) > check.width*check.height {
			check.fail(path, "too many squares")
		}
		for index, entry := range list {
			square, ok := check.list(entry)
			onBoard := false
			if ok && len(square) == 2 {
				x, xWhole := wholeNumber(square[0])
				y, yWhole := wholeNumber(square[1])
				onBoard = xWhole && yWhole && x >= 0 && x < check.width && y >= 0 && y < check.height
			}
			if !onBoard {
				check.fail(fmt.Sprintf("%s.squares[%d]", path, index),
					"not a square on a %d by %d board", check.width, check.height)
			}
		}
	case "rect":
		rect, ok := check.node(node[key], path)
		whole := ok
		for _, field := range []string{"x", "y", "width", "height"} {
			if !ok {
				break
			}
			if _, isWhole := wholeNumber(rect[field]); !isWhole {
				whole = false
			}
		}
		if !whole {
			check.fail(path, "rect is { x, y, width, height } in whole numbers")
		}
	case "home":
		home, _ := node[key].(string)
		if !contains(homeRefs, home) {
			check.fail(path+".home", "one of %s", strings.Join(homeRefs, ", "))
		}
	default:
		// corners, edge, all, destination, origin: flags, and only true.
		if node[key] != true {
			check.fail(path+"."+key, "only true")
		}
	}
}

/* ------------------------------------------------------------------ filters -- */

func (check *validator) filter(value any, path string) {
	node, ok := check.node(value, path)
	if !ok {
		check.fail(path, "a tile filter is an object")
		return
	}
	if region, present := node["region"]; present {
		check.region(region, path+".region")
	}
	for _, field := range []string{"owner", "territory"} {
		if side, present := node[field]; present {
			name, _ := side.(string)
			if !contains(sideRefs, name) {
				check.fail(path+"."+field, "one of %s", strings.Join(sideRefs, ", "))
			}
		}
	}
	if piece, present := node["piece"]; present {
		check.pieceRefs(piece, path+".piece")
	}
	if empty, present := node["empty"]; present {
		if _, isBool := empty.(bool); !isBool {
			check.fail(path+".empty", "true or false")
		}
	}
}

// pieceRefs reads a `piece` field, which is one kind or several.
func (check *validator) pieceRefs(value any, path string) []string {
	names := []string{}
	switch typed := value.(type) {
	case string:
		names = append(names, typed)
	case []any:
		for _, entry := range typed {
			name, _ := entry.(string)
			names = append(names, name)
		}
	default:
		check.fail(path, "a piece name or a list of them")
		return nil
	}
	for _, name := range names {
		if _, known := check.kinds[name]; !known {
			check.fail(path, "%q is not a declared piece", name)
		}
	}
	return names
}

/* -------------------------------------------------------------------- terms -- */

func (check *validator) term(value any, path string, depth int) {
	if depth > MaxDepth {
		check.fail(path, "nested deeper than %d", MaxDepth)
		return
	}
	if _, isNumber := value.(float64); isNumber {
		return
	}
	node, ok := check.node(value, path)
	if !ok {
		check.fail(path, "a term is a number or an object")
		return
	}
	key, sole := soleKey(node, termKinds)
	if !sole {
		check.fail(path, "a term names exactly one kind")
		return
	}
	switch key {
	case "count":
		check.filter(node[key], path+".count")
	case "row", "column":
		which, _ := node[key].(string)
		if !contains(fromTo, which) {
			check.fail(path+"."+key, "from or to")
		}
	case "moveNumber":
		if node[key] != true {
			check.fail(path+".moveNumber", "only true")
		}
	case "share":
		side, _ := node[key].(string)
		if !contains(sideRefs, side) {
			check.fail(path+".share", "one of %s", strings.Join(sideRefs, ", "))
		}
	}
}

/* --------------------------------------------------------------- predicates -- */

func (check *validator) predicate(value any, path string, depth int) {
	if depth > MaxDepth {
		check.fail(path, "nested deeper than %d", MaxDepth)
		return
	}
	if _, isBool := value.(bool); isBool {
		return
	}
	node, ok := check.node(value, path)
	if !ok {
		check.fail(path, "a condition is true, false, or an object")
		return
	}
	allowed := append([]string{"and", "or", "not"}, comparisons...)
	allowed = append(allowed, "in", "captured", "moved", "any", "all")
	key, sole := soleKey(node, allowed)
	if !sole {
		check.fail(path, "a condition names exactly one kind")
		return
	}
	switch {
	case key == "and" || key == "or":
		list, ok := check.list(node[key])
		if !ok || len(list) == 0 {
			check.fail(path+"."+key, "a non-empty list")
			return
		}
		for index, entry := range list {
			check.predicate(entry, fmt.Sprintf("%s.%s[%d]", path, key, index), depth+1)
		}
	case key == "not":
		check.predicate(node[key], path+".not", depth+1)
	case contains(comparisons, key):
		pair, ok := check.list(node[key])
		if !ok || len(pair) != 2 {
			check.fail(path+"."+key, "a pair of terms")
			return
		}
		check.term(pair[0], fmt.Sprintf("%s.%s[0]", path, key), depth+1)
		check.term(pair[1], fmt.Sprintf("%s.%s[1]", path, key), depth+1)
	case key == "in":
		pair, ok := check.list(node[key])
		if !ok || len(pair) != 2 {
			check.fail(path+".in", "[from|to, region]")
			return
		}
		which, _ := pair[0].(string)
		if !contains(fromTo, which) {
			check.fail(path+".in[0]", "from or to")
		}
		check.region(pair[1], path+".in[1]")
	case key == "captured":
		if node[key] != true {
			check.fail(path+".captured", "only true; wrap it in `not` for the other case")
		}
	case key == "moved":
		check.pieceRefs(node[key], path+".moved")
	case key == "any" || key == "all":
		quantifier, ok := check.node(node[key], path)
		if !ok {
			check.fail(path+"."+key, "{ tiles, where }")
			return
		}
		check.filter(quantifier["tiles"], path+"."+key+".tiles")
		if where, present := quantifier["where"]; present {
			check.predicate(where, path+"."+key+".where", depth+1)
		}
	}
}

/* ----------------------------------------------------------------- movement -- */

func (check *validator) directions(value any, path string) {
	if name, isString := value.(string); isString {
		if !contains(directionNames, name) {
			check.fail(path, "unknown direction set %q", name)
		}
		return
	}
	node, ok := check.node(value, path)
	if !ok {
		check.fail(path, "a direction name or { offsets: [[dx, dy], ...] }")
		return
	}
	offsets, ok := check.list(node["offsets"])
	if !ok {
		check.fail(path, "a direction name or { offsets: [[dx, dy], ...] }")
		return
	}
	if len(offsets) == 0 {
		check.fail(path, "offsets cannot be empty")
	}
	if len(offsets) > MaxOffsets {
		check.fail(path, "at most %d offsets", MaxOffsets)
	}
	for index, entry := range offsets {
		offsetPath := fmt.Sprintf("%s.offsets[%d]", path, index)
		pair, ok := check.list(entry)
		if !ok || len(pair) != 2 {
			check.fail(offsetPath, "a pair of whole numbers")
			continue
		}
		dx, dxWhole := wholeNumber(pair[0])
		dy, dyWhole := wholeNumber(pair[1])
		if !dxWhole || !dyWhole {
			check.fail(offsetPath, "a pair of whole numbers")
			continue
		}
		if dx == 0 && dy == 0 {
			check.fail(offsetPath, "a piece cannot move to the square it is on")
		}
		if abs(dx) >= maxSide || abs(dy) >= maxSide {
			check.fail(offsetPath, "longer than any board")
		}
	}
}

func (check *validator) movement() {
	if len(check.spec.Movement) == 0 {
		check.fail("movement", "at least one movement rule, or nothing can move")
		return
	}
	if len(check.spec.Movement) > MaxMovement {
		check.fail("movement", "at most %d rules", MaxMovement)
		return
	}
	covered := map[string]bool{}
	for index, rule := range check.spec.Movement {
		path := fmt.Sprintf("movement[%d]", index)
		kind, _ := rule["kind"].(string)
		if !contains(movementKinds, kind) {
			check.fail(path+".kind", "one of %s", strings.Join(movementKinds, ", "))
		}
		check.directions(rule["dirs"], path+".dirs")
		for _, field := range []string{"distance", "maxDistance"} {
			if value, present := rule[field]; present {
				number, whole := wholeNumber(value)
				if !whole || number < 1 {
					check.fail(path+"."+field, "a whole number of at least 1")
				}
			}
		}
		if targets, present := rule["targets"]; present {
			name, _ := targets.(string)
			if !contains(moveTargets, name) {
				check.fail(path+".targets", "one of %s", strings.Join(moveTargets, ", "))
			}
		}
		if mustCapture, present := rule["mustCapture"]; present {
			if _, isBool := mustCapture.(bool); !isBool {
				check.fail(path+".mustCapture", "true or false")
			}
		}
		if when, present := rule["when"]; present {
			check.predicate(when, path+".when", 1)
		}
		if piece, present := rule["piece"]; present {
			for _, name := range check.pieceRefs(piece, path+".piece") {
				covered[name] = true
			}
		} else {
			for kind := range check.kinds {
				covered[kind] = true
			}
		}
	}
	idle := make([]string, 0, len(check.kinds))
	for kind := range check.kinds {
		if !covered[kind] {
			idle = append(idle, kind)
		}
	}
	sort.Strings(idle)
	for _, kind := range idle {
		check.warn("movement", "no rule lets %q move, so it can only ever sit still", kind)
	}
}

/* ------------------------------------------------------------------ effects -- */

func (check *validator) effects() {
	if len(check.spec.Effects) > MaxEffects {
		check.fail("effects", "at most %d rules", MaxEffects)
		return
	}
	for index, rule := range check.spec.Effects {
		path := fmt.Sprintf("effects[%d]", index)
		on, _ := rule["on"].(string)
		if !contains(effectTriggers, on) {
			check.fail(path+".on", "one of %s", strings.Join(effectTriggers, ", "))
		}
		if when, present := rule["when"]; present {
			check.predicate(when, path+".when", 1)
		}
		actions, ok := check.list(rule["do"])
		if !ok || len(actions) == 0 {
			check.fail(path+".do", "at least one effect")
			continue
		}
		for position, action := range actions {
			check.effect(action, fmt.Sprintf("%s.do[%d]", path, position))
		}
	}
}

func (check *validator) effect(value any, path string) {
	node, ok := check.node(value, path)
	if !ok {
		check.fail(path, "an effect is an object")
		return
	}
	key, sole := soleKey(node, effectKinds)
	if !sole {
		check.fail(path, "an effect names exactly one kind")
		return
	}
	switch key {
	case "claimTerritory":
		side, _ := node[key].(string)
		if !contains(sideRefs, side) {
			check.fail(path+".claimTerritory", "one of %s", strings.Join(sideRefs, ", "))
		}
	case "setTerritory":
		set, ok := check.node(node[key], path)
		if !ok {
			check.fail(path, "setTerritory is { tiles, to }")
			return
		}
		check.filter(set["tiles"], path+".setTerritory.tiles")
		to, _ := set["to"].(string)
		if !contains(sideRefs, to) {
			check.fail(path+".setTerritory.to", "one of %s", strings.Join(sideRefs, ", "))
		}
	case "promote":
		promote, ok := check.node(node[key], path)
		if !ok {
			check.fail(path, "promote is { to }")
			return
		}
		to, _ := promote["to"].(string)
		if _, known := check.kinds[to]; !known {
			check.fail(path+".promote.to", "%q is not a declared piece", to)
		}
	case "remove":
		remove, ok := check.node(node[key], path)
		if !ok {
			check.fail(path, "remove is { tiles }")
			return
		}
		check.filter(remove["tiles"], path+".remove.tiles")
	case "spawn":
		spawn, ok := check.node(node[key], path)
		if !ok {
			check.fail(path, "spawn is { piece, owner, at }")
			return
		}
		piece, _ := spawn["piece"].(string)
		if _, known := check.kinds[piece]; !known {
			check.fail(path+".spawn.piece", "%q is not a declared piece", piece)
		}
		owner, _ := spawn["owner"].(string)
		if !contains(sideRefs, owner) {
			check.fail(path+".spawn.owner", "one of %s", strings.Join(sideRefs, ", "))
		}
		check.region(spawn["at"], path+".spawn.at")
	case "extraTurn":
		if node[key] != true {
			check.fail(path+".extraTurn", "only true")
		}
	}
}

/* ----------------------------------------------------------------- win/draw -- */

func (check *validator) winAndDraw() {
	if len(check.spec.Win) > MaxWin {
		check.fail("win", "at most %d conditions", MaxWin)
		return
	}
	if len(check.spec.Win) == 0 {
		// Legal, and worth saying out loud. Infiltration has no annihilation rule
		// and leans on the engine's stalemate draw, so a mode with no win
		// condition at all is a mode that can only be drawn or resigned.
		check.warn("win", "no win condition, so this mode can only end in a draw or a resignation")
	}
	for index, condition := range check.spec.Win {
		path := fmt.Sprintf("win[%d]", index)
		when, present := condition["when"]
		if !present {
			check.fail(path+".when", "required")
		} else {
			check.predicate(when, path+".when", 1)
		}
		check.winResult(condition["result"], path+".result")
		if reason, present := condition["reason"]; present {
			name, _ := reason.(string)
			if !reasonPattern.MatchString(name) {
				check.fail(path+".reason", "lower-case letters, digits and underscores")
			}
		}
	}
	check.draw()
}

func (check *validator) winResult(value any, path string) {
	if name, isString := value.(string); isString {
		if !contains(winResults, name) {
			check.fail(path, "one of mover, opponent, draw, or { moreOf }")
		}
		return
	}
	node, ok := check.node(value, path)
	if !ok {
		check.fail(path, "one of mover, opponent, draw, or { moreOf: { red, blue } }")
		return
	}
	moreOf, ok := check.node(node["moreOf"], path)
	if !ok {
		check.fail(path, "one of mover, opponent, draw, or { moreOf: { red, blue } }")
		return
	}
	check.term(moreOf["red"], path+".moreOf.red", 1)
	check.term(moreOf["blue"], path+".moreOf.blue", 1)
}

func (check *validator) draw() {
	if check.spec.Draw == nil {
		return
	}
	if check.spec.Draw.MoveLimit != nil && *check.spec.Draw.MoveLimit < 1 {
		check.fail("draw.moveLimit", "null, or a whole number of at least 1")
	}
	// A spec naming repetition or stalemate is refused by DisallowUnknownFields
	// on the way in, which is the right answer: an author who tried to switch off
	// a rule they cannot switch off should be told rather than left believing
	// they did.
}

func abs(value int) int {
	if value < 0 {
		return -value
	}
	return value
}
