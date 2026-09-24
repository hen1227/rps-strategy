# Game review

After a game ends, its players are offered a review: the game replayed move by
move, with the score sheet, the clocks, and a board you can play your own lines
out on. Switch the engine on and every move is graded against RPSFish as well,
with an evaluation chart across the whole game and an accuracy percentage for
each side — but it ships off, for the reason set out under "The engine is off
unless you ask for it". It runs on the archived PGN, so anything the archive
holds can be reviewed — ranked, unranked, tournament, or a bot game the server
never saw.

Everything below the storage section happens in the browser. The server hands
over a text record and, later, accepts a number back; it does not search a
single position.

## Getting there

The result card at the end of a game leads with **Review this game**, and a
finished board keeps a **Review** button next to **Modes** so the offer
survives dismissing the card. Both are hidden for a game with no moves in it.

Reviewing does not end the session. `clearGame` is what closes a finished
game's chat room, and the review screen deliberately does not call it: for an
online game the room stays open, the opponent and any spectators stay in it,
and the chat sits under the board while both sides go over what happened. The
app-level rule that a live game takes the screen is relaxed for this one route
for the same reason.

A stored game is addressed by id — `/review?gameId=…` — so the review of one is
a link like any other page's. The record card offers it as **COPY GAME LINK**
beside **COPY PGN**, every row of a player's history on the account page offers
the same address as **COPY LINK**, and both build it through `gameReviewURL` in
`frontend/src/navigation/links.ts`, which is the one place that knows the
route's whole address. Nothing about the link is private: the archived record is
served by id to anybody who asks, and the review runs in the reader's own
browser, so an opponent, a coach or a stranger who opens it gets the same game,
read on their own terms — without an account, and without having played in it.
Whether it is *graded* is their own device's business; see "The engine is off
unless you ask for it".
Accuracy is still only *stored* for a player who was in the game, which is why
`putGameAccuracy` takes a profile key.

A bot game has no server record at all, so the browser writes one:
`store/botSession.ts` keeps the move list and `botGamePGN()` encodes it in the
archive's own dialect (`engine/pgn.ts`). One review screen therefore reads one
format.

## Navigating

Left and right arrow keys step through the game; up/down and Home/End jump to
either end; the move list and the evaluation chart are both clickable.

The record is the **main line**. Playing a move that is not the recorded one
opens a private branch from that point, and the branch is analysed live. The
rule for leaving it is simple and is the one the arrow keys make you expect:
**stepping back to the branch point discards the branch**, so pressing right
again continues the game that was actually played. Playing the recorded move by
hand is not a deviation — it just advances.

**Play the engine move instead** on a graded move takes the position back one
step and plays the engine's choice there, because the move being graded is the
one that led into the position on screen.

## The engine is off unless you ask for it

A review opens with RPSFish switched off, and so does the analysis board.

The reason is the engine's strength, not the feature's cost. RPSFish is weaker
than most of the bots people actually play here, so its verdict on one of their
games is frequently wrong — and it is wrong in the worst register available,
because a grade is printed in a confident badge and read as a fact. `??` under a
move that was fine is worse than no badge at all: the reader either believes it
and learns something untrue, or stops believing the badges, which costs the
right ones too. Until the engine is strong enough to be believed against the
field it is grading, the honest default is what a review was before engines —
the game, replayed, with the reader doing the judging.

What a review is with the engine off:

- the board, stepped through with the arrow keys, the replay controls or the
  score sheet
- the score sheet, ungraded: the moves that were played and which one you are
  standing on
- how long the player spent on the move in front of you, off the record's own
  clocks — the one thing a review can say about a move without searching it, and
  worth saying, because a mistake made in half a second and one made after two
  minutes are different mistakes
- your own lines, played onto the board from any position and discarded by
  stepping back, exactly as before but unanalysed
- the territory and quiet-move meters, which read the board rather than the
  engine
- the PGN, the game link, the series table, and the chat room

What it is not: an evaluation bar, an evaluation chart, engine arrows, move
grades, accuracy, ranked lines, or *play the engine move instead*. Those are
**absent rather than blank**. A chart with no line in it and an accuracy reading
`—%` would say the review had failed, which is a different claim from the one
being made.

Turning it on is one press — **ENGINE**, in the review's header or in the
analysis board's own control row — and all of it comes back. The effort toggle
sits beside it and is hidden while it is off, because a depth readout for a
search nobody is running is furniture for a thing that is not there.

The choice is remembered per device (`store/enginePreference.ts`, under
`rps.engineAnalysis.v1`), because somebody who wants the grades should ask once
rather than once a game. It is deliberately *not* part of the account's synced
appearance: it says how far you trust the build of the engine in front of you,
which is a property of the machine you are holding rather than of you.

