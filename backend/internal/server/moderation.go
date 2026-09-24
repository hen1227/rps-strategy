package server

import (
	"context"
	"errors"
	"log"
	"net/http"
	"strconv"
	"sync"
	"time"

	"rps-strategy/backend/internal/persistence"
)

// Enforcing the sanctions that persistence/moderation.go stores.
//
// The store is the record; this is the gate. There are three sanctions and four
// places they bite, and the mapping is deliberately small enough to hold in
// your head:
//
//	mute        → sendChat, postSeek
//	ranked      → rankedAllowed
//	tournament  → signupForTournament, enrolOnlineBots
//
// # Why they are cached in memory
//
// A mute is asked about on every chat message and every challenge; the ranked
// bar is asked about on every seek. Those are the paths that have to stay
// cheap, and they run under server.mu, over the same single SQLite connection
// the game loop uses. So the whole set is read once at boot and held here, and
// every write goes through setRestriction, which updates both.
//
// The cost of that is one invariant: nothing may change
// `account_restrictions` without going through this file. Nothing does — the
// admin routes below are the only writers — and a host who edited the table by
// hand would need a restart, which is the same as it has always been for
// anything else the server holds in memory.
//
// Expiry needs no such care. A cached restriction carries its own deadline and
// is simply not in force past it, so a mute that lapses does so without
// anything having to run.

// moderationBoard is the in-memory copy of every account's sanctions.
type moderationBoard struct {
	mu sync.RWMutex
	// byAccount holds every sanction on record, lapsed ones included, because
	// the admin screen wants the history and filtering happens at the point of
	// the question instead.
	byAccount map[string][]persistence.Restriction
}

// loadRestrictions fills the cache from the store. Called once, at construction.
//
// A failure here is logged rather than fatal, and the consequence is stated
// plainly: sanctions would not be enforced until the next restart. That is the
// right trade for a server whose main job is to serve games — refusing to boot
// because the moderation table could not be read would turn a moderation
// outage into a total one.
func (server *Server) loadRestrictions(ctx context.Context) {
	byAccount, err := server.data.AllRestrictions(ctx)
	if err != nil {
		log.Printf("load account restrictions: %v (sanctions are not being enforced)", err)
		byAccount = make(map[string][]persistence.Restriction)
	}
	server.restrictions.mu.Lock()
	server.restrictions.byAccount = byAccount
	server.restrictions.mu.Unlock()
}

// restrictionOn returns an account's sanction of one kind, if it is in force.
//
// Nil for an account with no such sanction and for one whose sanction has
// lapsed, which is what makes it usable as a plain "is this allowed" question.
func (server *Server) restrictionOn(
	userID string,
	kind persistence.RestrictionKind,
) *persistence.Restriction {
	if userID == "" {
		return nil
	}
	now := time.Now()
	server.restrictions.mu.RLock()
	defer server.restrictions.mu.RUnlock()
	for _, restriction := range server.restrictions.byAccount[userID] {
		if restriction.Kind == kind && restriction.ActiveAt(now) {
			found := restriction
			return &found
		}
	}
	return nil
}

// activeRestrictions is every sanction in force on an account, which is what a
// client is told about itself so it can explain a refusal before making one.
func (server *Server) activeRestrictions(userID string) []persistence.PublicRestriction {
	if userID == "" {
		return nil
	}
	now := time.Now()
	server.restrictions.mu.RLock()
	defer server.restrictions.mu.RUnlock()
	var active []persistence.PublicRestriction
	for _, restriction := range server.restrictions.byAccount[userID] {
		if restriction.ActiveAt(now) {
			active = append(active, restriction.Public())
		}
	}
	return active
}

