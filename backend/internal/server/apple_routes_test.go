package server

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"math/big"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"

	"rps-strategy/backend/internal/persistence"
)

// A fake Apple, so both of Sign in with Apple's conversations are testable
// without leaving the process.
//
// It signs identity tokens with a real RSA key it publishes the way Apple
// does, and checks the client secret this server signs with a real ES256 key,
// so a test that passes here has exercised the same cryptography production
// will. It is a TLS server for the reason fakeDiscord gives.
type fakeApple struct {
	server   *httptest.Server
	tokenKey *rsa.PrivateKey
	// clientKey is the public half of the key the server under test signs its
	// client secrets with.
	clientKey *ecdsa.PublicKey

	mu sync.Mutex
	// subject is who every redeemed code belongs to, unless codeSubjects says
	// otherwise for a particular code.
	subject      string
	codeSubjects map[string]string
	// nonces is what the website's authorize step was given, by code, so the
	// token the code redeems for can carry it.
	nonces       map[string]string
	refuseCode   bool
	refuseRevoke bool
	tokenCalls   int
	lastRedirect string
	lastClientID string
	revoked      []fakeRevocation
	issued       int
}

type fakeRevocation struct {
	clientID string
	token    string
}

const (
	appleTestTeam      = "TEAM123456"
	appleTestKeyID     = "KEY1234567"
	appleTestBundle    = "com.henhen1227.rps-strategy"
	appleTestServices  = "com.henhen1227.rps-strategy.web"
	appleTestCallback  = "https://api-rps.example/api/auth/apple/callback"
	appleTestSubject   = "001234.0123456789abcdef0123456789abcdef.0123"
	appleTestSigningID = "fake-apple-key"
	// routeTestAppleProfileKey is a second device's key, for tests that need a
	// guest beside the one routeTestProfileKey names.
	routeTestAppleProfileKey = "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210"
)

func newFakeApple(t *testing.T, clientKey *ecdsa.PublicKey) *fakeApple {
	t.Helper()
	tokenKey, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	fake := &fakeApple{
		tokenKey:     tokenKey,
		clientKey:    clientKey,
		subject:      appleTestSubject,
		codeSubjects: map[string]string{},
		nonces:       map[string]string{},
	}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /auth/keys", func(writer http.ResponseWriter, _ *http.Request) {
		writeJSON(writer, http.StatusOK, map[string]any{"keys": []map[string]string{{
			"kty": "RSA", "kid": appleTestSigningID, "use": "sig", "alg": "RS256",
			"n": base64.RawURLEncoding.EncodeToString(tokenKey.N.Bytes()),
			"e": base64.RawURLEncoding.EncodeToString(big.NewInt(int64(tokenKey.E)).Bytes()),
		}}})
	})
	mux.HandleFunc("POST /auth/token", func(writer http.ResponseWriter, request *http.Request) {
		fake.mu.Lock()
		defer fake.mu.Unlock()
		fake.tokenCalls++
		if err := request.ParseForm(); err != nil {
			writeJSON(writer, http.StatusBadRequest, map[string]string{"error": "invalid_request"})
			return
		}
		clientID := request.Form.Get("client_id")
		fake.lastClientID = clientID
		fake.lastRedirect = request.Form.Get("redirect_uri")
		if !fake.validClientSecret(request.Form.Get("client_secret"), clientID) {
			writeJSON(writer, http.StatusBadRequest, map[string]string{"error": "invalid_client"})
			return
		}
		code := request.Form.Get("code")
		if fake.refuseCode || code == "" || code == "rps-key-check" {
			writeJSON(writer, http.StatusBadRequest, map[string]string{"error": "invalid_grant"})
			return
		}
		subject := fake.subject
		if override, ok := fake.codeSubjects[code]; ok {
			subject = override
		}
		fake.issued++
		writeJSON(writer, http.StatusOK, map[string]any{
			"access_token":  "apple-access",
			"token_type":    "Bearer",
			"expires_in":    3600,
			"refresh_token": "refresh-" + code,
			"id_token": fake.mintLocked(t, map[string]any{
				"aud": clientID, "sub": subject, "nonce": fake.nonces[code],
			}),
		})
	})
	mux.HandleFunc("POST /auth/revoke", func(writer http.ResponseWriter, request *http.Request) {
		fake.mu.Lock()
		defer fake.mu.Unlock()
		if err := request.ParseForm(); err != nil {
			writeJSON(writer, http.StatusBadRequest, map[string]string{"error": "invalid_request"})
			return
		}
		clientID := request.Form.Get("client_id")
		if !fake.validClientSecret(request.Form.Get("client_secret"), clientID) {
			writeJSON(writer, http.StatusBadRequest, map[string]string{"error": "invalid_client"})
			return
		}
		if fake.refuseRevoke {
			writeJSON(writer, http.StatusServiceUnavailable, map[string]string{"error": "server_error"})
			return
		}
		fake.revoked = append(fake.revoked, fakeRevocation{
			clientID: clientID, token: request.Form.Get("token"),
		})
		writer.WriteHeader(http.StatusOK)
	})
	fake.server = httptest.NewTLSServer(mux)
	t.Cleanup(fake.server.Close)
	return fake
}

