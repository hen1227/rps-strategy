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
}

// isBot reports whether this connection is an engine rather than a person.
func (client *Client) isBot() bool {
	return client != nil && client.bot != nil
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
