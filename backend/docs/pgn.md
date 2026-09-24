# Game records (PGN)

Every game the server plays is stored in full, as text, in the `game_pgn`
table. One row is one game and holds everything needed to rebuild it: the
board it started from, every move, both clocks after every action, the draw
offers and time extensions the players exchanged, and how it ended. Nothing
else in the database is required to reconstruct a stored game — the row is
self-sufficient, which is what makes the archive usable as a training set.

The format follows chess PGN's shape so ordinary tooling and ordinary eyes can
read it, and departs from it exactly where the game differs.

This is the full account, including how records are stored and exported.
[`../../docs/notation.md`](../../docs/notation.md) is the short public version
of the notation itself, served to the website beside the bot guide — a change to
how a move, a tag or a FEN is written belongs in both.

## Reading a record

```text
[Event "Ranked"]
[Site "RPS Strategy"]
[Date "2026.08.21"]
[Round "-"]
[Red "Alice"]
[Blue "Bob"]
[Result "1-0"]
[GameId "8f1c0b7d2a4e6f9012345678"]
[Variant "Total War"]
[ModeId "V5"]
[BoardSize "9"]
[TimeControl "300+3"]
[SetUp "1"]
[FEN "3SSS3/3PPP3/3RRR3/9/9/9/3rrr3/3ppp3/3sss3 b 3bbb3/3bbb3/3bbb3/9/9/9/3rrr3/3rrr3/3rrr3"]
[RedId "8b1f…"]
[BlueId "2c7a…"]
[RedElo "1200"]
[BlueElo "1240"]
[RedEloAfter "1216"]
[RedRatingDiff "+16"]
[BlueEloAfter "1224"]
[BlueRatingDiff "-16"]
[Ranked "true"]
[Termination "Red wins by resignation"]
[EndReason "resignation"]
[PlyCount "12"]
[MoveNumber "12"]
[UTCDate "2026.08.21"]
[UTCTime "16:29:56"]
[StartTimeUnixMs "1787329796329"]
[EndTimeUnixMs "1787329912480"]
[FinalFEN "3SSS3/3PPP3/3R5/6R2/2R6/3r1r3/3p5/2rp2p2/2s1ss3 r 3bbb3/…"]
[Generator "rps-strategy-pgn/2"]

1. Sd1-c1 {[%emt 2.104] [%clk 0:05:00.000 0:05:00.896]} 1... Pf8-g9
{[%emt 1.550] [%clk 0:05:01.450 0:05:00.896]} 2. Rf3xf4
{[%emt 0.981] [%clk 0:05:01.450 0:05:02.915]}
{[%act draw_offer Red] [%emt 4.002] [%clk 0:04:57.448 0:05:02.915]}
{[%end resignation Blue] [%emt 1.204] [%clk 0:04:57.448 0:05:01.711]} 1-0
```

### Squares

Files are letters running left to right (`a` is `x` = 0) and ranks are numbers
running from Blue's home boundary (`1` is `y` = 0) to Red's, matching engine
coordinates with no transformation. On the nine-by-nine board the built-in modes
use, that is `a1` at the corner of Blue's home rank and `i9` at the opposite one.

A mode may be any rectangle up to 26 a side, so a file may be any letter up to
`z` and a rank is a decimal number rather than one digit: `d10` is an ordinary
square on a board with ten ranks. The `BoardSize` tag says what shape a game was
played on — one number for a square board, `WxH` otherwise — but nothing reads
it, because the `FEN` beside it already describes the shape. Its ranks are the
board's ranks and each rank's runs add up to the board's files, which is what
lets an archived game replay on the board it was actually played on with nothing
else telling the parser so. A run of empty squares is a decimal number too, so a
wide empty rank is `11` rather than `9` followed by `2`.

### Moves

A move names the piece, the square it left, `-` or `x`, and the square it
entered: `Rd3-d4`, `Rd3xd4`. Blue moves first and is written like White.

The captured piece is not written because the rules fix it: rock takes only
scissors, scissors only paper, paper only rock. A capture of anything else — a
future mode with different rules — spells the victim out between the `x` and
the destination (`Rd7xPd6`) so the format cannot lose information.

`#` marks a move that ended the game by a rule (annihilation, territory,
infiltration, repetition, no capture, or stalemate). Resigning, agreeing a
draw, timing out, and walking away are not caused by a move and are never
marked.

`12.` announces a move by the side that *opened this game* and `12...` a move
by the other, the way a chess PGN announces White and Black, so colors stay
explicit even for a mode that does not strictly alternate. The opener is read
off the file's own `FEN` tag, which every generated record carries.

