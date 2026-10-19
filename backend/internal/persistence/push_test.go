package persistence

import (
	"context"
	"errors"
	"strings"
	"testing"
)

func pushTestStore(t *testing.T) *Store {
	t.Helper()
	store, err := Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	if _, err := store.EnsureAccount(context.Background(), "alice", "Alice"); err != nil {
		t.Fatal(err)
	}
	return store
}

func testSubscription(userID string, endpoint string) PushSubscription {
	return PushSubscription{
		Endpoint: endpoint,
		UserID:   userID,
		P256dh:   "BOrCVKq0zSJPYbXvT9GJl1S2zPQ3vY7ZlU0f4",
		Auth:     "k9XKQXG7YbXPQzS1vY7Zlg",
	}
}

// The endpoint is the browser's own name for a subscription, so re-subscribing
// must move the row rather than add one.
func TestReSubscribingReplacesTheSameEndpoint(t *testing.T) {
	store := pushTestStore(t)
	ctx := context.Background()
	endpoint := "https://push.example.com/abc"

	if _, err := store.SavePushSubscription(ctx, testSubscription("alice", endpoint)); err != nil {
		t.Fatal(err)
	}
	if _, err := store.SavePushSubscription(ctx, testSubscription("alice", endpoint)); err != nil {
		t.Fatal(err)
	}

	subscriptions, err := store.PushSubscriptionsFor(ctx, "alice")
	if err != nil {
		t.Fatal(err)
	}
	if len(subscriptions) != 1 {
		t.Fatalf("one browser is one row, got %d", len(subscriptions))
	}
}

// One person legitimately has a phone and a laptop.
func TestOneAccountCanHaveSeveralBrowsers(t *testing.T) {
	store := pushTestStore(t)
	ctx := context.Background()
	for _, endpoint := range []string{"https://push.example.com/a", "https://push.example.com/b"} {
		if _, err := store.SavePushSubscription(ctx, testSubscription("alice", endpoint)); err != nil {
			t.Fatal(err)
		}
	}
	reachable, err := store.HasPushSubscription(ctx, "alice", TransportWebPush)
	if err != nil || !reachable {
		t.Fatalf("expected alice to be reachable: %v", err)
	}
	subscriptions, err := store.PushSubscriptionsFor(ctx, "alice")
	if err != nil {
		t.Fatal(err)
	}
	if len(subscriptions) != 2 {
		t.Fatalf("expected two browsers, got %d", len(subscriptions))
	}
}

func TestPruningTheLastSubscriptionMakesSomebodyUnreachable(t *testing.T) {
	store := pushTestStore(t)
	ctx := context.Background()
	endpoint := "https://push.example.com/abc"
	if _, err := store.SavePushSubscription(ctx, testSubscription("alice", endpoint)); err != nil {
		t.Fatal(err)
	}
	if err := store.DeletePushSubscription(ctx, endpoint); err != nil {
		t.Fatal(err)
	}
	reachable, err := store.HasPushSubscription(ctx, "alice", TransportWebPush, TransportAPNs)
	if err != nil {
		t.Fatal(err)
	}
	if reachable {
		t.Fatal("a pruned subscription must not leave somebody looking reachable")
	}
}

// A push service is always https. Refusing anything else keeps the server from
// being talked into making requests to arbitrary hosts.
func TestASubscriptionMustBeHttps(t *testing.T) {
	store := pushTestStore(t)
	subscription := testSubscription("alice", "http://push.example.com/abc")
	if _, err := store.SavePushSubscription(context.Background(), subscription); err == nil {
		t.Fatal("expected a plaintext endpoint to be refused")
	}
}

// A device token, of the shape APNs hands out: 32 bytes written as hex.
const testDeviceToken = "b0c1d2e3f405162738495a6b7c8d9e0fb0c1d2e3f405162738495a6b7c8d9e0f"

func testDevice(userID string, token string) PushSubscription {
	return PushSubscription{Endpoint: token, UserID: userID, Transport: TransportAPNs}
}

// A phone and a laptop are one question with one answer, which is the whole
// reason both live in this table.
func TestABrowserAndAPhoneAreBothReachable(t *testing.T) {
	store := pushTestStore(t)
	ctx := context.Background()
	if _, err := store.SavePushSubscription(ctx, testSubscription("alice", "https://push.example.com/a")); err != nil {
		t.Fatal(err)
	}
	if _, err := store.SavePushSubscription(ctx, testDevice("alice", testDeviceToken)); err != nil {
		t.Fatal(err)
	}

	subscriptions, err := store.PushSubscriptionsFor(ctx, "alice")
	if err != nil {
		t.Fatal(err)
	}
	if len(subscriptions) != 2 {
		t.Fatalf("expected two addresses, got %d", len(subscriptions))
	}
	kinds := map[PushTransport]int{}
	for _, subscription := range subscriptions {
		kinds[subscription.Transport]++
	}
	if kinds[TransportWebPush] != 1 || kinds[TransportAPNs] != 1 {
		t.Fatalf("each address must remember which kind it is: %v", kinds)
	}
}