// validClientSecret checks the JWT this server signs the way Apple does: ES256
// with the right key id, from the team, for this client, addressed to Apple.
func (fake *fakeApple) validClientSecret(secret string, clientID string) bool {
	claims := jwt.MapClaims{}
	token, err := jwt.ParseWithClaims(secret, claims, func(token *jwt.Token) (any, error) {
		return fake.clientKey, nil
	}, jwt.WithValidMethods([]string{"ES256"}), jwt.WithExpirationRequired())
	if err != nil || !token.Valid || token.Header["kid"] != appleTestKeyID {
		return false
	}
	// Apple reads `aud` as a plain string.
	audience, isString := claims["aud"].(string)
	return isString && audience == appleIssuer &&
		claims["iss"] == appleTestTeam && claims["sub"] == clientID && clientID != ""
}

// mint signs an identity token the way Apple would, with any claim overridden.
func (fake *fakeApple) mint(t *testing.T, overrides map[string]any) string {
	t.Helper()
	fake.mu.Lock()
	defer fake.mu.Unlock()
	return fake.mintLocked(t, overrides)
}

func (fake *fakeApple) mintLocked(t *testing.T, overrides map[string]any) string {
	now := time.Now()
	claims := jwt.MapClaims{
		"iss": appleIssuer,
		"aud": appleTestBundle,
		"sub": fake.subject,
		"iat": now.Unix(),
		"exp": now.Add(10 * time.Minute).Unix(),
	}
	for key, value := range overrides {
		claims[key] = value
	}
	token := jwt.NewWithClaims(jwt.SigningMethodRS256, claims)
	token.Header["kid"] = appleTestSigningID
	signed, err := token.SignedString(fake.tokenKey)
	if err != nil {
		t.Fatalf("mint identity token: %v", err)
	}
	return signed
}

// appleTestServer wires a Server to the fake, the way production wires it to
// Apple. Poked directly, as discordTestServer pokes Discord's.
func appleTestServer(t *testing.T) (*Server, *persistence.Store, *fakeApple) {
	t.Helper()
	server, data, _ := discordTestServer(t)
	return server, data, withFakeApple(t, server)
}

// withFakeApple points a server's Apple sign-in at a new fake, beside whatever
// it already has for Discord.
func withFakeApple(t *testing.T, server *Server) *fakeApple {
	t.Helper()
	clientKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	fake := newFakeApple(t, &clientKey.PublicKey)
	server.apple = &appleAuth{
		enabled:      true,
		webEnabled:   true,
		teamID:       appleTestTeam,
		keyID:        appleTestKeyID,
		bundleID:     appleTestBundle,
		servicesID:   appleTestServices,
		redirectURL:  appleTestCallback,
		returnURLs:   []string{discordTestReturn, "rps-strategy:"},
		key:          clientKey,
		issuer:       appleIssuer,
		authorizeURL: fake.server.URL + "/auth/authorize",
		tokenURL:     fake.server.URL + "/auth/token",
		revokeURL:    fake.server.URL + "/auth/revoke",
		keysURL:      fake.server.URL + "/auth/keys",
		client:       fake.server.Client(),
	}
	return fake
}

func routeRequest(
	t *testing.T,
	server *Server,
	method string,
	path string,
	body any,
	credential string,
) *httptest.ResponseRecorder {
	t.Helper()
	var payload string
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
		payload = string(encoded)
	}
	request := httptest.NewRequest(method, path, strings.NewReader(payload))
	if credential != "" {
		request.Header.Set("Authorization", "Bearer "+credential)
	}
	recorder := httptest.NewRecorder()
	server.Routes().ServeHTTP(recorder, request)
	return recorder
}

// beginAppleSignIn is the phone asking for a nonce.
func beginAppleSignIn(t *testing.T, server *Server, credential, userID string) string {
	t.Helper()
	recorder := routeRequest(t, server, http.MethodPost, "/api/auth/apple/nonce",
		appleNonceRequest{UserID: userID}, credential)
	if recorder.Code != http.StatusOK {
		t.Fatalf("nonce: %d %s", recorder.Code, recorder.Body)
	}
	var reply appleNonceReply
	if err := json.Unmarshal(recorder.Body.Bytes(), &reply); err != nil || reply.Nonce == "" {
		t.Fatalf("decode nonce reply: %v %s", err, recorder.Body)
	}
	return reply.Nonce
}

// finishAppleSignIn is the phone handing back what Apple's sheet returned.
func finishAppleSignIn(
	t *testing.T,
	server *Server,
	nonce string,
	identityToken string,
	code string,
) (signInReply, int) {
	t.Helper()
	recorder := routeRequest(t, server, http.MethodPost, "/api/auth/apple/native",
		appleNativeRequest{Nonce: nonce, IdentityToken: identityToken, AuthorizationCode: code}, "")
	var reply signInReply
	_ = json.Unmarshal(recorder.Body.Bytes(), &reply)
	return reply, recorder.Code
}

// appleSignIn is the whole phone sign-in, as Apple's sheet would answer it.
func appleSignIn(t *testing.T, server *Server, fake *fakeApple, credential, userID, code string) (signInReply, int) {
	t.Helper()
	nonce := beginAppleSignIn(t, server, credential, userID)
	return finishAppleSignIn(t, server, nonce, fake.mint(t, map[string]any{"nonce": nonce}), code)
}

