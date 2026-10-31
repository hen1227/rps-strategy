package server

import (
	"context"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

func TestAppVersionGateRefusesOnlyOlderBuildsOfAGatedPlatform(t *testing.T) {
	const appStore = "https://apps.apple.com/app/id1"
	gate := appVersionGate{
		minimum:  map[string]string{appPlatformIOS: "1.2.0"},
		storeURL: map[string]string{appPlatformIOS: appStore, appPlatformAndroid: defaultAndroidStoreURL},
	}
	for _, check := range []struct {
		platform, version string
		refused           bool
	}{
		{"ios", "1.1.9", true},
		{"iOS", "1.0.0", true},
		{"ios", "1.2", false},
		{"ios", "1.2.0", false},
		// Compared as numbers: 1.10 is newer than 1.2, not older.
		{"ios", "1.10.0", false},
		// Every build before 1.0 sends no version, and is never refused.
		{"ios", "", false},
		// Neither is one that sends something that is not a version.
		{"ios", "1.0.0-beta", false},
		// A platform with no minimum is never refused.
		{"android", "0.1.0", false},
		{"web", "0.1.0", false},
		{"", "0.1.0", false},
	} {
		refusal, refused := gate.refusal(check.platform, check.version)
		if refused != check.refused {
			t.Errorf("%s %q: refused = %v, want %v", check.platform, check.version, refused, check.refused)
			continue
		}
		if !refused {
			continue
		}
		if refusal.Type != "update_required" || refusal.Message == "" || refusal.StoreURL != appStore {
			t.Errorf("%s %q: got %#v", check.platform, check.version, refusal)
		}
	}
}

func TestAppVersionGateReadsItsMinimumsFromTheEnvironment(t *testing.T) {
	t.Setenv("RPS_MIN_APP_VERSION_ANDROID", "1.3")
	// Not a version, so ignored and named at boot rather than half-applied.
	t.Setenv("RPS_MIN_APP_VERSION_IOS", "soon")
	t.Setenv("RPS_IOS_STORE_URL", "")
	t.Setenv("RPS_ANDROID_STORE_URL", "")

	gate := newAppVersionGate()
	if gate.minimum[appPlatformAndroid] != "1.3" {
		t.Fatalf("android minimum = %q, want 1.3", gate.minimum[appPlatformAndroid])
	}
	if minimum, set := gate.minimum[appPlatformIOS]; set {
		t.Fatalf("an unreadable iOS minimum was kept as %q", minimum)
	}
	if gate.storeURL[appPlatformAndroid] != defaultAndroidStoreURL {
		t.Fatalf("android store = %q, want the Play listing", gate.storeURL[appPlatformAndroid])
	}
	if gate.storeURL[appPlatformIOS] != "" {
		t.Fatalf("iOS store = %q, want none until it is set", gate.storeURL[appPlatformIOS])
	}
}

func TestOutdatedAppIsToldToUpdateBeforeItIsSignedIn(t *testing.T) {
	server := New(nil)
	server.appVersions = appVersionGate{
		minimum:  map[string]string{appPlatformAndroid: "1.1.0"},
		storeURL: map[string]string{appPlatformAndroid: defaultAndroidStoreURL},
	}
	httpServer := httptest.NewServer(server.Routes())
	defer httpServer.Close()
	websocketURL := "ws" + strings.TrimPrefix(httpServer.URL, "http") + "/ws"

	connect := func(userID, version string) *websocket.Conn {
		t.Helper()
		connection, _, err := websocket.DefaultDialer.Dial(websocketURL, nil)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = connection.Close() })
		_ = connection.SetReadDeadline(time.Now().Add(2 * time.Second))
		if err := connection.WriteJSON(ClientMessage{
			Type:       "authenticate",
			UserID:     userID,
			ProfileKey: "0123456789abcdef0123456789abcdef",
			AppVersion: version,
			Platform:   appPlatformAndroid,
		}); err != nil {
			t.Fatal(err)
		}
		return connection
	}

	old := connect("outdated-android-player", "1.0.0")
	var refusal ServerMessage
	if err := old.ReadJSON(&refusal); err != nil {
		t.Fatal(err)
	}
	if refusal.Type != "update_required" || refusal.StoreURL != defaultAndroidStoreURL {
		t.Fatalf("expected update_required with the Play listing, got %#v", refusal)
	}
	var after ServerMessage
	if err := old.ReadJSON(&after); err == nil {
		t.Fatalf("expected the socket to close after update_required, got %#v", after)
	}
	// Refused before the account was touched: a build too old to play has
	// nothing to sign in to.
	if _, err := server.data.Account(context.Background(), "outdated-android-player"); err == nil {
		t.Fatal("an outdated build was given an account")
	}

	current := connect("current-android-player", "1.1.0")
	var ready ServerMessage
	if err := current.ReadJSON(&ready); err != nil {
		t.Fatal(err)
	}
	if ready.Type != "connection_ready" {
		t.Fatalf("expected connection_ready for a current build, got %q", ready.Type)
	}
}
