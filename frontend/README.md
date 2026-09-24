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

Every page inside the frame belongs to one of five groups: **Play**, **Bots**,
**Study**, **Compete**, and **You** — the last of which carries **Admin** for an
account with the admin flag. `features/shell/sections.ts` is the whole list, and
both surfaces render all of it. On a wide screen the frame is a left sidebar
showing the five groups with their pages under them, the section, and a floating
right-hand rail of what is happening right now. On a phone it is a one-line
header, a strip naming the pages in the open group, the section, and a bottom
bar of five tabs — one per group, with nothing behind a menu.

They live in the route group `src/app/(shell)/`. A parenthesised directory
contributes nothing to the URL, so every one of these pages keeps the address it
already had — `/`, `/bots`, `/tournaments`, `/openings`, `/account`, `/admin` —
and still exports as its own HTML file. A section may have pages *under* it:
`/account/bots` is the engine registry, and `/bots/series` is one run of two
engines. Those are ordinary nested routes, so they export as their own files
too and still light the group they belong to, and `PageHeading` gives them the
one line of trail the sidebar cannot — nothing in a list of sections leads back
from one run to the runs.

One row may also stand for several pages. The three engine handouts —
`/account/bots/connect`, `/account/bots/protocol`, `/account/bots/notation` —
are one document set rather than three places to be, so the navigation lists
**Docs** once and the page itself carries tabs; `Section.covers` in
`sections.ts` is what makes any of the three light that one row. Each keeps its
own address, because each is a page worth linking to and pre-rendering on its
own.

Whether a page draws that trail is derived rather than declared. `useUpTarget`
asks the same list the sidebar and the strip render — see `listedInNav` — and a
page the navigation already has a row for draws nothing, which is what stops a
back button from surviving the day its page becomes a section.

`(shell)/_layout.tsx` renders `features/shell/ShellLayout.tsx`, which uses
`<Slot />` rather than a `Tabs` navigator: each section is a fresh mount with
fresh data, which for a lobby is the behaviour you want, since the whole point
of the page is what is true now.
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

The first human game — or the first bot fight when no people are playing — is
the rail's featured live board. `live_games` carries its current pieces and
territory as compact nine-character rows, plus the turn and move number, and is
republished after each move. `liveGameGrid` expands that wire picture into the
ordinary grid consumed by `MiniBoard`; the rail does not invent a second board
renderer. Entering the board remains an ordinary `spectate_game`, which opens
the full clocks and shared game chat.

The featured card uses a smaller fixed board in the mobile sheet. During a
mixed-version deploy, if a live preview has not arrived yet, it falls back to
the registered mode's opening position so the start of a match never appears as
an empty board.

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

## Local games

Two people, one device. **Play someone next to you** on the lobby opens a board
both players share and take it in turns at: no clock, nothing rated, and — the
part that matters — nothing sent anywhere. `store/localSession.ts` runs the
whole game off `engine/analysisGame.ts` and publishes a server-shaped
`gameState` with a `local` marker, exactly as the bot session publishes one with
a `bot` marker, so the live board, the player bars, the captured tallies, the
sound effects and the review all serve it without knowing what they have.

It is the only game in the app that generates **no traffic at all**. A bot game
still tells the server that this player is busy, so the lobby can count them;
this one says nothing, which is what lets it be started and finished with the
connection down — the mode catalog it needs is the fallback catalog the store
ships with.

Four things differ from a bot board, and each of them is the same fact seen from
a different angle: *nobody owns a colour here*.

- **`playerColor` is null**, and `gameState.local` answers the questions it
  usually would. `movableColor` is what makes the board work: it is the side to
  move rather than the viewer's own, which is the arrangement the analysis
  board already used for one person playing both sides.
- **The board is turned by hand**, with **Flip board**, and never by the turn.
  Facing the board at whoever is to move is the obvious thing to do with a
  device lying on a table between two people, and it is wrong for the far
  commoner case of two people sitting side by side: the board would spin under a
  hand already reaching for it.
