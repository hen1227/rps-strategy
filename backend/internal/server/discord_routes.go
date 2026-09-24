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

// discordExchangeReply is what redeeming a ticket returns.
//
// Several shapes in one struct rather than several endpoints, because the app
// cannot know in advance which it will get: whether a username is needed, and
// whether the one offered turns out to name an account that already exists,
// depend on facts only the server has. NeedsUsername and NeedsPassword are the
// discriminators, and a session plus an account is the answer when neither is
// set.
type discordExchangeReply struct {
	Account *persistence.Account `json:"account,omitempty"`
	Token   string               `json:"token,omitempty"`
	// NeedsUsername says this is a first sign-in and the ticket is still live,
	// waiting for a name.
	NeedsUsername     bool   `json:"needsUsername,omitempty"`
	SuggestedUsername string `json:"suggestedUsername,omitempty"`
	DiscordHandle     string `json:"discordHandle,omitempty"`
	// NeedsPassword says the name just offered already belongs to an account
	// that predates Discord sign-in. It is not a refusal: if the account is
	// theirs, its password links it and they sign in as it, keeping the name and
	// everything attached to it. The ticket stays live for that.
	NeedsPassword bool `json:"needsPassword,omitempty"`
}

type discordCompleteRequest struct {
	Ticket   string `json:"ticket"`
	Username string `json:"username"`
	// Password claims an account that already holds this username, rather than
	// creating one. Empty for an ordinary signup, which is the common case; see
	// completeDiscordSignup for why both live on one route.
	Password string `json:"password"`
	// ReservationToken carries the host secret for a reserved name, pasted into
	// the form rather than sent as a header — there is no session yet at this
	// point, so the Authorization slot has nothing to carry it in.
	ReservationToken string `json:"reservationToken"`
}

