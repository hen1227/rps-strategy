package server

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"os"
	"strings"
	"time"

	webpush "github.com/SherClockHolmes/webpush-go"
	"rps-strategy/backend/internal/persistence"
)

// Push is the only reason a queue can outlive a tab.
//
// Everything else in this server talks to people through a socket they are
// holding open. This is the one channel that reaches somebody who has gone, and
// the whole persistent queue rests on it: a seek survives a disconnect exactly
// when its author can be called back, and nowhere else.
//
// It comes in two kinds now — a browser's Web Push subscription and an iOS
// device token — and the split stops at the wire. One store answers "can this
// person be called back", one payload says the same sentence, and `Send` fans
// out to whatever a person happens to own. See `apns.go` for the other half.
//
// That makes restraint part of the design rather than a policy bolted on top.
// The server sends exactly one kind of notification — your game has started, go
// and play it — and there is deliberately no second one. A queue you can walk
// away from is worth having; an app that pings you about other people's
// activity is worth muting, and a muted app cannot call anybody back at all.

const (
	// pushTTL is how long a push service should hold a notification for a
	// device that is offline. Slightly longer than the first-move window, and no
	// longer: a summons that arrives after the game has been called off is worse
	// than one that never arrives, because the player acts on it.
	pushTTL = 45 * time.Second
	// pushTimeout bounds one delivery attempt. A push service that is slow must
	// not become a goroutine that lives for ever.
	pushTimeout = 10 * time.Second
)

// pushSender delivers match summons, and knows whether it can.
//
// Disabled is the ordinary state of a fresh checkout and of any deployment that
// has not been given VAPID keys, so it has to be a first-class case rather than
// an error path: with no keys the server simply never promises anybody it can
// reach them, `canSummon` is false for everyone, and the away queue disappears
// from the client. What is left behaves exactly as this server did before push
// existed.
type pushSender struct {
	data       *persistence.Store
	publicKey  string
	privateKey string
	subject    string
	// webEnabled is whether this server holds VAPID keys, and so whether there
	// is any point offering a browser the button at all. Held apart from APNs
	// because a deployment can perfectly well have one and not the other, and
	// each client must be told the truth about its own transport rather than
	// about the pair.
	webEnabled bool
	// apns is the same promise kept for a phone. Never nil; disabled is its
	// ordinary state.
	apns *apnsSender
	// client is swappable so a test can point deliveries at an httptest TLS
	// server. Nothing in production sets it.
	client webpush.HTTPClient
	// reachableOverride answers Reachable without touching the store. Tests set
	// it because reachability is the single fact the away queue branches on,
	// and standing up a push service to establish it would make every queue
	// test a test about crypto.
	reachableOverride *bool
	// onUnreachable is called when a person loses their last subscription, so
	// the wait they left on the board can be taken off it. Without this, the
	// one situation the reachability rule exists to prevent is exactly the one
	// a dead subscription creates.
	onUnreachable func(userID string)
}

func newPushSender(data *persistence.Store) *pushSender {
	sender := &pushSender{
		data:       data,
		publicKey:  strings.TrimSpace(os.Getenv("RPS_VAPID_PUBLIC_KEY")),
		privateKey: strings.TrimSpace(os.Getenv("RPS_VAPID_PRIVATE_KEY")),
		subject:    strings.TrimSpace(os.Getenv("RPS_VAPID_SUBJECT")),
	}
	sender.webEnabled = sender.publicKey != "" && sender.privateKey != "" && sender.subject != ""
	if !sender.webEnabled && (sender.publicKey != "" || sender.privateKey != "" || sender.subject != "") {
		// Half-configured is a mistake worth naming. Silently disabled would
		// look identical to a deployment that never wanted push at all.
		log.Print("web push notifications disabled: RPS_VAPID_PUBLIC_KEY, " +
			"RPS_VAPID_PRIVATE_KEY and RPS_VAPID_SUBJECT must all be set")
	}
	sender.apns = newAPNsSender()
	return sender
}

// enabled reports whether anybody can be reached by any means at all.
//
// The question the queue and the lobby ask. Which transport would carry it is a
// different question, asked by the two registration routes and answered per
// client, because a browser being able to subscribe says nothing about a phone.
func (sender *pushSender) enabled() bool {
	return sender.webEnabled || sender.apns.enabled
}

// canSend is whether a stored address is one this server is still configured to
// deliver to. A row outlives the keys that reached it: VAPID can be withdrawn
// from a deployment with browsers still subscribed, and an Apple key can expire
// with phones still registered.
func (sender *pushSender) canSend(transport persistence.PushTransport) bool {
	if transport == persistence.TransportAPNs {
		return sender.apns.enabled
	}
	return sender.webEnabled
}

