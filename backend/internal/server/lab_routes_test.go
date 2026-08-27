package server

// The library, over its routes: publish something, find it, and play it.
//
// The last of those is the point of the whole feature, so it is tested as one
// path rather than three: a mode is published, the registry can seat a game in
// it, and the rules that arrive with that game are the rules that were
// published. Anything short of that is a library of documents nobody can use.

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"rps-strategy/backend/internal/game"
	"rps-strategy/backend/internal/game/spec"
	"rps-strategy/backend/internal/persistence"
)

// A small, complete mode that is not either of the shipped ones: five files by
// five, one kind, and a race to the far rank.
const dashJSON = `{
  "spec": 1,
  "name": "Dash",
  "shortCode": "DSH",
  "description": "A sprint.",
  "objective": "Reach the far rank.",
  "board": { "width": 5, "height": 5 },
  "pieces": [{ "id": "Runner", "name": "Runner", "symbol": "R" }],
  "beats": [["Runner", "Runner"]],
  "startingPosition": { "rows": ["RRRRR", ".....", ".....", ".....", "rrrrr"] },
  "movement": [{ "kind": "step", "dirs": "all8", "distance": 1 }],
  "win": [{ "id": "reach", "when": { "in": ["to", { "home": "opponent" }] },
            "result": "mover", "reason": "infiltration" }]
}`

// freshRegistry is the two shipped modes and nothing else — what a process
// starts with, before the library is loaded.
func freshRegistry() *game.ModeRegistry {
	registry := game.NewModeRegistry()
	registry.MustRegister(func() game.GameMode { return &game.TotalWarMode{} })
	registry.MustRegister(func() game.GameMode { return &game.InfiltrationMode{} })
	return registry
}

type labTestServer struct {
	server *Server
	http   *httptest.Server
	data   *persistence.Store
}

// labAuthor is a guest. Publishing is deliberately open to one — the Lab is
// meant to be a click from a first visit — so the tests use the same identity a
// first-time visitor has: a locally minted user id and a profile key.
const labAuthorID = "lab-author"

// At least 32 characters, or hashProfileKey refuses it — and the refusal reads
// as a stale account rather than as a short key.
var labAuthorKey = strings.Repeat("labkey", 8)

func newLabTestServer(t *testing.T) labTestServer {
	t.Helper()
	data, err := persistence.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { data.Close() })
	if _, err := data.EnsureAccountWithProfileKey(
		t.Context(), labAuthorID, "LabAuthor", labAuthorKey,
	); err != nil {
		t.Fatal(err)
	}
	// Its own registry, not the process-wide one. Publishing registers a mode
	// for the life of the process, so tests sharing `DefaultModeRegistry` would
	// collide on the second publish of the same name — and the restart test
	// below would pass because an earlier test had already registered it, which
	// is the opposite of what it is for.
	server := NewWithRegistryAndStore(freshRegistry(), data, nil)
	httpServer := httptest.NewServer(server.Routes())
	t.Cleanup(httpServer.Close)
	return labTestServer{server: server, http: httpServer, data: data}
}

// A guest identity is the profile key as a bearer token plus the user id in the
// query string, which is exactly what the browser sends.
func labRequest(t *testing.T, harness labTestServer, method, path, body string) *http.Response {
	t.Helper()
	separator := "?"
	if strings.Contains(path, "?") {
		separator = "&"
	}
	url := harness.http.URL + path + separator + "userId=" + labAuthorID
	request, err := http.NewRequest(method, url, strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Authorization", "Bearer "+labAuthorKey)
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { response.Body.Close() })
	return response
}

func publishDash(t *testing.T, harness labTestServer) persistence.CustomMode {
	t.Helper()
	body, err := json.Marshal(map[string]any{
		"slug":        "dash",
		"spec":        json.RawMessage(dashJSON),
		"derivedFrom": []string{"jump@1"},
	})
	if err != nil {
		t.Fatal(err)
	}
	response := labRequest(t, harness, http.MethodPost, "/api/lab/modes", string(body))
	if response.StatusCode != http.StatusCreated {
		payload, _ := json.Marshal(response.Header)
		t.Fatalf("publish returned %d (%s)", response.StatusCode, payload)
	}
	var decoded struct {
		Mode persistence.CustomMode `json:"mode"`
	}
	if err := json.NewDecoder(response.Body).Decode(&decoded); err != nil {
		t.Fatal(err)
	}
	return decoded.Mode
}

