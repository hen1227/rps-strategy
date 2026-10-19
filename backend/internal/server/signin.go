package server

import (
	"errors"
	"log"
	"net/http"
	"net/url"
	"strings"
	"time"

	"rps-strategy/backend/internal/persistence"
)

// Everything a sign-in does once a provider has said who somebody is.
//
// Discord and Apple reach that point differently — Discord through a redirect
// this server owns end to end, Apple through a sheet on the phone or a redirect
// on the website — and each of those lives in its own file. What they produce is
// the same: a provider, a subject, and the account the caller proved they hold,
// if any. From there one path serves both, and is the reason Google can be added
// as a third way to reach a ticket rather than as a second copy of this file.
//
// That path is a ticket, redeemed once. Redeeming it signs a returning player
// straight in, links the identity to an account that already has a name, or
// asks a new player to choose one. The naming step can answer a name that is
// already somebody's older account by asking for its password, which is how a
// legacy account holder pressing the front-door button finds their way back to
// the account they already have.

const (
	// signInTicketLifetime is the window between a provider vouching for
	// somebody and the app redeeming the ticket — one page load, or one reply.
	// Short on purpose: on the web the ticket is the one part of this that
	// travels in a URL. A naming step keeps it alive past this only by being
	// started within it; see redeemSignInTicket.
	signInTicketLifetime = 2 * time.Minute
	// signInNamingLifetime is how long a ticket waits once its naming step has
	// begun. By then it has been redeemed once, by the app that holds it, and
	// what it is waiting for is somebody thinking of a name.
	signInNamingLifetime = 10 * time.Minute
	// signInMaximumPending bounds every pending-sign-in map, so that an
	// unauthenticated caller hammering a start route cannot turn one into the
	// memory problem.
	signInMaximumPending = 1024

	// SignInTicketPrefix marks the one-shot code a finished sign-in hands back.
	// Prefixed for the same reason session and bot tokens are: several
	// different secrets arrive on this server, and telling them apart by shape
	// is how one gets accepted where another was meant.
	SignInTicketPrefix = "rps_t_"
)

// signInTicket is the one-shot result of a provider vouching for somebody,
// redeemed by the app for a session.
type signInTicket struct {
	identity persistence.Identity
	// suggestions are where a first sign-in's username suggestion comes from,
	// best first: Discord's display name, then its handle. Apple gives none,
	// and a filler name would only be something to delete.
	suggestions []string
	// linkUserID is the account this identity should attach to, when the
	// caller proved one when the sign-in started.
	linkUserID string
	// linkFromSession says linkUserID was proved by a session token rather than
	// by a device key, which is the difference between "attach this identity to
	// *this* account" and "upgrade this device's guest if that helps". The first
	// is a request that can be refused; the second is an optimisation. See
	// resolveLinkTarget.
	linkFromSession bool
}

// signInReply is what redeeming a ticket returns.
//
// Several shapes in one struct rather than several endpoints, because the app
// cannot know in advance which it will get: whether a username is needed, and
// whether the one offered turns out to name an account that already exists,
// depend on facts only the server has. NeedsUsername and NeedsPassword are the
// discriminators, and a session plus an account is the answer when neither is
// set.
type signInReply struct {
	Account *persistence.Account `json:"account,omitempty"`
	Token   string               `json:"token,omitempty"`
	// NeedsUsername says this is a first sign-in and the ticket is still live,
	// waiting for a name.
	NeedsUsername     bool   `json:"needsUsername,omitempty"`
	SuggestedUsername string `json:"suggestedUsername,omitempty"`
	DiscordHandle     string `json:"discordHandle,omitempty"`
	// Provider is who vouched: on a NeedsUsername reply so the naming step can
	// say so, and on a finished sign-in for the app's analytics, since a
	// returning web sign-in reaches the app as a bare ticket. A build that
	// predates it reads Discord.
	Provider string `json:"provider,omitempty"`
	// Ticket is the ticket the naming step finishes, on a NeedsUsername reply.
	// The web app already has it, from its own address bar; Apple's phone
	// sign-in never sees one otherwise, because the ticket is issued and
	// redeemed inside the one call.
	Ticket string `json:"ticket,omitempty"`
	// NeedsPassword says the name just offered already belongs to an account
	// that predates Discord and Apple sign-in. It is not a refusal: if the
	// account is theirs, its password links it and they sign in as it, keeping
	// the name and everything attached to it. The ticket stays live for that.
	NeedsPassword bool `json:"needsPassword,omitempty"`
}

type signInTicketRequest struct {
	Ticket string `json:"ticket"`
}

