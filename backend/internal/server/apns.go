package server

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

// The same promise as Web Push, kept for a phone.
//
// A browser can be called back because it left behind a push service URL and a
// pair of keys to encrypt for. A native iOS app leaves neither: there is no
// service worker to wake inside it, and Safari's Web Push does not reach into
// one. What it leaves instead is an APNs device token, and what reaches it is a
// request this server signs with an Apple key of its own.
//
// Everything else is deliberately identical. The same single notification —
// your game has started — with the same forty-five second life, the same
// collapsing so a re-send replaces the banner rather than stacking one, and the
// same rule that losing your last device takes your seek off the board. A
// second transport must not turn into a second policy.

const (
	apnsProductionHost = "https://api.push.apple.com"
	// A token minted by a debug build exists only in Apple's sandbox, and the
	// production host answers it with BadDeviceToken. That is the one APNs
	// mistake indistinguishable from a working setup that never delivers, so
	// RPS_APNS_ENVIRONMENT is named in the log when it happens.
	apnsSandboxHost = "https://api.sandbox.push.apple.com"
	// apnsDefaultTopic is the app's bundle id, which is what APNs means by a
	// topic. Defaulted rather than required, because there is one app.
	apnsDefaultTopic = "com.henhen1227.rps-strategy"
	// A provider token is good for an hour, and Apple refuses one minted more
	// often than every twenty minutes. Renewing at forty-five sits inside both
	// bounds with room for a slow clock.
	apnsTokenLifetime = 45 * time.Minute
)

// httpDoer is the seam a test slides an httptest client into, so a delivery can
// be inspected without a round trip to Cupertino. Nothing in production sets it.
type httpDoer interface {
	Do(request *http.Request) (*http.Response, error)
}

// apnsSender delivers match summons to iOS devices, and knows whether it can.
//
// Disabled is its ordinary state: a fresh checkout has no Apple key, and one
// half of this feature working while the other is unconfigured has to be a
// first-class case rather than an error path. With no key, no phone is ever
// told it can be reached, and the web half behaves exactly as it always did.
type apnsSender struct {
	enabled bool
	teamID  string
	keyID   string
	topic   string
	host    string
	key     *ecdsa.PrivateKey
	client  httpDoer

	// A provider token is reused until it is nearly expired, both because Apple
	// rate-limits minting them and because signing one per notification would
	// put an ECDSA operation inline with pairing.
	mu          sync.Mutex
	token       string
	tokenExpiry time.Time
}

func newAPNsSender() *apnsSender {
	sender := &apnsSender{
		teamID: strings.TrimSpace(os.Getenv("RPS_APNS_TEAM_ID")),
		keyID:  strings.TrimSpace(os.Getenv("RPS_APNS_KEY_ID")),
		topic:  strings.TrimSpace(os.Getenv("RPS_APNS_TOPIC")),
		host:   apnsProductionHost,
		client: &http.Client{Timeout: pushTimeout},
	}
	if sender.topic == "" {
		sender.topic = apnsDefaultTopic
	}
	// Sandbox is opt-in, because production is what a deployment wants and a
	// silent default of sandbox would mean a shipped app that never rings.
	if strings.EqualFold(strings.TrimSpace(os.Getenv("RPS_APNS_ENVIRONMENT")), "sandbox") {
		sender.host = apnsSandboxHost
	}

	keyPath := strings.TrimSpace(os.Getenv("RPS_APNS_KEY_PATH"))
	if keyPath == "" && sender.teamID == "" && sender.keyID == "" {
		// Nothing was configured, which is not a mistake and is not worth a line
		// in the log. Every other shape below is.
		return sender
	}
	if keyPath == "" || sender.teamID == "" || sender.keyID == "" {
		log.Print("iOS notifications disabled: RPS_APNS_KEY_PATH, RPS_APNS_KEY_ID " +
			"and RPS_APNS_TEAM_ID must all be set")
		return sender
	}
	key, err := loadAPNsKey(keyPath)
	if err != nil {
		// Named loudly and at boot. A key that cannot be read is otherwise
		// discovered at the first summons, which is the worst possible moment
		// and on a goroutine nobody is watching.
		log.Printf("iOS notifications disabled: %v", err)
		return sender
	}
	sender.key = key
	sender.enabled = true
	return sender
}