func TestPublishingAModeMakesItPlayable(t *testing.T) {
	harness := newLabTestServer(t)
	published := publishDash(t, harness)

	if published.ModeID != "custom:dash@1" {
		t.Fatalf("mode id is %q, want custom:dash@1", published.ModeID)
	}
	if published.Version != 1 {
		t.Fatalf("version is %d", published.Version)
	}

	// The registry has it, which is what lets a challenge naming it be seated.
	if !harness.server.registry.Has(game.ModeID(published.ModeID)) {
		t.Fatal("a published mode should be registered")
	}
	if !harness.server.registry.Playable(game.ModeID(published.ModeID)) {
		t.Fatal("a published mode should accept new games")
	}

	// And a real game can be created in it, with the published rules riding
	// along inside the position — which is what lets a client who has never
	// heard of this mode play it.
	live, err := game.NewGameWithRegistry(
		harness.server.registry, "library-game", game.ModeID(published.ModeID),
		game.PlayerProfile{UserID: "red"}, game.PlayerProfile{UserID: "blue"},
	)
	if err != nil {
		t.Fatalf("seat a game in a published mode: %v", err)
	}
	state := live.Snapshot()
	if state.Grid.Width() != 5 || state.Grid.Height() != 5 {
		t.Fatalf("board is %d by %d, want 5 by 5", state.Grid.Width(), state.Grid.Height())
	}
	if len(state.Mode.Spec) == 0 {
		t.Fatal("the rules should travel with the game")
	}
	var carried spec.RuleSpec
	if err := json.Unmarshal(state.Mode.Spec, &carried); err != nil {
		t.Fatal(err)
	}
	if carried.Name != "Dash" {
		t.Fatalf("the game carries %q", carried.Name)
	}

	// Red starts on the last rank and wins by reaching rank 1, four steps away.
	for _, move := range []struct{ from, to game.Position }{
		{game.Position{X: 0, Y: 4}, game.Position{X: 0, Y: 3}},
		{game.Position{X: 4, Y: 0}, game.Position{X: 4, Y: 1}},
		{game.Position{X: 0, Y: 3}, game.Position{X: 0, Y: 2}},
		{game.Position{X: 4, Y: 1}, game.Position{X: 4, Y: 2}},
		{game.Position{X: 0, Y: 2}, game.Position{X: 0, Y: 1}},
		{game.Position{X: 4, Y: 2}, game.Position{X: 4, Y: 3}},
		{game.Position{X: 0, Y: 1}, game.Position{X: 0, Y: 0}},
	} {
		if _, err := live.Move(live.Snapshot().CurrentTurn, move.from, move.to); err != nil {
			t.Fatalf("%v -> %v: %v", move.from, move.to, err)
		}
	}
	final := live.Snapshot()
	if final.Status != game.Finished || final.Winner != game.Red {
		t.Fatalf("expected Red to win by reaching rank 1, got %+v", final)
	}
	if final.EndReason != game.EndReasonInfiltration {
		t.Fatalf("end reason is %q", final.EndReason)
	}
}

func TestTheLibraryListsAndFetchesAPublishedMode(t *testing.T) {
	harness := newLabTestServer(t)
	published := publishDash(t, harness)

	listed := labRequest(t, harness, http.MethodGet, "/api/lab/modes?q=Dash", "")
	var page struct {
		Modes []persistence.CustomMode `json:"modes"`
	}
	if err := json.NewDecoder(listed.Body).Decode(&page); err != nil {
		t.Fatal(err)
	}
	if len(page.Modes) != 1 || page.Modes[0].ModeID != published.ModeID {
		t.Fatalf("the library did not list the mode: %+v", page.Modes)
	}
	if page.Modes[0].OwnerUsername == "" {
		t.Error("a listed mode should name its author")
	}

	one := labRequest(t, harness, http.MethodGet, "/api/lab/modes/"+published.ModeID, "")
	if one.StatusCode != http.StatusOK {
		t.Fatalf("fetching one mode returned %d", one.StatusCode)
	}
	missing := labRequest(t, harness, http.MethodGet, "/api/lab/modes/custom:nothing@1", "")
	if missing.StatusCode != http.StatusNotFound {
		t.Fatalf("a mode that does not exist returned %d", missing.StatusCode)
	}
}

// An edit is a new version under a new id, so a game already being played in the
// first one is unaffected by the second existing.
func TestPublishingAnEditMakesANewVersion(t *testing.T) {
	harness := newLabTestServer(t)
	first := publishDash(t, harness)
	second := publishDash(t, harness)
	if first.ModeID == second.ModeID {
		t.Fatal("two publishes of the same name should be two modes")
	}
	if second.Version != 2 {
		t.Fatalf("the second publish is version %d", second.Version)
	}
	for _, modeID := range []string{first.ModeID, second.ModeID} {
		if !harness.server.registry.Has(game.ModeID(modeID)) {
			t.Fatalf("%s should still be registered", modeID)
		}
	}
}

