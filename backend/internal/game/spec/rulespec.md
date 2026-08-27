# RuleSpec: a game mode as data

A **RuleSpec** is one JSON document that completely describes a game mode: the
board, the pieces, how they move, what happens when they meet, and how somebody
wins. It is what the RPS Lab edits, what gets published to the mode library, and
what travels inside every game so a player who has never heard of your mode can
still play it.

Three rules define the format, and everything else follows from them:

1. **It is data, never code.** The server decides what is legal in a real game,
   and the server cannot run your JavaScript. So a rule is a shape, not a
   function — which is also why a mode a stranger wrote is safe to play.
2. **It is finite.** Every list has a cap, every question is a bounded look at
   the board, and nothing recurses forever. The cost of a position is bounded
   before anybody plays it.
3. **It is open by combination.** Every slot is a list, and almost every entry
   can carry a `when`. New kinds of game come from new *combinations* far more
   often than from new fields. If you are looking for a field that does not
   exist, try composing two that do.

Two interpreters read this format and must agree exactly:
`frontend/src/engine/spec/interpret.ts` and `backend/internal/game/spec`. A
shared corpus of positions pins them together, and either one disagreeing is a
failing test in two languages.

## A whole mode

This is Total War, the game this project shipped first, written out completely.
Nothing in it is optional except the comments.

```jsonc
{
  "spec": 1,
  "name": "Total War",
  "shortCode": "V5",
  "description": "Pieces and territory.",
  "objective": "Annihilate the enemy or control most territory when the board is filled.",

  "board": { "width": 9, "height": 9 },

  "pieces": [
    { "id": "Rock",     "name": "Rock",     "symbol": "R", "art": "rock" },
    { "id": "Paper",    "name": "Paper",    "symbol": "P", "art": "paper" },
    { "id": "Scissors", "name": "Scissors", "symbol": "S", "art": "scissors" }
  ],
  "beats": [["Rock", "Scissors"], ["Scissors", "Paper"], ["Paper", "Rock"]],

  "startingPosition": { "rows": [
    "...SSS...", "...PPP...", "...RRR...",
    ".........", ".........", ".........",
    "...rrr...", "...ppp...", "...sss..."
  ]},

  "movement": [{ "kind": "step", "dirs": "all8", "distance": 1 }],
  "capture":  { "mode": "beats" },

  "effects": [{ "on": "move", "do": [{ "claimTerritory": "mover" }] }],

  "win": [
    { "id": "annihilation",
      "when": { "eq": [{ "count": { "owner": "opponent" } }, 0] },
      "result": "mover", "reason": "annihilation" },
    { "id": "territory",
      "when": { "eq": [{ "count": { "territory": "neutral" } }, 0] },
      "result": { "moreOf": { "red":  { "count": { "territory": "red" } },
                              "blue": { "count": { "territory": "blue" } } } },
      "reason": "territory" }
  ]
}
```

Infiltration, the other shipped mode, is the same document with the `effects`
removed and one win condition instead of two:

```jsonc
"win": [
  { "id": "infiltration",
    "when": { "in": ["to", { "home": "opponent" }] },
    "result": "mover", "reason": "infiltration" }
]
```

Note what Infiltration does **not** say. It has no annihilation rule, so losing
your last piece is not a loss — it leaves you with no legal move, which the
engine calls a stalemate draw. That is a real rule of the mode, expressed by
leaving something out.

## What you get for free

Three rules apply to every mode and are not yours to write:

- **Stalemate is a draw.** A player to move with no legal move draws. The engine
  asks *your* movement rules, so custom movement, blocking and immobile pieces
  are all covered. This is why a mode needs no annihilation rule to handle a
  wiped-out army.
- **Threefold repetition is a draw.** The same board, territory and side to move,
  three times.
- **Clocks, resignation, draw offers and time extensions.** Nothing about them
  belongs in a spec.

**You cannot turn those first two off.** They belong to the engine and apply to
every mode identically, so a spec that claimed to change them would be making a
promise the authoritative server could not keep — and the validator refuses one
that tries.

`draw` states the one rule that *is* yours, a cap on how long a game may run:

```jsonc
"draw": { "moveLimit": 200 }
```

It depends only on the move number, which is why every reader can honour it. Use
it for a mode whose win condition might never fire.

## The board

```jsonc
"board": { "width": 11, "height": 7, "art": "img:<digest>" }
```

