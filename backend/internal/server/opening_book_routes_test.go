package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"

	"rps-strategy/backend/internal/game"
	"rps-strategy/backend/internal/persistence"
)

const openingAdminToken = "opening-admin-token"

// A v1 tree, kept because the importer still accepts one.
const testOpeningBook = `{
  "format":"rps-opening-book/v1",
  "modeId":"V3",
  "modeName":"Infiltration",
  "engineVersion":"0.1.0",
  "rulesVersion":2,
  "weights":"0123456789abcdef",
  "symmetry":"files",
  "maxPly":4,
  "width":2,
  "positionCount":2,
  "mainLine":["d8-c7","d2-c3"],
  "root":{
    "turn":"Red","score":17,"depth":20,"selectiveDepth":26,"nodes":1000,
    "moves":[{
      "move":"d8-c7","score":17,"rank":1,"searched":true,
      "mainLine":true,"repetition":false,
      "child":{
        "turn":"Blue","score":-17,"depth":19,"selectiveDepth":25,"nodes":900,
        "moves":[{
          "move":"d2-c3","score":-17,"rank":1,"searched":false,
          "mainLine":true,"repetition":false,"child":null
        }]
      }
    }]
  }
}`

// The graph the website is actually served from. `d8-c7 f2-g3` and
// `f8-g7 d2-c3` are the same board by two move orders, so both resolve to key
// "z" -- the thing a tree export cannot express and this one must.
const testOpeningGraph = `{
  "format":"rps-opening-book/v2",
  "modeId":"V3",
  "modeName":"Infiltration",
  "engineVersion":"0.1.0",
  "rulesVersion":2,
  "weights":"0123456789abcdef",
  "symmetry":"files",
  "maxPly":8,
  "rootKey":"r",
  "positionCount":4,
  "mainLine":["d8-c7","f2-g3"],
  "featured":[["d8-c7","f2-g3"]],
  "positions":[
    {"key":"r","turn":"Red","score":17,"depth":20,"selectiveDepth":26,"nodes":1000,
     "moves":[
       {"move":"d8-c7","score":17,"rank":1,"searched":true,"mainLine":true,"child":"x"},
       {"move":"f8-g7","score":9,"rank":2,"searched":true,"mainLine":false,"child":"y"}
     ]},
    {"key":"x","turn":"Blue","score":-17,"depth":19,"selectiveDepth":25,"nodes":900,
     "moves":[{"move":"f2-g3","score":-17,"rank":1,"searched":true,"mainLine":true,"child":"z"}]},
    {"key":"y","turn":"Blue","score":-9,"depth":18,"selectiveDepth":24,"nodes":800,
     "moves":[{"move":"d2-c3","score":-9,"rank":1,"searched":true,"mainLine":true,"child":"z"}]},
    {"key":"z","turn":"Red","score":17,"depth":17,"selectiveDepth":23,"nodes":700,
     "moves":[
       {"move":"e9-d8","score":17,"rank":1,"searched":false,"mainLine":true,"child":null},
       {"move":"c7-d8","score":4,"rank":2,"searched":true,"mainLine":false,"child":"r"}
     ]}
  ]
}`

func openingTestServer(t *testing.T) *Server {
	t.Helper()
	data, err := persistence.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = data.Close() })
	return NewWithStoreAndAdminToken(data, nil, openingAdminToken)
}

func openingRoute(
	t *testing.T,
	server *Server,
	method, path, body, adminToken string,
) *httptest.ResponseRecorder {
	t.Helper()
	request := httptest.NewRequest(method, path, strings.NewReader(body))
	if adminToken != "" {
		request.Header.Set("Authorization", "Bearer "+adminToken)
	}
	recorder := httptest.NewRecorder()
	server.Routes().ServeHTTP(recorder, request)
	return recorder
}

