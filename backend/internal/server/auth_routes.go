package server

import (
	"errors"
	"net/http"
	"strings"

	"rps-strategy/backend/internal/persistence"
)

type loginRequest struct {
	Username string `json:"username"`
	Password string `json:"password"`
}

// authResponse is what every successful auth call returns: the account, plus a
// session token on the calls that create one.
type authResponse struct {
	Account persistence.Account `json:"account"`
	Token   string              `json:"token,omitempty"`
}

func (server *Server) loginAccount(writer http.ResponseWriter, request *http.Request) {
	var input loginRequest
	if err := decodeAPIRequest(writer, request, &input); err != nil {
		writeAPIError(writer, http.StatusBadRequest, err.Error())
		return
	}
	if !server.allowAuthAttempt(writer, request, input.Username) {
		return
	}
	account, err := server.data.AuthenticateAccount(request.Context(), input.Username, input.Password)
	if err != nil {
		writeAuthError(writer, err)
		return
	}
	token, err := server.data.CreateSession(request.Context(), account.UserID)
	if err != nil {
		writeAPIError(writer, http.StatusInternalServerError, "could not start a session")
		return
	}
	writeJSON(writer, http.StatusOK, authResponse{Account: account, Token: token})
}

func (server *Server) logoutAccount(writer http.ResponseWriter, request *http.Request) {
	if token := sessionToken(request); token != "" {
		if err := server.data.RevokeSession(request.Context(), token); err != nil {
			writeAPIError(writer, http.StatusInternalServerError, "could not sign out")
			return
		}
	}
	writeJSON(writer, http.StatusOK, map[string]bool{"signedOut": true})
}

func (server *Server) currentAccount(writer http.ResponseWriter, request *http.Request) {
	account, ok := server.requireSession(writer, request)
	if !ok {
		return
	}
	writeJSON(writer, http.StatusOK, authResponse{Account: account})
}

// identityPolicy publishes the username rule so the frontend applies the same
// one instead of keeping its own copy, which is how the two drifted before.
func (server *Server) identityPolicy(writer http.ResponseWriter, _ *http.Request) {
	writeJSON(writer, http.StatusOK, persistence.Policy())
}

func writeAuthError(writer http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, persistence.ErrInvalidCredentials):
		// One message for both "no such user" and "wrong password": telling
		// them apart is an account-enumeration oracle.
		writeAPIError(writer, http.StatusUnauthorized, persistence.ErrInvalidCredentials.Error())
	case errors.Is(err, persistence.ErrInvalidProfileKey):
		writeAPIError(writer, http.StatusUnauthorized, "this device's local account key does not match")
	case errors.Is(err, persistence.ErrAccountDisabled):
		writeAPIError(writer, http.StatusForbidden, "this account is disabled")
	case errors.Is(err, persistence.ErrUsernameTaken):
		writeAPIError(writer, http.StatusConflict, "that username is already taken")
	case errors.Is(err, persistence.ErrAlreadyRegistered):
		writeAPIError(writer, http.StatusConflict, "this account already has a password")
	case errors.Is(err, persistence.ErrNotRegistered):
		writeAPIError(writer, http.StatusForbidden, "this account is not registered")
	case errors.Is(err, persistence.ErrIdentityAlreadyLinked):
		writeAPIError(writer, http.StatusConflict, err.Error())
	case errors.Is(err, persistence.ErrInvalidUsername):
		writeAPIError(writer, http.StatusBadRequest, err.Error())
	case errors.Is(err, persistence.ErrInvalidAccountProfile):
		writeAPIError(writer, http.StatusBadRequest, strings.TrimPrefix(
			err.Error(), persistence.ErrInvalidAccountProfile.Error()+": ",
		))
	case errors.Is(err, persistence.ErrAccountNotFound):
		writeAPIError(writer, http.StatusNotFound, "no such account")
	default:
		writeAPIError(writer, http.StatusInternalServerError, "authentication is unavailable")
	}
}
