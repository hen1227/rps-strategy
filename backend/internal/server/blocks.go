package server

import (
	"context"
	"errors"
	"log"
	"net/http"
	"strings"
	"sync"

	"rps-strategy/backend/internal/persistence"
)

// Enforcing the block lists that persistence/blocks.go stores.
//
// Same shape as moderation.go, and for the same reason: the store is the
// record, this is the gate, and the whole set is held in memory because the
// question is asked far too often to go to the database for. Chat delivery asks
// it once per listener per message, over the same single SQLite connection the
// game loop runs on.
//
// The invariant that buys is the same one: nothing may write `account_blocks`
// without going through setBlock/clearBlock below, which update the cache in
// the same breath. The two routes at the bottom are the only writers.
//
// # Where it bites
//
// Two places, and the mapping is small enough to hold in your head:
//
//	chat        → sendChat, and the history handed to a joining client
//	challenges  → postSeek, but only a challenge addressed to somebody by name
//
// Matchmaking is deliberately untouched. See the note at the top of
// persistence/blocks.go for why: on a site this size, removing two people from
// each other's pool turns a block into "one of us cannot get a game".

// blockBoard is the in-memory copy of every block list.
type blockBoard struct {
	mu sync.RWMutex
	// byBlocker is who each account has blocked. The reverse direction is not
	// indexed: every question asked here is symmetric and checks both maps, and
	// a second index would be a second thing to keep in step.
	byBlocker map[string]map[string]struct{}
}

// loadBlocks fills the cache from the store. Called once, at construction.
//
// A failure is logged rather than fatal, with the consequence stated plainly —
// the same trade loadRestrictions makes. Blocks would not be enforced until the
// next restart, which is bad; refusing to serve games at all because a
// preference table could not be read is worse.
func (server *Server) loadBlocks(ctx context.Context) {
	byBlocker, err := server.data.AllBlocks(ctx)
	if err != nil {
		log.Printf("load account blocks: %v (blocks are not being enforced)", err)
		byBlocker = make(map[string]map[string]struct{})
	}
	server.blocks.mu.Lock()
	server.blocks.byBlocker = byBlocker
	server.blocks.mu.Unlock()
}

// blockedBetween reports whether either account has blocked the other.
//
// The symmetric question, which is the only one any caller asks. A
// one-directional check is how you end up with a blocked player who can still
// read, and answer, everything the person who blocked them says.
func (server *Server) blockedBetween(first, second string) bool {
	if first == "" || second == "" || first == second {
		return false
	}
	server.blocks.mu.RLock()
	defer server.blocks.mu.RUnlock()
	if _, blocked := server.blocks.byBlocker[first][second]; blocked {
		return true
	}
	_, blocked := server.blocks.byBlocker[second][first]
	return blocked
}

// blockedUserIDs is one account's own list, as the client is told it so it can
// grey out a name it is about to challenge.
func (server *Server) blockedUserIDs(userID string) []string {
	if userID == "" {
		return nil
	}
	server.blocks.mu.RLock()
	defer server.blocks.mu.RUnlock()
	held := server.blocks.byBlocker[userID]
	if len(held) == 0 {
		return nil
	}
	ids := make([]string, 0, len(held))
	for blocked := range held {
		ids = append(ids, blocked)
	}
	return ids
}

func (server *Server) cacheBlock(blockerID, blockedID string) {
	server.blocks.mu.Lock()
	defer server.blocks.mu.Unlock()
	if server.blocks.byBlocker == nil {
		server.blocks.byBlocker = make(map[string]map[string]struct{})
	}
	if server.blocks.byBlocker[blockerID] == nil {
		server.blocks.byBlocker[blockerID] = make(map[string]struct{})
	}
	server.blocks.byBlocker[blockerID][blockedID] = struct{}{}
}

func (server *Server) uncacheBlock(blockerID, blockedID string) {
	server.blocks.mu.Lock()
	defer server.blocks.mu.Unlock()
	held := server.blocks.byBlocker[blockerID]
	delete(held, blockedID)
	if len(held) == 0 {
		delete(server.blocks.byBlocker, blockerID)
	}
}

