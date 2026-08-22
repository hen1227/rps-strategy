package server

import (
	"rps-strategy/backend/internal/game"
	"rps-strategy/backend/internal/persistence"
)

// ClientMessage describes every command accepted over the WebSocket transport.
type ClientMessage struct {
	Type         string            `json:"type"`
	UserID       string            `json:"userId,omitempty"`
	ProfileKey   string            `json:"profileKey,omitempty"`
	GameID       string            `json:"gameId,omitempty"`
	ChallengeID  string            `json:"challengeId,omitempty"`
	TournamentID string            `json:"tournamentId,omitempty"`
	MatchID      int64             `json:"matchId,omitempty"`
	Username     string            `json:"username,omitempty"`
	Text         string            `json:"text,omitempty"`
	ModeID       game.ModeID       `json:"modeId,omitempty"`
	TimeControl  *game.TimeControl `json:"timeControl,omitempty"`
	From         game.Position     `json:"from,omitempty"`
	To           game.Position     `json:"to,omitempty"`
}

// Challenge is a private, unranked game invitation addressed to a display
// name. It remains pending briefly so the recipient can receive it when they
// next connect to the lobby.
type Challenge struct {
	ID              string             `json:"id"`
	Challenger      game.PlayerProfile `json:"challenger"`
	TargetUsername  string             `json:"targetUsername"`
	ModeID          game.ModeID        `json:"modeId"`
	ModeName        string             `json:"modeName"`
	TimeControl     game.TimeControl   `json:"timeControl"`
	CreatedAtUnixMs int64              `json:"createdAtUnixMs"`
	ExpiresAtUnixMs int64              `json:"expiresAtUnixMs"`
}

// LiveGameSummary is the public lobby representation of an in-progress game.
// Ratings are captured when the match starts so a disconnected player still
// has a complete row in the live-game list.
type LiveGameSummary struct {
	GameID          string             `json:"gameId"`
	ModeID          game.ModeID        `json:"modeId"`
	ModeName        string             `json:"modeName"`
	RedPlayer       game.PlayerProfile `json:"redPlayer"`
	BluePlayer      game.PlayerProfile `json:"bluePlayer"`
	RedElo          int                `json:"redElo"`
	BlueElo         int                `json:"blueElo"`
	SpectatorCount  int                `json:"spectatorCount"`
	StartedAtUnixMs int64              `json:"startedAtUnixMs"`
}

// ChatMessage is authored from the authenticated client profile. SenderRole
// allows players to locally hide spectator messages without weakening the
// server-side identity attached to each message.
type ChatMessage struct {
	ID           string           `json:"id"`
	GameID       string           `json:"gameId"`
	SenderUserID string           `json:"senderUserId"`
	SenderName   string           `json:"senderName"`
	SenderRole   string           `json:"senderRole"`
	SenderColor  game.PlayerColor `json:"senderColor,omitempty"`
	Text         string           `json:"text"`
	SentAtUnixMs int64            `json:"sentAtUnixMs"`
}

// ServerMessage is the shared WebSocket response envelope.
type ServerMessage struct {
	Type                    string                    `json:"type"`
	Message                 string                    `json:"message,omitempty"`
	ModeID                  game.ModeID               `json:"modeId,omitempty"`
	Modes                   []game.ModeDefinition     `json:"modes,omitempty"`
	LiveGames               []LiveGameSummary         `json:"liveGames,omitempty"`
	Tournaments             []TournamentSnapshot      `json:"tournaments,omitempty"`
	Challenge               *Challenge                `json:"challenge,omitempty"`
	Challenges              []Challenge               `json:"challenges,omitempty"`
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
	ModeQueueCounts         map[game.ModeID]int       `json:"modeQueueCounts,omitempty"`
	BotPlayerCount          int                       `json:"botPlayerCount,omitempty"`
	RatingUpdate            *persistence.RatingUpdate `json:"ratingUpdate,omitempty"`
	ChatMessage             *ChatMessage              `json:"chatMessage,omitempty"`
	ChatMessages            []ChatMessage             `json:"chatMessages,omitempty"`
	ReconnectDeadlineUnixMs int64                     `json:"reconnectDeadlineUnixMs,omitempty"`
}
