# Website opening books

RPSFish's append-only `nodes.log` and `paths.log` remain the authoritative
analysis. The website consumes a flat *position graph* derived from them --
`rps-opening-book/v2`. That separation is intentional: the browser sees moves in
the coordinates a player actually used and never needs to reproduce native
symmetry or cycle handling.

## Certified openings

The page leads with the openings the engine will *stand behind*, which is a
narrower claim than "the best openings" and a much narrower one than the page
used to make. `--featured` follows the best few first moves along their
principal variations for a fixed number of plies, and a principal variation
runs to whatever length it is asked for whether or not the search behind it
ever separated the moves along it. That is how a book of tens of thousands of
positions produced a shortlist nobody should have trusted.

A **certified** opening runs while exactly one continuation is strictly best,
mirror twins folded, at a position searched to at least a depth floor -- and
stops at the first ply where that fails. Each one carries why it stopped, so
the page can say "RPSFish rates three replies equally here" instead of drawing
a line through the branch.

The test is on the *ranking*, not on a score margin, and that is the point.
A threshold in score units would need refitting every time the evaluation is
re-tuned, because re-tuning moves every score in a mode at once -- and nothing
would fail when it wasn't refitted, so the page would quietly certify too much
or nothing at all. "Strictly better than the best alternative" survives any
positive rescaling of the evaluation. The one score comparison left is against
`MATE_THRESHOLD`, which is structural rather than fitted.

The first move is exempt from the strict test, because it is the player's
choice rather than the engine's claim: every distinct first move is an opening
somebody may want to play, and its rank already says how the book rates it.
Everything after it is the engine asserting how the line goes.

```sh
cargo run --release --bin book -- certify --dir book/V3 --mode infiltration
```

Its own command as well as part of every export, because it is the question to
ask *during* a long build: whether another few hours bought another certified
opening is the only reason to run those hours. **An empty list is a real
answer** -- it means the scan has not separated the mode's openings from each
other, and more budget rather than a lower bar is the reply. Total War's book
certified nothing at all when this was written: its root spans +2 to +1 across
ten moves.

Mirror twins are folded on the canonical child key rather than by mirroring
notation, because two edges that reach the same canonical position are the same
opening drawn twice however the mode's geometry works.

## The server owns the book

The graph is stored, not served. A published book is tens of thousands of
positions and around ten megabytes; a visitor reads a handful. So the browser
gets a small bootstrap on arrival and then asks for one position at a time as it
clicks through:

| | payload |
| --- | --- |
| `GET /api/openings/V3` | 21 KB (3 KB gzipped) |
| `GET /api/openings/V3/node?line=...` | ~1 KB |
| the whole V3 graph, which is never sent | 9.6 MB |

Positions are keyed by the hash of the *real* board, so two move orders reaching
the same position resolve to one key and one analysis -- something the old
nested tree could not express, since it had to write that position out once per
line that reached it. Storage for both modes is about 36,000 positions and
155,000 moves, or 9 MB of SQLite.

Repetition is not stored. Whether a move repeats depends on the line walked to
reach it, not on the position, so the server decides it per request from the
path it just resolved.

Three tables hold it: `opening_positions`, `opening_edges`, and
`opening_graph_meta`. Names live apart in `opening_names`, keyed by line rather
than by position -- deliberately, because the same board reached two ways can be
two differently named openings, and that is exactly the case the graph merges.

## Export and import

From `RPSFish/`, `scripts/build_books.sh` builds, checks, and stages both
modes, and `--publish` uploads them:

```sh
RPS_API_URL=... RPS_ADMIN_TOKEN=... scripts/build_books.sh --publish
```

The steps it wraps, if a book already exists and only needs publishing:

```sh
cargo run --release --bin book -- export \
  --dir book/V3 --mode infiltration --format graph \
  --plies 40 --featured 3 --featured-plies 12 \
  --certain-depth 14 --certain-plies 8 --certain-min 2 --certain-max 8 \
  --output book/export/V3-openings.json
```