- **Undo takes back one move**, not two. The bot board undoes a move and its
  reply because it has to get back to the player's own turn; here every turn is
  theirs.
- **A draw is one press**, and the resign button names the side giving up
  (`Red resigns`). An offer that the other half of the same person has to accept
  is ceremony rather than consent — the two players are in the same room, so the
  negotiation happened out loud before anybody touched the screen.

There is no chat, for the same reason, and no hint: RPSFish's own best move is
practice against a bot and cheating against a person.

The record is written by the browser (`localGamePGN`) in the archive's dialect,
so a finished local game reviews through exactly the same screen as an online
one, with both seats named after their colours and no reviewer's own side to
grade from.

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
plays the other side. It runs entirely on the device — the same engine the
analysis board uses, as a WebAssembly worker in a browser and as a static
library in the iOS app — so the server never sees a bot move and a bot game
keeps working while the connection is down.

**Your side** is a choice, in the same three words the challenge editor uses:
EITHER, RED · FIRST, BLUE · SECOND. Both bot panels carry it — the practice
ladder and the engine list — because "play a bot" means two different things on
this page and only one of them is local.

The session records the *choice* rather than only the seat it produced, which is
what the rematch button reads. Somebody who picked a colour keeps it; somebody
who asked for either is handed the other one each time, so a rematch alternates
the way it always has instead of flipping a coin that can land the same way four
times running. An engine challenge with no preference seats the challenger Red —
the courtesy every other challenge here carries — and the server decides that,
not the client.

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

Shared visual tokens live in `theme/` — colour, `radius`, and now `space`,
`type` and `contentWidth`, which exist because font sizes, weights,
letter-spacings, gaps and page widths were inline numbers in every file, and
"what size is a section heading" had eleven answers.

Colour is chosen by the player, so those tokens are containers whose contents
`applyAppearance` overwrites rather than constants: `import { colors } from
'@/theme'` and `colors.surface` are written exactly as before and now follow
whatever theme is on. Two rules follow from that and neither is optional.
**Stylesheets are declared with `themedSheet(() => ({ … }))`, not
`StyleSheet.create`** — a sheet reads its colours once, when the file is
imported, and `themedSheet` is what lets it be refilled. And **nothing may hold
a token in a module-level constant**: `const TINT = colors.accent` at the top of
a file keeps the colour of whichever theme happened to load first, for ever, and
no test will notice. Make it a function.

Re-rendering after a change is a subscription, `useAppearanceGeneration()`,
placed at the top of every route file in `src/app/` and inside the handful of
components wearing `memo()`. A route file is the seam because expo-router puts
each route behind a `React.memo` that skips `children`, so a re-render above
never reaches in. A new page needs that one line; see any existing route file.

`src/appearance/` owns the rest: the four catalogues, the device preference, and
the browser's pre-paint script. `src/theme/spec.ts` explains what a theme is and
why the roles are authored rather than derived from a ramp.

Shared controls are in
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

