package server

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/golang-jwt/jwt/v5"
	"rps-strategy/backend/internal/persistence"
)

// A token of the shape FCM hands out: an instance id, a colon, and a long
// base64url tail.
const testRegistrationToken = "dQw4w9WgXcQ:APA91bHun4MxP5egoKMwt2KZFBaFUH-1RYqx_xQ3eQ5HfZJ9" +
	"o8nZ2tYyX0u2VQ7yK1n1bS0T3p9JqXc4Z8wD7lL6mN5oP4qR3sT2uV1wX0yZ"

// fcmTestKey is generated per test rather than checked in, for the reason the
// APNs key is: a real one in a repository is a real one leaked.
func fcmTestKey(t *testing.T) *rsa.PrivateKey {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	return key
}

// fcmTestSender really signs and really posts, to one TLS endpoint the test
// controls that plays both Google's token endpoint and FCM.
func fcmTestSender(t *testing.T, handler http.HandlerFunc) (*fcmSender, *httptest.Server) {
	t.Helper()
	endpoint := httptest.NewTLSServer(handler)
	t.Cleanup(endpoint.Close)
	return &fcmSender{
		enabled:     true,
		projectID:   "rps-test",
		clientEmail: "push@rps-test.iam.gserviceaccount.com",
		tokenURI:    endpoint.URL + "/token",
		host:        endpoint.URL,
		key:         fcmTestKey(t),
		client:      endpoint.Client(),
	}, endpoint
}

// fcmEndpoint answers the token exchange and then hands every message to send.
// It counts the exchanges, because minting a token per summons is the mistake
// the cache exists to prevent.
func fcmEndpoint(t *testing.T, mints *atomic.Int32, send http.HandlerFunc) http.HandlerFunc {
	t.Helper()
	return func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path == "/token" {
			mints.Add(1)
			writer.Header().Set("content-type", "application/json")
			_, _ = io.WriteString(writer, `{"access_token":"ya29.test","expires_in":3599,"token_type":"Bearer"}`)
			return
		}
		send(writer, request)
	}
}

// The wire shape Google is entitled to expect, and the assertion behind it.
func TestAnAndroidSummonsIsAuthorisedAndAddressedToTheDevice(t *testing.T) {
	var (
		mu        sync.Mutex
		assertion string
		request   *http.Request
		message   fcmMessage
		mints     atomic.Int32
	)
	var sender *fcmSender
	sender, _ = fcmTestSender(t, func(writer http.ResponseWriter, received *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		if received.URL.Path == "/token" {
			mints.Add(1)
			_ = received.ParseForm()
			if received.Form.Get("grant_type") != "urn:ietf:params:oauth:grant-type:jwt-bearer" {
				writer.WriteHeader(http.StatusBadRequest)
				return
			}
			assertion = received.Form.Get("assertion")
			_, _ = io.WriteString(writer, `{"access_token":"ya29.test","expires_in":3599}`)
			return
		}
		request = received
		raw, _ := io.ReadAll(received.Body)
		_ = json.Unmarshal(raw, &message)
		writer.WriteHeader(http.StatusOK)
	})

	outcome := sender.send(context.Background(), testRegistrationToken, pushPayload{
		Kind:   "match_started",
		Title:  "Your game has started",
		Body:   "Grace is at the board",
		Tag:    "rps-match",
		GameID: "game-7",
	})
	if outcome != deliveryAccepted {
		t.Fatalf("a message Google accepted must count as delivered, got %v", outcome)
	}

	mu.Lock()
	defer mu.Unlock()
	if request == nil {
		t.Fatal("expected one delivery")
	}
	if request.URL.Path != "/v1/projects/rps-test/messages:send" {
		t.Fatalf("sent to %s", request.URL.Path)
	}
	if got := request.Header.Get("authorization"); got != "Bearer ya29.test" {
		t.Fatalf("expected the minted access token, got %q", got)
	}

	// The assertion is the service account's, for FCM only, and verifies with
	// the public half of the key that signed it.
	claims := jwt.MapClaims{}
	if _, err := jwt.ParseWithClaims(assertion, claims, func(token *jwt.Token) (any, error) {
		return &sender.key.PublicKey, nil
	}, jwt.WithValidMethods([]string{"RS256"}), jwt.WithAudience(sender.tokenURI)); err != nil {
		t.Fatalf("the assertion must be an RS256 JWT for the token endpoint: %v", err)
	}
	if claims["iss"] != sender.clientEmail || claims["scope"] != fcmScope {
		t.Fatalf("unexpected assertion claims: %v", claims)
	}

	body := message.Message
	if body.Token != testRegistrationToken {
		t.Fatalf("addressed to %q", body.Token)
	}
	if body.Notification.Title != "Your game has started" || body.Notification.Body != "Grace is at the board" {
		t.Fatalf("unexpected notification: %+v", body.Notification)
	}
	// The app reads these from the flat data map, and decides on `kind`
	// whether to stay quiet in the foreground.
	if body.Data["kind"] != "match_started" || body.Data["gameId"] != "game-7" {
		t.Fatalf("unexpected data: %v", body.Data)
	}
	if _, ok := body.Data["body"]; ok {
		t.Fatal(`a "body" data key is read as Expo's own format and must never be sent`)
	}
	android := body.Android
	if android.Priority != "HIGH" || android.TTL != "45s" || android.CollapseKey != "rps-match" {
		t.Fatalf("unexpected delivery options: %+v", android)
	}
	// The channel the app creates, and the tag the app finds its summons by.
	if android.Notification.ChannelID != fcmChannel || android.Notification.Tag != "rps-match" {
		t.Fatalf("unexpected Android notification: %+v", android.Notification)
	}
	if mints.Load() != 1 {
		t.Fatalf("expected one token exchange, got %d", mints.Load())
	}
}

