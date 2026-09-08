# Reach

Infiltration is a race. A piece that lands on the opponent's home row wins on
the spot, every piece moves one king step in any direction, and each kind is
captured by exactly one other kind. So the mode is largely a geometry problem,
and **Reach** draws the geometry: every square a piece can stand on and how many
moves it takes, which of those squares the piece that hunts it gets to first,
and whether any route to the goal survives the difference.

It is a study tool, not an engine. It runs no search and never calls RPSFish; it
is a handful of breadth-first walks over eighty-one squares, so it is instant,
deterministic, and it does not queue behind the worker a bot is thinking in.

It is available on the analysis board and on a practice game against a bot. It
is deliberately **not** available in a game against a person: a rated game is
not the place for one side to be handed a picture of the race.

Reach has nothing to do with Total War's *territory*, which is the ground a
piece claims by standing on it (`tile.ownerColor`, `TerritoryMeter`). The two
are different questions about the same board and can be drawn at once.

## What it measures

### Reach maps

A **reach map** is one number per square: how many moves this piece needs to be
standing there. The walk is a plain breadth-first search over the eight
neighbours, and two of its rules are worth stating outright.

**A square holding this piece's prey is an ordinary passable node.** A rock
steps onto an enemy scissors, takes it, and carries on from that square next
move. For one piece's own shortest path that is exact, not an approximation.

**Blockers are held still, and that is the approximation.** Real pieces move,
into the way as well as out of it. Rather than hide the choice, the tool offers
the brackets as a setting:

| Obstacles | What blocks |
| --- | --- |
| `open` | Nothing. Pure king-step geometry, which is Chebyshev distance. |
| `static` | The board as it stands: friends, and any enemy this kind cannot take. |
| `friendlyVacates` | Enemies only. Your own pieces are assumed to step aside. |

`open` is the floor under the other two, and the three are ordered: opening a
route can only ever shorten it. A test asserts that.

### Threat, and when a square is too dangerous

The hierarchy is a single three-cycle, so a piece has exactly one **predator** —
Rock is only ever taken by Paper, Paper by Scissors, Scissors by Rock. A
**threat map** is the per-square minimum of the reach maps of every enemy piece
of that one kind.

A runner is safe on square `s` after its own move `k` when

```
threat[s] > k + (walkerToMove ? 0 : 1)
```

Count the plies to see the tempo term. With the runner to move the order is
W₁ E₁ W₂ E₂ …, so after the runner's move `k` the enemy has played `k − 1` and
is about to play its `k`th: a predator needing `k` moves or fewer arrives in
time. Safety is therefore `threat > k`. When the enemy moves first it has had
one more move by the same point, and the bound tightens by one. **A tempo is
worth exactly one square of the chase**, which is why the tool can force either
side to move next.

This inequality is *monotone decreasing in `k`* — arriving later is never easier
— so a square unusable at its earliest arrival is unusable at every later one.
That is what makes a single layered walk both correct and complete, with no need
to revisit a square at a greater depth.

Two other rules sit alongside it:

- **`wholeRun`** is the stricter reading: no square of the run may be reachable
  by a predator inside the run's whole length — safe even if you dawdle. Its
  rule mentions the finished length, which a walk does not know yet, so it is
  searched the other way round: for each candidate length `n`, restrict the
  board to squares with `threat ≥ n` and ask whether the goal is `n` steps away
  in what is left. The allowed set only shrinks as `n` grows, so the first `n`
  that works is the answer, and at that `n` the distance is exactly `n`.
- **Landing on the goal ends the game before the reply**, so the last square of
  a run needs no margin. That is the rule as the game plays it and it is on by
  default; turning it off asks the stricter question of whether the piece could
  stand there and survive.

### The verdict, and what it is worth

Each side's fastest surviving run is compared. The side to move arrives on ply
`2n − 1` and the other on ply `2n`, so **the side to move is first whenever its
run is no longer than its opponent's** — a dead heat still goes to whoever moves
next.

**This is a bound, not a proof.** It holds the blockers still and it credits the
defender with doing nothing but intercepting: no rerouting, no blocking, no
counter-race. A side with no safe run here may find one after a capture opens
the board. The UI says so under the table, and it should keep saying so.

The one reading that really is conclusive is **immortality**. No mode ever puts
a piece back on the board, so once the enemy's last Paper is gone every Rock is
permanently uncapturable, and its blocked distance is a win in that many moves.
This is the same fact as `Position::is_immortal_kind` in RPSFish, which prices
it as an evaluation term; here it is stated outright.

