package server

// Players naming openings, including the ones RPSFish never looked at.

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"

	"rps-strategy/backend/internal/persistence"
)

func nameBody(name string, line ...string) string {
	quoted := make([]string, 0, len(line))
	for _, move := range line {
		quoted = append(quoted, `"`+move+`"`)
	}
	return fmt.Sprintf(`{"line":[%s],"name":%q}`, strings.Join(quoted, ","), name)
}

// The point of the whole feature: a line the engine has no opinion about is
// still nameable. `d3-d4` is legal from Infiltration's start and is nowhere in
// testOpeningGraph, whose root lists only `d8-c7` and `f8-g7` -- moves that
// are not even legal under the current rules, since Blue moves first now.
func TestAPlayerCanNameALineTheEngineNeverAnalyzed(t *testing.T) {
	server := openingTestServer(t)
	if response := openingRoute(
		t, server, http.MethodPut, "/api/admin/openings/V3",
		testOpeningGraph, openingAdminToken,
	); response.Code != http.StatusOK {
		t.Fatalf("import: %d %s", response.Code, response.Body)
	}

	response := openingRoute(
		t, server, http.MethodPost, "/api/openings/V3/names",
		nameBody("Centre Push", "d3-d4"), "",
	)
	if response.Code != http.StatusCreated {
		t.Fatalf("naming an unanalyzed line: %d %s", response.Code, response.Body)
	}
	var named persistence.OpeningName
	if err := json.Unmarshal(response.Body.Bytes(), &named); err != nil {
		t.Fatal(err)
	}
	if named.Name != "Centre Push" {
		t.Fatalf("name %q", named.Name)
	}
	// Published, not queued: the whole reason for this route.
	if named.Source != persistence.OpeningNamePlayer {
		t.Fatalf("source %q, want %q", named.Source, persistence.OpeningNamePlayer)
	}
	// Nobody was signed in, which is allowed and leaves no author.
	if named.AuthorUserID != "" {
		t.Fatalf("author %q on an anonymous name", named.AuthorUserID)
	}

	// And it is immediately in the naming layer the live board reads.
	names := openingRoute(t, server, http.MethodGet, "/api/openings/V3/names", "", "")
	if names.Code != http.StatusOK || !strings.Contains(names.Body.String(), "Centre Push") {
		t.Fatalf("names: %d %s", names.Code, names.Body)
	}
}

func TestNamingRefusesMovesNobodyCouldPlay(t *testing.T) {
	server := openingTestServer(t)
	for _, probe := range []struct {
		name string
		body string
		want int
	}{
		{
			// Red's move, and Blue moves first: legal before 2026-09-03 and
			// not since. The rules decide, not the book.
			name: "a move for the wrong side",
			body: nameBody("Backwards", "d8-c7"),
			want: http.StatusBadRequest,
		},
		{
			name: "a square that is not on the board",
			body: nameBody("Nowhere", "z9-z8"),
			want: http.StatusBadRequest,
		},
		{
			name: "not notation at all",
			body: nameBody("Nonsense", "hello"),
			want: http.StatusBadRequest,
		},
		{
			name: "no moves",
			body: `{"line":[],"name":"Empty"}`,
			want: http.StatusBadRequest,
		},
		{
			// Seven plies, one past PlayerOpeningNameLimit. Every move is
			// legal; the line is simply longer than a name should describe.
			name: "longer than an opening",
			body: nameBody(
				"Too Long",
				"d2-c3", "d7-c6", "c3-c4", "c6-c5", "d1-c2", "d8-c7", "c2-b3",
			),
			want: http.StatusBadRequest,
		},
	} {
		t.Run(probe.name, func(t *testing.T) {
			response := openingRoute(
				t, server, http.MethodPost, "/api/openings/V3/names", probe.body, "",
			)
			if response.Code != probe.want {
				t.Fatalf("status %d, want %d: %s", response.Code, probe.want, response.Body)
			}
		})
	}

	// The boundary itself is allowed: exactly PlayerOpeningNameLimit plies.
	response := openingRoute(
		t, server, http.MethodPost, "/api/openings/V3/names",
		nameBody("Just Long Enough", "d2-c3", "d7-c6", "c3-c4", "c6-c5", "d1-c2", "d8-c7"),
		"",
	)
	if response.Code != http.StatusCreated {
		t.Fatalf("six plies should be nameable: %d %s", response.Code, response.Body)
	}
}

func TestTheFirstNameOnALineWins(t *testing.T) {
	server := openingTestServer(t)
	first := openingRoute(
		t, server, http.MethodPost, "/api/openings/V3/names",
		nameBody("Quiet Advance", "d3-d4"), "",
	)
	if first.Code != http.StatusCreated {
		t.Fatalf("first name: %d %s", first.Code, first.Body)
	}
	second := openingRoute(
		t, server, http.MethodPost, "/api/openings/V3/names",
		nameBody("Something Else", "d3-d4"), "",
	)
	// 409, not a silent overwrite: a name that changes under the people
	// already using it is worse than one they disagree with.
	if second.Code != http.StatusConflict {
		t.Fatalf("second name: %d %s, want 409", second.Code, second.Body)
	}
	if !strings.Contains(second.Body.String(), "Quiet Advance") {
		t.Fatalf("the conflict should say what it is called: %s", second.Body)
	}

	// Disagreeing is what suggestions are for, and that path still works for a
	// line the engine does know.
	names := openingRoute(t, server, http.MethodGet, "/api/openings/V3/names", "", "")
	if strings.Contains(names.Body.String(), "Something Else") {
		t.Fatalf("the losing name should not be published: %s", names.Body)
	}
}