Three consequences worth stating:

- **An ungraded review stores nothing.** `putGameAccuracy` is only ever sent
  from a completed graded report, so a manual review cannot overwrite an
  accuracy some earlier graded one measured.
- **`enabled: false` beats an unsupported mode.** `useGameAnalysis` and
  `usePositionAnalysis` both ask `enabled` before they ask
  `engineUnavailableMessage`. A reviewer who switched the engine off is not
  waiting to hear which modes it would have refused, and an error banner saying
  so would read as a fault rather than as a mode.
- **The analysis board still moves.** Its pieces used to wait for
  `engineState === 'ready'`, which with nothing searching never arrives. Both
  that gate and the one in `performMove` now apply only while the engine is on;
  off, the board is a study board — position setup, reach maps, undo and redo,
  and both sides yours.

The bot battle is not covered by any of this. Its players *are* RPSFish, at
rungs the grading walk outsearches, so the engine grading them is the engine
grading itself — the one comparison it is qualified to make — and a screen whose
entire purpose is a graded game would have nothing left to show. It opens
graded, as it always did.

## How RPSFish is used

### One walk, wherever a game is graded

Three screens grade games — the review, the bot battle, and the analysis board —
and all three run the same walk, through `engine/gameAnalysis.ts`. A session
there is handed a line of play as it currently stands and keeps the engine
walking whatever part of it has not been graded yet. What differs between the
screens is only how the line arrives:

| Screen | How the line arrives |
| --- | --- |
| Review | whole, once, from the archived record |
| Bot battle | a move at a time, while the game is still being played |
| Analysis board | grows and shrinks, as moves are played, taken back, replaced |

`hooks/useGameAnalysis.ts` is the React binding, and it returns the report
`summarizeReview` builds plus how far behind the game the walk is. Nothing else
grades a move. In particular a bot's own search never does: it is shallow on
purpose, and a different depth on each side of the board, so it says what that
bot thought rather than what was true.

### One request, one walk

A run of positions is one `review` request to the analysis worker
(`engine/rpsfish/client.ts` → the worker built from `engine/rpsfish/worker/`,
which shares its message types with the client). The worker
owns the walk instead of being driven one position at a time, which buys two
things:

- **The transposition table is never cleared.** Every position in a game is a
  child of the one before it, so the table stays valid for the entire walk.
  Measured over 41-position engine-quality games: **1.18–1.22× less time and
  1.14–1.23× fewer nodes** than analysing each position from scratch. On games
  of random moves the saving shrinks to about 1.1×, because a random move's
  subtree was never searched deeply enough to be worth reusing.
- **Repetition history is extended, not rebuilt.** ABI 4 adds
  `rpsfish_history_len` and `rpsfish_history_truncate`, so each step pushes one
  position instead of re-pushing every earlier one. That turns quadratic work
  over the length of a game into linear work.

Results stream back per position, so the report fills in from the first move
rather than after the last.

A request also names the first position it wants graded (`analyzeFrom`), which
is what lets a game be graded while it is still being played. Everything before
that index is still sent — the walk needs it for repetition — but is not
searched again, and when the engine is already standing exactly there, which is
the normal case because a live game's requests arrive as a growing prefix,
neither the table nor the history is rebuilt. A game graded in ten instalments
therefore costs what grading it in one costs; `src/engine/gameAnalysis.test.mts`
asserts that the two produce identical scores, position by position.

**The position a game is currently at is not graded while the game is still
going.** It has no move out of it yet, and grading it would produce an entry
carrying an evaluation but no played move — so the move eventually played from
it would read as ungraded for the rest of the game. It is graded when its move
arrives, or when the game ends and it is genuinely the last position.

### Two engines, so a game and its analysis do not queue behind each other

The WASM search is synchronous, so a worker inside a search cannot answer
anything else until that search returns — including a request to cancel it.
Everything sharing a worker therefore takes turns, and `engine/rpsfish/client.ts` runs
two **lanes**, each with a worker of its own:

- The **interactive** lane answers whoever is looking at a position right now:
  the analysis board, the hint button, and a bot deciding its move. Searches
  are short, and the newest is usually the only one still wanted, so a position
  change pre-empts (`analyzePosition`) while a bot move and a hint queue
  (`analyzeExclusive`).
- The **review** lane grades games (`reviewGame`), queued. A deep review is
  minutes of work, and a walk that climbs to the deepest rung is several passes
  of it; it must not be torn down every time a bot thinks, and the bots must not
  wait for it.

Two lanes is what makes a watched game watchable, and it also removes a
compromise from the review screen: a branch played off the record is now
analysed pre-emptively on the interactive lane, rather than queued behind a
review it would have destroyed.

