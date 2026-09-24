# RPS Strategy

The app: frontend, backend, docs, deploy. The engine is a separate repo at
`../rpsfish` with its own history and its own licence.

`frontend/AGENTS.md` carries the frontend-specific rules — read it before
touching anything under `frontend/`.

## What's New changelog

`CHANGELOG.md` at this repo root is the player-facing record of what changed.
**After any change a player can see, add a line to the top section as part of
the same change.** It is kept as you go, not written at release time — by then
nobody can reconstruct it.

### What counts

Log it if a player would notice: new screens or modes, rule changes, rating and
matchmaking behaviour, anything visibly faster or slower, bugs they could hit.

Skip it otherwise: refactors, tests, dependency bumps, docs, deploy and tooling,
engine tuning that does not change how a game plays, backend work with no
visible effect. Most commits are not changelog-worthy. An empty section at
release time is a real answer; padding it is not.

### How to write it

One line per change, present tense, from the player's side of the screen. Name
the thing they see, not the code that does it.

| Write this | Not this |
| --- | --- |
| Blue now moves first in every mode. | Swap the first-mover constant in `game/types.go`. |
| The opening explorer can mix game sources. | Add per-segment opening stats with summed queries. |
| Fixed sign-in failing on iOS. | Fix the Discord native return URL slash count. |

No file names, no function names, no internal vocabulary (segment, ply, SPSA,
Fabric). A change that cannot be described without them probably does not
belong in this file.

### Budget

One release's section must fit **500 characters**. That is Google Play's
release-notes field, and the shipped section is pasted into it verbatim; the
App Store's "What's New" allows 4,000, so 500 is the binding limit. If a
release runs over, cut the smallest items — do not split the release.

### Releasing

The top section is unreleased and carries no date. When a build ships:

1. Change its heading to `## <version> — <YYYY-MM-DD>`.
2. Open a new `## <next version> — unreleased` section above it.
3. Paste the shipped section into both release-notes fields in
   `docs/store-listing.md` — App Store "What's New in This Version" and Play
   "Release notes" — and update their `used/limit` counts.

`frontend/app.json` and `frontend/package.json` both carry the version; the
heading must match them.
