# RPSI: the engine protocol

RPSI is a line-based protocol for Rock–Paper–Scissors Strategy engines, based on UCI.
Read commands from stdin and write replies to stdout. The host handles networking,
accounts, rules, clocks, and game records.

- The host decides whether moves are legal and when the game ends.
- Each search receives the full position and move history. Do not rely on earlier commands to reconstruct it.
- Each line is a complete command or reply. Flush output after every reply.
- One engine process plays one game. Concurrent games use separate processes.

## A whole conversation

`>` marks host commands and `<` marks engine replies. Neither prefix is sent.

```text
> rpsi
< id name Example
< id author you
< id version 0.1.0
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

Options and search progress are optional. A simple bot can choose from `legalmoves`
without parsing the position itself. Ignore commands you do not recognise.

## Squares, moves and positions

Files run `a`–`i`; ranks run `1`–`9`, from Blue's home boundary to Red's.
`a1` is a corner of Blue's home rank.

Moves use a source, separator, and destination: `d3-d4` or `d3xd4`.
Accept either separator; the board determines whether a move captures.
A leading piece letter, as in `Rd3xd4`, is also accepted.
You can return a move from `legalmoves` unchanged.

A position has three space-separated fields: pieces, side to move, and territory.

```text
3SSS3/3PPP3/3RRR3/9/9/9/3rrr3/3ppp3/3sss3 b 3bbb3/3bbb3/3bbb3/9/9/9/3rrr3/3rrr3/3rrr3
```

Rows run from rank 1 to rank 9, separated by `/`. Digits count empty tiles.
`R`, `P`, and `S` mean rock, paper, and scissors. Uppercase is Blue; lowercase is Red.
The side to move is `r`, `b`, or `-`. Blue starts a standard game.

Only Total War (`V5`) uses territory. The host always sends it; other modes may
ignore it. Input may omit territory, in which case ownership follows the pieces.

## Host to engine

| Command | Arguments | Meaning |
| --- | --- | --- |
| `rpsi` | None | Send identity, protocol, rules, options, and modes, then `rpsiok`. The host waits for `rpsiok`. |
| `isready` | None | Reply `readyok` after pending option changes. Answer even during a search. |
| `setoption` | `name <id> [value <v>]` | Set a declared option, before the first search or between games. |
| `newgame` | `<modeId>` | Start an unrelated game. Clear search history, killers, and the transposition table. |
| `position` | `fen <pieces> <side> <territory> [moves <m>…]` | Starting board followed by every move played. |
| `legalmoves` | `<m>…` | Legal moves for the current position. |
| `go` | See below | Start searching. |
| `stop` | None | Stop searching and print `bestmove`. |
| `quit` | None | Exit immediately, abandoning any search. |

### The `go` line

```text
go rtime 300000 btime 298400 rinc 3000 binc 3000
```

Times are in milliseconds. `rtime` and `btime` are Red's and Blue's remaining time;
`rinc` and `binc` are their per-move increments. Both clocks are sent. Your side is
the side to move in the preceding `position`.

Optional search limits can be combined:

- `movetime <ms>`: search for this long, ignoring the game clock.
- `depth <n>` or `nodes <n>`: limit depth or node count.
- `searchmoves <m>…`: search only these root moves.
- `infinite`: search until `stop`.

There is no `movestogo`. Time controls use an initial allowance and an increment.

## Engine to host

| Line | Meaning |
| --- | --- |
| `id name <text>` | Engine name shown to players. |
| `id author <text>` | Author name. |
| `id version <text>` | Optional build identifier. |
| `protocol <n>` | RPSI major version, currently `1`. |
| `rules <n>` | Implemented rule set, currently `2`. |
| `option name <id> type <spin\|check\|combo\|string\|button> [default …] [min …] [max …] [var …]` | UCI option syntax. |
| `mode <id> [name]` | One line per supported mode. |
| `rpsiok` | Identification complete. |
| `readyok` | Reply to `isready`. |
| `info …` | Search progress. |
| `bestmove <move>` | Exactly one move per `go`. |
| `shutdown [reason]` | Request no new games; finish existing commitments. |

An unsupported protocol version may be refused. A rules mismatch is logged,
since unchanged modes may still work. Mode IDs are `V3` (Infiltration),
`V5` (Total War), and `V6` (Intransitive). Unknown mode IDs are ignored.

When present, `info` fields use this order: `depth`, `seldepth`, `multipv`,
`score`, `confidence`, `nodes`, `nps`, `time`, `pv`. Put the space-separated move
list in `pv` last. Prefix all other diagnostic output with `info string`.
Unrecognised output may be discarded or treated as a protocol fault.

### `shutdown`

```text
< shutdown this machine is being reclaimed in ten minutes
```

Send this at any time to request no new games. Continue answering searches and
finish every committed game. It does not replace `bestmove` or resign a game.
Hosts that do not support it ignore it. The host's `quit` command still means
exit immediately.

## Common mistakes

**Scores use the side to move's perspective.** `score cp <n>` uses centi-units;
positive values favour that side. Proven results use `score win <plies>` or `score loss <plies>`, not
`mate`. Optional `confidence <0-100>` measures stability across search iterations,
not win probability.

**There is no `startpos`.** Use the supplied FEN. Games may start from custom
positions, and standard openings can change.

**Count captures from the move history.** All modes draw after 200 plies without
a capture (100 moves per side). FEN has no counter. Replay the moves and reset
the counter when the destination held a piece.

**Repetition is not a draw in any current mode.** Older rules allowed it in
Infiltration and Total War, so older engines may disagree.

## On `legalmoves`

The host sends this list before each `go`. A move outside it is rejected.
Simple bots can pick directly from the list. Engines with their own move
generator can compare the lists to check their rules and report differences
with `info string`.

## Time, and errors

Return `bestmove` before your clock reaches zero. Leave time for the round trip.
If time is short, return a legal move immediately.

There are no error replies. Ignore unknown commands, optionally log them with
`info string`, and keep running. The host handles illegal moves, missing replies,
and crashed engines. Never exit just because a command is unfamiliar.

## Driving an engine by hand

```bash
printf 'rpsi\nisready\nnewgame V5\nquit\n' | ./your-engine
```

See [Connect your bot](bots.md) to run the engine on a live server.

This reference is released under the MIT License, like `rpsbot.py` and the
example engines. See the licence note at the end of
[Connect your bot](bots.md).