func completeSignInAt(t *testing.T, server *Server, ticket, username string) (signInReply, int) {
	t.Helper()
	recorder := routeRequest(t, server, http.MethodPost, "/api/auth/complete",
		signInCompleteRequest{Ticket: ticket, Username: username}, "")
	var reply signInReply
	_ = json.Unmarshal(recorder.Body.Bytes(), &reply)
	return reply, recorder.Code
}

func queuedRevocations(t *testing.T, data *persistence.Store) []persistence.TokenRevocation {
	t.Helper()
	due, err := data.DueTokenRevocations(t.Context(), time.Now().Add(time.Hour), 50)
	if err != nil {
		t.Fatal(err)
	}
	return due
}

func TestAppleSignInOnThePhoneCreatesAnAccount(t *testing.T) {
	server, data, fake := appleTestServer(t)

	reply, status := appleSignIn(t, server, fake, "", "", "the-code")
	if status != http.StatusOK {
		t.Fatalf("native: %d %+v", status, reply)
	}
	if !reply.NeedsUsername || reply.Ticket == "" || reply.Provider != persistence.ProviderApple {
		t.Fatalf("a first sign-in must ask for a username, with the ticket: %+v", reply)
	}
	// Apple gives no name to suggest from, and a filler would be one to delete.
	if reply.SuggestedUsername != "" || reply.DiscordHandle != "" {
		t.Fatalf("an Apple sign-in suggested %q / %q", reply.SuggestedUsername, reply.DiscordHandle)
	}
	// The code was redeemed for the phone's client, with no redirect.
	if fake.lastClientID != appleTestBundle || fake.lastRedirect != "" {
		t.Fatalf("redeemed as %q with redirect %q", fake.lastClientID, fake.lastRedirect)
	}
	if _, err := data.AccountForIdentity(
		t.Context(), persistence.ProviderApple, appleTestSubject,
	); err == nil {
		t.Fatal("an account existed before the username was chosen")
	}

	done, status := completeSignInAt(t, server, reply.Ticket, "Orchard")
	if status != http.StatusOK || done.Token == "" || done.Account == nil {
		t.Fatalf("complete: %d %+v", status, done)
	}
	if !done.Account.Registered || done.Account.DiscordVerified {
		t.Fatalf("new account: %+v", done.Account)
	}

	// The refresh token was kept, for the phone's client: deleting the account
	// queues exactly that for revocation.
	if _, err := data.AnonymizeAccount(t.Context(), done.Account.UserID); err != nil {
		t.Fatal(err)
	}
	queued := queuedRevocations(t, data)
	if len(queued) != 1 || queued[0].Token != "refresh-the-code" || queued[0].ClientID != appleTestBundle {
		t.Fatalf("queued %+v, want the phone's refresh token", queued)
	}
}

func TestAppleSignInReturnsTheSameAccountNextTime(t *testing.T) {
	server, data, fake := appleTestServer(t)

	first, _ := appleSignIn(t, server, fake, "", "", "first-code")
	made, status := completeSignInAt(t, server, first.Ticket, "Orchard")
	if status != http.StatusOK {
		t.Fatalf("complete: %d", status)
	}

	second, status := appleSignIn(t, server, fake, "", "", "second-code")
	if status != http.StatusOK || second.NeedsUsername {
		t.Fatalf("a returning player was asked for a name: %d %+v", status, second)
	}
	if second.Account == nil || second.Account.UserID != made.Account.UserID || second.Token == "" {
		t.Fatalf("signed into a different account: %+v", second)
	}
	// The newer token replaces the older one.
	if _, err := data.AnonymizeAccount(t.Context(), made.Account.UserID); err != nil {
		t.Fatal(err)
	}
	if queued := queuedRevocations(t, data); len(queued) != 1 || queued[0].Token != "refresh-second-code" {
		t.Fatalf("queued %+v, want the newest token", queued)
	}
}

func TestAppleSignInUpgradesTheGuestThatProvedItself(t *testing.T) {
	server, data, fake := appleTestServer(t)
	if _, err := data.EnsureAccountWithProfileKey(
		t.Context(), "guest-1", "Guest", routeTestProfileKey,
	); err != nil {
		t.Fatal(err)
	}

	reply, _ := appleSignIn(t, server, fake, routeTestProfileKey, "guest-1", "code")
	done, status := completeSignInAt(t, server, reply.Ticket, "Orchard")
	if status != http.StatusOK {
		t.Fatalf("complete: %d %+v", status, done)
	}
	if done.Account.UserID != "guest-1" {
		t.Fatalf("the guest was abandoned rather than upgraded: %q", done.Account.UserID)
	}
}