// loadAPNsKey reads the .p8 Apple hands out for token-based authentication.
//
// It is a PKCS#8 PEM file, which is why the parse is the JWT library's rather
// than `x509.ParseECPrivateKey`: the latter refuses a .p8 outright, and the
// error it gives ("failed to parse EC private key") reads like a corrupt file
// rather than the wrong parser.
func loadAPNsKey(path string) (*ecdsa.PrivateKey, error) {
	pem, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read APNs key %s: %w", path, err)
	}
	key, err := jwt.ParseECPrivateKeyFromPEM(pem)
	if err != nil {
		return nil, fmt.Errorf("parse APNs key %s: %w", path, err)
	}
	return key, nil
}

// apnsAlert, apnsAps, apnsData and apnsBody are the payload Apple defines.
//
// As thin as the Web Push one, and for the same reason: a notification is the
// one thing this server puts on a screen it does not own, so it carries nothing
// the lobby would not show anybody who opened the page.
//
// The custom keys sit under a top-level "body" rather than beside "aps", which
// looks arbitrary and is not: for a remote notification `expo-notifications`
// builds `content.data` from `userInfo["body"]` and nothing else. Spread beside
// "aps" they arrive as nothing at all, and the app cannot tell a summons it
// should stay quiet about from a test somebody just asked for.
type apnsAlert struct {
	Title string `json:"title"`
	Body  string `json:"body"`
}

type apnsAps struct {
	Alert apnsAlert `json:"alert"`
	Sound string    `json:"sound,omitempty"`
}

type apnsData struct {
	Kind   string `json:"kind,omitempty"`
	GameID string `json:"gameId,omitempty"`
}

type apnsBody struct {
	APS  apnsAps  `json:"aps"`
	Data apnsData `json:"body"`
}

// send delivers one summons to one device, and reports whether that device is
// gone for good.
//
// True means the token will never work again — the app was deleted, or the
// token was never valid for this server's environment — and the caller is
// expected to forget it. Every other failure returns false: a push service
// having a bad five minutes is not a reason to make somebody unreachable.
func (sender *apnsSender) send(ctx context.Context, token string, payload pushPayload) (gone bool) {
	if !sender.enabled {
		return false
	}
	body, err := json.Marshal(apnsBody{
		APS: apnsAps{
			Alert: apnsAlert{Title: payload.Title, Body: payload.Body},
			Sound: "default",
		},
		Data: apnsData{Kind: payload.Kind, GameID: payload.GameID},
	})
	if err != nil {
		log.Printf("encode APNs payload: %v", err)
		return false
	}
	providerToken, err := sender.providerToken()
	if err != nil {
		log.Printf("sign APNs provider token: %v", err)
		return false
	}

	request, err := http.NewRequestWithContext(
		ctx,
		http.MethodPost,
		sender.host+"/3/device/"+token,
		bytes.NewReader(body),
	)
	if err != nil {
		log.Printf("build APNs request: %v", err)
		return false
	}
	request.Header.Set("authorization", "bearer "+providerToken)
	request.Header.Set("content-type", "application/json")
	request.Header.Set("apns-topic", sender.topic)
	request.Header.Set("apns-push-type", "alert")
	// Priority 10 is "deliver now"; the whole point is that it arrives while
	// the seat is still being held.
	request.Header.Set("apns-priority", "10")
	// The same life as the Web Push TTL. A summons that arrives after the game
	// has been called off is worse than one that never arrives, because the
	// player acts on it.
	request.Header.Set(
		"apns-expiration",
		strconv.FormatInt(time.Now().Add(pushTTL).Unix(), 10),
	)
	// Apple's word for the Web Push tag: a second summons for the same game
	// replaces the first banner instead of stacking beside it.
	if payload.Tag != "" {
		request.Header.Set("apns-collapse-id", payload.Tag)
	}

	response, err := sender.client.Do(request)
	if err != nil {
		log.Printf("send APNs notification: %v", err)
		return false
	}
	defer response.Body.Close()
	return sender.readOutcome(response)
}

