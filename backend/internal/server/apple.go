package server

import (
	"context"
	"crypto/ecdsa"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"math/big"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

// Signing in with Apple.
//
// The second provider, and the reason the linking in signin.go is written once:
// App Store guideline 4.8 asks an app whose players sign in with a social login
// to offer one that collects nothing beyond a name and an email, lets the
// player keep their email private, and does no tracking. Sign in with Apple is
// that, and here it collects less than that — no name and no email are asked
// for, so all this server ever learns is an opaque id Apple makes for this app.
//
// Two ways in, ending in the same ticket Discord's does:
//
//   - On the phone, Apple's own sheet. The app asks for a nonce, hands it to the
//     sheet, and sends back the identity token and authorization code the
//     sheet returns. The token is a JWT Apple signed, checked against the keys
//     Apple publishes; the nonce inside it is what ties it to this sign-in.
//   - On the website, a redirect, the way Discord's works: out to Apple with a
//     state and a nonce, back to a callback on this server, which redeems the
//     code for a token and only then sends the browser home with a ticket.
//
// Either way the authorization code is redeemed, signed with this server's own
// Sign in with Apple key, and the refresh token that comes back is kept. It has
// one use: revoking this app's access when the account is deleted, which Apple
// asks every app that offers its sign-in to do. See identity_revocation.go.
// A failed redemption costs the player nothing — they are still signed in —
// and the next sign-in tries again.
//
// # Facts that differ from the obvious reading
//
//   - Apple's documentation for verifying a token mentions ES256, but the keys
//     it actually publishes for identity tokens are RS256, and only RS256 is
//     accepted here.
//   - The audience is the app's bundle id for a token from the phone and the
//     Services ID for one from the website. Each route checks for its own and
//     never the other, so a token minted for one client cannot sign in as the
//     other.
//   - Expo hands the nonce to Apple unchanged, and Apple puts what it was given
//     into the token. Whether that is the string itself or its SHA-256 — the
//     form some libraries pass — is accepted either way. See appleNonceMatches.
//   - `sub` is fixed per Apple developer team. Moving the app to a different
//     team changes every player's, behind a migration with a deadline.

const (
	appleIssuer       = "https://appleid.apple.com"
	appleAuthorizeURL = "https://appleid.apple.com/auth/authorize"
	appleTokenURL     = "https://appleid.apple.com/auth/token"
	appleRevokeURL    = "https://appleid.apple.com/auth/revoke"
	appleKeysURL      = "https://appleid.apple.com/auth/keys"

	// appleDefaultBundleID is the app, which is what Apple calls the client on
	// the phone. Defaulted rather than required, because there is one app; the
	// same value APNs calls a topic.
	appleDefaultBundleID = "com.henhen1227.rps-strategy"

	// appleFlowLifetime bounds how long somebody may sit on Apple's sheet or
	// its website. Generous for a Face ID glance, and short enough that an
	// abandoned flow is not worth remembering.
	appleFlowLifetime = 10 * time.Minute
	// appleKeysLifetime is how long Apple's published keys are trusted before
	// they are fetched again. Apple rotates them rarely and without notice; a
	// token naming a key that is not cached triggers a fetch before then.
	appleKeysLifetime = 24 * time.Hour
	// appleKeysRefetchFloor stops a token naming a key Apple does not have from
	// turning every sign-in attempt into a request to Apple.
	appleKeysRefetchFloor = time.Minute
	// appleClientSecretLifetime is how long each signed client secret is good
	// for. Apple allows six months; one is minted per request instead, so a
	// leaked one is worth ten minutes.
	appleClientSecretLifetime = 10 * time.Minute
	// appleReplyLimit bounds what is read back from Apple. Generous for a small
	// JSON object, and finite, which is the point.
	appleReplyLimit = 1 << 20
)

// appleAuth holds the configuration and the seam tests reach through.
//
// The URLs are fields rather than constants so a test can point them at an
// httptest server, and the client is the same seam discordAuth and apnsSender
// use. Nothing in production sets any of them.
type appleAuth struct {
	// enabled is the phone: a key, its id, the team and the bundle id. Without
	// it there is no Apple button anywhere.
	enabled bool
	// webEnabled is the website on top of that: a Services ID, the callback
	// Apple sends the browser to, and somewhere to send it on to.
	webEnabled  bool
	teamID      string
	keyID       string
	bundleID    string
	servicesID  string
	redirectURL string
	returnURLs  []string
	key         *ecdsa.PrivateKey

	issuer       string
	authorizeURL string
	tokenURL     string
	revokeURL    string
	keysURL      string
	client       httpDoer

	keys appleKeyCache
}

// appleKeyCache is Apple's published keys, by id.
type appleKeyCache struct {
	mu        sync.Mutex
	keys      map[string]*rsa.PublicKey
	fetchedAt time.Time
}

// appleFlow is what is remembered between handing somebody to Apple and their
// coming back: the nonce the token must carry, where a website flow returns
// to, and the account the caller proved, if any. Like discordFlow it holds no
// credential — a device key is reduced to a user ID before it is stored.
type appleFlow struct {
	nonce           string
	returnTo        string
	linkUserID      string
	linkFromSession bool
}

// newAppleAuth reads the environment, following the rule the other providers
// set: a half-configured deployment is refused loudly rather than quietly
// behaving as though the feature were switched off, and an unconfigured one
// says nothing, because that is a fresh checkout and not a mistake.
func newAppleAuth() *appleAuth {
	auth := &appleAuth{
		teamID:       strings.TrimSpace(os.Getenv("RPS_APPLE_TEAM_ID")),
		keyID:        strings.TrimSpace(os.Getenv("RPS_APPLE_KEY_ID")),
		bundleID:     strings.TrimSpace(os.Getenv("RPS_APPLE_BUNDLE_ID")),
		servicesID:   strings.TrimSpace(os.Getenv("RPS_APPLE_SERVICES_ID")),
		redirectURL:  strings.TrimSpace(os.Getenv("RPS_APPLE_REDIRECT_URL")),
		issuer:       appleIssuer,
		authorizeURL: appleAuthorizeURL,
		tokenURL:     appleTokenURL,
		revokeURL:    appleRevokeURL,
		keysURL:      appleKeysURL,
		client:       &http.Client{Timeout: 10 * time.Second},
	}
	keyPath := strings.TrimSpace(os.Getenv("RPS_APPLE_KEY_PATH"))
	if keyPath == "" && auth.keyID == "" && auth.teamID == "" &&
		auth.servicesID == "" && auth.redirectURL == "" {
		return auth
	}
	// The team is the one the APNs key belongs to, which is the same team.
	if auth.teamID == "" {
		auth.teamID = strings.TrimSpace(os.Getenv("RPS_APNS_TEAM_ID"))
	}
	if auth.bundleID == "" {
		auth.bundleID = appleDefaultBundleID
	}
	// The same addresses Discord sends people home to, unless told otherwise:
	// both are the app's own pages, on the web and behind its URL scheme.
	returns := os.Getenv("RPS_APPLE_RETURN_URLS")
	if strings.TrimSpace(returns) == "" {
		returns = os.Getenv("RPS_DISCORD_RETURN_URLS")
	}
	auth.returnURLs = parseReturnURLs(returns)

	if keyPath == "" || auth.keyID == "" || auth.teamID == "" {
		log.Print("Sign in with Apple disabled: RPS_APPLE_KEY_PATH, RPS_APPLE_KEY_ID and " +
			"RPS_APPLE_TEAM_ID (or RPS_APNS_TEAM_ID) must all be set")
		return auth
	}
	key, err := loadAppleKey(keyPath)
	if err != nil {
		// Named at boot, where somebody is looking. Discovered at the first
		// sign-in instead, it would read as Apple being broken.
		log.Printf("Sign in with Apple disabled: %v", err)
		return auth
	}
	auth.key = key
	auth.enabled = true

	if auth.servicesID == "" && auth.redirectURL == "" {
		return auth
	}
	if auth.servicesID == "" || auth.redirectURL == "" || len(auth.returnURLs) == 0 {
		log.Print("Sign in with Apple on the website disabled: RPS_APPLE_SERVICES_ID and " +
			"RPS_APPLE_REDIRECT_URL must both be set, with RPS_APPLE_RETURN_URLS or " +
			"RPS_DISCORD_RETURN_URLS to send people back to")
		return auth
	}
	auth.webEnabled = true
	return auth
}

// loadAppleKey reads the .p8 Apple hands out for a Sign in with Apple key: a
// PKCS#8 PEM file, parsed by the JWT library for the reason loadAPNsKey gives.
func loadAppleKey(path string) (*ecdsa.PrivateKey, error) {
	pem, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read Sign in with Apple key %s: %w", path, err)
	}
	key, err := jwt.ParseECPrivateKeyFromPEM(pem)
	if err != nil {
		return nil, fmt.Errorf("parse Sign in with Apple key %s: %w", path, err)
	}
	return key, nil
}