// Every way a token can be wrong is a 401, and nothing is kept.
func TestAppleRefusesATokenThatIsNotForThisSignIn(t *testing.T) {
	server, data, fake := appleTestServer(t)

	otherKey, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	for name, forge := range map[string]func(nonce string) string{
		"minted for the website": func(nonce string) string {
			return fake.mint(t, map[string]any{"nonce": nonce, "aud": appleTestServices})
		},
		"another sign-in's nonce": func(string) string {
			return fake.mint(t, map[string]any{"nonce": "somebody-elses"})
		},
		"no nonce at all": func(string) string {
			return fake.mint(t, nil)
		},
		"expired": func(nonce string) string {
			return fake.mint(t, map[string]any{
				"nonce": nonce, "exp": time.Now().Add(-time.Hour).Unix(),
				"iat": time.Now().Add(-2 * time.Hour).Unix(),
			})
		},
		"not from Apple": func(nonce string) string {
			return fake.mint(t, map[string]any{"nonce": nonce, "iss": "https://evil.test"})
		},
		"signed by a key Apple never published": func(nonce string) string {
			token := jwt.NewWithClaims(jwt.SigningMethodRS256, jwt.MapClaims{
				"iss": appleIssuer, "aud": appleTestBundle, "sub": appleTestSubject,
				"nonce": nonce, "iat": time.Now().Unix(),
				"exp": time.Now().Add(time.Minute).Unix(),
			})
			token.Header["kid"] = appleTestSigningID
			signed, err := token.SignedString(otherKey)
			if err != nil {
				t.Fatal(err)
			}
			return signed
		},
		"signed with a shared secret": func(nonce string) string {
			token := jwt.NewWithClaims(jwt.SigningMethodHS256, jwt.MapClaims{
				"iss": appleIssuer, "aud": appleTestBundle, "sub": appleTestSubject,
				"nonce": nonce, "iat": time.Now().Unix(),
				"exp": time.Now().Add(time.Minute).Unix(),
			})
			token.Header["kid"] = appleTestSigningID
			signed, err := token.SignedString([]byte("guessable"))
			if err != nil {
				t.Fatal(err)
			}
			return signed
		},
	} {
		t.Run(name, func(t *testing.T) {
			nonce := beginAppleSignIn(t, server, "", "")
			reply, status := finishAppleSignIn(t, server, nonce, forge(nonce), "code")
			if status != http.StatusUnauthorized || reply.Token != "" || reply.Ticket != "" {
				t.Fatalf("a token %s was accepted: %d %+v", name, status, reply)
			}
		})
	}
	if _, err := data.AccountForIdentity(
		t.Context(), persistence.ProviderApple, appleTestSubject,
	); err == nil {
		t.Fatal("a refused token still made an account")
	}
}

// A nonce is used once, so a token captured from one sign-in cannot be played
// back into another.
func TestAnAppleNonceIsSingleUse(t *testing.T) {
	server, _, fake := appleTestServer(t)

	nonce := beginAppleSignIn(t, server, "", "")
	token := fake.mint(t, map[string]any{"nonce": nonce})
	if _, status := finishAppleSignIn(t, server, nonce, token, ""); status != http.StatusOK {
		t.Fatalf("first use: %d", status)
	}
	if _, status := finishAppleSignIn(t, server, nonce, token, ""); status != http.StatusUnauthorized {
		t.Fatalf("a spent nonce was accepted again: %d", status)
	}
}

// Some clients hand Apple the nonce's SHA-256 rather than the nonce. Either is
// proof of the same flow.
func TestAppleAcceptsTheHashedFormOfTheNonce(t *testing.T) {
	server, _, fake := appleTestServer(t)

	nonce := beginAppleSignIn(t, server, "", "")
	sum := sha256.Sum256([]byte(nonce))
	token := fake.mint(t, map[string]any{"nonce": hex.EncodeToString(sum[:])})
	if reply, status := finishAppleSignIn(t, server, nonce, token, ""); status != http.StatusOK ||
		!reply.NeedsUsername {
		t.Fatalf("the hashed nonce was refused: %d %+v", status, reply)
	}
}

// The code exchange is for deletion, not for signing in: Apple refusing it
// costs the player nothing, and the next sign-in tries again.
func TestAppleSignInSurvivesTheCodeExchangeFailing(t *testing.T) {
	server, data, fake := appleTestServer(t)
	fake.refuseCode = true

	reply, status := appleSignIn(t, server, fake, "", "", "code")
	if status != http.StatusOK || !reply.NeedsUsername {
		t.Fatalf("a refused code exchange failed the sign-in: %d %+v", status, reply)
	}
	done, _ := completeSignInAt(t, server, reply.Ticket, "Orchard")
	if _, err := data.AnonymizeAccount(t.Context(), done.Account.UserID); err != nil {
		t.Fatal(err)
	}
	if queued := queuedRevocations(t, data); len(queued) != 0 {
		t.Fatalf("queued %+v with no token to revoke", queued)
	}
}

// A code that redeems as somebody else must not leave their token on this
// account, where deleting it would revoke the wrong person's authorization.
func TestAppleKeepsNoTokenFromSomebodyElsesCode(t *testing.T) {
	server, data, fake := appleTestServer(t)
	fake.codeSubjects["borrowed-code"] = "000999.someone.else.0001"

	reply, status := appleSignIn(t, server, fake, "", "", "borrowed-code")
	if status != http.StatusOK {
		t.Fatalf("native: %d %+v", status, reply)
	}
	done, _ := completeSignInAt(t, server, reply.Ticket, "Orchard")
	if _, err := data.AnonymizeAccount(t.Context(), done.Account.UserID); err != nil {
		t.Fatal(err)
	}
	if queued := queuedRevocations(t, data); len(queued) != 0 {
		t.Fatalf("kept somebody else's token: %+v", queued)
	}
}

