package server

import (
	"sort"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"rps-strategy/backend/internal/game"
)

type pendingChallenge struct {
	challenge  Challenge
	challenger *Client
}

func normalizeChallengeUsername(username string) (string, bool) {
	username = strings.TrimSpace(username)
	count := utf8.RuneCountInString(username)
	if count < 1 || count > 40 || strings.IndexFunc(username, unicode.IsControl) >= 0 {
		return "", false
	}
	return username, true
}

func sameUsername(first string, second string) bool {
	return strings.EqualFold(strings.TrimSpace(first), strings.TrimSpace(second))
}

func (server *Server) clientCanStartChallenge(client *Client) bool {
	if server.participantFor(client) != nil || server.spectatorFor(client) != nil {
		return false
	}
	_, queued := server.matchmaking.Status(client)
	return !queued
}

func (server *Server) hasOutgoingChallenge(client *Client) bool {
	server.mu.RLock()
	defer server.mu.RUnlock()
	for _, pending := range server.challenges {
		if pending.challenger == client {
			return true
		}
	}
	return false
}

func (server *Server) sendChallenge(
	client *Client,
	username string,
	modeID game.ModeID,
	timeControl *game.TimeControl,
) {
	username, valid := normalizeChallengeUsername(username)
	if !valid {
		client.Send(ServerMessage{Type: "challenge_rejected", Message: "enter a username between 1 and 40 characters"})
		return
	}
	if sameUsername(username, "Guest") {
		client.Send(ServerMessage{Type: "challenge_rejected", Message: "Guest is not a challengeable username"})
		return
	}
	if sameUsername(username, client.profile.Username) {
		client.Send(ServerMessage{Type: "challenge_rejected", Message: "you cannot challenge yourself"})
		return
	}
	if !server.registry.Has(modeID) {
		client.Send(ServerMessage{Type: "challenge_rejected", Message: "invalid game mode"})
		return
	}
	if !server.registry.Playable(modeID) {
		client.Send(ServerMessage{
			Type:    "challenge_rejected",
			Message: "that game mode is no longer open for new matches",
		})
		return
	}
	control := game.DefaultTimeControl()
	if timeControl != nil {
		control = *timeControl
	}
	if err := control.Validate(); err != nil {
		client.Send(ServerMessage{Type: "challenge_rejected", Message: err.Error()})
		return
	}
	if !server.clientCanStartChallenge(client) {
		client.Send(ServerMessage{Type: "challenge_rejected", Message: "leave your current game or matchmaking first"})
		return
	}
	if server.hasOutgoingChallenge(client) {
		client.Send(ServerMessage{Type: "challenge_rejected", Message: "cancel your current challenge before sending another"})
		return
	}

	id, err := randomID()
	if err != nil {
		client.Send(ServerMessage{Type: "challenge_rejected", Message: "could not create the challenge"})
		return
	}
	mode, err := server.registry.New(modeID)
	if err != nil {
		client.Send(ServerMessage{Type: "challenge_rejected", Message: "invalid game mode"})
		return
	}
	definition := mode.Definition()
	now := time.Now()
	challenge := Challenge{
		ID:              id,
		Challenger:      client.profile,
		TargetUsername:  username,
		ModeID:          modeID,
		ModeName:        definition.Name,
		TimeControl:     control,
		CreatedAtUnixMs: now.UnixMilli(),
		ExpiresAtUnixMs: now.Add(challengeLifetime).UnixMilli(),
	}

	server.mu.Lock()
	pendingForName := 0
	for _, pending := range server.challenges {
		if sameUsername(pending.challenge.TargetUsername, username) {
			pendingForName++
		}
	}
	if pendingForName >= maximumPendingPerName {
		server.mu.Unlock()
		client.Send(ServerMessage{Type: "challenge_rejected", Message: "that player has too many pending challenges"})
		return
	}
	server.challenges[id] = &pendingChallenge{challenge: challenge, challenger: client}
	server.mu.Unlock()

	client.Send(ServerMessage{Type: "challenge_sent", Challenge: &challenge})
	for _, recipient := range server.connectedClients() {
		if recipient != client && sameUsername(recipient.profile.Username, username) {
			recipient.Send(ServerMessage{Type: "challenge_received", Challenge: &challenge})
		}
	}
}

func (server *Server) acceptChallenge(client *Client, challengeID string) {
	server.mu.RLock()
	pending := server.challenges[strings.TrimSpace(challengeID)]
	server.mu.RUnlock()
	if pending == nil || !sameUsername(pending.challenge.TargetUsername, client.profile.Username) {
		client.Send(ServerMessage{Type: "challenge_unavailable", Message: "that challenge is no longer available"})
		return
	}
	if time.Now().UnixMilli() >= pending.challenge.ExpiresAtUnixMs {
		server.removeChallenge(pending.challenge.ID)
		client.Send(ServerMessage{Type: "challenge_unavailable", Challenge: &pending.challenge, Message: "that challenge has expired"})
		return
	}
	if !server.clientCanStartChallenge(client) {
		client.Send(ServerMessage{Type: "challenge_rejected", Message: "leave your current game or matchmaking first"})
		return
	}
	if server.hasOutgoingChallenge(client) {
		client.Send(ServerMessage{Type: "challenge_rejected", Message: "cancel your outgoing challenge before accepting another"})
		return
	}
	challenger := pending.challenger
	if challenger == client || challenger.profile.UserID == client.profile.UserID ||
		!server.clientIsConnected(challenger) || !server.clientCanStartChallenge(challenger) {
		server.removeChallenge(pending.challenge.ID)
		client.Send(ServerMessage{Type: "challenge_unavailable", Challenge: &pending.challenge, Message: "the challenger is no longer available"})
		return
	}

	server.mu.Lock()
	current := server.challenges[pending.challenge.ID]
	if current != pending {
		server.mu.Unlock()
		client.Send(ServerMessage{Type: "challenge_unavailable", Message: "that challenge is no longer available"})
		return
	}
	delete(server.challenges, pending.challenge.ID)
	server.mu.Unlock()

	entryTime := time.Now()
	first := QueueEntry{
		Client:      challenger,
		ModeID:      pending.challenge.ModeID,
		TimeControl: pending.challenge.TimeControl,
		Elo:         matchmakingElo(challenger, pending.challenge.ModeID),
		JoinedAt:    entryTime,
	}
	second := QueueEntry{
		Client:      client,
		ModeID:      pending.challenge.ModeID,
		TimeControl: pending.challenge.TimeControl,
		Elo:         matchmakingElo(client, pending.challenge.ModeID),
		JoinedAt:    entryTime,
	}
	server.startConfiguredMatch(first, second, matchSetup{})
}