// cacheRestriction replaces one kind of sanction in the cache.
func (server *Server) cacheRestriction(userID string, restriction persistence.Restriction) {
	server.restrictions.mu.Lock()
	defer server.restrictions.mu.Unlock()
	if server.restrictions.byAccount == nil {
		server.restrictions.byAccount = make(map[string][]persistence.Restriction)
	}
	existing := server.restrictions.byAccount[userID]
	for index := range existing {
		if existing[index].Kind == restriction.Kind {
			existing[index] = restriction
			return
		}
	}
	server.restrictions.byAccount[userID] = append(existing, restriction)
}

// uncacheRestriction drops one kind of sanction from the cache.
func (server *Server) uncacheRestriction(userID string, kind persistence.RestrictionKind) {
	server.restrictions.mu.Lock()
	defer server.restrictions.mu.Unlock()
	existing := server.restrictions.byAccount[userID]
	kept := existing[:0]
	for _, restriction := range existing {
		if restriction.Kind != kind {
			kept = append(kept, restriction)
		}
	}
	if len(kept) == 0 {
		delete(server.restrictions.byAccount, userID)
		return
	}
	server.restrictions.byAccount[userID] = kept
}

/* ----------------------------------------------------------- the refusals -- */

// muteRefusal is the answer a muted account gets, or empty when it is not muted.
//
// One function for both halves of a mute — chat and challenges — because the
// pairing *is* the definition of the sanction, and two spellings of it is how
// one of them ends up not being enforced. See the note on
// persistence.RestrictMute.
func (server *Server) muteRefusal(client *Client, what string) string {
	return server.mutedRefusal(client.profile.UserID, what)
}

// mutedRefusal is the same answer for a caller that arrived over HTTP rather
// than down a socket.
//
// The feedback board is the third thing a mute covers, and it reaches this by
// account id because a REST request has no Client behind it. One function for
// all three, for the reason above: a sanction with two implementations is one
// that eventually means two different things.
func (server *Server) mutedRefusal(userID string, what string) string {
	restriction := server.restrictionOn(userID, persistence.RestrictMute)
	if restriction == nil {
		return ""
	}
	return "you cannot " + what + " while muted" + sanctionSuffix(*restriction)
}

// rankedAllowed reports whether this connection may play for a rating.
//
// Bots always may. No bot path reaches either gate today — engine matches and
// bot-versus-bot series build their entries and seat them directly — but an
// engine that did arrive here must not be silently downgraded, because every
// bot account has no password and would otherwise read as unregistered and
// have its ranked series quietly turned casual.
//
// A sanctioned account is downgraded rather than refused, which is the same
// treatment a guest gets and for the same reason: they can still play, it just
// does not move the ladder. Refusing outright would make a ranked ban a ban.
func (server *Server) rankedAllowed(client *Client) bool {
	if !client.isBot() && !client.account.Registered {
		return false
	}
	return server.restrictionOn(client.profile.UserID, persistence.RestrictRanked) == nil
}

// tournamentRefusal is the answer an account barred from events gets.
func (server *Server) tournamentRefusal(userID string) string {
	restriction := server.restrictionOn(userID, persistence.RestrictTournament)
	if restriction == nil {
		return ""
	}
	return "this account cannot enter tournaments" + sanctionSuffix(*restriction)
}

// sanctionSuffix is the part of a refusal that says why and until when.
//
// Both halves are worth saying. "You are muted" with no end and no reason is
// the message that generates the support request; "muted until 19:40 for
// spamming the lobby" answers it in advance.
func sanctionSuffix(restriction persistence.Restriction) string {
	suffix := ""
	if restriction.ExpiresAtUnixMs != nil {
		remaining := time.Until(time.UnixMilli(*restriction.ExpiresAtUnixMs))
		suffix += " (" + roughDuration(remaining) + " left)"
	}
	if restriction.Reason != "" {
		suffix += ": " + restriction.Reason
	}
	return suffix
}

