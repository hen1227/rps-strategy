package server

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"rps-strategy/backend/internal/persistence"
)

// A token of the shape APNs hands out: 32 bytes, written as hex.
const testDeviceToken = "b0c1d2e3f405162738495a6b7c8d9e0fb0c1d2e3f405162738495a6b7c8d9e0f"

// apnsTestSender is a sender that really signs and really posts, to a TLS
// endpoint the test controls. The key is generated per test rather than checked
// in, because a real one in a repository is a real one leaked.
func apnsTestSender(t *testing.T, handler http.HandlerFunc) (*apnsSender, *httptest.Server) {
	t.Helper()
	endpoint := httptest.NewTLSServer(handler)
	t.Cleanup(endpoint.Close)
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	return &apnsSender{
		enabled: true,
		teamID:  "TEAMID1234",
		keyID:   "KEYID56789",
		topic:   apnsDefaultTopic,
		host:    endpoint.URL,
		key:     key,
		client:  endpoint.Client(),
	}, endpoint
}

// The wire shape Apple is entitled to expect.
func TestASummonsIsSignedAndAddressedToTheDevice(t *testing.T) {
	var (
		mu      sync.Mutex
		request *http.Request
		body    apnsBody
		rawBody []byte
	)
	sender, _ := apnsTestSender(t, func(writer http.ResponseWriter, received *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		request = received
		rawBody, _ = io.ReadAll(received.Body)
		_ = json.Unmarshal(rawBody, &body)
		writer.WriteHeader(http.StatusOK)
	})

	sent := time.Now()
	gone := sender.send(context.Background(), testDeviceToken, pushPayload{
		Kind:   "match_started",
		Title:  "Your game has started",
		Body:   "Grace is at the board",
		Tag:    "rps-match",
		GameID: "game-7",
	})
	if gone {
		t.Fatal("a delivery Apple accepted must not cost somebody their device")
	}

	mu.Lock()
	defer mu.Unlock()
	if request == nil {
		t.Fatal("expected one delivery")
	}
	// The token is in the path, which is the whole of how APNs addresses a
	// device. Getting this wrong is a 404 rather than a silence, but it is worth
	// pinning: it is the one place the stored token is used.
	if want := "/3/device/" + testDeviceToken; request.URL.Path != want {
		t.Fatalf("expected %s, got %s", want, request.URL.Path)
	}
	if got := request.Header.Get("apns-topic"); got != apnsDefaultTopic {
		t.Fatalf("a summons must name the app it is for, got %q", got)
	}
	if got := request.Header.Get("apns-push-type"); got != "alert" {
		t.Fatalf("expected an alert push, got %q", got)
	}
	if got := request.Header.Get("apns-priority"); got != "10" {
		t.Fatalf("a summons is only useful immediately, got priority %q", got)
	}
	// A summons that arrives after the seat is gone is worse than one that never
	// arrives, because the player acts on it. Same forty-five seconds as the Web
	// Push TTL.
	expiration, err := strconv.ParseInt(request.Header.Get("apns-expiration"), 10, 64)
	if err != nil {
		t.Fatalf("apns-expiration must be a unix time: %v", err)
	}
	if delta := expiration - sent.Add(pushTTL).Unix(); delta < -2 || delta > 2 {
		t.Fatalf("a summons should expire with the hold, got %ds away", delta)
	}
	if got := request.Header.Get("apns-collapse-id"); got != "rps-match" {
		t.Fatalf("a re-send must replace the banner rather than stack, got %q", got)
	}

	// The signature, verified rather than merely present. ES256 in a JWS wants
	// the raw r‖s pair rather than the ASN.1 signature crypto/ecdsa returns by
	// default, and a server that gets that wrong has every notification refused.
	authorization := request.Header.Get("authorization")
	if !strings.HasPrefix(authorization, "bearer ") {
		t.Fatalf("a request must carry a provider token, got %q", authorization)
	}
	parsed, err := jwt.Parse(
		strings.TrimPrefix(authorization, "bearer "),
		func(*jwt.Token) (any, error) { return sender.key.Public(), nil },
		jwt.WithValidMethods([]string{"ES256"}),
	)
	if err != nil {
		t.Fatalf("Apple must be able to verify the provider token: %v", err)
	}
	if got := parsed.Header["kid"]; got != sender.keyID {
		t.Fatalf("the token must name the key that signed it, got %v", got)
	}
	if got, _ := parsed.Claims.GetIssuer(); got != sender.teamID {
		t.Fatalf("the token must name the team, got %q", got)
	}

	if body.APS.Alert.Title != "Your game has started" || body.APS.Alert.Body != "Grace is at the board" {
		t.Fatalf("the alert did not survive the trip: %+v", body.APS.Alert)
	}
	// What the app reads to know which board to open, and to know a summons from
	// a test. It has to be nested under "body": that is the only place
	// expo-notifications looks for a remote notification's data, and beside
	// "aps" it would arrive as nothing at all.
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(rawBody, &raw); err != nil {
		t.Fatal(err)
	}
	if _, nested := raw["body"]; !nested {
		t.Fatalf("custom keys must be nested under \"body\", got %v", keysOf(raw))
	}
	if body.Data.GameID != "game-7" || body.Data.Kind != "match_started" {
		t.Fatalf("a summons must say which game it is about: %+v", body.Data)
	}
}