func TestOpeningBookImportBrowseAndNamingFlow(t *testing.T) {
	server := openingTestServer(t)
	if response := openingRoute(t, server, http.MethodGet, "/api/openings/V3", "", ""); response.Code != http.StatusNotFound {
		t.Fatalf("expected 404 before import, got %d: %s", response.Code, response.Body)
	}
	if response := openingRoute(t, server, http.MethodPut, "/api/admin/openings/V3", testOpeningGraph, ""); response.Code != http.StatusUnauthorized {
		t.Fatalf("expected admin protection, got %d", response.Code)
	}
	response := openingRoute(
		t, server, http.MethodPut, "/api/admin/openings/V3", testOpeningGraph, openingAdminToken,
	)
	if response.Code != http.StatusOK {
		t.Fatalf("import failed with %d: %s", response.Code, response.Body)
	}

	// The bootstrap is metadata, names, the root, and the featured lines --
	// never the whole book.
	response = openingRoute(t, server, http.MethodGet, "/api/openings/V3", "", "")
	if response.Code != http.StatusOK {
		t.Fatalf("browse failed with %d: %s", response.Code, response.Body)
	}
	var bootstrap openingBootstrap
	if err := json.NewDecoder(response.Body).Decode(&bootstrap); err != nil {
		t.Fatal(err)
	}
	if bootstrap.RootKey != "r" || len(bootstrap.Root.Moves) != 2 {
		t.Fatalf("unexpected root: %#v", bootstrap.Root)
	}
	if len(bootstrap.Names) != 0 {
		t.Fatalf("expected no names yet: %#v", bootstrap.Names)
	}
	// "r" is the root and is not repeated; "x" and "z" are the line itself.
	if len(bootstrap.FeaturedPositions) != 2 {
		t.Fatalf("expected the featured line's positions, got %#v", bootstrap.FeaturedPositions)
	}
	// A move's child contributes what the list renders, without another request.
	if bootstrap.Root.Moves[0].ChildTurn != "Blue" || bootstrap.Root.Moves[0].ChildDepth != 19 {
		t.Fatalf("root move lost its child summary: %#v", bootstrap.Root.Moves[0])
	}

	// Walking a layer at a time, and a transposition landing on one position.
	first := openingNodeAt(t, server, "d8-c7,f2-g3")
	second := openingNodeAt(t, server, "f8-g7,d2-c3")
	if first.Node.Key != "z" || second.Node.Key != "z" {
		t.Fatalf("transposed lines reached %q and %q", first.Node.Key, second.Node.Key)
	}
	// Repetition is a property of the walk, so the move back to the root is one
	// here and the stored graph never said so.
	if len(first.Node.Moves) != 2 || !first.Node.Moves[1].Repetition {
		t.Fatalf("expected c7-d8 to close a repetition: %#v", first.Node.Moves)
	}
	if response := openingRoute(t, server, http.MethodGet, "/api/openings/V3/node?line=d8-c7,a1-a2", "", ""); response.Code != http.StatusNotFound {
		t.Fatalf("expected an unknown line to 404, got %d: %s", response.Code, response.Body)
	}

	badLine := `{"line":["a1-a2"],"name":"Ghost Gambit"}`
	response = openingRoute(t, server, http.MethodPost, "/api/openings/V3/suggestions", badLine, "")
	if response.Code != http.StatusBadRequest {
		t.Fatalf("expected an unknown line to be rejected, got %d: %s", response.Code, response.Body)
	}

	suggestion := `{"line":["d8-c7"],"name":"Skipping Stone Opening"}`
	response = openingRoute(t, server, http.MethodPost, "/api/openings/V3/suggestions", suggestion, "")
	if response.Code != http.StatusCreated {
		t.Fatalf("suggestion failed with %d: %s", response.Code, response.Body)
	}
	var suggested persistence.OpeningNameSuggestion
	if err := json.NewDecoder(response.Body).Decode(&suggested); err != nil {
		t.Fatal(err)
	}
	if suggested.SuggestionID <= 0 {
		t.Fatalf("suggestion did not receive an id: %#v", suggested)
	}

	response = openingRoute(
		t,
		server,
		http.MethodPost,
		"/api/admin/openings/V3/suggestions/"+strconv.FormatInt(suggested.SuggestionID, 10)+"/approve",
		"",
		openingAdminToken,
	)
	if response.Code != http.StatusOK {
		t.Fatalf("approval failed with %d: %s", response.Code, response.Body)
	}

	response = openingRoute(t, server, http.MethodGet, "/api/openings/V3", "", "")
	if err := json.NewDecoder(response.Body).Decode(&bootstrap); err != nil {
		t.Fatal(err)
	}
	if len(bootstrap.Names) != 1 || bootstrap.Names[0].Name != "Skipping Stone Opening" {
		t.Fatalf("approved name was not published: %#v", bootstrap.Names)
	}

	// A line that ends at the frontier is still a line, and still nameable:
	// "e9-d8" was ranked but nothing is stored behind it.
	frontierName := `{"line":["d8-c7","f2-g3","e9-d8"],"name":"Skipping Stone Frontier"}`
	response = openingRoute(
		t, server, http.MethodPut, "/api/admin/openings/V3/names", frontierName, openingAdminToken,
	)
	if response.Code != http.StatusOK {
		t.Fatalf("naming a frontier line failed with %d: %s", response.Code, response.Body)
	}

	// Engine refreshes replace analysis but do not erase the human taxonomy.
	response = openingRoute(
		t, server, http.MethodPut, "/api/admin/openings/V3", testOpeningGraph, openingAdminToken,
	)
	if response.Code != http.StatusOK {
		t.Fatalf("re-import failed with %d: %s", response.Code, response.Body)
	}
	response = openingRoute(t, server, http.MethodGet, "/api/openings/V3", "", "")
	if err := json.NewDecoder(response.Body).Decode(&bootstrap); err != nil {
		t.Fatal(err)
	}
	if len(bootstrap.Names) != 2 {
		t.Fatalf("re-import erased opening names: %#v", bootstrap.Names)
	}
}

