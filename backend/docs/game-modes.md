# Adding a game mode

All modes inherit two automatic endings from the engine, and a new mode gets
both without writing any code:

1. **No capture.** A game ends in a draw after `game.QuietPlyLimit` plies — two
   hundred, which is a hundred moves from each side — with nothing taken. The `endReason` is
   `no_capture`. A capture is the only thing that restarts the count; claiming
   territory does not, because that is progress Total War already ends the game
   on when the board fills.
2. **Stalemate.** A game ends when the player to move has no legal move.
   `Game` decides this by asking the active mode for its own legal moves, so a
   mode with custom movement, blocking, or immobile pieces is covered
   automatically. The `endReason` is `stalemate` and the winner is `Neutral`.

Rule 1 is what bounds a game's length, and it is adjudicated last of everything
— after the mode's own win conditions and after rule 2 — because it is the
weakest claim any ending makes. A move that wins or blockades has said something
about the position, and "nothing has been taken for a while" must not overrule
it. Without that ordering the hundredth quiet move would turn a blockade, which
wins in a mode where being stuck loses, into half a point.

**There is no repetition draw.** Repeating a position three times is play in
every mode. The rule is not deleted — it is switched off at
`game.RepetitionDrawEnabled`, with `FeatureNoRepetitionDraw` and
`RuleFlags.NoRepetitionDraw` still underneath it and still tested — because it
has been on and off before and the argument has two real sides: a repeated
position is a claim to half a point in a game decided by what is left on the
board, and a defensive resource in a race for one tile. What settles it for now
is that neither reading has to bound a game's length any more. Rule 1 does that
in every mode, and unlike repetition it cannot be shuffled around by an army
with room to wander. `EndReasonRepetition` stays because archived games carry
it.

A mode may change what rule 2 is worth by declaring a feature on its
`ModeDefinition`:

- `FeatureStalemateLoses` makes rule 2 a loss for the side that cannot move.

Intransitive declares it and no other built-in mode does. Features travel to the
client inside the mode catalogue, so the browser's copy of the rules — which
replays archived games and walks bot battles — follows the same answers without a
second list to keep in step.

A custom game may also switch a rule off without a mode knowing about it.
`game.RuleFlags` travels with the `GameSetup` a game was created from and is
enforced by `Game`, not by any mode: `NoDrawOffers` / `NoTimeExtensions` refuse
the two mutual agreements, and `NoRepetitionDraw` removes a rule nothing has at
the moment. Every field is a deviation, so the zero value is the standard game
and a mode that never mentions rule flags gets them right. A flag can only take
a rule away, so it cannot put a repetition draw back into a mode that has none —
and it cannot lift rule 1, which has no flag at all.

Where stalemate is a draw, a mode does not need an annihilation rule to handle
a wiped-out army: a player with no pieces has no legal move, so the game ends
in a draw rather than hanging. Infiltration relies on exactly this — it has no
annihilation win condition, so losing every piece is a stalemate draw. In
Intransitive the same position is a loss, from the same absence of an
annihilation rule plus `FeatureStalemateLoses`. A mode that wants a wipeout to
be a loss for its own reasons must say so in its own `Move`, as Total War does.

The side that opens is `game.FirstToMove`, and it is Blue. Rank 1 — row 0 of a
starting position — is Blue's home boundary, and the board is drawn from that
edge, so the first row of a layout is the one nearest the side that moves
first.

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
modes it has been taught: its boards are `u128` bitmaps over eighty-one squares
and its pruning rests on the rock-paper-scissors three-cycle, so it refuses a
mode it does not know rather than encoding onto the wrong board. Being built in
is not enough — the list is `ENGINE_MODE_CODES` in
`frontend/src/engine/rpsfish/protocol.ts` and `Mode` in `RPSFish/src/model.rs`,
and both have to learn a mode together. Intransitive was the worked example of
a mode that was built in and not searched, and it has since been taught: a goal
is now a *shape* the rule table declares (`ModeRules::goal`), so a rank and a
corner are two values of one field rather than two branches. The public engine
is still withheld from the mode in the browser — see `engineUnavailableMessage`
in that same file — but that is a tournament embargo rather than a limit of the
engine.

And the **opening book** is an engine artifact in a five-character notation
(`d2-c3`, files `a` to `i`), so a mode the notation cannot spell has no book at
all — see `openingBoardFor`.

A mode also loses the book's **mirror rule** if its layout is not symmetric
across the files. `d2-c3` and `f2-g3` are the same opening seen twice only when
reversing the files leaves the opening position unchanged, which `MirrorsFiles`
is the single test for. Intransitive is the first built-in mode that fails it on
purpose: its two goal corners are different places, so its lines are not folded
onto their mirrors.

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
