package server

import (
	"context"
	"crypto/ecdh"
	"crypto/rand"
	"encoding/base64"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"rps-strategy/backend/internal/persistence"
)

// A VAPID pair, generated once so the tests below cost one key generation
// rather than one each.
const (
	testVAPIDPublic  = "BDvxBCimX9jqk-bzvVYj_o4ZcA3anoZUxhFTXCYC3cxZpK8bH0V59LeN7_yxBFEKU5yepXFNi48HlAGpCCANbHs"
	testVAPIDPrivate = "hcUq3Q0hJdWBBSMEUUuc7pQC0OqI5xVaLHzTvFyD3Wg"
)

// testSubscription builds a subscription against a real P-256 key, because the
// encryption path validates the point and silently produces nothing if it is
// not on the curve — which is the failure this whole feature cannot tolerate.
func testSubscription(t *testing.T, userID string, endpoint string) persistence.PushSubscription {
	t.Helper()
	private, err := ecdh.P256().GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	auth := make([]byte, 16)
	if _, err := rand.Read(auth); err != nil {
		t.Fatal(err)
	}
	return persistence.PushSubscription{
		Endpoint: endpoint,
		UserID:   userID,
		P256dh:   base64.RawURLEncoding.EncodeToString(private.PublicKey().Bytes()),
		Auth:     base64.RawURLEncoding.EncodeToString(auth),
	}
}

// pushTestServer is a server whose push sender really encrypts and really
// posts, to a TLS endpoint the test controls.
func pushTestServer(t *testing.T, handler http.HandlerFunc) (*Server, *httptest.Server) {
	t.Helper()
	endpoint := httptest.NewTLSServer(handler)
	t.Cleanup(endpoint.Close)

	server := New(nil)
	server.push.webEnabled = true
	server.push.publicKey = testVAPIDPublic
	server.push.privateKey = testVAPIDPrivate
	server.push.subject = "mailto:test@example.com"
	server.push.client = endpoint.Client()
	return server, endpoint
}

// withAPNs points a test server's Apple half at the same endpoint its Web Push
// half already uses, so a mixed account can be summoned in one handler.
func withAPNs(t *testing.T, server *Server, endpoint *httptest.Server) {
	t.Helper()
	sender, _ := apnsTestSender(t, nil)
	sender.host = endpoint.URL
	sender.client = endpoint.Client()
	server.push.apns = sender
}

func seedAccount(t *testing.T, server *Server, userID string) {
	t.Helper()
	if _, err := server.data.EnsureAccount(context.Background(), userID, "Tester"); err != nil {
		t.Fatal(err)
	}
}

// The wire shape a push service is entitled to expect.
func TestANotificationIsEncryptedAndSigned(t *testing.T) {
	var (
		mu       sync.Mutex
		requests []*http.Request
		bodies   []int
	)
	server, endpoint := pushTestServer(t, func(writer http.ResponseWriter, request *http.Request) {
		mu.Lock()
		requests = append(requests, request)
		bodies = append(bodies, int(request.ContentLength))
		mu.Unlock()
		writer.WriteHeader(http.StatusCreated)
	})
	seedAccount(t, server, "ada")
	if _, err := server.data.SavePushSubscription(
		context.Background(),
		testSubscription(t, "ada", endpoint.URL+"/ada"),
	); err != nil {
		t.Fatal(err)
	}

	server.push.Send("ada", pushPayload{
		Kind:  "match_found",
		Title: "Your game is ready",
		Body:  "Grace is waiting at the board",
		Tag:   "rps-match",
	})

	mu.Lock()
	defer mu.Unlock()
	if len(requests) != 1 {
		t.Fatalf("expected one delivery, got %d", len(requests))
	}
	request := requests[0]
	if got := request.Header.Get("Content-Encoding"); got != "aes128gcm" {
		t.Fatalf("a payload must be encrypted per RFC 8291, got %q", got)
	}
	if authorization := request.Header.Get("Authorization"); !strings.HasPrefix(authorization, "vapid t=") {
		t.Fatalf("a request must carry a VAPID JWT, got %q", authorization)
	}
	if got := request.Header.Get("TTL"); got != "45" {
		// A summons that arrives after the seat is gone is worse than one that
		// never arrives, because the player acts on it.
		t.Fatalf("a summons should expire with the hold, got TTL %q", got)
	}
	if bodies[0] <= 0 {
		t.Fatal("a notification should have a body")
	}
}