### Grading a move against the best move

A move's loss is the difference between the best move's score and its own, and
subtracting two numbers is only meaningful when both were produced the same
way. Two separate searches of the same position, both correct, still disagree
by a few points, because a fixed depth is only fixed until the transposition
table starts answering from a deeper one.

So the review never crosses searches:

1. Search the position with MultiPV 3. If the played move is one of the three
   returned lines, its score and the best line's score came out of the same
   search and the loss is exact.
2. Otherwise, run one more search of the same position **restricted to
   {best move, played move}**. Both are scored under one window, one table, one
   ordering, and the loss is read off that pair rather than across the two
   searches.

Step 2 is what the engine change is for. `Searcher::analyze_root_moves` takes a
list of root moves and considers only those; the WASM boundary exposes it as
`rpsfish_root_filter_clear` / `rpsfish_root_filter_push`, spent by the next
`rpsfish_analyze`. Two invariants make it safe, and both are tested in
`RPSFish/src/search.rs`:

- A restricted search **stores no transposition entry for the root**. It did
  not look at every move, so its verdict is not the position's verdict, and
  leaving it behind would let a later search take a cutoff on a number that was
  never true.
- A restriction whose moves are all illegal returns `NoLegalMove` with no
  lines, so asking about the wrong board is an answer rather than a guess.

The alternative — scoring the played move by searching the position it leads to
— was rejected because it measures the move one ply deeper than the alternative
it is being compared with.

### Budgets

Per position, from `REVIEW_PRESETS` plus the deepest rung in
`engine/analysisBudget.ts`:

| Rung | Depth | Nodes | Time | MultiPV | ~60-position game |
| --- | --- | --- | --- | --- | --- |
| Quick | 6 | 200k | 0.6s | 3 | under a second |
| Standard | 9 | 700k | 2.0s | 3 | a few seconds |
| Deep | 12 | 4M | 8s | 3 | up to about a minute |
| Deeper | 16 | 20M | 20s | 3 | a few minutes |

Measured on 60-position games: at MultiPV 3, depth 8 costs ~40ms per position
in Total War and ~35ms in Infiltration; depth 12 costs ~600ms and ~300ms. Two
more plies cost four to five times the work.

### Nobody picks one

These are rungs, not settings. The review screen used to open with a row of
three depth chips, and that was the wrong question to ask: the right depth
depends on the machine the reviewer is holding, which they cannot see, and on
how long the game is, which they have not counted. Picking too low meant
reading grades a deeper search would have overturned; picking too high meant
waiting for depth the position did not need.

So the walk climbs the ladder itself. `createGameAnalysis` grades at the
shallowest rung first — grades reach the screen in about a second — and then,
once every move has one and the line has held still for `ANALYSIS_SETTLE_MS`,
regrades **the entire line** at the next rung and swaps the deeper report in
when it completes. It keeps going until the ladder runs out or the clock says
the next pass will not fit.

Two things decide how far it gets, and only one is a guess:

- A coarse device tier — `low`, `medium`, `high` — from core count and the
  memory figure Chromium will admit to, or `medium` flat in the native app,
  which reports neither. It sets ceilings only: how many rungs exist and how
  long the whole climb may take (35s, 60s, 90s).
- Measurement. Each completed pass is timed, and the next one is projected from
  that measurement scaled by the ratio of the two rungs' time ceilings. That is
  the pessimistic reading, since most searches finish on depth rather than on
  their ceiling, and it is the right direction to be wrong in: overestimating
  costs a rung the device could have managed, underestimating costs a pass that
  gets abandoned. A machine that turns out to be fast climbs further without
  ever being asked what it is.

The projection can still be wrong, so the budget has a hard backstop: a pass
that overruns is aborted and the report it would have replaced stays. **An
overrun costs background time, never a grade.**

A deeper pass never publishes a partial result. Rule 2 above is that a move's
loss comes off one search of one position; the report-wide corollary is that
every move in one report must come off the same budget, or the accuracy
averaged across them is comparing two searches. So a deeper pass accumulates
out of sight and replaces the report atomically. `refining` on the snapshot is
how a screen says a better answer is on its way, and `pass` and `limits` are
what the numbers currently on screen actually mean — every screen states the
depth beside the grades for exactly this reason, because a grade that changes
under the reviewer needs to be explicable rather than doubted.

What is left is one switch, **QUICK**: a single shallow pass and no deepening,
for a reviewer who wants a number now and does not care that a deeper search
might revise it. It sits beside **ENGINE**, and only appears once that is on —
two switches, in the order the questions are actually asked.