// roughDuration is a countdown in the units somebody reads it in.
//
// Deliberately coarse. "23 minutes" is what a person needs; "22m47.318s" is
// what a stopwatch needs, and printing a Duration is how the second one ends up
// in a message to a player.
func roughDuration(remaining time.Duration) string {
	switch {
	case remaining <= time.Minute:
		return "under a minute"
	case remaining < time.Hour:
		return plural(int(remaining.Minutes()), "minute")
	case remaining < 48*time.Hour:
		return plural(int(remaining.Hours()), "hour")
	default:
		return plural(int(remaining.Hours()/24), "day")
	}
}

func plural(count int, noun string) string {
	if count == 1 {
		return "1 " + noun
	}
	return strconv.Itoa(count) + " " + noun + "s"
}

/* -------------------------------------------------------------- the routes -- */

type restrictionRequest struct {
	Kind   persistence.RestrictionKind `json:"kind"`
	Reason string                      `json:"reason"`
	// DurationSeconds is how long it stands, and zero means until it is lifted.
	// Seconds rather than a deadline so a client says "an hour" and does not
	// have to agree with the server about what time it is.
	DurationSeconds int64 `json:"durationSeconds"`
}

// restrictAccount places or extends a sanction.
func (server *Server) restrictAccount(writer http.ResponseWriter, request *http.Request) {
	userID := request.PathValue("userID")
	var input restrictionRequest
	if err := decodeAPIRequest(writer, request, &input); err != nil {
		writeAPIError(writer, http.StatusBadRequest, err.Error())
		return
	}
	if !input.Kind.Valid() {
		writeAPIError(writer, http.StatusBadRequest, "kind must be mute, ranked, or tournament")
		return
	}
	if input.DurationSeconds < 0 {
		writeAPIError(writer, http.StatusBadRequest, "durationSeconds cannot be negative")
		return
	}
	var expiresAt *int64
	if input.DurationSeconds > 0 {
		deadline := time.Now().Add(time.Duration(input.DurationSeconds) * time.Second).UnixMilli()
		expiresAt = &deadline
	}
	// Who issued it, for the record. Read straight off the session rather than
	// through requireSession, because this route is already behind adminOnly
	// and an administrator holding the shared token rather than an account has
	// no user id to record — see Restriction.IssuedBy.
	issuedBy := ""
	if token := sessionToken(request); token != "" {
		if account, err := server.data.SessionAccount(request.Context(), token); err == nil {
			issuedBy = account.UserID
		}
	}
	restriction, err := server.data.SetRestriction(
		request.Context(), userID, input.Kind, input.Reason, issuedBy, expiresAt,
	)
	if err != nil {
		writeRestrictionError(writer, err)
		return
	}
	server.cacheRestriction(userID, restriction)
	// Told at once, rather than discovered by trying something. A player whose
	// next message is silently refused reads it as the site being broken.
	server.notifyRestrictions(userID)
	// A ranked bar changes what the lobby may offer this account, and a mute
	// changes whether their posted challenge should still be up. Both are
	// simplest to settle by withdrawing whatever they have on the board.
	if input.Kind == persistence.RestrictMute || input.Kind == persistence.RestrictRanked {
		server.withdrawSeeksOf(userID, "Your challenge was withdrawn by a moderator.")
	}
	writeJSON(writer, http.StatusOK, restriction)
}

// liftAccountRestriction removes a sanction.
func (server *Server) liftAccountRestriction(
	writer http.ResponseWriter,
	request *http.Request,
) {
	userID := request.PathValue("userID")
	kind := persistence.RestrictionKind(request.PathValue("kind"))
	if !kind.Valid() {
		writeAPIError(writer, http.StatusBadRequest, "kind must be mute, ranked, or tournament")
		return
	}
	if err := server.data.ClearRestriction(request.Context(), userID, kind); err != nil {
		writeRestrictionError(writer, err)
		return
	}
	server.uncacheRestriction(userID, kind)
	server.notifyRestrictions(userID)
	writeJSON(writer, http.StatusOK, map[string]bool{"lifted": true})
}