// Linking is written once: a player who signed up with Discord adds Apple from
// their session, and lands where they already were.
func TestLinkingAppleFromADiscordSessionKeepsTheAccount(t *testing.T) {
	server, data, fake := appleTestServer(t)
	if _, err := data.EnsureAccountWithProfileKey(
		t.Context(), "player", "Guest", routeTestProfileKey,
	); err != nil {
		t.Fatal(err)
	}
	if _, err := data.ClaimAccountWithIdentity(
		t.Context(), "player", "Yuki", persistence.DiscordIdentity("80351110224678912", "yuki"),
	); err != nil {
		t.Fatal(err)
	}
	session, err := data.CreateSession(t.Context(), "player")
	if err != nil {
		t.Fatal(err)
	}

	reply, status := appleSignIn(t, server, fake, session, "", "code")
	if status != http.StatusOK || reply.NeedsUsername {
		t.Fatalf("linking asked an established account for a name: %d %+v", status, reply)
	}
	if reply.Account == nil || reply.Account.UserID != "player" || reply.Account.Username != "Yuki" {
		t.Fatalf("linking changed the account: %+v", reply.Account)
	}
	methods, err := data.SignInMethods(t.Context(), "player")
	if err != nil {
		t.Fatal(err)
	}
	if strings.Join(methods.Methods, ",") != "discord,apple" {
		t.Fatalf("methods: %v", methods.Methods)
	}
	// And Apple alone now opens it.
	again, status := appleSignIn(t, server, fake, "", "", "later-code")
	if status != http.StatusOK || again.Account == nil || again.Account.UserID != "player" {
		t.Fatalf("Apple did not open the linked account: %d %+v", status, again)
	}
}

// Pressing "add Apple" on one account must never sign somebody into another.
// The refusal says where the Apple ID already leads.
func TestLinkingAnAppleIDHeldElsewhereIsRefusedWithTheWayOut(t *testing.T) {
	server, data, fake := appleTestServer(t)
	first, _ := appleSignIn(t, server, fake, "", "", "code")
	if _, status := completeSignInAt(t, server, first.Ticket, "Orchard"); status != http.StatusOK {
		t.Fatal(status)
	}
	if _, err := data.EnsureAccountWithProfileKey(
		t.Context(), "other", "Guest", routeTestAppleProfileKey,
	); err != nil {
		t.Fatal(err)
	}
	if _, err := data.ClaimAccountWithIdentity(
		t.Context(), "other", "Yuki", persistence.DiscordIdentity("80351110224678912", "yuki"),
	); err != nil {
		t.Fatal(err)
	}
	session, err := data.CreateSession(t.Context(), "other")
	if err != nil {
		t.Fatal(err)
	}

	nonce := beginAppleSignIn(t, server, session, "")
	recorder := routeRequest(t, server, http.MethodPost, "/api/auth/apple/native", appleNativeRequest{
		Nonce: nonce, IdentityToken: fake.mint(t, map[string]any{"nonce": nonce}),
	}, "")
	if recorder.Code != http.StatusConflict {
		t.Fatalf("linking an Apple ID held elsewhere answered %d: %s", recorder.Code, recorder.Body)
	}
	if !strings.Contains(recorder.Body.String(), "sign in with Apple to use it") {
		t.Fatalf("the refusal gives no way out: %s", recorder.Body)
	}
	if strings.Contains(recorder.Body.String(), `"token"`) {
		t.Fatalf("a refused link handed back a session: %s", recorder.Body)
	}
}

// A device key proves a guest. One that names an account already upgraded —
// a shared iPad, signed out — must not hand that account to the next Apple ID.
func TestADeviceKeyThatNamesAnUpgradedAccountIsIgnored(t *testing.T) {
	server, data, fake := appleTestServer(t)
	if _, err := data.EnsureAccountWithProfileKey(
		t.Context(), "first-person", "Guest", routeTestProfileKey,
	); err != nil {
		t.Fatal(err)
	}
	if _, err := data.ClaimAccountWithIdentity(
		t.Context(), "first-person", "Yuki", persistence.DiscordIdentity("80351110224678912", "yuki"),
	); err != nil {
		t.Fatal(err)
	}

	reply, status := appleSignIn(t, server, fake, routeTestProfileKey, "first-person", "code")
	if status != http.StatusOK || !reply.NeedsUsername {
		t.Fatalf("a second person's Apple ID should start a fresh signup: %d %+v", status, reply)
	}
	done, status := completeSignInAt(t, server, reply.Ticket, "Orchard")
	if status != http.StatusOK {
		t.Fatalf("complete: %d %+v", status, done)
	}
	if done.Account.UserID == "first-person" {
		t.Fatal("the Apple ID was attached to the account the device key named")
	}
	methods, err := data.SignInMethods(t.Context(), "first-person")
	if err != nil || strings.Join(methods.Methods, ",") != "discord" {
		t.Fatalf("the first person's account changed: %+v %v", methods, err)
	}
}