`--featured` is what comes down in the bootstrap: the best openings, each
followed along its own principal continuation, so the recommended lines can be
clicked through with no network at all. Everything else is fetched on demand.
`--format tree` still writes the old nested shape, and the importer still
accepts one -- it keys such a book by line, which is the only identity a nested
export carries.

Publishing is a shell act: the export is around ten megabytes, so the website
never offers to take one. `scripts/build_books.sh --publish` does the whole
thing, and an automated scan can PUT it directly without an intermediate file:

```sh
cargo run --release --bin book -- export \
  --dir book/V3 --mode infiltration --output - |
curl --fail-with-body -X PUT \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $RPS_ADMIN_TOKEN" \
  --data-binary @- \
  "$RPS_API_URL/api/admin/openings/V3"
```

`V3`, `V5`, and `V6` are the website mode IDs, and are what the book
directories are named after. The import URL must agree with the export's
`modeId`; `node scripts/check_export.mjs <file> --mode V3` checks that and every
other rule below against the file, before anything is uploaded. Imports replace
only engine analysis; published human names and pending suggestions live in
separate tables and survive every scan.

## API

Public routes:

```text
GET  /api/openings/{modeId}
     metadata, names, the opening position, and the featured lines' positions
GET  /api/openings/{modeId}/node?line=d2-c3,d9-c8
     one position: its ranked moves, each with the child's turn and depth
GET  /api/openings/{modeId}/names
     the naming layer alone: what lines are called, and the mirror rule
POST /api/openings/{modeId}/names
     {"line":["d2-c3"],"name":"The Quiet Centre"}
     a player naming a line, published on the spot
GET  /api/openings/{modeId}/names/browse?q=&source=&limit=&offset=
     the searchable index of every name, newest first
GET  /api/openings/{modeId}/stats?segments=human,meaf&line=d2-c3
     what people actually play, from whichever sources you ask for
GET  /api/openings/{modeId}/suggestions
     every name put forward and not yet published, oldest first
POST /api/openings/{modeId}/suggestions
     {"line":["d2-c3","d8-c7"],"name":"Skipping Stone Defense"}
```

## Anybody can name an opening

`POST .../names` publishes a name immediately, with no queue. A proposal that
sits invisible until a curator happens to look is a question the site asked and
then ignored, and the openings worth naming are mostly the ones RPSFish never
analyzed -- so the interesting names could not be made at all while naming
meant naming a line in the book.

Three rules make that safe to offer:

- **The line is checked against the rules, not against the book.** A nameable
  line is one somebody could sit down and play, whether or not the engine has
  an opinion about it, so it is replayed onto a scratch game
  (`replayOpeningLine`). This is deliberately *not* the `openingBookForLine`
  check the explorer makes.
- **`PlayerOpeningNameLimit` is six plies.** Where "book" ends is genuinely
  unclear -- there is no ply at which a game stops being an opening -- so this
  does not try to find that line. It picks a length at which a name still
  describes an idea rather than a game. Past it the page says the position has
  no name, which is the honest answer.
- **First to name it wins.** A second name for the same line is a 409, not an
  overwrite: a name that changes under the people already using it is worse
  than a name they disagree with, and disagreeing is what a suggestion is for.

A name carries its `source` -- `curator` or `player` -- and its author when
somebody was signed in. Signing in is not required, because the choice was to
let anybody name a line rather than to gate it; recording who did when we know
is what gives a curator something to act on beyond the name itself. Removal is
the existing `DELETE /api/admin/openings/{modeId}/names`.

**Player names are not listed beside the certified openings.** An unvetted name
shown next to a certified line reads as though the engine had something to do
with it. But a name nobody can find is a name nobody will use, so
`.../names/browse` is the searchable index of all of them, and
`GET .../names` -- the layer the live board reads -- carries every name
regardless of source.