// The two answers that mean this device will never be reachable again, and the
// one that does not.
func TestOnlyAPermanentFailureCostsADevice(t *testing.T) {
	for name, answer := range map[string]struct {
		status int
		reason string
		gone   bool
	}{
		// The app was deleted.
		"unregistered": {status: http.StatusGone, reason: "Unregistered", gone: true},
		// A sandbox token sent to production, or a token that was never ours.
		"bad token": {status: http.StatusBadRequest, reason: "BadDeviceToken", gone: true},
		// Apple having a bad five minutes is not a reason to forget somebody.
		"apple is down": {status: http.StatusInternalServerError, reason: "InternalServerError"},
		// A mistake in this server's own configuration. Nothing about the device
		// is wrong, so nothing about the device is dropped.
		"our key is wrong": {status: http.StatusForbidden, reason: "InvalidProviderToken"},
		"we are throttled": {status: http.StatusTooManyRequests, reason: "TooManyRequests"},
	} {
		t.Run(name, func(t *testing.T) {
			sender, _ := apnsTestSender(t, func(writer http.ResponseWriter, _ *http.Request) {
				writer.WriteHeader(answer.status)
				_ = json.NewEncoder(writer).Encode(map[string]string{"reason": answer.reason})
			})
			if got := sender.send(context.Background(), testDeviceToken, pushPayload{Title: "hi"}); got != answer.gone {
				t.Fatalf("expected gone=%v for %s, got %v", answer.gone, answer.reason, got)
			}
		})
	}
}

// One provider token, reused. Apple refuses tokens minted more often than once
// every twenty minutes, so signing one per notification would eventually mean
// signing one that is thrown away.
func TestAProviderTokenIsMintedOnceAndRenewed(t *testing.T) {
	sender, _ := apnsTestSender(t, func(writer http.ResponseWriter, _ *http.Request) {
		writer.WriteHeader(http.StatusOK)
	})
	first, err := sender.providerToken()
	if err != nil {
		t.Fatal(err)
	}
	again, err := sender.providerToken()
	if err != nil {
		t.Fatal(err)
	}
	if first != again {
		t.Fatal("a live provider token should be reused")
	}

	sender.tokenExpiry = time.Now().Add(-time.Second)
	renewed, err := sender.providerToken()
	if err != nil {
		t.Fatal(err)
	}
	if renewed == first {
		t.Fatal("an expired provider token should be replaced")
	}
}

// A clock that jumped is recoverable; a server that keeps signing with a token
// Apple has already refused is not.
func TestAnExpiredProviderTokenIsReplacedAfterApnsSaysSo(t *testing.T) {
	var seen []string
	sender, _ := apnsTestSender(t, func(writer http.ResponseWriter, request *http.Request) {
		seen = append(seen, request.Header.Get("authorization"))
		writer.WriteHeader(http.StatusForbidden)
		_ = json.NewEncoder(writer).Encode(map[string]string{"reason": "ExpiredProviderToken"})
	})

	sender.send(context.Background(), testDeviceToken, pushPayload{Title: "hi"})
	sender.send(context.Background(), testDeviceToken, pushPayload{Title: "hi"})

	if len(seen) != 2 {
		t.Fatalf("expected two attempts, got %d", len(seen))
	}
	if seen[0] == seen[1] {
		t.Fatal("a provider token Apple called expired must not be sent twice")
	}
}