// An access token lasts an hour, and a summons does not wait on a new one.
func TestAnAccessTokenIsMintedOnceAndReused(t *testing.T) {
	var mints atomic.Int32
	sender, _ := fcmTestSender(t, fcmEndpoint(t, &mints, func(writer http.ResponseWriter, _ *http.Request) {
		writer.WriteHeader(http.StatusOK)
	}))
	for range 3 {
		if outcome := sender.send(context.Background(), testRegistrationToken, pushPayload{}); outcome != deliveryAccepted {
			t.Fatalf("expected delivery, got %v", outcome)
		}
	}
	if mints.Load() != 1 {
		t.Fatalf("expected one token exchange for three sends, got %d", mints.Load())
	}
}

// Only a token Google says is dead costs a device. A refusal of this server's
// own credentials, or of another project's token, is a deployment fault.
func TestOnlyADeadTokenCostsAnAndroidDevice(t *testing.T) {
	cases := []struct {
		name   string
		status int
		body   string
		want   deliveryOutcome
	}{
		{"unregistered", http.StatusNotFound,
			`{"error":{"code":404,"status":"NOT_FOUND","details":[{"errorCode":"UNREGISTERED"}]}}`,
			deliveryGone},
		{"not a token", http.StatusBadRequest,
			`{"error":{"code":400,"status":"INVALID_ARGUMENT","message":"The registration token is not a valid FCM registration token"}}`,
			deliveryGone},
		{"a bad payload", http.StatusBadRequest,
			`{"error":{"code":400,"status":"INVALID_ARGUMENT","message":"Invalid value at 'message.android.ttl'"}}`,
			deliveryFailed},
		{"another project", http.StatusForbidden,
			`{"error":{"code":403,"status":"PERMISSION_DENIED","details":[{"errorCode":"SENDER_ID_MISMATCH"}]}}`,
			deliveryFailed},
		{"unavailable", http.StatusServiceUnavailable,
			`{"error":{"code":503,"status":"UNAVAILABLE","details":[{"errorCode":"UNAVAILABLE"}]}}`,
			deliveryFailed},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			var mints atomic.Int32
			sender, _ := fcmTestSender(t, fcmEndpoint(t, &mints, func(writer http.ResponseWriter, _ *http.Request) {
				writer.WriteHeader(testCase.status)
				_, _ = io.WriteString(writer, testCase.body)
			}))
			if got := sender.send(context.Background(), testRegistrationToken, pushPayload{}); got != testCase.want {
				t.Fatalf("expected %v, got %v", testCase.want, got)
			}
		})
	}
}

