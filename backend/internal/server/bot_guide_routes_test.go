package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"rps-strategy/backend/internal/botclient"
)

// The guide endpoint carries every document the package embeds.
//
// One test rather than one per document, because the failure it exists for is
// adding a third file to `embed.go` and forgetting the payload — the website
// then renders an empty page for a document that is right there on disk.
func TestTheGuideEndpointServesEveryDocument(t *testing.T) {
	server, _ := archiveTestServer(t)

	recorder := httptest.NewRecorder()
	server.Routes().ServeHTTP(recorder, httptest.NewRequest(
		http.MethodGet, "/api/bot/guide", nil,
	))
	if recorder.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", recorder.Code, recorder.Body)
	}

	var payload map[string]any
	if err := json.Unmarshal(recorder.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	for _, document := range []struct {
		key  string
		want string
	}{
		{"guide", botclient.Guide()},
		{"protocol", botclient.Protocol()},
		{"notation", botclient.Notation()},
	} {
		served, ok := payload[document.key].(string)
		if !ok {
			t.Errorf("the guide endpoint sent no %q", document.key)
			continue
		}
		if served != document.want {
			t.Errorf("%q is not the embedded document", document.key)
		}
		// A document that begins with its own heading is what the page reads as
		// a title; one that does not renders untitled.
		if !strings.HasPrefix(served, "# ") {
			t.Errorf("%q does not open with a heading", document.key)
		}
	}
}