// errMismatchedAppleNonce is a genuine Apple token that was not issued for
// this sign-in: replayed from another flow, or carried over from another app.
var errMismatchedAppleNonce = errors.New("the identity token does not carry this sign-in's nonce")

// appleIdentityClaims is the part of Apple's identity token this server reads.
// Email and the private-relay flags are never asked for, so never present.
type appleIdentityClaims struct {
	jwt.RegisteredClaims
	Nonce string `json:"nonce"`
}

// verifyIdentityToken checks an identity token Apple issued for one audience,
// and returns what it says. The caller checks the nonce against its own flow:
// see appleNonceMatches.
func (auth *appleAuth) verifyIdentityToken(
	ctx context.Context,
	raw string,
	audience string,
) (appleIdentityClaims, error) {
	var claims appleIdentityClaims
	_, err := jwt.ParseWithClaims(strings.TrimSpace(raw), &claims, func(token *jwt.Token) (any, error) {
		keyID, _ := token.Header["kid"].(string)
		if keyID == "" {
			return nil, errors.New("the token names no key")
		}
		return auth.publicKey(ctx, keyID)
	},
		jwt.WithValidMethods([]string{jwt.SigningMethodRS256.Alg()}),
		jwt.WithIssuer(auth.issuer),
		jwt.WithAudience(audience),
		jwt.WithExpirationRequired(),
		jwt.WithIssuedAt(),
		jwt.WithLeeway(time.Minute),
	)
	if err != nil {
		return appleIdentityClaims{}, fmt.Errorf("verify Apple identity token: %w", err)
	}
	if strings.TrimSpace(claims.Subject) == "" {
		return appleIdentityClaims{}, errors.New("verify Apple identity token: no subject")
	}
	return claims, nil
}

