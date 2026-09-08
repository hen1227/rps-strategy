# RPSI: the engine protocol

RPSI is how a Rock–Paper–Scissors Strategy engine talks to whatever drives it. An engine
reads commands on standard input and writes answers to standard output, one per line. It
holds no socket, no account, and no opinion about whether it is playing a ranked game, a
tournament, or nothing at all.

The shape is Universal Chess Interface, deliberately, down to the spelling of `isready` and
`setoption`. If you have written a UCI engine you already know this protocol, so only the
differences below are worth reading.

Three rules define the relationship:

1. **The host owns the game** — the rules, both clocks, the move history, the archive, and
   the decision that a game is over. An engine that disagrees is wrong.
2. **The engine is close to a pure function.** Given a position and a budget, produce a
   move. The host re-sends the full position every time, so nothing you remember between
   commands may be load-bearing.
3. **Every line is complete on its own.** No continuations, no binary, no framing — a human
   can drive an engine by typing at it, and frequently should.

One process plays one game at a time, always. A host running several games against the same
engine runs a separate copy per game, so an engine needs no locking, no per-game state, and
no awareness that any of this is happening.

## A whole conversation

`>` is what the host sends, `<` what the engine answers; neither character is on the wire.

```text
> rpsi
< id name Example 0.1.0
< id author you
< protocol 1
< rules 2
< option name Hash type spin default 16 min 1 max 4096
< mode V3 Infiltration
< mode V5 Total War
< mode V6 Intransitive
< rpsiok
> setoption name Hash value 128
> isready
< readyok
> newgame V5
> isready
< readyok
> position fen 3SSS3/3PPP3/3RRR3/9/9/9/3rrr3/3ppp3/3sss3 b 3bbb3/3bbb3/3bbb3/9/9/9/3rrr3/3rrr3/3rrr3 moves d3-d4 d7-d6
> legalmoves d4-c5 d4-d5 d4-e5 e3-e4 e3-f4 f3-f4 f3-g4 d2-d3 e2-e3 f2-f3
> go rtime 300000 btime 298400 rinc 3000 binc 3000
< info depth 8 seldepth 14 multipv 1 score cp 137 confidence 82 nodes 1204551 nps 1830000 time 658 pv f3-f4 f7-f6 e3xf4
< bestmove f3-f4
> quit
```

Only the `info` lines and the `setoption` are optional. An engine that answers `rpsi`,
`isready`, `position` and `go`, and ignores what it does not recognise, conforms.

## Squares, moves and positions

Files `a`–`i`, ranks `1`–`9` running from Blue's home boundary at `1` to Red's at `9`, so
`a1` is the corner of Blue's home rank. These are the archive's coordinates, untransformed.

A move is the square left, a separator, and the square entered: `d3-d4`, or `d3xd4` when
the destination is occupied. **Accept either separator and read nothing into it** — whether
a move captures is a fact about the position, not about the move. A leading piece letter
(`Rd3xd4`) is accepted too, which makes an RPSI move a PGN move minus the piece. A move
echoed back verbatim from `legalmoves` is always spelled acceptably.

A position is three space-separated fields — pieces, side to move, territory:

```text
3SSS3/3PPP3/3RRR3/9/9/9/3rrr3/3ppp3/3sss3 b 3bbb3/3bbb3/3bbb3/9/9/9/3rrr3/3rrr3/3rrr3
```

Rows run rank 1 to rank 9 separated by `/`, digits count consecutive empty tiles, uppercase
is Blue and lowercase is Red. The side to move is `r`, `b` or `-`; it is `b` in a fresh
position because Blue opens.

The third field is territory ownership, which only Total War (`V5`) uses — a tile can be
owned by a player with no piece standing on it, and that is what decides that mode. The host
always writes the field, so **an engine playing Infiltration or Intransitive can ignore
it**. It is optional on the way in: a position with only pieces and a side to move is read
with ownership following the pieces.

## Host to engine

| Command | Arguments | Meaning |
| --- | --- | --- |
| `rpsi` | — | Identify yourself: `id`, `protocol`, `rules`, `option` and `mode` lines, then `rpsiok`. The host sends nothing else until `rpsiok` arrives. |
| `isready` | — | Answer `readyok` once pending `setoption` work has finished. Legal at any time, including during a search, which must not delay it. |
| `setoption` | `name <id> [value <v>]` | Set one option you declared. Sent before the first `go`, or between games. |
| `newgame` | `<modeId>` | A new game, unrelated to the last. Clear the transposition table, killers and history heuristics. |
| `position` | `fen <pieces> <side> <territory> [moves <m>…]` | The board the game was played from, then every move since, in order. |
| `legalmoves` | `<m>…` | Every legal move for the side to move. Advisory. |
| `go` | see below | Start searching. |
| `stop` | — | Stop as soon as possible and print `bestmove`. |
| `quit` | — | Exit, abandoning any search. |

### The `go` line

```text
go rtime 300000 btime 298400 rinc 3000 binc 3000
```

`<parameter> <value>` pairs in milliseconds. `rtime`/`btime` are what Red and Blue have
left; `rinc`/`binc` are what each gains per move. Both clocks are always sent, because an
engine managing its own time may want to know what its opponent has — `r` and `b` are
colours, not you and your opponent, and you are whichever side the preceding `position`
named to move.

