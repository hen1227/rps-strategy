# Records and notation

Games are stored as PGN text: the starting board, moves, clocks, and result.
Use a record to replay or share a game. FEN describes a single position.

## Squares

On the standard 9×9 board, files run `a`–`i` and ranks run `1`–`9`, from Blue's
home boundary to Red's. `a1` and `i9` are opposite corners.

Boards can be rectangular, up to 26 squares per side. Files extend to `z`;
ranks can have multiple digits, as in `d10`.

## Positions (FEN)

Three space-separated fields: pieces, side to move, and territory.

```text
3SSS3/3PPP3/3RRR3/9/9/9/3rrr3/3ppp3/3sss3 b 3bbb3/3bbb3/3bbb3/9/9/9/3rrr3/3rrr3/3rrr3
```

- Rows run from rank 1 upward, separated by `/`.
- `R`, `P`, and `S` mean rock, paper, and scissors. Uppercase is Blue; lowercase is Red.
- Numbers count consecutive empty or unowned tiles. Eleven empty tiles are `11`.
- The side to move is `r`, `b`, or `-`.
- The rows and their lengths define the board dimensions.

Only Total War uses territory, which records ownership even on empty squares.
Generated game records always include it. Input may omit it; ownership then
follows the pieces. Positions copied from the app omit territory outside Total War.

## Moves

A move names the piece, source, separator, and destination: `Rd3-d4` or
`Rd3xd4`. Use `x` for a capture. Rock captures scissors, scissors captures paper,
and paper captures rock. A capture outside that cycle names the victim too,
as in `Rd7xPd6`.

`#` marks a move that ends the game under its rules, including repetition in
older records. Resignation, agreed draws, timeouts, and abandonment have no `#`.

`12.` marks a move by the side that opened this game; `12...` marks the other
side. Read the opener from the `FEN` tag. Blue opens standard games.

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

Records also include player IDs, ratings before and after, timestamps, and a game ID.

| Tag | Meaning |
| --- | --- |
| `ModeId`, `Variant` | Mode ID and name. |
| `SetUp`, `FEN` | Actual starting board and first side to move. |
| `FinalFEN` | Final board. |
| `BoardSize` | `9`, or `WxH` for a rectangle. |
| `EndReason` | Machine-readable result alongside `Termination`. |
| `Generator` | Record dialect. |

Always replay from the recorded FEN, including custom positions. A later change
to the standard opening does not affect the record.

## Annotations

Actions and clock readings appear in comments.

| Annotation | Meaning |
| --- | --- |
| `[%emt 1.284]` | Seconds spent before this action. |
| `[%clk 0:04:58.716 0:05:00.000]` | Red's and Blue's remaining time. |
| `[%act draw_offer Red]` | Draw or time-extension offer or decline. |
| `[%act time_accept Blue 180000]` | Agreed extension and bonus in milliseconds for both clocks. |
| `[%end resignation Red]` | How the game ended and who caused it. |

`%emt` preserves elapsed time to the millisecond. Time spent on rejected actions
is included in the next recorded event.

## Dialects

The current dialect is `rps-strategy-pgn/2`. Dialect 1 always used `12.` for Red;
dialect 2 uses it for the opening side. Both replay correctly. A missing
`Generator` tag means the current dialect.

## Getting records out

```text
GET /api/games/{gameId}/pgn            one game
GET /api/accounts/{userId}/games/pgn   one player's games, newest first
```

Both accept `?format=json` to return the stored row instead of PGN.