func TestAStoreReviewSessionIsRefusedApple(t *testing.T) {
	server, data, _ := appleTestServer(t)
	reset, err := data.ResetStoreReviewAccount(t.Context(), "apple",
		persistence.StoreReviewOptions{Username: "ReviewAda"})
	if err != nil {
		t.Fatal(err)
	}
	session, err := data.CreateSession(t.Context(), reset.UserID)
	if err != nil {
		t.Fatal(err)
	}
	for path, body := range map[string]any{
		"/api/auth/apple/nonce": appleNonceRequest{},
		"/api/auth/apple/start": appleStartRequest{ReturnTo: discordTestReturn},
	} {
		recorder := routeRequest(t, server, http.MethodPost, path, body, session)
		if recorder.Code != http.StatusForbidden ||
			!strings.Contains(recorder.Body.String(), "can't link an Apple ID") {
			t.Fatalf("%s: a review session was not refused: %d %s", path, recorder.Code, recorder.Body)
		}
	}
}

func TestTheProvidersRouteSaysWhatThisServerCanDo(t *testing.T) {
	read := func(server *Server) signInProvidersReply {
		recorder := routeRequest(t, server, http.MethodGet, "/api/auth/providers", nil, "")
		var reply signInProvidersReply
		if err := json.Unmarshal(recorder.Body.Bytes(), &reply); err != nil {
			t.Fatal(err)
		}
		return reply
	}
	configured, _, _ := appleTestServer(t)
	if reply := read(configured); !reply.Discord || !reply.Apple || !reply.AppleWeb {
		t.Fatalf("a configured server: %+v", reply)
	}
	configured.apple.webEnabled = false
	if reply := read(configured); !reply.Apple || reply.AppleWeb {
		t.Fatalf("a phone-only server: %+v", reply)
	}

	data, err := persistence.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = data.Close() })
	bare := NewWithStore(data, nil)
	if reply := read(bare); reply.Apple || reply.AppleWeb || reply.Discord {
		t.Fatalf("a fresh checkout: %+v", reply)
	}
	for _, path := range []string{
		"/api/auth/apple/nonce", "/api/auth/apple/native", "/api/auth/apple/start",
	} {
		if recorder := routeRequest(t, bare, http.MethodPost, path, map[string]string{}, ""); recorder.Code !=
			http.StatusServiceUnavailable {
			t.Errorf("%s on an unconfigured server: %d", path, recorder.Code)
		}
	}
}

// beginAppleWebSignIn runs the website's start and returns the authorize URL.
func beginAppleWebSignIn(t *testing.T, server *Server, credential string) *url.URL {
	t.Helper()
	recorder := routeRequest(t, server, http.MethodPost, "/api/auth/apple/start",
		appleStartRequest{ReturnTo: discordTestReturn + "/account/callback"}, credential)
	if recorder.Code != http.StatusOK {
		t.Fatalf("start: %d %s", recorder.Code, recorder.Body)
	}
	var reply appleStartReply
	if err := json.Unmarshal(recorder.Body.Bytes(), &reply); err != nil {
		t.Fatal(err)
	}
	authorize, err := url.Parse(reply.AuthorizeURL)
	if err != nil {
		t.Fatal(err)
	}
	return authorize
}