// A v1 tree still imports; it is flattened by line, since duplication is the
// only identity a nested export carries.
func TestOpeningBookImportAcceptsTheOlderTreeExport(t *testing.T) {
	server := openingTestServer(t)
	response := openingRoute(
		t, server, http.MethodPut, "/api/admin/openings/V3", testOpeningBook, openingAdminToken,
	)
	if response.Code != http.StatusOK {
		t.Fatalf("tree import failed with %d: %s", response.Code, response.Body)
	}
	node := openingNodeAt(t, server, "d8-c7")
	if node.Node.Turn != "Blue" || len(node.Node.Moves) != 1 {
		t.Fatalf("tree import did not become a walkable graph: %#v", node.Node)
	}
}

func openingNodeAt(t *testing.T, server *Server, line string) openingNodeResponse {
	t.Helper()
	response := openingRoute(t, server, http.MethodGet, "/api/openings/V3/node?line="+line, "", "")
	if response.Code != http.StatusOK {
		t.Fatalf("node %q failed with %d: %s", line, response.Code, response.Body)
	}
	var decoded openingNodeResponse
	if err := json.NewDecoder(response.Body).Decode(&decoded); err != nil {
		t.Fatal(err)
	}
	return decoded
}

func TestOpeningBookImportValidatesTheEngineArtifact(t *testing.T) {
	server := openingTestServer(t)
	for _, test := range []struct {
		name string
		body string
	}{
		{name: "wrong mode", body: strings.Replace(testOpeningBook, `"modeId":"V3"`, `"modeId":"V5"`, 1)},
		{name: "wrong count", body: strings.Replace(testOpeningBook, `"positionCount":2`, `"positionCount":3`, 1)},
		{name: "bad move", body: strings.Replace(testOpeningBook, `"d8-c7"`, `"z8-c7"`, 1)},
		{name: "trailing object", body: testOpeningBook + `{}`},
	} {
		t.Run(test.name, func(t *testing.T) {
			response := openingRoute(
				t, server, http.MethodPut, "/api/admin/openings/V3", test.body, openingAdminToken,
			)
			if response.Code != http.StatusBadRequest {
				t.Fatalf("expected 400, got %d: %s", response.Code, response.Body)
			}
		})
	}
}

// A helper for the naming tests: import the graph and hand back the server.
func namedOpeningServer(t *testing.T) *Server {
	t.Helper()
	server := openingTestServer(t)
	response := openingRoute(
		t, server, http.MethodPut, "/api/admin/openings/V3", testOpeningGraph, openingAdminToken,
	)
	if response.Code != http.StatusOK {
		t.Fatalf("import failed with %d: %s", response.Code, response.Body)
	}
	return server
}

