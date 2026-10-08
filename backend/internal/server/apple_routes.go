package server

import (
	"log"
	"net/http"
	"net/url"
	"strings"

	"rps-strategy/backend/internal/persistence"
)

// The routes Apple's two sign-ins arrive by. See apple.go for the shape of
// both, and signin.go for what the ticket they end in does.

type appleNonceRequest struct {
	// UserID names the guest the caller is asking to upgrade, as it does for
	// Discord: only meaningful alongside a device key, and ignored when a
	// session is sent instead.
	UserID string `json:"userId"`
}

type appleNonceReply struct {
	Nonce string `json:"nonce"`
}

type appleNativeRequest struct {
	Nonce             string `json:"nonce"`
	IdentityToken     string `json:"identityToken"`
	AuthorizationCode string `json:"authorizationCode"`
}

type appleStartRequest struct {
	// ReturnTo is where the browser should end up afterwards, checked against
	// the allowlist here and nowhere else. See permittedReturnURL.
	ReturnTo string `json:"returnTo"`
	UserID   string `json:"userId"`
}

type appleStartReply struct {
	AuthorizeURL string `json:"authorizeUrl"`
}

// startAppleNativeAuth begins a sign-in from the phone: it settles who is
// asking, and hands back the nonce Apple's sheet must sign into its token.
//
// Who is asking is decided here rather than when the token comes back, for the
// reason Discord's start route gives: a device key is reduced to a user ID and
// never stored. The nonce is what the flow is found by afterwards, so it is the
// one secret both halves share, and it is used once.
func (server *Server) startAppleNativeAuth(writer http.ResponseWriter, request *http.Request) {
	if !server.apple.enabled {
		writeAPIError(writer, http.StatusServiceUnavailable,
			"Sign in with Apple is not configured on this server")
		return
	}
	var input appleNonceRequest
	if err := decodeAPIRequest(writer, request, &input); err != nil {
		writeAPIError(writer, http.StatusBadRequest, err.Error())
		return
	}
	if !server.allowOAuthStart(writer, request) {
		return
	}
	linkUserID, fromSession, ok := server.resolveLinkTarget(writer, request, input.UserID)
	if !ok {
		return
	}
	if server.refuseStoreReviewLink(
		writer, request, linkUserID, fromSession, persistence.ProviderApple,
	) {
		return
	}
	nonce, err := oauthSecret()
	if err != nil {
		writeAPIError(writer, http.StatusInternalServerError, "could not start sign-in")
		return
	}
	server.appleNonces.put(hashSecret(nonce), appleFlow{
		nonce:           nonce,
		linkUserID:      linkUserID,
		linkFromSession: fromSession,
	})
	writeJSON(writer, http.StatusOK, appleNonceReply{Nonce: nonce})
}

// finishAppleNativeAuth takes what Apple's sheet returned and answers the way
// redeeming a ticket does: signed in, linked, or asked for a name.
//
// The identity token is the proof. It has to be Apple's, for this app, current,
// and carry the nonce this flow issued; anything else is a 401 and nothing is
// kept. The authorization code beside it is only for the refresh token —
// see keepRefreshToken — and its failing never fails the sign-in.
func (server *Server) finishAppleNativeAuth(writer http.ResponseWriter, request *http.Request) {
	if !server.apple.enabled {
		writeAPIError(writer, http.StatusServiceUnavailable,
			"Sign in with Apple is not configured on this server")
		return
	}
	var input appleNativeRequest
	if err := decodeAPIRequest(writer, request, &input); err != nil {
		writeAPIError(writer, http.StatusBadRequest, err.Error())
		return
	}
	flow, ok := server.appleNonces.take(hashSecret(input.Nonce))
	if !ok {
		writeAPIError(writer, http.StatusUnauthorized, "that sign-in has expired; try again")
		return
	}
	claims, err := server.apple.verifyIdentityToken(
		request.Context(), input.IdentityToken, server.apple.bundleID,
	)
	if err == nil && !appleNonceMatches(claims.Nonce, flow.nonce) {
		err = errMismatchedAppleNonce
	}
	if err != nil {
		log.Printf("Sign in with Apple: %v", err)
		writeAPIError(writer, http.StatusUnauthorized, "Apple did not confirm that sign-in; try again")
		return
	}

	refreshToken, clientID := "", ""
	if code := strings.TrimSpace(input.AuthorizationCode); code != "" {
		refreshToken, clientID = server.apple.keepRefreshToken(
			request.Context(), claims.Subject, server.apple.bundleID, code, "",
		)
	}
	ticket, err := server.issueSignInTicket(signInTicket{
		identity:        persistence.AppleIdentity(claims.Subject, refreshToken, clientID),
		linkUserID:      flow.linkUserID,
		linkFromSession: flow.linkFromSession,
	})
	if err != nil {
		writeAPIError(writer, http.StatusInternalServerError, "could not finish sign-in")
		return
	}
	server.redeemSignInTicket(writer, request, ticket)
}

