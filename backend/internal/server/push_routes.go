package server

import (
	"crypto/ecdh"
	"encoding/base64"
	"errors"
	"net/http"
	"strings"

	"rps-strategy/backend/internal/persistence"
)

// The routes a device needs to become reachable, to prove it is, and to stop
// being.
//
// Two registration routes rather than one, because the two transports have
// nothing in common on the wire: a browser hands over a URL and a pair of keys
// to encrypt for, and a phone hands over a token and nothing else. One route
// taking either would be a body where half the fields are always ignored and
// no single validation is right, which is how a subscription that stores
// cleanly and never delivers gets in.
//
// They are HTTP rather than WebSocket messages because subscribing is a
// property of the browser rather than of a session: it survives the socket, it
// is done once, and the service worker that receives the result outlives every
// tab. Putting it on the socket would tie "can this person be called back" to
// "is this person currently connected", which is the exact coupling the
// persistent queue exists to break.

type pushSubscriptionRequest struct {
	Endpoint string `json:"endpoint"`
	Keys     struct {
		P256dh string `json:"p256dh"`
		Auth   string `json:"auth"`
	} `json:"keys"`
}

type pushUnsubscribeRequest struct {
	Endpoint string `json:"endpoint"`
}

// pushDeviceRequest is what a native app registers. A token is the whole of it:
// APNs authenticates the channel with this server's Apple key, so there is no
// per-device key material to carry.
type pushDeviceRequest struct {
	Token string `json:"token"`
}

// getPushKey hands out the public half of the VAPID pair, and says plainly when
// there is not one. A client that reads `enabled: false` hides the whole
// away-queue offer rather than showing a button that cannot work.
//
// `enabled` still means exactly what it has always meant to a browser — there
// is a VAPID key here — because that is what every deployed web client reads it
// as. `transports` is the same answer given per kind of device, so a phone can
// ask about the half that concerns it instead of inferring its own future from
// a browser's.
func (server *Server) getPushKey(writer http.ResponseWriter, _ *http.Request) {
	writeJSON(writer, http.StatusOK, map[string]any{
		"enabled":    server.push.webEnabled,
		"publicKey":  server.push.publicKey,
		"transports": server.push.transports(),
	})
}

func (server *Server) subscribeToPush(writer http.ResponseWriter, request *http.Request) {
	if !server.push.webEnabled {
		writeAPIError(writer, http.StatusServiceUnavailable, "notifications are not configured on this server")
		return
	}
	account, ok := server.requireAnyIdentity(writer, request)
	if !ok {
		return
	}
	var input pushSubscriptionRequest
	if err := decodeAPIRequest(writer, request, &input); err != nil {
		writeAPIError(writer, http.StatusBadRequest, err.Error())
		return
	}
	// Checked here rather than left to the first send. A key that is the wrong
	// length, or is not actually a point on the curve, produces a subscription
	// that stores cleanly and then silently never delivers anything — and
	// "silently never delivers" is the failure this whole feature cannot
	// tolerate, because a seek is kept on the board on the strength of it.
	if err := validatePushKeys(input.Keys.P256dh, input.Keys.Auth); err != nil {
		writeAPIError(writer, http.StatusBadRequest, err.Error())
		return
	}

	saved, err := server.data.SavePushSubscription(request.Context(), persistence.PushSubscription{
		Endpoint:  input.Endpoint,
		UserID:    account.UserID,
		Transport: persistence.TransportWebPush,
		P256dh:    input.Keys.P256dh,
		Auth:      input.Keys.Auth,
	})
	if err != nil {
		if errors.Is(err, persistence.ErrInvalidPushSubscription) {
			message := strings.TrimPrefix(
				err.Error(),
				persistence.ErrInvalidPushSubscription.Error()+": ",
			)
			writeAPIError(writer, http.StatusBadRequest, message)
			return
		}
		writePersistenceError(writer, err)
		return
	}
	writeJSON(writer, http.StatusOK, map[string]any{
		"subscribed":      true,
		"createdAtUnixMs": saved.CreatedAtUnixMs,
	})
}

// registerPushDevice records an iOS device as reachable.
//
// The APNs counterpart of subscribeToPush, and deliberately its twin: same
// identity rule, same upsert, same store, same 200-means-reachable contract.
// What it does not have is a key to validate — the token is checked for shape
// in the store, and the first real proof it works is the test notification the
// account screen offers, exactly as on the web.
func (server *Server) registerPushDevice(writer http.ResponseWriter, request *http.Request) {
	if !server.push.apns.enabled {
		writeAPIError(
			writer,
			http.StatusServiceUnavailable,
			"iOS notifications are not configured on this server",
		)
		return
	}
	account, ok := server.requireAnyIdentity(writer, request)
	if !ok {
		return
	}
	var input pushDeviceRequest
	if err := decodeAPIRequest(writer, request, &input); err != nil {
		writeAPIError(writer, http.StatusBadRequest, err.Error())
		return
	}
	saved, err := server.data.SavePushSubscription(request.Context(), persistence.PushSubscription{
		Endpoint:  input.Token,
		UserID:    account.UserID,
		Transport: persistence.TransportAPNs,
	})
	if err != nil {
		if errors.Is(err, persistence.ErrInvalidPushSubscription) {
			message := strings.TrimPrefix(
				err.Error(),
				persistence.ErrInvalidPushSubscription.Error()+": ",
			)
			writeAPIError(writer, http.StatusBadRequest, message)
			return
		}
		writePersistenceError(writer, err)
		return
	}
	writeJSON(writer, http.StatusOK, map[string]any{
		"subscribed":      true,
		"createdAtUnixMs": saved.CreatedAtUnixMs,
	})
}