func openingBootstrapFor(t *testing.T, server *Server) openingBootstrap {
	t.Helper()
	response := openingRoute(t, server, http.MethodGet, "/api/openings/V3", "", "")
	if response.Code != http.StatusOK {
		t.Fatalf("browse failed with %d: %s", response.Code, response.Body)
	}
	var bootstrap openingBootstrap
	if err := json.NewDecoder(response.Body).Decode(&bootstrap); err != nil {
		t.Fatal(err)
	}
	return bootstrap
}

// Naming `f8-g7` names `d8-c7`, because they are one opening drawn twice.
func TestOpeningNamesAreSharedWithTheirMirrors(t *testing.T) {
	server := namedOpeningServer(t)

	// Published against the mirror, stored against the canonical line.
	response := openingRoute(
		t, server, http.MethodPut, "/api/admin/openings/V3/names",
		`{"line":["f8-g7"],"name":"Skipping Stone Opening"}`, openingAdminToken,
	)
	if response.Code != http.StatusOK {
		t.Fatalf("naming the mirror failed with %d: %s", response.Code, response.Body)
	}
	bootstrap := openingBootstrapFor(t, server)
	if !bootstrap.MirrorNaming {
		t.Fatal("V3 mirrors its files, so the screen has to be told so")
	}
	if len(bootstrap.Names) != 1 || strings.Join(bootstrap.Names[0].Line, " ") != "d8-c7" {
		t.Fatalf("the mirror was not folded onto one line: %#v", bootstrap.Names)
	}

	// The same line named again from the other side is the same row, not a
	// second opening with a competing name.
	response = openingRoute(
		t, server, http.MethodPut, "/api/admin/openings/V3/names",
		`{"line":["d8-c7"],"name":"Skipping Stone"}`, openingAdminToken,
	)
	if response.Code != http.StatusOK {
		t.Fatalf("renaming failed with %d: %s", response.Code, response.Body)
	}
	bootstrap = openingBootstrapFor(t, server)
	if len(bootstrap.Names) != 1 || bootstrap.Names[0].Name != "Skipping Stone" {
		t.Fatalf("naming the mirror made a second opening: %#v", bootstrap.Names)
	}

	// A whole line mirrors as a unit: `d8-c7 f2-g3` and `f8-g7 d2-c3` are the
	// same sequence, and per-move canonicalization would have produced neither.
	response = openingRoute(
		t, server, http.MethodPost, "/api/openings/V3/suggestions",
		`{"line":["f8-g7","d2-c3"],"name":"Twin Defense"}`, "",
	)
	if response.Code != http.StatusCreated {
		t.Fatalf("suggesting against the mirror failed with %d: %s", response.Code, response.Body)
	}
	bootstrap = openingBootstrapFor(t, server)
	if len(bootstrap.Suggestions) != 1 ||
		strings.Join(bootstrap.Suggestions[0].Line, " ") != "d8-c7 f2-g3" {
		t.Fatalf("the suggested mirror line was not folded: %#v", bootstrap.Suggestions)
	}
}

// Naming a line deeper in the book must leave the shallower line's proposals
// exactly where they were: the two are separate openings, and a curator who
// works out of order should not appear to have destroyed anything.
func TestNamingOneLineLeavesOtherLinesSuggestionsAlone(t *testing.T) {
	server := namedOpeningServer(t)
	for _, body := range []string{
		`{"line":["d8-c7"],"name":"Skipping Stone Opening"}`,
		`{"line":["d8-c7"],"name":"The Long Walk"}`,
		`{"line":["d8-c7","f2-g3"],"name":"Crane Lift"}`,
	} {
		response := openingRoute(
			t, server, http.MethodPost, "/api/openings/V3/suggestions", body, "",
		)
		if response.Code != http.StatusCreated {
			t.Fatalf("suggestion failed with %d: %s", response.Code, response.Body)
		}
	}

	// Publish the second move's name first, which is the order that used to
	// look like it had eaten the first move's.
	response := openingRoute(
		t, server, http.MethodPut, "/api/admin/openings/V3/names",
		`{"line":["d8-c7","f2-g3"],"name":"Crane Lift"}`, openingAdminToken,
	)
	if response.Code != http.StatusOK {
		t.Fatalf("naming the deeper line failed with %d: %s", response.Code, response.Body)
	}

	bootstrap := openingBootstrapFor(t, server)
	if len(bootstrap.Names) != 1 {
		t.Fatalf("expected one published name: %#v", bootstrap.Names)
	}
	// Both proposals for the first move survive, and the deeper line's own
	// proposal is resolved by having been answered.
	if len(bootstrap.Suggestions) != 2 {
		t.Fatalf("naming a line disturbed another line's queue: %#v", bootstrap.Suggestions)
	}
	for _, suggestion := range bootstrap.Suggestions {
		if strings.Join(suggestion.Line, " ") != "d8-c7" {
			t.Fatalf("unexpected surviving suggestion: %#v", suggestion)
		}
	}
}

