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

A custom game may switch those rules without a mode knowing about it.
`game.RuleFlags` travels with the `GameSetup` a game was created from and is
enforced by `Game`, not by any mode: `NoRepetitionDraw` removes rule 1, and
`NoDrawOffers` / `NoTimeExtensions` refuse the two mutual agreements. Every
field is a deviation, so the zero value is the standard game and a mode that
never mentions rule flags gets them right.

Because stalemate is a draw, a mode does not need an annihilation rule to
handle a wiped-out army: a player with no pieces has no legal move, so the game
ends in a draw rather than hanging. Infiltration relies on exactly this — it has
no annihilation win condition, so losing every piece is a stalemate draw, not a
loss. A mode that wants a wipeout to be a *loss* must say so in its own `Move`,
as Total War does.

The engine, WebSocket layer, matchmaking queue, and lobby do not contain mode-specific switch statements. A mode is one Go type implementing `GameMode` in a self-registering file.

**Or it is data.** A mode written by somebody who does not have commit access is a
`RuleSpec` — one JSON document describing the board, the pieces, the movement, the
effects and the win conditions — interpreted by `SpecMode`, which is itself just
another `GameMode`. `docs/rulespec.md` at the repository root is the format's
reference, and `internal/game/spec/builtin.go` holds Total War and Infiltration
written in it, which is what a differential test uses to prove the interpreter
agrees with the hand-written modes below. Write a Go type when a mode needs
something the format cannot say; write a spec otherwise.

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

`ValidMoves` receives a `GameState` whose `Grid` is a copy, so a mode cannot
change the live board by being asked a question. `Move` receives the real one,
because changing it is the job. Both are `game.Grid`, a slice rather than a fixed
array — see the note at the top of `internal/game/board.go`, and use
`Grid.Contains` for bounds rather than comparing against `BoardSize`.

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

## Board shape

A mode is played on a rectangle, not necessarily on nine by nine. The shape comes
from the mode's own `StartingPosition` — the number of rows is the height and
their common length is the width — so a mode changes its board by being written
with a different layout, and nothing else has to be told. `game.ValidateBoardSize`
is the bound: at least 3 a side, at most 26 (one letter per file, `a` to `z`), and
at most 361 tiles.

Two things follow that a mode author should know. Squares are named for the board
they are on, so a tall board really has a rank `10` and `d10` is an ordinary
square in a record. And a **custom starting position must be the mode's own
shape** (`GameSetup.ValidateFor`): a position somebody drew is a different
arrangement of the same squares, because a mode's rules talk about *its* board —
"reach the far rank" means something else on a board of another size.

Two things are deliberately still nine by nine. **RPSFish** searches only the
built-in modes: its boards are `u128` bitmaps over eighty-one squares and its
pruning rests on the rock-paper-scissors three-cycle, so it refuses a mode it
does not know rather than encoding onto the wrong board. And the **opening book**
is an engine artifact in a five-character notation (`d8-c7`, files `a` to `i`),
so a mode the notation cannot spell has no book and no mirror rule — see
`openingBoardFor`.

## Starting positions

Every mode advertises and initializes from one `StartingPosition`. The layout is
written as one string per rank, all the same length, from Blue's side of the
board to Red's:

- `R`, `P`, `S` are Blue pieces.
- `r`, `p`, `s` are Red pieces.
- `.` is an empty tile.

`MustStartingPosition` validates the shape, the row widths, and every symbol when
the server starts. Built-in layouts are grouped in
`internal/game/starting_position.go`, so a mode's complete opening formation — and
its board — can be changed by editing its visual rows.

The Go type stores those rows as one `/`-joined string. That is not a detail to
work around: `GameSetup` is compared with `==` and that comparison *is* the
matchmaking pairing rule, so every field reachable from it has to be comparable.
Read the rows back with `Rows()`; the JSON on the wire is still `{"rows": [...]}`.
The mode catalog includes the same layout under `startingPosition.rows`; the
frontend uses it for the lobby preview, keeping the preview and live setup in sync.

That file is sufficient for the mode to appear in `GET /api/modes`, the WebSocket `connection_ready` catalog, and the frontend lobby. Matchmaking pairs two people whose whole `GameSetup` matches — the mode among the rest of it — so a new mode's players only ever meet each other.

`standardRPSRules` is optional composition. A mode can implement unrelated setup
and movement directly, as demonstrated by the test-only teleport mode in
`internal/game/mode_test.go`.

Ratings are per mode, so a new mode arrives with its own rating pool and needs no rating code of its own. The first ranked game an account finishes in the mode creates its rating row from that account's shared starting rating, and ranked matchmaking then compares only ratings earned in that mode.
