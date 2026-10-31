package server

import (
	"encoding/json"
	"log"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"rps-strategy/backend/internal/game"
	"rps-strategy/backend/internal/persistence"
)

const (
	writeWait  = 10 * time.Second
	pongWait   = 60 * time.Second
	pingPeriod = (pongWait * 9) / 10
	maxMessage = 4096
	// botMaxMessage is larger because a bot's reply carries every line its
	// engine printed, and a ten-second multi-PV search prints a lot of them.
	botMaxMessage = 64 << 10
	// botAuthMaxMessage is the pre-authentication limit, which is larger again
	// because the frame that registers a bot carries its icon as base64 —
	// persistence.MaximumBotIconBytes inflated by a third, plus the rest of the
	// registration. Deliberately not botMaxMessage: an icon travels once, at
	// connect, and every bot would otherwise hold a read buffer sized for one
	// all game.
	botAuthMaxMessage = 256 << 10
	// sendBuffer is generous for bots for a different reason: a bot spends
	// most of a game blocked inside a search and cannot drain its queue. An
	// overrun closes the connection, so the buffer has to outlast a long think.
	sendBuffer    = 32
	botSendBuffer = 256
)

type Client struct {
	connection *websocket.Conn
	send       chan []byte
	done       chan struct{}
	profile    game.PlayerProfile
	account    persistence.Account
	server     *Server
	closeOnce  sync.Once
	// readLimit is per-client rather than a package constant because bots and
	// browsers send messages of very different sizes. It is applied in
	// readPump; the pre-authentication limit lives in handleWebSocket, and
	// both have to agree or the difference shows up only under load.
	readLimit int64
	// bot is nil for a person. A pointer rather than a flag so it carries the
	// engine session with it, and so every existing `&Client{...}` in tests
	// keeps compiling unchanged.
	bot *botClient

	// presence is what this tab last said about the person behind it. A seek
	// keeps its own copy for pairing; this one is what a challenge link asks
	// before it opens a board for somebody who is not searching at all. Unset
	// reads as here to isHere, for the reason Seek.CurrentPresence gives: a
	// socket that has said nothing about itself is one somebody just opened. A
	// link's author has to say so — see readyToBeSeated.
	presenceMu sync.Mutex
	presence   Presence
	// connectedAt is when the socket authenticated. Zero for the clients tests
	// build by hand, which therefore read as long connected.
	connectedAt time.Time
}

// setPresence records what this tab says about itself, and reports whether
// that changed anything. Recorded even when it changes nothing, because a tab
// that has said "here" is a different thing from one that has said nothing —
// see readyToBeSeated.
func (client *Client) setPresence(presence Presence) bool {
	client.presenceMu.Lock()
	defer client.presenceMu.Unlock()
	changed := client.currentPresenceLocked() != presence
	client.presence = presence
	return changed
}

// isHere reports whether somebody is looking at this tab, as far as it has
// said. Nil is nobody.
func (client *Client) isHere() bool {
	if client == nil {
		return false
	}
	client.presenceMu.Lock()
	defer client.presenceMu.Unlock()
	return client.currentPresenceLocked() == PresenceHere
}

func (client *Client) currentPresenceLocked() Presence {
	if client.presence == "" {
		return PresenceHere
	}
	return client.presence
}

// isBot reports whether this connection is an engine rather than a person.
func (client *Client) isBot() bool {
	return client != nil && client.bot != nil
}

// engineVersion is the build this connection's engine declared, and "" for a
// human seat, an empty one, or an engine that declared none.
//
// Nil-tolerant like isBot above, because both are asked about seats that may
// have nobody in them.
func (client *Client) engineVersion() string {
	if !client.isBot() {
		return ""
	}
	client.bot.mu.Lock()
	defer client.bot.mu.Unlock()
	if client.bot.handshake.Version != "" {
		return client.bot.handshake.Version
	}
	return client.bot.engineVersion
}

func (client *Client) Send(payload any) {
	encoded, err := json.Marshal(payload)
	if err != nil {
		log.Printf("encode websocket message: %v", err)
		return
	}
	select {
	case <-client.done:
		return
	default:
	}
	select {
	case client.send <- encoded:
	case <-client.done:
	default:
		client.close()
	}
}

func (client *Client) close() {
	client.closeOnce.Do(func() {
		close(client.done)
		if client.connection != nil {
			_ = client.connection.Close()
		}
	})
}

func (client *Client) readPump() {
	defer client.server.disconnect(client)
	limit := client.readLimit
	if limit == 0 {
		limit = maxMessage
	}
	client.connection.SetReadLimit(limit)
	_ = client.connection.SetReadDeadline(time.Now().Add(pongWait))
	client.connection.SetPongHandler(func(string) error {
		return client.connection.SetReadDeadline(time.Now().Add(pongWait))
	})

	for {
		var message ClientMessage
		if err := client.connection.ReadJSON(&message); err != nil {
			if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseAbnormalClosure) {
				log.Printf("websocket read: %v", err)
			}
			return
		}
		client.server.handleMessage(client, message)
	}
}

func (client *Client) writePump() {
	ticker := time.NewTicker(pingPeriod)
	defer ticker.Stop()
	defer client.close()

	for {
		select {
		case <-client.done:
			return
		case message := <-client.send:
			_ = client.connection.SetWriteDeadline(time.Now().Add(writeWait))
			if err := client.connection.WriteMessage(websocket.TextMessage, message); err != nil {
				return
			}
		case <-ticker.C:
			_ = client.connection.SetWriteDeadline(time.Now().Add(writeWait))
			if err := client.connection.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		}
	}
}

type Hub struct {
	mu      sync.RWMutex
	clients map[*Client]struct{}
}

func NewHub() *Hub {
	return &Hub{
		clients: make(map[*Client]struct{}),
	}
}

func (hub *Hub) Register(client *Client) {
	hub.mu.Lock()
	hub.clients[client] = struct{}{}
	hub.mu.Unlock()
}

func (hub *Hub) Unregister(client *Client) {
	hub.mu.Lock()
	delete(hub.clients, client)
	hub.mu.Unlock()
	client.close()
}