// A refused access token is thrown away, so the next send does not fail the
// same way until the process restarts.
func TestARefusedAccessTokenIsReplaced(t *testing.T) {
	var (
		mints atomic.Int32
		sends atomic.Int32
	)
	sender, _ := fcmTestSender(t, fcmEndpoint(t, &mints, func(writer http.ResponseWriter, _ *http.Request) {
		if sends.Add(1) == 1 {
			writer.WriteHeader(http.StatusUnauthorized)
			_, _ = io.WriteString(writer, `{"error":{"code":401,"status":"UNAUTHENTICATED"}}`)
			return
		}
		writer.WriteHeader(http.StatusOK)
	}))
	if got := sender.send(context.Background(), testRegistrationToken, pushPayload{}); got != deliveryFailed {
		t.Fatalf("a refused credential is a failure, not a dead device, got %v", got)
	}
	if got := sender.send(context.Background(), testRegistrationToken, pushPayload{}); got != deliveryAccepted {
		t.Fatalf("expected the next send to work with a new token, got %v", got)
	}
	if mints.Load() != 2 {
		t.Fatalf("expected the refused token to be replaced, got %d exchanges", mints.Load())
	}
}

// The key file the Firebase console downloads, read the way the server reads it.
func TestAServiceAccountIsLoadedOrRefusedAtBoot(t *testing.T) {
	key := fcmTestKey(t)
	der, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		t.Fatal(err)
	}
	privatePEM := string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der}))
	write := func(fields map[string]string) string {
		raw, err := json.Marshal(fields)
		if err != nil {
			t.Fatal(err)
		}
		path := filepath.Join(t.TempDir(), "service-account.json")
		if err := os.WriteFile(path, raw, 0o600); err != nil {
			t.Fatal(err)
		}
		return path
	}

	good := write(map[string]string{
		"type":         "service_account",
		"project_id":   "rps-test",
		"private_key":  privatePEM,
		"client_email": "push@rps-test.iam.gserviceaccount.com",
		"token_uri":    "https://oauth2.googleapis.com/token",
	})
	t.Setenv("RPS_FCM_CREDENTIALS_PATH", good)
	if sender := newFCMSender(); !sender.enabled || sender.projectID != "rps-test" {
		t.Fatalf("a complete service account should enable Android: %+v", sender)
	}

	for name, fields := range map[string]map[string]string{
		"no key":     {"project_id": "rps-test", "client_email": "push@x"},
		"plain http": {"project_id": "rps-test", "client_email": "push@x", "private_key": privatePEM, "token_uri": "http://example.com/token"},
		"not a key":  {"project_id": "rps-test", "client_email": "push@x", "private_key": "nonsense"},
		"no project": {"client_email": "push@x", "private_key": privatePEM},
	} {
		t.Setenv("RPS_FCM_CREDENTIALS_PATH", write(fields))
		if newFCMSender().enabled {
			t.Fatalf("%s: a service account the server cannot use must leave Android off", name)
		}
	}

	t.Setenv("RPS_FCM_CREDENTIALS_PATH", "")
	if newFCMSender().enabled {
		t.Fatal("no credentials is Android off")
	}
}

