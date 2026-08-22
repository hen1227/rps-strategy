package game

import (
	"errors"
	"fmt"
	"sort"
	"sync"
)

var (
	ErrUnknownMode        = errors.New("unknown game mode")
	ErrDuplicateMode      = errors.New("game mode is already registered")
	ErrInvalidModeFactory = errors.New("game mode factory returned invalid metadata")
)

// GameMode is the only rules contract understood by Game. A mode owns board
// initialization, legal-move calculation, move application, and win conditions.
// Implement this interface and self-register a factory to add a complete mode.
type GameMode interface {
	Definition() ModeDefinition
	Initialize(state *GameState)
	ValidMoves(state GameState, player PlayerColor, from Position) []Position
	Move(state *GameState, player PlayerColor, from, to Position) error
}

type ModeFactory func() GameMode

type ModeRegistry struct {
	mu        sync.RWMutex
	factories map[ModeID]ModeFactory
}

func NewModeRegistry() *ModeRegistry {
	return &ModeRegistry{factories: make(map[ModeID]ModeFactory)}
}

func (registry *ModeRegistry) Register(factory ModeFactory) error {
	if factory == nil {
		return ErrInvalidModeFactory
	}
	mode := factory()
	if mode == nil {
		return ErrInvalidModeFactory
	}
	definition := mode.Definition()
	if definition.ID == "" || definition.Name == "" {
		return ErrInvalidModeFactory
	}
	if err := definition.StartingPosition.Validate(); err != nil {
		return fmt.Errorf("%w: %s: %v", ErrInvalidModeFactory, definition.ID, err)
	}

	registry.mu.Lock()
	defer registry.mu.Unlock()
	modeID := definition.ID
	if _, exists := registry.factories[modeID]; exists {
		return fmt.Errorf("%w: %s", ErrDuplicateMode, modeID)
	}
	registry.factories[modeID] = factory
	return nil
}

func (registry *ModeRegistry) MustRegister(factory ModeFactory) {
	if err := registry.Register(factory); err != nil {
		panic(err)
	}
}

func (registry *ModeRegistry) New(modeID ModeID) (GameMode, error) {
	registry.mu.RLock()
	factory, exists := registry.factories[modeID]
	registry.mu.RUnlock()
	if !exists {
		return nil, fmt.Errorf("%w: %s", ErrUnknownMode, modeID)
	}
	return factory(), nil
}

func (registry *ModeRegistry) Has(modeID ModeID) bool {
	registry.mu.RLock()
	_, exists := registry.factories[modeID]
	registry.mu.RUnlock()
	return exists
}

// Playable reports whether a registered mode still accepts new games.
// Matchmaking, challenges, and tournaments all gate on this, so retiring a
// mode is a one-line change to its definition.
func (registry *ModeRegistry) Playable(modeID ModeID) bool {
	registry.mu.RLock()
	factory, exists := registry.factories[modeID]
	registry.mu.RUnlock()
	return exists && factory().Definition().Playable
}

func (registry *ModeRegistry) Definitions() []ModeDefinition {
	registry.mu.RLock()
	definitions := make([]ModeDefinition, 0, len(registry.factories))
	for _, factory := range registry.factories {
		definitions = append(definitions, factory().Definition())
	}
	registry.mu.RUnlock()
	sort.Slice(definitions, func(i, j int) bool {
		if definitions[i].DisplayOrder == definitions[j].DisplayOrder {
			return definitions[i].ID < definitions[j].ID
		}
		return definitions[i].DisplayOrder < definitions[j].DisplayOrder
	})
	return definitions
}

func (registry *ModeRegistry) IDs() []ModeID {
	definitions := registry.Definitions()
	ids := make([]ModeID, len(definitions))
	for index, definition := range definitions {
		ids[index] = definition.ID
	}
	return ids
}

var DefaultModeRegistry = NewModeRegistry()