One trap worth knowing: the startup mirror-rekey moves a name onto the
canonical half of its pair with an `INSERT..SELECT`, and a select that omits
the provenance columns does not blank them, it takes their *defaults*. A
player's name silently became the book's own and lost its author the first time
the server restarted. `TestRekeyingAMirrorPairKeepsWhoNamedIt` is the guard.

## What people actually play

The book says what is good. The statistics say what happens, and the gap is the
interesting part: a move can be RPSFish's third choice and the one four players
in five reach for.

Compiled from `game_pgn` by the server, once a day, in its own goroutine --
not on the lobby ticker, because a compile replays every archived game in the
mode. It recompiles on startup only when the stored set is older than a day, so
a server that was down over a compile does not wait a further day and one
restarted repeatedly does not recompile every boot.

**Every game is replayed under the current rules rather than trusted.** This is
the whole reason the compiler is a replay: the rules changed on 2026-09-03 so
that Blue moves first, where Red used to, so most of the archive is a record of
a game whose opening moves are not legal opening moves now. Counting a stored
move list would have put unplayable moves into the statistics silently.

**A record today's rules refuse is tried again through the rank flip.** Reverse
the ranks and swap the colours and a game Red opened from the top of the board
is the same game with Blue opening from the bottom, which is legal now -- so a
pre-change game contributes the opening it actually played, named from the end
of the board an opener plays from today, and its result is turned with it.

The flip and *not* the half turn, which is worth stating plainly because
reaching for the half turn is what silently dropped an entire mode's archive.
Two things changed on 2026-09-03: the first mover, and Intransitive's board,
which was flipped end for end so that the corner Red runs for moved from i1 to
a1. The half turn is a genuine symmetry of *today's* rules -- that is what
`TestHalfTurnPlaysTheSameGame` pins -- but it carries today's Intransitive onto
itself, and what a pre-change record needs is the map from *yesterday's*
Intransitive onto today's. The two agree on Total War and Infiltration, whose
layouts and rank goals survive reversing files, so the wrong map skipped every
pre-change V6 game and nothing else. See `game/rank_flip.go` and
`TestRankFlipReadsThePreChangeArchive`.

Nothing asks the mode's permission before flipping. The record's own declared
`FEN` is the evidence: it has to flip onto exactly this mode's opening
position, side to move included, or the reading is refused before a move is
replayed. Turned games are counted in `games` and reported in **`turned`**,
because a reader looking at a mode whose archive is mostly pre-change games is
owed the fact that most of the count was read that way.

A game that will not replay either way is **skipped and counted as skipped**,
and the API and the page publish both counts -- showing the games it kept
without saying how many it dropped would mislead by omission.

Three tables' worth of decisions:

- **Every prefix is a row.** A game contributes a row for its first move,
  another for its first two, and so on, so "x% of games follow this path" is one
  lookup and so is "of the games that got here, where did they go next". A game
  contributes at most `OpeningStatsPlies` (12) rows.
- **The parent is stored, not derived.** `parent_key` makes a position's
  continuations an indexed lookup instead of a prefix `LIKE` over the mode.
- **Recomputed whole, never incremented.** Incrementing would be faster and
  would drift: a re-archived game, a rules change, or a half-failed compile all
  leave counters that describe no set of games.

Cohorts are `human` (both players human), `bot` (both bots) and `mixed`, told
apart by `persistence.BotAccountPrefix` on the archived player IDs. `human` is
the default, because bots outnumber humans several to one in the archive and
play whatever book they were handed -- an unqualified "most played openings"
that included them would be a survey of bot configuration.

### Two keys, two questions

The compiler writes the same replay into two shapes, because a line and a
board are different things and neither answers for the other:

| | keyed by | answers |
| --- | --- | --- |
| `opening_stats` | the space-joined line | the most played *openings* |
| `opening_stats_positions` | a hash of the board and side to move | how many games reached *here* |