Any rectangle from 3 to 26 a side, up to 361 tiles. Files are letters `a`
onwards, left to right. Ranks are numbers from 1 upwards, starting at **Blue's
home boundary** — so on a 9×9 board Blue starts on rank 1 and Red on rank 9, and
`a1` is the corner of Blue's home.

`startingPosition.rows` has to be exactly this shape, one string per rank from
rank 1 up. Each character is a piece's `symbol` — upper case for Blue, lower case
for Red — or `.` for empty. Territory follows the pieces at setup, so a piece
standing on a square owns it before anybody moves.

**Red moves first.**

`art` is optional and paints a picture under the whole board. The squares stay
visible over it — the chequer goes translucent rather than away, because a board
nobody can read is not a board anybody can play on. See **Pictures**.

## Pieces and captures

```jsonc
"pieces": [
  { "id": "Lizard", "name": "Lizard", "symbol": "L" }
]
```

`id` is what the rest of the spec refers to, and it is **also the value that
appears on a tile** — one name per piece, so a rule about a Lizard and the square
a Lizard is standing on use the same word. That is why the standard kinds are
`Rock`, `Paper` and `Scissors`: those are the names every board and record in
this project has always carried. `Empty` is reserved, because it is what a square
with nothing on it says.

`symbol` is one upper-case letter, unique in the mode, and it is how the piece is
written in a layout and in the archive. `art` is optional: it names bundled
artwork (`rock`, `paper`, `scissors`) or a picture you uploaded (see
**Pictures**). A piece with neither is drawn as a disc carrying its initial, so
you can invent a piece without drawing one.

`beats` is a directed graph of `[attacker, defender]` pairs — *not* a cycle. The
standard game is a three-cycle, but nothing requires that:
Rock-Paper-Scissors-Lizard-Spock is ten pairs, a one-sided matchup is one pair,
`["Pawn", "Pawn"]` is a kind that takes its own kind the way a chess pawn does,
and a piece nothing captures is a piece that is simply never taken. The validator
warns about the last one, because it usually makes an annihilation win
unreachable.

`capture.mode` decides how contact resolves at all:

| mode | meaning |
| --- | --- |
| `beats` | the graph decides. The default, and the standard game. |
| `always` | anything takes anything, like chess. |
| `never` | nothing is ever captured; win some other way. |
| `mutual` | both pieces are removed, unless the graph says otherwise. |

## Movement

`movement` is a **list, and a piece's moves are the union of every rule that
applies to it.** Two rules for the same piece give it both. Omit `piece` and a
rule applies to every kind.

```jsonc
"movement": [
  { "kind": "step", "dirs": "all8", "distance": 1 },
  { "kind": "jumpOver", "dirs": "all8", "captureJumped": true, "piece": "Rock" }
]
```

| kind | what it does |
| --- | --- |
| `step` | a fixed `distance` in a direction (default 1), ignoring what is between. `distance: 1` is the standard king step. |
| `slide` | any distance up to `maxDistance`, **stopped by the first occupied square**. A rook or a bishop. |
| `leap` | straight to an offset, whatever stands between. A knight. |
| `jumpOver` | over the adjacent piece to the square beyond, optionally taking what was jumped. The checkers move. |

`dirs` is a named set or an explicit list of offsets:

`all8`, `orthogonal`, `diagonal`, `sideways`, and — **relative to the mover**, so
one rule serves both sides — `forward`, `forwardDiagonal`, `backward`. Anything
else is `{ "offsets": [[1, 2], [2, 1]] }`, which is how a knight or a one-way
piece is written.

Offsets are in **the mover's own frame**: `+y` is forward, away from your own
home. So `[[0, 1]]` is a piece that only advances, for both sides, rather than a
piece that only moves up the screen. A symmetric set — a knight's eight — reads
the same either way.

Three more fields on any rule:

- `targets`: `"empty"`, `"enemy"`, or `"any"` (the default). A pawn's quiet move
  is `targets: "empty"`.
- `when`: a condition (below), asked **before** the move with both `from` and
  `to` known. The rule only applies when it holds — which is how a
  first-move-only double step is written. (Everywhere else — effects, win
  conditions — a condition is asked *after* the move. Movement is the exception
  because the move has not happened yet.)
- `mustCapture`: when any move satisfying this rule exists, *only* moves like it
  are legal. Checkers' forced capture.

## Conditions

A condition is a yes-or-no question about the position **after** the move, and it
is the same little language everywhere: on a movement rule's `when`, on an
effect's `when`, and on a win condition's `when`.

Combine them with `{ "and": [...] }`, `{ "or": [...] }`, `{ "not": ... }`.

