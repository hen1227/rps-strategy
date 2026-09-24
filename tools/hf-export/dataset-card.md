---
license: cc0-1.0
pretty_name: RPS Strategy game archive
size_categories:
  - 1K<n<10K
tags:
  - games
  - board-games
  - game-records
  - pgn
  - self-play
configs:
  - config_name: default
    data_files:
      - split: train
        path: data/**/*.parquet
---

# RPS Strategy game archive

Every finished game played on [RPS Strategy](https://api-rps.henhen1227.com),
updated once a day. Complete records: every move, both clocks after every
action, draw offers and time extensions, and how the game ended.

**The games are not my invention.** Intransitive, Total War and Infiltration
were designed by WebGoatGuy, who runs the original implementation at
[meaf.us/rps2](https://meaf.us/rps2/). This site is a fan implementation, and
this data set is games played on it. Games from meaf.us's own server are *not*
included here — they are Meaf's to publish.

## Loading it

```python
from datasets import load_dataset

games = load_dataset("Henhen1227/rps-strategy-games", split="train")
print(games[0]["pgn"])
```

The `pgn/` directory carries the same games as gzipped PGN text, for tooling
that would rather read that than a dataframe.

## What a row is

One finished game. The `pgn` column is self-sufficient — it replays without
anything else in the file — and the other columns are there so you can filter
without parsing it.

| column | type |
| --- | --- |
| `game_id` | string |
| `mode_id`, `mode_name` | string |
| `red_player`, `blue_player` | string |
| `red_key`, `blue_key` | string |
| `players` | string |
| `opener` | string |
| `pgn_dialect` | int64 |
| `winner_color`, `outcome`, `end_reason`, `termination` | string |
| `event` | string |
| `ranked` | bool |
| `tournament_id`, `series_id`, `opening_seed` | string |
| `book_plies` | int64 |
| `red_elo`, `red_elo_after`, `blue_elo`, `blue_elo_after` | int64 |
| `ply_count`, `initial_time_ms`, `increment_ms` | int64 |
| `started_at_unix_ms`, `finished_at_unix_ms` | int64 |
| `pgn` | string |

### Three columns worth reading before you use this

**`opener` — the rules changed on 2026-09-03.** Blue moves first now; Red moved
first before. Both sets of games are in here, and mixing them is the mistake
this column exists to prevent. Filter on `opener == "blue"` for games under
current rules. `pgn_dialect` is a *different* fact — a move-numbering
convention, where dialect 1 numbered pairs by colour and dialect 2 numbers by
whoever opened — and both dialects replay correctly. Read `opener` for the
rules, not `pgn_dialect`.

**Two things changed that day, not one.** The first mover, *and* the board,
which was flipped end for end: rank 1 moved to the opener's end and the colours
were renamed with it. Total War and Infiltration are unchanged by that flip —
their openings and their goal ranks are each other's images — so for those two
modes `opener` really is the whole story. **Intransitive is not.** Its opening
is a pair of diagonal wedges that the flip moves, and its goal corners moved
with them: Red raced for `i1` and Blue for `a9` before the change, Red for `a1`
and Blue for `i9` after. Since Intransitive is most of this dataset, that is
worth stating plainly:

- An `opener == "red"` Intransitive game is played on a **different board** from
  an `opener == "blue"` one. Every move in it is still legal under today's rules
  — movement and capture know nothing about colour — so it will replay happily
  and end on the wrong square, or several moves early, without complaining.
  Its `FEN` is the evidence: it is today's opening rank-flipped.
- The map between the two eras is **reverse the ranks and swap the colours**,
  which carries an old record onto today's board exactly. It is *not* a 180°
  rotation. A rotation is a symmetry of today's Intransitive, so it carries the
  current board onto itself and leaves a pre-change record as unreadable as
  before — a mistake that is easy to make and hard to see, because it is a
  correct-looking transform that agrees with itself.
- Simplest safe option: filter to `opener == "blue"` and ignore the rest.

**`players` — `bot`, `mixed` or `human`.** The mix is heavily skewed, and so
are the game lengths:

| `players` | share | median plies |
| --- | --- | --- |
| `bot` — engine vs engine | 77% | 76 |
| `mixed` — engine vs person | 19% | 23 |
| `human` — person vs person | 3% | 51 |

Any statistic over the whole file is a statistic about engine play. Say which
subset you meant. Note that `mixed` games are the *shortest*: people resign
against engines quickly.

**`book_plies` — moves nobody chose.** In bot matches the first few plies are
dealt from a seeded random opening rather than selected by either engine.
Skip them when training or grading: they are not decisions.

## Names and keys

Games finished from **2026-09-09T00:00:00Z** onward carry the usernames they
were played under. Games finished before that instant read `Anonymous player`
on both seats — they were played before the site's privacy policy said games
would be published under names, so publishing them that way would not have been
agreed to.

`red_key` and `blue_key` are opaque per-player identifiers: an HMAC of the
account under a key that is not published. They let you group one person's
games without the key leading back to an account. They are stable across
renames, and a player who deletes their account keeps their key while their
name becomes `Deleted player`.

## What is never in here

No Discord user ID or handle, no account ID, no account key hash, no password
hash, no IP address, and no in-game chat. Nor the internal timestamp recording
when a row was written. The site's
[privacy policy](https://github.com/hen1227/rps-strategy/blob/main/PRIVACY.md)
is the binding version of this list.

## How the files are laid out

```
data/YYYY/games-YYYY-MM-DD.parquet   # the dataset
pgn/YYYY/games-YYYY-MM-DD.pgn.gz     # the same games as PGN text
```

**File dates are publication dates, not play dates.** A file named
`2026-09-11` holds the games first published that day, which is almost always
the games played the day before — but a game the server recorded late lands in
whichever file was next. Sort by `finished_at_unix_ms` for chronological order.

Files are never rewritten. Once a day is out it stays as it was, which is also
why a name removed at the source only changes in files published afterwards:
copies already downloaded cannot be recalled.

## License

**CC0-1.0.** Public domain dedication — use it for anything, no permission
needed and no attribution required. Game records are records of facts, and this
makes that explicit rather than asserting a copyright over them.

Attribution is welcome but not required. If it is useful to you, I would enjoy
hearing about it.

## Known limitations

- Two rule sets are present; see `opener` above.
- Bot and human games are mixed; see `players` above.
- Compiled opening statistics are not published here.
- Games interrupted by a server restart are excluded — only finished games are
  in the file.
- Modes are lopsided: Intransitive (`V6`) is almost everything, with a few
  hundred Infiltration (`V3`) and Total War (`V5`) games.
- Every game carries before-and-after ratings, including unranked ones, where
  the two are simply equal. `ranked` is the column to filter on, not the
  ratings.