// forgetBlocksOf drops every block an account is either end of.
//
// Called when the account goes: the rows cascade away in the database, and a
// cache that kept them would go on hiding a stranger who was later given the
// same id. Cheap enough to do by sweeping — this runs once per deletion, not
// per message.
func (server *Server) forgetBlocksOf(userID string) {
	server.blocks.mu.Lock()
	defer server.blocks.mu.Unlock()
	delete(server.blocks.byBlocker, userID)
	for blocker, held := range server.blocks.byBlocker {
		if _, blocked := held[userID]; !blocked {
			continue
		}
		delete(held, userID)
		if len(held) == 0 {
			delete(server.blocks.byBlocker, blocker)
		}
	}
}

/* ----------------------------------------------------------- the refusals -- */

// visibleChat is a chat history with the blocked parties taken out of it.
//
// Applied wherever a room's history is handed to one identified client, which
// is every entry point into a conversation: match_found, game_rejoined,
// spectator_joined, and the post-game room. A live message is filtered at
// delivery instead — see chatAudienceFor — because there the recipient list is
// what is being built.
//
// Returns the input untouched when nothing is blocked, which is nearly always,
// so the ordinary path does not copy a room's worth of messages per join.
func (server *Server) visibleChat(client *Client, history []ChatMessage) []ChatMessage {
	if client == nil || len(history) == 0 {
		return history
	}
	viewer := client.profile.UserID
	if viewer == "" {
		return history
	}
	hidden := 0
	for _, message := range history {
		if server.blockedBetween(viewer, message.SenderUserID) {
			hidden++
		}
	}
	if hidden == 0 {
		return history
	}
	visible := make([]ChatMessage, 0, len(history)-hidden)
	for _, message := range history {
		if server.blockedBetween(viewer, message.SenderUserID) {
			continue
		}
		visible = append(visible, message)
	}
	return visible
}

// challengeBlockRefusal is the answer somebody gets for challenging a person
// one of them has blocked.
//
// Deliberately vague about which direction the block runs. "You have blocked
// them" and "they have blocked you" are different sentences, and publishing the
// second one tells somebody they were blocked — which is a thing the person who
// blocked them chose not to say, and the start of the argument a block exists
// to avoid.
const challengeBlockRefusal = "you cannot challenge that player"

// challengeIsBlocked reports whether a challenge addressed to a username may
// not be sent.
//
// The name is resolved through the store rather than against the connected
// clients, because a private challenge outlives the moment: it sits in an inbox
// and is delivered when its target signs in, so "are they online right now" is
// the wrong question. One indexed lookup, on a path a person walks by pressing
// a button rather than one the game loop runs.
//
// An unresolvable name is not blocked. It is either a guest, a typo, or
// somebody who has since been renamed, and none of those is a block.
func (server *Server) challengeIsBlocked(client *Client, username string) bool {
	if client == nil || client.profile.UserID == "" {
		return false
	}
	targetID, err := server.data.AccountIDForUsername(context.Background(), username)
	if err != nil {
		if !errors.Is(err, persistence.ErrAccountNotFound) {
			log.Printf("resolve challenge target %q: %v", username, err)
		}
		return false
	}
	return server.blockedBetween(client.profile.UserID, targetID)
}

/* -------------------------------------------------------------- the routes -- */

type blockRequest struct {
	// UserID is who to block. Username is the same request from a client that
	// only knows the name — a chat line carries both, but a player page reached
	// by handle carries only the second.
	UserID   string `json:"userId"`
	Username string `json:"username"`
}

// listBlocks is the player's own list, which is the screen they manage it from.
func (server *Server) listBlocks(writer http.ResponseWriter, request *http.Request) {
	account, ok := server.requireSession(writer, request)
	if !ok {
		return
	}
	blocked, err := server.data.BlockedAccounts(request.Context(), account.UserID)
	if err != nil {
		writeBlockError(writer, err)
		return
	}
	writeJSON(writer, http.StatusOK, map[string]any{"blocked": blocked})
}

