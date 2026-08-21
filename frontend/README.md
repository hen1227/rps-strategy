# RPS Strategy frontend

The production web build connects to `wss://api-rps.henhen1227.com/ws` and is
published to the repository's `dist` branch.

Each game-mode card carries a **How to play** link that opens a per-mode rules
card (`components/HowToPlayModal.js`): the mode's opening position, the piece
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

## Bots

The home screen's **Play a bot** panel opens a practice board where RPSFish
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

Difficulty lives in `engine/botProfiles.js`, which is the only file to edit when
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
`botArena.js --adjudicate`, an opt-in shortcut for exploratory measurement runs
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
do it. `botProfiles.js` carries a measured depth-cost table for both modes;
re-measure it after an engine change, since a faster engine makes every rung
cheaper without making it stronger.

Strength is measured, not asserted, and the measurement runs headlessly:

```sh
npm run arena -- --ladder --pairs 20      # every rung against the one below
npm run arena -- --a crane --b boulder    # one matchup
npm run arena -- --spread                 # root-score gaps, per mode
npm run arena -- --selftest               # the harness checks itself
```

`scripts/botArena.mjs` loads the shipped worker and WASM from `public/rpsfish/`
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

`engine/botEngine.js` wraps a profile in a `createBot()` object whose only job
is `chooseMove(game, { history })`. It holds no React state and touches no
store, and its engine, random source, and clock are injectable, so the same bot
can be driven by a stub for testing. `engine/botArena.js` uses exactly that
contract to play bots against each other — `playBotGame` for one game,
`playBotPair` for one opening played twice with the colours swapped, and
`playBotMatch` for a full match with statistics. A bot game in the app is
seeded too, and the session records the seed, so a game that produced a strange
move can be replayed rather than described.

While a player is on the bot board the lobby still counts them: the server is
told `bot_session_start`, publishes the total as `botPlayerCount`, and the home
screen shows **"N playing bots"**. The bot board watches the other direction
too. Because the server broadcasts matchmaking waits separately as
`modeQueueCounts`, a bot game shows a live notice whenever a real player is
looking for an opponent in any mode, with a button that joins that queue —
keeping the bot game playable until the match is actually found, at which point
the real game takes the board.

The home screen leads with any tournament that needs attention: signup while
registration is open, then your own scheduled matches and the event's live games
once it starts. On wide screens it splits into a play column and a side column
for live games, friend challenges, and retired modes. Tournament play reuses the
ordinary game screen — readying up on a match starts a normal game session, so
clocks, chat, spectating, and reconnection behave exactly as they do elsewhere.

A floating call to action follows the player across every screen while one of
their matches is waiting, including while they are spectating someone else's
board, and disappears once they are sitting at their own game. Its rule lives in
`store/useTournamentCall.js`, and the derivations behind it in
`store/tournamentSelectors.js`, so the home screen, the tournament board, and
the floating bar always agree.

The **Tournaments** button opens the full board: schedule, standings, and roster.
**Host controls** accepts the backend's `RPS_ADMIN_TOKEN` and exposes tournament
creation, start, and result-override commands. The browser remembers a verified
token in local storage, retries it when host controls are opened, and forgets it
if verification fails or the host taps **Lock**. Tournament HTTP calls use
`EXPO_PUBLIC_API_URL` when set; otherwise the API origin is derived from
`EXPO_PUBLIC_WS_URL` by changing `ws(s)` to `http(s)` and removing the trailing
`/ws`.

Shared visual tokens live in `theme.js` and shared controls in
`components/ui.js`. A mode whose catalog entry has `playable: false` is listed
under **Retired modes** with analysis only; the server refuses matchmaking,
challenges, and new tournaments for it.

The lobby's **Account** button edits the server-side display name and Discord
username shown in online games. The browser generates a 256-bit local profile
key alongside its account UUID, keeps the raw key in `localStorage`, and sends
it as the first WebSocket authentication message and as a Bearer credential for
profile edits. The server stores only the key hash. Clearing site data therefore
creates a new local account identity.

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