Compare numbers with `eq`, `lt`, `lte`, `gt`, `gte`, each taking a pair:

```jsonc
{ "gt": [{ "count": { "owner": "mover", "piece": "Rock" } }, 2] }
```

The numbers you can compare are:

| term | is |
| --- | --- |
| `7` | itself |
| `{ "count": <filter> }` | how many tiles match |
| `{ "row": "to" }` / `{ "column": "to" }` | a coordinate of the move just played (or `"from"`) |
| `{ "moveNumber": true }` | how many moves have been played |
| `{ "share": "red" }` | a side's territory as a fraction from 0 to 1 |

And the questions that are not comparisons:

| condition | holds when |
| --- | --- |
| `{ "in": ["to", <region>] }` | the move landed inside a region |
| `{ "captured": true }` | the move took something |
| `{ "moved": "Rock" }` | the piece that moved is one of these kinds |
| `{ "any": { "tiles": <filter>, "where": <condition> } }` | some matching tile satisfies it |
| `{ "all": { "tiles": <filter>, "where": <condition> } }` | every matching tile does |

A **filter** picks tiles: `region`, `owner`, `piece`, `territory`, `empty`. Every
field is optional and they combine, so `{ "owner": "opponent", "piece": "Rock" }`
is "enemy pieces of that kind" and `{ "territory": "neutral" }` is "unclaimed
ground".

A **region** is a set of squares, and exactly one of:

`{ "rows": [0] }`, `{ "columns": [4] }`, `{ "squares": [[4, 4]] }`,
`{ "rect": { "x": 3, "y": 3, "width": 3, "height": 3 } }`,
`{ "home": "opponent" }`, `{ "corners": true }`, `{ "edge": true }`,
`{ "all": true }`, `{ "destination": true }`, `{ "origin": true }`.

`home` is the rank a side starts behind — `mover`, `opponent`, `red`, `blue` — so
"reach the far side" is one region rather than two rules with a board size
hard-coded in them. **Prefer `{ "home": "opponent" }` to `{ "rows": [0] }`**: the
first is right on any board and for either side.

Every side reference (`owner`, `territory`, `share`, `home`, effect targets) takes
`mover`, `opponent`, `red`, `blue`, `neutral` or `any`. `mover` and `opponent` are
relative to whoever just moved, which is what lets one rule serve both players.

## Effects

An effect is something a move does to the board beyond moving the piece. This is
usually where a mode's character lives — territory is the whole of what makes
Total War a different game from Infiltration.

```jsonc
"effects": [
  { "on": "move", "do": [{ "claimTerritory": "mover" }] },
  { "on": "capture", "when": { "moved": "Rock" }, "do": [{ "extraTurn": true }] }
]
```

`on` is `move` (every move), `capture` (only when something was taken), or
`turnEnd`. `when` narrows it further.

| effect | does |
| --- | --- |
| `{ "claimTerritory": "mover" }` | claims the square just landed on, **if nobody owns it yet** |
| `{ "setTerritory": { "tiles": <filter>, "to": "mover" } }` | sets ownership outright — this is how you *take* ground somebody holds |
| `{ "promote": { "to": "queen" } }` | turns the piece that moved into another kind |
| `{ "remove": { "tiles": <filter> } }` | takes pieces off the board |
| `{ "spawn": { "piece": "Rock", "owner": "mover", "at": <region> } }` | puts a new piece down |
| `{ "extraTurn": true }` | the mover goes again instead of passing the turn |

## Winning

`win` is checked in order after every move, and **the first condition that holds
ends the game**. Order is the tie-break, and it matters: Total War checks
annihilation before territory, so a move that takes the last enemy piece *and*
fills the last square is a win, not a count.

```jsonc
{ "id": "centre", "when": { "in": ["to", { "squares": [[4, 4]] }] },
  "result": "mover", "reason": "game_rule" }
```

`result` is `mover`, `opponent`, `draw`, or a comparison:

```jsonc
"result": { "moreOf": { "red": { "count": { "territory": "red" } },
                        "blue": { "count": { "territory": "blue" } } } }
```

`moreOf` hands the game to whichever side's number is larger, and calls it a draw
when they are level. Any "most X wins" rule is written with it, so majority
conditions need no special case.

`id` is optional and worth setting: the Lab's playtester reports which win
conditions never fired across a run of games, and it reports them by `id`.
`reason` is what a stored record says the game ended by, and shows up in the game
list.

## Turns

```jsonc
"turn": { "movesPerTurn": 1, "mayPass": false }
```

