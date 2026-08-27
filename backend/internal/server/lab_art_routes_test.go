package server

import (
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"

	"rps-strategy/backend/internal/persistence"
)

const artAuthorID = "art-author"

// registeredArtAuthor upgrades the harness's guest into a real account and
// hands back a session token, because uploading is the one thing in the Lab a
// guest may not do.
func registeredArtAuthor(t *testing.T, harness labTestServer) string {
	t.Helper()
	if _, err := harness.data.ClaimAccountWithDiscord(
		t.Context(), artAuthorID, "ArtAuthor", "discord-art", "art",
	); err != nil {
		t.Fatal(err)
	}
	token, err := harness.data.CreateSession(t.Context(), artAuthorID)
	if err != nil {
		t.Fatal(err)
	}
	return token
}

func artRequest(
	t *testing.T,
	harness labTestServer,
	token, method, path, body string,
) *http.Response {
	t.Helper()
	request, err := http.NewRequest(method, harness.http.URL+path, strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Content-Type", "application/json")
	if token != "" {
		request.Header.Set("Authorization", "Bearer "+token)
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { response.Body.Close() })
	return response
}

func uploadArt(t *testing.T, harness labTestServer, token, role string, raw []byte) string {
	t.Helper()
	body, _ := json.Marshal(map[string]any{
		"role": role,
		"data": base64.StdEncoding.EncodeToString(raw),
	})
	response := artRequest(t, harness, token, http.MethodPost, "/api/lab/art", string(body))
	if response.StatusCode != http.StatusCreated {
		payload, _ := io.ReadAll(response.Body)
		t.Fatalf("upload returned %d: %s", response.StatusCode, payload)
	}
	var decoded struct {
		Art persistence.ArtAsset `json:"art"`
	}
	if err := json.NewDecoder(response.Body).Decode(&decoded); err != nil {
		t.Fatal(err)
	}
	return decoded.Art.ArtID
}

// Publishing a mode is open to a guest and uploading a picture is not, which is
// the one place the Lab deliberately asks for more than it does elsewhere.
func TestAGuestMayNotAddAPicture(t *testing.T) {
	harness := newLabTestServer(t)
	body, _ := json.Marshal(map[string]any{
		"role": "piece",
		"data": base64.StdEncoding.EncodeToString(smallPNG(t, 64)),
	})

	// The guest identity the rest of the Lab accepts.
	response := labRequest(t, harness, http.MethodPost, "/api/lab/art", string(body))
	if response.StatusCode != http.StatusUnauthorized && response.StatusCode != http.StatusForbidden {
		t.Fatalf("a guest uploaded a picture: %d", response.StatusCode)
	}
	// And nothing at all.
	if response := artRequest(t, harness, "", http.MethodPost, "/api/lab/art", string(body)); response.StatusCode != http.StatusUnauthorized {
		t.Fatalf("an anonymous request uploaded a picture: %d", response.StatusCode)
	}
}

func TestAPictureIsServedAsWhatItIsAndCachedByItsOwnID(t *testing.T) {
	harness := newLabTestServer(t)
	token := registeredArtAuthor(t, harness)
	artID := uploadArt(t, harness, token, "piece", smallPNG(t, 64))

	response := artRequest(t, harness, "", http.MethodGet, "/api/lab/art/"+artID, "")
	if response.StatusCode != http.StatusOK {
		t.Fatalf("serving answered %d", response.StatusCode)
	}
	for header, want := range map[string]string{
		"Content-Type":           "image/png",
		"X-Content-Type-Options": "nosniff",
	} {
		if got := response.Header.Get(header); got != want {
			t.Errorf("%s is %q, want %q", header, got, want)
		}
	}
	if !strings.Contains(response.Header.Get("Cache-Control"), "immutable") {
		t.Errorf("a content-addressed picture should be cacheable: %q",
			response.Header.Get("Cache-Control"))
	}
	if response.Header.Get("Content-Security-Policy") == "" {
		t.Error("the one route serving a stranger's file should carry a policy")
	}
	if response.Header.Get("ETag") == "" {
		t.Error("no ETag")
	}
}

// A different answer for "no such picture" and "taken down" is an oracle: it
// tells a stranger what this server is holding.
func TestAnUnknownAndATakenDownPictureAnswerIdentically(t *testing.T) {
	harness := newLabTestServer(t)
	token := registeredArtAuthor(t, harness)
	artID := uploadArt(t, harness, token, "piece", smallPNG(t, 64))
	if err := harness.data.TakeArtDown(t.Context(), artID, "test"); err != nil {
		t.Fatal(err)
	}

	takenDown := artRequest(t, harness, "", http.MethodGet, "/api/lab/art/"+artID, "")
	downBody, _ := io.ReadAll(takenDown.Body)
	unknown := artRequest(t, harness, "", http.MethodGet,
		"/api/lab/art/img:"+strings.Repeat("0", 32), "")
	unknownBody, _ := io.ReadAll(unknown.Body)

	if takenDown.StatusCode != http.StatusNotFound || unknown.StatusCode != http.StatusNotFound {
		t.Fatalf("statuses are %d and %d", takenDown.StatusCode, unknown.StatusCode)
	}
	if string(downBody) != string(unknownBody) {
		t.Fatalf("the two answers differ:\n%s\n%s", downBody, unknownBody)
	}
}

func TestAMalformedPictureIDNeverReachesTheDatabase(t *testing.T) {
	harness := newLabTestServer(t)
	for _, bad := range []string{"nonsense", "img:", "img:zzzz", "img:" + strings.Repeat("a", 31)} {
		response := artRequest(t, harness, "", http.MethodGet, "/api/lab/art/"+bad, "")
		if response.StatusCode != http.StatusNotFound {
			t.Errorf("%q answered %d", bad, response.StatusCode)
		}
	}
}

func TestAPictureIsRefusedWithAReasonThePersonCanAct(t *testing.T) {
	harness := newLabTestServer(t)
	token := registeredArtAuthor(t, harness)
	body, _ := json.Marshal(map[string]any{
		"role": "piece",
		"data": base64.StdEncoding.EncodeToString(pngOf(t, 64, 32)),
	})
	response := artRequest(t, harness, token, http.MethodPost, "/api/lab/art", string(body))
	if response.StatusCode != http.StatusBadRequest {
		t.Fatalf("a rectangular piece answered %d", response.StatusCode)
	}
	payload, _ := io.ReadAll(response.Body)
	if !strings.Contains(string(payload), "square") {
		t.Fatalf("the refusal should say what is wrong: %s", payload)
	}
}

func TestABase64DataURLIsAcceptedTheWayAnAgentWillSendIt(t *testing.T) {
	harness := newLabTestServer(t)
	token := registeredArtAuthor(t, harness)
	body, _ := json.Marshal(map[string]any{
		"role": "piece",
		"data": "data:image/png;base64," + base64.StdEncoding.EncodeToString(smallPNG(t, 64)),
	})
	response := artRequest(t, harness, token, http.MethodPost, "/api/lab/art", string(body))
	if response.StatusCode != http.StatusCreated {
		payload, _ := io.ReadAll(response.Body)
		t.Fatalf("a data URL answered %d: %s", response.StatusCode, payload)
	}
}

func TestExactlyOneOfBytesOrAURLIsRequired(t *testing.T) {
	harness := newLabTestServer(t)
	token := registeredArtAuthor(t, harness)
	for _, body := range []map[string]any{
		{"role": "piece"},
		{"role": "piece", "data": "AAAA", "url": "https://example.com/a.png"},
		{"role": "nowhere", "data": "AAAA"},
	} {
		encoded, _ := json.Marshal(body)
		response := artRequest(t, harness, token, http.MethodPost, "/api/lab/art", string(encoded))
		if response.StatusCode != http.StatusBadRequest {
			t.Errorf("%v answered %d", body, response.StatusCode)
		}
	}
}

// The regression test for the whole degradation story: a name this build does
// not recognise must still publish, and still warn.
func TestAnUnknownBundledArtNameStillPublishes(t *testing.T) {
	harness := newLabTestServer(t)
	specWithArt := strings.Replace(dashJSON,
		`"symbol": "R"`, `"symbol": "R", "art": "lizard"`, 1)
	if specWithArt == dashJSON {
		t.Fatal("the fixture changed shape; this test is no longer editing it")
	}
	body, _ := json.Marshal(map[string]any{
		"slug": "lizardy",
		"spec": json.RawMessage(specWithArt),
	})
	response := labRequest(t, harness, http.MethodPost, "/api/lab/modes", string(body))
	if response.StatusCode != http.StatusCreated {
		payload, _ := io.ReadAll(response.Body)
		t.Fatalf("an unknown artwork name blocked publishing: %d %s", response.StatusCode, payload)
	}
}

func TestPublishingRefusesAPictureThatIsNotThere(t *testing.T) {
	harness := newLabTestServer(t)
	missing := "img:" + strings.Repeat("a", 32)
	specWithArt := strings.Replace(dashJSON,
		`"symbol": "R"`, `"symbol": "R", "art": "`+missing+`"`, 1)
	body, _ := json.Marshal(map[string]any{
		"slug": "ghosty",
		"spec": json.RawMessage(specWithArt),
	})
	response := labRequest(t, harness, http.MethodPost, "/api/lab/modes", string(body))
	if response.StatusCode != http.StatusBadRequest {
		t.Fatalf("a mode referring to nothing published: %d", response.StatusCode)
	}
	payload, _ := io.ReadAll(response.Body)
	if !strings.Contains(string(payload), "pieces[0].art") {
		t.Fatalf("the refusal should name where the reference is: %s", payload)
	}
}

// Taking a picture down must not un-publish the mode. The mode is immutable and
// its archived games replay through it; what changes is that its pieces draw
// letters, which the client already does for any picture it cannot load.
func TestTakingAPictureDownLeavesTheModePlayable(t *testing.T) {
	harness := newLabTestServer(t)
	token := registeredArtAuthor(t, harness)
	artID := uploadArt(t, harness, token, "piece", smallPNG(t, 64))

	specWithArt := strings.Replace(dashJSON,
		`"symbol": "R"`, `"symbol": "R", "art": "`+artID+`"`, 1)
	body, _ := json.Marshal(map[string]any{
		"slug": "arty",
		"spec": json.RawMessage(specWithArt),
	})
	// Published by the account that owns the picture.
	published := artRequest(t, harness, token, http.MethodPost, "/api/lab/modes", string(body))
	if published.StatusCode != http.StatusCreated {
		payload, _ := io.ReadAll(published.Body)
		t.Fatalf("publishing with a picture answered %d: %s", published.StatusCode, payload)
	}

	if err := harness.data.TakeArtDown(t.Context(), artID, "test"); err != nil {
		t.Fatal(err)
	}
	mode := artRequest(t, harness, "", http.MethodGet, "/api/lab/modes/custom:arty@1", "")
	if mode.StatusCode != http.StatusOK {
		t.Fatalf("a takedown un-published the mode: %d", mode.StatusCode)
	}
	if !harness.server.registry.Has("custom:arty@1") {
		t.Fatal("a takedown removed the mode from the registry")
	}
	image := artRequest(t, harness, "", http.MethodGet, "/api/lab/art/"+artID, "")
	if image.StatusCode != http.StatusNotFound {
		t.Fatalf("the picture is still being served: %d", image.StatusCode)
	}
}

func TestAPictureCannotBePinnedIntoSomebodyElsesMode(t *testing.T) {
	harness := newLabTestServer(t)
	token := registeredArtAuthor(t, harness)
	artID := uploadArt(t, harness, token, "piece", smallPNG(t, 64))

	specWithArt := strings.Replace(dashJSON,
		`"symbol": "R"`, `"symbol": "R", "art": "`+artID+`"`, 1)
	body, _ := json.Marshal(map[string]any{
		"slug": "borrowed",
		"spec": json.RawMessage(specWithArt),
	})
	// labRequest is the *other* account, the harness's guest.
	response := labRequest(t, harness, http.MethodPost, "/api/lab/modes", string(body))
	if response.StatusCode != http.StatusBadRequest {
		t.Fatalf("somebody else's unpublished picture was published: %d", response.StatusCode)
	}
	payload, _ := io.ReadAll(response.Body)
	if !strings.Contains(string(payload), "somebody else") {
		t.Fatalf("the refusal should say whose it is: %s", payload)
	}
}

func TestAnAccountCanListItsOwnPicturesToReuseThem(t *testing.T) {
	harness := newLabTestServer(t)
	token := registeredArtAuthor(t, harness)
	uploadArt(t, harness, token, "piece", smallPNG(t, 64))
	uploadArt(t, harness, token, "piece", smallPNG(t, 48))

	response := artRequest(t, harness, token, http.MethodGet, "/api/lab/art", "")
	if response.StatusCode != http.StatusOK {
		t.Fatalf("listing answered %d", response.StatusCode)
	}
	var decoded struct {
		Art []struct {
			Art persistence.ArtAsset `json:"art"`
			URL string               `json:"url"`
		} `json:"art"`
	}
	if err := json.NewDecoder(response.Body).Decode(&decoded); err != nil {
		t.Fatal(err)
	}
	if len(decoded.Art) != 2 {
		t.Fatalf("listed %d pictures, expected 2", len(decoded.Art))
	}
	if decoded.Art[0].URL == "" {
		t.Error("a listed picture should say where it is served")
	}
}
