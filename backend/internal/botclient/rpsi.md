# RPSI: the engine protocol

RPSI is how a Rock–Paper–Scissors Strategy engine talks to whatever is driving it. An
engine is a program that reads commands on standard input and writes answers to standard
output, one per line. It holds no socket, no account, and no opinion about whether it is
playing a ranked game, a tournament, or nothing at all.

The shape is Universal Chess Interface, deliberately, down to the spelling of `isready` and
`setoption`. Anyone who has written a UCI engine already knows this protocol; the only new
things are the ones this game actually does differently. Where the two could plausibly
diverge, RPSI matches UCI, and where they cannot, this document says why.

Three rules define the relationship, and everything else follows from them:

1. **The host owns the game.** It holds the rules, both clocks, the repetition history and
   the archive. It decides when a game is over. An engine that disagrees is wrong.
2. **The engine is close to a pure function.** Given a position and a budget, produce a
   move. Nothing it remembers between commands is allowed to be load-bearing, because the
   host re-sends the full position every single time.
3. **Every line is complete on its own.** No continuations, no binary, no framing. A human
   can drive an engine by typing at it, and frequently should.

## A whole conversation

This is a complete session, from launch to first move. `>` is what the host sends and `<`
is what the engine answers; neither character appears on the wire.

```text
> rpsi
< id name RPSFish 0.1.0
< id author Henry Abrahamsen
< protocol 1
< rules 2
< option name Hash type spin default 16 min 1 max 4096
< option name MultiPV type spin default 1 min 1 max 8
< option name Param type string default
< mode V3 Infiltration
< mode V5 Total War
< rpsiok
> setoption name Hash value 128
> isready
< readyok
> newgame V5
> isready
< readyok
> position fen 3SSS3/3PPP3/3RRR3/9/9/9/3rrr3/3ppp3/3sss3 r 3bbb3/3bbb3/3bbb3/9/9/9/3rrr3/3rrr3/3rrr3 moves d7-d6 d3-d4
> legalmoves d6-c5 d6-d5 d6-e5 e7-e6 e7-f6 f7-f6 f7-g6 d8-d7 e8-e7 f8-f7
> go rtime 298400 btime 300000 rinc 3000 binc 3000
< info depth 1 seldepth 3 multipv 1 score cp 12 confidence 40 nodes 812 nps 406000 time 2 pv f7-f6
< info depth 5 seldepth 9 multipv 1 score cp 104 confidence 71 nodes 214880 nps 1610000 time 133 pv f7-f6 f3-f4 e7-e6
< info depth 8 seldepth 14 multipv 1 score cp 137 confidence 82 nodes 1204551 nps 1830000 time 658 pv f7-f6 f3-f4 e7xf6
< bestmove f7-f6
> quit
```

Nothing in that exchange is optional except the `info` lines and the `setoption`. An engine
that answers `rpsi`, `isready`, `position` and `go`, and ignores everything else it does
not recognise, is a conforming engine.

Take apart the `go` line from that session:

```text
go rtime 298400 btime 300000 rinc 3000 binc 3000
```

It is four `<parameter> <value>` pairs, in milliseconds, describing both clocks at once —
not just the side to move's:

| Token | Value | Meaning |
| --- | --- | --- |
| `rtime 298400` | 298 400 ms | Red has 4 minutes 58.4 seconds left on its clock. |
| `btime 300000` | 300 000 ms | Blue has exactly 5 minutes left. |
| `rinc 3000` | 3 000 ms | Red gains 3 seconds back each time it moves. |
| `binc 3000` | 3 000 ms | Blue gains 3 seconds back each time it moves. |

Red is 1.6 seconds behind Blue here because Red already made the opening move in this game
(`d7-d6`, back in the `position` line) and spent a little time thinking about it; the host
is simply reporting both clocks as they stand right now. The engine being asked to move is
whichever side the preceding `position` line named to move — in this example, Red — but
`go` still carries both `rtime` and `btime` because an engine computing its own time
management may want to know how much time its opponent has too. There is no `movestogo`
field, as the table below explains, so this is the entire time control: an initial budget
plus a per-move increment, forever.

## Squares, moves and positions

A square is a file letter `a`–`i` and a rank digit `1`–`9`. Files run left to right and
ranks run from Blue's home boundary at `1` to Red's at `9`, so `a1` is the corner of Blue's
home rank. These are the same coordinates the game archive uses, with no transformation.

A move is the square a piece leaves, a separator, and the square it enters: `d7-d6`. When
the destination is occupied the host writes `x` instead of `-`, as in `d7xd6`.

**Readers must accept either separator and must not treat it as information.** Whether a
move captures is a fact about the position, not about the move, and an engine that rejected
`d7-d6` for a capture would be relying on the host to tell it something it can already see.
The host also accepts a leading piece letter (`Rd7xd6`), which is what makes an RPSI move
identical to a PGN move minus the piece. A move an engine echoes back verbatim from
`legalmoves` is always spelled acceptably.