Both default to what you would expect. `movesPerTurn` above 1 gives a side
several moves before the turn passes.

## Pictures

A mode can carry pictures: one per piece kind, one under the board, and one for
the card the library lists it on.

```jsonc
"pieces": [{ "id": "Lizard", "name": "Lizard", "symbol": "L", "art": "img:<digest>" }],
"board":  { "width": 9, "height": 9, "art": "img:<digest>" },
"cover":  "img:<digest>"
```

Upload one with `lab_upload_art` and it answers with an id. **Only the id is in
the document**, which is the thing worth knowing: a picture does not count
against the 16 KiB a spec is capped at, so a mode can be fully illustrated and
still be mostly rules.

The id is the first 128 bits of the picture's own SHA-256, so it never means a
different picture than it did the day it was written — the same property a
published mode has, arrived at the same way. Uploading the same picture twice
gives you the same id back.

**One drawing per piece kind, not two.** It is painted inside a ring in the
side's colour, so the same drawing serves Red and Blue and you do not have to
draw a piece twice to say whose it is.

**A picture that is missing costs the picture and nothing else.** A build that
does not recognise a reference, a picture that has been taken down, a network
that is not there: the piece draws its letter, the board draws plain, the
library card shows the opening position. A mode never stops being playable over
a picture.

### The format

Square PNGs for pieces, because a piece is drawn over its ring and needs
transparency. PNG or JPEG for the board and the cover.

| | shape | at most | at most |
| --- | --- | --- | --- |
| a piece | square | 512×512 | 256 KiB |
| the board | any | 1024×1024 | 512 KiB |
| the cover | any | 1200×1200 | 512 KiB |

Nothing is scaled up, and nothing that is not a PNG or a JPEG is accepted — no
SVG, no animation. The server decodes what arrives and re-encodes it before
storing it, so what it serves is always a plain image of the size you sent, with
no metadata riding along. One consequence worth stating: a photograph taken on a
phone loses its EXIF orientation, so a portrait picture is stored the way its
pixels are laid out rather than the way the phone meant them to be shown.

Uploading needs a registered account. Publishing a mode does not — that is
deliberately open to a guest — but a picture is the one thing the Lab makes that
this server hosts and serves to strangers, so there has to be somebody behind it.

## Reusable parts

A **part** is a published, parameterised fragment of one slot — the unit of
reuse. Somebody writes `jump` once and every later mode can have it:

```jsonc
{ "part": 1, "id": "jump", "version": 1, "author": "henry", "kind": "movement",
  "name": "Jump",
  "summary": "Leap the adjacent piece and land beyond it.",
  "params": { "captureJumped": { "type": "boolean", "default": true } },
  "body": { "kind": "jumpOver", "dirs": "all8", "captureJumped": "$captureJumped" } }
```

Refer to one anywhere its slot's own entry could go:

```jsonc
"movement": [
  { "kind": "step", "dirs": "all8", "distance": 1 },
  { "use": "jump@1", "piece": "Rock", "with": { "captureJumped": true } }
]
```

**At publish time a reference is resolved and the body is inlined**, with
`derivedFrom` recording where it came from. So a published mode is
self-contained: it never changes under you because the part's author edited
theirs, and playing it needs no lookup — which is what lets the whole spec ride
inside a game and reach somebody who has never heard of the mode. The library
still shows the provenance, and credits the author.

You can go the other way too: lift a fragment of what you have built into a new
part, and the next author gets it.

## Limits

The caps are the same in the browser and on the server, so a spec the Lab accepts
is a spec that can be published.

| | at most |
| --- | --- |
| board | 26 a side, 361 tiles |
| pieces | 12 kinds |
| `beats` pairs | 64 |
| `movement` rules | 24 |
| `effects` rules | 24 |
| `win` conditions | 16 |
| condition nesting | 12 deep |
| offsets in one rule | 32 |
| name / description / objective | 400 characters each |
| pictures in one mode | 14 — every piece, the board, the cover |
| the whole document | 16 KiB of JSON |

A picture is referred to by id and stored elsewhere, so it costs the document
about twenty bytes and nothing else. See **Pictures** for what a picture itself
may be.

## Two things a spec cannot do

Worth knowing before you design around them.

**RPSFish will not play your mode.** The engine is nine by nine to its
foundations, and its search prunes on proofs that hold only for the
rock-paper-scissors three-cycle. Custom modes get a general search over this
format instead — strong enough to test a mode with, weaker than RPSFish.

**Custom modes have no opening book.** The book is an engine artifact, so there is
nothing to name openings in.