That is dialect 2, and the `Generator` tag is how a reader tells. Dialect 1
numbered pairs by colour — `12.` was always Red — which was the same thing
until Blue became the side that opens. The two disagree only about a game the
*non-opening* side began, which is a board somebody set up or an opening seeded
to an odd number of plies, so an archived record from either dialect replays
correctly and a file with no `Generator` tag is read as the current one.

### Annotations

Every action carries the clock, and everything that is not a move is an
annotation comment:

| Annotation | Meaning |
| --- | --- |
| `[%emt 1.284]` | seconds the side to move spent before this action |
| `[%clk 0:04:58.716 0:05:00.000]` | Red's and Blue's remaining time afterwards |
| `[%act draw_offer Red]` | a draw offer, decline, time offer, or time decline |
| `[%act time_accept Blue 180000]` | an agreed time extension and the bonus, in ms, given to both clocks |
| `[%end resignation Red]` | how the game ended and who caused it |

`%emt` is what makes a record replayable rather than merely readable.
Advancing a clock by exactly those elapsed times reproduces both clocks to the
millisecond, so the archive preserves how long players thought, not just what
they played. Time consumed by an action that was rejected is carried into the
next recorded event, so the elapsed times always sum to time actually spent.

### Positions

`FEN` and `FinalFEN` hold three space-separated fields: pieces, the side to
move (`r`, `b`, or `-`), and territory ownership. A generated game record always
writes all three, but `DecodePosition` reads a position with the territory field
left off — ownership then follows the pieces — so a board written by hand for a
mode where ownership decides nothing need not spell it out. The app's own
"copy position" writes such a board: outside Total War the field would record
where the pieces used to be, because a tile no rule reads keeps the colour of
whoever last stood on it. Rows run from rank 1 to rank
9 separated by `/`, digits count consecutive empty (or unowned) tiles,
uppercase letters are Blue pieces and lowercase are Red — the same convention a
mode's `StartingPosition` uses. Territory is a separate field because a tile
can be owned by a player who has no piece on it, which decides Total War.

`FEN` is the board the game was actually played from, so replaying an old
record survives a later redesign of the mode's opening position.

Custom starting positions use the standard PGN pairing `[SetUp "1"]` plus
`[FEN "…"]`. The reader uses the complete FEN as the initial state: pieces,
territory, and the side to move are all preserved. For example, a `b` in the
second field makes the first move Blue's and should be followed by a `1...`
move token. Encoding the parsed or replayed record writes the same custom FEN
back out.

## Reconstructing a game

```go
parsed, err := notation.Parse(pgnText)
if err != nil { … }

// Replay every recorded event through the real mode rules.
replayed, err := game.Replay(parsed.Record)

// Or prove the record describes exactly one game: Verify replays it and
// insists on the same final board, clocks, turn, winner, and end reason.
err = game.Verify(parsed.Record)
```

`Replay` fails if any recorded move is illegal or any recorded ending does not
follow from the position, so a record that verifies cannot describe two
different games. The round trip is tested against randomly generated games in
every registered mode.

## Getting the data out

```text
GET /api/games/{gameId}/pgn                      one game
GET /api/accounts/{userId}/games/pgn             one player's games, newest first
GET /api/admin/games/pgn                         the whole archive (host token)
```

All three accept `?format=json` for the stored row instead of the text. The
bulk export also accepts `?format=jsonl` for one JSON object per line, and
filters `since`, `until` (Unix milliseconds, `since` inclusive and `until`
exclusive), `mode`, `ranked`, `limit`, and `offset`. It is ordered oldest
first with the game ID breaking ties, so paging with `offset` sees every game
exactly once, and it reports the archive size in the `X-Archive-Total` header.

Bulk export is host-only because it returns the whole database in one call.
Pass the server's `RPS_ADMIN_TOKEN` as a Bearer credential:

```sh
curl -H "Authorization: Bearer $RPS_ADMIN_TOKEN" \
  "https://api-rps.henhen1227.com/api/admin/games/pgn?limit=1000&offset=0" \
  > games.pgn
```

`notation.ParseMulti` reads a file of concatenated records back.

## Reviews

A record is also what the in-app review replays. When a player reviews a game
they played, their accuracy is stored beside the record in `game_accuracy`
rather than inside the PGN column, so a record stays a complete game on its own
and a game nobody has reviewed has no row rather than a blank one. `?format=json`
responses carry whatever reviews exist alongside the record. See
[`../../docs/review.md`](../../docs/review.md).

## What is stored, and when

A game is archived the moment it ends, in the same place the result is
recorded, but never gated on it: a game whose rating transaction fails is still
archived, and so are unranked, private-challenge, and tournament games. Local
bot battles are kept in the browser and can be copied as PGN instead. Games
still in progress when the process stops are archived as they
stand with the `*` result, so a restart costs only the games that had no moves
yet. Writes are keyed on the game ID and ignore a repeat, so no game can be
archived twice.
