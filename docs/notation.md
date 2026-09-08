# Records and notation

Every game the server plays is stored in full, as text: the board it started from, every
move, both clocks after every action, and how it ended. Nothing else is needed to rebuild
it. The format follows chess PGN's shape, so ordinary tooling and ordinary eyes can read it,
and departs from it only where this game differs.

## Squares

Files are letters running left to right and ranks are numbers running from Blue's home
boundary at `1` to Red's, so on the 9×9 board the built-in modes use, `a1` is the corner of
Blue's home rank and `i9` the opposite one. These are the engine's own coordinates,
untransformed.

A mode may be any rectangle up to 26 a side, so a file may be any letter up to `z`, and a
rank is a decimal number rather than a single digit: `d10` is an ordinary square on a board
with ten ranks.

## Positions (FEN)

Three space-separated fields — pieces, side to move, territory:

```text
3SSS3/3PPP3/3RRR3/9/9/9/3rrr3/3ppp3/3sss3 b 3bbb3/3bbb3/3bbb3/9/9/9/3rrr3/3rrr3/3rrr3
```

Rows run from rank 1 to rank 9, separated by `/`. `R`, `P` and `S` are rock, paper and
scissors, uppercase for Blue and lowercase for Red. Digits count consecutive empty — or
unowned — tiles, as decimal numbers, so a wide empty rank is `11` rather than `9` followed
by `2`. The side to move is `r`, `b` or `-`.

Territory is a field of its own because a tile can be owned by a player with no piece
standing on it, and that is what decides Total War — the only mode that uses it. A generated
record always writes the field, so a stored game states its ownership rather than implying
it, but the field is optional on the way in: a position written as just pieces and a side to
move is read with ownership following the pieces, which is how every mode's opening board
looks anyway.

The ranks and their runs describe the board's shape, which is what lets an archived game
replay on the board it was actually played on without anything else telling the parser so.

## Moves

A move names the piece, the square it left, `-` or `x`, and the square it entered:
`Rd3-d4`, `Rd3xd4`. Blue moves first and is written like White.

The captured piece is not written, because the rules fix it: rock takes only scissors,
scissors only paper, paper only rock. A capture of anything else — a future mode with
different rules — spells the victim out between the `x` and the destination (`Rd7xPd6`), so
the format cannot lose information.

`#` marks a move that ended the game by a rule: annihilation, territory, infiltration,
repetition or stalemate. Resigning, agreeing a draw, timing out and walking away are not
caused by a move and are never marked.

`12.` announces a move by the side that **opened this game** and `12...` a move by the
other, the way a chess record announces White and Black — so colours stay explicit even in
a mode that does not strictly alternate. The opener is read off the record's own `FEN` tag.

## A whole record

```text
[Event "Ranked"]
[Site "RPS Strategy"]
[Date "2026.08.21"]
[Red "Alice"]
[Blue "Bob"]
[Result "1-0"]
[Variant "Total War"]
[ModeId "V5"]
[BoardSize "9"]
[TimeControl "300+3"]
[SetUp "1"]
[FEN "3SSS3/3PPP3/3RRR3/9/9/9/3rrr3/3ppp3/3sss3 b 3bbb3/3bbb3/3bbb3/9/9/9/3rrr3/3rrr3/3rrr3"]
[Termination "Red wins by resignation"]
[EndReason "resignation"]
[FinalFEN "3SSS3/3PPP3/3R5/6R2/2R6/3r1r3/3p5/2rp2p2/2s1ss3 r 3bbb3/…"]
[Generator "rps-strategy-pgn/2"]

1. Sd1-c1 {[%emt 2.104] [%clk 0:05:00.000 0:05:00.896]} 1... Pf8-g9
{[%emt 1.550] [%clk 0:05:01.450 0:05:00.896]} 2. Rf3xf4
{[%emt 0.981] [%clk 0:05:01.450 0:05:02.915]}
{[%act draw_offer Red] [%emt 4.002] [%clk 0:04:57.448 0:05:02.915]}
{[%end resignation Blue] [%emt 1.204] [%clk 0:04:57.448 0:05:01.711]} 1-0
```

A real record carries more tags than this — the players' ids, both ratings before and after,
timestamps, the game id — but they are the ordinary kind. The ones worth knowing:

| Tag | Meaning |
| --- | --- |
| `ModeId`, `Variant` | the mode, by id and by name |
| `SetUp`, `FEN` | the board this game was actually played from |
| `FinalFEN` | the board it ended on |
| `BoardSize` | `9`, or `WxH` for a rectangle |
| `EndReason` | the machine-readable half of `Termination` |
| `Generator` | which dialect wrote the file |

`FEN` is the board the game was **actually** played from, so replaying an old record survives
a later redesign of the mode's opening position. A game started from a position somebody set
up uses the same standard pairing of `SetUp` and `FEN`, and its second field decides who
moves first.

## Annotations

Everything that is not a move is an annotation comment, and every action carries the clock:

| Annotation | Meaning |
| --- | --- |
| `[%emt 1.284]` | seconds the side to move spent before this action |
| `[%clk 0:04:58.716 0:05:00.000]` | Red's and Blue's remaining time afterwards |
| `[%act draw_offer Red]` | a draw offer or decline, or a time-extension offer or decline |
| `[%act time_accept Blue 180000]` | an agreed extension, and the bonus in ms given to both clocks |
| `[%end resignation Red]` | how the game ended, and who caused it |

`%emt` is what makes a record replayable rather than merely readable: advancing a clock by
exactly those elapsed times reproduces both clocks to the millisecond, so the archive
preserves how long people thought, not only what they played. Time spent on an action that
was then rejected is carried into the next recorded event, so the elapsed times always sum
to time actually spent.

## Dialects

`Generator` says which dialect wrote a file, and `rps-strategy-pgn/2` is current. Dialect 1
numbered move pairs by colour, so `12.` was always Red — the same thing until Blue became
the side that opens. The two disagree only about a game the **non-opening** side began, which
means a board somebody set up or an opening seeded to an odd number of plies. A record from
either dialect replays correctly, and a file with no `Generator` tag is read as the current
one.

## Getting records out

```text
GET /api/games/{gameId}/pgn            one game
GET /api/accounts/{userId}/games/pgn   one player's games, newest first
```

Both accept `?format=json` for the stored row instead of the text.