// appleNonceMatches is whether a token carries the nonce this sign-in issued.
//
// Either the nonce itself or its SHA-256 in hex. Apple puts into the token
// whatever the client gave it, and the convention some clients follow is to
// give it the hash; Expo's module passes the string straight through. Both
// bind the token to this flow equally — the hash of a secret only this flow
// knows is as unforgeable as the secret — so accepting both costs nothing and
// keeps a client library's choice from breaking sign-in.
func appleNonceMatches(claimed string, issued string) bool {
	if claimed == "" || issued == "" {
		return false
	}
	if subtle.ConstantTimeCompare([]byte(claimed), []byte(issued)) == 1 {
		return true
	}
	sum := sha256.Sum256([]byte(issued))
	return subtle.ConstantTimeCompare([]byte(claimed), []byte(hex.EncodeToString(sum[:]))) == 1
}

// publicKey is one of Apple's published keys, fetched and cached.
//
// Held under the lock across the fetch, which serialises sign-ins for the
// length of one request to Apple about once a day. Cheaper than reasoning
// about two fetches racing to replace the cache.
func (auth *appleAuth) publicKey(ctx context.Context, keyID string) (*rsa.PublicKey, error) {
	auth.keys.mu.Lock()
	defer auth.keys.mu.Unlock()
	now := time.Now()
	key, known := auth.keys.keys[keyID]
	if known && now.Sub(auth.keys.fetchedAt) < appleKeysLifetime {
		return key, nil
	}
	if !auth.keys.fetchedAt.IsZero() && now.Sub(auth.keys.fetchedAt) < appleKeysRefetchFloor {
		if known {
			return key, nil
		}
		return nil, fmt.Errorf("Apple publishes no key %q", keyID)
	}
	keys, err := auth.fetchKeys(ctx)
	if err != nil {
		// A key Apple published yesterday still verifies a token today, so
		// Apple's key endpoint being down is not a reason to refuse one.
		if known {
			return key, nil
		}
		return nil, err
	}
	auth.keys.keys, auth.keys.fetchedAt = keys, now
	if key, known = keys[keyID]; !known {
		return nil, fmt.Errorf("Apple publishes no key %q", keyID)
	}
	return key, nil
}