type signInCompleteRequest struct {
	Ticket   string `json:"ticket"`
	Username string `json:"username"`
	// Password claims an account that already holds this username, rather than
	// creating one. Empty for an ordinary signup, which is the common case; see
	// completeSignIn for why both live on one route.
	Password string `json:"password"`
	// ReservationToken carries the host secret for a reserved name, pasted into
	// the form rather than sent as a header — there is no session yet at this
	// point, so the Authorization slot has nothing to carry it in.
	ReservationToken string `json:"reservationToken"`
}

// signInProviders is what a client asks before offering a button: which ways
// in this server can actually complete.
//
// Discord is listed for completeness and the app does not hide its button by
// it, since a server without Discord says so plainly when the button is
// pressed. Apple is different: a button that is Apple's own on the phone, and
// the size of the front door on the website, is not one to show and then fail.
type signInProvidersReply struct {
	Discord bool `json:"discord"`
	// Apple is the phone's sheet. AppleWeb is the website's redirect, which
	// needs a Services ID on top of the key.
	Apple    bool `json:"apple"`
	AppleWeb bool `json:"appleWeb"`
}

func (server *Server) signInProviders(writer http.ResponseWriter, _ *http.Request) {
	writeJSON(writer, http.StatusOK, signInProvidersReply{
		Discord:  server.discord.enabled,
		Apple:    server.apple.enabled,
		AppleWeb: server.apple.webEnabled,
	})
}

// resolveLinkTarget works out which account, if any, a sign-in should attach
// to, and by what proof. Returning ("", false, true) means "nobody proved
// anything", which is a legitimate way to sign in — it just creates a new
// account rather than upgrading one.
//
// The middle result is the one to read carefully. A session says the player is
// already in an account and is asking for the identity to be attached to *that*
// one; a device key says only that this device owns an anonymous account which
// may as well be upgraded. The two want opposite things when the identity turns
// out to belong to somebody else — the first must be refused, the second may be
// ignored — so which proof arrived has to survive the trip to redemption.
//
// A device key proves a guest, and only a guest — or a legacy password account
// awaiting its link, which is the migration path the key has always served.
// Signing in upgrades a guest in place and the account keeps the device's key,
// so a key can name an account that already signs in with Discord or Apple. On
// a shared iPad that account belongs to whoever signed in before; a second
// person's Apple ID attaching to it would be the worst possible answer. So such
// a key is ignored, and the sign-in carries on as one with no proof at all.
//
// A credential that is present but wrong is a 401 rather than a silent fall
// through to "create a new account". Quietly handing somebody a second account
// because their key did not match is how a player loses their history without
// ever being told anything went wrong.
func (server *Server) resolveLinkTarget(
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
	upgraded, err := server.data.AccountHoldsIdentity(request.Context(), userID)
	if err != nil {
		writeAPIError(writer, http.StatusInternalServerError, "could not start sign-in")
		return "", false, false
	}
	if upgraded {
		return "", false, true
	}
	return userID, false, true
}

// refuseStoreReviewLink answers a start route asked, from a session, to link
// an identity to a store review account. Refused here as well as at the link
// itself, so that a reviewer pressing the button is told no at once instead of
// being sent through a provider to hear it. See persistence/store_review.go.
func (server *Server) refuseStoreReviewLink(
	writer http.ResponseWriter,
	request *http.Request,
	linkUserID string,
	fromSession bool,
	provider string,
) bool {
	if !fromSession {
		return false
	}
	review, err := server.data.IsStoreReviewAccount(request.Context(), linkUserID)
	if err != nil {
		writeAPIError(writer, http.StatusInternalServerError, "could not start sign-in")
		return true
	}
	if !review {
		return false
	}
	writeAuthError(writer, persistence.StoreReviewLinkRefusal(provider))
	return true
}

// issueSignInTicket mints a ticket for an identity a provider has just
// vouched for, and remembers it for one redemption.
func (server *Server) issueSignInTicket(pending signInTicket) (string, error) {
	secret, err := oauthSecret()
	if err != nil {
		return "", err
	}
	ticket := SignInTicketPrefix + secret
	server.signInTickets.put(hashSecret(ticket), pending)
	return ticket, nil
}

// exchangeSignInTicket turns a one-shot ticket into a session, or reports that
// this is a first sign-in and a username is still needed.
func (server *Server) exchangeSignInTicket(writer http.ResponseWriter, request *http.Request) {
	var input signInTicketRequest
	if err := decodeAPIRequest(writer, request, &input); err != nil {
		writeAPIError(writer, http.StatusBadRequest, err.Error())
		return
	}
	server.redeemSignInTicket(writer, request, input.Ticket)
}

