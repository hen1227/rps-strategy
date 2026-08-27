package server

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"

	"rps-strategy/backend/internal/game"
	"rps-strategy/backend/internal/persistence"
)

const (
	// The nested, download-whole shape. Still accepted so an older export can
	// be imported, but the graph is what the website is served from.
	openingBookFormat = "rps-opening-book/v1"
	// The flat position graph: every position once, moves naming children by
	// key. See `WEB_GRAPH_FORMAT` in RPSFish's `book.rs`.
	openingGraphFormat      = "rps-opening-book/v2"
	openingBookRequestLimit = 64 << 20
	maximumOpeningPositions = 100_000
	// A line the website can ask about. The export's own ply bound is well
	// under this; the cap is here so a hand-made request cannot make the server
	// walk an unbounded number of lookups.
	maximumOpeningLine = 128
)

// openingGraphImport is the flat payload the engine publishes.
type openingGraphImport struct {
	Format        string                `json:"format"`
	ModeID        string                `json:"modeId"`
	ModeName      string                `json:"modeName"`
	EngineVersion string                `json:"engineVersion"`
	RulesVersion  int                   `json:"rulesVersion"`
	Weights       string                `json:"weights"`
	Symmetry      string                `json:"symmetry"`
	MaxPly        int                   `json:"maxPly"`
	RootKey       string                `json:"rootKey"`
	PositionCount int                   `json:"positionCount"`
	MainLine      []string              `json:"mainLine"`
	Featured      [][]string            `json:"featured"`
	Positions     []openingGraphPositon `json:"positions"`
}

type openingGraphPositon struct {
	Key            string             `json:"key"`
	Turn           string             `json:"turn"`
	Score          int                `json:"score"`
	Depth          int                `json:"depth"`
	SelectiveDepth int                `json:"selectiveDepth"`
	Nodes          uint64             `json:"nodes"`
	Moves          []openingGraphMove `json:"moves"`
}

type openingGraphMove struct {
	Move     string  `json:"move"`
	Score    int     `json:"score"`
	Rank     int     `json:"rank"`
	Searched bool    `json:"searched"`
	MainLine bool    `json:"mainLine"`
	Child    *string `json:"child"`
}

type openingBookImport struct {
	Format        string       `json:"format"`
	ModeID        string       `json:"modeId"`
	ModeName      string       `json:"modeName"`
	EngineVersion string       `json:"engineVersion"`
	RulesVersion  int          `json:"rulesVersion"`
	Weights       string       `json:"weights"`
	Symmetry      string       `json:"symmetry"`
	MaxPly        int          `json:"maxPly"`
	Width         int          `json:"width"`
	PositionCount int          `json:"positionCount"`
	MainLine      []string     `json:"mainLine"`
	Root          *openingNode `json:"root"`
}

type openingNode struct {
	Turn           game.PlayerColor `json:"turn"`
	Score          int              `json:"score"`
	Depth          int              `json:"depth"`
	SelectiveDepth int              `json:"selectiveDepth"`
	Nodes          uint64           `json:"nodes"`
	Moves          []openingMove    `json:"moves"`
}

type openingMove struct {
	Move       string       `json:"move"`
	Score      int          `json:"score"`
	Rank       int          `json:"rank"`
	Searched   bool         `json:"searched"`
	MainLine   bool         `json:"mainLine"`
	Repetition bool         `json:"repetition"`
	Child      *openingNode `json:"child"`
}

type openingNameRequest struct {
	Line []string `json:"line"`
	Name string   `json:"name"`
}

func (server *Server) openingMode(writer http.ResponseWriter, request *http.Request) (game.ModeID, bool) {
	modeID := game.ModeID(strings.TrimSpace(request.PathValue("modeID")))
	if _, err := server.registry.New(modeID); err != nil {
		writeAPIError(writer, http.StatusNotFound, "unknown game mode")
		return "", false
	}
	return modeID, true
}

