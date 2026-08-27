# Website opening books

RPSFish's append-only `nodes.log` and `paths.log` remain the authoritative
analysis. The website consumes a flat *position graph* derived from them --
`rps-opening-book/v2`. That separation is intentional: the browser sees moves in
the coordinates a player actually used and never needs to reproduce native
symmetry or cycle handling.

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

`V1`, `V3`, and `V5` are the website mode IDs, and are what the book
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
GET  /api/openings/{modeId}/node?line=d9-c8,d2-c3
     one position: its ranked moves, each with the child's turn and depth
GET  /api/openings/{modeId}/names
     the naming layer alone: what lines are called, and the mirror rule
GET  /api/openings/{modeId}/suggestions
     every name put forward and not yet published, oldest first
POST /api/openings/{modeId}/suggestions
     {"line":["d8-c7","d2-c3"],"name":"Skipping Stone Defense"}
```

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
       {"line":["d8-c7"],"name":"Skipping Stone Opening"}
DELETE /api/admin/openings/{modeId}/names?line=d8-c7
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

## Mirror-image lines

Reversing files -- a<->i, b<->h, c<->g, d<->f, e alone -- maps every legal move
onto a legal move and every position onto an equivalent one, for a mode whose
opening layout reads the same right to left. Both shipped modes do, so `d8-c7`
and `f8-g7` are one opening drawn twice, and the graph contains both, because
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