// The pruning that keeps the away queue honest.
func TestAGoneSubscriptionIsPrunedAndItsSeekDropped(t *testing.T) {
	server, endpoint := pushTestServer(t, func(writer http.ResponseWriter, _ *http.Request) {
		writer.WriteHeader(http.StatusGone)
	})
	seedAccount(t, server, "ada")
	subscription := testSubscription(t, "ada", endpoint.URL+"/ada")
	if _, err := server.data.SavePushSubscription(context.Background(), subscription); err != nil {
		t.Fatal(err)
	}

	dropped := make(chan string, 1)
	server.push.onUnreachable = func(userID string) { dropped <- userID }

	server.push.Send("ada", pushPayload{Title: "hello"})

	reachable, err := server.data.HasPushSubscription(context.Background(), "ada")
	if err != nil {
		t.Fatal(err)
	}
	if reachable {
		t.Fatal("a subscription the push service calls Gone must not survive")
	}
	select {
	case userID := <-dropped:
		if userID != "ada" {
			t.Fatalf("the wrong person was dropped: %s", userID)
		}
	default:
		t.Fatal("losing the last subscription must take the away seek off the board")
	}
}

// A push service having a bad five minutes is not a reason to forget somebody.
func TestAServerErrorDoesNotPrune(t *testing.T) {
	server, endpoint := pushTestServer(t, func(writer http.ResponseWriter, _ *http.Request) {
		writer.WriteHeader(http.StatusInternalServerError)
	})
	seedAccount(t, server, "ada")
	if _, err := server.data.SavePushSubscription(
		context.Background(),
		testSubscription(t, "ada", endpoint.URL+"/ada"),
	); err != nil {
		t.Fatal(err)
	}

	server.push.Send("ada", pushPayload{Title: "hello"})

	reachable, err := server.data.HasPushSubscription(context.Background(), "ada")
	if err != nil {
		t.Fatal(err)
	}
	if !reachable {
		t.Fatal("a transient failure must not cost somebody their subscription")
	}
}

// The ordinary state of a fresh checkout, and of any deployment given no keys of
// either kind.
func TestADisabledSenderIsAQuietNoOp(t *testing.T) {
	server := New(nil)
	if server.push.enabled() {
		t.Fatal("push should be off without VAPID or Apple keys")
	}
	if server.push.Reachable(context.Background(), "ada") {
		t.Fatal("nobody is reachable when the server cannot send")
	}
	// Neither panics nor touches the store.
	server.push.Send("ada", pushPayload{Title: "hello"})
}

// One person, two browsers.
func TestEveryBrowserIsNotified(t *testing.T) {
	var mu sync.Mutex
	hits := 0
	server, endpoint := pushTestServer(t, func(writer http.ResponseWriter, _ *http.Request) {
		mu.Lock()
		hits++
		mu.Unlock()
		writer.WriteHeader(http.StatusCreated)
	})
	seedAccount(t, server, "ada")
	for _, path := range []string{"/phone", "/laptop"} {
		if _, err := server.data.SavePushSubscription(
			context.Background(),
			testSubscription(t, "ada", endpoint.URL+path),
		); err != nil {
			t.Fatal(err)
		}
	}

	server.push.Send("ada", pushPayload{Title: "hello"})

	mu.Lock()
	defer mu.Unlock()
	if hits != 2 {
		t.Fatalf("expected both browsers to be reached, got %d", hits)
	}
}

// A malformed key stores cleanly and then silently never delivers, so it has to
// be refused at the moment somebody could still be told.
func TestMalformedKeysAreRefusedAtSubscribeTime(t *testing.T) {
	valid := testSubscription(t, "ada", "https://push.example.com/ada")
	if err := validatePushKeys(valid.P256dh, valid.Auth); err != nil {
		t.Fatalf("a real subscription should be accepted: %v", err)
	}
	for name, keys := range map[string][2]string{
		"not base64":       {"!!!!", valid.Auth},
		"wrong length":     {base64.RawURLEncoding.EncodeToString([]byte{4, 1, 2}), valid.Auth},
		"not on the curve": {base64.RawURLEncoding.EncodeToString(make([]byte, 65)), valid.Auth},
		"short auth":       {valid.P256dh, base64.RawURLEncoding.EncodeToString([]byte{1, 2, 3})},
	} {
		if err := validatePushKeys(keys[0], keys[1]); err == nil {
			t.Fatalf("%s should have been refused", name)
		}
	}
}