A position is three space-separated fields — pieces, side to move, territory:

```text
3SSS3/3PPP3/3RRR3/9/9/9/3rrr3/3ppp3/3sss3 r 3bbb3/3bbb3/3bbb3/9/9/9/3rrr3/3rrr3/3rrr3
```

Rows run from rank 1 to rank 9 separated by `/`, digits count consecutive empty tiles,
uppercase letters are Blue pieces and lowercase are Red. The side to move is `r`, `b`, or
`-`. The third field is territory ownership, and it is **mandatory even in modes that
ignore it**, because a tile can be owned by a player who has no piece standing on it and
that is exactly what decides Total War. See [`backend/docs/pgn.md`](../backend/docs/pgn.md)
for the same notation in its archival form.

## Host to engine

| Command | Arguments | Meaning |
| --- | --- | --- |
| `rpsi` | — | Identify yourself. Answer with `id`, `protocol`, `rules`, `option` and `mode` lines, then `rpsiok`. The host sends nothing else until `rpsiok` arrives. |
| `isready` | — | Synchronise. Answer `readyok` once any pending `setoption` work has finished. Legal at any time, including during a search, and a search in flight must not delay it. |
| `setoption` | `name <id> [value <v>]` | Set one option you declared. Sent before the first `go`, or between games. |
| `newgame` | `<modeId>` | A new game, unrelated to the last one, in this mode. Clear the transposition table, killers and history heuristics. |
| `position` | `fen <pieces> <side> <territory> [moves <m>…]` | The board the game was played from, then every move since, in order. |
| `legalmoves` | `<m>…` | Every legal move for the side to move in the position just described. Advisory. |
| `go` | see below | Start searching. |
| `stop` | — | Stop as soon as possible and print `bestmove`. |
| `quit` | — | Exit. Abandon any search in progress. |

`go` takes any combination of:

| Parameter | Meaning |
| --- | --- |
| `rtime <ms>` | Red's remaining time |
| `btime <ms>` | Blue's remaining time |
| `rinc <ms>` | Red's increment per move |
| `binc <ms>` | Blue's increment per move |
| `movetime <ms>` | Search for exactly this long, ignoring the clock |
| `depth <n>` | Stop after completing this depth |
| `nodes <n>` | Stop after approximately this many nodes |
| `searchmoves <m>…` | Consider only these moves at the root |
| `infinite` | Search until `stop` |

There is no `movestogo`. A time control here is an initial allowance plus a per-move
increment and nothing else, so there is no move count to reach.

## Engine to host

| Line | Meaning |
| --- | --- |
| `id name <text>` | Free text, shown to players. Include a version. |
| `id author <text>` | Free text. |
| `protocol <n>` | The RPSI major version you speak. `1` today. |
| `rules <n>` | The rule set you implement. RPSFish reports its `RULES_VERSION`, currently `2`. |
| `option name <id> type <spin\|check\|combo\|string\|button> [default …] [min …] [max …] [var …]` | UCI's option grammar, unchanged. |
| `mode <id> [name]` | One line per mode you can play. |
| `rpsiok` | End of identification. |
| `readyok` | Answer to `isready`. |
| `info …` | Search progress. |
| `bestmove <move>` | Your move. Exactly one per `go`. |
| `shutdown [reason]` | Take me out of play when it is convenient. See below. |

`protocol` is the field that lets a host refuse an engine it cannot talk to, which is the
only reason to have it. A `rules` mismatch is logged rather than refused: an engine may
legitimately be built against an older rule set and still play correctly in modes that did
not change.

Mode ids are `V3` (Infiltration) and `V5` (Total War). The trailing name is for a human reading a log. **An id the host does not
recognise is ignored, not rejected**, so an engine can declare support for a mode that this
server has not shipped yet without failing the handshake.

`info` fields appear in this order when present: `depth`, `seldepth`, `multipv`, `score`,
`confidence`, `nodes`, `nps`, `time`, `pv`. `pv` is last because it is the only
variable-length one. Moves in a `pv` are separated by single spaces.

**Any other line an engine prints must begin with `info string`.** This is the rule that
lets a host forward engine output without having to decide what is diagnostic. Anything
unrecognised that does not start with `info string` may be discarded, logged as an error,
or treated as a protocol fault.

## `shutdown`

`shutdown`, optionally followed by free text, asks the host to stop giving this engine new
games. It is the one line here that is a request rather than an answer, and it is the only
reason an engine ever speaks unprompted.

```text
< shutdown the host is being reclaimed in ten minutes
```

Print it at any time — during a search, between games, or while idle. It is not part of an
exchange and does not replace a `bestmove`: an engine that says this in the middle of a
search still owes the move it was asked for, and every game already on a board is still to
be played out.