// openingBootstrap is what a visitor gets on arrival: enough to render the
// screen and to click through the recommended openings without another request,
// and nothing else. Everything past that is fetched a position at a time.
type openingBootstrap struct {
	persistence.OpeningGraphMeta
	Names []persistence.OpeningName `json:"names"`
	// Every name anybody has put forward and nobody has published yet. Public
	// on purpose: a line with no name should show what people have called it,
	// not an empty box that gives no sign the question was ever asked.
	Suggestions []persistence.OpeningNameSuggestion `json:"suggestions"`
	// Whether this mode's lines have mirror twins that share their names, which
	// the screen needs in order to look a name up at all. See opening_mirror.go.
	MirrorNaming bool                        `json:"mirrorNaming"`
	Root         persistence.OpeningPosition `json:"root"`
	// Every position along every featured line, so the openings worth
	// recommending are instant and the rest of the book stays lazy.
	FeaturedPositions []persistence.OpeningPosition `json:"featuredPositions"`
}

// openingNodeResponse is one position, resolved from the line that reached it.
type openingNodeResponse struct {
	Line []string                    `json:"line"`
	Node persistence.OpeningPosition `json:"node"`
}

func (server *Server) getOpeningBook(writer http.ResponseWriter, request *http.Request) {
	modeID, ok := server.openingMode(writer, request)
	if !ok {
		return
	}
	meta, err := server.data.OpeningGraph(request.Context(), string(modeID))
	if err != nil {
		writeOpeningBookError(writer, err)
		return
	}
	names, err := server.data.OpeningNames(request.Context(), string(modeID))
	if err != nil {
		writeOpeningBookError(writer, err)
		return
	}
	suggestions, err := server.data.OpeningNameSuggestions(request.Context(), string(modeID))
	if err != nil {
		writeOpeningBookError(writer, err)
		return
	}
	root, err := server.data.OpeningPositionAt(request.Context(), string(modeID), meta.RootKey)
	if err != nil {
		writeOpeningBookError(writer, err)
		return
	}

	// Featured lines overlap heavily -- they share a root and often each
	// other's first plies -- so this is deduplicated by key, not by line.
	seen := map[string]struct{}{meta.RootKey: {}}
	featured := make([]persistence.OpeningPosition, 0, len(meta.Featured)*8)
	for _, line := range meta.Featured {
		path, err := server.data.ResolveOpeningLine(
			request.Context(), string(modeID), meta.RootKey, line,
		)
		if err != nil {
			// A featured line that no longer resolves is not worth failing the
			// whole screen over. The rest of the book is still good.
			continue
		}
		for _, key := range path {
			if _, already := seen[key]; already {
				continue
			}
			seen[key] = struct{}{}
			position, err := server.data.OpeningPositionAt(request.Context(), string(modeID), key)
			if err != nil {
				continue
			}
			featured = append(featured, position)
		}
	}

	writeJSON(writer, http.StatusOK, openingBootstrap{
		OpeningGraphMeta:  meta,
		Names:             names,
		Suggestions:       suggestions,
		MirrorNaming:      server.openingBoardFor(modeID).mirrors,
		Root:              root,
		FeaturedPositions: featured,
	})
}

// openingNamesResponse is the naming layer on its own: what lines are called
// and whether mirror twins share a name, and not one board.
//
// The bootstrap above answers the same question, and carries a book's worth of
// positions with it. The live game screen wants only to look up what the game
// it is showing is called, and it wants that for every game -- so it gets the
// few kilobytes it can actually use.
type openingNamesResponse struct {
	ModeID       string                    `json:"modeId"`
	Names        []persistence.OpeningName `json:"names"`
	MirrorNaming bool                      `json:"mirrorNaming"`
}

func (server *Server) getOpeningNames(writer http.ResponseWriter, request *http.Request) {
	modeID, ok := server.openingMode(writer, request)
	if !ok {
		return
	}
	names, err := server.data.OpeningNames(request.Context(), string(modeID))
	if err != nil {
		writeOpeningBookError(writer, err)
		return
	}
	// Deliberately not gated on a published book. Names outlive scans -- a
	// rebuilt book keeps them -- and a mode whose scan is still in preparation
	// should still be able to say what its openings are called.
	writeJSON(writer, http.StatusOK, openingNamesResponse{
		ModeID:       string(modeID),
		Names:        names,
		MirrorNaming: server.openingBoardFor(modeID).mirrors,
	})
}