func TestBrowsingFindsEveryNameAndSeparatesTheSources(t *testing.T) {
	server := openingTestServer(t)
	if response := openingRoute(
		t, server, http.MethodPut, "/api/admin/openings/V3",
		testOpeningGraph, openingAdminToken,
	); response.Code != http.StatusOK {
		t.Fatalf("import: %d %s", response.Code, response.Body)
	}
	// One curator name on a line the book knows, two player names on lines it
	// does not.
	if response := openingRoute(
		t, server, http.MethodPut, "/api/admin/openings/V3/names",
		nameBody("Skipping Stone Opening", "d8-c7"), openingAdminToken,
	); response.Code != http.StatusOK {
		t.Fatalf("curator name: %d %s", response.Code, response.Body)
	}
	for _, probe := range []struct{ name, move string }{
		{"Centre Push", "d3-d4"},
		{"Wing Feint", "f3-g4"},
	} {
		if response := openingRoute(
			t, server, http.MethodPost, "/api/openings/V3/names",
			nameBody(probe.name, probe.move), "",
		); response.Code != http.StatusCreated {
			t.Fatalf("%s: %d %s", probe.name, response.Code, response.Body)
		}
	}

	var page persistence.OpeningNamePage
	read := func(query string) {
		t.Helper()
		response := openingRoute(
			t, server, http.MethodGet, "/api/openings/V3/names/browse"+query, "", "",
		)
		if response.Code != http.StatusOK {
			t.Fatalf("browse%s: %d %s", query, response.Code, response.Body)
		}
		page = persistence.OpeningNamePage{}
		if err := json.Unmarshal(response.Body.Bytes(), &page); err != nil {
			t.Fatal(err)
		}
	}

	read("")
	if page.Total != 3 || len(page.Names) != 3 {
		t.Fatalf("every name should be reachable: total %d, %#v", page.Total, page.Names)
	}
	// The two counts describe the whole mode regardless of the filter, so a
	// screen can say "1 book name, 2 named by players" while showing one.
	if page.Curator != 1 || page.Player != 2 {
		t.Fatalf("counts: %d curator, %d player", page.Curator, page.Player)
	}

	read("?source=player")
	if page.Total != 2 {
		t.Fatalf("player filter: %d", page.Total)
	}
	for _, name := range page.Names {
		if name.Source != persistence.OpeningNamePlayer {
			t.Fatalf("filter leaked a %s name", name.Source)
		}
	}
	if page.Curator != 1 || page.Player != 2 {
		t.Fatalf("filtering must not move the totals: %d/%d", page.Curator, page.Player)
	}

	read("?q=centre")
	if page.Total != 1 || page.Names[0].Name != "Centre Push" {
		t.Fatalf("search: %d %#v", page.Total, page.Names)
	}

	// A LIKE wildcard is text, not a pattern: someone searching for "%" wants
	// the names containing it, not all of them.
	read("?q=%25")
	if page.Total != 0 {
		t.Fatalf("a bare wildcard matched %d names", page.Total)
	}

	read("?limit=2")
	if len(page.Names) != 2 || page.Total != 3 {
		t.Fatalf("paging: %d of %d", len(page.Names), page.Total)
	}
}

func TestACuratorCanRemoveAPlayerName(t *testing.T) {
	server := openingTestServer(t)
	if response := openingRoute(
		t, server, http.MethodPost, "/api/openings/V3/names",
		nameBody("Regrettable", "d3-d4"), "",
	); response.Code != http.StatusCreated {
		t.Fatalf("name: %d %s", response.Code, response.Body)
	}
	// The removal path is what makes publishing on the spot safe to offer.
	if response := openingRoute(
		t, server, http.MethodDelete,
		"/api/admin/openings/V3/names?line=d3-d4", "", openingAdminToken,
	); response.Code != http.StatusNoContent {
		t.Fatalf("delete: %d %s", response.Code, response.Body)
	}
	names := openingRoute(t, server, http.MethodGet, "/api/openings/V3/names", "", "")
	if strings.Contains(names.Body.String(), "Regrettable") {
		t.Fatalf("the name survived removal: %s", names.Body)
	}
	// And the line is free to be named again.
	if response := openingRoute(
		t, server, http.MethodPost, "/api/openings/V3/names",
		nameBody("Second Attempt", "d3-d4"), "",
	); response.Code != http.StatusCreated {
		t.Fatalf("renaming after removal: %d %s", response.Code, response.Body)
	}
}

// The startup mirror-rekey moves a name onto the canonical half of its pair.
// It has to carry the name's provenance with it: an INSERT..SELECT that omits
// the newer columns does not blank them, it takes their *defaults* -- so a
// player's name became the book's own and lost its author the first time the
// server restarted after they wrote it. Found by looking at the page.
func TestRekeyingAMirrorPairKeepsWhoNamedIt(t *testing.T) {
	server := openingTestServer(t)
	// `f3-g4` mirrors to `d3-c4`, and `d3-c4` is the lexicographically smaller
	// of the two, so naming this line stores it under the other one.
	if response := openingRoute(
		t, server, http.MethodPost, "/api/openings/V3/names",
		nameBody("Wing Feint", "f3-g4"), "",
	); response.Code != http.StatusCreated {
		t.Fatalf("name: %d %s", response.Code, response.Body)
	}

	// What the server does on every start.
	server.canonicalizeOpeningNames()

	names, err := server.data.OpeningNames(t.Context(), "V3")
	if err != nil {
		t.Fatal(err)
	}
	if len(names) != 1 {
		t.Fatalf("names after rekeying: %#v", names)
	}
	if names[0].Source != persistence.OpeningNamePlayer {
		t.Fatalf("source became %q -- the rekey dropped it", names[0].Source)
	}
}