// readOutcome turns Apple's answer into the one decision the caller needs.
func (sender *apnsSender) readOutcome(response *http.Response) (gone bool) {
	if response.StatusCode == http.StatusOK {
		return false
	}
	var failure struct {
		Reason string `json:"reason"`
	}
	// The body is small and always JSON on a failure; an unreadable one just
	// leaves the reason empty, which still logs the status.
	_ = json.NewDecoder(response.Body).Decode(&failure)

	switch {
	// 410 is Apple saying the app is no longer installed. BadDeviceToken is it
	// saying the token was never ours to use. Both mean an endpoint nobody
	// prunes would leave this account looking reachable for ever, and a seek
	// behind it is exactly the ghost the away queue must not contain.
	case response.StatusCode == http.StatusGone,
		failure.Reason == "BadDeviceToken",
		failure.Reason == "Unregistered":
		if failure.Reason == "BadDeviceToken" {
			// Named in both directions, because it is the same mistake either
			// way round: a token is only ever valid against the environment it
			// was minted in, and every other symptom of getting this wrong is
			// indistinguishable from a working setup that delivers nothing.
			log.Printf("APNs rejected a device token as invalid: a token is only "+
				"valid for the environment it was minted in, and this server is "+
				"talking to %s — check RPS_APNS_ENVIRONMENT", sender.host)
		}
		return true
	case response.StatusCode == http.StatusForbidden:
		// Nothing about the device is wrong, so nothing about the device is
		// dropped. An expired token is worth throwing away though — the likely
		// cause is a host clock that jumped, and without this every later
		// summons would fail identically until the process was restarted.
		if failure.Reason == "ExpiredProviderToken" {
			sender.expireProviderToken()
		}
		log.Printf("APNs refused this server's key (%s): check RPS_APNS_KEY_ID, "+
			"RPS_APNS_TEAM_ID and that the key is enabled for push", failure.Reason)
		return false
	default:
		log.Printf("APNs rejected a notification: %s %s", response.Status, failure.Reason)
		return false
	}
}

// providerToken is the JWT every APNs request carries, minted at most once every
// forty-five minutes.
//
// Signed with the JWT library that webpush-go already brings in for VAPID
// rather than by hand: ES256 in a JWS wants the raw r‖s pair rather than the
// ASN.1 signature `crypto/ecdsa` returns by default, and getting that subtly
// wrong produces a server every notification is refused by.
func (sender *apnsSender) providerToken() (string, error) {
	sender.mu.Lock()
	defer sender.mu.Unlock()
	now := time.Now()
	if sender.token != "" && now.Before(sender.tokenExpiry) {
		return sender.token, nil
	}
	claims := jwt.NewWithClaims(jwt.SigningMethodES256, jwt.MapClaims{
		"iss": sender.teamID,
		"iat": now.Unix(),
	})
	claims.Header["kid"] = sender.keyID
	signed, err := claims.SignedString(sender.key)
	if err != nil {
		return "", err
	}
	sender.token = signed
	sender.tokenExpiry = now.Add(apnsTokenLifetime)
	return signed, nil
}

// expireProviderToken throws away the cached token so the next send mints one.
func (sender *apnsSender) expireProviderToken() {
	sender.mu.Lock()
	defer sender.mu.Unlock()
	sender.token = ""
}