// getOpeningNode answers "what does the book say here", for one line.
func (server *Server) getOpeningNode(writer http.ResponseWriter, request *http.Request) {
	modeID, ok := server.openingMode(writer, request)
	if !ok {
		return
	}
	line, err := parseOpeningLineQuery(request.URL.Query().Get("line"))
	if err != nil {
		writeAPIError(writer, http.StatusBadRequest, err.Error())
		return
	}
	meta, err := server.data.OpeningGraph(request.Context(), string(modeID))
	if err != nil {
		writeOpeningBookError(writer, err)
		return
	}
	path, err := server.data.ResolveOpeningLine(
		request.Context(), string(modeID), meta.RootKey, line,
	)
	if err != nil {
		writeOpeningBookError(writer, err)
		return
	}
	node, err := server.data.OpeningPositionAt(
		request.Context(), string(modeID), path[len(path)-1],
	)
	if err != nil {
		writeOpeningBookError(writer, err)
		return
	}
	markOpeningRepetitions(&node, path)
	writeJSON(writer, http.StatusOK, openingNodeResponse{Line: line, Node: node})
}

// markOpeningRepetitions flags moves that walk back into this line.
//
// The graph has cycles because pieces walk back over their own tracks, and the
// stored book cannot say which of those is a repetition: that depends entirely
// on how the position was reached. `path` is how it was reached, so this is the
// only place the answer exists.
func markOpeningRepetitions(node *persistence.OpeningPosition, path []string) {
	visited := make(map[string]struct{}, len(path))
	for _, key := range path {
		visited[key] = struct{}{}
	}
	for index := range node.Moves {
		move := &node.Moves[index]
		if move.Child == "" {
			continue
		}
		if _, seen := visited[move.Child]; seen {
			move.Repetition = true
		}
	}
}

// parseOpeningLineQuery reads a line from the query string. Comma or space, so
// a line reads in a URL much as it does in the archive's own notation.
func parseOpeningLineQuery(raw string) ([]string, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return []string{}, nil
	}
	line := strings.FieldsFunc(raw, func(r rune) bool { return r == ',' || r == ' ' })
	if len(line) > maximumOpeningLine {
		return nil, fmt.Errorf("a line may be at most %d moves", maximumOpeningLine)
	}
	for index, move := range line {
		if !validOpeningMove(move) {
			return nil, fmt.Errorf("line move %d is not notation like d7-d6", index+1)
		}
	}
	return line, nil
}

func (server *Server) importOpeningBook(writer http.ResponseWriter, request *http.Request) {
	modeID, ok := server.openingMode(writer, request)
	if !ok {
		return
	}
	raw, err := readOpeningBookBody(writer, request)
	if err != nil {
		writeAPIError(writer, http.StatusBadRequest, err.Error())
		return
	}
	graph, err := decodeOpeningGraph(raw)
	if err != nil {
		writeAPIError(writer, http.StatusBadRequest, err.Error())
		return
	}
	if graph.ModeID != string(modeID) {
		writeAPIError(writer, http.StatusBadRequest, "book modeId does not match the import URL")
		return
	}
	if err := validateOpeningGraph(graph); err != nil {
		writeAPIError(writer, http.StatusBadRequest, err.Error())
		return
	}
	meta, positions := openingGraphRecords(graph)
	stored, err := server.data.ReplaceOpeningGraph(request.Context(), meta, positions)
	if err != nil {
		writeOpeningBookError(writer, err)
		return
	}
	writeJSON(writer, http.StatusOK, stored)
}