MultiPV 3 rather than 1 costs about twice as much per position and pays for
itself twice. The reviewer gets alternatives to look at, and the played move is
usually already among the returned lines — 49 of 61 positions in the measured
Total War game and 32 of 48 in the Infiltration one — so the paired search in
step 2 is often not needed at all.


### Moves nobody chose

A bot series starts each pair of games from the same opening, dealt out of the
published book, so that two engines are compared across varied positions rather
than one. Those
plies are dealt, not played, and the record says how many in its `BookPlies`
tag.

The review still evaluates them — leaving a gap in the evaluation chart would
be worse than useless — but marks them *book* in the move list and leaves them
out of both accuracy figures. Grading a move nobody made is a claim about a
player that is not true, and in a series the dealt moves are frequently bad
ones, so counting them would systematically understate every engine.
## Watching two bots, graded

A bot battle is the same report as a review, produced while the game happens.
The screen shows the evaluation bar and chart, a grade on every move, RPSFish's
lines for the position on screen, and an accuracy for each bot — all from the
walk above, none of it from either bot's own search.

Its walk's *floor* is Deep, and that is why the analysis runs behind the board.
Deep is depth 12 with an eight-second ceiling per position, and a position whose
played move needs the paired search costs two of those. The ladder's own
searches are capped at depths 2, 3, 4, 7, 11 and 19 with one- to four-second
budgets, and every rung but the top costs single-digit to low-hundreds of
milliseconds. So a graded position costs more than any bot's move and far more
than most, and the report trails the game by however many moves that adds up
to — measured at ten to twenty in a fast Total War game. The status card says
how far behind it is, ungraded moves say so rather than showing a grade, and
the evaluation line stops where the walk has got to.

A floor, and not the shallowest rung, because this is the one screen where
starting shallow is not an option — see the next paragraph. It climbs above
Deep the same way every other walk does, but only once the board stops moving:
deepening a game that is still arriving move by move only throws the work away,
which is what `ANALYSIS_SETTLE_MS` is for. So a battle is graded at depth 12
while it runs and regraded deeper once it is over. QUICK is on this screen too,
and drops it to Standard — the reviewer overriding the floor knowingly.

The alternative was to grade at a budget the bots can outrun, and it is worth
saying plainly why that is not a real option. Before this, the screen reused
whatever each bot's own search had returned. That meant:

- The evaluation line alternated between the two bots' opinions, one ply apart,
  so it moved with the strength gap between them rather than with the position.
- A move was graded against the best move of a depth-2 or depth-4 search, so a
  "Best" badge meant "the weak bot agreed with itself".
- A weak profile asks for one candidate line, so the played move was usually not
  in the returned lines at all. Its score was then taken from the *next*
  position's search with the sign flipped — two different searches, at two
  different depths, one of them a ply deeper than the move it was compared
  against. That is the comparison this document's whole first half exists to
  avoid.

Bots also no longer search on a move their profile decided at random. That was
only ever there to keep the chart and the grades complete, and the walk does
that now.

Accuracy still appears only once every move of a side has a grade, for the
reason it always has: the mean of the first ten moves of a game is not that
player's accuracy. On a watched game that means it fills in at the end.

## From an evaluation to a number

### Expected score, measured

Centipawns are the wrong currency for judging a move. Fifty centipawns is a
catastrophe in a level position and noise in a won one, and a review that
grades on raw loss says the opposite. Everything a player sees is therefore
computed from **expected score** — the share of a point the side to move can
expect from here — rather than from the evaluation directly.

The conversion is a logistic, `1 / (1 + exp(-k · score))`, and `k` is measured
rather than chosen. `frontend/scripts/reviewCalibration.mts` plays games with
the shipped engine, sampling among its own top moves so that both good and bad
positions occur, records the evaluation at every position, and fits the `k`
that best predicts the result those games actually reached. Games are scored as
expected points, so a draw is half; games that hit the ply cap are discarded
rather than counted as draws.

From 150 games per mode at depth 8 (seed 20260821):

| Mode | `k` | 75% expected score at | Games |
| --- | --- | --- | --- |
| Total War (V5) | 0.003848 | 286 cp | 75 / 19 / 51, 5 discarded |
| Infiltration (V3) | 0.004949 | 222 cp | 71 / 0 / 79 |

The fitted curve tracks the empirical expected score closely through the middle
of the range and in the decided tails. Two caveats are worth stating: positions
within a game are correlated, so the effective sample is 150 outcomes rather
than the ~14,000–23,000 positions they contain; and the curve describes *this
engine at this strength* converting *this* advantage, which is exactly the
question a review is asking.

Re-run the script after any evaluation change:

```sh
cd frontend
npm run calibrate:review -- --games 150 --depth 8 --plies 400
```