// Reachable means reachable by a kind of address the caller can deliver to. A
// phone registered while this server held an Apple key is no way in once the
// key is gone, and counting it would keep a seek for somebody no summons can
// reach.
func TestOnlyTheNamedKindsOfAddressCount(t *testing.T) {
	store := pushTestStore(t)
	ctx := context.Background()
	if _, err := store.SavePushSubscription(ctx, testDevice("alice", testDeviceToken)); err != nil {
		t.Fatal(err)
	}

	for name, check := range map[string]struct {
		transports []PushTransport
		want       bool
	}{
		"a phone, asked about phones":   {transports: []PushTransport{TransportAPNs}, want: true},
		"a phone, asked about browsers": {transports: []PushTransport{TransportWebPush}, want: false},
		"a phone, asked about either":   {transports: []PushTransport{TransportWebPush, TransportAPNs}, want: true},
		"naming no kind at all":         {transports: nil, want: false},
	} {
		reachable, err := store.HasPushSubscription(ctx, "alice", check.transports...)
		if err != nil {
			t.Fatal(err)
		}
		if reachable != check.want {
			t.Fatalf("%s: expected reachable=%v, got %v", name, check.want, reachable)
		}
	}
}

// A row written before iOS existed is a Web Push row, and so is one from any
// caller that does not mention a transport.
func TestAnUnsaidTransportIsWebPush(t *testing.T) {
	store := pushTestStore(t)
	saved, err := store.SavePushSubscription(
		context.Background(),
		testSubscription("alice", "https://push.example.com/a"),
	)
	if err != nil {
		t.Fatal(err)
	}
	if saved.Transport != TransportWebPush {
		t.Fatalf("expected webpush, got %q", saved.Transport)
	}
}

// A token that stores cleanly and then silently never delivers is the failure
// this feature cannot tolerate, so the shape is checked while somebody could
// still be told about it.
func TestADeviceTokenMustLookLikeOne(t *testing.T) {
	store := pushTestStore(t)
	ctx := context.Background()
	for name, token := range map[string]string{
		"empty":          "",
		"too short":      "b0c1d2e3",
		"odd length":     testDeviceToken + "a",
		"not hex":        strings.Repeat("z", 64),
		"a web push URL": "https://push.example.com/abc",
		"absurdly long":  strings.Repeat("ab", 200),
	} {
		if _, err := store.SavePushSubscription(ctx, testDevice("alice", token)); err == nil {
			t.Fatalf("%s should have been refused", name)
		} else if !errors.Is(err, ErrInvalidPushSubscription) {
			t.Fatalf("%s should be refused as invalid, got %v", name, err)
		}
	}
	if _, err := store.SavePushSubscription(ctx, testDevice("alice", testDeviceToken)); err != nil {
		t.Fatalf("a real token should be accepted: %v", err)
	}
}

// APNs rows have no key material. Any that arrives is dropped rather than kept
// where a later reader would take the row for a Web Push subscription with an
// unusable endpoint.
func TestADeviceStoresNoKeys(t *testing.T) {
	store := pushTestStore(t)
	device := testDevice("alice", testDeviceToken)
	device.P256dh = "BOrCVKq0zSJPYbXvT9GJl1S2zPQ3vY7ZlU0f4"
	device.Auth = "k9XKQXG7YbXPQzS1vY7Zlg"
	saved, err := store.SavePushSubscription(context.Background(), device)
	if err != nil {
		t.Fatal(err)
	}
	if saved.P256dh != "" || saved.Auth != "" {
		t.Fatalf("expected no keys on a device row, got %+v", saved)
	}
}

// An unknown transport is a client mistake, not a row to guess at.
func TestAnUnknownTransportIsRefused(t *testing.T) {
	store := pushTestStore(t)
	subscription := testSubscription("alice", "https://push.example.com/a")
	subscription.Transport = "carrier-pigeon"
	if _, err := store.SavePushSubscription(context.Background(), subscription); err == nil {
		t.Fatal("expected an unknown transport to be refused")
	}
}

// An Android registration token is stored as its own kind, and anything that
// could not be one is refused before it can make an account look reachable.
func TestAnAndroidRegistrationTokenIsStoredAndCheckedForShape(t *testing.T) {
	store := authTestStore(t)
	ctx := t.Context()
	registeredOwner(t, store, "alice", "Alice")
	token := "dQw4w9WgXcQ:APA91bHun4MxP5egoKMwt2KZFBaFUH-1RYqx_xQ3eQ5HfZJ9o8nZ2tYyX0u2VQ7yK1n1bS0T"

	saved, err := store.SavePushSubscription(ctx, PushSubscription{
		Endpoint: token, UserID: "alice", Transport: TransportFCM, P256dh: "stray", Auth: "stray",
	})
	if err != nil {
		t.Fatalf("save: %v", err)
	}
	if saved.P256dh != "" || saved.Auth != "" {
		t.Fatal("an FCM row carries no key material")
	}
	reachable, err := store.HasPushSubscription(ctx, "alice", TransportFCM)
	if err != nil || !reachable {
		t.Fatalf("expected the phone to be reachable over FCM: %v", err)
	}
	if reachable, _ := store.HasPushSubscription(ctx, "alice", TransportAPNs); reachable {
		t.Fatal("an Android phone is not reachable over APNs")
	}

	for _, bad := range []string{"", "short", "https://push.example/not-a-token-but-long-enough", token + " " + token} {
		if _, err := store.SavePushSubscription(ctx, PushSubscription{
			Endpoint: bad, UserID: "alice", Transport: TransportFCM,
		}); !errors.Is(err, ErrInvalidPushSubscription) {
			t.Fatalf("%q: expected a refusal, got %v", bad, err)
		}
	}
}