func readOpeningBookBody(writer http.ResponseWriter, request *http.Request) ([]byte, error) {
	request.Body = http.MaxBytesReader(writer, request.Body, openingBookRequestLimit)
	raw, err := io.ReadAll(request.Body)
	if err != nil {
		return nil, fmt.Errorf("read opening book: %w", err)
	}
	if len(raw) == 0 {
		return nil, errors.New("opening book JSON is required")
	}
	return raw, nil
}

// decodeOpeningGraph accepts the flat graph, and converts a v1 tree into one so
// an older export still imports. Nesting is what makes the tree a bad serving
// format, not a bad archive.
func decodeOpeningGraph(raw []byte) (openingGraphImport, error) {
	var probe struct {
		Format string `json:"format"`
	}
	if err := json.Unmarshal(raw, &probe); err != nil {
		return openingGraphImport{}, fmt.Errorf("invalid opening book JSON: %w", err)
	}
	switch probe.Format {
	case openingGraphFormat:
		var graph openingGraphImport
		decoder := json.NewDecoder(strings.NewReader(string(raw)))
		if err := decoder.Decode(&graph); err != nil {
			return openingGraphImport{}, fmt.Errorf("invalid opening book JSON: %w", err)
		}
		if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
			return openingGraphImport{}, errors.New(
				"invalid opening book JSON: only one object is allowed",
			)
		}
		return graph, nil
	case openingBookFormat:
		var tree openingBookImport
		if err := json.Unmarshal(raw, &tree); err != nil {
			return openingGraphImport{}, fmt.Errorf("invalid opening book JSON: %w", err)
		}
		if err := validateOpeningBook(tree); err != nil {
			return openingGraphImport{}, err
		}
		return flattenOpeningTree(tree), nil
	default:
		return openingGraphImport{}, fmt.Errorf(
			"format must be %q or %q", openingGraphFormat, openingBookFormat,
		)
	}
}

// flattenOpeningTree keys a v1 tree by line, which is the only identity a
// nested export carries: it duplicates transposed positions, so there is
// nothing better to key on. A graph export keys on the position itself.
func flattenOpeningTree(tree openingBookImport) openingGraphImport {
	graph := openingGraphImport{
		Format:        openingGraphFormat,
		ModeID:        tree.ModeID,
		ModeName:      tree.ModeName,
		EngineVersion: tree.EngineVersion,
		RulesVersion:  tree.RulesVersion,
		Weights:       tree.Weights,
		Symmetry:      tree.Symmetry,
		MaxPly:        tree.MaxPly,
		RootKey:       "root",
		MainLine:      tree.MainLine,
		Featured:      [][]string{},
	}
	var walk func(node *openingNode, key string)
	walk = func(node *openingNode, key string) {
		flat := openingGraphPositon{
			Key: key, Turn: string(node.Turn), Score: node.Score, Depth: node.Depth,
			SelectiveDepth: node.SelectiveDepth, Nodes: node.Nodes,
			Moves: make([]openingGraphMove, 0, len(node.Moves)),
		}
		for index := range node.Moves {
			move := &node.Moves[index]
			flat.Moves = append(flat.Moves, openingGraphMove{
				Move: move.Move, Score: move.Score, Rank: move.Rank,
				Searched: move.Searched, MainLine: move.MainLine,
				Child: childKeyFor(key, move),
			})
		}
		graph.Positions = append(graph.Positions, flat)
		for index := range node.Moves {
			if move := &node.Moves[index]; move.Child != nil {
				walk(move.Child, key+" "+move.Move)
			}
		}
	}
	walk(tree.Root, "root")
	graph.PositionCount = len(graph.Positions)
	return graph
}

func childKeyFor(key string, move *openingMove) *string {
	if move.Child == nil {
		return nil
	}
	child := key + " " + move.Move
	return &child
}