func TestAnUnplayableSpecIsRefusedWithItsReasons(t *testing.T) {
	harness := newLabTestServer(t)
	broken := strings.Replace(dashJSON, `"piece"`, `"piece"`, 1)
	broken = strings.Replace(broken, `{ "kind": "step", "dirs": "all8", "distance": 1 }`,
		`{ "kind": "step", "dirs": "all8", "piece": "Lizard" }`, 1)
	body, _ := json.Marshal(map[string]any{"slug": "broken", "spec": json.RawMessage(broken)})
	response := labRequest(t, harness, http.MethodPost, "/api/lab/modes", string(body))
	if response.StatusCode != http.StatusBadRequest {
		t.Fatalf("an unplayable spec returned %d", response.StatusCode)
	}
	var decoded struct {
		Issues []spec.Issue `json:"issues"`
	}
	if err := json.NewDecoder(response.Body).Decode(&decoded); err != nil {
		t.Fatal(err)
	}
	if len(decoded.Issues) == 0 {
		t.Fatal("a refusal should say what is wrong, so the Lab can point at it")
	}
	if decoded.Issues[0].Path == "" {
		t.Fatal("an issue should name the field it is about")
	}
}

func TestAMisspelledFieldIsRefusedRatherThanIgnoredOverHTTP(t *testing.T) {
	harness := newLabTestServer(t)
	body := `{"slug":"typo","spec":` + strings.Replace(dashJSON, `"movement"`, `"movements"`, 1) + `}`
	response := labRequest(t, harness, http.MethodPost, "/api/lab/modes", body)
	if response.StatusCode != http.StatusBadRequest {
		t.Fatalf("a misspelled field returned %d", response.StatusCode)
	}
}

func TestABadSlugIsRefused(t *testing.T) {
	harness := newLabTestServer(t)
	for _, slug := range []string{"", "A", "has spaces", strings.Repeat("x", 60), "-leading"} {
		body, _ := json.Marshal(map[string]any{"slug": slug, "spec": json.RawMessage(dashJSON)})
		response := labRequest(t, harness, http.MethodPost, "/api/lab/modes", string(body))
		if response.StatusCode != http.StatusBadRequest {
			t.Errorf("slug %q returned %d", slug, response.StatusCode)
		}
	}
}

// A name is lower-cased rather than refused: "Dash" and "dash" are the same
// mode, and telling somebody their capital letter is an error would be pedantry
// about a field they will never see again.
func TestASlugIsNormalisedRatherThanRefused(t *testing.T) {
	harness := newLabTestServer(t)
	body, _ := json.Marshal(map[string]any{"slug": "  Dash  ", "spec": json.RawMessage(dashJSON)})
	response := labRequest(t, harness, http.MethodPost, "/api/lab/modes", string(body))
	if response.StatusCode != http.StatusCreated {
		t.Fatalf("publishing returned %d", response.StatusCode)
	}
	var decoded struct {
		Mode persistence.CustomMode `json:"mode"`
	}
	if err := json.NewDecoder(response.Body).Decode(&decoded); err != nil {
		t.Fatal(err)
	}
	if decoded.Mode.ModeID != "custom:dash@1" {
		t.Fatalf("mode id is %q", decoded.Mode.ModeID)
	}
}

// Retiring stops new games and keeps the rules, because the archive needs them.
func TestRetiringAModeKeepsItsRules(t *testing.T) {
	harness := newLabTestServer(t)
	published := publishDash(t, harness)
	response := labRequest(t, harness, http.MethodDelete, "/api/lab/modes/"+published.ModeID, "")
	if response.StatusCode != http.StatusNoContent {
		t.Fatalf("retiring returned %d", response.StatusCode)
	}
	if !harness.server.registry.Has(game.ModeID(published.ModeID)) {
		t.Fatal("a retired mode keeps its rules: its games still replay")
	}
	listed := labRequest(t, harness, http.MethodGet, "/api/lab/modes", "")
	var page struct {
		Modes []persistence.CustomMode `json:"modes"`
	}
	if err := json.NewDecoder(listed.Body).Decode(&page); err != nil {
		t.Fatal(err)
	}
	if len(page.Modes) != 0 {
		t.Fatalf("a retired mode should not be listed: %+v", page.Modes)
	}
}

