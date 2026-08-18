package server

import (
	"rps-strategy/backend/internal/game"
	"rps-strategy/backend/internal/persistence"
)

// ClientMessage describes every command accepted over the WebSocket transport.
type ClientMessage struct {
	Type        string            `json:"type"`
	GameID      string            `json:"gameId,omitempty"`
	ModeID      game.ModeID       `json:"modeId,omitempty"`
	TimeControl *game.TimeControl `json:"timeControl,omitempty"`
	From        game.Position     `json:"from,omitempty"`
	To          game.Position     `json:"to,omitempty"`
}

// ServerMessage is the shared WebSocket response envelope.
type ServerMessage struct {
	Type                    string                    `json:"type"`
	Message                 string                    `json:"message,omitempty"`
	ModeID                  game.ModeID               `json:"modeId,omitempty"`
	Modes                   []game.ModeDefinition     `json:"modes,omitempty"`
	Account                 *persistence.Account      `json:"account,omitempty"`
	DefaultTimeControl      *game.TimeControl         `json:"defaultTimeControl,omitempty"`
	TimeControl             *game.TimeControl         `json:"timeControl,omitempty"`
	Color                   game.PlayerColor          `json:"color,omitempty"`
	GameState               *game.GameState           `json:"gameState,omitempty"`
	From                    *game.Position            `json:"from,omitempty"`
	ValidMoves              []game.Position           `json:"validMoves,omitempty"`
	SearchRange             int                       `json:"searchRange,omitempty"`
	QueuedForMs             int64                     `json:"queuedForMs,omitempty"`
	ModePlayerCounts        map[game.ModeID]int       `json:"modePlayerCounts,omitempty"`
	RatingUpdate            *persistence.RatingUpdate `json:"ratingUpdate,omitempty"`
	ReconnectDeadlineUnixMs int64                     `json:"reconnectDeadlineUnixMs,omitempty"`
}