// A key Apple refuses for any other reason is this server's mistake, and
// re-minting would not fix it — so the token is kept and no device is dropped.
func TestABadKeyDoesNotMintANewTokenEveryTime(t *testing.T) {
	var seen []string
	sender, _ := apnsTestSender(t, func(writer http.ResponseWriter, request *http.Request) {
		seen = append(seen, request.Header.Get("authorization"))
		writer.WriteHeader(http.StatusForbidden)
		_ = json.NewEncoder(writer).Encode(map[string]string{"reason": "InvalidProviderToken"})
	})

	sender.send(context.Background(), testDeviceToken, pushPayload{Title: "hi"})
	sender.send(context.Background(), testDeviceToken, pushPayload{Title: "hi"})

	if len(seen) != 2 || seen[0] != seen[1] {
		t.Fatal("a live provider token should be reused even when the key is refused")
	}
}

// The ordinary state of a fresh checkout: an Apple key is one more thing a
// deployment can simply not have.
func TestADisabledAPNsSenderIsAQuietNoOp(t *testing.T) {
	hits := 0
	sender, _ := apnsTestSender(t, func(writer http.ResponseWriter, _ *http.Request) {
		hits++
		writer.WriteHeader(http.StatusOK)
	})
	sender.enabled = false

	if sender.send(context.Background(), testDeviceToken, pushPayload{Title: "hi"}) {
		t.Fatal("a disabled sender must not report anybody's device as gone")
	}
	if hits != 0 {
		t.Fatal("a disabled sender must not talk to Apple")
	}
}

// The point of the whole exercise: one summons, every device, whichever kind.
func TestBothTransportsAreSummoned(t *testing.T) {
	var (
		mu      sync.Mutex
		browser int
		phone   int
	)
	server, endpoint := pushTestServer(t, func(writer http.ResponseWriter, request *http.Request) {
		mu.Lock()
		if strings.HasPrefix(request.URL.Path, "/3/device/") {
			phone++
		} else {
			browser++
		}
		mu.Unlock()
		writer.WriteHeader(http.StatusOK)
	})
	withAPNs(t, server, endpoint)
	seedAccount(t, server, "ada")
	if _, err := server.data.SavePushSubscription(
		context.Background(),
		testSubscription(t, "ada", endpoint.URL+"/laptop"),
	); err != nil {
		t.Fatal(err)
	}
	if _, err := server.data.SavePushSubscription(context.Background(), persistence.PushSubscription{
		Endpoint:  testDeviceToken,
		UserID:    "ada",
		Transport: persistence.TransportAPNs,
	}); err != nil {
		t.Fatal(err)
	}

	if reached := server.push.SendTo("ada", pushPayload{Title: "hello", Tag: "rps-match"}); reached != 2 {
		t.Fatalf("expected both devices to be reached, got %d", reached)
	}
	mu.Lock()
	defer mu.Unlock()
	if browser != 1 || phone != 1 {
		t.Fatalf("expected one of each, got %d browsers and %d phones", browser, phone)
	}
}

// A phone Apple has disowned has to leave the away queue exactly as a dead
// browser subscription does, or the seek behind it is a ghost.
func TestALostDeviceDropsTheAwaySeek(t *testing.T) {
	server, endpoint := pushTestServer(t, func(writer http.ResponseWriter, _ *http.Request) {
		writer.WriteHeader(http.StatusGone)
		_ = json.NewEncoder(writer).Encode(map[string]string{"reason": "Unregistered"})
	})
	withAPNs(t, server, endpoint)
	seedAccount(t, server, "ada")
	if _, err := server.data.SavePushSubscription(context.Background(), persistence.PushSubscription{
		Endpoint:  testDeviceToken,
		UserID:    "ada",
		Transport: persistence.TransportAPNs,
	}); err != nil {
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
		t.Fatal("a device Apple calls Unregistered must not survive")
	}
	select {
	case userID := <-dropped:
		if userID != "ada" {
			t.Fatalf("the wrong person was dropped: %s", userID)
		}
	default:
		t.Fatal("losing the last device must take the away seek off the board")
	}
}