// redeemSignInTicket is the exchange itself, shared by the route above and by
// Apple's phone sign-in, which issues its ticket and redeems it in one call.
func (server *Server) redeemSignInTicket(
	writer http.ResponseWriter,
	request *http.Request,
	ticket string,
) {
	key := hashSecret(ticket)
	pending, ok := server.signInTickets.peek(key)
	if !ok {
		writeAPIError(writer, http.StatusUnauthorized, "that sign-in has expired; try again")
		return
	}
	identity := pending.identity

	existing, err := server.data.AccountForIdentity(
		request.Context(), identity.Provider, identity.Subject,
	)
	switch {
	case err == nil:
		// A link asked for from a session is a request about one *named*
		// account, so an identity that belongs to a different one is a conflict
		// and has to be said out loud. Answering it the way a sign-in is
		// answered would quietly move the player to the other account — they
		// press "add Apple" on the account holding their rating and their
		// games, and land in somebody else's, with their own still unlinked and
		// nothing on screen saying so.
		if pending.linkFromSession && existing.UserID != pending.linkUserID {
			writeAPIError(writer, http.StatusConflict, linkedElsewhereGuidance(identity.Provider))
			return
		}
		// A returning player. Their account is whichever one holds the
		// identity, regardless of what this device happens to be signed in as
		// — which is right here, where nothing but a device key was offered.
		server.signInTickets.take(key)
		if err := server.data.RecordIdentityToken(request.Context(), identity); err != nil {
			// Worth a line and not a refusal: the token is for deletion, and
			// this player is not deleting anything.
			log.Printf("sign-in: could not keep the %s token: %v", identity.Provider, err)
		}
		existing = server.absorbGuestHistory(request, existing, pending.linkUserID)
		server.finishSignIn(writer, request, existing, identity.Provider)
		return
	case errors.Is(err, persistence.ErrAccountNotFound):
		// First time with this identity.
	default:
		writePersistenceError(writer, err)
		return
	}

	// An account that already has a name is a link, not a signup: it keeps its
	// username. That is a signed-in player adding a second way in, or a legacy
	// account trading its password for the identity.
	if pending.linkUserID != "" {
		account, err := server.data.Account(request.Context(), pending.linkUserID)
		if err != nil {
			writePersistenceError(writer, err)
			return
		}
		if account.Registered {
			linked, err := server.data.LinkIdentity(request.Context(), pending.linkUserID, identity)
			if err != nil {
				writeAuthError(writer, err)
				return
			}
			server.signInTickets.take(key)
			server.finishSignIn(writer, request, linked, identity.Provider)
			return
		}
	}

	// Everybody else needs a name before an account exists. The ticket stays
	// live for the second call: nothing is written to `accounts` until a
	// username is agreed, so an abandoned signup leaves no half-built account
	// and no squatted name.
	reply := signInReply{
		NeedsUsername: true,
		Provider:      identity.Provider,
		Ticket:        ticket,
	}
	if len(pending.suggestions) > 0 {
		suggestion, err := server.data.SuggestAvailableUsername(
			request.Context(), pending.suggestions...,
		)
		if err != nil {
			writePersistenceError(writer, err)
			return
		}
		reply.SuggestedUsername = suggestion
	}
	if identity.Provider == persistence.ProviderDiscord {
		reply.DiscordHandle = identity.Handle
	}
	// Starting the naming step buys it the time it needs. A ticket lives two
	// minutes so that it is worthless in a URL bar soon after; a person
	// choosing a name — from nothing, after Apple, which suggests none — and
	// perhaps typing an old password, can take longer.
	server.signInTickets.putFor(key, pending, signInNamingLifetime)
	writeJSON(writer, http.StatusOK, reply)
}

// linkSignInTicket attaches a ticket's identity to the signed-in account.
//
// It is for the player who pressed the provider they don't usually use. Their
// Apple ID is new here, so the naming step opens, but they already play under
// Discord. Without this, the way out was to back out of the step, sign in with
// Discord, find the Account screen and press Apple again. With it, the app keeps
// the Apple ticket, signs in with Discord, and then hands the ticket back here
// with the new session, so one press on the naming step does the whole thing.
//
// Two proofs, the same two a link from a session has always needed: the
// session says which account, and the ticket says the identity has just been
// vouched for by its provider. The ticket is a secret only the app that
// started this sign-in holds, and it is spent here, so it cannot be reused.
func (server *Server) linkSignInTicket(writer http.ResponseWriter, request *http.Request) {
	account, ok := server.requireSession(writer, request)
	if !ok {
		return
	}
	var input signInTicketRequest
	if err := decodeAPIRequest(writer, request, &input); err != nil {
		writeAPIError(writer, http.StatusBadRequest, err.Error())
		return
	}
	key := hashSecret(input.Ticket)
	pending, ok := server.signInTickets.peek(key)
	if !ok {
		writeAPIError(writer, http.StatusUnauthorized, "that sign-in has expired; try again")
		return
	}
	identity := pending.identity

	// An identity that already opens some other account says so the way a link
	// from a session does, with the way out, rather than as a bare conflict.
	holder, err := server.data.AccountForIdentity(
		request.Context(), identity.Provider, identity.Subject,
	)
	switch {
	case err == nil && holder.UserID != account.UserID:
		writeAPIError(writer, http.StatusConflict, linkedElsewhereGuidance(identity.Provider))
		return
	case err != nil && !errors.Is(err, persistence.ErrAccountNotFound):
		writePersistenceError(writer, err)
		return
	}

	linked, err := server.data.LinkIdentity(request.Context(), account.UserID, identity)
	if err != nil {
		writeAuthError(writer, err)
		return
	}
	server.signInTickets.take(key)
	linked = server.titledAccount(request.Context(), linked)
	writeJSON(writer, http.StatusOK, signInReply{Account: &linked, Provider: identity.Provider})
}

