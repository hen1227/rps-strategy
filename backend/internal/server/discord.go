package server

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"log"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"
)

// Signing in with Discord.
//
// The shape to understand before reading the handlers: the backend owns the
// whole OAuth conversation. The app never gives Discord a redirect URI and
// never sees an authorization code. Discord is told to come back *here*, this
// server trades the code for a token and asks who the player is, and only then
// does the browser get sent home — carrying a ticket that means nothing to
// anybody who intercepts it, because redeeming it takes a second request.
//
// That costs one extra round trip and buys four things: the client secret and
// the code never touch a client, the native app and the web app need no
// separate Discord applications, `rps-strategy://` never has to be a registered
// redirect URI, and a local dev origin is one allowlist entry rather than a
// portal change.

const (
	// discordFlowLifetime bounds how long somebody may sit on Discord's consent
	// screen. Ten minutes is generous for a decision that takes three seconds,
	// and short enough that abandoned flows are not worth remembering.
	discordFlowLifetime = 10 * time.Minute
	// discordTicketLifetime is the window between landing back here and the app
	// redeeming the ticket, which is one page load. Short on purpose: the
	// ticket is the one part of this that travels in a URL.
	discordTicketLifetime = 2 * time.Minute
	// Bounded so that an unauthenticated caller hammering /start cannot turn
	// this map into the memory problem.
	discordMaximumPending = 1024

	discordAuthorizeURL = "https://discord.com/oauth2/authorize"
	discordTokenURL     = "https://discord.com/api/oauth2/token"
	discordUserURL      = "https://discord.com/api/users/@me"

	// DiscordTicketPrefix marks the one-shot code that comes back in the return
	// URL. Prefixed for the same reason session and bot tokens are: several
	// different secrets arrive on this server, and telling them apart by shape
	// is how one gets accepted where another was meant.
	DiscordTicketPrefix = "rps_t_"
)

// discordAuth holds the configuration and the seam tests reach through.
//
// authorizeURL, tokenURL and userURL are fields rather than constants so a test
// can point them at an httptest server; the client is the same seam apnsSender
// uses. Nothing in production sets any of the four.
type discordAuth struct {
	enabled      bool
	clientID     string
	clientSecret string
	redirectURL  string
	returnURLs   []string

	authorizeURL string
	tokenURL     string
	userURL      string
	client       httpDoer
}

// newDiscordAuth reads the environment, following the rule the push senders
// already set: all or nothing, and a half-configured deployment is refused
// loudly rather than quietly behaving as though the feature were switched off.
//
// It is not fatal, though, tempting as that is for something that gates signing
// up. New(...) is called by tests with no environment at all, and a panic here
// would take the suite with it. Loud at both ends instead: this line at boot,
// and a 503 with a real message at the route.
func newDiscordAuth() *discordAuth {
	auth := &discordAuth{
		clientID:     strings.TrimSpace(os.Getenv("RPS_DISCORD_CLIENT_ID")),
		clientSecret: strings.TrimSpace(os.Getenv("RPS_DISCORD_CLIENT_SECRET")),
		redirectURL:  strings.TrimSpace(os.Getenv("RPS_DISCORD_REDIRECT_URL")),
		authorizeURL: discordAuthorizeURL,
		tokenURL:     discordTokenURL,
		userURL:      discordUserURL,
		client:       &http.Client{Timeout: 10 * time.Second},
	}
	for _, candidate := range strings.Split(os.Getenv("RPS_DISCORD_RETURN_URLS"), ",") {
		if trimmed := strings.TrimSpace(candidate); trimmed != "" {
			auth.returnURLs = append(auth.returnURLs, strings.TrimRight(trimmed, "/"))
		}
	}

	configured := 0
	for _, value := range []string{auth.clientID, auth.clientSecret, auth.redirectURL} {
		if value != "" {
			configured++
		}
	}
	if configured == 0 && len(auth.returnURLs) == 0 {
		// The ordinary state of a fresh checkout. Not a mistake, so not a log
		// line.
		return auth
	}
	if configured != 3 || len(auth.returnURLs) == 0 {
		log.Print(
			"Discord sign-in disabled: RPS_DISCORD_CLIENT_ID, " +
				"RPS_DISCORD_CLIENT_SECRET, RPS_DISCORD_REDIRECT_URL and " +
				"RPS_DISCORD_RETURN_URLS must all be set",
		)
		return auth
	}
	auth.enabled = true
	return auth
}

// permittedReturnURL matches a requested return address against the allowlist.
//
// This is the open-redirect guard, and it runs at /start rather than at the
// callback: the callback uses the address stored with the flow and never reads
// one from its own query string, so there is exactly one place an attacker
// could aim it and exactly one place that is checked.
//
// Prefix rather than equality because the app appends a path, and both an https
// origin and a `rps-strategy://` scheme have to pass. The separator check is
// what stops "https://rps.henhen1227.com.evil.test" matching.
func (auth *discordAuth) permittedReturnURL(candidate string) bool {
	candidate = strings.TrimSpace(candidate)
	if candidate == "" {
		return false
	}
	for _, allowed := range auth.returnURLs {
		if candidate == allowed {
			return true
		}
		if strings.HasPrefix(candidate, allowed+"/") {
			return true
		}
	}
	return false
}

// defaultReturnURL is where somebody is sent when their flow has expired and
// there is therefore no validated address to send them to.
func (auth *discordAuth) defaultReturnURL() string {
	if len(auth.returnURLs) == 0 {
		return "/"
	}
	return auth.returnURLs[0]
}