func (server *Server) declineChallenge(client *Client, challengeID string) {
	pending := server.challengeForRecipient(client, challengeID)
	if pending == nil {
		client.Send(ServerMessage{Type: "challenge_unavailable", Message: "that challenge is no longer available"})
		return
	}
	if !server.removeChallenge(pending.challenge.ID) {
		client.Send(ServerMessage{Type: "challenge_unavailable", Message: "that challenge is no longer available"})
		return
	}
	pending.challenger.Send(ServerMessage{Type: "challenge_declined", Challenge: &pending.challenge, Message: "Your challenge was declined."})
	client.Send(ServerMessage{Type: "challenge_removed", Challenge: &pending.challenge})
}

func (server *Server) cancelChallenge(client *Client, challengeID string) {
	server.mu.RLock()
	pending := server.challenges[strings.TrimSpace(challengeID)]
	server.mu.RUnlock()
	if pending == nil || pending.challenger != client || !server.removeChallenge(pending.challenge.ID) {
		client.Send(ServerMessage{Type: "challenge_unavailable", Message: "that challenge is no longer available"})
		return
	}
	message := ServerMessage{Type: "challenge_cancelled", Challenge: &pending.challenge, Message: "The challenge was cancelled."}
	client.Send(message)
	server.sendToChallengeRecipients(pending.challenge.TargetUsername, message)
}

func (server *Server) challengeForRecipient(client *Client, challengeID string) *pendingChallenge {
	server.mu.RLock()
	defer server.mu.RUnlock()
	pending := server.challenges[strings.TrimSpace(challengeID)]
	if pending == nil || !sameUsername(pending.challenge.TargetUsername, client.profile.Username) {
		return nil
	}
	return pending
}

func (server *Server) removeChallenge(challengeID string) bool {
	server.mu.Lock()
	defer server.mu.Unlock()
	if server.challenges[challengeID] == nil {
		return false
	}
	delete(server.challenges, challengeID)
	return true
}

func (server *Server) pendingChallengesFor(client *Client, now time.Time) []Challenge {
	server.mu.RLock()
	challenges := make([]Challenge, 0)
	for _, pending := range server.challenges {
		if now.UnixMilli() < pending.challenge.ExpiresAtUnixMs &&
			sameUsername(pending.challenge.TargetUsername, client.profile.Username) {
			challenges = append(challenges, pending.challenge)
		}
	}
	server.mu.RUnlock()
	sort.Slice(challenges, func(first, second int) bool {
		return challenges[first].CreatedAtUnixMs < challenges[second].CreatedAtUnixMs
	})
	return challenges
}

func (server *Server) expireChallenges(now time.Time) {
	expired := make([]*pendingChallenge, 0)
	server.mu.Lock()
	for id, pending := range server.challenges {
		if now.UnixMilli() >= pending.challenge.ExpiresAtUnixMs {
			delete(server.challenges, id)
			expired = append(expired, pending)
		}
	}
	server.mu.Unlock()
	for _, pending := range expired {
		message := ServerMessage{Type: "challenge_cancelled", Challenge: &pending.challenge, Message: "The challenge expired."}
		pending.challenger.Send(message)
		server.sendToChallengeRecipients(pending.challenge.TargetUsername, message)
	}
}

func (server *Server) cancelChallengesFrom(client *Client, reason string) {
	cancelled := make([]*pendingChallenge, 0)
	server.mu.Lock()
	for id, pending := range server.challenges {
		if pending.challenger == client {
			delete(server.challenges, id)
			cancelled = append(cancelled, pending)
		}
	}
	server.mu.Unlock()
	for _, pending := range cancelled {
		server.sendToChallengeRecipients(
			pending.challenge.TargetUsername,
			ServerMessage{Type: "challenge_cancelled", Challenge: &pending.challenge, Message: reason},
		)
	}
}

func (server *Server) sendToChallengeRecipients(username string, message ServerMessage) {
	for _, client := range server.connectedClients() {
		if sameUsername(client.profile.Username, username) {
			client.Send(message)
		}
	}
}

func (server *Server) connectedClients() []*Client {
	server.hub.mu.RLock()
	clients := make([]*Client, 0, len(server.hub.clients))
	for client := range server.hub.clients {
		clients = append(clients, client)
	}
	server.hub.mu.RUnlock()
	return clients
}

func (server *Server) clientIsConnected(client *Client) bool {
	server.hub.mu.RLock()
	_, connected := server.hub.clients[client]
	server.hub.mu.RUnlock()
	return connected
}
