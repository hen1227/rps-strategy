# Adding a game mode

All modes inherit two automatic draw rules from the engine, and a new mode gets
both without writing any code:

1. **Repetition.** A game ends in a draw when the same board position,
   including territory ownership and the side to move, occurs for the third
   time.
2. **Stalemate.** A game ends in a draw when the player to move has no legal
   move. `Game` decides this by asking the active mode for its own legal moves,
   so a mode with custom movement, blocking, or immobile pieces is covered
   automatically. The resulting `endReason` is `stalemate` and the winner is
   `Neutral`.

Because stalemate is a draw, a mode does not need an annihilation rule to
handle a wiped-out army: a player with no pieces has no legal move, so the game
ends in a draw rather than hanging. Infiltration relies on exactly this — it has
no annihilation win condition, so losing every piece is a stalemate draw, not a
loss. A mode that wants a wipeout to be a *loss* must say so in its own `Move`,
as Annihilation and Total War do.

The engine, WebSocket layer, matchmaking queue, and lobby do not contain mode-specific switch statements. A mode is one Go type implementing `GameMode` in a self-registering file.

## Contract

```go
type GameMode interface {
    Definition() ModeDefinition
    Initialize(state *GameState)
    ValidMoves(state GameState, player PlayerColor, from Position) []Position
    Move(state *GameState, player PlayerColor, from, to Position) error
}
```

`Move` owns validation, mutation, turn progression, and win evaluation. `ValidMoves` is sent to the requesting frontend client, so custom movement does not need to be reimplemented in JavaScript.

## Minimal mode file

```go
package game

type CenterRushMode struct {
    rules standardRPSRules
}

var centerRushStartingPosition = MustStartingPosition(
    "R..P.S..R",
    ".........",
    ".........",
    ".........",
    ".........",
    ".........",
    ".........",
    ".........",
    "r..s.p..r",
)

func (mode *CenterRushMode) Definition() ModeDefinition {
    return ModeDefinition{
        ID:               "center-rush",
        ShortCode:        "CR",
        Name:             "Center Rush",
        Description:      "Take the center to win.",
        Objective:        "Move any piece onto tile 4,4.",
        DisplayOrder:     10,
        Features:         []ModeFeature{},
        StartingPosition: centerRushStartingPosition,
    }
}

func (mode *CenterRushMode) Initialize(state *GameState) {
    mode.rules.initializeBoard(state, centerRushStartingPosition)
}

func (mode *CenterRushMode) ValidMoves(
    state GameState,
    player PlayerColor,
    from Position,
) []Position {
    return mode.rules.validMoves(state, player, from)
}

func (mode *CenterRushMode) Move(
    state *GameState,
    player PlayerColor,
    from Position,
    to Position,
) error {
    if err := mode.rules.movePiece(state, player, from, to); err != nil {
        return err
    }
    if to == (Position{X: 4, Y: 4}) {
        mode.rules.finish(state, player, EndReasonGameRule)
    } else {
        mode.rules.passTurn(state, player)
    }
    return nil
}

func init() {
    DefaultModeRegistry.MustRegister(func() GameMode { return &CenterRushMode{} })
}
```

## Starting positions

Every mode advertises and initializes from one `StartingPosition`. The layout is
written as nine strings of nine symbols, from Blue's side of the board to Red's:

- `R`, `P`, `S` are Blue pieces.
- `r`, `p`, `s` are Red pieces.
- `.` is an empty tile.

`MustStartingPosition` validates the row count, row width, and every symbol when
the server starts. Built-in layouts are grouped in
`internal/game/starting_position.go`, so a mode's complete opening formation can
be changed by editing its nine visual rows.
The mode catalog includes the same layout under `startingPosition.rows`; the
frontend uses it for the lobby preview, keeping the preview and live setup in sync.

That file is sufficient for the mode to appear in `GET /api/modes`, the WebSocket `connection_ready` catalog, and the frontend lobby. Matchmaking pairs only guests queued under the same `ModeDefinition.ID`.

`standardRPSRules` is optional composition. A mode can implement unrelated setup
and movement directly, as demonstrated by the test-only teleport mode in
`internal/game/mode_test.go`.

Guest matchmaking is currently unranked. The server reports a temporary ±10,000 compatibility range but does not read, calculate, or persist Elo until accounts exist.