Under the lifetime record on the same screen is **Your games**, the account's
finished games newest first — the result in words, the mode, whether it was
ranked, how long it ran, and how it went for the player, with a **REVIEW**
button and a **COPY LINK** button on every row. Ten arrive at a time and
**LOAD MORE** asks for the next ten. It is `features/game/GameHistoryPanel.tsx`,
keyed by account id rather than by "the signed-in player", so a profile page for
somebody else would use the same panel unchanged; the list it reads,
`GET /api/accounts/{userId}/games`, is as public as the archive it points into.
See [Game review](../docs/review.md#getting-there) for what the link is and who
can open it.

`store/accountSession.ts` owns the session token, holds it in device storage,
and reconnects the socket whenever it changes. Each client also generates a
256-bit local profile key alongside its account UUID and keeps the raw key
beside the token; the socket authenticates with the session token when there is
one and with the UUID and key otherwise, and the server stores only the key
hash. Device storage is `localStorage` in a browser and `expo-sqlite/kv-store`
on a phone — see [Run on iOS](#run-on-ios). Clearing site data loses the local identity but not the account — signing
in restores it. A session the server rejects is dropped by the client, which
reconnects as the browser's anonymous identity.

## Run on iOS

```sh
npm run build:rpsfish:ios
npx expo run:ios --device
```

The first command compiles `../RPSFish` for the three Apple targets, packs them
into `RPSFish.xcframework` and copies it to `modules/rpsfish/ios/`, where the
local Expo module vendors it. It is a build artifact rather than source, so it
is not in the repository and a clean checkout has to run it before the first
`pod install`; `npm run ios` does both in that order. `npx expo prebuild -p ios`
regenerates the ignored `ios/` directory from `app.json` — which is where the
URL scheme, the `expo-router` `origin` and the APNs entitlement come from, and a
project generated before any of them was set will refuse to render a page that
asks for a handoff URL, or will fail to register for notifications with "no
valid aps-environment entitlement string found".

### RPSFish in the app rather than in a worker

The browser runs the engine as WebAssembly inside a Web Worker. iOS has
neither, so the same Rust crate is compiled to a static library and reached
through a native module in `modules/rpsfish`.

What is *not* duplicated is the engine's behaviour. Iterative deepening, the
review walk, the paired search that scores a played move, every clamp on a
caller's request and all the warm-table bookkeeping live in
`engine/rpsfish/session.ts`, which both platforms run. Each platform supplies
only an `EngineBackend` — a handful of methods that forward to the ABI and read
the result back — and the worker is what is left of the browser's half, about a
hundred lines of loading WebAssembly. `client.ts` cannot tell the two apart,
because `nativeSession.ts` presents the same few members the request lane uses
on a `Worker`, so the queueing, the deadlines and the cancellation are written
once.

One difference between the platforms is visible in the design. A browser worker
owns its WebAssembly instance, so two workers are two independent engines —
which is why analysis and review are given one each, and why a deep review does
not have to be torn down every time a bot thinks. The static library's search
state is process-global: there is one engine however many sessions ask for one.
Sequences of calls are therefore serialised, at the granularity of a single
search — one deepening step, or one graded position — so an analysis waits for
the review's current position rather than for the whole review, and neither
cancels the other. Every search states the line it needs before it runs, and
the engine is stood back on that line if something else has moved it since.

Nothing touches the JavaScript thread or the UI thread: every ABI call is
dispatched to one serial background queue, at `userInitiated`, because somebody
is watching a spinner. Positions cross the bridge as 32-bit halves — a 9x9
bitboard fills bits past the 53 a double holds exactly — and are put back
together in Swift.

Screens ask `isEngineAvailable()` rather than which platform they are on. The
two stopped being the same question when the engine started shipping inside the
app: it is a build-time fact there, not a platform one, so a bundle running in
an app built without the engine can say so instead of offering a board it
cannot play.

### What the phone stores

`localStorage` does not exist off the web, and what the web build keeps in it is
the account itself: the account UUID and the 256-bit profile key. Unstored, both
would be minted fresh on every launch, so every launch would be a new player.
`store/deviceStorage.ts` resolves per platform — `localStorage` in a browser,
`expo-sqlite/kv-store` on a device — and both halves are synchronous, which
`getOrCreateUserId` needs because it has to answer before the first socket
frame is sent.

### Match alerts on a phone

The queue outlives a closed tab only because the server can call somebody back,
so a phone that cannot be called back is a phone that has to sit and watch a
spinner. It is reached through APNs, which shares nothing with Web Push on the
wire — a device token against a URL and a pair of encryption keys — and
everything above it.

`store/push.ts` is where the two meet. `activePushTransport()` reads the
platform once: `web-push` in a browser, `apns` on iOS, and `null` on Android,
which would be FCM and is not built. `pushCapabilityFrom` stays pure and now
takes either set of facts, so both arms are tested in Node without a device.
Only `detect`, `enable` and `disable` branch; the statuses, the snooze, the
offer rule in `canOfferAlerts` and the panel are shared.

`expo-notifications` is reached through `await import('./pushApns')` rather than
imported. `push.ts` is loaded by the static web export and by the unit tests,
both of which run in Node, and a native module at module scope would be
evaluated by both — the same rule the rest of the file follows for `navigator`.

Three things about iOS are worth knowing before debugging a silence:

- **A simulator reports `unsupported`.** On Apple silicon it will hand over a
  device token that looks entirely real and that only `xcrun simctl push` can
  deliver to. Registering one would leave the account looking reachable for ever
  while every summons went nowhere, which is the one failure the away queue
  cannot contain. Alerts need a real device.
- **A debug build's token is a sandbox token.** The APNs entitlement is
  `development` for anything `expo run:ios` builds, and Xcode rewrites it to
  `production` in a release archive. The server has to be pointed at the
  matching host — `RPS_APNS_ENVIRONMENT=sandbox` for a build off this Mac — or
  Apple answers `BadDeviceToken` and the row is pruned.
- **iOS asks once.** A declined prompt never appears again, and a later request
  resolves without showing anything, so `denied` is a state the panel talks
  about rather than a button that silently does nothing.

`hooks/useNativeAlerts.ts` keeps the promise `sw.js` keeps for a browser: a
summons that arrives while the app is open is recorded and not banner-ed, and
coming back to the app clears any that are waiting. There is deliberately no tap
handler — tapping brings the app to the front, the socket reconnects, and the
`gameId` effect in `_layout` navigates to the board.

### Not on iOS yet

Keyboard replay navigation is web-only: there is no DOM `keydown` to bind off
the web, and `useReplayKeyboard` returns without doing anything. React Native
defines `window` as the global object, so its presence proves nothing — guarding
on `typeof window` alone is how that hook came to throw on a phone.

Android alerts are the other gap. `activePushTransport()` answers `null` there
rather than guessing: an FCM token posted to the APNs route would store cleanly
and never deliver.

Saving a board as a picture is the third. `features/board/export` lays the card
out on every platform — that half is plain arithmetic and is tested in Node —
but painting it needs a canvas and handing the file over needs a share sheet,
and `react-native-view-shot`, `expo-file-system` and `expo-sharing` are all
absent. Adding any of them is a native rebuild rather than a JavaScript change,
so `shareImage.ts` reports `PNG_SUPPORTED: false` and the export dialog draws
no picture section on a phone. The position text, which is what most people
want from that dialog anyway, works everywhere.

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
location = /sw.js { add_header Cache-Control "no-cache"; }

# Debian/Ubuntu nginx ships no mime type for .webmanifest — still absent in
# 1.24 — so it falls through to `application/octet-stream`, and a manifest
# served as a binary blob is a manifest the browser may decline to read. That
# matters more than it looks: `display: standalone` in the manifest is what
# makes an iOS Home Screen install a context where Web Push works at all, so a
# mistyped manifest is an iPhone that can never be notified.
location = /manifest.webmanifest {
    types { } default_type application/manifest+json;
    add_header Cache-Control "no-cache";
}
```

Check both from outside, because a CDN in front can override either one — a
browser cache TTL set at the edge replaces whatever the origin said:

```sh
curl -sI https://rps.example.com/sw.js | grep -i 'cache-control\|content-type'
curl -sI https://rps.example.com/manifest.webmanifest | grep -i 'content-type'
```

The worker deliberately caches nothing itself — it has no `fetch` handler at
all. Expo fingerprints its bundles per deploy, so a cache-first worker would go
on serving an HTML file pointing at chunks that no longer exist. To retire it
entirely, deploy an `sw.js` whose whole body is
`self.registration.unregister()`.
