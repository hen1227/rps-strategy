package server

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"sync"
	"testing"
	"time"
)

// The sign-in fixture: this server's real routes and a real database, with
// Apple and Discord replaced by the fakes these tests use, served for the
// app's own sign-in code to drive.
//
// Not a test. `frontend/e2e/signIn.e2e.mts` builds this package's test binary,
// runs only this with RPS_SIGNIN_FIXTURE=1, reads the address it prints, and
// runs the app's sign-in store against it: the same requests, in the same
// order, with the same credentials a phone sends. The route tests here prove
// each route; this proves the app and the routes agree, which is what failed
// when a beta build reached a server that did not have `POST /api/auth/link`.
// Closing stdin stops it.
//
// The halves of each provider that run on the device are stood in for as
// routes, which the end-to-end test calls where a phone would show a sheet:
//
//	POST /fixture/apple/sheet        Apple's sheet: a signed identity token
//	                                 and a code, for a nonce and an Apple ID
//	GET  /fixture/discord/authorize  Discord's consent page, consenting
//	POST /fixture/discord/user       who is signed in to Discord there
//	POST /fixture/guest              the lobby socket registering a device
//	POST /fixture/link-route         serve as a server from before the link
//	                                 route, which answers it with a bare 404
func TestServeSignInFixture(t *testing.T) {
	if os.Getenv("RPS_SIGNIN_FIXTURE") == "" {
		t.Skip("serves the sign-in fixture for frontend/e2e when RPS_SIGNIN_FIXTURE=1")
	}
	server, data, discord := discordTestServer(t)
	apple := withFakeApple(t, server)
	// Every phone the driver plays comes from 127.0.0.1, where real phones
	// each have an address of their own, so the per-address sign-in limit
	// would stop it a few accounts in.
	server.authLimiter = newRateLimiter(10_000, time.Minute)
	routes := server.Routes()

	var mu sync.Mutex
	linkRoute := true
	codes := 0

	mux := http.NewServeMux()
	mux.HandleFunc("/", func(writer http.ResponseWriter, request *http.Request) {
		mu.Lock()
		served := linkRoute
		mu.Unlock()
		if !served && request.URL.Path == "/api/auth/link" {
			http.NotFound(writer, request)
			return
		}
		routes.ServeHTTP(writer, request)
	})
	mux.HandleFunc("POST /fixture/apple/sheet", func(writer http.ResponseWriter, request *http.Request) {
		var input struct {
			Nonce   string `json:"nonce"`
			Subject string `json:"sub"`
		}
		if err := json.NewDecoder(request.Body).Decode(&input); err != nil || input.Subject == "" {
			http.Error(writer, "nonce and sub, please", http.StatusBadRequest)
			return
		}
		mu.Lock()
		codes++
		code := fmt.Sprintf("apple-code-%d", codes)
		mu.Unlock()
		// The code redeems for the same Apple ID the token names, as Apple's do.
		apple.mu.Lock()
		apple.codeSubjects[code] = input.Subject
		token := apple.mintLocked(t, map[string]any{"nonce": input.Nonce, "sub": input.Subject})
		apple.mu.Unlock()
		writeJSON(writer, http.StatusOK, map[string]string{
			"identityToken": token, "authorizationCode": code,
		})
	})
	mux.HandleFunc("GET /fixture/discord/authorize", func(writer http.ResponseWriter, request *http.Request) {
		query := request.URL.Query()
		back, err := url.Parse(query.Get("redirect_uri"))
		if err != nil || back.Host == "" {
			http.Error(writer, "no redirect_uri", http.StatusBadRequest)
			return
		}
		values := back.Query()
		values.Set("code", "discord-code")
		values.Set("state", query.Get("state"))
		back.RawQuery = values.Encode()
		http.Redirect(writer, request, back.String(), http.StatusFound)
	})
	mux.HandleFunc("POST /fixture/discord/user", func(writer http.ResponseWriter, request *http.Request) {
		var identity discordIdentity
		if err := json.NewDecoder(request.Body).Decode(&identity); err != nil || identity.ID == "" {
			http.Error(writer, "id, please", http.StatusBadRequest)
			return
		}
		discord.identity = identity
		writer.WriteHeader(http.StatusNoContent)
	})
	mux.HandleFunc("POST /fixture/guest", func(writer http.ResponseWriter, request *http.Request) {
		var input struct {
			UserID     string `json:"userId"`
			ProfileKey string `json:"profileKey"`
		}
		if err := json.NewDecoder(request.Body).Decode(&input); err != nil {
			http.Error(writer, err.Error(), http.StatusBadRequest)
			return
		}
		if _, err := data.EnsureAccountWithProfileKey(
			request.Context(), input.UserID, "Guest", input.ProfileKey,
		); err != nil {
			http.Error(writer, err.Error(), http.StatusBadRequest)
			return
		}
		writer.WriteHeader(http.StatusNoContent)
	})
	mux.HandleFunc("POST /fixture/link-route", func(writer http.ResponseWriter, request *http.Request) {
		var input struct {
			Served bool `json:"served"`
		}
		if err := json.NewDecoder(request.Body).Decode(&input); err != nil {
			http.Error(writer, err.Error(), http.StatusBadRequest)
			return
		}
		mu.Lock()
		linkRoute = input.Served
		mu.Unlock()
		writer.WriteHeader(http.StatusNoContent)
	})

	listener := httptest.NewServer(mux)
	defer listener.Close()
	// Discord sends the browser to its consent page and back to this server's
	// callback, which then sends it on to the app's own address. Both ends of
	// that are here now, and the app's address is the phone's custom scheme.
	server.discord.authorizeURL = listener.URL + "/fixture/discord/authorize"
	server.discord.redirectURL = listener.URL + "/api/auth/discord/callback"
	server.discord.returnURLs = []string{discordTestReturn, "rps-strategy:"}

	fmt.Printf("RPS_SIGNIN_FIXTURE_URL=%s\n", listener.URL)
	_, _ = io.Copy(io.Discard, os.Stdin)
}