and put the fitted values into `WIN_PROBABILITY_SCALE` in
`frontend/src/engine/gameReview.ts`. They are measurements, not preferences.

#### The fitted scales are overdue a re-measurement

Re-running the script as a control — same protocol, same shipped weights,
nothing changed but the seed — does not reproduce the values in
`WIN_PROBABILITY_SCALE`:

| Mode | Shipped | Seed 6180339 | Seed 1414213 | Positions |
| --- | --- | --- | --- | --- |
| Infiltration (V3) | 0.004949 | 0.008216 | 0.007020 | 6,266 / 5,912 |
| Total War (V5) | 0.003236 | 0.004117 | — | 31,136 |

Two fresh seeds agreeing in direction is the bar this file sets for believing a
shift, and Infiltration clears it: both are far above the shipped figure and
within 16% of each other. Total War moved the same way on one seed, +27%.
Every fresh fit reads higher than what is shipped, which would mean the review
currently reads every loss as *smaller* than the games say it is.

Do not act on that yet, and in particular do not reach for the obvious
explanation. Total War's run produced 31,136 positions against the ~30,600
recorded for its last re-fit — the same sample, from the same protocol — and
`k` still moved 27%. So "the games got shorter" does not account for it, even
though Infiltration's position count is now well down on what this file
records. That leaves a genuine evaluation change and the script's own seed
noise, and one seed per mode cannot separate them.

What is needed is two seeds for Total War as well, and an explanation for the
direction. Re-fitting moves every accuracy figure for the mode, including the
ones already stored against archived games in `game_accuracy` — which records
the engine budget a number came from but not the scale. So this is recorded
rather than applied.

#### A mode with no fit of its own

`scaleFor` falls back to Infiltration's curve for a mode that has none, and it
does that **silently**. This is the number that says how many points of
expected score a centipawn is worth, and every grade and every accuracy on the
screen is downstream of it, so a borrowed one tilts a whole report at once —
every move in the same direction, by roughly the same factor.

Intransitive spent its whole life so far in that state. It was added to
`ENGINE_MODE_CODES`, the review started grading it, and nothing said the curve
underneath was somebody else's — while it became the mode nearly every game on
the site is played in.

Which direction that tilts Intransitive is not known yet, and is not worth
guessing: the two fitted modes differ by more than 50% in `k`, so a mode
borrowing one of them could be off by that much either way. Measure it. What
is already clear is that it compounds with the band widths above rather than
cancelling them, because a scale that is wrong in one direction and a boundary
drawn in the wrong place are independent errors in the same arithmetic.

`UNCALIBRATED_MODES` now names the modes in that state, and
`gameReview.test.mts` fails if a mode the engine will search is neither fitted
nor named there. A new mode therefore arrives with a fit or with an
acknowledgement, and never again with a borrowed curve nobody mentioned.

#### Intransitive cannot be fitted by self-play

The obvious next step is to run the script on it. That does not work, and the
way it fails is worth writing down, because it produces a number rather than an
error:

| Seed | Outcomes over 150 games | Fitted `k` |
| --- | --- | --- |
| 6180339 | 0 decisive, 145 draws | 0.000010 |
| 1414213 | 4 decisive, 140 draws | 0.001208 |

The engine draws itself in Intransitive essentially always. With no decisive
results there is nothing for a logistic to predict: every score bucket in the
calibration table comes back with an actual expected score of exactly 0.500,
and the likelihood is maximised by the flattest curve available, so the first
fit simply pinned at the lower bound of its own bracketing interval. The
evaluation never moves either — 21,782 of 32,166 positions sat within two
pawns of level, and none at all past 200 centipawns. The two seeds disagree by
a factor of 120.

Either number taken at face value would be much worse than the borrowed curve
it replaced: both are far flatter than Infiltration's, so every loss in the
mode would convert to approximately nothing and a review would grade an entire
game Excellent. **A degenerate fit here is not a null result, it is a
plausible-looking constant.** Hence the note in `UNCALIBRATED_MODES` rather
than a command to run.

Real Intransitive games are not drawish — 44 archived records sampled for the
band measurement above were every one of them decisive, and a bot's recent 40
came in at 17/20/3 with most games ending by corner. So the signal exists; it
is self-play at this strength that has none. Fitting the mode means fitting it
from the archive — take the evaluation at each position of a stored game and
the result that game actually reached — which is the source
`reviewStability.mts --pgn` already reads and `reviewCalibration.mts` does not.

### Move grades

A grade is the expected score, in percentage points, that a move gave away:

| Badge | Grade | Points given up | Which is an accuracy of |
| --- | --- | --- | --- |
| `★` | Best | the engine's own choice, or nothing at all given up | 100 |
| `!` | Great | the engine's choice when line two gives up more than 20 points | 100 |
| `✓` | Excellent | up to 5 | 80 or better |
| `!?` | Good | up to 11 | 60 to 80 |
| `?!` | Inaccuracy | up to 20 | 40 to 60 |
| `?` | Mistake | up to 34 | 20 to 40 |
| `??` | Blunder | more | under 20 |

The punctuation follows familiar chess-review notation, while Best and
Excellent use neutral symbols because traditional notation has no separate
marks for those engine categories.

#### The bands are the accuracy scale, in fifths

That last column is not a coincidence and not a table: it is where the bands
come from. Each grade is one fifth of the accuracy curve above, and the
boundaries are computed by reading that curve backwards
(`lossForAccuracy` in `gameReview.ts`), so a grade means something a reader
can state without looking anything up — **an Excellent move scored 80% or
better, a Mistake scored between 20 and 40, a Blunder scored under 20.** A cut
point and the accuracy it corresponds to cannot drift apart, because only one
of them exists in the source.

They used to be 2 / 5 / 10 / 20 points of loss, which on that same curve is
91 / 80 / 64 / 40 percent: three of the five bands crowded into the top third
of the scale, and the first boundary drawn at a loss of 2 points. That last
one is what made the review unreadable, and it took a measurement to see why.

`frontend/scripts/reviewStability.mts` measures how far RPSFish disagrees with
itself, the way `reviewCalibration.mts` measures the win-probability scale:
play games, grade each one at *every* rung of the shipped ladder, and compare
each move's loss against the deepest opinion the engine has. Run it after an
evaluation change, for the same reason:

```sh
cd frontend
npm run measure:stability -- --games 30 --plies 90 --mode V5 --top deep
```

The loss *numbers* turned out to be tolerable. Over 521 positions of
Infiltration, the shallowest rung differs from the deepest by a median of 1.7
points, 4.8 at the third quartile, 11.5 at the 95th. The *classes* were not
tolerable at all:

| Rung read at | Badges that changed class | Condemned, then cleared |
| --- | --- | --- |
| Quick (d6) | 40.5% | 29.7% of 91 |
| Standard (d9) | 34.0% | 28.4% of 105 |
| Deep (d12) | 28.4% | 25.7% of 105 |

"Condemned, then cleared" is the column that matters: a move the review called
a Mistake or a Blunder, which a deeper search of the same position says was
neither. Close to a third of the accusations in the review were ones the engine
itself withdrew on a longer look — and the reader was never going to see the
longer look, because how far the ladder climbs is decided by
`analysisBudget.ts` from core count, so a `low` device stops at Standard.

Those two findings are only compatible because of where the boundaries sat.
Three quarters of the moves in a measured game lose less than two points, so
the Excellent/Good boundary was drawn at 2 with a typical error of 5, in the
exact part of the range where almost every move lands. It was not sorting
moves. It was sorting which rung the reader's device happened to reach, so the
same game graded on a laptop and on a phone disagreed about most of itself.

`ENGINE_LOSS_ERROR_BAR` holds the measured typical figure and
`ENGINE_LOSS_ERROR_TAIL` the 95th percentile; `gameReview.test.mts` fails if
any band is narrower than the first or if either accusing band starts inside
one and a half times the second. The quintiles clear both at every boundary,
which is worth stating as luck rather than as design: the two were derived
independently and only one of them is a measurement.

#### What this fixes, measured on real games

Both schemes scored on the same positions: 20 archived Intransitive records,
1,249 moves, graded at Quick and Standard and checked against Deep. Use real
records for this and not the script's synthetic games — see `playGame` on why.

| Scheme | Read at | Grade changed | Condemned, then cleared |
| --- | --- | --- | --- |
| 2/5/10/20 | Quick | 29.3% | 21.2% of 170 |
| 2/5/10/20 | Standard | 19.6% | 9.8% of 153 |
| quintiles | Quick | **14.3%** | **2.3% of 129** |
| quintiles | Standard | **9.5%** | **3.0% of 134** |

Grade instability halves. The withdrawn accusations — the column that matters —
fall from 36 moves to 3 at Quick, and from 15 to 4 at Standard.

That is a larger improvement than "fewer badges" would explain, and the reason
is in the shape of the distribution rather than in the count. Intransitive's
losses are strongly bimodal: median 0.4 points, third quartile 3.2, then
37.2 at the 90th. Almost every real condemnation in the mode is a decisive
position — a tenth of all moves are Blunders under either scheme, and those are
*stable*, because a position that is lost at depth 9 is still lost at depth 12.
What the old `mistake` band at 10–20 caught was the unstable middle, and the
error bar there is the size of the loss itself:

| Loss, at Deep | 0–3 | 3–6 | 6–10 | 10–15 |
| --- | --- | --- | --- | --- |
| p90 disagreement, Quick vs Deep | 3.3 | 5.5 | 6.6 | **13.6** |

A twelve-point loss that the engine's own deeper search disagrees about by
thirteen points is not a measurement of anything. Moving that range into
Inaccuracy is most of the gain, and it is why the accusing bands start where
they do.

**The bands still do not make one accusation trustworthy.** They move the
lines to where the engine is actually able to tell two moves apart, which is a
different thing from the engine being right, and the gap between those is the
engine's strength against the field it is grading. Until that closes this is
the honest trade — the same argument, at a finer grain, as the one for shipping
with the engine switched off.

Two things the measurement cannot see, which is why the accusing bands sit far
out rather than just outside the error bar:

> The error bar only measures the engine disagreeing with a deeper version of
> itself. RPSFish is weaker than most of the bots on this site, so the move it
> names as best is sometimes not the best move, and a loss measured against a
> wrong baseline is wrong by however much the baseline was. There is no way to
> measure that from inside the engine. The response to an error you cannot
> measure is margin, not precision.

None of this touches an accuracy figure. Accuracy is that curve applied to the
loss; these are cut points on the same curve, and a cut point is not an input
to the number being cut. What changed is which word is printed over a move.

A Great Move is deliberately strict, and stricter than it was: MultiPV is
ordered, so when line two is already a mistake, line one is the only move the
engine thinks is playable. It used to ask only that line two be less than
Good. `!` rests on more of the engine's opinion than any other badge — on the
score of a move nobody played, *and* on MultiPV having ordered the
alternatives correctly — and the same script finds the engine's own first
line changes between the shallowest rung and the deepest on one position in
eight. A badge resting on that much needs the widest margin on the list, not
the narrowest.

#### And no false precision

A loss is printed in whole points. "10.1 points of expected score given up"
reads as a measurement to a tenth of a point from a search whose opinion of
that same move moves by two points between depths; the tenths were never
information, and printing them invites a reader to rank two moves the engine
cannot separate. `formatLoss` in `gameReview.ts` is the one place that decides
this, so the review, the analysis board and the bot battle cannot drift apart
on it. Each of those three also now names the depth the verdict came off,
which they previously did only for the engine's own choice.

### What the evaluation chart marks

Mistakes and blunders, and only the few of them the chart has room to say
clearly. The rule is `frontend/src/features/analysis/chartMarks.ts`, tested
next to it; the chart itself only decides where to draw what that returns.

It used to badge every `great`, `mistake` and `blunder` in the game, which was
the right idea and the wrong amount of it. On an eighty-move game between
imperfect players it produced around twenty badges on one chart, arriving in
clumps of four that overlapped each other and hid the curve they were
annotating. An overlapped badge is worse than an absent one — it hides one
verdict and misreads the one drawn on top of it — and a chart with a badge on
a quarter of its moves has stopped being a picture of the game.

Three rules, in the order they apply:

- **Errors only.** A compliment is not a turning point. `great` also makes the
  strongest claim any badge makes — that no other move in the position was any
  good — which is the claim this engine is least able to support, so it is the
  last one worth printing in two places. Every grade is still on every move in
  the score sheet, which is the list, and lists can afford one mark per row.
- **A budget, spent worst-first.** However long a game is, the moments that
  decided it are a handful: at most six on a desktop review and two on a
  phone, and they go to the costliest moves. Spare budget is never a reason to
  draw a seventh.
- **No overlaps.** A mark is dropped if it would land within a badge's width of
  one already taken. Because the budget is spent worst-first, what survives a
  clump of four consecutive mistakes is the worst of the four.

The last two rules are separate on purpose. Spacing alone would still allow
thirty legible badges across a wide chart, and thirty legible badges is still
not a picture of anything.

### Accuracy

Per move, Lichess's published curve, on the points given up:

```
accuracy = 103.1668 · exp(-0.04354 · pointsLost) - 3.1669
```

with the result clamped to 0–100. The constants are Lichess's, unchanged,
deliberately. The curve's input is expected-score points, which are already
game-independent once the conversion above is calibrated for this game, so
borrowing a curve people have compared their own games against for years beats
inventing one nobody has seen.

Per game, also Lichess's formulation: the mean of

- a **volatility-weighted mean**, where each move is weighted by the standard
  deviation of expected score over a sliding window around it, so a move played
  where the game was actually being decided counts for more than one played in
  a dead position, and
- a **harmonic mean**, which refuses to let a run of forced recaptures bury a
  single game-losing move.