func TestCuratorsCanUnnameALineAndTurnDownASuggestion(t *testing.T) {
	server := namedOpeningServer(t)
	response := openingRoute(
		t, server, http.MethodPut, "/api/admin/openings/V3/names",
		`{"line":["d8-c7"],"name":"Skipping Stone Opening"}`, openingAdminToken,
	)
	if response.Code != http.StatusOK {
		t.Fatalf("naming failed with %d: %s", response.Code, response.Body)
	}
	response = openingRoute(
		t, server, http.MethodDelete, "/api/admin/openings/V3/names?line=f8-g7", "", openingAdminToken,
	)
	if response.Code != http.StatusNoContent {
		t.Fatalf("unnaming through the mirror failed with %d: %s", response.Code, response.Body)
	}
	if bootstrap := openingBootstrapFor(t, server); len(bootstrap.Names) != 0 {
		t.Fatalf("the name survived its removal: %#v", bootstrap.Names)
	}
	response = openingRoute(
		t, server, http.MethodDelete, "/api/admin/openings/V3/names?line=d8-c7", "", openingAdminToken,
	)
	if response.Code != http.StatusNotFound {
		t.Fatalf("expected 404 for a line with no name, got %d: %s", response.Code, response.Body)
	}

	response = openingRoute(
		t, server, http.MethodPost, "/api/openings/V3/suggestions",
		`{"line":["d8-c7"],"name":"Something Unrepeatable"}`, "",
	)
	if response.Code != http.StatusCreated {
		t.Fatalf("suggestion failed with %d: %s", response.Code, response.Body)
	}
	var suggested persistence.OpeningNameSuggestion
	if err := json.NewDecoder(response.Body).Decode(&suggested); err != nil {
		t.Fatal(err)
	}
	path := "/api/admin/openings/V3/suggestions/" + strconv.FormatInt(suggested.SuggestionID, 10)
	if response := openingRoute(t, server, http.MethodDelete, path, "", ""); response.Code != http.StatusUnauthorized {
		t.Fatalf("rejecting a suggestion is an admin act, got %d", response.Code)
	}
	response = openingRoute(t, server, http.MethodDelete, path, "", openingAdminToken)
	if response.Code != http.StatusNoContent {
		t.Fatalf("rejection failed with %d: %s", response.Code, response.Body)
	}

	// The public list is the same list the curator works from.
	response = openingRoute(t, server, http.MethodGet, "/api/openings/V3/suggestions", "", "")
	if response.Code != http.StatusOK {
		t.Fatalf("listing suggestions failed with %d: %s", response.Code, response.Body)
	}
	var pending []persistence.OpeningNameSuggestion
	if err := json.NewDecoder(response.Body).Decode(&pending); err != nil {
		t.Fatal(err)
	}
	if len(pending) != 0 {
		t.Fatalf("the rejected suggestion is still queued: %#v", pending)
	}
}