// pushTransports is which kinds of device this server can actually reach.
//
// Sent both on the socket at connect and from the key route, because the client
// needs it before it decides whether to offer anything: a browser reads
// `webPush` and a phone reads `apns`, and neither should be shown a button that
// this deployment could never honour.
type pushTransports struct {
	WebPush bool `json:"webPush"`
	APNs    bool `json:"apns"`
}

func (sender *pushSender) transports() pushTransports {
	return pushTransports{WebPush: sender.webEnabled, APNs: sender.apns.enabled}
}

// pushPayload is what a service worker receives. Deliberately thin: it carries
// nothing the lobby does not already show anybody who loads the page, because a
// notification is the one thing this server puts on a screen it does not own.
type pushPayload struct {
	Kind   string `json:"kind"`
	Title  string `json:"title"`
	Body   string `json:"body"`
	Tag    string `json:"tag"`
	GameID string `json:"gameId,omitempty"`
}

// Reachable reports whether an account has anywhere to be notified.
func (sender *pushSender) Reachable(ctx context.Context, userID string) bool {
	if !sender.enabled() || strings.TrimSpace(userID) == "" {
		return false
	}
	if sender.reachableOverride != nil {
		return *sender.reachableOverride
	}
	reachable, err := sender.data.HasPushSubscription(ctx, userID)
	if err != nil {
		log.Printf("check push subscriptions for %s: %v", userID, err)
		return false
	}
	return reachable
}

// SendTo is Send with the count of devices it reached, for the one caller that
// needs to report back: a person pressing "send me a test" wants to know
// whether anything went anywhere, and "no subscriptions" is a different answer
// from "sent, check your notification settings".
func (sender *pushSender) SendTo(userID string, payload pushPayload) int {
	if !sender.enabled() {
		return 0
	}
	ctx, cancel := context.WithTimeout(context.Background(), pushTimeout)
	defer cancel()
	subscriptions, err := sender.data.PushSubscriptionsFor(ctx, userID)
	if err != nil {
		log.Printf("read push subscriptions for %s: %v", userID, err)
		return 0
	}
	if len(subscriptions) == 0 {
		return 0
	}
	body, err := json.Marshal(payload)
	if err != nil {
		log.Printf("encode push payload: %v", err)
		return 0
	}
	reached := 0
	for _, subscription := range subscriptions {
		if !sender.canSend(subscription.Transport) {
			continue
		}
		if subscription.Transport == persistence.TransportAPNs {
			if sender.apns.send(ctx, subscription.Endpoint, payload) {
				sender.forget(ctx, subscription)
			}
		} else {
			sender.deliver(ctx, subscription, body)
		}
		reached++
	}
	return reached
}

// Send delivers one payload to every device an account has registered.
//
// Callers run this on their own goroutine. Nothing in the lobby may wait on a
// push service: seating a match happens inline with pairing, and a single
// unreachable endpoint taking ten seconds to time out would hold up every other
// pair in the same sweep.
func (sender *pushSender) Send(userID string, payload pushPayload) {
	sender.SendTo(userID, payload)
}

// forget drops a device the push service has told us is gone, and says so if it
// was the last one.
//
// Shared by both transports, because the consequence is the transport's only
// point of contact with the queue: an address nobody prunes is an account that
// looks reachable for ever and silently is not, and a seek left behind one is
// exactly the ghost this feature must not have.
func (sender *pushSender) forget(ctx context.Context, subscription persistence.PushSubscription) {
	if err := sender.data.DeletePushSubscription(ctx, subscription.Endpoint); err != nil {
		log.Printf("prune dead push subscription: %v", err)
		return
	}
	reachable, err := sender.data.HasPushSubscription(ctx, subscription.UserID)
	if err == nil && !reachable && sender.onUnreachable != nil {
		sender.onUnreachable(subscription.UserID)
	}
}

func (sender *pushSender) deliver(
	ctx context.Context,
	subscription persistence.PushSubscription,
	body []byte,
) {
	response, err := webpush.SendNotificationWithContext(ctx, body, &webpush.Subscription{
		Endpoint: subscription.Endpoint,
		Keys: webpush.Keys{
			P256dh: subscription.P256dh,
			Auth:   subscription.Auth,
		},
	}, &webpush.Options{
		HTTPClient:      sender.client,
		Subscriber:      sender.subject,
		VAPIDPublicKey:  sender.publicKey,
		VAPIDPrivateKey: sender.privateKey,
		TTL:             int(pushTTL.Seconds()),
		Urgency:         webpush.UrgencyHigh,
	})
	if err != nil {
		log.Printf("send push notification: %v", err)
		return
	}
	defer response.Body.Close()

	// 404 and 410 are the push service telling us this browser is gone: the
	// permission was revoked, the profile was deleted, the subscription
	// expired.
	if response.StatusCode == http.StatusNotFound || response.StatusCode == http.StatusGone {
		sender.forget(ctx, subscription)
		return
	}
	if response.StatusCode >= 400 {
		log.Printf("push service rejected a notification: %s", response.Status)
	}
}