// startAppleWebAuth begins a sign-in from the website, the way Discord's does:
// JSON with the address to send the browser to, because a fetch that redirected
// to Apple would be stopped by CORS and a navigation could not carry the
// credential that says who is asking.
func (server *Server) startAppleWebAuth(writer http.ResponseWriter, request *http.Request) {
	if !server.apple.webEnabled {
		writeAPIError(writer, http.StatusServiceUnavailable,
			"Sign in with Apple is not configured for the website on this server")
		return
	}
	var input appleStartRequest
	if err := decodeAPIRequest(writer, request, &input); err != nil {
		writeAPIError(writer, http.StatusBadRequest, err.Error())
		return
	}
	if !server.allowOAuthStart(writer, request) {
		return
	}
	returnTo := strings.TrimSpace(input.ReturnTo)
	if !returnURLPermitted(server.apple.returnURLs, returnTo) {
		writeAPIError(writer, http.StatusBadRequest, "that return address is not allowed")
		return
	}
	linkUserID, fromSession, ok := server.resolveLinkTarget(writer, request, input.UserID)
	if !ok {
		return
	}
	if server.refuseStoreReviewLink(
		writer, request, linkUserID, fromSession, persistence.ProviderApple,
	) {
		return
	}
	state, err := oauthSecret()
	if err != nil {
		writeAPIError(writer, http.StatusInternalServerError, "could not start sign-in")
		return
	}
	nonce, err := oauthSecret()
	if err != nil {
		writeAPIError(writer, http.StatusInternalServerError, "could not start sign-in")
		return
	}
	server.appleFlows.put(state, appleFlow{
		nonce:           nonce,
		returnTo:        returnTo,
		linkUserID:      linkUserID,
		linkFromSession: fromSession,
	})

	// No scope at all: no name, no email. That is also what allows the answer
	// to come back as a plain GET — Apple insists on a form POST only when a
	// scope is asked for — though the callback accepts either.
	query := url.Values{}
	query.Set("client_id", server.apple.servicesID)
	query.Set("redirect_uri", server.apple.redirectURL)
	query.Set("response_type", "code")
	query.Set("response_mode", "query")
	query.Set("state", state)
	query.Set("nonce", nonce)
	writeJSON(writer, http.StatusOK, appleStartReply{
		AuthorizeURL: server.apple.authorizeURL + "?" + query.Encode(),
	})
}

// appleCallback is where Apple sends the browser back from its website.
//
// Every exit is a redirect, including every failure, for the reason Discord's
// callback gives. Both methods are accepted and read the same way: with no
// scope asked for, Apple's documentation says the answer may come as a query,
// and form_post is what it uses otherwise.
func (server *Server) appleCallback(writer http.ResponseWriter, request *http.Request) {
	if err := request.ParseForm(); err != nil {
		server.redirectWithSignInError(writer, request,
			firstReturnURL(server.apple.returnURLs), "invalid_request")
		return
	}
	flow, ok := server.appleFlows.take(strings.TrimSpace(request.Form.Get("state")))
	if !ok {
		server.redirectWithSignInError(writer, request,
			firstReturnURL(server.apple.returnURLs), "expired")
		return
	}
	if refusal := strings.TrimSpace(request.Form.Get("error")); refusal != "" {
		// Pressing Cancel arrives here as user_cancelled_authorize. It is an
		// ordinary outcome, not a fault.
		server.redirectWithSignInError(writer, request, flow.returnTo, refusal)
		return
	}
	code := strings.TrimSpace(request.Form.Get("code"))
	if code == "" {
		server.redirectWithSignInError(writer, request, flow.returnTo, "invalid_request")
		return
	}

	// On the website the redemption *is* the sign-in: the identity token comes
	// back from it, over a connection this server made to Apple, rather than
	// from the browser.
	reply, err := server.apple.redeemCode(
		request.Context(), server.apple.servicesID, code, server.apple.redirectURL,
	)
	if err != nil {
		log.Printf("Sign in with Apple on the website: %v", err)
		server.redirectWithSignInError(writer, request, flow.returnTo, "apple_unavailable")
		return
	}
	claims, err := server.apple.verifyIdentityToken(
		request.Context(), reply.IDToken, server.apple.servicesID,
	)
	if err == nil && !appleNonceMatches(claims.Nonce, flow.nonce) {
		err = errMismatchedAppleNonce
	}
	if err != nil {
		log.Printf("Sign in with Apple on the website: %v", err)
		server.redirectWithSignInError(writer, request, flow.returnTo, "apple_unavailable")
		return
	}

	clientID := ""
	if reply.RefreshToken != "" {
		clientID = server.apple.servicesID
	}
	ticket, err := server.issueSignInTicket(signInTicket{
		identity:        persistence.AppleIdentity(claims.Subject, reply.RefreshToken, clientID),
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