// An Android phone registers on the same route as an iPhone, saying which it is.
func TestRegisteringAnAndroidPhoneMakesItReachable(t *testing.T) {
	server := New(nil)
	server.push.fcm = &fcmSender{enabled: true}
	claimAccount(t, server.data, "ada")

	if got := server.push.transports(); !got.FCM || got.APNs {
		t.Fatalf("expected fcm only, got %+v", got)
	}
	recorder := registerDevice(t, server, http.MethodPost,
		`{"token":"`+testRegistrationToken+`","platform":"android"}`)
	if recorder.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", recorder.Code, recorder.Body)
	}
	stored, err := server.data.PushSubscriptionsFor(t.Context(), "ada")
	if err != nil {
		t.Fatal(err)
	}
	if len(stored) != 1 || stored[0].Transport != persistence.TransportFCM {
		t.Fatalf("expected one FCM row, got %#v", stored)
	}
	if !server.push.Reachable(t.Context(), "ada") {
		t.Fatal("a registered Android phone must be somewhere a summons can go")
	}

	// An iPhone's token on a server with no Apple key is still refused: the
	// two halves are configured, and answered, separately.
	if recorder := registerDevice(t, server, http.MethodPost,
		`{"token":"`+testDeviceToken+`"}`); recorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("expected 503 for an iPhone without an Apple key, got %d", recorder.Code)
	}
	if recorder := registerDevice(t, server, http.MethodPost,
		`{"token":"`+testRegistrationToken+`","platform":"windows"}`); recorder.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for a platform there is no transport for, got %d", recorder.Code)
	}

	recorder = registerDevice(t, server, http.MethodDelete, `{"token":"`+testRegistrationToken+`"}`)
	if recorder.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", recorder.Code, recorder.Body)
	}
	if server.push.Reachable(t.Context(), "ada") {
		t.Fatal("a phone that asked to be forgotten must not still look reachable")
	}

	// And a deployment with no service account says so.
	server.push.fcm = &fcmSender{}
	if recorder := registerDevice(t, server, http.MethodPost,
		`{"token":"`+testRegistrationToken+`","platform":"android"}`); recorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("expected 503 without a service account, got %d", recorder.Code)
	}
}

// One account, three kinds of device, and one summons reaching each.
func TestEveryKindOfDeviceIsSummoned(t *testing.T) {
	var (
		mu      sync.Mutex
		reached = map[string]int{}
		mints   atomic.Int32
	)
	server, endpoint := pushTestServer(t, fcmEndpoint(t, &mints, func(writer http.ResponseWriter, request *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		switch {
		case strings.HasPrefix(request.URL.Path, "/3/device/"):
			reached["apns"]++
			writer.WriteHeader(http.StatusOK)
		case strings.HasSuffix(request.URL.Path, "/messages:send"):
			reached["fcm"]++
			writer.WriteHeader(http.StatusOK)
		default:
			reached["webpush"]++
			writer.WriteHeader(http.StatusCreated)
		}
	}))
	withAPNs(t, server, endpoint)
	fcm, _ := fcmTestSender(t, nil)
	fcm.host = endpoint.URL
	fcm.tokenURI = endpoint.URL + "/token"
	fcm.client = endpoint.Client()
	server.push.fcm = fcm
	seedAccount(t, server, "ada")

	for _, subscription := range []persistence.PushSubscription{
		testSubscription(t, "ada", endpointOn(endpoint, "/browser")),
		{Endpoint: testDeviceToken, UserID: "ada", Transport: persistence.TransportAPNs},
		{Endpoint: testRegistrationToken, UserID: "ada", Transport: persistence.TransportFCM},
	} {
		if _, err := server.data.SavePushSubscription(t.Context(), subscription); err != nil {
			t.Fatal(err)
		}
	}

	report := server.push.SendTo("ada", pushPayload{Kind: "match_started", Title: "t", Body: "b", Tag: "rps-match"})
	if report.Delivered != 3 || report.Removed != 0 || report.Failed != 0 {
		t.Fatalf("expected three deliveries, got %+v", report)
	}
	mu.Lock()
	defer mu.Unlock()
	if reached["apns"] != 1 || reached["fcm"] != 1 || reached["webpush"] != 1 {
		t.Fatalf("expected one delivery of each kind, got %v", reached)
	}
}

func endpointOn(endpoint *httptest.Server, path string) string {
	parsed, _ := url.Parse(endpoint.URL)
	parsed.Path = path
	return parsed.String()
}