// unregisterPushDevice forgets one phone.
//
// A token arrives where the endpoint goes, because in the store it is the same
// column and here it is the same rule: only the account that owns an address
// may drop it, and a token that was never stored still answers 200.
func (server *Server) unregisterPushDevice(writer http.ResponseWriter, request *http.Request) {
	account, ok := server.requireAnyIdentity(writer, request)
	if !ok {
		return
	}
	var input pushDeviceRequest
	if err := decodeAPIRequest(writer, request, &input); err != nil {
		writeAPIError(writer, http.StatusBadRequest, err.Error())
		return
	}
	server.forgetPushAddress(writer, request, account, input.Token, "device token")
}

// unsubscribeFromPush forgets one browser.
//
// It answers 200 for an endpoint that was never stored. Turning notifications
// off is the one request that must never fail: a person withdrawing consent
// should not be told to try again, and "it is already gone" is the outcome they
// asked for.
func (server *Server) unsubscribeFromPush(writer http.ResponseWriter, request *http.Request) {
	account, ok := server.requireAnyIdentity(writer, request)
	if !ok {
		return
	}
	var input pushUnsubscribeRequest
	if err := decodeAPIRequest(writer, request, &input); err != nil {
		writeAPIError(writer, http.StatusBadRequest, err.Error())
		return
	}
	server.forgetPushAddress(writer, request, account, input.Endpoint, "endpoint")
}

// forgetPushAddress drops one address, whatever kind it is.
//
// Only the account that owns it may drop it, so one signed-in player cannot
// silence another by guessing a URL or a token.
func (server *Server) forgetPushAddress(
	writer http.ResponseWriter,
	request *http.Request,
	account persistence.Account,
	address string,
	name string,
) {
	address = strings.TrimSpace(address)
	if address == "" {
		writeAPIError(writer, http.StatusBadRequest, name+" is required")
		return
	}
	subscriptions, err := server.data.PushSubscriptionsFor(request.Context(), account.UserID)
	if err != nil {
		writePersistenceError(writer, err)
		return
	}
	for _, subscription := range subscriptions {
		if subscription.Endpoint != address {
			continue
		}
		if err := server.data.DeletePushSubscription(request.Context(), subscription.Endpoint); err != nil {
			writePersistenceError(writer, err)
			return
		}
		break
	}
	writeJSON(writer, http.StatusOK, map[string]any{"subscribed": false})
}

// sendTestPush delivers one notification to the person who asked for it.
//
// The one exception to "match-found is the only notification this server ever
// sends", and not really an exception at all: it is sent because somebody
// pressed a button demanding it, which is the opposite of the unsolicited
// pinging that rule exists to forbid. It earns its place because the whole
// feature is otherwise unverifiable — a subscription that stores cleanly and
// silently never delivers looks exactly like one that works, right up until the
// moment somebody misses a game.
func (server *Server) sendTestPush(writer http.ResponseWriter, request *http.Request) {
	if !server.push.enabled() {
		writeAPIError(writer, http.StatusServiceUnavailable, "notifications are not configured on this server")
		return
	}
	account, ok := server.requireAnyIdentity(writer, request)
	if !ok {
		return
	}
	// Delivery is synchronous here, unlike every other send. Nothing is waiting
	// on it — no pairing, no clock — and the count is the entire answer.
	delivered := server.push.SendTo(account.UserID, pushPayload{
		Kind:  "test",
		Title: "Notifications are working",
		Body:  "This is the only kind of alert RPS sends, and only when a game starts.",
		Tag:   "rps-test",
	})
	writeJSON(writer, http.StatusOK, map[string]any{"delivered": delivered})
}

// validatePushKeys rejects a subscription that could never be encrypted for.
//
// The two values come straight from the browser's PushSubscription, so a
// well-behaved client always passes. What this catches is a hand-rolled or
// truncated one, at the moment somebody could still be told about it.
func validatePushKeys(p256dh string, auth string) error {
	point, err := base64.RawURLEncoding.DecodeString(strings.TrimRight(p256dh, "="))
	if err != nil {
		return errors.New("p256dh must be base64url")
	}
	if _, err := ecdh.P256().NewPublicKey(point); err != nil {
		return errors.New("p256dh must be an uncompressed P-256 public key")
	}
	secret, err := base64.RawURLEncoding.DecodeString(strings.TrimRight(auth, "="))
	if err != nil {
		return errors.New("auth must be base64url")
	}
	if len(secret) != 16 {
		return errors.New("auth must be 16 bytes")
	}
	return nil
}