func openingGraphRecords(
	graph openingGraphImport,
) (persistence.OpeningGraphMeta, []persistence.OpeningPosition) {
	meta := persistence.OpeningGraphMeta{
		ModeID: graph.ModeID, ModeName: graph.ModeName,
		EngineVersion: graph.EngineVersion, RulesVersion: graph.RulesVersion,
		Weights: graph.Weights, Symmetry: graph.Symmetry, MaxPly: graph.MaxPly,
		RootKey: graph.RootKey, MainLine: graph.MainLine, Featured: graph.Featured,
	}
	positions := make([]persistence.OpeningPosition, 0, len(graph.Positions))
	for _, source := range graph.Positions {
		position := persistence.OpeningPosition{
			Key: source.Key, Turn: source.Turn, Score: source.Score,
			Depth: source.Depth, SelectiveDepth: source.SelectiveDepth,
			Nodes: source.Nodes,
			Moves: make([]persistence.OpeningMove, 0, len(source.Moves)),
		}
		for _, move := range source.Moves {
			child := ""
			if move.Child != nil {
				child = *move.Child
			}
			position.Moves = append(position.Moves, persistence.OpeningMove{
				Move: move.Move, Score: move.Score, Rank: move.Rank,
				Searched: move.Searched, MainLine: move.MainLine, Child: child,
			})
		}
		positions = append(positions, position)
	}
	return meta, positions
}

// validateOpeningGraph checks what the storage layer cannot: that the graph is
// closed. A move naming a child the payload never wrote would become a line the
// website can start walking and cannot finish.
func validateOpeningGraph(graph openingGraphImport) error {
	switch {
	case strings.TrimSpace(graph.ModeID) == "":
		return errors.New("modeId is required")
	case strings.TrimSpace(graph.ModeName) == "":
		return errors.New("modeName is required")
	case strings.TrimSpace(graph.EngineVersion) == "":
		return errors.New("engineVersion is required")
	case graph.RulesVersion <= 0:
		return errors.New("rulesVersion must be positive")
	case graph.MaxPly < 0 || graph.MaxPly > 512:
		return errors.New("maxPly must be between 0 and 512")
	case strings.TrimSpace(graph.RootKey) == "":
		return errors.New("rootKey is required")
	case len(graph.Positions) < 1 || len(graph.Positions) > maximumOpeningPositions:
		return fmt.Errorf("a book must hold between 1 and %d positions", maximumOpeningPositions)
	case graph.PositionCount != len(graph.Positions):
		return fmt.Errorf(
			"positionCount says %d, payload holds %d", graph.PositionCount, len(graph.Positions),
		)
	}

	keys := make(map[string]struct{}, len(graph.Positions))
	for index := range graph.Positions {
		position := &graph.Positions[index]
		if strings.TrimSpace(position.Key) == "" {
			return fmt.Errorf("position %d has no key", index+1)
		}
		if _, repeated := keys[position.Key]; repeated {
			return fmt.Errorf("position key %s appears twice", position.Key)
		}
		keys[position.Key] = struct{}{}
	}
	if _, ok := keys[graph.RootKey]; !ok {
		return fmt.Errorf("rootKey %s is not one of the positions", graph.RootKey)
	}

	for index := range graph.Positions {
		position := &graph.Positions[index]
		if position.Turn != string(game.Red) && position.Turn != string(game.Blue) {
			return fmt.Errorf("position %s has invalid side to move", position.Key)
		}
		if position.Depth < 0 || position.Depth > 127 ||
			position.SelectiveDepth < 0 || position.SelectiveDepth > 127 {
			return fmt.Errorf("position %s has invalid search depth", position.Key)
		}
		seen := make(map[string]struct{}, len(position.Moves))
		mainMoves := 0
		for moveIndex := range position.Moves {
			move := &position.Moves[moveIndex]
			if !validOpeningMove(move.Move) {
				return fmt.Errorf(
					"position %s move %d is not notation like d7-d6", position.Key, moveIndex+1,
				)
			}
			if _, repeated := seen[move.Move]; repeated {
				return fmt.Errorf("position %s repeats move %s", position.Key, move.Move)
			}
			seen[move.Move] = struct{}{}
			if move.Rank != moveIndex+1 {
				return fmt.Errorf(
					"position %s move %s has rank %d, expected %d",
					position.Key, move.Move, move.Rank, moveIndex+1,
				)
			}
			if move.MainLine {
				mainMoves++
			}
			if move.Child == nil {
				continue
			}
			if !move.Searched {
				return fmt.Errorf(
					"position %s move %s names a child but is not marked searched",
					position.Key, move.Move,
				)
			}
			if _, ok := keys[*move.Child]; !ok {
				return fmt.Errorf(
					"position %s move %s names child %s, which is not in the payload",
					position.Key, move.Move, *move.Child,
				)
			}
		}
		if mainMoves > 1 {
			return fmt.Errorf("position %s marks more than one main-line move", position.Key)
		}
	}

	for index, line := range append([][]string{graph.MainLine}, graph.Featured...) {
		for moveIndex, move := range line {
			if !validOpeningMove(move) {
				return fmt.Errorf(
					"line %d move %d is not notation like d7-d6", index+1, moveIndex+1,
				)
			}
		}
	}
	return nil
}