func (auth *appleAuth) fetchKeys(ctx context.Context) (map[string]*rsa.PublicKey, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, auth.keysURL, nil)
	if err != nil {
		return nil, fmt.Errorf("build Apple keys request: %w", err)
	}
	var published struct {
		Keys []struct {
			KeyType string `json:"kty"`
			KeyID   string `json:"kid"`
			Use     string `json:"use"`
			Modulus string `json:"n"`
			Expo    string `json:"e"`
		} `json:"keys"`
	}
	if err := auth.call(request, &published); err != nil {
		return nil, fmt.Errorf("fetch Apple's keys: %w", err)
	}
	keys := make(map[string]*rsa.PublicKey, len(published.Keys))
	for _, candidate := range published.Keys {
		if candidate.KeyType != "RSA" || candidate.KeyID == "" ||
			(candidate.Use != "" && candidate.Use != "sig") {
			continue
		}
		modulus, err := base64.RawURLEncoding.DecodeString(candidate.Modulus)
		if err != nil {
			continue
		}
		exponent, err := base64.RawURLEncoding.DecodeString(candidate.Expo)
		if err != nil || len(exponent) == 0 || len(exponent) > 4 {
			continue
		}
		keys[candidate.KeyID] = &rsa.PublicKey{
			N: new(big.Int).SetBytes(modulus),
			E: int(new(big.Int).SetBytes(exponent).Int64()),
		}
	}
	if len(keys) == 0 {
		return nil, errors.New("fetch Apple's keys: none were usable")
	}
	return keys, nil
}

// clientSecret signs the JWT that stands for a client secret, for one client:
// the bundle id or the Services ID. Apple wants `aud` as a plain string, which
// is why the claims are a map rather than RegisteredClaims, whose audience is
// written as a list.
func (auth *appleAuth) clientSecret(clientID string) (string, error) {
	now := time.Now()
	token := jwt.NewWithClaims(jwt.SigningMethodES256, jwt.MapClaims{
		"iss": auth.teamID,
		"iat": now.Unix(),
		"exp": now.Add(appleClientSecretLifetime).Unix(),
		"aud": auth.issuer,
		"sub": clientID,
	})
	token.Header["kid"] = auth.keyID
	return token.SignedString(auth.key)
}

// appleTokenReply is the part of Apple's token response this server keeps.
type appleTokenReply struct {
	RefreshToken string `json:"refresh_token"`
	IDToken      string `json:"id_token"`
}

// appleRefusal is Apple answering with an error, which says which kind:
// `invalid_grant` is a code that is spent, expired or made up, and
// `invalid_client` is this server's key or configuration.
type appleRefusal struct {
	status int
	code   string
}

func (refusal *appleRefusal) Error() string {
	return fmt.Sprintf("Apple answered %d %s", refusal.status, refusal.code)
}

// redeemCode trades an authorization code for tokens. The website's code needs
// the redirect address it was issued to; the phone's needs none.
func (auth *appleAuth) redeemCode(
	ctx context.Context,
	clientID string,
	code string,
	redirectURI string,
) (appleTokenReply, error) {
	secret, err := auth.clientSecret(clientID)
	if err != nil {
		return appleTokenReply{}, fmt.Errorf("sign Apple client secret: %w", err)
	}
	form := url.Values{}
	form.Set("client_id", clientID)
	form.Set("client_secret", secret)
	form.Set("code", code)
	form.Set("grant_type", "authorization_code")
	if redirectURI != "" {
		form.Set("redirect_uri", redirectURI)
	}
	request, err := http.NewRequestWithContext(
		ctx, http.MethodPost, auth.tokenURL, strings.NewReader(form.Encode()),
	)
	if err != nil {
		return appleTokenReply{}, fmt.Errorf("build Apple token request: %w", err)
	}
	request.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	var reply appleTokenReply
	if err := auth.call(request, &reply); err != nil {
		return appleTokenReply{}, fmt.Errorf("redeem Apple authorization code: %w", err)
	}
	return reply, nil
}

// revoke tells Apple a refresh token is no longer wanted, which withdraws the
// player's authorization of this app. Apple answers 200 even for a token that
// was already dead, so 200 means done either way.
func (auth *appleAuth) revoke(ctx context.Context, clientID string, token string) error {
	secret, err := auth.clientSecret(clientID)
	if err != nil {
		return fmt.Errorf("sign Apple client secret: %w", err)
	}
	form := url.Values{}
	form.Set("client_id", clientID)
	form.Set("client_secret", secret)
	form.Set("token", token)
	form.Set("token_type_hint", "refresh_token")
	request, err := http.NewRequestWithContext(
		ctx, http.MethodPost, auth.revokeURL, strings.NewReader(form.Encode()),
	)
	if err != nil {
		return fmt.Errorf("build Apple revoke request: %w", err)
	}
	request.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	if err := auth.call(request, nil); err != nil {
		return fmt.Errorf("revoke Apple token: %w", err)
	}
	return nil
}

