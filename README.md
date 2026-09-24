# RPS Strategy

A real-time, full-stack Rock–Paper–Scissors strategy game on a 9×9 board.

## Structure

- `backend/` — Go HTTP/WebSocket server, modular game modes, SQLite accounts/history, Elo, ranked matchmaking, and a complete PGN record of every game played. See [`backend/README.md`](backend/README.md) for its package layout.
- `frontend/` — Expo React Native app with Zustand state, SVG pieces, and Reanimated transitions.
- **RPSFish** — the deterministic Rust/WASM analysis engine: progressive
  iterative deepening, principal variations, bounded deep-search controls,
  data-driven evaluation weights, and a self-play arena with SPRT testing. Its
  `rpsi` subcommand speaks [the engine protocol](docs/rpsi.md), so it plays
  online through `rpsbot.py` exactly like a third-party engine. It lives in its
  own repository, [hen1227/rpsfish](https://github.com/hen1227/rpsfish), under
  LGPL-3.0-or-later. Nothing in this repository needs it in order to build or
  test — see [Building the engine](#building-the-engine).
- [`docs/review.md`](docs/review.md) — post-game review: how a stored PGN is
  replayed and graded, how an evaluation becomes an expected score, how
  accuracy is computed, and where it is stored.
- [`docs/reach.md`](docs/reach.md) — the **Reach** study tool: reach maps, the
  predator-interception rule and its tempo term, what the race verdict does and
  does not prove, and how to host the tool on another screen.
- [`docs/rpsi.md`](docs/rpsi.md) — the engine protocol. A UCI-shaped line
  protocol on stdin and stdout, so an engine written in any language can play
  here without knowing anything about this server.
- [`docs/bots.md`](docs/bots.md) — the handout for bot authors: what a bot has
  to do, the ten-line example, `rpsbot.py`, ratings, series and tournaments.
  The same text is served at `GET /api/bot/guide` and rendered on the site's
  **Bots** page, so the page and this file cannot disagree. A copy lives in
  `backend/internal/botclient/` because `go:embed` cannot reach out of its own
  directory; a test fails if the two drift.
- [`PRIVACY.md`](PRIVACY.md) — privacy policy and online play agreement. The
  same text is a screen in the app (`frontend/src/features/policy/PolicyScreen.tsx`), linked
  from the app shell's sidebar and its **More** list; edit both together.

## Run locally

Start the server:

```sh
cd backend
go run ./cmd/server
```

Start Expo in another terminal:

```sh
cd frontend
EXPO_PUBLIC_WS_URL=ws://localhost:8080/ws npm start
```

For a physical device, replace `localhost` with the computer's LAN IP address. Android Emulator users can use `ws://10.0.2.2:8080/ws`.

### Building the engine

The analysis screens run RPSFish as WebAssembly. The engine is a separate
repository, so the build is a seam rather than a relative path: clone it beside
this one and `frontend/scripts/build-engine.sh` will find it.

```sh
git clone git@github.com:hen1227/rpsfish.git ../rpsfish
cd frontend && npm run build:rpsfish
```

Set `RPSFISH_DIR` to build against a checkout somewhere else:

```sh
RPSFISH_DIR=~/src/rpsfish npm run build:rpsfish
```

Only a contributor working on analysis needs any of this. Without the engine the
app still runs and `npm test` still passes — the one suite that drives RPSFish
skips itself and prints why. What you lose is the analysis and review screens,
which need `frontend/public/rpsfish/rpsfish.wasm` to exist.

## WebSocket protocol

Connect to `/ws`, then send `authenticate` as the first message with the
browser's account UUID and local profile key, or with the `sessionToken` of a
signed-in account, which takes precedence and is how one player is themselves on
every browser they open. The web client generates the UUID and key in
`localStorage`; SQLite stores only a SHA-256 hash of the key. On its first
authenticated connection, an existing pre-key account is claimed by that
browser. `connection_ready.account` contains the username, Discord,
lifetime win/loss/draw totals, and `modeRatings` — one Elo and record per game
mode. Later client message types are `join_queue`,
`leave_queue`, `queue_presence`, `abort_game`, `rejoin_game`,
`spectate_game`, `stop_spectating`, `leave_game`,
`send_chat`, `request_moves`, `make_move`, `offer_draw`, `accept_draw`,
`decline_draw`, `offer_time`, `accept_time`, `decline_time`,
`resign_game`, `bot_session_start`, `bot_session_end`, `bot_drain`,
`tournament_ready`, and
`tournament_withdraw`. Server message
types include
`queue_update`, `queue_left`, `game_cancelled`,
`mode_player_counts`, `match_found`, `game_rejoined`,
`spectator_joined`, `spectate_unavailable`, `live_games`, `open_challenges`,
`tournaments`, `tournament_rejected`, `chat_message`,
`game_unavailable`, `opponent_disconnected`, `opponent_reconnected`,
`valid_moves`, `game_state`, `bot_draining`, `bot_shutdown`,
`bot_drain_update`, and `move_rejected`.
`connection_ready.modePlayerCounts` provides the initial per-mode population,
and `mode_player_counts` keeps it current; each count includes players in active
games and players waiting for a match. The same two messages carry
`modeQueueCounts`, the per-mode population of players *waiting* for a game —
anybody with an open seek, whether they pressed play or posted a game — and
`modeReadyCounts`, the subset of those who are at the keyboard right now rather
than waiting with the tab closed. Two numbers rather than one, because a queue
of five people four of whom have gone out is honestly both "five waiting" and
"one you could be playing in ten seconds", and either figure alone lies about
the other. `connection_ready` also carries `pushEnabled`, `queue` and `gameId` — the
live game this account is already seated in, which may have opened while the
browser was closed, so a notification has something to come back to —
`botPlayerCount`, the number of players practising against a bot, and
`onlineCount`, how many people are connected at all. That last one counts
*people*, not sockets: two tabs from one account are one person, and engine
connections are not people.

Bots are played entirely in the browser (see
[`frontend/README.md`](frontend/README.md#bots)), so the server holds no board
for them. `bot_session_start` — which takes a `modeId` and is idempotent, so a
reconnecting player can simply re-announce it — records the player as busy with
bots, and `bot_session_end` or a disconnect releases it. A bot game counts
towards `botPlayerCount` only: it is neither a queued player nor a live game, so
it never inflates the per-mode figures a real match uses. Splitting waits out of
the totals is what lets a bot player be told that someone is looking for a real
opponent right now.

A local game — two people sharing one device, from the lobby's **Play someone
next to you** (see [`frontend/README.md`](frontend/README.md#local-games)) —
goes one step further and sends *nothing*. No board, no session, not even the
"busy" marker a bot game files, because there is nobody to tell and nothing to
count: it is unrated, has no clock, and is dropped rather than queued behind a
real match if one is found. It is therefore the one way into a game that works
with the server down, and the only kind of game this project keeps no record of
anywhere but the browser that played it.

An engine somebody connected is the other kind of bot, and that one *is* a
server game: `challenge_bot` names the bot, the mode, and — since it is a
challenge — the seat its sender wants, as a plain `preferredColor` beside the
mode rather than inside a `setup`, because nothing pairs it. Omitted, the
challenger is seated Blue — the side that moves first — the same courtesy a
posted challenge carries. The
engine takes whichever side is left; it never asks for one, and the protocol
already tells it which it got.

An engine also has to be able to *leave* without abandoning the game on the
board, which is what `backend/internal/server/bot_shutdown.go` is for. A drain
takes the bot out of every path that could hand it a new game — challenges,
series, tournament enrolment — while it plays out what it already owes: the game
in progress, the rest of the current *pair* of a series, and every match of a
tournament that has started. It withdraws from tournaments that have not, since
nothing there has been played. When the last commitment settles, a bot that
asked to stop is told to, and one that asked to pause sits connected and idle.

The state lives on the connection and nowhere else, because "no new games until
it reboots" is exactly the life of one socket — `rpsbot.py` restarts the engine
subprocess on every reconnect, so a reconnected bot is a rebooted one. Three
things can ask, and they are the same request: `POST /api/bots/{botId}/shutdown`
from the website, a `bot_drain` frame from the client (Ctrl-C or `SIGTERM`), and
the engine itself printing `shutdown` on stdout, which the client watches for
outside any exchange. The server answers `bot_draining` with what is left to
finish, and `bot_shutdown` when there is nothing — except to a client older than
1.2, which gets `bot_rejected` instead, the message every version since 1.0
already exits on.

### Seeks: one way to want a game

Joining matchmaking and posting a challenge are the same act. Both create a
`Seek` on one board (`internal/server/seeks.go`), and both carry a
`game.GameSetup` describing the whole game: the mode, the clock, the starting
position, the optional rules, whether it is rated, and which seat its author
wants. `join_queue` sends the mode's `StandardSetup`; `send_challenge` sends an
edited one. Everything else — the pairing rule, the public board, the expiry
sweep, cancel-on-disconnect, one-seek-per-client — is written once for both.

**Two people get a game when their setups are equal.** `GameSetup` is comparable
in Go precisely so that `==` can be the whole pairing test, which is why the
starting position is resolved rather than optional: an absent board would make
two setups describing the same opening compare unequal. The only field pairing
does not compare is `preferredColor`, where two seeks fit unless they want the
same seat. So two people who each write out the same unusual game find each
other automatically, and a rated seek is never seated against a casual one.

**A seek belongs to a person, not to a socket.** It is keyed by account, so two
tabs of one account are one wait shown twice, and closing one hands the wait to
the other. More importantly it survives the tab closing altogether: press play,
walk away, and a Web Push notification calls you back when somebody turns up.

That only works for somebody who can actually be called back, which is the rule
the whole thing rests on. On disconnect, a plain search by a named account with
a live push subscription is kept, with `presence` forced to away and a
two-hour expiry started. **Everything else is withdrawn exactly as it always
was** — a posted challenge, an anonymous search, or anybody with no
subscription. A row nobody can be summoned from is a row that spends the next
player's thirty seconds for nothing, so the board never carries one. `Challenge`
therefore reports `present`, and the lobby labels an away row rather than
implying somebody is sitting at it.

Clients report their own half of presence with `queue_presence`: a tab is
*here* only if it is visible and somebody has touched it in the last ninety
seconds. The server takes that at its word and overrules it in the one
direction it knows better, by treating a closed socket as away.

**Pairing opens the board, and the clock is what waits.** Two seeks that fit
become a game immediately, whether or not either player is looking at the
screen: `match_found` goes to whoever is connected, a notification goes to
anybody who is not demonstrably watching, and a browser that comes back later is
handed the game id in `connection_ready`. Nothing is held back except the clock.
Both sides start whole, `clock.activeColor` is `Neutral`, and the first move is
what starts them — so arriving late costs nothing at all.

This replaced an arrangement where pairing produced a *held* match that both
players had to accept before the board opened. It read well and it did not work:
the button is one more thing to miss, a notification that leads to a second
notification is a notification people stop opening, and two people who were both
perfectly willing to play would routinely fail to meet.

A game with no move in it after thirty seconds — the same window a disconnected
player gets to rejoin — is **cancelled outright**: no result, no archive row, no
rating either way, and both sides get `game_cancelled`. The player who had to
move is the no-show and leaves the queue; the other goes back on the board
behind **the same seek** — same id, same `joinedAt` — so the wait they have
already served still counts and the rating band they had widened to does not
snap shut. `abort_game` ends it early, from either side, for somebody who opens
the notification and cannot play; it is refused once a move has landed, when the
only way out is a resignation. `match_found` and `game_rejoined` carry
`firstMoveDeadlineUnixMs` so a client can show the countdown, and zero means the
game is already being played. Accepting a posted challenge works the same way;
tournament matches and bot games open with the clock already running, because a
ready-up and a pipe both already prove somebody is there.

**A standard game offered to the room is a matchmaking search.** If a
`send_challenge` names nobody and its setup equals `StandardSetup`, the server
answers with `queue_update` instead of `challenge_sent` and the seek never
expires — there is nothing about it left to advertise. The frontend draws the
same conclusion before sending, so the button says `FIND A GAME` rather than
promising a row that would not appear. Every seek is published on the open
board either way, including plain searches, so a searching player is somebody
whose row you can click.

A seek addressed to a display username is private: only that person sees it, in
`connection_ready.challenges` when they connect or `challenge_received` if they
are already online, and only they can `accept_challenge` or `decline_challenge`
it. Usernames are matched case-insensitively. Private seeks are never paired
automatically — they wait for the person they name, for up to ten minutes.

**Omit the username and the same message posts to the room.** An open seek goes
out to the whole lobby as `open_challenges` — the full board every time it
changes, plus `connection_ready.openChallenges` on connect — and anybody except
its author can take it. Whoever claims it first gets the game and everyone else
gets `challenge_unavailable`, because removing it from the board *is* the claim.
It cannot be declined: declining destroys a seek, and letting a passer-by
destroy an invitation nobody addressed to them would make the board a heckler's
veto. One seek per client is enforced by the board itself, which is also the
whole anti-spam rule an open one needs.

A challenge is a normal game with edits, so one that edits nothing is a normal
game — **rated included**. `casual: true` is the knob that makes it unrated;
being challenged is not. `rules` holds the engine rules a game may drop —
`noRepetitionDraw`, `noDrawOffers`, and `noTimeExtensions`. Every field there is
a deviation, so an absent or empty `rules` is the ordinary game, and
`game_state` echoes it back so a client can hide the offers a game has switched
off.

A draw offer and a time extension are both mutual agreements: only one of each
kind is live at a time, a player may open one only once per move, and only the
opponent can answer, with `accept_draw`/`decline_draw` or
`accept_time`/`decline_time`. `game_state` carries the live proposals in
`drawOfferedBy`, `drawOfferUsedBy`, `timeOfferedBy`, and `timeOfferUsedBy`.

Where they differ is whose clock the proposal belongs to. A draw is a move
substitute, so `offer_draw` is accepted only on the offering player's turn and a
move by its recipient declines it. Running low on time happens whenever it
happens, so `offer_time` is accepted from either player at any point, on or off
turn, and the request stands until it is answered — playing a move does not
cancel it. Accepting adds three minutes to **both** clocks, so agreeing to play
on never costs the accepting player their time advantage.

`connection_ready.liveGames` and subsequent `live_games` messages populate the
lobby's live rail with player names, Elo, mode, spectator count, and a compact
picture of each current board. The server republishes those compact positions
after every move, so the rail's featured board is genuinely live without
sending the several-kilobyte full `game_state` for every game to the whole
lobby.
Spectators are read-only game-session members: they receive the current board
and every later `game_state`, and can exchange authenticated chat messages with
the players. Each chat message identifies whether its sender is a player or a
spectator. Chat history is capped at 100 messages and is returned on player
rejoin or spectator join; viewer-side controls can hide all chat or, for
players, hide only spectator messages.

A result does not close the conversation. When a game finishes it leaves the
lobby immediately, but its players and spectators stay together in a chat room
that keeps accepting `send_chat`. Nobody in the room is a player or spectator of
a live game any more, so they are free to queue for another match while they
talk. `rejoin_game` readmits a player whose connection dropped, chat history and
all. The room closes as soon as its last member sends `leave_game` or
disconnects.

A room is not always one game. Every game of a bot series shares one, because a
run is watched as a single thing: whoever follows it to its next board and
whoever stays on the one that just ended are in the same conversation and hear
each other. Every match of a **bots-only tournament** shares one for the same
reason, with the boards side by side rather than one after another — nobody in
that event is playing, so its whole audience is one crowd instead of one room
per board with a single person in each. An event with people in it keeps a room
per game: chat between concurrent matches of a human event is coaching.

So `match_found`, `game_rejoined` and `spectator_joined` all carry a
`chatRoomId` and a `chatRoomScope` of `game`, `series` or `tournament`, and
every `chat_message` carries a `roomId` beside the `gameId` it was typed at —
for an ordinary game the two are equal, for a series the room is the series, and
for a bots-only event it is the event. A client matches arriving messages on the
room, not on the board it is showing.

Names belong to accounts. Everyone plays as "Guest" until they sign in with
Discord from **Account** in the app shell, which attaches that identity to the
anonymous one the browser already has — same user ID, same ratings, same games.
Signing in elsewhere brings all of it along. Username and Discord are copied
into every new online game's player profiles and shown next to each clock, and
editing them takes the session token rather than the local key.

Discord is the only way to make an account. Accounts created before that keep
their password and can still sign in with it, and are prompted to link a Discord
account; linking deletes the password hash. No new password account can be
created, and `/api/auth/login` goes when the last one has linked.

Ranked play needs an account. A signed-out player still gets casual online games
and bots — the server forces `casual` on their own search rather than refusing
it, and refuses only when they try to accept somebody else's rated game, because
that setup belongs to whoever posted it.

The backend owns the whole OAuth conversation: the app never gives Discord a
redirect URI and never sees an authorization code. Discord returns to
`/api/auth/discord/callback`, which trades the code for an identity and sends
the browser home carrying a one-shot ticket, redeemed by a second request. That
is what lets the web app and the iOS app share one Discord application, and what
keeps `rps-strategy://` out of the portal entirely.

```text
POST   /api/auth/discord/start    Bearer <session-token | local-profile-key>
GET    /api/auth/discord/callback
POST   /api/auth/discord/exchange
POST   /api/auth/discord/complete
POST   /api/auth/login            legacy; no new password accounts
GET    /api/accounts/{userId}
PATCH  /api/accounts/{userId} Bearer <session-token>

GET    /api/push/key
POST   /api/push/subscriptions   Bearer <session-token | local-profile-key>
DELETE /api/push/subscriptions
POST   /api/push/devices         Bearer <session-token | local-profile-key>
DELETE /api/push/devices
POST   /api/push/test            Bearer <session-token | local-profile-key>
```

The push routes are what let a queue outlive a tab. They take either credential,
because the player most in need of being called back is a Guest who has never
registered. `/subscriptions` is a browser's Web Push endpoint and its two
encryption keys; `/devices` is an iOS device token, which is the whole of what a
native app has to give. They are separate routes because they share nothing on
the wire, and one store because "can this person be called back" has to be one
question with one answer however many devices somebody owns.

`GET /api/push/key` answers `{"enabled": false}` on a deployment with no VAPID
keys, and `connection_ready` carries a `pushTransports` object saying which
kinds of device this server can actually reach. A client reads the half that
applies to it and hides the whole offer rather than showing a button that cannot
work — with no keys of either kind set, matchmaking behaves exactly as it did
before any of this existed. Generate a VAPID pair with `go run
./cmd/vapidkeys`; APNs wants an Apple `.p8` key, named by `RPS_APNS_KEY_PATH`,
`RPS_APNS_KEY_ID` and `RPS_APNS_TEAM_ID`.

`POST /api/push/test` sends one notification to the account that asked for it
and answers with how many devices it went to, of either kind. It is the only way
to tell a working registration from one that stores cleanly and silently
delivers nothing — which are otherwise indistinguishable right up until somebody
misses a game — and the button for it sits on the account screen beside the
switch.

**Your-game-has-started is the only notification this server sends on its own.**
No reminders, no "somebody is waiting", no digests. The thirty-second window,
the two-hour away expiry and that one-notification rule are the three things
standing between a queue worth having and an app people mute — and a muted app
cannot call anybody back at all.

Matchmaking is ranked, never pairs two connections from the same account, and pairs players by game mode and exact time control. Ratings are per mode: a queue compares the two players' ratings in the mode being played, so strength in one mode never decides who you meet in another. A mode a player has never finished starts from their shared account rating. Matching begins at ±100 Elo, prefers the closest eligible rating, widens its tolerance as wait time increases, and becomes Elo-unrestricted after two minutes. A completed game's final `game_state` includes a `ratingUpdate` naming the rated mode; the history, that mode's rating, and both players' lifetime records are committed atomically so a game ID cannot be counted twice.

Persistent account data is also available over HTTP:

```text
GET /api/accounts/{userId}
GET /api/accounts/{userId}/games?limit=20&offset=0
GET /api/accounts/{userId}/record/{opponentId}
GET /api/leaderboard?mode=&kind=human|bot&minGames=&limit=&offset=
GET /api/bot-matches?botId=&botId=&mode=&limit=&offset=
GET /api/bot-series?limit=
POST /api/bot-series                        start one, as anybody
POST /api/bot-series/{seriesId}/abort       stop the one you started
POST /api/bots/{botId}/shutdown             drain a bot you own; {"exit":true} stops it
DELETE /api/bots/{botId}/shutdown           call the drain off
```

The ladder is one route serving two boards, because "who is winning" is the same
question asked of two populations — players and bots are separate because a
bot's rating comes from a different competition, since bot-versus-bot series are
ranked and bot-versus-human is not, *and* because the two are computed
differently. A person's Elo is a per-game transfer. A bot's rating is a fit over
the head-to-head record of every pair of bots, because an engine's author picks
its opponents and a transfer system pays out for beating a fresh account — so
that ladder caps what one matchup can be worth, wants at least two opponents per
bot, publishes only the group of bots that all play each other, and assumes
nothing at all about a bot nobody has played. See
[`backend/internal/persistence/bot_rating.go`](backend/internal/persistence/bot_rating.go).
Four exclusions, each for its own reason:
disabled accounts, because a ban that leaves someone on the front page is not
much of a ban; unregistered accounts on the human board, because every browser
that has ever loaded the site owns a real playable account called "Guest";
anyone below `minGames`, because an untested rating is a starting value
rather than an achievement; and, on the bot board, every engine but its owner's
best, because an owner may enter five and five entries of one engine are one
result reported five times. The engines left off keep their ratings, their
profiles and their place in the bot directory — what they lose is a second seat
on a page of fifty — and an engine whose registry row has gone counts as its own
owner, because an unknown owner is not a shared one.

The bot board carries the games behind it. `GET /api/bot-matches` is the
bot-versus-bot slice of `game_history` — both seats' account kind is `bot`,
which is not a column, so the server answers it rather than shipping the whole
history and the roster for a client to join. `botId` may be repeated, and means
*either* seat: a leading bot's game against a bot outside the top eight is still
one of its games, so scoping the history to a board of eight must not drop it.
`mode` narrows the history to one mode, for a caller that is showing one mode's
board: a page of the best Infiltration bots followed by their Total War games
answers a question nobody asked. The Leaderboard page stands both mode boards
side by side instead, so it asks for every mode and each row names the one it
was played in. Every row carries the `seriesId` and `tournamentId` it belonged
to, because the history is read as a feed of *occasions* rather than of games
and a client cannot group them without being told which belong together.

**A run is one card, not six rows.** The Bots and Leaderboard pages share
`BotHistoryFeed`, which merges three things into one list, newest first: a
series as a card; a tournament as a single summary linking to the event's own
page, since a round robin between eight engines is twenty-eight games and
listing them would bury everything else; and a bot game belonging to neither as
one row in its place in the order.

Inside the card is a score table, which is the shape a match between two engines
already has: each bot owns a row with its portrait and name, each game owns a
column, and a point sits under the game in the winner's row — one, nothing, or
half each. This replaced a row of W/L/D chips, which did not work: a letter is
only readable against a side, the side was named once above the row, and the
seats swap every game, so the reader had to hold "W means the left one" in their
head and apply it six times against the instinct to read it off the board. Whose
W it was is the thing the strip existed to say. A game that ended in a walk-off
is written out under the table — who left, and who was awarded the win — because
that is the one result people ask about when a score looks wrong.

A run that was stopped early shows only the games it played. The server writes a
game's row when that game *begins*, so the pairs an abort cancelled were never
recorded and drawing them would mean inventing games that read as losses. The
game the abort interrupted does still count: stopping a run does not stop the
board two engines are already on, so that game finishes, is rated, and is filed
against the run — which it silently was not before, leaving a decided game
sitting on the record as pending for ever.

`GET /api/bot-series` carries each run's games with it, and `?game=` asks the
same question backwards: which run was this game part of. That second form is
what puts the table over the board on the review and spectate screens, so a game
reached from a shared link knows it was the fourth of six and can step to the
others — with the same hand-off animation a spectated series plays when it moves
to its next board. Both directions go through one hook, `useBotSeries`, which
takes either key: the review screen used to carry its own copy of the request,
and a second fetch policy is a second answer to what a failed lookup looks like.

**Every occasion has an address, and a run's address is a page.** A card in the
feed is not one: the feed is a moving window over the last two dozen runs, so a
link to "the card on the Bots page" stops leading anywhere within the day. So a
run has `/bots/series?series=…` — under `/bots` because that is the section it
belongs to, which is what keeps Bots lit in the sidebar for somebody arriving
from a pasted link, and a query parameter rather than a path segment for the
reason every other page here gives: the site exports as one HTML file per route
and a series id is not knowable at build time. The page draws the same
`SeriesScoreTable` the feed draws, and adds what a card has no room for — every
game with its own link, which seat each engine held, and the four numbers that
would let somebody run it again (mode, clock, opening plies, seed).

Which means the two directions are both covered. From the history: a run copies
a link to its page, and a bot game belonging to no run copies a link to its
review. From a shared game link: the strip over the board steps between the
run's games, and the record card beside it offers the run itself. Nothing on
either path builds a URL — `links.ts` owns every address, and `shareURL` turns
any of them into the whole thing, so a route that moves takes its shareable form
with it rather than leaving a stale copy behind in a second file.

Which column goes where is decided by the lobby's live list rather than by the
run's own rows. A game still being played has no archived record, so sending
anybody to its review lands them on "this game cannot be reviewed"; it is
spectated instead. A column that is neither decided nor live — the game a
stopped run was in the middle of — is inert, because there is nothing behind it.
And because every game of a run shares one chat room, the review screen keeps
the chat up for any game of a run that is still being played, not only for the
board the socket happens to be seated on.

Starting a series is no longer a host command. The cost argument for making it
one was real — a run holds two engines for as long as it lasts — but the
permission argument was not: every bot already carries a `public_play` switch
saying whether strangers may play it, and a series is strangers playing it. So
`POST /api/bot-series` takes either credential, like the push routes, and the
cost is handled by limits instead: at most 3 pairs, at most 10 minutes each, one
running series per account, two across the server, and a token bucket per
account and per IP. The clock is bounded above and not below — the form offers
down to 0.1+1, six seconds each with a second back per move, which is a run that
settles a question while somebody watches it. Both bots must be open to public play or belong to the
caller, the row records who asked, and only that person — or an admin — can stop
it. `POST /api/admin/bot-series` is the same call without the ceilings, which is
what a fifty-pair run at a real time control needs.

Note what the combined board does **not** order by: `accounts.elo`. That column
is only the seed a new mode inherits — ranked play moves
`account_mode_ratings` — so ordering by it would sit every player on 1200 for
ever. There is no single number for "how good is this player" in a game with
per-mode ratings, so the combined board ranks each account by its strongest
mode and reports which mode that was.

### Game records

Every game is stored in full as PGN. One record contains the board the game
started from, every move, both clocks after every action, the draw offers and
time extensions the players exchanged, and how it ended — enough to replay the
game through the real mode rules and arrive at the identical final position,
clocks included. Records are written for ranked, unranked, private-challenge,
tournament, and self-play games alike, and a game still in progress when the
server stops is stored as far as it was played.

```text
GET /api/games/{gameId}/pgn
GET /api/accounts/{userId}/games/pgn?limit=20&offset=0
GET /api/admin/games/pgn?since=&until=&mode=&ranked=&limit=&offset=&format=pgn|json|jsonl
```

The bulk export is host-only and ordered oldest first, which is the order a
training set is built in. See [`backend/docs/pgn.md`](backend/docs/pgn.md) for
the notation, the tag list, and how to replay a record.

A record is also what the in-app review reads. After any game the result card
offers **Review this game**, which replays the stored PGN in the browser,
grades every move against RPSFish, charts the evaluation, and reports each
player's accuracy. A player's own accuracy is stored with the game:

```text
PUT /api/games/{gameId}/accuracy      one player's review, keyed by their local key
GET /api/games/{gameId}/accuracy      both sides' stored reviews
```

Reviews live in their own table and are attached to `?format=json` responses,
so the PGN column stays a complete game on its own. See
[`docs/review.md`](docs/review.md) for how the numbers are calculated and why
the server records a client's measurement rather than making its own.

A reconnecting client is *told* what it is already in rather than asked to
guess: `connection_ready` carries `queue` and `gameId`, so a blip resumes a
search with its elapsed time intact instead of silently ending it, and a browser
that has never heard of the game waiting for it is handed the id. Re-sending
`join_queue` would mint a new seek and throw the wait away, so no client does.

When a player disconnects, their seat remains reserved for 30 seconds. Rejoining requires both the saved game session ID and the same user UUID. If the deadline expires, the connected opponent receives a final `game_state` with `endReason: "abandonment"`. A pending draw offer is included as `drawOfferedBy`; it can be accepted, explicitly declined, or declined by continuing play. The server permits one draw offer per player turn.

### Automatic endings

Two endings come from the game engine rather than from any mode, and a mode may
say what each of them is worth by declaring a feature (see
[`backend/docs/game-modes.md`](backend/docs/game-modes.md)):

- **Repetition** — the third occurrence of the same position, including
  territory ownership and the side to move (`endReason: "repetition"`, a draw).
  A mode that declares `no_repetition_draw` has no such rule: repeating a
  position there is play, and only the clock bounds the game.
- **Stalemate** — the player to move has no legal move (`endReason:
  "stalemate"`). A draw normally; a loss for the stuck side in a mode that
  declares `stalemate_loses`. `Game` decides this by asking the active mode for
  its own legal moves, so a mode with custom movement gets the rule for free.

Where stalemate is a draw, a mode needs no annihilation rule to handle a
wiped-out army: Infiltration wins only by arriving at the far boundary, so a
player reduced to zero pieces draws rather than losing. Intransitive is the
mode that declares both features, which turns the same position into a loss —
a race for one tile is not something a side may sit out, and shuffling is not
worth half a point.

### Who moves first

Blue. Blue's home boundary is rank 1, the board is drawn from that edge the way
a chessboard is drawn from White's, and Blue takes the `1.` in a PGN. The seat
that opens is also the courtesy seat: matchmaking gives it to the older seek, a
challenge to its author, and a tournament to the match's first player. The rule
lives in one place — `game.FirstToMove` in `backend/internal/game/types.go` —
which is what every board, clock, and move number reads.

The server sends its registered mode catalog in `connection_ready` and exposes the same catalog from `GET /api/modes`. Each entry carries a `playable` flag: a mode retired with `playable: false` keeps its rules, existing games, and analysis board, but the server refuses matchmaking, challenges, and new tournaments for it, and the lobby offers only analysis. Each catalog entry includes the mode's validated starting position, which also drives the lobby preview. The frontend renders that catalog dynamically and requests legal moves from the active server-side mode. See [`backend/docs/game-modes.md`](backend/docs/game-modes.md) for the self-registering mode contract, starting-position format, and a complete example.

### Time controls

Games default to five minutes per player with a three-second Fischer increment. Omitting `timeControl` keeps that default:

```json
{"type":"join_queue","modeId":"V5"}
```

Clients can request any positive initial time and non-negative increment, both expressed in milliseconds:

```json
{
  "type": "join_queue",
  "modeId": "V5",
  "timeControl": { "initialTimeMs": 60000, "incrementMs": 1000 }
}
```

`connection_ready.defaultTimeControl` advertises the backend default and each `queue_update.timeControl` echoes the selected control. Every `match_found` and `game_state` snapshot contains:

```json
{
  "timeControl": { "initialTimeMs": 300000, "incrementMs": 3000 },
  "clock": {
    "redRemainingMs": 300000,
    "blueRemainingMs": 300000,
    "activeColor": "Red",
    "updatedAtUnixMs": 1786982400000
  }
}
```

The backend owns clock accounting. For a live display, subtract elapsed time since `updatedAtUnixMs` from the active color locally; subsequent server snapshots resynchronize it. A timeout produces a final `game_state` with `status: "Finished"`, the opponent in `winner`, `endReason: "timeout"`, zero remaining time for the flagged player, and `activeColor: "Neutral"`.

### Tournaments

Tournaments have their own section, and the front page carries whichever of them
needs attention: the registration panel while registration is open, then the
player's own scheduled matches and the games running right now once the host
starts the event. Finished events stay in the section's archive. A
player readies up on a match and the server starts an ordinary game session as
soon as their opponent does, so tournament play reuses the normal board, clocks,
chat, spectating, and reconnection. Finishing the game records the result and
updates the standings without the host typing anything in.

There is a **weekend bot arena** on its own page: one tournament a weekend,
built automatically from every engine that is online, with a countdown, a live
crosstable and two community decisions — a ballot for the event's time control,
and a 36-hour availability window for when it should be. The window is approval
voting rather than a pick: the field is worldwide, so people mark every slot they
could turn up for and the event moves to the fullest one, a week at a time. It
spans thirty-six hours rather than twenty-four because a weekly event has to name
a night as well as an hour, and an hour on its own cannot — the slot one reader
calls Saturday evening is Sunday morning for another. Every slot is shown in the
reader's own timezone and grouped under the reader's own day names, so which is
Saturday and which is Sunday is never a conversion anybody has to do. Weekend
events stay off the tournaments board and out of the Tournament Champion title;
they have a rolling crown of their own, held by whoever has won the most weekends
in the last ninety days. The host configures all of it — including where the
thirty-six hours sit — from the Weekend tab of the admin screen.

Registering asks one question: **who is entering.** An account may enter itself
or exactly one of the bots it owns, never both and never two engines, and it can
withdraw and choose again until the host starts the event. That is the whole of
how an engine gets into a bot tournament — its author registers it, and the
picker names the reason for any of theirs that cannot enter rather than quietly
leaving it out. Once the event starts, every engine in it is held in reserve:
still online, and not taking challenges or series until it finishes.

While a match of theirs is waiting, a persistent bar follows the player across
every screen — including while they spectate another board — and takes them
straight into their own game. An account with the admin flag reaches those
commands with its own session; a host without an account still unlocks them by
pasting the server's `RPS_ADMIN_TOKEN`. Either way the commands are the same:
create events, start the signup-order round robin, and override a result. Note
that `adminOnly` asks who the caller is *before* checking whether a host token is
configured — the other order answered 503 to a legitimate administrator on any
deployment that had not set the environment variable. The board publishes the roster, ordered rounds,
W/L/D record, points, and winner. See [`backend/README.md`](backend/README.md)
for the tournament API, the readiness protocol, and deployment configuration.

### Titles

A title is the short tag that sits in front of a name — `GM`, `TC`, `DEV` — the
way `GM` sits in front of a chess player's. They appear wherever a player is
named: both bars of a live board, every line of game chat, the ladder, and the
lobby rows that offer a game.

Two halves, deliberately separate:

- **Owning** one is a row in `account_titles`, and permanent. A Grandmaster who
  has a bad month is still a Grandmaster, which is what makes a collection worth
  having. Clearing a rung of the rating ladder awards it *and* every rung below,
  so a player who prefers the modest tag can wear it.
- **Wearing** one is a single column on `accounts`. At most one goes in front of
  the name, wearing none is the default, and only a title the account holds may
  be chosen. Choosing reconnects the lobby socket, which is what rebuilds the
  profile everyone else sees this player through.

The catalogue is code rather than data (`backend/internal/persistence/titles.go`),
because every earned title needs a rule somebody has to write anyway and a
titles *table* would be a second place to say the same thing. It is public at
`GET /api/titles`: an unearned title is only worth chasing if its requirement can
be read.

Titles are earned two ways and granted a third. The rating ladder — `CM`, `FM`,
`IM`, `GM` — reads the best rating held in any one mode with at least ten ranked
games behind it, since modes rate independently and requiring the bar everywhere
would title nobody who specialises. The achievements are `TC` for finishing a
tournament on the most points, `BSL` for beating a registered engine somebody
*else* owns, `STK` for eight rated wins in a row, and `BM` and `ARC` for owning
an engine that has won a tournament or that tops a mode's bot ladder. `D` is the
one with no bar to clear: Discord has vouched for the account, which makes it
the commonest tag on the site and the reason it is a single letter. An
administrator grants anything out of the same catalogue, including `DEV` and
`MOD`, which no rule awards.

Engines collect nothing themselves: a bot's rating comes from a fit across every
pair's head-to-head record rather than from per-game Elo, so it is not on a
person's scale, and the achievements its games produce accrue to its owner —
who is the one who turns up in chat. A bot can still be granted a title.

The rulebook re-runs after a finished game, after the last result of a
tournament, on connect, and when a Discord sign-in finishes — that last one so
`D` is on the account the sign-in reply hands back rather than arriving at the
next reload. It only ever adds, so a rating that falls back keeps
the title. Anything new arrives as an `account_updated` message carrying the
player's own refreshed account, which is what puts a title on the account page
without a reload.

### Openings

Three different claims share the openings page, and the page keeps them apart
because they are not the same kind of statement.

**What the engine will stand behind.** RPSFish certifies a handful of openings
per mode: a line runs while exactly one continuation is strictly best, mirror
twins folded, at a position searched deep enough, and stops at the first ply
where that fails. Each carries why it stopped — "three replies tie here" is
more use to somebody studying the opening than a line drawn through the branch.
The test is on the *ranking* rather than on a score margin, so it needs no
recalibrating when the evaluation is re-tuned. An empty list is a real answer:
Total War's book certified nothing when this was written, because its root
spans +2 to +1 across ten moves.

**What people call things.** Anybody can name an opening up to six plies deep,
published on the spot rather than queued, and the line is checked against the
*rules* rather than against the book — so the openings RPSFish never analyzed,
which is most of the interesting ones, can be named at all. Names carry who
gave them, a curator can remove one, and they are listed in their own
searchable index rather than beside the certified lines.

**What people actually play.** The server recompiles opening statistics from
the game archive daily, by replaying every game under the current rules.
`GET /api/openings/{mode}/stats` is the condensed dataset for a mode in one
request — every prefix counted, so `x% of games follow this path` is one
lookup. A game the current rules refuse is replayed again through a half turn:
the first mover changed on 2026-09-03, and rotating the board and swapping the
colours makes a game Red opened the same game with Blue opening, so most of the
archive counts as the openings it actually played rather than not at all. Those
are counted *and counted as turned*, and a game that will not replay either way
is skipped *and counted as skipped*.

That has its own page: **the opening explorer** at `/explorer` is a board you
move pieces on, and every figure beside it is about the position in front of
you. It is keyed on the *board* rather than on the move order, so two ways to
the same picture share one set of numbers — the question somebody standing on a
board is actually asking. The most played continuations are drawn on it as
arrows, thickest for the commonest, which is the analysis board's own arrow
layer weighted by frequency instead of by engine rank.

See [`backend/docs/opening-book.md`](backend/docs/opening-book.md) for the
graph format, the export pipeline, and the API.

## Production backend

The Orange Pi deployment uses systemd to supervise the Go binary and Nginx to
proxy `api-rps.henhen1227.com` to:

```text
unix:/var/www/production/henhen1227/rps-henhen1227-backend.sock
```

The binary and SQLite database remain under
`/var/www/production/henhen1227/api-rps.henhen1227.com/`. See
[`backend/README.md`](backend/README.md#orange-pi-production-deployment) for the
ARM64 build command, systemd unit installation, Nginx site configuration, and
verification commands.