func validateOpeningBook(book openingBookImport) error {
	switch {
	case book.Format != openingBookFormat:
		return fmt.Errorf("format must be %q", openingBookFormat)
	case strings.TrimSpace(book.ModeID) == "":
		return errors.New("modeId is required")
	case strings.TrimSpace(book.ModeName) == "":
		return errors.New("modeName is required")
	case strings.TrimSpace(book.EngineVersion) == "":
		return errors.New("engineVersion is required")
	case book.RulesVersion <= 0:
		return errors.New("rulesVersion must be positive")
	case book.MaxPly < 0 || book.MaxPly > 128:
		return errors.New("maxPly must be between 0 and 128")
	case book.Width < 1 || book.Width > 64:
		return errors.New("width must be between 1 and 64")
	case book.PositionCount < 1 || book.PositionCount > maximumOpeningPositions:
		return fmt.Errorf("positionCount must be between 1 and %d", maximumOpeningPositions)
	case book.Root == nil:
		return errors.New("root position is required")
	}
	for index, move := range book.MainLine {
		if !validOpeningMove(move) {
			return fmt.Errorf("mainLine move %d is not notation like d7-d6", index+1)
		}
	}
	count := 0
	if err := validateOpeningNode(book.Root, 0, book.MaxPly, book.Width, &count); err != nil {
		return err
	}
	if count != book.PositionCount {
		return fmt.Errorf("positionCount says %d, tree contains %d", book.PositionCount, count)
	}
	return nil
}

func validateOpeningNode(node *openingNode, ply, maxPly, width int, count *int) error {
	*count = *count + 1
	positionNumber := *count
	if *count > maximumOpeningPositions {
		return fmt.Errorf("opening tree exceeds %d positions", maximumOpeningPositions)
	}
	if node.Turn != game.Red && node.Turn != game.Blue {
		return fmt.Errorf("position %d has invalid side to move", positionNumber)
	}
	if node.Depth < 0 || node.Depth > 127 || node.SelectiveDepth < 0 || node.SelectiveDepth > 127 {
		return fmt.Errorf("position %d has invalid search depth", positionNumber)
	}
	if len(node.Moves) > width {
		return fmt.Errorf("position %d has %d moves, wider than export width %d", positionNumber, len(node.Moves), width)
	}
	seen := make(map[string]struct{}, len(node.Moves))
	mainMoves := 0
	for index := range node.Moves {
		move := &node.Moves[index]
		if !validOpeningMove(move.Move) {
			return fmt.Errorf("position %d move %d is not notation like d7-d6", positionNumber, index+1)
		}
		if _, exists := seen[move.Move]; exists {
			return fmt.Errorf("position %d repeats move %s", positionNumber, move.Move)
		}
		seen[move.Move] = struct{}{}
		if move.Rank != index+1 {
			return fmt.Errorf("position %d move %s has rank %d, expected %d", positionNumber, move.Move, move.Rank, index+1)
		}
		if move.MainLine {
			mainMoves++
		}
		if move.Child != nil {
			if !move.Searched || move.Repetition {
				return fmt.Errorf("position %d move %s has an inconsistent child", positionNumber, move.Move)
			}
			if ply >= maxPly {
				return fmt.Errorf("position %d expands beyond maxPly %d", positionNumber, maxPly)
			}
			if err := validateOpeningNode(move.Child, ply+1, maxPly, width, count); err != nil {
				return err
			}
		}
	}
	if mainMoves > 1 {
		return fmt.Errorf("position %d marks more than one main-line move", positionNumber)
	}
	return nil
}