// The community's modes are unbounded, and the catalogue is broadcast to every
// socket on connect. One must not be the other.
func TestPublishedModesStayOutOfTheLobbyCatalogue(t *testing.T) {
	harness := newLabTestServer(t)
	published := publishDash(t, harness)

	catalogue := harness.server.registry.CatalogueDefinitions()
	for _, definition := range catalogue {
		if string(definition.ID) == published.ModeID {
			t.Fatal("a community mode should not be in the lobby catalogue")
		}
	}
	if len(catalogue) != 2 {
		t.Fatalf("the catalogue should be the two shipped modes, got %d", len(catalogue))
	}

	response := labRequest(t, harness, http.MethodGet, "/api/modes", "")
	var listed []game.ModeDefinition
	if err := json.NewDecoder(response.Body).Decode(&listed); err != nil {
		t.Fatal(err)
	}
	if len(listed) != 2 {
		t.Fatalf("/api/modes should list the shipped modes, got %d", len(listed))
	}
}

// A restart has to bring the library back, or a published mode is playable until
// the next deploy and then is not.
func TestPublishedModesAreLoadedAtStartUp(t *testing.T) {
	harness := newLabTestServer(t)
	published := publishDash(t, harness)

	restarted := NewWithRegistryAndStore(freshRegistry(), harness.data, nil)
	if !restarted.registry.Has(game.ModeID(published.ModeID)) {
		t.Fatal("a published mode should be registered again after a restart")
	}
	if !restarted.registry.Playable(game.ModeID(published.ModeID)) {
		t.Fatal("and should still accept games")
	}
}

func TestTheLanguageReferenceIsServed(t *testing.T) {
	harness := newLabTestServer(t)
	response := labRequest(t, harness, http.MethodGet, "/api/lab/language", "")
	if response.StatusCode != http.StatusOK {
		t.Fatalf("the language reference returned %d", response.StatusCode)
	}
	var body bytes.Buffer
	if _, err := body.ReadFrom(response.Body); err != nil {
		t.Fatal(err)
	}
	for _, expected := range []string{"RuleSpec", "movement", "win", "beats"} {
		if !strings.Contains(body.String(), expected) {
			t.Errorf("the reference does not mention %q", expected)
		}
	}
}

func TestPartsCanBePublishedAndFound(t *testing.T) {
	harness := newLabTestServer(t)
	body, _ := json.Marshal(map[string]any{
		"partId":  "jump",
		"kind":    "movement",
		"name":    "Jump",
		"summary": "Leap the adjacent piece and land beyond it.",
		"body":    json.RawMessage(`{"kind":"jumpOver","dirs":"all8","captureJumped":true}`),
	})
	created := labRequest(t, harness, http.MethodPost, "/api/lab/parts", string(body))
	if created.StatusCode != http.StatusCreated {
		t.Fatalf("publishing a part returned %d", created.StatusCode)
	}

	listed := labRequest(t, harness, http.MethodGet, "/api/lab/parts?kind=movement&q=jump", "")
	var page struct {
		Parts []persistence.RulePart `json:"parts"`
	}
	if err := json.NewDecoder(listed.Body).Decode(&page); err != nil {
		t.Fatal(err)
	}
	if len(page.Parts) != 1 || page.Parts[0].PartID != "jump" {
		t.Fatalf("the part was not found: %+v", page.Parts)
	}

	one := labRequest(t, harness, http.MethodGet, "/api/lab/parts/jump@1", "")
	if one.StatusCode != http.StatusOK {
		t.Fatalf("fetching jump@1 returned %d", one.StatusCode)
	}

	// Publishing a mode that says it used the part credits it, which is what the
	// library's "used by" number means.
	publishDash(t, harness)
	credited, err := harness.data.Part(t.Context(), "jump", 1)
	if err != nil {
		t.Fatal(err)
	}
	if credited.UsedBy != 1 {
		t.Fatalf("the part was used once and reports %d", credited.UsedBy)
	}
}

func TestDraftsAreSavedAndListedPerAuthor(t *testing.T) {
	harness := newLabTestServer(t)
	body := fmt.Sprintf(`{"draftId":"d1","name":"Work in progress","spec":%s}`, dashJSON)
	saved := labRequest(t, harness, http.MethodPut, "/api/lab/drafts", body)
	if saved.StatusCode != http.StatusNoContent {
		t.Fatalf("saving a draft returned %d", saved.StatusCode)
	}
	listed := labRequest(t, harness, http.MethodGet, "/api/lab/drafts", "")
	var page struct {
		Drafts []persistence.LabDraft `json:"drafts"`
	}
	if err := json.NewDecoder(listed.Body).Decode(&page); err != nil {
		t.Fatal(err)
	}
	if len(page.Drafts) != 1 || page.Drafts[0].Name != "Work in progress" {
		t.Fatalf("the draft was not listed: %+v", page.Drafts)
	}
}