// A deployment with an Apple key and no VAPID keys, and the reverse. Neither
// client may be told the other's answer.
func TestEachClientIsToldAboutItsOwnTransport(t *testing.T) {
	server := New(nil)
	server.push.webEnabled = false
	server.push.apns = &apnsSender{enabled: true}
	if !server.push.enabled() {
		t.Fatal("a server that can reach a phone can call somebody back")
	}
	if got := server.push.transports(); got.WebPush || !got.APNs {
		t.Fatalf("expected apns only, got %+v", got)
	}
	// A browser subscription that predates the keys being withdrawn is not sent
	// to, because there is nothing to encrypt it with.
	if server.push.canSend(persistence.TransportWebPush) {
		t.Fatal("a Web Push row must not be delivered to without VAPID keys")
	}
	if !server.push.canSend(persistence.TransportAPNs) {
		t.Fatal("an APNs row should be deliverable when Apple is configured")
	}
}

func keysOf(raw map[string]json.RawMessage) []string {
	names := make([]string, 0, len(raw))
	for name := range raw {
		names = append(names, name)
	}
	return names
}

// registerDevice is the request the app makes, with the credential a Guest has:
// this browser's — or this phone's — own account key.
func registerDevice(t *testing.T, server *Server, method string, body string) *httptest.ResponseRecorder {
	t.Helper()
	request := httptest.NewRequest(method, "/api/push/devices?userId=ada", strings.NewReader(body))
	request.Header.Set("Authorization", "Bearer "+testProfileKey)
	recorder := httptest.NewRecorder()
	server.Routes().ServeHTTP(recorder, request)
	return recorder
}

// The entry point of the whole feature: a phone hands over a token and becomes
// somewhere a summons can go.
func TestRegisteringAPhoneMakesItReachable(t *testing.T) {
	server := New(nil)
	server.push.apns = &apnsSender{enabled: true}
	claimAccount(t, server.data, "ada")

	recorder := registerDevice(t, server, http.MethodPost, `{"token":"`+testDeviceToken+`"}`)
	if recorder.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", recorder.Code, recorder.Body)
	}
	reachable, err := server.data.HasPushSubscription(t.Context(), "ada")
	if err != nil {
		t.Fatal(err)
	}
	if !reachable {
		t.Fatal("a registered phone must be somewhere a summons can go")
	}
	stored, err := server.data.PushSubscriptionsFor(t.Context(), "ada")
	if err != nil {
		t.Fatal(err)
	}
	if len(stored) != 1 || stored[0].Transport != persistence.TransportAPNs {
		t.Fatalf("expected one APNs row, got %#v", stored)
	}

	// And turning it off again leaves nobody reachable, which is what takes the
	// away seek off the board.
	recorder = registerDevice(t, server, http.MethodDelete, `{"token":"`+testDeviceToken+`"}`)
	if recorder.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", recorder.Code, recorder.Body)
	}
	reachable, err = server.data.HasPushSubscription(t.Context(), "ada")
	if err != nil {
		t.Fatal(err)
	}
	if reachable {
		t.Fatal("a phone that asked to be forgotten must not still look reachable")
	}
}

// The two refusals, which matter because the alternative to each is an account
// that looks reachable and is not.
func TestTheDeviceRouteRefusesWhatItCannotUse(t *testing.T) {
	server := New(nil)
	server.push.apns = &apnsSender{enabled: true}
	claimAccount(t, server.data, "ada")

	if recorder := registerDevice(
		t, server, http.MethodPost, `{"token":"not-a-device-token"}`,
	); recorder.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for a token that could never be delivered to, got %d", recorder.Code)
	}

	// A deployment with no Apple key says so, rather than storing a token it
	// will never send to.
	server.push.apns = &apnsSender{}
	if recorder := registerDevice(
		t, server, http.MethodPost, `{"token":"`+testDeviceToken+`"}`,
	); recorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("expected 503 without an Apple key, got %d", recorder.Code)
	}

	reachable, err := server.data.HasPushSubscription(t.Context(), "ada")
	if err != nil {
		t.Fatal(err)
	}
	if reachable {
		t.Fatal("a refused registration must leave nobody looking reachable")
	}
}