// validOpeningMove accepts the book's own notation, which is nine by nine:
// `d8-c7`, five characters, files a to i and ranks 1 to 9.
//
// That is not an oversight now that a mode may be any rectangle. An opening book
// is an engine artifact and RPSFish only searches the built-in modes, so a mode
// the notation cannot spell is a mode with no book — see openingBoardFor, which
// switches the mirror rule off for exactly those modes.
func validOpeningMove(move string) bool {
	return len(move) == 5 && move[2] == '-' &&
		move[0] >= 'a' && move[0] <= 'i' && move[1] >= '1' && move[1] <= '9' &&
		move[3] >= 'a' && move[3] <= 'i' && move[4] >= '1' && move[4] <= '9' &&
		move[:2] != move[3:]
}

// openingBookForLine checks that a line is one the book actually has.
//
// This used to unmarshal the whole stored document on every name suggestion.
// Against the graph it is a walk of a few indexed lookups -- the same
// resolution the browse route does.
func (server *Server) openingBookForLine(
	writer http.ResponseWriter,
	request *http.Request,
	modeID game.ModeID,
	line []string,
) bool {
	if len(line) == 0 || len(line) > maximumOpeningLine {
		writeAPIError(writer, http.StatusBadRequest, "choose a line between 1 and 128 moves")
		return false
	}
	meta, err := server.data.OpeningGraph(request.Context(), string(modeID))
	if err != nil {
		writeOpeningBookError(writer, err)
		return false
	}
	exists, err := server.data.OpeningLineExists(
		request.Context(), string(modeID), meta.RootKey, line,
	)
	if err != nil {
		writeOpeningBookError(writer, err)
		return false
	}
	if !exists {
		writeAPIError(writer, http.StatusBadRequest, "that line is not in this opening book")
		return false
	}
	return true
}

func (server *Server) suggestOpeningName(writer http.ResponseWriter, request *http.Request) {
	modeID, ok := server.openingMode(writer, request)
	if !ok {
		return
	}
	var input openingNameRequest
	if err := decodeAPIRequest(writer, request, &input); err != nil {
		writeAPIError(writer, http.StatusBadRequest, err.Error())
		return
	}
	// Throttled before the book is consulted, so a flood costs the database
	// nothing at all.
	if !server.allowOpeningSuggestion(writer, request) {
		return
	}
	// The line is checked as the visitor gave it, since that is the one they
	// were looking at, and stored under whichever of it and its mirror is the
	// key -- so a name proposed for `d8-c7` is a name proposed for `f8-g7`.
	if !server.openingBookForLine(writer, request, modeID, input.Line) {
		return
	}
	suggestion, err := server.data.SuggestOpeningName(
		request.Context(), string(modeID),
		server.canonicalLineFor(modeID, input.Line), input.Name,
	)
	if err != nil {
		writeOpeningBookError(writer, err)
		return
	}
	writeJSON(writer, http.StatusCreated, suggestion)
}

func (server *Server) setOpeningName(writer http.ResponseWriter, request *http.Request) {
	modeID, ok := server.openingMode(writer, request)
	if !ok {
		return
	}
	var input openingNameRequest
	if err := decodeAPIRequest(writer, request, &input); err != nil {
		writeAPIError(writer, http.StatusBadRequest, err.Error())
		return
	}
	if !server.openingBookForLine(writer, request, modeID, input.Line) {
		return
	}
	name, err := server.data.SetOpeningName(
		request.Context(), string(modeID),
		server.canonicalLineFor(modeID, input.Line), input.Name,
	)
	if err != nil {
		writeOpeningBookError(writer, err)
		return
	}
	writeJSON(writer, http.StatusOK, name)
}