Also optional, in any combination: `movetime <ms>` (search exactly this long, ignoring the
clock), `depth <n>`, `nodes <n>`, `searchmoves <m>…` (only these moves at the root), and
`infinite` (search until `stop`).

There is no `movestogo`: a time control is an allowance plus a per-move increment, so there
is no move count to reach.

## Engine to host

| Line | Meaning |
| --- | --- |
| `id name <text>` | Free text, shown to players. Include a version. |
| `id author <text>` | Free text. |
| `protocol <n>` | The RPSI major version you speak. `1` today. |
| `rules <n>` | The rule set you implement, currently `2`. |
| `option name <id> type <spin\|check\|combo\|string\|button> [default …] [min …] [max …] [var …]` | UCI's option grammar, unchanged. |
| `mode <id> [name]` | One line per mode you can play. |
| `rpsiok` | End of identification. |
| `readyok` | Answer to `isready`. |
| `info …` | Search progress. |
| `bestmove <move>` | Your move. Exactly one per `go`. |
| `shutdown [reason]` | Take me out of play when convenient. See below. |

`protocol` exists so a host can refuse an engine it cannot talk to. A `rules` mismatch is
logged rather than refused: an engine built against an older rule set may still play
correctly in modes that did not change.

Mode ids are `V3` (Infiltration), `V5` (Total War) and `V6` (Intransitive); the trailing
name is for a human reading a log. **An id the host does not recognise is ignored, not
rejected**, so you may declare a mode the host has not shipped yet.

`info` fields appear in this order when present: `depth`, `seldepth`, `multipv`, `score`,
`confidence`, `nodes`, `nps`, `time`, `pv`. `pv` is last, being the only variable-length
one, and its moves are single-space separated.

**Any other line an engine prints must begin with `info string`.** That is what lets a host
forward engine output without deciding what is diagnostic; anything else unrecognised may
be discarded, logged, or treated as a protocol fault.

### `shutdown`

`shutdown`, optionally followed by free text, asks the host to stop giving this engine new
games. It is the only line here that is a request rather than an answer, and the only one an
engine sends unprompted.

```text
< shutdown this machine is being reclaimed in ten minutes
```

Print it at any time — mid-search, between games, or idle. It does not replace a `bestmove`,
and every game already on a board is still to be played out. A host must not read it as
"stop now": the engine is asking to leave the queue, not resigning. One that does not
implement it ignores the line, so an engine may print it unconditionally. **`quit` is
unrelated** — that comes from the host and means exit now.

## Three things that are easy to get wrong

**Score is from the side to move's point of view.** `score cp <n>` is in centi-units,
positive meaning the side to move is better — not Red, not your own colour. A sign error
here is completely silent: the engine plays on, the protocol never complains, and a strong
engine simply looks weak. If a new engine loses for no visible reason, check this first. A
proven result is `score win <plies>` or `score loss <plies>`, counting plies to the end; it
is not called `mate` because there is no mate in this game. `confidence <0-100>` is optional
and reports how stable the result has been across iterations — **it is not a win
probability**.

**There is no `startpos`.** You always get a full FEN. A stored game records the board it
was **actually** played from, and a game can start from a position somebody chose, so an
engine that assumed the standard opening would occasionally and silently analyse a different
game than the one being played.

**The `moves` list is how you count the plies since the last capture.** Two hundred of
them — a hundred moves from each side — is a draw in every mode, and the FEN carries no
counter, so the move list is the only place that number can come from. Past the opening this is the difference between a
draw and a win in both directions: an engine blind to it plays for a win it will not be
allowed to finish, and declines a draw it has already been handed. Replay the moves and
reset your count on any move whose destination held a piece.

**No mode has a repetition draw.** Standing in a position for the third time is play, and
the engine must not score it as half a point. It was a draw once, and in every mode but
Intransitive (`V6`); a host talking to an older engine should expect it to disagree about
exactly those positions. The move list still tells you which positions have occurred, which
is worth knowing for other reasons — a line you have already been down is one you already
know the value of.

## On `legalmoves`

Immediately before every `go`, the host sends every legal move for the side to move. This
is not in UCI. Without it the smallest possible bot would need a FEN parser, a neighbour
table, the capture cycle and each mode's movement rules before making one legal move; with
it, the smallest possible bot is ten lines and picks at random.

The list is authoritative rather than a second opinion — a `bestmove` outside it is
rejected. An engine with its own generator gets a free conformance check by diffing the two
and complaining via `info string`, which is the cheapest warning that the rules have moved.
Otherwise discard it and generate your own; it costs about a kilobyte per move to ignore.

## Time, and errors

Turning a clock into a search budget is the engine's business. Two obligations: return a
`bestmove` before your own clock reaches zero, leaving a margin for the round trip, because
the host will flag you; and always answer a `go`, returning the first legal move rather than
nothing when there is no time to think.

RPSI has no error replies, on purpose. An engine that cannot understand a line should ignore
it, optionally saying so with `info string`, and carry on — an illegal `bestmove`, one that
never arrives, and a crashed process are all detected host-side and resolved without the
engine's help. The one thing an engine must never do is **exit on an unrecognised
command**, because future versions will add them.

## Driving an engine by hand

It is plain text on a pipe, so the fastest way to check an engine is to talk to it:

```bash
printf 'rpsi\nisready\nnewgame V5\nquit\n' | ./your-engine
```

To put an engine on a live server, see [bots.md](bots.md). Nothing here is specific to that:
an engine that satisfies this specification needs no changes to play online.