// keepRefreshToken redeems the code that came with a sign-in, for the token
// deletion will need, and returns the identity carrying it.
//
// Never a reason to refuse the sign-in. The identity token has already proved
// who this is; the refresh token is only for revoking later, and a sign-in that
// fails because a second call to Apple did is the worse outcome by far. The
// token from the redemption is checked to be the same person's, so a code from
// somebody else's sign-in can never leave their token on this account — where a
// deletion would revoke the wrong player's authorization.
func (auth *appleAuth) keepRefreshToken(
	ctx context.Context,
	subject string,
	clientID string,
	code string,
	redirectURI string,
) (string, string) {
	reply, err := auth.redeemCode(ctx, clientID, code, redirectURI)
	if err != nil {
		log.Printf("Sign in with Apple: no refresh token kept (%v); "+
			"the next sign-in will try again", err)
		return "", ""
	}
	if reply.IDToken != "" {
		claims, err := auth.verifyIdentityToken(ctx, reply.IDToken, clientID)
		if err != nil || claims.Subject != subject {
			log.Printf("Sign in with Apple: the redeemed code did not belong to this sign-in; " +
				"no refresh token kept")
			return "", ""
		}
	}
	if reply.RefreshToken == "" {
		return "", ""
	}
	return reply.RefreshToken, clientID
}

// checkKey asks Apple, once at boot, whether it accepts this server's key.
//
// By redeeming a code that does not exist. Apple answers `invalid_grant` when
// the client secret was good and the code was not — which is the answer wanted
// — and `invalid_client` when the key, its id, the team or the client's
// configuration is wrong. Without this, a wrong key is found at the first
// sign-in on the website, which fails, or not at all on the phone, where
// sign-in works and every deletion quietly keeps its Apple token.
func (auth *appleAuth) checkKey(ctx context.Context) {
	if !auth.enabled {
		return
	}
	clients := []string{auth.bundleID}
	if auth.webEnabled {
		clients = append(clients, auth.servicesID)
	}
	for _, clientID := range clients {
		redirect := ""
		if clientID == auth.servicesID {
			redirect = auth.redirectURL
		}
		_, err := auth.redeemCode(ctx, clientID, "rps-key-check", redirect)
		var refusal *appleRefusal
		switch {
		case errors.As(err, &refusal) && refusal.code == "invalid_grant":
			log.Printf("Sign in with Apple: Apple accepts this server's key for %s", clientID)
		case errors.As(err, &refusal) && refusal.code == "invalid_client":
			log.Printf("Sign in with Apple: Apple REFUSED this server's key for %s. Check "+
				"RPS_APPLE_KEY_ID and RPS_APPLE_TEAM_ID, that the key has Sign in with Apple "+
				"enabled with %s as its primary App ID, and that the Services ID is grouped "+
				"under it. Until then the website cannot sign anybody in, and deleting an "+
				"account cannot revoke its Apple token", clientID, auth.bundleID)
		case err != nil:
			if ctx.Err() == nil {
				log.Printf("Sign in with Apple: could not check the key for %s: %v", clientID, err)
			}
		}
	}
}

// call sends a request to Apple and decodes a JSON reply into `into`, or
// discards it when `into` is nil. An error reply becomes an appleRefusal.
func (auth *appleAuth) call(request *http.Request, into any) error {
	request.Header.Set("Accept", "application/json")
	response, err := auth.client.Do(request)
	if err != nil {
		return err
	}
	defer func() { _ = response.Body.Close() }()
	body, err := io.ReadAll(io.LimitReader(response.Body, appleReplyLimit))
	if err != nil {
		return err
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		var failure struct {
			Error string `json:"error"`
		}
		_ = json.Unmarshal(body, &failure)
		code := strings.TrimSpace(failure.Error)
		if code == "" {
			code = "unknown_error"
		}
		return &appleRefusal{status: response.StatusCode, code: code}
	}
	if into == nil {
		return nil
	}
	if err := json.Unmarshal(body, into); err != nil {
		return fmt.Errorf("decode Apple's reply: %w", err)
	}
	return nil
}