// The board asks what the game it is showing is called, once per mode, and it
// asks every game. What comes back is the naming layer and nothing else: no
// root position, no featured lines, no book at all -- including for a mode
// whose scan has not been imported, because names outlive scans.
func TestOpeningNamesRouteAnswersWithoutTheBook(t *testing.T) {
	server := openingTestServer(t)

	response := openingRoute(t, server, http.MethodGet, "/api/openings/V3/names", "", "")
	if response.Code != http.StatusOK {
		t.Fatalf("names before any import failed with %d: %s", response.Code, response.Body)
	}
	var empty openingNamesResponse
	if err := json.Unmarshal(response.Body.Bytes(), &empty); err != nil {
		t.Fatal(err)
	}
	if len(empty.Names) != 0 || !empty.MirrorNaming {
		t.Fatalf("an unscanned mode answered %#v", empty)
	}

	server = namedOpeningServer(t)
	published := openingRoute(
		t, server, http.MethodPut, "/api/admin/openings/V3/names",
		`{"line":["f8-g7"],"name":"Skipping Stone"}`, openingAdminToken,
	)
	if published.Code != http.StatusOK {
		t.Fatalf("naming failed with %d: %s", published.Code, published.Body)
	}

	response = openingRoute(t, server, http.MethodGet, "/api/openings/V3/names", "", "")
	if response.Code != http.StatusOK {
		t.Fatalf("names failed with %d: %s", response.Code, response.Body)
	}
	var named openingNamesResponse
	if err := json.Unmarshal(response.Body.Bytes(), &named); err != nil {
		t.Fatal(err)
	}
	if named.ModeID != "V3" || len(named.Names) != 1 || named.Names[0].Name != "Skipping Stone" {
		t.Fatalf("the published name is missing: %#v", named)
	}
	// Folded onto the canonical line, exactly as the bootstrap serves it: the
	// board looks a line up by the same key the openings screen does.
	if strings.Join(named.Names[0].Line, " ") != "d8-c7" {
		t.Fatalf("the mirror was not folded: %#v", named.Names[0])
	}
	if strings.Contains(response.Body.String(), "featuredPositions") {
		t.Fatalf("the names route is carrying the book: %s", response.Body)
	}
}

func TestUnknownModeHasNoOpeningNames(t *testing.T) {
	server := openingTestServer(t)
	response := openingRoute(t, server, http.MethodGet, "/api/openings/V9/names", "", "")
	if response.Code != http.StatusNotFound {
		t.Fatalf("expected 404 for an unknown mode, got %d: %s", response.Code, response.Body)
	}
}

// The line travels with the position, because the board cannot work it out for
// itself: a player who refreshed and a spectator who arrived late never saw the
// moves that made the opening. So every snapshot the server sends carries it,
// in the book's own notation and under the name the client reads.
func TestGameStateCarriesTheOpeningLineItIsPlaying(t *testing.T) {
	server := New(nil)
	challenger := challengeTestClient("red-id", "Alice")
	target := challengeTestClient("blue-id", "Bob")
	server.hub.Register(challenger)
	server.hub.Register(target)

	server.handleMessage(challenger, ClientMessage{
		Type:     "send_challenge",
		Username: "Bob",
		ModeID:   game.ModeInfiltration,
	})
	sent := readChallengeTestMessage(t, challenger)
	readChallengeTestMessage(t, target)
	server.handleMessage(target, ClientMessage{
		Type:        "accept_challenge",
		ChallengeID: sent.Challenge.ID,
	})
	found := readChallengeTestMessage(t, challenger)
	readChallengeTestMessage(t, target)
	if found.Type != "match_found" || found.GameState == nil {
		t.Fatalf("expected a game, got %#v", found)
	}
	if len(found.GameState.OpeningLine) != 0 {
		t.Fatalf("a game with no moves announced the line %v", found.GameState.OpeningLine)
	}

	// d1 is Blue's scissors in the Infiltration opening, and c2 is the empty
	// square in front of it — the first move of the published book's main line,
	// played by the challenger, who holds the seat that opens.
	from := game.Position{X: 3, Y: 0}
	to := game.Position{X: 2, Y: 1}
	server.handleMessage(challenger, ClientMessage{Type: "make_move", From: from, To: to})

	// Lobby broadcasts share the wire, so the board is whichever of the next
	// few messages is the board.
	var state ServerMessage
	for attempt := 0; attempt < 8 && state.GameState == nil; attempt++ {
		next := readChallengeTestMessage(t, challenger)
		if next.Type == "game_state" {
			state = next
		}
	}
	if state.GameState == nil {
		t.Fatal("the move never came back as a board")
	}
	if strings.Join(state.GameState.OpeningLine, " ") != "d1-c2" {
		t.Fatalf("the move reached the client as %v", state.GameState.OpeningLine)
	}

	// Under the name the openings screen looks for, spelled the way the book
	// spells a move. A snapshot that carried it as anything else would leave
	// the badge on the board permanently blank.
	encoded, err := json.Marshal(state.GameState)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(encoded), `"openingLine":["d1-c2"]`) {
		t.Fatalf("the wire form is missing the line: %s", encoded)
	}
}
