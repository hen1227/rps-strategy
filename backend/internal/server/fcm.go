package server

import (
	"bytes"
	"context"
	"crypto/rsa"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

// The same promise again, kept for an Android phone.
//
// An Android app leaves behind a Firebase Cloud Messaging registration token,
// and what reaches it is a request this server makes to Google with an access
// token it mints from a service account of its own Firebase project. There is
// no third party between the two beyond the one Android always routes through:
// no Expo push service, and no Firebase SDK in this server.
//
// Everything above the wire is the APNs half restated, on purpose. The same one
// notification with the same forty-five second life, the same collapsing, the
// same rule that a token Google says is gone is forgotten at once, and the same
// refusal to drop a device over a fault of this server's own. See `apns.go`.

const (
	fcmHost = "https://fcm.googleapis.com"
	// fcmScope is the one permission the access token is asked for.
	fcmScope = "https://www.googleapis.com/auth/firebase.messaging"
	// fcmChannel is the notification channel the app creates before it asks
	// for permission. Named on every message, because Android shows a message
	// for a channel the app never made under a catch-all the player cannot
	// tell apart from anything else.
	fcmChannel = "match-alerts"
	// Google's access tokens are good for an hour. One is renewed this long
	// before it runs out, so a summons is never sent with a token that expires
	// on the way.
	fcmTokenMargin = 5 * time.Minute
)

// fcmServiceAccount is the part of a Google service account key this server
// reads: the JSON file the Firebase console downloads once.
type fcmServiceAccount struct {
	ProjectID   string `json:"project_id"`
	PrivateKey  string `json:"private_key"`
	ClientEmail string `json:"client_email"`
	TokenURI    string `json:"token_uri"`
}

// fcmSender delivers match summons to Android devices, and knows whether it can.
//
// Disabled is its ordinary state, as for APNs: a deployment with no service
// account tells no Android phone it can be reached, and everything else behaves
// exactly as it did before Android existed.
type fcmSender struct {
	enabled     bool
	projectID   string
	clientEmail string
	tokenURI    string
	host        string
	key         *rsa.PrivateKey
	client      httpDoer

	// An access token is reused until it is nearly expired. Minting one is a
	// signed round trip to Google, which has no business being inline with
	// every summons.
	mu           sync.Mutex
	accessToken  string
	accessExpiry time.Time
}

func newFCMSender() *fcmSender {
	sender := &fcmSender{
		host:   fcmHost,
		client: &http.Client{Timeout: pushTimeout},
	}
	path := strings.TrimSpace(os.Getenv("RPS_FCM_CREDENTIALS_PATH"))
	if path == "" {
		// Nothing configured, which is not a mistake and not worth a log line.
		return sender
	}
	account, key, err := loadFCMServiceAccount(path)
	if err != nil {
		// Named at boot rather than discovered at the first summons, on a
		// goroutine nobody is watching.
		log.Printf("Android notifications disabled: %v", err)
		return sender
	}
	sender.projectID = account.ProjectID
	sender.clientEmail = account.ClientEmail
	sender.tokenURI = account.TokenURI
	sender.key = key
	sender.enabled = true
	return sender
}

// loadFCMServiceAccount reads and checks a service account key file.
func loadFCMServiceAccount(path string) (fcmServiceAccount, *rsa.PrivateKey, error) {
	var account fcmServiceAccount
	raw, err := os.ReadFile(path)
	if err != nil {
		return account, nil, fmt.Errorf("read FCM service account %s: %w", path, err)
	}
	if err := json.Unmarshal(raw, &account); err != nil {
		return account, nil, fmt.Errorf("parse FCM service account %s: %w", path, err)
	}
	if account.ProjectID == "" || account.ClientEmail == "" || account.PrivateKey == "" {
		return account, nil, fmt.Errorf(
			"FCM service account %s needs project_id, client_email and private_key", path,
		)
	}
	if account.TokenURI == "" {
		account.TokenURI = "https://oauth2.googleapis.com/token"
	}
	// The key is sent to whatever this names, signed. Anything but https is a
	// file somebody edited, and not a server to hand a signed assertion to.
	if parsed, err := url.Parse(account.TokenURI); err != nil || parsed.Scheme != "https" {
		return account, nil, fmt.Errorf("FCM service account %s: token_uri must be https", path)
	}
	// PKCS#8, which is what Google issues. The JWT library reads it, as it
	// reads the Apple key for APNs.
	key, err := jwt.ParseRSAPrivateKeyFromPEM([]byte(account.PrivateKey))
	if err != nil {
		return account, nil, fmt.Errorf("parse FCM service account key in %s: %w", path, err)
	}
	return account, key, nil
}

// fcmMessage and the types under it are the HTTP v1 payload Google defines.
//
// A notification message rather than data only, and that is not a style
// choice: expo-notifications never hands a data-only message to the app while
// it is open, so the foreground rule — a summons for a game already on screen
// is not shown — would have nothing to decide on. The custom keys sit in the
// flat `data` map, which is where the app reads them, and none of them is
// called "body": that one key is parsed as Expo's own format instead.
type fcmMessage struct {
	Message fcmMessageBody `json:"message"`
}

type fcmMessageBody struct {
	Token        string            `json:"token"`
	Notification fcmNotification   `json:"notification"`
	Data         map[string]string `json:"data,omitempty"`
	Android      fcmAndroidConfig  `json:"android"`
}

type fcmNotification struct {
	Title string `json:"title"`
	Body  string `json:"body"`
}

type fcmAndroidConfig struct {
	// HIGH is "deliver now", which is the whole point while a seat is held.
	Priority string `json:"priority"`
	// The Web Push TTL and the APNs expiry, in Google's notation.
	TTL string `json:"ttl"`
	// What a phone that was offline keeps one of, rather than every summons.
	CollapseKey  string                 `json:"collapse_key,omitempty"`
	Notification fcmAndroidNotification `json:"notification"`
}

type fcmAndroidNotification struct {
	ChannelID string `json:"channel_id"`
	// Google's word for the Web Push tag: a second summons replaces the first
	// in the shade. It is also how the app finds its own summons there when it
	// comes to the front, because a notification Android posted while the app
	// was in the background comes back with none of the data above.
	Tag   string `json:"tag,omitempty"`
	Sound string `json:"sound,omitempty"`
}

// send delivers one summons to one device, and reports what Google made of it.
func (sender *fcmSender) send(ctx context.Context, token string, payload pushPayload) deliveryOutcome {
	if !sender.enabled {
		return deliveryFailed
	}
	data := map[string]string{}
	if payload.Kind != "" {
		data["kind"] = payload.Kind
	}
	if payload.GameID != "" {
		data["gameId"] = payload.GameID
	}
	body, err := json.Marshal(fcmMessage{Message: fcmMessageBody{
		Token:        token,
		Notification: fcmNotification{Title: payload.Title, Body: payload.Body},
		Data:         data,
		Android: fcmAndroidConfig{
			Priority:    "HIGH",
			TTL:         fmt.Sprintf("%ds", int(pushTTL.Seconds())),
			CollapseKey: payload.Tag,
			Notification: fcmAndroidNotification{
				ChannelID: fcmChannel,
				Tag:       payload.Tag,
				Sound:     "default",
			},
		},
	}})
	if err != nil {
		log.Printf("encode FCM payload: %v", err)
		return deliveryFailed
	}
	bearer, err := sender.bearer(ctx)
	if err != nil {
		log.Printf("get an FCM access token: %v", err)
		return deliveryFailed
	}

	request, err := http.NewRequestWithContext(
		ctx,
		http.MethodPost,
		sender.host+"/v1/projects/"+url.PathEscape(sender.projectID)+"/messages:send",
		bytes.NewReader(body),
	)
	if err != nil {
		log.Printf("build FCM request: %v", err)
		return deliveryFailed
	}
	request.Header.Set("authorization", "Bearer "+bearer)
	request.Header.Set("content-type", "application/json")

	response, err := sender.client.Do(request)
	if err != nil {
		log.Printf("send FCM message: %v", err)
		return deliveryFailed
	}
	defer response.Body.Close()
	return sender.readOutcome(response)
}

// fcmFailure is the error body Google sends, of which only the code matters.
type fcmFailure struct {
	Error struct {
		Message string `json:"message"`
		Status  string `json:"status"`
		Details []struct {
			ErrorCode string `json:"errorCode"`
		} `json:"details"`
	} `json:"error"`
}

func (failure fcmFailure) errorCode() string {
	for _, detail := range failure.Error.Details {
		if detail.ErrorCode != "" {
			return detail.ErrorCode
		}
	}
	return failure.Error.Status
}

// readOutcome turns Google's answer into the one decision the caller needs.
func (sender *fcmSender) readOutcome(response *http.Response) deliveryOutcome {
	if response.StatusCode == http.StatusOK {
		return deliveryAccepted
	}
	var failure fcmFailure
	_ = json.NewDecoder(io.LimitReader(response.Body, 64<<10)).Decode(&failure)
	code := failure.errorCode()

	switch {
	// The app was uninstalled, or the token expired or was replaced. Gone for
	// good, and an address nobody prunes is an account that looks reachable
	// for ever.
	case code == "UNREGISTERED", response.StatusCode == http.StatusNotFound:
		return deliveryGone
	// A token Google will never accept. INVALID_ARGUMENT also covers a payload
	// this server got wrong, which must not cost anybody their device, so only
	// the token's own complaint counts.
	case code == "INVALID_ARGUMENT" &&
		strings.Contains(strings.ToLower(failure.Error.Message), "registration token"):
		return deliveryGone
	case response.StatusCode == http.StatusUnauthorized, code == "THIRD_PARTY_AUTH_ERROR":
		// Nothing about the device is wrong. The token is thrown away in case
		// the clock jumped, as for APNs, and the next send mints another.
		sender.expireAccessToken()
		log.Printf("FCM refused this server's credentials (%s): check "+
			"RPS_FCM_CREDENTIALS_PATH and that the service account may send", code)
		return deliveryFailed
	case code == "SENDER_ID_MISMATCH":
		// A token from another Firebase project: the app was built with one
		// google-services.json and this server holds another's key. Logged and
		// kept, because pruning on it would wipe every Android device the day
		// the two are mismatched, which is a fault of the deployment.
		log.Printf("FCM rejected a token from a different Firebase project than %s: "+
			"the app's google-services.json and RPS_FCM_CREDENTIALS_PATH must match", sender.projectID)
		return deliveryFailed
	default:
		log.Printf("FCM rejected a message: %s %s %s", response.Status, code, failure.Error.Message)
		return deliveryFailed
	}
}

// bearer is the OAuth access token every send carries, minted at most once an
// hour from the service account.
//
// Held under the lock for the round trip, so a burst of summons at the moment
// the token runs out mints one rather than one each.
func (sender *fcmSender) bearer(ctx context.Context) (string, error) {
	sender.mu.Lock()
	defer sender.mu.Unlock()
	now := time.Now()
	if sender.accessToken != "" && now.Before(sender.accessExpiry) {
		return sender.accessToken, nil
	}

	assertion, err := jwt.NewWithClaims(jwt.SigningMethodRS256, jwt.MapClaims{
		"iss":   sender.clientEmail,
		"scope": fcmScope,
		"aud":   sender.tokenURI,
		"iat":   now.Unix(),
		"exp":   now.Add(time.Hour).Unix(),
	}).SignedString(sender.key)
	if err != nil {
		return "", fmt.Errorf("sign the service account assertion: %w", err)
	}
	form := url.Values{
		"grant_type": {"urn:ietf:params:oauth:grant-type:jwt-bearer"},
		"assertion":  {assertion},
	}
	request, err := http.NewRequestWithContext(
		ctx, http.MethodPost, sender.tokenURI, strings.NewReader(form.Encode()),
	)
	if err != nil {
		return "", err
	}
	request.Header.Set("content-type", "application/x-www-form-urlencoded")
	response, err := sender.client.Do(request)
	if err != nil {
		return "", err
	}
	defer response.Body.Close()

	var reply struct {
		AccessToken string `json:"access_token"`
		ExpiresIn   int64  `json:"expires_in"`
		Error       string `json:"error"`
		Description string `json:"error_description"`
	}
	_ = json.NewDecoder(io.LimitReader(response.Body, 64<<10)).Decode(&reply)
	if response.StatusCode != http.StatusOK || reply.AccessToken == "" {
		return "", fmt.Errorf("%s: %s %s", response.Status, reply.Error, reply.Description)
	}
	if reply.ExpiresIn <= 0 {
		return "", errors.New("the access token came with no lifetime")
	}
	sender.accessToken = reply.AccessToken
	sender.accessExpiry = now.Add(time.Duration(reply.ExpiresIn)*time.Second - fcmTokenMargin)
	return reply.AccessToken, nil
}

// expireAccessToken throws away the cached token so the next send mints one.
func (sender *fcmSender) expireAccessToken() {
	sender.mu.Lock()
	defer sender.mu.Unlock()
	sender.accessToken = ""
}