The tool also names **where** a race is decided. When the quickest route is not
the safe one, `cutOff` reports the first square of the quick route that fails
the inequality, with the move you would arrive on and the move a predator gets
there on — *"e2: you arrive on move 3, a paper is there in 3"*. That single line
is usually the whole explanation of a lost endgame.

## What it draws

### The notation

A square reads **`R3`**, **`P4`**, **`S5`**: the kind, then the moves it needs to
stand there. The letter is not decoration. A side's kinds are not
interchangeable — a rock and a paper are stopped by different pieces and hunted
by different ones — so a single merged "how far is this side from here" number
answers a question nobody is asking. **Every kind that can reach a square gets
its own line**, in Rock/Paper/Scissors order, so a board can be read across
rather than square by square.

The wash under the lines is the *nearest* kind's distance, because a heat map
wants one number per square. The lines are where the detail is.

The one number written without a letter is a step of a run, which is a move
index rather than a reach.

### The views

Five, each reading the same distances a different way:

| View | Shows |
| --- | --- |
| `piece` | One piece: every square it can stand on, banded and numbered. |
| `side` | One side at once, kind by kind — `R3 P4 S5` on a square all three can reach. |
| `contest` | Both sides, one line each: whose kind gets here first and in how many, each in that side's colour. Dead heats are drawn apart. |
| `threat` | The focused piece against the kind that captures it, **both numbers on every square** — `R5` over `P3` is the comparison the whole tool is for. |
| `run` | The surviving route to the goal, step by step, and the square that would cut it off. |

The **ghost** is a piece that is not on the board, put anywhere: the whole
reading is redone as though it were there, which is how to ask what a square is
worth before spending four moves reaching it.

Everything else is a setting — the distance to look out to, whether to number
the squares, whether to outline the frontier, whether to fade what lies past it
or drop it, and whether to follow taps on the board or pin the focus.

The palette is two ramps per side, in `theme.ts`. One alpha wash cannot serve
both squares of a chequerboard: the strong hue darkens the sand tile and would
vanish into the green one, so the dark tile takes the light hue and lifts off
its background instead. `clock.bonusWash` solves the same problem the same way,
and its comment is the precedent.

## Adding it to another surface

The board knows nothing about reach. `Board` (and `MiniBoard`) take an
`overlay` prop of finished per-square decorations — a fill, a ring, up to three
stacked corner lines each with its own colour, a dim flag, and a line of
accessibility text — keyed by *board* coordinates, so a flipped board needs no
special handling. That contract is
`features/board/overlay.ts` and it is deliberately free of reach vocabulary.

Hosting the tool on a new screen is three lines:

```tsx
const reachTool = useReach(position);          // 1. any PositionLike
<Board overlay={reachTool.overlay} … />        // 2. hand the board the overlay
<ReachPanel tool={reachTool} />                // 3. render the controls
```

and one more if the screen wants the maps to follow taps:

```tsx
onTilePress={(square) => {
  if (reachTool.handleTilePress(square)) return;   // only ever true while placing a ghost
  selectTile(square);
}}
```

The settings live in one store slice, so a board set to "threat, three moves,
friends move aside" is still set that way when the position is carried to
another screen.

Which modes have a goal row to race to is decided in one place,
`goalRowFor` in `engine/reach.ts` — the same rule `applyAnalysisMove` decides
infiltration with. A future mode with a different objective is an edit there.
If modes should declare their own support instead, the route is a `ModeFeature`
on the Go `ModeDefinition`, which already carries `territory`.

## Files

| File | Role |
| --- | --- |
| `frontend/src/engine/reach.ts` | The walks, the safety rule, the readings and the verdict. Pure, typed against `PositionLike`. |
| `frontend/src/engine/analysisGame.ts` | `stepTargets`, `predatorOf`, `preyOf` — the movement and capture rules, held in one copy. |
| `frontend/src/features/reach/reachOverlay.ts` | Distances into a `BoardOverlay`: banding, labels, and which wash wins. |
| `frontend/src/features/reach/settings.ts` | Every knob, and the defaults. |
| `frontend/src/features/reach/ReachPanel.tsx` | The controls beside the board, plus the settings dialog and the summary. |
| `frontend/src/features/reach/ReachSummary.tsx` | The verdict, the focused piece, and the per-piece table. |
| `frontend/src/features/board/overlay.ts` | The board's decoration contract. |
| `frontend/src/hooks/useReach.ts` | The one binding every host screen goes through. |
| `frontend/src/store/reachTool.ts` | The settings slice. |

Tested by `frontend/src/engine/reach.test.mts` and
`frontend/src/features/reach/reachOverlay.test.mts`, both under `npm test`.