// listAccountRestrictions is what the admin screen shows against a name:
// everything on record, lapsed ones included.
func (server *Server) listAccountRestrictions(
	writer http.ResponseWriter,
	request *http.Request,
) {
	restrictions, err := server.data.Restrictions(
		request.Context(), request.PathValue("userID"),
	)
	if err != nil {
		writeRestrictionError(writer, err)
		return
	}
	writeJSON(writer, http.StatusOK, restrictions)
}

// notifyRestrictions tells every connection an account holds what it may and
// may not do now.
func (server *Server) notifyRestrictions(userID string) {
	active := server.activeRestrictions(userID)
	for _, client := range server.connectedClients() {
		if client.profile.UserID != userID {
			continue
		}
		client.Send(ServerMessage{Type: "restrictions", Restrictions: active})
	}
}

// withdrawSeeksOf takes an account's challenge off the board.
func (server *Server) withdrawSeeksOf(userID string, reason string) {
	for _, client := range server.connectedClients() {
		if client.profile.UserID != userID {
			continue
		}
		if seek := server.seeks.RemoveClient(client); seek != nil {
			server.announceWithdrawnSeek(seek, reason)
		}
	}
	server.broadcastOpenChallenges()
}

func writeRestrictionError(writer http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, persistence.ErrAccountNotFound):
		writeAPIError(writer, http.StatusNotFound, "no such account")
	case errors.Is(err, persistence.ErrUnknownRestriction):
		writeAPIError(writer, http.StatusBadRequest, err.Error())
	default:
		log.Printf("account restriction: %v", err)
		writeAPIError(writer, http.StatusInternalServerError, err.Error())
	}
}

// rankedRefusal explains why a game just became casual.
//
// Two reasons can produce the same downgrade, and telling somebody to sign in
// with Discord when they already have — and are barred — is the message that
// makes a moderation decision look like a bug.
func (server *Server) rankedRefusal(client *Client) string {
	if restriction := server.restrictionOn(
		client.profile.UserID, persistence.RestrictRanked,
	); restriction != nil {
		return "this account cannot play ranked" +
			sanctionSuffix(*restriction) + "; this game is casual"
	}
	return "sign in with Discord to play ranked; this game is casual"
}

// rankedAcceptRefusal is the same explanation for the other side of the gate:
// somebody trying to accept a rated game that is not theirs to accept.
func (server *Server) rankedAcceptRefusal(client *Client) string {
	if restriction := server.restrictionOn(
		client.profile.UserID, persistence.RestrictRanked,
	); restriction != nil {
		return "that game is ranked, and this account cannot play ranked" +
			sanctionSuffix(*restriction)
	}
	return "that game is ranked; sign in with Discord to accept it"
}

// pruneRestrictions clears out lapsed sanctions, in the store and in the cache.
//
// Housekeeping, on the lobby ticker beside the other sweeps. Nothing depends on
// it: a lapsed restriction is already not enforced, in both places, because
// both ask ActiveAt. What this buys is that the admin screen's history does not
// grow without limit, and that an account with nothing live against it stops
// having a row at all.
func (server *Server) pruneRestrictions(now time.Time) {
	// Not every tick. This is a write to the database that the moment-to-moment
	// running of the server has no interest in, and the ticker it is on fires
	// every couple of seconds.
	if now.Minute() != 0 || now.Second() >= 3 {
		return
	}
	if _, err := server.data.PruneExpiredRestrictions(context.Background(), now); err != nil {
		log.Printf("prune expired restrictions: %v", err)
		return
	}
	server.restrictions.mu.Lock()
	defer server.restrictions.mu.Unlock()
	for userID, restrictions := range server.restrictions.byAccount {
		kept := restrictions[:0]
		for _, restriction := range restrictions {
			if restriction.ActiveAt(now) {
				kept = append(kept, restriction)
			}
		}
		if len(kept) == 0 {
			delete(server.restrictions.byAccount, userID)
			continue
		}
		server.restrictions.byAccount[userID] = kept
	}
}
