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
)

type Client struct {
	connection *websocket.Conn
	send       chan []byte
	done       chan struct{}
	profile    game.PlayerProfile
	account    persistence.Account
	server     *Server
	closeOnce  sync.Once
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
	client.connection.SetReadLimit(maxMessage)
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
