package game

import (
	"errors"
	"fmt"
	"sort"
	"sync"
)

// rulesPublished is the day the rules every mode here shares last changed:
// 3 September 2026, when the board's orientation and two win conditions moved
// together. One constant while the three modes' answer is the same one, and a
// literal on the mode that moves next — ModeDefinition.RulesPublished is per
// mode for that reason.
//
// Written down rather than derived from a build date, because it is a fact
// about the rules and not about this binary. A server rebuilt on Tuesday has
// not republished anything.
const rulesPublished = "2026-09-03"

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
	// Shape only: a mode owns the letters its layout is written with, and a
	// spec-defined one may write pieces this package has never heard of. Its own
	// validator has already checked them against its own alphabet.
	if err := definition.StartingPosition.ValidateShape(); err != nil {
		return fmt.Errorf("%w: %s: %v", ErrInvalidModeFactory, definition.ID, err)
	}
	// A symmetry a mode does not have is worse than one it never claimed: the
	// opening statistics fold two positions together on the strength of this,
	// so a wrong declaration merges boards that are genuinely different and
	// nothing downstream can notice. The layout half is checkable here and is
	// checked; see ModeDefinition.Symmetries for the half that is not.
	for _, symmetry := range definition.Symmetries {
		if !symmetry.PreservesLayout(definition.StartingPosition) {
			return fmt.Errorf(
				"%w: %s: starting position is not unchanged by the %q symmetry",
				ErrInvalidModeFactory, definition.ID, symmetry,
			)
		}
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

// CatalogueDefinitions is the modes a lobby lists.
//
// Every registered mode, now that they are all built in. Kept as its own name
// rather than folded into Definitions because the distinction is about what is
// broadcast to every socket on connect, and a mode format that brings back an
// unbounded community set would restore the filter here and nowhere else.
func (registry *ModeRegistry) CatalogueDefinitions() []ModeDefinition {
	return registry.Definitions()
}

// CatalogueIDs is CatalogueDefinitions as ids, for the per-mode counters.
func (registry *ModeRegistry) CatalogueIDs() []ModeID {
	definitions := registry.CatalogueDefinitions()
	ids := make([]ModeID, len(definitions))
	for index, definition := range definitions {
		ids[index] = definition.ID
	}
	return ids
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
