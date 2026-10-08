package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"strconv"
	"strings"

	"rps-strategy/backend/internal/persistence"
)

type discordStartRequest struct {
	// ReturnTo is where the browser should end up afterwards. Checked against
	// the allowlist here and nowhere else; see permittedReturnURL.
	ReturnTo string `json:"returnTo"`
	// UserID names the anonymous account the caller is asking to upgrade. Only
	// meaningful alongside a profile key, and ignored when a session token is
	// sent instead, since a session already says which account it is.
	UserID string `json:"userId"`
}

type discordStartReply struct {
	AuthorizeURL string `json:"authorizeUrl"`
}

// startDiscordAuth mints a flow and hands back the URL to send the player to.
//
// It answers with JSON rather than redirecting, for two reasons that both come
// from this being an app rather than a server-rendered page: a fetch that 302s
// to discord.com is followed by the fetch and then refused by CORS, and a
// top-level navigation cannot carry the Authorization header that says which
// account is asking — which is the entire linking mechanism.
func (server *Server) startDiscordAuth(writer http.ResponseWriter, request *http.Request) {
	if !server.discord.enabled {
		writeAPIError(writer, http.StatusServiceUnavailable,
			"Discord sign-in is not configured on this server")
		return
	}
	var input discordStartRequest
	if err := decodeAPIRequest(writer, request, &input); err != nil {
		writeAPIError(writer, http.StatusBadRequest, err.Error())
		return
	}
	if !server.allowOAuthStart(writer, request) {
		return
	}
	returnTo := strings.TrimSpace(input.ReturnTo)
	if !server.discord.permittedReturnURL(returnTo) {
		writeAPIError(writer, http.StatusBadRequest, "that return address is not allowed")
		return
	}

	// Who is asking, settled now rather than at the callback. A profile key
	// checked on the way back would have to survive the trip through Discord in
	// the state or a cookie, which means handing a long-lived device credential
	// to a third party. Reduced to a user ID here, it never leaves.
	linkUserID, fromSession, ok := server.resolveLinkTarget(writer, request, input.UserID)
	if !ok {
		return
	}
	if server.refuseStoreReviewLink(
		writer, request, linkUserID, fromSession, persistence.ProviderDiscord,
	) {
		return
	}

	state, err := oauthSecret()
	if err != nil {
		writeAPIError(writer, http.StatusInternalServerError, "could not start sign-in")
		return
	}
	verifier, err := oauthSecret()
	if err != nil {
		writeAPIError(writer, http.StatusInternalServerError, "could not start sign-in")
		return
	}
	server.discordFlows.put(state, discordFlow{
		verifier:        verifier,
		returnTo:        returnTo,
		linkUserID:      linkUserID,
		linkFromSession: fromSession,
	})

	query := url.Values{}
	query.Set("client_id", server.discord.clientID)
	query.Set("redirect_uri", server.discord.redirectURL)
	query.Set("response_type", "code")
	query.Set("scope", "identify")
	query.Set("state", state)
	query.Set("code_challenge", pkceChallenge(verifier))
	query.Set("code_challenge_method", "S256")
	writeJSON(writer, http.StatusOK, discordStartReply{
		AuthorizeURL: server.discord.authorizeURL + "?" + query.Encode(),
	})
}

