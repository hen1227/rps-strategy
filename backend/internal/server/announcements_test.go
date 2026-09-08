package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"rps-strategy/backend/internal/persistence"
)

// The reason the notice is held rather than only broadcast: the person who
// reloads the page five seconds after the announcement went out is exactly the
// person who was told nothing, and exactly the person it was written for.
func TestANoticeIsHeldForWhoeverArrivesNext(t *testing.T) {
	server := New(nil)
	server.PostNotice("Sorry — restarting now to fix the clock bug.", "warning", 0)

	held := server.notices.current()
	if held == nil || held.Text != "Sorry — restarting now to fix the clock bug." {
		t.Fatalf("the notice was not held for the next arrival, got %+v", held)
	}
	if held.Tone != "warning" {
		t.Fatalf("the tone did not survive, got %q", held.Tone)
	}
}

// An apology for a restart that happened an hour ago makes a working server
// look broken, so a notice nobody clears goes on its own.
func TestANoticeExpires(t *testing.T) {
	server := New(nil)
	server.PostNotice("Back shortly.", "notice", time.Millisecond)
	time.Sleep(5 * time.Millisecond)
	if server.notices.current() != nil {
		t.Fatal("an expired notice was still being shown")
	}
}

func TestClearingANoticeTakesTheBannerDown(t *testing.T) {
	server := New(nil)
	watcher := fakeClient(t, server, "watcher", false)
	server.PostNotice("Back shortly.", "notice", 0)
	drain(watcher)

	if !server.ClearNotice() {
		t.Fatal("clearing a standing notice reported nothing to clear")
	}
	cleared, told := messageOfType(drain(watcher), "server_notice")
	if !told || cleared.Notice == nil || cleared.Notice.Text != "" {
		t.Fatalf("the banner was not told to go, got %+v", cleared.Notice)
	}
	if server.ClearNotice() {
		t.Fatal("clearing nothing reported that something was cleared")
	}
}

// Everybody hears it, engines included: rpsbot.py prints what the server says,
// so a bot owner tailing their log finds out at the same time as everybody at a
// browser.
func TestANoticeReachesEveryoneConnected(t *testing.T) {
	server := New(nil)
	human := fakeClient(t, server, "human", false)
	engine := fakeClient(t, server, "engine", true)

	server.PostNotice("Emergency restart, sorry about that.", "warning", 0)

	for name, client := range map[string]*Client{"human": human, "engine": engine} {
		notice, told := messageOfType(drain(client), "server_notice")
		if !told || notice.Notice == nil ||
			notice.Notice.Text != "Emergency restart, sorry about that." {
			t.Fatalf("the %s was not told", name)
		}
	}
}

// The route, end to end, because it is the one an administrator actually
// touches — and because an empty announcement is a banner that says nothing and
// cannot be dismissed by reading it.
func TestThePostNoticeRouteRefusesAnEmptyAnnouncement(t *testing.T) {
	data, err := persistence.Open(":memory:")
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	t.Cleanup(func() { _ = data.Close() })

	const adminToken = "0123456789abcdef0123456789abcdef"
	server := NewWithStoreAndAdminToken(data, nil, adminToken)
	routes := server.Routes()

	post := func(body string) *httptest.ResponseRecorder {
		request := httptest.NewRequest(
			http.MethodPost, "/api/admin/notice", strings.NewReader(body),
		)
		request.Header.Set("Authorization", "Bearer "+adminToken)
		request.Header.Set("Content-Type", "application/json")
		recorder := httptest.NewRecorder()
		routes.ServeHTTP(recorder, request)
		return recorder
	}

	if code := post(`{"text":"   "}`).Code; code != http.StatusBadRequest {
		t.Fatalf("an empty announcement was accepted with %d", code)
	}

	recorder := post(`{"text":"Restarting in one minute.","tone":"warning"}`)
	if recorder.Code != http.StatusOK {
		t.Fatalf("a good announcement was refused with %d", recorder.Code)
	}
	var posted ServerNotice
	if err := json.Unmarshal(recorder.Body.Bytes(), &posted); err != nil {
		t.Fatalf("decode reply: %v", err)
	}
	if posted.ID == "" || posted.Tone != "warning" {
		t.Fatalf("the reply did not describe the notice, got %+v", posted)
	}

	// Public, because a client reconnecting over HTTP before its socket is up
	// should be able to read the same sentence.
	request := httptest.NewRequest(http.MethodGet, "/api/notice", nil)
	recorder = httptest.NewRecorder()
	routes.ServeHTTP(recorder, request)
	if !strings.Contains(recorder.Body.String(), "Restarting in one minute.") {
		t.Fatalf("the public route did not report the notice, got %s", recorder.Body)
	}
}