What the host does with it is the host's business, and this document does not say. What it
must not do is treat it as an instruction to stop *now*: the engine is asking to be taken
out of the queue, not resigning. On the server in [`bots.md`](bots.md) it starts a graceful
shutdown — the bot is offered no new game, plays out what it already owes, and is then told
to exit — and the free text is shown to the bot's owner as the reason.

A host that does not implement it ignores the line, like any other it does not recognise.
So an engine may print it unconditionally; the worst case is that nothing happens.

**`quit` is unrelated and still means what it says.** That comes from the host and is an
order to exit immediately. This goes the other way and is a request to be let go.

## The three things that are easy to get wrong

### Score is from the side to move's point of view

`score cp <n>` is in centi-units, positive meaning **the side to move is better**. Not Red,
not the engine's own colour — the side to move in the position the host just described.
This is UCI's convention and it is what a negamax search naturally produces.

It is worth being blunt about why this matters: a sign error here is completely silent. The
engine plays on, the protocol never complains, and the symptom is that a strong engine
appears to be a weak one. If a new engine loses badly for no visible reason, check the sign
before anything else.

A proven result is `score win <plies>` or `score loss <plies>`, counting plies from the
current position to the end. It is not called `mate`, because there is no mate in this
game — a forced win comes from annihilating the opponent, from owning the board, or from
reaching a boundary, and calling any of those checkmate would be a lie in the one place a
reader most needs precision.

`confidence <0-100>` is optional and reports how stable the result has been across
iterations. **It is not a win probability** and must not be displayed as one.

### There is no `startpos`

The host always sends a full FEN, even for a game starting from the mode's ordinary opening
board, and RPSI provides no way to say "the usual starting position".

This is a deliberate omission rather than a gap. A stored game records the board it was
*actually played from*, so that redesigning a mode's opening layout does not invalidate
every game played before the change — the reasoning is in
[`backend/docs/pgn.md`](../backend/docs/pgn.md). Games can also start from a position a
player chose. An engine that assumed the standard opening would therefore, occasionally and
silently, analyse a different game than the one being played. Making the assumption
impossible to express removes the failure mode instead of documenting it.

### Repetition history lives in the move list

The third occurrence of the same position — the same pieces, the same territory, and the
same side to move — is a draw. The FEN carries no ply counter and no history, so the
`moves` list is the only way an engine can see a repetition coming, and it is why the host
re-sends every move from the start of the game rather than only the position.

Past the opening this is the difference between a draw and a win, in both directions: an
engine blind to repetition will walk into a drawn cycle when it is winning, and will fail
to find one when it is losing.

## On `legalmoves`

Immediately before every `go`, the host sends the complete list of legal moves for the side
to move. This is not in UCI and deserves an explanation.

There is no library for this game. A chess engine author starts from a hundred
implementations of move generation; here there is exactly one, and it is inside this
repository. Without `legalmoves`, the smallest possible bot has to parse a three-field FEN,
build a neighbour table, encode the rock-paper-scissors capture cycle, and implement three
different sets of mode-specific movement rules before it can make a single legal move. With
it, the smallest possible bot is ten lines and picks at random.

The list is also the authoritative statement of legality rather than a second opinion. A
`bestmove` outside it is rejected. Today an engine can only discover the rules by being told
its move was illegal; this states them up front. An engine with its own generator gets a
free conformance check by diffing the two and complaining via `info string` when they
disagree — which is the cheapest possible early warning that a rules change has landed.

A strong engine should discard the line and generate its own moves. It costs about a
kilobyte per move to ignore.

## Time

Converting a clock into a search budget is the engine's business, not the protocol's. The
host reports what remains and what the increment is; how much of that to spend is exactly
the kind of decision that distinguishes engines.

Two obligations, though. An engine must return a `bestmove` before its own clock reaches
zero, because the host will flag it and the game is lost — leave a margin for the round
trip. And an engine must always answer a `go`, even a hopeless one: if there is no time to
think, return the first legal move rather than nothing.

## Errors

RPSI has no error replies, on purpose. An engine that cannot understand a line should
ignore it, optionally reporting the fact with `info string`, and carry on. The host is
responsible for everything that matters: an illegal `bestmove`, a `bestmove` that never
arrives, or a crashed process are all detected and handled host-side, and the game is
resolved without the engine's cooperation.

The one thing an engine must never do is exit on an unrecognised command. A future protocol
version will add commands, and an engine that treats them as fatal breaks on the day they
ship.

## Driving an engine by hand

Everything above is plain text on a pipe, so the fastest way to check an engine is to talk
to it:

```bash
printf 'rpsi\nisready\nnewgame V5\nquit\n' | ./your-engine
```

RPSFish implements this protocol as its `rpsi` subcommand and is the reference:

```bash
cargo run --release -- rpsi
```

To connect an engine to the live server, see [`bots.md`](bots.md) — nothing in this document
is specific to that, and an engine that satisfies this specification needs no changes to
play online.