// linkedElsewhereGuidance is the refusal a session link gets when the identity
// is already somebody's account, with the way out: that account is the one the
// identity opens, so signing in with it reaches it.
func linkedElsewhereGuidance(provider string) string {
	switch provider {
	case persistence.ProviderApple:
		return "that Apple ID is already linked to another account; sign in with Apple to use it"
	case persistence.ProviderDiscord:
		return "that Discord account is already linked to another account; " +
			"sign in with Discord to use it"
	default:
		return persistence.ErrIdentityAlreadyLinked.Error()
	}
}

// completeSignIn finishes the naming step: it claims the chosen username for a
// new account, or links the identity to an account that already holds it.
//
// Both on one route because from the player's side they are one step — they are
// typing the name they want to be, and whether that name is new is a fact about
// the database, not about their intent. The password, when there is one, is what
// turns the second reading into a proof.
func (server *Server) completeSignIn(writer http.ResponseWriter, request *http.Request) {
	var input signInCompleteRequest
	if err := decodeAPIRequest(writer, request, &input); err != nil {
		writeAPIError(writer, http.StatusBadRequest, err.Error())
		return
	}
	if !server.allowAuthAttempt(writer, request, input.Username) {
		return
	}
	key := hashSecret(input.Ticket)
	pending, ok := server.signInTickets.peek(key)
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
		account, err := server.data.LinkIdentityWithPassword(
			request.Context(), input.Username, input.Password, pending.identity,
		)
		if err != nil {
			writeAuthError(writer, err)
			return
		}
		server.signInTickets.take(key)
		server.finishSignIn(writer, request, account, pending.identity.Provider)
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

	account, err := server.data.ClaimAccountWithIdentity(
		request.Context(), pending.linkUserID, input.Username, pending.identity,
	)
	if err != nil {
		// The ticket survives a refused name so the player can pick another
		// one without going back through the provider.
		if errors.Is(err, persistence.ErrUsernameTaken) {
			server.offerPasswordLink(writer, request, input.Username)
			return
		}
		writeAuthError(writer, err)
		return
	}
	server.signInTickets.take(key)
	server.finishSignIn(writer, request, account, pending.identity.Provider)
}

// offerPasswordLink answers a name collision with the question worth asking
// instead of the refusal.
//
// A name that is taken is very often the player's own, from before Discord was
// an option: they are typing what they have always been called. "That username
// is already taken" is true and useless to them — it reads as somebody else
// having their name, and the only door left is a password form folded away on
// a different panel. So when the name belongs to an account a password would
// link, ask for the password.
func (server *Server) offerPasswordLink(
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
		// Held by somebody who signs in with Discord or Apple already, so there
		// is no password to offer and it really is just taken.
		writeAuthError(writer, persistence.ErrUsernameTaken)
		return
	}
	// The flag alone. Which name is being asked about is the name the caller
	// just sent, and echoing it back would only invite the app to read it from
	// here instead of from what it asked.
	writeJSON(writer, http.StatusOK, signInReply{NeedsPassword: true})
}

// absorbGuestHistory folds this device's guest account into the one being
// signed into, in the single case where that is unambiguous: the account being
// signed into has never played, and the guest has.
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
		log.Printf("sign-in: could not merge guest history: %v", err)
		return account
	}
	merged, err := server.data.Account(request.Context(), account.UserID)
	if err != nil {
		return account
	}
	return merged
}

func (server *Server) finishSignIn(
	writer http.ResponseWriter,
	request *http.Request,
	account persistence.Account,
	provider string,
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
	writeJSON(writer, http.StatusOK, signInReply{Account: &account, Token: token, Provider: provider})
}

// redirectWithSignInError sends a browser back from a provider's callback with
// the reason it did not work. Every exit from a callback is a redirect,
// including every failure: it is a page load in somebody's browser, not an API
// call, so answering with JSON would leave them staring at a payload.
func (server *Server) redirectWithSignInError(
	writer http.ResponseWriter,
	request *http.Request,
	returnTo string,
	reason string,
) {
	http.Redirect(writer, request,
		returnWithParameters(returnTo, url.Values{"error": {reason}}),
		http.StatusSeeOther)
}
