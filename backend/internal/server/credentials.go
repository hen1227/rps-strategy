package server

import (
	"errors"
	"net/http"
	"strings"

	"rps-strategy/backend/internal/persistence"
)

// Three different secrets arrive in `Authorization: Bearer`, and a fourth
// would have made four. Rather than guessing which is which by shape, tokens
// this system issues carry a prefix that says what they are:
//
//	rps_s_...  a login session
//	rps_b_...  a bot's durable token
//	anything   a browser profile key, or the shared admin token
//
// The legacy forms keep working untouched, so no existing client breaks. The
// prefixes also make a leaked token greppable in a log and recognisable to
// secret scanners.

const sessionPrefix = persistence.SessionTokenPrefix

// sessionToken returns the credential only if it is a session token, so a
// profile key can never be accepted where a login was required.
func sessionToken(request *http.Request) string {
	token := bearerToken(request)
	if !strings.HasPrefix(token, sessionPrefix) {
		return ""
	}
	return token
}

// profileKey returns the credential only if it is *not* one of the prefixed
// tokens, which is the mirror image of the rule above.
func profileKey(request *http.Request) string {
	token := bearerToken(request)
	if strings.HasPrefix(token, sessionPrefix) ||
		strings.HasPrefix(token, persistence.BotTokenPrefix) {
		return ""
	}
	return token
}

// requireSession resolves a logged-in account, writing the error response
// itself and returning false when there is none.
func (server *Server) requireSession(
	writer http.ResponseWriter,
	request *http.Request,
) (persistence.Account, bool) {
	token := sessionToken(request)
	if token == "" {
		writer.Header().Set("WWW-Authenticate", `Bearer realm="account"`)
		writeAPIError(writer, http.StatusUnauthorized, "sign in to do that")
		return persistence.Account{}, false
	}
	account, err := server.data.SessionAccount(request.Context(), token)
	if err != nil {
		switch {
		case errors.Is(err, persistence.ErrAccountDisabled):
			writeAPIError(writer, http.StatusForbidden, "this account is disabled")
		default:
			writer.Header().Set("WWW-Authenticate", `Bearer realm="account"`)
			writeAPIError(writer, http.StatusUnauthorized, "your session has expired")
		}
		return persistence.Account{}, false
	}
	return account, true
}

// requestIsAdmin accepts either the shared host token or a signed-in
// administrator.
//
// Both, rather than one: the account flag makes an action attributable to a
// person, and the shared token stays as the way in when the database has no
// administrator yet or the only one has lost their password.
func (server *Server) requestIsAdmin(request *http.Request) bool {
	if server.hasValidAdminToken(request) {
		return true
	}
	token := sessionToken(request)
	if token == "" {
		return false
	}
	account, err := server.data.SessionAccount(request.Context(), token)
	return err == nil && account.IsAdmin && !account.Disabled
}

// requireRegistered is requireSession plus the one thing publishing does not ask
// for.
//
// Publishing a mode is deliberately open to a guest — the Lab is meant to be a
// click away from a first visit, and a rule document is checked against a format
// before anybody sees it. A picture is not: it is the one thing the Lab produces
// that this server hosts and serves, unexamined, to every player of a mode. So
// there has to be somebody behind it, and `Registered` is what says there is.
//
// A session alone is not enough. A guest browser can hold one, and `Registered`
// is derived in `accountSelect` rather than stored — see the rule that
// `registered_rule_test.go` enforces — so this reads the field and does not
// invent a second opinion about what registered means.
func (server *Server) requireRegistered(
	writer http.ResponseWriter,
	request *http.Request,
) (persistence.Account, bool) {
	account, ok := server.requireSession(writer, request)
	if !ok {
		return persistence.Account{}, false
	}
	if !account.Registered {
		writeAPIError(writer, http.StatusForbidden, "sign in with an account to add pictures")
		return persistence.Account{}, false
	}
	return account, true
}

// requireAnyIdentity resolves whoever is asking, signed in or not, the same way
// authenticateBrowser resolves a socket: a session token wins, and a local
// profile key stands for the anonymous account this browser already owns.
//
// Every other route in this file picks one or the other, and rightly so —
// editing a profile needs a login, and storing a review needs only the key that
// played the game. Push belongs to neither camp. A notification is addressed to
// a *browser*, and the browser most in need of one belongs to a Guest who has
// never registered: they are the player who would otherwise have to sit and
// watch a spinner. Refusing them would leave the away queue available only to
// the people least likely to need it.
func (server *Server) requireAnyIdentity(
	writer http.ResponseWriter,
	request *http.Request,
) (persistence.Account, bool) {
	if token := sessionToken(request); token != "" {
		account, err := server.data.SessionAccount(request.Context(), token)
		if err != nil {
			writer.Header().Set("WWW-Authenticate", `Bearer realm="account"`)
			writeAPIError(writer, http.StatusUnauthorized, "your session has expired")
			return persistence.Account{}, false
		}
		return account, true
	}

	key := profileKey(request)
	userID := strings.TrimSpace(request.URL.Query().Get("userId"))
	if key == "" || userID == "" {
		writer.Header().Set("WWW-Authenticate", `Bearer realm="account-profile"`)
		writeAPIError(writer, http.StatusUnauthorized, "sign in, or send this browser's account key")
		return persistence.Account{}, false
	}
	if err := server.data.VerifyProfileKey(request.Context(), userID, key); err != nil {
		writer.Header().Set("WWW-Authenticate", `Bearer realm="account-profile"`)
		writeAPIError(writer, http.StatusUnauthorized, "that account key is not valid")
		return persistence.Account{}, false
	}
	account, err := server.data.Account(request.Context(), userID)
	if err != nil {
		writePersistenceError(writer, err)
		return persistence.Account{}, false
	}
	return account, true
}

// optionalSession returns the signed-in account when there is one, and reports
// nothing at all when there is not.
//
// For the routes anybody may use but a signed-in visitor should get credit
// for. It writes no error and sets no header: a caller with no token is not
// making a mistake, and an expired one is treated as absent rather than as a
// reason to refuse the request.
func (server *Server) optionalSession(request *http.Request) (persistence.Account, bool) {
	token := sessionToken(request)
	if token == "" {
		return persistence.Account{}, false
	}
	account, err := server.data.SessionAccount(request.Context(), token)
	if err != nil {
		return persistence.Account{}, false
	}
	return account, true
}