// discordFlow is what is remembered between sending somebody to Discord and
// their coming back. It deliberately holds no credential: the profile key that
// proved who they are is verified at /start and reduced to a user ID here, so
// that a device credential never round-trips through a third party.
type discordFlow struct {
	verifier   string
	returnTo   string
	linkUserID string
	// linkFromSession says linkUserID was proved by a session token rather than
	// by a device key, which is the difference between "attach this identity to
	// *this* account" and "upgrade this browser's guest if that helps". The
	// first is a request that can be refused; the second is an optimisation.
	linkFromSession bool
}

// discordTicket is the one-shot result of a finished OAuth conversation,
// redeemed by the app for a session.
type discordTicket struct {
	discordUserID   string
	discordUsername string
	globalName      string
	// linkUserID is the account this identity should attach to, when the
	// caller proved one at /start.
	linkUserID string
	// linkFromSession carries the flow's distinction through to redemption. See
	// discordFlow.
	linkFromSession bool
}

// ttlStore is a small expiring map: mutex, clock, capacity bound, sweep.
//
// The same shape as rateLimiter next door, and for the same reasons. It is in
// memory rather than in the database because the store runs on a single
// connection by design, and putting writes that any unauthenticated caller can
// trigger onto that connection would contend with the game loop for data that
// is worthless in ten minutes. The cost of a restart is one sign-in that has to
// be retried.
type ttlStore[Value any] struct {
	mu       sync.Mutex
	entries  map[string]ttlEntry[Value]
	lifetime time.Duration
	capacity int
	// now is injectable so an expiry test does not have to sleep.
	now func() time.Time
}

type ttlEntry[Value any] struct {
	value    Value
	expiryAt time.Time
}

func newTTLStore[Value any](lifetime time.Duration, capacity int) *ttlStore[Value] {
	return &ttlStore[Value]{
		entries:  make(map[string]ttlEntry[Value]),
		lifetime: lifetime,
		capacity: capacity,
		now:      time.Now,
	}
}

// put stores a value and returns the key, which is fresh randomness the caller
// hands out exactly once.
func (store *ttlStore[Value]) put(key string, value Value) {
	store.mu.Lock()
	defer store.mu.Unlock()
	if len(store.entries) >= store.capacity {
		store.evictExpiredLocked()
	}
	if len(store.entries) >= store.capacity {
		// Still full: everything in here is live. Dropping the oldest is crude
		// and correct — the worst case is that somebody who started signing in
		// ten minutes ago has to press the button again.
		store.dropOldestLocked()
	}
	store.entries[key] = ttlEntry[Value]{value: value, expiryAt: store.now().Add(store.lifetime)}
}

// take returns a value and removes it. Single use is the point: a state or a
// ticket that can be replayed is not a defence against replay.
func (store *ttlStore[Value]) take(key string) (Value, bool) {
	store.mu.Lock()
	defer store.mu.Unlock()
	entry, ok := store.entries[key]
	if !ok {
		var zero Value
		return zero, false
	}
	delete(store.entries, key)
	if store.now().After(entry.expiryAt) {
		var zero Value
		return zero, false
	}
	return entry.value, true
}

// peek returns a value and leaves it in place, for the one step that may need a
// second call: a sign-in that still has to choose a username.
func (store *ttlStore[Value]) peek(key string) (Value, bool) {
	store.mu.Lock()
	defer store.mu.Unlock()
	entry, ok := store.entries[key]
	if !ok || store.now().After(entry.expiryAt) {
		var zero Value
		return zero, false
	}
	return entry.value, true
}

func (store *ttlStore[Value]) sweep() {
	store.mu.Lock()
	defer store.mu.Unlock()
	store.evictExpiredLocked()
}

func (store *ttlStore[Value]) evictExpiredLocked() {
	now := store.now()
	for key, entry := range store.entries {
		if now.After(entry.expiryAt) {
			delete(store.entries, key)
		}
	}
}

func (store *ttlStore[Value]) dropOldestLocked() {
	var oldestKey string
	var oldest time.Time
	for key, entry := range store.entries {
		if oldest.IsZero() || entry.expiryAt.Before(oldest) {
			oldestKey, oldest = key, entry.expiryAt
		}
	}
	if oldestKey != "" {
		delete(store.entries, oldestKey)
	}
}

// oauthSecret returns URL-safe randomness for a state, a verifier, or a ticket.
func oauthSecret() (string, error) {
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(raw), nil
}

// pkceChallenge is the S256 transform.
//
// PKCE on a confidential client that already holds a secret is belt and
// braces, and it costs one hash: it protects the authorization code over the
// hop through an in-app browser, which is the leg this design cannot see.
func pkceChallenge(verifier string) string {
	sum := sha256.Sum256([]byte(verifier))
	return base64.RawURLEncoding.EncodeToString(sum[:])
}

func hashDiscordTicket(ticket string) string {
	sum := sha256.Sum256([]byte(strings.TrimSpace(ticket)))
	return hex.EncodeToString(sum[:])
}

// returnWithParameters builds the address the browser is sent back to.
func returnWithParameters(returnTo string, parameters url.Values) string {
	separator := "?"
	if strings.Contains(returnTo, "?") {
		separator = "&"
	}
	return returnTo + separator + parameters.Encode()
}