// blockPlayer adds somebody to the caller's list.
//
// A session rather than a browser key, which is the one place blocking is
// stricter than reporting. A block is a durable preference that has to survive
// a cleared browser to mean anything: a guest's list would be thrown away with
// the local key it hung off, and a protection that quietly evaporates is worse
// than one somebody knows they have to sign in for. Reporting takes either —
// see fileReport — because a report is a one-off message and loses nothing by
// being anonymous.
func (server *Server) blockPlayer(writer http.ResponseWriter, request *http.Request) {
	account, ok := server.requireSession(writer, request)
	if !ok {
		return
	}
	var input blockRequest
	if err := decodeAPIRequest(writer, request, &input); err != nil {
		writeAPIError(writer, http.StatusBadRequest, err.Error())
		return
	}
	targetID, err := server.resolveTarget(request.Context(), input.UserID, input.Username)
	if err != nil {
		writeBlockError(writer, err)
		return
	}
	if err := server.data.BlockAccount(request.Context(), account.UserID, targetID); err != nil {
		writeBlockError(writer, err)
		return
	}
	server.cacheBlock(account.UserID, targetID)
	// Whatever either of them had addressed to the other is withdrawn now. A
	// challenge that survives the block is a name sitting in an inbox that
	// cannot be accepted, which reads as the site being broken.
	server.cancelChallengesBetween(account.UserID, targetID)
	server.sendBlockList(account.UserID)
	blocked, err := server.data.BlockedAccounts(request.Context(), account.UserID)
	if err != nil {
		writeBlockError(writer, err)
		return
	}
	writeJSON(writer, http.StatusOK, map[string]any{"blocked": blocked})
}

// unblockPlayer removes somebody from the caller's list.
func (server *Server) unblockPlayer(writer http.ResponseWriter, request *http.Request) {
	account, ok := server.requireSession(writer, request)
	if !ok {
		return
	}
	targetID := request.PathValue("userID")
	if err := server.data.UnblockAccount(request.Context(), account.UserID, targetID); err != nil {
		writeBlockError(writer, err)
		return
	}
	server.uncacheBlock(account.UserID, targetID)
	server.sendBlockList(account.UserID)
	blocked, err := server.data.BlockedAccounts(request.Context(), account.UserID)
	if err != nil {
		writeBlockError(writer, err)
		return
	}
	writeJSON(writer, http.StatusOK, map[string]any{"blocked": blocked})
}

// resolveTarget turns whichever of the two identifiers a client sent into a
// user id.
//
// The id wins when both are present: a name can be changed between the moment
// a client read it and the moment somebody presses the button, and blocking
// whoever happens to hold the name now is the wrong person.
func (server *Server) resolveTarget(
	ctx context.Context,
	userID string,
	username string,
) (string, error) {
	if trimmed := strings.TrimSpace(userID); trimmed != "" {
		return trimmed, nil
	}
	if trimmed := strings.TrimSpace(username); trimmed != "" {
		return server.data.AccountIDForUsername(ctx, trimmed)
	}
	return "", persistence.ErrAccountNotFound
}

// sendBlockList tells every connection an account holds who it is currently
// hiding, so a second tab does not go on showing somebody the first one just
// blocked.
func (server *Server) sendBlockList(userID string) {
	blocked := server.blockedUserIDs(userID)
	for _, client := range server.connectedClients() {
		if client.profile.UserID != userID {
			continue
		}
		client.Send(ServerMessage{Type: "blocked_players", BlockedUserIDs: blocked})
	}
}

// cancelChallengesBetween withdraws whatever either party has addressed to the
// other: a posted seek, and a pending challenge in an inbox.
func (server *Server) cancelChallengesBetween(first, second string) {
	for _, client := range server.connectedClients() {
		userID := client.profile.UserID
		if userID != first && userID != second {
			continue
		}
		seek := server.seeks.ForClient(client)
		if seek == nil || seek.IsOpen() {
			continue
		}
		// A private seek names its target. Resolving that name to an id costs
		// a lookup against connected clients, which is cheaper than a query
		// and is the same set the seek could ever be accepted from.
		if !server.usernameBelongsTo(seek.TargetUsername, first, second) {
			continue
		}
		if removed := server.seeks.RemoveClient(client); removed != nil {
			server.announceWithdrawnSeek(removed, "That challenge was withdrawn.")
		}
	}
	server.broadcastOpenChallenges()
}

// usernameBelongsTo reports whether a challenge target names either of two
// accounts, judged against the connected clients that could answer to it.
func (server *Server) usernameBelongsTo(username string, first, second string) bool {
	for _, client := range server.connectedClients() {
		if !sameUsername(client.profile.Username, username) {
			continue
		}
		if client.profile.UserID == first || client.profile.UserID == second {
			return true
		}
	}
	return false
}

func writeBlockError(writer http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, persistence.ErrAccountNotFound):
		writeAPIError(writer, http.StatusNotFound, "no such player")
	case errors.Is(err, persistence.ErrCannotBlockSelf):
		writeAPIError(writer, http.StatusBadRequest, err.Error())
	default:
		log.Printf("account block: %v", err)
		writeAPIError(writer, http.StatusInternalServerError, err.Error())
	}
}