A line is a path, so `d2-c3 f3-g4` and `f3-g4 d2-c3` are correctly two
different openings. A board is a picture, so those two are correctly one
position with one set of numbers -- which is what somebody standing on a board
is asking, and why the explorer is keyed the second way. In a game where nine
pieces shuffle between adjacent squares, transpositions are most of the tree.

### Reflections are the same picture too

The position key is the **canonical** board under the mode's symmetries, not
the board as played. A mode declares which colour-preserving relabellings leave
it alone (`ModeDefinition.Symmetries`, `internal/game/symmetry.go`), the board
is folded onto the smallest spelling of itself and its images, and that is what
is hashed:

| mode | symmetry | so these are one opening |
| --- | --- | --- |
| V5 Total War, V3 Infiltration | `mirror-files`, reflect across the middle file | `d2-c3` and `f2-g3` |
| V6 Intransitive | `diagonal`, reflect across a1--i9 | `e3-f3` and `c5-c6` |

The declaration is checked in two halves. Registration refuses a mode whose
*layout* is not fixed by a symmetry it claims, and
`TestBuiltInSymmetriesPlayTheSameGame` plays a random game and its reflection
side by side to a finish to check the *win conditions* agree -- which is the
half that is Go rather than data, and the half a mode can be wrong about.
Infiltration races for a rank, which reversing files preserves and transposing
would not; Intransitive races for a1 and i9, which are exactly the two squares
the main diagonal fixes.

Colour-preserving is load-bearing. `RankFlipGrid` and `HalfTurnGrid` also map a
game onto an equivalent game, but they swap Red and Blue, so folding on them
would mix one side's wins with the other's. These leave the side to move where
it is.

Moves are folded with their board. `opening_stats_position_moves` stores the
move named on the *canonical* board, so a game that played `e3-f3` and a game
that played `c5-c6` write to one row rather than two. On the way out the
explorer maps the stored name back into the coordinates of the board the caller
actually walked to, and returns every spelling: `move` plus `twins`. Two
spellings come back exactly when the caller's board is its own reflection --
`e3-f3` and `c5-c6` from Intransitive's opening position are two legal moves
that reach one position, so they are one continuation with one set of counts,
drawn as one arrow and its dashed twin.

The **line** statistics are deliberately not folded. A line is a path somebody
walked, and the "most played openings" list is the answer to that question. The
naming layer folds mirrors separately and on its own terms; see
`opening_mirror.go`.

`opening_stats_position_moves` holds the moves played out of each board. Two
counting rules matter:

- **A board is counted once per game**, however often the game returned to it.
  A line that shuffles a piece out and back has not been reached twice by two
  games, and counting it twice would let one game outvote another.
- **The moves are counted per visit**, because the game really did leave that
  board twice. So the conditional shares out of a repeated position can sum
  past 1. That is not a bug -- the denominator is games that reached the board
  and the numerator is times it was left -- and only a repetition can do it.

`ply` on a position is the **shortest** route anybody took to it, which is what
"four moves in" should mean when several routes exist -- by any move order or
reflection.

`OpeningStatsCompiler` in `persistence/opening_stats.go` versions what a
compile *means*. The daily job is lazy -- it recompiles a mode whose stored set
is over a day old -- so a deploy that changes how a position is keyed would
otherwise leave rows on the page that the new server cannot look up, and the
explorer would report that no game has ever reached any position. A stored set
from an older compiler is recompiled at startup however fresh it is. Bump the
constant whenever a compile would key, count or name anything differently.

## Where the games come from

Every game belongs to exactly one **segment**, and a caller asks for any set of
them:

