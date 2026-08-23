# RPS Strategy frontend

The production web build connects to `wss://api-rps.henhen1227.com/ws` and is
published to the repository's `dist` branch.

## Layout

TypeScript throughout, with `strict` on, and no `.js` in `src/`.

Routing is [Expo Router](https://docs.expo.dev/router/introduction/): a file in
`src/app/` is a page, and `web.output` is `static`, so `expo export` writes one
HTML file per page. Every page therefore has a real address that can be
bookmarked, shared, and reloaded. Two consequences worth knowing before adding
a page:

- **No dynamic segments.** A `[gameId].tsx` route would have to be pre-generated
  for every value it could take, and game ids are not knowable at build time, so
  parameters travel in the query string instead — `/review?gameId=…`. Read them
  with `useSettledSearchParams`, not `useLocalSearchParams`; a static file cannot
  know its own query string, so the first render in the browser has to match the
  pre-rendered HTML, which had none.
- **The build runs in Node.** Anything with no server implementation — audio,
  `window`, a worker — must not run during the first render. `GameSoundEffects`
  shows the pattern.

```
src/
  app/         one file per page; thin, they render a feature screen
  app/(shell)/ the pages that sit inside the app shell — see below
  features/    board, analysis, game, bots, tournaments, account, shell, live, …
  engine/      the rules, PGN, RPSFish, the bots — no React anywhere in here
  store/       Zustand slices and the REST clients under store/api/
  hooks/       the shared React behaviour: board layout, selection, replay,
               the analysis walk and the interactive search
  ui/          primitives and the Markdown renderer
  navigation/  link builders; the only place a page's address is written
  types/       the wire protocol, mirroring backend/internal/{game,server}
```

## The app shell

Seven sections live inside one frame: **Play Online**, **Bots**, **Tournaments**,
**Account**, **Leaderboard**, **Openings**, and — only for an account with the
admin flag — **Admin**. On a wide screen that frame is a left sidebar, the
section, and a floating right-hand rail of what is happening right now. On a
phone it is a one-line header, the section, the rail collapsed to a single
tappable line, and a bottom bar of four tabs plus **More**.

They live in the route group `src/app/(shell)/`. A parenthesised directory
contributes nothing to the URL, so every one of these pages keeps the address it
already had — `/`, `/bots`, `/tournaments`, `/openings`, `/account`, `/admin` —
and still exports as its own HTML file. A section may have pages *under* it:
`/account/bots` is the engine registry and `/account/bots/connect` and
`/account/bots/protocol` are the two documents behind it. Those are ordinary
nested routes, so they export as their own files too and keep **Account** lit in
the sidebar, and `PageHeading` gives them the one line of trail the sidebar
cannot — nothing in a list of sections leads back from a reference page to the
registry that sent you there. `(shell)/_layout.tsx` renders
`features/shell/ShellLayout.tsx`, which uses `<Slot />` rather than a `Tabs`
navigator: each section is a fresh mount with fresh data, which for a lobby is
the behaviour you want, since the whole point of the page is what is true now.
The live board, the analysis board, the review screen and the bot battle stay
outside the shell, full-bleed, because a board wants the whole window.

`features/shell/sections.ts` is the only list of sections. All three navigation
surfaces read it, so adding one is one entry rather than three edits that have to
agree, and the Admin entry's visibility is a predicate on the account rather than
a condition repeated per surface.

Two things to know before changing the responsive split. First, `useWideScreen`
is false on the very first client render, always — the pages are pre-rendered in
Node where there is no viewport, and the first render in the browser has to match
— so the phone layout is what paints first and the desktop layout arrives one
render later. Second, a child of `<Link asChild>` must be given **one resolved
style object**: `StyleSheet.flatten([...])`, not an array and not the usual
`({ pressed }) => [...]` function. Anything else is silently dropped, which the
first version of the sidebar discovered by rendering every nav row with none of
its own styles.

## The live rail

`features/live/liveSelectors.ts` turns store state into one `LiveSnapshot`: who
is online, which live games are between people and which are one game of a bot
series, who is waiting for an opponent, and whether a tournament needs
attention. Pure functions, in the same spirit as `store/tournamentSelectors.ts`,
because the desktop rail, the phone's collapsed bar and — later — the game
screen all ask the same questions, and three copies of "is this row a bot fight"
is how one of them ends up counting a tournament board twice.

A bot fight is a live game carrying the server's own `series` marker, so the
split needs no guess about who the players are. Your own open challenge stays on
the board marked as yours, with a Cancel button rather than an Accept one: hiding
it would lose the only feedback that a posted game is up, and offering it back
would offer a game the server refuses.

The four hooks in `src/hooks/` exist because four screens had four copies of
each: `useBoardLayout` (one rule for how big the board is), `useBoardSelection`
(tap a piece, tap where it goes), `useReplayCursor` (stepping along a line of
positions), and `usePositionAnalysis` (the interactive search — as distinct from
`useGameAnalysis`, which is the review walk that grades moves).

The RPSFish worker is written in TypeScript too, in
`src/engine/rpsfish/worker/`, and bundled to `public/rpsfish/rpsfish-worker.js`
by `npm run build:worker`. It shares its message types with the client that
drives it, so the two cannot drift. The built file is not checked in; `start`,
`web`, `pretest` and `prebuild:web` all produce it first.

Each game-mode card carries a **How to play** link that opens a per-mode rules
card (`features/game/HowToPlayModal.tsx`): the mode's opening position, the piece
matchups drawn with the real artwork, a movement diagram, and the mode's own win
condition. Only the win condition is keyed by mode id, so an unrecognised mode
falls back to its catalog objective.

Each game-mode card also opens a local self-analysis board. RPSFish runs as
WebAssembly in a dedicated browser worker, ranks the top three moves, draws
their arrows, maintains a Red/Blue evaluation bar, and grades every move the
player makes while controlling both sides. Analysis does not require a server
connection. The analysis screen updates after every completed search depth and
offers a **Go Deep** mode that continuously ranks three principal variations.
The deep preset is bounded to one worker thread, depth 127, 100 million nodes,
and 30 seconds; the client API also accepts custom `maxDepth`, `maxNodes`,
`maxTimeMs`, `variations`, and inter-iteration `throttleMs` values.

Squares are written the way the game archive writes them: files `a` to `i` left
to right, ranks `1` to `9` from Blue's home boundary to Red's. A square named on
the board is therefore the square named in that game's PGN.

## Game review

Any finished game can be replayed and graded. Players get one inline result
card with the finished board—never a post-game modal—with **Review game** opening
the review directly and **Play again** / **Modes** alongside it. The screen shows
the game's own move list — arrow keys walk it, and
the record stays the main line even after you play your own moves off it — with
a grade on every move, an evaluation chart across the whole game, RPSFish's top
lines for whatever position is on screen, and an accuracy percentage for each
player.

Online games are reviewed from the record the server stored; bot games are
reviewed from a record the browser writes itself, in the same dialect
(`engine/pgn.ts`), because the server never saw them. Reviewing an online game
does not leave the session, so its chat room stays open under the board while
both players go over it, and the reviewing player's own accuracy is stored with
the game.

The whole review is one request to the analysis worker, which walks the game
keeping its transposition table and repetition history across positions rather
than rebuilding both per position. Grades come from restricting one search to
the best move and the played move, so the two scores being subtracted were
produced under identical conditions. Depth is chosen with the **Quick /
Standard / Deep** switch.

The walk itself is shared. `engine/gameAnalysis.ts` holds one analysis session —
hand it a line of play as it currently stands and it keeps the engine grading
whatever part of it is not graded yet — and `hooks/useGameAnalysis.ts` binds it
to a screen. The review, the bot battle, and the analysis board all run through
it, so a move cannot be Good on one screen and a Mistake on another, and a
request can pick up where the last one stopped instead of regrading a game from
the beginning every time it gains a move.

RPSFish runs in two workers rather than one. Because the WASM search is
synchronous, everything sharing a worker takes turns, so one lane answers
whoever is looking at a position right now — the analysis board, the hint
button, a bot choosing its move — and a second lane grades whole games. That is
what lets a game and the analysis of that game run at the same time.

`scripts/reviewCalibration.mts` fits the evaluation-to-expected-score curve the
grades and accuracies are built on; re-run it after an evaluation change and
put the result in `WIN_PROBABILITY_SCALE`. See
[`../docs/review.md`](../docs/review.md) for the whole design.

## Bots

The **Bots** section is one screen: play a bot, watch two of them fight, and
challenge an engine somebody connected. It used to be four sub-tabs, which is
what a page becomes when unrelated things are filed on it — two of those tabs
were not about playing at all. The bot ladder was the Leaderboard's own BOTS
board rendered a second time, and the registry with both handouts under it
belongs to whoever owns an engine, so it is now `/account/bots`. What is left
fits without paging: one difficulty ladder picks your opponent *and* the red
side of a battle, and the chips under it pick the blue side.

The **Play a bot** panel opens a practice board where RPSFish
plays the other side. It runs entirely in the browser — the same WebAssembly
worker the analysis board uses — so the server never sees a bot move and a bot
game keeps working while the connection is down.

A bot game deliberately reads like a real match: the same board, player bars,
captured-piece tallies, territory meter, move sounds, resignation dialog, and
outcome card. What differs is that there is no clock, the opponent is labelled
**BOT** with its level, nothing is rated, and two practice controls are switched
on — **Hint**, which draws RPSFish's own best move on the board, and **Undo**,
which takes back the player's last move together with the bot's reply. There is
no chat, because nobody is listening.

Difficulty lives in `engine/bots/profiles.ts`, which is the only file to edit when
tuning a bot. Each profile carries four groups of knobs:

| Group | What it controls |
| --- | --- |
| `search` | `maxDepth`, `maxTimeMs` — how hard RPSFish may think |
| `choice` | `candidateLines`, `randomMoveChance`, `temperatureUnits`, `maxLossUnits` — how often the bot fails to play what it found |
| `tempo` | `minThinkMs`, `maxThinkMs` — a floor on how long a reply takes, for feel only |
| `manners` | `resignBelowArmies`, `resignAfterMove`, `acceptDrawWithinArmies`, `acceptDrawAfterMove` |

A bot never resigns against a person. It will answer a draw offer, because the
player made that offer, but a lost position gets played out so the win belongs
to whoever earned it. The `resignBelow*` knobs therefore affect only
`bots/arena.ts --adjudicate`, an opt-in shortcut for exploratory measurement runs
that is off by default — a recorded number should come from the bot that
actually ships.

No knob is a raw score, because scores are not comparable between modes. The
`choice` knobs are multiples of that mode's typical spread among top root
moves; the `manners` knobs are multiples of a starting army's worth of
material. `MODE_SCORE_SCALE` at the top of the file holds both units per mode
and explains where each was measured. Expressed absolutely they meant wildly
different things per mode — and mostly meant nothing at all: the old
temperatures ran from 60 to 1050 against root-move gaps whose 90th percentile
is 7 to 50, so every rung below the top sampled close to uniformly, and no
resignation threshold was reachable in any mode.

The ladder is defined in **depths**, so difficulty does not drift with the
device: Pebble 2, Napkin 3, Snips 4, Boulder 7, Crane 11, Obsidian 16. Below the top rung `maxTimeMs` is only a backstop, because
those depths cost single-digit milliseconds. At the top it is the real governor,
and the two modes diverge — Infiltration reaches the full depth 16 in one to two
seconds, while Total War runs out of the four-second budget around depth 13–15.
A search the timeout interrupts still returns the last *fully completed* depth
with its principal variation, so a tight budget degrades to a shallower move
rather than a random one. Lower `maxTimeMs` first if the top bot feels slow.

There is no per-profile node cap. One shared `BOT_TUNING.maxNodes` valve guards
every search instead, sized well above what the deepest profile spends, because
a per-profile node ceiling silently caps depth instead of letting the depth knob
do it. `bots/profiles.ts` carries a measured depth-cost table for both modes;
re-measure it after an engine change, since a faster engine makes every rung
cheaper without making it stronger.

Strength is measured, not asserted, and the measurement runs headlessly:

```sh
npm run arena -- --ladder --pairs 20      # every rung against the one below
npm run arena -- --a crane --b boulder    # one matchup
npm run arena -- --spread                 # root-score gaps, per mode
npm run arena -- --selftest               # the harness checks itself
```

`scripts/botArena.mts` loads the shipped worker and WASM from `public/rpsfish/`
into a vm context and drives the real `createBot`, so what it measures is the
path the app runs rather than a model of it. It plays paired colour-swapped
games from seeded random openings and reports Elo with a 95% interval, the same
way `RPSFish/src/bin/arena.rs` does — a run is reproducible from its seed, and
`--selftest` asserts that a profile which samples nothing scores exactly 0.5000
against itself. Thirty unpaired games, the previous method, carries an interval
of roughly ±120 Elo, which is wide enough to "measure" a rung gap that is not
there.

Weakness is deliberately two-sided: a weak bot searches shallowly *and* picks
badly from what it found. `randomMoveChance` skips the search entirely,
`temperatureUnits` spreads a softmax over the ranked lines so known-worse moves
get played, and `maxLossUnits` is the guardrail that keeps a strong bot from
ever sampling a blunder. The low rungs lean on the softmax rather than on
`randomMoveChance`, because a move the engine ranked eighth looks like a
beginner's move while a uniformly random legal move looks like a bug — which is
why the engine's MultiPV cap was raised from three lines to eight: it roughly
triples the score range a profile has to be weak within. `BOT_TUNING` in the same file holds the settings that are
not per-difficulty, including the always-strong search behind the hint button.

`engine/bots/engine.ts` wraps a profile in a `createBot()` object whose only job
is `chooseMove(game, { history })`. It holds no React state and touches no
store, and its engine, random source, and clock are injectable, so the same bot
can be driven by a stub for testing. `engine/bots/arena.ts` uses exactly that
contract to play bots against each other — `playBotGame` for one game,
`playBotPair` for one opening played twice with the colours swapped, and
`playBotMatch` for a full match with statistics. A bot game in the app is
seeded too, and the session records the seed, so a game that produced a strange
move can be replayed rather than described.

### Bot battles

The **Bots** section can also put two bots on the board and let you watch, at
`/battle`. The battle
screen is a live game and a game review at once: the board plays itself while
RPSFish grades it, with an evaluation bar and chart, a grade on every move,
ranked lines for whatever position is on screen, and an accuracy for each bot.

Every number there comes from an independent **Deep** analysis of the game, not
from either bot's own search. That distinction is the whole point: a bot's
search is how that bot chose its move — two plies deep for the bottom rung, and
a different depth on each side of the board — so grading a battle with it would
measure the bots against themselves. Deep costs more per position than any
bot's move and far more than most, so the analysis runs *behind* the board: the
status card says how many moves behind, ungraded moves say so rather than
showing a grade, and the evaluation line stops where the analysis has reached.
Accuracies fill in when the game ends, because a mean over the first ten moves
of a game is not anybody's accuracy.

The finished game can be copied as a PGN and reopened in the review screen,
since a battle is recorded in the same dialect as everything else.

While a player is on the bot board the lobby still counts them: the server is
told `bot_session_start`, publishes the total as `botPlayerCount`, and the Bots
section shows **"N playing bots"** while the live rail says how many people are
practising. The bot board watches the other direction
too. Because the server broadcasts matchmaking waits separately as
`modeQueueCounts`, a bot game shows a live notice whenever a real player is
looking for an opponent in any mode, with a button that joins that queue —
keeping the bot game playable until the match is actually found, at which point
the real game takes the board.

**Play Online** leads with any tournament that needs attention: signup while
registration is open, then your own scheduled matches and the event's live games
once it starts. Below that are the ranked mode cards, then one panel for custom
games — pick a starting position and either name somebody or leave it open for
whoever takes it first — then the board of open challenges other people have
left, then the retired modes with analysis only. Tournament play reuses the
ordinary game screen: readying up on a match starts a normal game session, so
clocks, chat, spectating, and reconnection behave exactly as they do elsewhere.

A floating call to action follows the player across every screen while one of
their matches is waiting, including while they are spectating someone else's
board, and disappears once they are sitting at their own game. Its rule lives in
`hooks/useTournamentCall.ts`, and the derivations behind it in
`store/tournamentSelectors.ts`, so Play Online, the tournament board, and
the floating bar always agree.

The **Tournaments** section is the full board: schedule, standings, roster, and
an archive of every event that has finished, each opening into its own standings
and champion. `store/tournamentSelectors.ts` owns the split — `currentTournaments`
for what needs attention and `pastTournaments` for what happened — because mixing
them made a finished event look like something to sign up for.

Administration has two doors, and `hooks/useAdminToken.ts` is both. A signed-in
account with the admin flag is one already: the server accepts their session
token on every admin route, `connection_ready.account.isAdmin` says so before any
request is made, and they never see a token form or a **Lock** button. The shared
`RPS_ADMIN_TOKEN` is the other door, for a host running the server without an
account; the browser remembers a verified token in local storage, retries it when
host controls are opened, and forgets it if verification fails or the host taps
**Lock**. Tournament HTTP calls use
`EXPO_PUBLIC_API_URL` when set; otherwise the API origin is derived from
`EXPO_PUBLIC_WS_URL` by changing `ws(s)` to `http(s)` and removing the trailing
`/ws`.

Shared visual tokens live in `theme.ts` — colour, `radius`, and now `space`,
`type` and `contentWidth`, which exist because font sizes, weights,
letter-spacings, gaps and page widths were inline numbers in every file, and
"what size is a section heading" had eleven answers. Shared controls are in
`ui/primitives.tsx`, alongside three that earned their place by removing real
duplication: `ModalCard` (the backdrop, card and close button that three dialogs
each wrote out), `ScreenShell` (page padding and width, replacing eleven
hand-rolled headers), and `ListRow` (the table row the live games, the engine
roster, the leaderboard and the open board all share).

A mode whose catalog entry has `playable: false` is listed under **Retired
modes** with analysis only; the server refuses matchmaking, challenges, and new
tournaments for it.

The **Leaderboard** is two boards over one route, and the combined one ranks each
account by its strongest mode rather than by `accounts.elo` — that column is only
the seed a new mode inherits, so a board ordered by it would sit everybody on
1200 for ever. Each row names the mode its rating came from, because a number
with no scope attached invites the reader to think this game has one rating.

The **Account** section leads with registration: a player is "Guest"
until they claim a username and password there, and claiming one keeps the
rating, record, and games the browser has already accumulated. A signed-in
player can rename themselves and add a Discord handle from the same screen;
nobody can set either without an account.

`store/accountSession.ts` owns the session token, holds it in `localStorage`,
and reconnects the socket whenever it changes. The browser also generates a
256-bit local profile key alongside its account UUID and keeps the raw key in
`localStorage`; the socket authenticates with the session token when there is
one and with the UUID and key otherwise, and the server stores only the key
hash. Clearing site data loses the local identity but not the account — signing
in restores it. A session the server rejects is dropped by the client, which
reconnects as the browser's anonymous identity.

## Publish the web build

```sh
npm ci
npm run deploy
scp deploy/nginx-rps.conf orange-pi:/tmp/nginx-rps.conf
```

`npm run deploy` first exports the Expo web app to the ignored local `dist/`
directory, then publishes only those generated files to the remote `dist`
branch. The web build automatically compiles `../RPSFish` for
`wasm32-unknown-unknown` and copies the engine plus its worker into
`dist/rpsfish/`.

## Deploy the `dist` branch on the Orange Pi

For the first deployment, the target directory must not already contain files:

```sh
git clone --branch dist --single-branch \
  git@github.com:hen1227/RockPaperScissors.git \
  /var/www/production/henhen1227/rps.henhen1227.com
```

For later deployments:

```sh
git -C /var/www/production/henhen1227/rps.henhen1227.com \
  pull --ff-only origin dist
```

Install `deploy/nginx-rps.conf` as the Nginx site when the hostname does not
already have one:

```sh
sudo cp /tmp/nginx-rps.conf \
  /etc/nginx/sites-available/rps.henhen1227.com
sudo ln -s /etc/nginx/sites-available/rps.henhen1227.com \
  /etc/nginx/sites-enabled/rps.henhen1227.com
sudo nginx -t
sudo systemctl reload nginx
```

If Certbot or another existing site file already owns this hostname, retain its
TLS directives and merge the `root` and `location` blocks instead of replacing
the file.

**`/sw.js` and `/manifest.webmanifest` must not be cached for long.** The export
puts both at the site root, and the service worker is what delivers a match
notification to somebody who has closed the tab — so a worker pinned in a
browser cache for a year is a worker that cannot be fixed. Serve them with
`Cache-Control: no-cache`; the fingerprinted bundles under `_expo/` can be
cached for as long as you like, as they always could.

```nginx
location = /sw.js              { add_header Cache-Control "no-cache"; }
location = /manifest.webmanifest { add_header Cache-Control "no-cache"; }
```

The worker deliberately caches nothing itself — it has no `fetch` handler at
all. Expo fingerprints its bundles per deploy, so a cache-first worker would go
on serving an HTML file pointing at chunks that no longer exist. To retire it
entirely, deploy an `sw.js` whose whole body is
`self.registration.unregister()`.