The harmonic mean is why one catastrophe can cost twenty points of game
accuracy. That is the intended behaviour, not a bug: a game you threw away is
not a game you played accurately.

Average centipawn loss is also reported, with both scores pulled back to the
score at which the side is already expected to take 95% of the point
(`decisiveScore`) before subtracting. Without that clamp a single missed forced
win, nominally worth tens of thousands of centipawns, would be the entire
average.

## Storing an accuracy

A completed review of a game the viewer played is sent to the server once:

```text
PUT /api/games/{gameId}/accuracy      Bearer: local profile key
GET /api/games/{gameId}/accuracy
```

The body carries the colour, the accuracy, the average losses, the grade
counts, and the engine budget it was measured with. The server does **not**
take the colour's identity from the request: it reads who played that colour
out of the archived game and requires that account's profile key, so a client
can only ever report its own side of a game it actually played. An account that
has never claimed a key authorizes nothing here — claiming is something
connecting and editing a profile do, and quietly claiming an account because
somebody reviewed its game would be a way to take it.

Reviews live in their own `game_accuracy` table rather than in the PGN column,
keyed by `(game_id, color)`. The PGN stays the whole game on its own, and a
game nobody has reviewed has no row rather than a blank one. `GET
/api/games/{id}/pgn?format=json` and the per-account game list carry whatever
reviews exist alongside the record.

Reviewing again replaces the stored number, so a deeper review can correct a
shallower one, and the stored engine budget says which review a number came
from.

**The number is a claim, not a verdict.** It is computed in the browser by the
engine build the player was watching, and the server records the claim. That is
acceptable only because nothing depends on it: no rating, no matchmaking, no
ranking reads this table. The reporter and the engine settings are stored so a
later server-side recomputation can be compared against what a client said.

## Notation

Reviewing a stored record made two long-standing frontend/backend
disagreements visible, and both were resolved in the frontend's favour of the
archive, because the archive is the record and the app is a view of it.

- **Squares.** The board used to label ranks from Red's side, so the square the
  archive calls `d7` appeared as `D3`. Files and ranks now match
  `backend/internal/notation` exactly: files `a`–`i` left to right, ranks `1`–`9`
  from Blue's home boundary to Red's.
- **Whose turn it is after a decisive move.** A server mode that ends the game
  on a move returns before passing the turn, so the final position of a decided
  game still has the winner to move; stalemate and repetition are adjudicated
  afterwards and do change hands. `engine/analysisGame.ts` now does the same.
  Before the fix, every replayed record that ended by annihilation, territory,
  or infiltration disagreed with its own `FinalFEN`.

Both were checked by generating random games in every mode with the Go
implementation, replaying them with the frontend rules, and requiring the
replayed final board, side to move, territory, and ply count to match the
record's tags exactly. All twelve records agree.

## Files

| What | Where |
| --- | --- |
| PGN reader and writer | `frontend/src/engine/pgn.ts` |
| Replay, grading, accuracy | `frontend/src/engine/gameReview.ts` |
| Analysis session, shared by every screen | `frontend/src/engine/gameAnalysis.ts`, `frontend/src/hooks/useGameAnalysis.ts` |
| Depth the device can afford | `frontend/src/engine/analysisBudget.ts` |
| Its tests | `frontend/src/engine/gameAnalysis.test.mts` against the real engine, `analysisLadder.test.mts` against a stub engine and a controlled clock (`npm test`) |
| Engine lanes and request budgets | `frontend/src/engine/rpsfish/client.ts` |
| Per-game engine walk | `frontend/src/engine/rpsfish/worker/` (built to `public/rpsfish/rpsfish-worker.js`) |
| Screens | `frontend/src/features/review/ReviewScreen.tsx`, `frontend/src/features/bots/BotBattleScreen.tsx`, `frontend/src/features/analysis/AnalysisScreen.tsx` |
| Shared analysis UI | `frontend/src/features/analysis/EvalChart.tsx`, `AccuracyCard.tsx`, `AnalysisEffortToggle.tsx`, `MoveAnalysisList.tsx`, `EngineLinesCard.tsx` |
| The engine switch, and where it is kept | `frontend/src/features/analysis/EngineSwitch.tsx`, `frontend/src/store/enginePreference.ts` |
| Calibration | `frontend/scripts/reviewCalibration.mts` |
| How far the engine disagrees with itself | `frontend/scripts/reviewStability.mts` |
| What the chart badges | `frontend/src/features/analysis/chartMarks.ts` |
| Root-move restriction | `RPSFish/src/search.rs`, `RPSFish/src/wasm.rs` |
| Storage | `backend/internal/persistence/accuracy.go`, `backend/internal/server/accuracy_routes.go` |