// returnFromApple plays Apple's redirect back, by GET or form POST, and returns
// where the browser was sent.
func returnFromApple(t *testing.T, server *Server, method string, values url.Values) *url.URL {
	t.Helper()
	var request *http.Request
	if method == http.MethodGet {
		request = httptest.NewRequest(method, "/api/auth/apple/callback?"+values.Encode(), nil)
	} else {
		request = httptest.NewRequest(method, "/api/auth/apple/callback",
			strings.NewReader(values.Encode()))
		request.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		request.Header.Set("Origin", "https://appleid.apple.com")
	}
	recorder := httptest.NewRecorder()
	server.Routes().ServeHTTP(recorder, request)
	if recorder.Code != http.StatusSeeOther {
		t.Fatalf("callback: %d %s", recorder.Code, recorder.Body)
	}
	location, err := url.Parse(recorder.Header().Get("Location"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(location.String(), discordTestReturn) {
		t.Fatalf("the callback left the allowlist: %s", location)
	}
	return location
}

func TestAppleSignInOnTheWebsite(t *testing.T) {
	for _, method := range []string{http.MethodGet, http.MethodPost} {
		t.Run(method, func(t *testing.T) {
			server, data, fake := appleTestServer(t)

			authorize := beginAppleWebSignIn(t, server, "")
			query := authorize.Query()
			// No name, no email, and a mode that lets the answer come back as
			// a plain GET.
			if query.Get("client_id") != appleTestServices || query.Get("redirect_uri") != appleTestCallback ||
				query.Get("response_type") != "code" || query.Get("response_mode") != "query" ||
				query.Has("scope") || query.Get("state") == "" || query.Get("nonce") == "" {
				t.Fatalf("authorize URL: %s", authorize)
			}
			fake.nonces["web-code"] = query.Get("nonce")

			location := returnFromApple(t, server, method, url.Values{
				"code": {"web-code"}, "state": {query.Get("state")},
			})
			ticket := location.Query().Get("ticket")
			if ticket == "" || location.Query().Get("error") != "" {
				t.Fatalf("callback returned %s", location)
			}
			if fake.lastClientID != appleTestServices || fake.lastRedirect != appleTestCallback {
				t.Fatalf("redeemed as %q with redirect %q", fake.lastClientID, fake.lastRedirect)
			}

			reply, status := redeemDiscordTicket(t, server, ticket)
			if status != http.StatusOK || !reply.NeedsUsername || reply.Provider != "apple" {
				t.Fatalf("exchange: %d %+v", status, reply)
			}
			done, status := completeSignInAt(t, server, ticket, "Orchard")
			if status != http.StatusOK || done.Token == "" {
				t.Fatalf("complete: %d %+v", status, done)
			}
			// The website's token is the Services ID's, and is revoked as such.
			if _, err := data.AnonymizeAccount(t.Context(), done.Account.UserID); err != nil {
				t.Fatal(err)
			}
			if queued := queuedRevocations(t, data); len(queued) != 1 ||
				queued[0].ClientID != appleTestServices {
				t.Fatalf("queued %+v, want the website's token", queued)
			}
		})
	}
}

// One Apple ID is one account whichever door it comes through: the website's
// sign-in finds the account the phone made.
func TestTheWebsiteFindsTheAccountThePhoneMade(t *testing.T) {
	server, _, fake := appleTestServer(t)
	phone, _ := appleSignIn(t, server, fake, "", "", "phone-code")
	made, status := completeSignInAt(t, server, phone.Ticket, "Orchard")
	if status != http.StatusOK {
		t.Fatal(status)
	}

	query := beginAppleWebSignIn(t, server, "").Query()
	fake.nonces["web-code"] = query.Get("nonce")
	location := returnFromApple(t, server, http.MethodGet, url.Values{
		"code": {"web-code"}, "state": {query.Get("state")},
	})
	reply, status := redeemDiscordTicket(t, server, location.Query().Get("ticket"))
	if status != http.StatusOK || reply.Account == nil || reply.Account.UserID != made.Account.UserID {
		t.Fatalf("the website did not find the phone's account: %d %+v", status, reply)
	}
}

func TestAppleWebsiteCallbackReportsWhatWentWrong(t *testing.T) {
	server, _, fake := appleTestServer(t)

	// Pressing Cancel on Apple's page.
	state := beginAppleWebSignIn(t, server, "").Query().Get("state")
	location := returnFromApple(t, server, http.MethodGet, url.Values{
		"error": {"user_cancelled_authorize"}, "state": {state},
	})
	if location.Query().Get("error") != "user_cancelled_authorize" {
		t.Fatalf("a cancel was not reported: %s", location)
	}
	// The same state again: spent.
	location = returnFromApple(t, server, http.MethodGet, url.Values{
		"code": {"web-code"}, "state": {state},
	})
	if location.Query().Get("error") != "expired" {
		t.Fatalf("a spent state was accepted: %s", location)
	}
	// Apple refusing the code.
	fake.refuseCode = true
	state = beginAppleWebSignIn(t, server, "").Query().Get("state")
	location = returnFromApple(t, server, http.MethodGet, url.Values{
		"code": {"web-code"}, "state": {state},
	})
	if location.Query().Get("error") != "apple_unavailable" {
		t.Fatalf("a refused code was not reported: %s", location)
	}
	// A token that does not carry this flow's nonce.
	fake.refuseCode = false
	state = beginAppleWebSignIn(t, server, "").Query().Get("state")
	fake.nonces["web-code"] = "a-different-flow"
	location = returnFromApple(t, server, http.MethodGet, url.Values{
		"code": {"web-code"}, "state": {state},
	})
	if location.Query().Get("error") != "apple_unavailable" {
		t.Fatalf("a token for another flow was accepted: %s", location)
	}
}

func TestAppleWebsiteStartRefusesAReturnAddressOffTheAllowlist(t *testing.T) {
	server, _, _ := appleTestServer(t)
	for _, hostile := range []string{"https://evil.test", discordTestReturn + ".evil.test", ""} {
		recorder := routeRequest(t, server, http.MethodPost, "/api/auth/apple/start",
			appleStartRequest{ReturnTo: hostile}, "")
		if recorder.Code != http.StatusBadRequest {
			t.Errorf("return address %q was accepted: %d", hostile, recorder.Code)
		}
	}
}

// The deletion queues the token; the worker tells Apple, with the client that
// minted it, and forgets it once Apple has said yes.
func TestDeletingAnAppleAccountRevokesItsToken(t *testing.T) {
	server, data, fake := appleTestServer(t)
	reply, _ := appleSignIn(t, server, fake, "", "", "code")
	done, status := completeSignInAt(t, server, reply.Ticket, "Orchard")
	if status != http.StatusOK {
		t.Fatal(status)
	}

	recorder := routeRequest(t, server, http.MethodDelete,
		"/api/accounts/"+done.Account.UserID, map[string]string{"confirm": "Orchard"}, done.Token)
	if recorder.Code != http.StatusOK {
		t.Fatalf("delete: %d %s", recorder.Code, recorder.Body)
	}
	select {
	case <-server.revocations:
	default:
		t.Fatal("deleting the account did not wake the revocation worker")
	}

	server.revokeDueTokens(t.Context())
	if len(fake.revoked) != 1 || fake.revoked[0].token != "refresh-code" ||
		fake.revoked[0].clientID != appleTestBundle {
		t.Fatalf("Apple was told %+v", fake.revoked)
	}
	if pending, err := data.PendingTokenRevocations(t.Context()); err != nil || pending != 0 {
		t.Fatalf("a revoked token was kept: %d %v", pending, err)
	}
}

// Apple being down never undoes a deletion. The token waits, a little longer
// each time, and goes when Apple answers.
func TestARefusedRevocationWaitsAndIsTriedAgain(t *testing.T) {
	server, data, fake := appleTestServer(t)
	reply, _ := appleSignIn(t, server, fake, "", "", "code")
	done, _ := completeSignInAt(t, server, reply.Ticket, "Orchard")
	if _, err := data.AnonymizeAccount(t.Context(), done.Account.UserID); err != nil {
		t.Fatal(err)
	}

	fake.refuseRevoke = true
	server.revokeDueTokens(t.Context())
	if due, err := data.DueTokenRevocations(t.Context(), time.Now(), 10); err != nil || len(due) != 0 {
		t.Fatalf("a refused revocation was due again at once: %+v %v", due, err)
	}
	later, err := data.DueTokenRevocations(t.Context(), time.Now().Add(revocationBackoff(0)+time.Second), 10)
	if err != nil || len(later) != 1 || later[0].Attempts != 1 {
		t.Fatalf("the refused revocation did not wait its turn: %+v %v", later, err)
	}
}

func TestRevocationBackoffDoublesAndStops(t *testing.T) {
	for attempts, want := range map[int]time.Duration{
		0: time.Minute, 1: 2 * time.Minute, 5: 32 * time.Minute,
		9: revocationLongestWait, 40: revocationLongestWait,
	} {
		if got := revocationBackoff(attempts); got != want {
			t.Errorf("after %d attempts: %s, want %s", attempts, got, want)
		}
	}
}

// The boot-time check reads Apple's answer to a made-up code: invalid_grant
// means the key is good, invalid_client means it is not.
func TestTheKeyCheckTellsAGoodKeyFromABadOne(t *testing.T) {
	server, _, _ := appleTestServer(t)
	_, err := server.apple.redeemCode(t.Context(), appleTestBundle, "rps-key-check", "")
	var refusal *appleRefusal
	if !errors.As(err, &refusal) || refusal.code != "invalid_grant" {
		t.Fatalf("a good key: %v", err)
	}

	wrongKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	server.apple.key = wrongKey
	_, err = server.apple.redeemCode(t.Context(), appleTestBundle, "rps-key-check", "")
	if !errors.As(err, &refusal) || refusal.code != "invalid_client" {
		t.Fatalf("a wrong key: %v", err)
	}
}

// The generic routes and Discord's own names for them are the same routes, so
// a build that predates Apple keeps working against this server.
func TestTheSharedSignInRoutesServeDiscordToo(t *testing.T) {
	server, _, _ := discordTestServer(t)
	state := beginDiscordSignIn(t, server, "", "")
	ticket, _ := followDiscordCallback(t, server, state)

	recorder := routeRequest(t, server, http.MethodPost, "/api/auth/exchange",
		signInTicketRequest{Ticket: ticket}, "")
	var reply signInReply
	if err := json.Unmarshal(recorder.Body.Bytes(), &reply); err != nil || !reply.NeedsUsername ||
		reply.SuggestedUsername != "Yuki" || reply.DiscordHandle != "yuki" ||
		reply.Provider != persistence.ProviderDiscord {
		t.Fatalf("exchange: %d %+v %v", recorder.Code, reply, err)
	}
	if done, status := completeSignInAt(t, server, ticket, "Yuki"); status != http.StatusOK ||
		!done.Account.DiscordVerified {
		t.Fatalf("complete: %d %+v", status, done)
	}
}

// The same device-key rule holds for Discord: a key naming an upgraded account
// starts a fresh signup rather than linking to somebody else's account.
func TestADeviceKeyThatNamesAnUpgradedAccountIsIgnoredByDiscordToo(t *testing.T) {
	server, data, _ := discordTestServer(t)
	if _, err := data.EnsureAccountWithProfileKey(
		t.Context(), "first-person", "Guest", routeTestProfileKey,
	); err != nil {
		t.Fatal(err)
	}
	if _, err := data.ClaimAccountWithIdentity(
		t.Context(), "first-person", "Orchard", persistence.AppleIdentity(appleTestSubject, "", ""),
	); err != nil {
		t.Fatal(err)
	}

	state := beginDiscordSignIn(t, server, routeTestProfileKey, "first-person")
	ticket, _ := followDiscordCallback(t, server, state)
	reply, status := redeemDiscordTicket(t, server, ticket)
	if status != http.StatusOK || !reply.NeedsUsername {
		t.Fatalf("a second person's Discord should start a fresh signup: %d %+v", status, reply)
	}
}