// discordCallback is where Discord sends the browser back.
//
// Every exit is a redirect, including every failure: this is a page load in
// somebody's browser, not an API call, so answering with JSON would leave them
// staring at a payload. The app reads the outcome off the return URL.
func (server *Server) discordCallback(writer http.ResponseWriter, request *http.Request) {
	query := request.URL.Query()
	flow, ok := server.discordFlows.take(strings.TrimSpace(query.Get("state")))
	if !ok {
		// With no flow there is no validated return address, so the only place
		// it is safe to send them is the default.
		server.redirectWithSignInError(writer, request,
			server.discord.defaultReturnURL(), "expired")
		return
	}
	if refusal := strings.TrimSpace(query.Get("error")); refusal != "" {
		// Pressing Cancel arrives here. It is an ordinary outcome, not a fault.
		server.redirectWithSignInError(writer, request, flow.returnTo, refusal)
		return
	}
	code := strings.TrimSpace(query.Get("code"))
	if code == "" {
		server.redirectWithSignInError(writer, request, flow.returnTo, "invalid_request")
		return
	}

	identity, err := server.discord.identify(request.Context(), code, flow.verifier)
	if err != nil {
		log.Printf("discord sign-in: %v", err)
		server.redirectWithSignInError(writer, request, flow.returnTo, "discord_unavailable")
		return
	}

	ticket, err := server.issueSignInTicket(signInTicket{
		identity:        persistence.DiscordIdentity(identity.ID, identity.Username),
		suggestions:     []string{identity.GlobalName, identity.Username},
		linkUserID:      flow.linkUserID,
		linkFromSession: flow.linkFromSession,
	})
	if err != nil {
		server.redirectWithSignInError(writer, request, flow.returnTo, "server_error")
		return
	}
	http.Redirect(writer, request,
		returnWithParameters(flow.returnTo, url.Values{"ticket": {ticket}}),
		http.StatusSeeOther)
}

// discordIdentity is the part of Discord's user object this system keeps.
type discordIdentity struct {
	// ID is the snowflake, and it is the identity. Stable, unique, and the only
	// field worth matching on.
	ID string `json:"id"`
	// Username is the handle — lowercase, no spaces — and is what somebody
	// types into Discord to find this player.
	Username string `json:"username"`
	// GlobalName is a display name. Free-form, may hold spaces and emoji, and
	// is therefore only ever a source for a *suggested* in-game name.
	GlobalName string `json:"global_name"`
}

// identify runs the two calls to Discord: code for token, token for user.
func (auth *discordAuth) identify(
	ctx context.Context,
	code string,
	verifier string,
) (discordIdentity, error) {
	form := url.Values{}
	form.Set("grant_type", "authorization_code")
	form.Set("code", code)
	form.Set("redirect_uri", auth.redirectURL)
	form.Set("code_verifier", verifier)

	tokenRequest, err := http.NewRequestWithContext(
		ctx, http.MethodPost, auth.tokenURL, strings.NewReader(form.Encode()),
	)
	if err != nil {
		return discordIdentity{}, fmt.Errorf("build token request: %w", err)
	}
	tokenRequest.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	tokenRequest.SetBasicAuth(auth.clientID, auth.clientSecret)

	var token struct {
		AccessToken string `json:"access_token"`
	}
	if err := auth.call(tokenRequest, &token); err != nil {
		return discordIdentity{}, fmt.Errorf("exchange code: %w", err)
	}
	if token.AccessToken == "" {
		return discordIdentity{}, errors.New("exchange code: no access token in the reply")
	}

	userRequest, err := http.NewRequestWithContext(ctx, http.MethodGet, auth.userURL, nil)
	if err != nil {
		return discordIdentity{}, fmt.Errorf("build user request: %w", err)
	}
	userRequest.Header.Set("Authorization", "Bearer "+token.AccessToken)

	var identity discordIdentity
	if err := auth.call(userRequest, &identity); err != nil {
		return discordIdentity{}, fmt.Errorf("read discord user: %w", err)
	}
	if strings.TrimSpace(identity.ID) == "" {
		return discordIdentity{}, errors.New("read discord user: no id in the reply")
	}
	return identity, nil
}

// discordReplyLimit bounds what is read back from Discord. Generous for a small
// JSON object, and finite, which is the point.
const discordReplyLimit = 1 << 20

func (auth *discordAuth) call(request *http.Request, into any) error {
	request.Header.Set("Accept", "application/json")
	response, err := auth.client.Do(request)
	if err != nil {
		return err
	}
	defer func() { _ = response.Body.Close() }()
	body, err := io.ReadAll(io.LimitReader(response.Body, discordReplyLimit))
	if err != nil {
		return err
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return fmt.Errorf("discord answered %s: %s",
			strconv.Itoa(response.StatusCode), strings.TrimSpace(string(body)))
	}
	if err := json.Unmarshal(body, into); err != nil {
		return fmt.Errorf("decode discord reply: %w", err)
	}
	return nil
}