| segment | what it is |
| --- | --- |
| `human` | this site's archive, a human on both seats |
| `bot` | this site's archive, a bot on both seats |
| `mixed` | this site's archive, bot against human |
| `meaf` | the [meaf.us](https://meaf.us/rps2/) archive: several thousand games of bulk human play from a different server, shared by its operator |

`?segments=human,meaf` and `?segment=human&segment=bot` are both accepted, as is
`?cohort=` for callers written before there was more than one source. `all` means
every segment there is -- which now includes meaf.us, a real change in what the
word covers.

Because the segments partition the games, a set of them is answered by adding
their counts: no game is in two segments, so nothing is double counted, and the
explorer can offer four checkboxes without the server compiling fifteen
combinations. That property is what makes them mixable, and it is the reason
each source gets its own segment rather than being folded into an existing one.
Asking for none of them is an error rather than a default -- the page short
circuits before it gets that far, because every box unticked is a question with
no subject.

The meaf.us export is a fixed asset compiled into the binary
(`internal/meafarchive`), replayed under this server's rules at compile time
like everything else. It is Intransitive only -- meaf.us runs one game -- so the
`meaf` segment is empty under the other modes rather than full of skips.
Refreshing it means replacing `games_export.txt` and deploying;
`TestMeafExportIsReadable` is what says the new file arrived intact.

## The explorer

```text
GET /api/openings/{modeId}/explore?segments=human,meaf&line=d2-c3,d7-c6
```

The caller sends the *line* it walked, never a position key: the server replays
it to reach the board and derives the key itself. A key computed by a client is
one this server could not check, and the rules are what own the answer to "is
that a board". A line the rules refuse is a 400; a legal board nobody has
reached is a 200 with `games: 0`, because that is the honest answer for most of
the tree and the page says "nobody has been here".

The frontend is `features/openings/OpeningExplorerScreen.tsx`, and it is mostly
borrowed: the analysis screen's `Board`, `useBoardSelection`, `usePieceDrag`,
`ReplayControls` and `applyAnalysisMove`. What it adds is the arrows. `Board`'s
`analysisArrows` gained an optional `weight`, so the same component draws two
different claims -- an engine's variations by *rank*, where the order is the
point, and the explorer's continuations by *size*, where the second most
played move may be nearly as popular as the first or a twentieth of it.
Weights scale against the most played move at that board rather than against
1, so a rarely-visited position still shows which of its continuations is the
common one.

An arrow also carries an optional `rank` and `dashed`. A continuation with
`twins` is drawn once per spelling, all at the same rank and so in one colour,
with the twins ghosted and dashed: they are one move that can be played two
ways, and drawing them in two colours at two thicknesses would have the board
contradict the move list beside it. The cap of five is a cap on *ranks*, so a
twin does not cost another continuation its arrow, and the palette holds five
distinct colours for the same reason -- with three, two unrelated continuations
could share a colour and the pairing would stop meaning anything.

With no `line`, one request is the whole condensed dataset for a mode: the
totals, the first-move breakdown with a share on each, and the most played
lines. Shares are computed on the way out from a total the server knows, so a
percentage cannot disagree with the count printed beside it.

`POST /api/admin/openings/{modeId}/stats` forces a compile now.

Suggestions are public because an unnamed line should show what people have
called it, rather than an empty box that gives no sign the question was ever
asked. The bootstrap ships them alongside the names, so a line's proposals are
already on the page. Proposing one is rate limited per IP.

A line's last move only has to be *ranked*, not expanded: a principal variation
ends on the best move out of its final position, and the position behind that
move is the one the scan had not reached. That line is still nameable.

Curator routes use `Authorization: Bearer <admin token>`:

```text
PUT    /api/admin/openings/{modeId}               <RPSFish export JSON>
PUT    /api/admin/openings/{modeId}/names
       {"line":["d2-c3"],"name":"Skipping Stone Opening"}
DELETE /api/admin/openings/{modeId}/names?line=d2-c3
POST   /api/admin/openings/{modeId}/suggestions/{suggestionId}/approve
DELETE /api/admin/openings/{modeId}/suggestions/{suggestionId}
```

Publishing a name -- by naming the line or by approving a proposal for it --
also clears that line's pending suggestions, and only that line's: the queue
means "lines still waiting for a name", and answering one line says nothing
about any other. Removing a name leaves the line unnamed again, which is the
only way out of a name that turned out to be wrong.

Names describe move sequences, like chess openings and variations. An exact
name is displayed as written. Until a branch gets its own name, the closest
named ancestor lends its family name to the last move: `Skipping Stone
Opening: d2-c3`. With no named ancestor the website shows `Suggest a name`.
The import's principal variation is the book's core `mainLine`.

## The board asks too

A game in progress carries the line it is playing, in the book's own notation,
as `openingLine` on every game state the server sends -- capped at
`game.OpeningLineLimit` plies and present only for games that began from the
mode's own starting position, since a line measured from a board somebody drew
would name openings nobody played. The board reads it to show what the opening
is called while it is still being played, and the card at the end of a game
uses it to ask both players to name the line they just played.

The line travels with the position rather than being reconstructed by the
client, because the client cannot: a player who refreshed mid-game and a
spectator who arrived at move twenty never saw the moves that made the opening,
and they are exactly the people the badge is for.

`GET .../names` exists for the same screen. The bootstrap answers the same
question and brings a book's worth of positions with it; a live board wants the
few kilobytes of names and asks for them on every game.

## A bot series asks too

Two engines from one starting position play the same game every time, so a bot
series varies the opening it deals each pair. It used to vary it by walking
random legal moves, which does produce a different board every time -- and a
board nobody has ever played, that the engine has never looked at. Twenty of
those measured twenty curiosities.

So the deal comes out of the book instead: a seeded walk from the root, taking
one of the moves the engine ranked at each position it reaches. Two cuts keep
the result playable. Only the top `openingBookChoices` ranks are candidates,
which matters at the root and almost nowhere else -- an export already keeps
just the best few moves out of every other position, while the root keeps all
23 of V3's, down to scores nobody would open with. And a move scored past
RPSFish's `MATE_THRESHOLD` is refused outright, because a forced win is a
finished game rather than an opening. That second rule is written against the
mate score and not against a window like "within 40 of the best": re-tuning the
evaluation moves every score in the book, and a fitted window would have to be
refitted alongside it with nothing to fail if it wasn't.

A line's last move only has to be one the engine ranked, the same rule
`OpeningLineExists` uses; the moves before it need a position stored behind
them, since that is what the walk steps into. Four edges in ten are frontier
edges, so requiring a child of the last one would throw away most of the book at
exactly the depth an opening ends.

The rules still decide. Every dealt move is replayed onto a scratch game before
the real one is seated, so a move the book lists and this server's rules refuse
fails the walk rather than reaching a board -- the graph is a record of what
some engine build searched, and the server is what owns the rules. A mode with
no imported book falls back to the old random walk, because a book is something
a mode acquires and a new one still has to be able to run a series.

One consequence worth knowing: a seed no longer names an opening by itself, since
a re-imported scan can rank the same position differently. That is why the
archive stores the dealt line and not only the seed.

## Mirror-image lines

Reversing files -- a<->i, b<->h, c<->g, d<->f, e alone -- maps every legal move
onto a legal move and every position onto an equivalent one, for a mode whose
opening layout reads the same right to left. Both shipped modes do, so `d2-c3`
and `f2-g3` are one opening drawn twice, and the graph contains both, because
both are boards a visitor can reach. RPSFish folds them while searching;
`Transform::FILES` in its model is the same fact.

Naming folds them too. A name and a suggestion are stored against the
lexicographically smaller of the line and its mirror, so naming either names
both, and there is no second name to drift out of step. The bootstrap says
`mirrorNaming` so the website can look a name up the same way. Whether a mode
mirrors is asked of the mode, not assumed: a lopsided opening layout would make
its two wings genuinely different openings.

Names written before this rule existed are moved onto the canonical key once at
startup. Where both halves of a pair were separately named, the more recent
name is the one that survives.