// deleteOpeningName takes a published name back off a line.
//
// The line arrives in the query string rather than a body, which is what a
// DELETE reads like elsewhere in this API and what the browse route already
// accepts: `?line=d8-c7,f2-g3`.
func (server *Server) deleteOpeningName(writer http.ResponseWriter, request *http.Request) {
	modeID, ok := server.openingMode(writer, request)
	if !ok {
		return
	}
	line, err := parseOpeningLineQuery(request.URL.Query().Get("line"))
	if err != nil {
		writeAPIError(writer, http.StatusBadRequest, err.Error())
		return
	}
	if len(line) == 0 {
		writeAPIError(writer, http.StatusBadRequest, "name a line to unname")
		return
	}
	// Deliberately not checked against the book: a name for a line the latest
	// scan no longer reaches is exactly the name a curator most needs to remove.
	if err := server.data.DeleteOpeningName(
		request.Context(), string(modeID), server.canonicalLineFor(modeID, line),
	); err != nil {
		writeOpeningBookError(writer, err)
		return
	}
	writer.WriteHeader(http.StatusNoContent)
}

// getOpeningNameSuggestions lists what people have proposed and nobody has
// published. Public: these are shown beside the line they name.
func (server *Server) getOpeningNameSuggestions(writer http.ResponseWriter, request *http.Request) {
	modeID, ok := server.openingMode(writer, request)
	if !ok {
		return
	}
	suggestions, err := server.data.OpeningNameSuggestions(request.Context(), string(modeID))
	if err != nil {
		writeOpeningBookError(writer, err)
		return
	}
	writeJSON(writer, http.StatusOK, suggestions)
}

func (server *Server) approveOpeningNameSuggestion(writer http.ResponseWriter, request *http.Request) {
	modeID, ok := server.openingMode(writer, request)
	if !ok {
		return
	}
	suggestionID, ok := openingSuggestionID(writer, request)
	if !ok {
		return
	}
	name, err := server.data.ApproveOpeningNameSuggestion(
		request.Context(), string(modeID), suggestionID,
	)
	if err != nil {
		writeOpeningBookError(writer, err)
		return
	}
	writeJSON(writer, http.StatusOK, name)
}

// rejectOpeningNameSuggestion turns one proposal down without naming the line,
// which is the other half of curating a queue and the only answer to a name
// nobody should have to read twice.
func (server *Server) rejectOpeningNameSuggestion(writer http.ResponseWriter, request *http.Request) {
	modeID, ok := server.openingMode(writer, request)
	if !ok {
		return
	}
	suggestionID, ok := openingSuggestionID(writer, request)
	if !ok {
		return
	}
	if err := server.data.DeleteOpeningNameSuggestion(
		request.Context(), string(modeID), suggestionID,
	); err != nil {
		writeOpeningBookError(writer, err)
		return
	}
	writer.WriteHeader(http.StatusNoContent)
}

func openingSuggestionID(writer http.ResponseWriter, request *http.Request) (int64, bool) {
	suggestionID, err := strconv.ParseInt(request.PathValue("suggestionID"), 10, 64)
	if err != nil || suggestionID <= 0 {
		writeAPIError(writer, http.StatusBadRequest, "suggestionId must be a positive integer")
		return 0, false
	}
	return suggestionID, true
}

func writeOpeningBookError(writer http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, persistence.ErrOpeningBookNotFound),
		errors.Is(err, persistence.ErrOpeningNameNotFound),
		errors.Is(err, persistence.ErrOpeningLineNotFound):
		writeAPIError(writer, http.StatusNotFound, err.Error())
	case errors.Is(err, persistence.ErrInvalidOpeningName):
		message := strings.TrimPrefix(err.Error(), persistence.ErrInvalidOpeningName.Error()+": ")
		writeAPIError(writer, http.StatusBadRequest, message)
	default:
		writeAPIError(writer, http.StatusInternalServerError, "opening book data is unavailable")
	}
}