type discordTicketRequest struct {
	Ticket string `json:"ticket"`
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
	linkUserID, fromSession, ok := server.resolveDiscordLinkTarget(writer, request, input.UserID)
	if !ok {
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

// resolveDiscordLinkTarget works out which account, if any, this sign-in should
// attach to, and by what proof. Returning ("", false, true) means "nobody proved
// anything", which is a legitimate way to sign in — it just creates a new
// account rather than upgrading one.
//
// The middle result is the one to read carefully. A session says the player is
// already in an account and is asking for the identity to be attached to *that*
// one; a device key says only that this browser owns an anonymous account which
// may as well be upgraded. The two want opposite things when the identity turns
// out to belong to somebody else — the first must be refused, the second may be
// ignored — so which proof arrived has to survive the trip to redemption.
//
// A credential that is present but wrong is a 401 rather than a silent fall
// through to "create a new account". Quietly handing somebody a second account
// because their key did not match is how a player loses their history without
// ever being told anything went wrong.
func (server *Server) resolveDiscordLinkTarget(
	writer http.ResponseWriter,
	request *http.Request,
	userID string,
) (string, bool, bool) {
	if token := sessionToken(request); token != "" {
		account, err := server.data.SessionAccount(request.Context(), token)
		if err != nil {
			writer.Header().Set("WWW-Authenticate", `Bearer realm="account"`)
			writeAPIError(writer, http.StatusUnauthorized, "your session has expired")
			return "", false, false
		}
		return account.UserID, true, true
	}
	key := profileKey(request)
	userID = strings.TrimSpace(userID)
	if key == "" || userID == "" {
		return "", false, true
	}
	if err := server.data.VerifyProfileKey(request.Context(), userID, key); err != nil {
		writer.Header().Set("WWW-Authenticate", `Bearer realm="account-profile"`)
		writeAPIError(writer, http.StatusUnauthorized, "that account key is not valid")
		return "", false, false
	}
	return userID, false, true
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
		server.redirectWithDiscordError(writer, request,
			server.discord.defaultReturnURL(), "expired")
		return
	}
	if refusal := strings.TrimSpace(query.Get("error")); refusal != "" {
		// Pressing Cancel arrives here. It is an ordinary outcome, not a fault.
		server.redirectWithDiscordError(writer, request, flow.returnTo, refusal)
		return
	}
	code := strings.TrimSpace(query.Get("code"))
	if code == "" {
		server.redirectWithDiscordError(writer, request, flow.returnTo, "invalid_request")
		return
	}

	identity, err := server.discord.identify(request.Context(), code, flow.verifier)
	if err != nil {
		log.Printf("discord sign-in: %v", err)
		server.redirectWithDiscordError(writer, request, flow.returnTo, "discord_unavailable")
		return
	}

	ticket, err := oauthSecret()
	if err != nil {
		server.redirectWithDiscordError(writer, request, flow.returnTo, "server_error")
		return
	}
	ticket = DiscordTicketPrefix + ticket
	server.discordTickets.put(hashDiscordTicket(ticket), discordTicket{
		discordUserID:   identity.ID,
		discordUsername: identity.Username,
		globalName:      identity.GlobalName,
		linkUserID:      flow.linkUserID,
		linkFromSession: flow.linkFromSession,
	})
	http.Redirect(writer, request,
		returnWithParameters(flow.returnTo, url.Values{"ticket": {ticket}}),
		http.StatusSeeOther)
}

func (server *Server) redirectWithDiscordError(
	writer http.ResponseWriter,
	request *http.Request,
	returnTo string,
	reason string,
) {
	http.Redirect(writer, request,
		returnWithParameters(returnTo, url.Values{"error": {reason}}),
		http.StatusSeeOther)
}

// exchangeDiscordTicket turns the one-shot ticket into a session, or reports
// that this is a first sign-in and a username is still needed.
func (server *Server) exchangeDiscordTicket(writer http.ResponseWriter, request *http.Request) {
	var input discordTicketRequest
	if err := decodeAPIRequest(writer, request, &input); err != nil {
		writeAPIError(writer, http.StatusBadRequest, err.Error())
		return
	}
	key := hashDiscordTicket(input.Ticket)
	pending, ok := server.discordTickets.peek(key)
	if !ok {
		writeAPIError(writer, http.StatusUnauthorized, "that sign-in has expired; try again")
		return
	}

	existing, err := server.data.AccountForDiscordIdentity(request.Context(), pending.discordUserID)
	switch {
	case err == nil:
		// A link asked for from a session is a request about one *named*
		// account, so an identity that belongs to a different one is a conflict
		// and has to be said out loud. Answering it the way a sign-in is
		// answered would quietly move the player to the other account — they
		// press "link Discord" on the account holding their rating and their
		// games, and land in somebody else's, with their own still unlinked and
		// nothing on screen saying so.
		if pending.linkFromSession && existing.UserID != pending.linkUserID {
			writeAuthError(writer, persistence.ErrIdentityAlreadyLinked)
			return
		}
		// A returning player. Their account is whichever one holds the
		// identity, regardless of what this browser happens to be signed in as
		// — which is right here, where nothing but a device key was offered.
		server.discordTickets.take(key)
		existing = server.absorbGuestHistory(request, existing, pending.linkUserID)
		server.finishDiscordSignIn(writer, request, existing, pending)
		return
	case errors.Is(err, persistence.ErrAccountNotFound):
		// First time with this Discord account.
	default:
		writePersistenceError(writer, err)
		return
	}

	// A legacy account that already has a name is a link, not a signup: it
	// keeps its username and trades its password for the identity.
	if pending.linkUserID != "" {
		account, err := server.data.Account(request.Context(), pending.linkUserID)
		if err != nil {
			writePersistenceError(writer, err)
			return
		}
		if account.Registered {
			linked, err := server.data.LinkDiscordIdentity(
				request.Context(), pending.linkUserID,
				pending.discordUserID, pending.discordUsername,
			)
			if err != nil {
				writeAuthError(writer, err)
				return
			}
			server.discordTickets.take(key)
			server.finishDiscordSignIn(writer, request, linked, pending)
			return
		}
	}

	// Everybody else needs a name before an account exists. The ticket stays
	// live for the second call: nothing is written to `accounts` until a
	// username is agreed, so an abandoned signup leaves no half-built account
	// and no squatted name.
	suggestion, err := server.data.SuggestAvailableUsername(
		request.Context(), pending.globalName, pending.discordUsername,
	)
	if err != nil {
		writePersistenceError(writer, err)
		return
	}
	writeJSON(writer, http.StatusOK, discordExchangeReply{
		NeedsUsername:     true,
		SuggestedUsername: suggestion,
		DiscordHandle:     pending.discordUsername,
	})
}

// completeDiscordSignup finishes the naming step: it claims the chosen username
// for a new account, or links the identity to an account that already holds it.
//
// Both on one route because from the player's side they are one step — they are
// typing the name they want to be, and whether that name is new is a fact about
// the database, not about their intent. The password, when there is one, is what
// turns the second reading into a proof.
func (server *Server) completeDiscordSignup(writer http.ResponseWriter, request *http.Request) {
	var input discordCompleteRequest
	if err := decodeAPIRequest(writer, request, &input); err != nil {
		writeAPIError(writer, http.StatusBadRequest, err.Error())
		return
	}
	if !server.allowAuthAttempt(writer, request, input.Username) {
		return
	}
	key := hashDiscordTicket(input.Ticket)
	pending, ok := server.discordTickets.peek(key)
	if !ok {
		writeAPIError(writer, http.StatusUnauthorized, "that sign-in has expired; try again")
		return
	}

	// A password says this name is an account they already have rather than one
	// they are making, so it is answered first and on its own: claiming would
	// refuse the name anyway, and with the wrong error.
	//
	// It runs before the reserved-name gate below, which has nothing to guard
	// here. That gate protects *granting* a held name to somebody new; this
	// grants nothing — the account already exists and already has the name, and
	// its password is a better proof of holding it than the host token is.
	if strings.TrimSpace(input.Password) != "" {
		account, err := server.data.LinkDiscordIdentityWithPassword(
			request.Context(), input.Username, input.Password,
			pending.discordUserID, pending.discordUsername,
		)
		if err != nil {
			writeAuthError(writer, err)
			return
		}
		server.discordTickets.take(key)
		server.finishDiscordSignIn(writer, request, account, pending)
		return
	}

	// The same gate registration had. Holding the owner handle *is* the admin
	// check, so the door that grants it has to keep asking for the host token.
	if persistence.IsReservedUsername(input.Username) &&
		!server.requestIsAdmin(request) &&
		!server.hasValidAdminTokenValue(input.ReservationToken) {
		writeAPIError(writer, http.StatusForbidden, "that username is reserved")
		return
	}

	account, err := server.data.ClaimAccountWithDiscord(
		request.Context(), pending.linkUserID, input.Username,
		pending.discordUserID, pending.discordUsername,
	)
	if err != nil {
		// The ticket survives a refused name so the player can pick another
		// one without going back through Discord.
		if errors.Is(err, persistence.ErrUsernameTaken) {
			server.offerDiscordPasswordLink(writer, request, input.Username)
			return
		}
		writeAuthError(writer, err)
		return
	}
	server.discordTickets.take(key)
	server.finishDiscordSignIn(writer, request, account, pending)
}

// offerDiscordPasswordLink answers a name collision with the question worth
// asking instead of the refusal.
//
// A name that is taken is very often the player's own, from before Discord was
// an option: they are typing what they have always been called. "That username
// is already taken" is true and useless to them — it reads as somebody else
// having their name, and the only door left is a password form folded away on
// a different panel. So when the name belongs to an account a password would
// link, ask for the password.
func (server *Server) offerDiscordPasswordLink(
	writer http.ResponseWriter,
	request *http.Request,
	username string,
) {
	linkable, err := server.data.UsernameCanLinkWithPassword(request.Context(), username)
	if err != nil {
		writePersistenceError(writer, err)
		return
	}
	if !linkable {
		// Held by somebody who signs in with Discord already, so there is no
		// password to offer and it really is just taken.
		writeAuthError(writer, persistence.ErrUsernameTaken)
		return
	}
	// The flag alone. Which name is being asked about is the name the caller
	// just sent, and echoing it back would only invite the app to read it from
	// here instead of from what it asked.
	writeJSON(writer, http.StatusOK, discordExchangeReply{NeedsPassword: true})
}

// absorbGuestHistory folds this browser's guest account into the one being
// signed into, in the single case where that is unambiguous: the Discord
// account has never played, and the guest has.
//
// Any other combination is left alone. Two accounts that have both played is a
// genuine merge — two Elos, two records, possibly games against each other —
// and guessing at it would silently rewrite somebody's ladder position.
//
// A failure here is logged and swallowed. The merge is a convenience; being
// unable to sign in is not, and refusing the session because the tidying-up
// went wrong would be the worse failure by far.
func (server *Server) absorbGuestHistory(
	request *http.Request,
	account persistence.Account,
	guestUserID string,
) persistence.Account {
	guestUserID = strings.TrimSpace(guestUserID)
	if guestUserID == "" || guestUserID == account.UserID || account.GamesPlayed > 0 {
		return account
	}
	guest, err := server.data.Account(request.Context(), guestUserID)
	if err != nil || guest.GamesPlayed == 0 || guest.Registered {
		return account
	}
	if _, err := server.data.MergeAccountHistory(
		request.Context(), guestUserID, account.UserID,
	); err != nil {
		log.Printf("discord sign-in: could not merge guest history: %v", err)
		return account
	}
	merged, err := server.data.Account(request.Context(), account.UserID)
	if err != nil {
		return account
	}
	return merged
}

func (server *Server) finishDiscordSignIn(
	writer http.ResponseWriter,
	request *http.Request,
	account persistence.Account,
	_ discordTicket,
) {
	token, err := server.data.CreateSession(request.Context(), account.UserID)
	if err != nil {
		writeAPIError(writer, http.StatusInternalServerError, "could not start a session")
		return
	}
	// The link that has just been written is itself worth a title, so the
	// rulebook runs before the account is handed back rather than at the next
	// connection: this reply is what the account page renders from, and a tag
	// that appears on the following reload reads as something that went wrong.
	account = server.titledAccount(request.Context(), account)
	writeJSON(writer, http.StatusOK, discordExchangeReply{Account: &account, Token: token})
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
