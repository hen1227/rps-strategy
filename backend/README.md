# Backend

Go HTTP/WebSocket service for RPS Strategy.

## Layout

```text
backend/
├── cmd/server/          # Executable entry point and process lifecycle
├── deploy/              # systemd, Nginx, and production environment templates
├── docs/                # Backend-specific development documentation
├── internal/game/       # Game state, rules, modes, clocks, event records, and tests
├── internal/notation/   # PGN reader and writer for complete game records
├── internal/persistence/ # SQLite schema, account stats, history, Elo, the game archive, and reviews
├── internal/server/     # HTTP, WebSocket protocol, sessions, and matchmaking
├── go.mod
└── go.sum
```

Code under `internal/` cannot be imported by projects outside this Go module.
The game package is transport-independent; the server package owns all HTTP and
WebSocket concerns and depends on the game package. The notation package
depends only on the game package, so reading and writing archived games never
needs a database or a server.

Every finished game is archived as PGN, in full, and can be replayed back into
the position it ended in. See [`docs/pgn.md`](docs/pgn.md) for the format, the
export endpoints, and the replay API, and
[`../docs/review.md`](../docs/review.md) for the post-game review the archive
feeds.

## Development

Run the server:

```sh
go run ./cmd/server
```

Run all tests:

```sh
go test ./...
```

Build a local development binary:

```sh
mkdir -p bin
go build -o bin/rps-server ./cmd/server
```

The server listens on `PORT` (default `8080`) during local development. When
`RPS_UNIX_SOCKET` is set, it takes precedence over `PORT` and accepts an
absolute Unix socket path with an optional `unix:` prefix. Set
`RPS_ALLOWED_ORIGINS` to a comma-separated list of permitted browser origins.
Native WebSocket clients and local development origins are accepted without
extra configuration.

Tournament host commands are disabled unless `RPS_ADMIN_TOKEN` is set to a
secret of at least 32 characters. Keep that token server-side; the frontend has
a **Host controls** field where the tournament organizer can paste it for the
current browser. The token is sent as a Bearer credential, saved in local storage
after entry, and removed automatically if verification fails. It is not included
in the public web build.

### Notifications

Notifications are the one channel that reaches a player who has closed the tab,
and therefore the only reason a matchmaking seek is allowed to outlive its
socket. They come in two kinds — Web Push for a browser, APNs for the iOS app —
and each is configured, and can be missing, on its own. `HasPushSubscription`
counts both, so "can this person be called back" stays one question with one
answer whichever devices they happen to own.

#### Web Push

Off until three variables are set:

```sh
go run ./cmd/vapidkeys   # prints all three, ready to paste
```

`RPS_VAPID_PUBLIC_KEY`, `RPS_VAPID_PRIVATE_KEY` and `RPS_VAPID_SUBJECT` (a
`mailto:` or `https:` URL the push services can reach a human at). Setting some
but not all of them is refused loudly rather than treated as "off": a silently
half-configured push sender would leave the queue holding places for people it
cannot reach.

With none of them set the feature is cleanly absent — `GET /api/push/key`
answers `{"enabled": false}`, `connection_ready.pushTransports.webPush` is
false, the app hides the offer to wait with the tab closed, and every disconnect
withdraws its seek exactly as it did before the persistent queue existed.

Rotating the keys invalidates every stored subscription. Nothing needs cleaning
up by hand: the first delivery attempt to a stale endpoint comes back `410`, and
the row is deleted then, along with any wait that person had left on the board.

**Checking a deployment.** Three things, in order, because each one can fail on
its own and they fail identically from the outside — nothing arrives:

```sh
curl https://api-rps.example.com/api/push/key
# {"enabled":true,"publicKey":"B…","transports":{"webPush":true,"apns":true}}
```

`transports` is the per-kind answer, and the one to read when only one half of
this is working: `webPush` false is missing VAPID keys, `apns` false is a
missing, unreadable or unparseable `.p8` — and the server logged which at
startup.

That is the server. The browser is next: open the site over **https**, go to
**Account → Match alerts**, and turn them on — the permission prompt only ever
appears from a real press, so nothing about this can be automated. The panel
then offers **Send a test**, which is the third check and the only one that
exercises the whole chain: `POST /api/push/test` encrypts a payload with the
VAPID keys, hands it to the browser's own push service, and answers with how
many browsers it went to. A subscription that stores cleanly and then silently
delivers nothing looks exactly like one that works until that button says so.

Two things outside this server can still swallow a notification: iOS delivers
Web Push only to a site added to the Home Screen, and `/sw.js` must be served
uncached from the site root (see
[`frontend/README.md`](../frontend/README.md#deploy-the-dist-branch-on-the-orange-pi))
or browsers go on running an old worker.

#### APNs, for the iOS app

A native app has no service worker to wake, so the same promise is kept with an
Apple push key and a device token. Three variables, and the same all-or-nothing
rule:

```sh
RPS_APNS_KEY_PATH=/etc/rps/AuthKey_ABCD123456.p8
RPS_APNS_KEY_ID=ABCD123456        # the .p8 filename, minus AuthKey_
RPS_APNS_TEAM_ID=XYZ9876543       # Apple Developer → Membership
```

The key is the **Apple Push Notification service** key from Apple Developer →
Keys, downloaded once as a `.p8` and never again. Two more are optional:

- `RPS_APNS_TOPIC` defaults to `com.henhen1227.rps-strategy`, the app's bundle
  id, which is what APNs means by a topic.
- `RPS_APNS_ENVIRONMENT=sandbox` points deliveries at
  `api.sandbox.push.apple.com`. **A token from a debug build only exists in the
  sandbox**, so a development machine wants this and a deployment serving the
  App Store build does not. Getting it wrong is the one APNs mistake that looks
  exactly like a working setup: Apple answers `BadDeviceToken`, the token is
  pruned, and the log says so naming this variable.

Everything downstream is shared. `POST /api/push/devices` stores a token where a
Web Push endpoint goes, `summon` fans one payload out to every address an
account has, and a `410 Unregistered` prunes a phone and drops the wait it left
on the board exactly as a `410` from a push service does for a browser. **Send a
test** on the account screen reports how many devices it reached, of both kinds.

Rotating or revoking the Apple key does not invalidate stored tokens — they are
addresses, not credentials — so a new key with the same team and bundle id keeps
working without anybody re-registering.

## Orange Pi production deployment

Production uses systemd to supervise the Go process and Nginx to proxy HTTP and
WebSocket traffic. The binary and SQLite database live in:

```text
/var/www/production/henhen1227/api-rps.henhen1227.com/
```

The process listens only on this Unix socket, so no backend TCP port is exposed:

```text
/var/www/production/henhen1227/rps-henhen1227-backend.sock
```

### Deploying an update without ending anybody's game

`./deploy-backend.sh` from the repository root does all of this, and does it in
an order that matters: it installs the new binary **while the old one is still
serving**, then asks the server to drain.

A drain stops the server taking new games, lets the ones already on the board
finish, and then exits — so systemd's `Restart=always` brings up the binary that
was installed in step one. Nothing runs `systemctl restart`, which is why there
is no gap between the last move of the last game and the new build answering.
Everybody connected gets a banner explaining why the play button is refusing,
and the script prints what the drain is still waiting on while it waits.

```sh
./deploy-backend.sh --say "Back in about a minute."
./deploy-backend.sh --now --say "Sorry — restarting to fix the clock bug."
```

`--now` skips the waiting and restarts immediately, posting the message as an
announcement first. That is the escape hatch, and it costs whatever is on the
board: those games are archived unfinished, exactly as every restart used to do.

The same two controls are on the admin screen, for the deploy that has to be
called off and the apology that is owed after one. The routes behind them:

```text
POST   /api/admin/drain    {"note":"Back in about a minute."}
GET    /api/admin/drain    what it is still waiting on
DELETE /api/admin/drain    put the server back in play
POST   /api/admin/notice   {"text":"…","tone":"notice"|"warning"}
DELETE /api/admin/notice
GET    /api/notice         public: the standing announcement, if any
```

`GET /healthz` carries a `build` stamp — set with
`-ldflags "-X rps-strategy/backend/internal/server.build=…"`, which the deploy
script does — so a deploy can tell the new process from the old one rather than
sleeping and hoping. It also reports `"status":"draining"` while a restart is
pending, which is still healthy: the server is serving games, just not starting
new ones.

A drain waits at most twelve minutes. A bot series finishes its current pair and
stops; a tournament keeps its pairings, and both players ready up again after
the restart. `SIGTERM` is deliberately unchanged — `systemctl restart` still
stops the server at once and archives what was on the board as `Interrupted`.

See `internal/server/deploy_drain.go` and `internal/server/announcements.go`.

### 1. Build and upload the ARM64 binary

The steps below are what the script automates, for a first install or a manual
one. On the development machine:

```sh
CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -trimpath \
  -ldflags="-s -w" -o /tmp/rps-server-arm64 ./cmd/server
scp /tmp/rps-server-arm64 deploy/rps-strategy.service \
  deploy/rps-strategy.env.example deploy/nginx-api-rps.conf orange-pi:/tmp/
```

On the Orange Pi, stage the binary inside the destination directory before the
rename so replacing it is atomic:

```sh
sudo install -o root -g www-data -m 0750 /tmp/rps-server-arm64 \
  /var/www/production/henhen1227/api-rps.henhen1227.com/rps-server-arm64.new
sudo mv /var/www/production/henhen1227/api-rps.henhen1227.com/rps-server-arm64.new \
  /var/www/production/henhen1227/api-rps.henhen1227.com/rps-server-arm64
```

### 2. Configure systemd

Merge the four values in `/tmp/rps-strategy.env.example` into the existing
production `.env` file, then install the systemd unit:

```sh
sudoedit /var/www/production/henhen1227/api-rps.henhen1227.com/.env
sudo chmod 0640 \
  /var/www/production/henhen1227/api-rps.henhen1227.com/.env
sudo cp /tmp/rps-strategy.service /etc/systemd/system/rps-strategy.service
sudo systemctl daemon-reload
sudo systemctl enable --now rps-strategy.service
```

The `.env` file uses plain `KEY=value` lines; do not add `export`. A startup log
containing `[::]:8080` means `RPS_UNIX_SOCKET` did not reach the process. Check
that the unit contains the `EnvironmentFile=` line, then run `daemon-reload`
and restart the unit.

The service runs as `www-data:www-data`. Because `ProtectSystem=strict` is
enabled, the unit's `ReadWritePaths` includes the production parent containing
both the database directory and requested socket. The underlying directory
permissions must also permit `www-data` to create the socket. Grant that
specific account access without changing the directory's existing owner or
group, then start the service and confirm the socket owner and mode:

```sh
sudo setfacl -m u:www-data:rwx /var/www/production/henhen1227
sudo systemctl restart rps-strategy.service
sudo journalctl -u rps-strategy.service -n 50 --no-pager
stat -c '%A %U:%G %n' \
  /var/www/production/henhen1227/rps-henhen1227-backend.sock
curl --unix-socket /var/www/production/henhen1227/rps-henhen1227-backend.sock \
  http://localhost/healthz
```

The expected socket is `srw-rw---- www-data:www-data`. The server removes its own
socket on a graceful stop. After a crash, it probes and removes only a stale
socket; it refuses to unlink a live socket or a regular file. systemd restarts
the process after three seconds and also starts it after a reboot.

### 3. Configure Nginx

If this hostname does not already have a site file, install the included one:

```sh
sudo cp /tmp/nginx-api-rps.conf \
  /etc/nginx/sites-available/api-rps.henhen1227.com
sudo ln -s /etc/nginx/sites-available/api-rps.henhen1227.com \
  /etc/nginx/sites-enabled/api-rps.henhen1227.com
sudo nginx -t
sudo systemctl reload nginx
```

If Certbot or an existing TLS site already manages this hostname, retain its
TLS and certificate directives and merge the `upstream` and `location` blocks
from `nginx-api-rps.conf` instead of replacing the site file. Then verify
the public route:

```sh
curl https://api-rps.henhen1227.com/healthz
```

Completed games and accounts are stored at `RPS_DATABASE_PATH` (default
`data/rps-strategy.sqlite`). Every account rates each game mode separately in
`account_mode_ratings`; a mode's row is created the first time that account
finishes a game in it and copies the account's shared `elo` as its starting
point. Accounts begin at 1200 Elo, ranked results between people use a K-factor
of 32, and the shared value stays put as the seed for modes not played yet. Game
insertion, lifetime win/loss/draw changes, and both mode-rating updates share one
idempotent SQLite transaction.

Bots are rated by a different system, in `internal/persistence/bot_rating.go`. A per-game
transfer is wrong for engines because their author chooses their opponents, so beating a
fresh account pays points that a throwaway can mint on demand. Instead the bot ladder is
derived: the head-to-head record of every pair of bots is read back out of `game_history`,
fitted with Bradley–Terry, and written over the mode's bot rows. Four things do the work.

A pair counts for at most twenty games however long it is played, so grinding one opponent
stops paying. A bot needs at least two distinct opponents to be ranked, applied by pruning
until nothing is left below the bar, so a pile of throwaways collapses and takes whoever
farmed it down too. Only the largest connected group of bots is published, so a private
league of one author's engines is rated against nobody. And there is no prior anywhere —
nothing assumes an unrated bot is probably average, because that assumption is precisely
what a farm mints. An unknown opponent's strength is a free parameter, so beating it moves
that parameter rather than the rating of the bot doing the beating.

What is published is the fit shrunk towards DefaultElo by how much of the board's spread
the record establishes, estimated from the ladder itself. A well-played board keeps almost
all of its spread; one whose games cannot tell its engines apart collapses towards 1200
rather than ranking anybody by accident. Because the whole thing is derived, deleting a bot
game is exact rather than approximate, and `Open` refits every ladder at startup instead of
migrating one.

Read APIs:

```text
GET /api/accounts/{userId}
GET /api/accounts/{userId}/games?limit=20&offset=0
GET /api/accounts/{userId}/record/{opponentId}
```

Registering claims a name for the anonymous account the browser is already
using, keeping its user ID, ratings, and history:

```text
POST /api/auth/register    Authorization: Bearer <local-profile-key>
                           {"userId":"…","username":"Player","password":"…"}
POST /api/auth/login       {"username":"Player","password":"…"}
POST /api/auth/logout      Authorization: Bearer <session-token>
GET  /api/auth/me          Authorization: Bearer <session-token>
POST /api/auth/password    Authorization: Bearer <session-token>
GET  /api/identity/policy
```

Register and login return the account and a 90-day session token. Registering a
reserved username needs the host token in a `reservationToken` field, because
the `Authorization` header on that route is already carrying the profile key.

Editing a profile then takes the session, not the local key:

```text
PATCH /api/accounts/{userId}
Authorization: Bearer <session-token>

{"username":"Player","discord":"discord.username"}
```

Only a registered account has a profile to edit: an unregistered one is called
"Guest" until it claims a name, and the route answers 401 for a local key and
403 for another account's session. A rename obeys the same username rule as
registration and moves the uniqueness key with it, so the old name is released.
Discord is optional. The saved username and Discord handle are copied into every
newly created online game and returned in both player profiles.

The browser creates a random local profile key and sends it with the account ID
in the WebSocket's first `authenticate` message; a signed-in client sends its
`sessionToken` there instead, so the account follows the player to a second
browser rather than leaving them playing as a stranger. The database stores only
the key's SHA-256 hash. Existing accounts with no key are claimed by the first
local key they authenticate with.

A player's own review of a game they played is stored alongside it:

```text
GET /api/games/{gameId}/accuracy
PUT /api/games/{gameId}/accuracy
Authorization: Bearer <local-profile-key>

{"color":"Red","accuracy":87.5,"averageLossPercent":4.2,
 "averageLossCentipawns":31,"moveCount":12,
 "grades":{"best":5,"excellent":3,"good":2,"inaccuracy":1,"mistake":1,"blunder":0},
 "engine":{"preset":"standard","maxDepth":9,"maxNodes":700000,
           "maxTimeMs":2000,"variations":3}}
```

The colour's identity is read out of the archived game rather than taken from
the request, and the key must be that account's, so a client can only report
its own side of a game it actually played. Accounts that have never claimed a
key authorize nothing here — claiming happens when connecting, never as a side
effect of saving a review. Rows live in
`game_accuracy`, keyed by game and colour, and are attached to
`?format=json` game responses; the PGN column stays a complete game on its own.
Reviewing again replaces the stored number, and the engine budget is stored
with it so a shallow review is never mistaken for a deep one. Nothing that
decides a rating reads this table.

Claiming the reserved owner handle also grants the admin flag. Every route that
can claim it — registration and rename, the two that write `username_lower` —
already refuses without the host token or an existing administrator, so holding
the name is the check, and requiring the host to then grant themselves
privileges through a second door was a step that could be forgotten. The grant only ever adds: renaming away from the handle leaves the
flag alone, since a profile edit should not be a silent self-demotion.
`persistence.OwnerUsername` is the name, a startup migration promotes an account
that already holds it, and `SetAccountAdmin` remains the way to revoke.

Account, bot, and game administration:

```text
GET    /api/admin/accounts?query=&limit=&offset=
GET    /api/admin/accounts/{userId}          account, its bots, its recent games
PATCH  /api/admin/accounts/{userId}          {"disabled":true,"isAdmin":false}
DELETE /api/admin/accounts/{userId}          anonymize: keeps the games
DELETE /api/admin/accounts/{userId}/purge    delete: removes the rows
DELETE /api/admin/bots/{botId}               delete a bot, its games, its account
GET    /api/admin/games?query=&limit=&offset=
DELETE /api/admin/games/{gameId}?revertRatings=true
```

Two ways to remove somebody, and the difference is deliberate. *Anonymizing*
strips the identity and keeps the games, including rewriting the name inside the
stored PGN text; it is what [`PRIVACY.md`](../PRIVACY.md) promises and the right
answer for a privacy request, because a game is a shared object and one player
cannot decide the other's history. *Purging* deletes the rows — the account, its
bots, its games, its reviews, and its tournament entries — and is for the
account that should never have existed, where a placeholder name in every
opponent's history preserves nothing anyone wanted. Both refuse to remove the
last administrator.

Deleting a game removes it from `game_history`, `game_pgn`, and `game_accuracy`,
and leaves the tournament match or series game that referenced it in place with
the link cleared. Unless `revertRatings=false`, both players get the Elo and the
win counts that game moved handed back — exact for the last game somebody
played, and an approximation for an older one, since the games since were rated
against a number that has now changed. Between two bots it is exact whatever has
happened since: there is no transfer to unwind, so the game goes and the ladder
is fitted again from what remains. A purge always reverts, so an opponent is
never left holding rating from a game that no longer exists.

Retiring a bot (`DELETE /api/bots/{botId}`, which an owner may call for their
own) is the soft version: the bot leaves play and frees its name while its games
stay. `DELETE /api/admin/bots/{botId}` is the hard one, for a bot whose record
is itself the problem.

### The weekend bot arena

A tournament a weekend, built from whatever engines are online, with its own
page and its own settings. It is an ordinary tournament underneath — same
pairing, boards, standings and archive — plus the two things a *recurring* event
needs that a one-off does not: a schedule that survives a restart, and a way for
the people watching to decide what it plays.

```text
GET    /api/weekend              the whole page in one read
POST   /api/weekend/votes        cast or change a clock vote (session)
PUT    /api/weekend/availability which slots you can play (session)
GET    /api/admin/weekend        the host's settings
PUT    /api/admin/weekend        save them
POST   /api/admin/weekend/open   open this weekend's doors now, for testing
```

This ran every night for a year, on the theory that engines do not get tired.
They do not, but they also do not change much between a Tuesday and a Wednesday,
and a table that reads the same three nights running is a table nobody opens. A
week is long enough that authors ship something between one event and the next.

An event is two moments. At **doors** (default 30 minutes before) the event is
created and published, so the page has a countdown, a ballot and a field to
watch fill up. At the **start** the clock is locked in from the ballot, every
eligible engine online is enrolled through the host door, and the event either
begins or is called off for want of a field — with the reason on the
announcement banner rather than in a log.

The format follows the field: a round robin up to `roundRobinMax` engines, and
a Swiss above it. That is the answer to a big turnout — the right tool for the
size, not a round robin with rounds cut off it.

Two things the community decides, deliberately different in kind.

**The clock** is a ballot with a deadline: it opens when the previous event
ends, closes `pollClosesMinutes` before the start, and a thin turnout or a tie
falls back to the host's default, because neither is the field choosing
something. The floor is published to the client (`minimumVotes` on the poll) so
the page can say *why* a vote is not carrying — a fallback nobody explains reads
as the site ignoring you.

The default game is **Intransitive**. It is corrected onto rows seeded during
the single day this defaulted to Total War, once, behind the
`mode_default_corrected` flag: re-running that on every boot would undo a host
who deliberately picks something else.

**The slot** is not a ballot at all — it is approval voting over a 36-hour
window (`PUT /api/weekend/availability`, the whole set each time). The field is
worldwide, and asking each person for their one favourite slot splits thirty-six
ways and picks whichever continent happened to answer; asking which slots they
*can make* is a question everybody can answer and has a fullest one. Whatever
leads when an event begins becomes the next weekend's slot, so the schedule
moves at most once a week and always a week ahead. A tie or a turnout below
`minimumVotes` holds it where it is. The host's minutes survive a move: a 20:30
schedule whose grid picks slot 8 becomes 17:30, because the half past was never
what the grid was asked about.

A **slot** rather than an hour, and that is what weekly scheduling forced. An
hour of the day was enough for a nightly: the event came round again tomorrow,
so "20:00" meant the next 20:00 and everybody's evening was the same evening.
Weekly on a weekend breaks it — Saturday 21:00 in New York is already Sunday in
Berlin, so a grid of twenty-four bare hours would have half the world voting for
a day it did not mean. The ballot is instead `WeekendSlots` consecutive hours
laid end to end from `windowOpensDay`/`windowOpensHour`, each a fixed
weekday-and-hour in the host's zone.

Thirty-six of them, and the number is a compromise rather than a law. No
thirty-six hours are fair to everybody: wherever the window sits, some zone
loses one of its two evenings, which is why its opening is a host setting rather
than a constant. The default — Saturday 09:00 through Sunday 20:00 in the host's
zone — holds both of the evenings the schedule would ever be set to by hand, and
reaches far enough east that Europe gets both of its own.

Slots are stored as offsets into the host's window, and **clients never see them
in those terms**. Every slot is handed out with `atUnixMs`, the instant it next
falls on, so a page formats one timestamp — weekday and hour together — in its
reader's own locale and is correct by construction, rather than thirty-six
clients each getting both daylight saving and the date line right on their own.
The page groups the grid under the reader's *own* day names: the same slot is
Saturday evening for one reader and Sunday morning for another, and both
headings are true. A start time no slot can name is dragged to the nearer end of
the window on both read and save, because the grid is the only thing that can
move the schedule.

The schedule is a wall clock plus an IANA zone, not a UTC instant: "eight
o'clock" has to mean eight in November as well as in July. `cmd/server` imports
`time/tzdata` so the zone resolves from the binary rather than from the host's
`/usr/share/zoneinfo`, which a slim image does not have. The scheduler rides the
existing lobby ticker, does real work at most once a minute, and is idempotent
on a stored local date so a restart at one minute past eight cannot open a
second event. It declines to open or start while a deploy is draining, and it
waits for the hour the *event* published rather than the one in the settings —
the two differ whenever a host opens one by hand, and the page counts down
to the published one.

An engine that goes missing mid-event starts a grace clock (`graceSeconds`) from
when it went away; when that runs out its unplayed games are forfeited, and an
engine that has already burned grace gets none on its next match. Other matches
run on — only the round boundary waits.

Weekend events carry `kind = "nightly"` and a `nightlyNumber`. Both spellings
are the stored vocabulary of a year of nightly events, and renaming them would
rewrite an archive that `titles.go` and the rolling crown read; everything the
code calls itself, and everything a reader sees, says "weekend". They ride the
same broadcast as every other tournament, which is what gives the weekend page
live boards for free, and the frontend filters them off the tournaments board
and the home screen. They are excluded from the Tournament Champion title, which
would otherwise be awarded 52 times a year; the weekend arena has a rolling crown
instead, held by whoever has won the most weekends in the last ninety days.

Tournament APIs:

```text
GET    /api/tournaments
GET    /api/tournaments/{tournamentId}
POST   /api/tournaments/{tournamentId}/signups
DELETE /api/tournaments/{tournamentId}/signups

GET   /api/admin/session
POST  /api/admin/tournaments
POST  /api/admin/tournaments/{tournamentId}/start
PATCH /api/admin/tournaments/{tournamentId}/matches/{matchId}
```

The `/api/admin/*` routes require `Authorization: Bearer <RPS_ADMIN_TOKEN>`.
Creating a tournament opens registration for one playable game mode. Starting
it closes registration and creates a round-robin schedule in signup order;
reporting each match as a player-one win, player-two win, or draw updates the
public standings. Wins are worth three points and draws one. A signup includes
the local account ID, IGN, Discord username, and explicit unfiltered-chat
agreement.

An entrant may enter **themselves or exactly one of their bots**, never both.
`POST .../signups` with a `botId` and a session token enters that engine
instead: ownership is checked, the bot's own account and name go into the field,
and the Discord handle stored beside it is the *owner's*, because a host chasing
a missing engine has to reach a person. The route refuses an engine that has
never connected, is disabled, is set `enterTournaments = false`, or whose last
handshake did not report the event's mode; it also refuses a bot account named
directly in `userId`, so the only way an engine enters is through its owner.
There is no bulk enrolment — the host button that swept every online bot into
the field is gone.

The one-entry rule is enforced in persistence, over the *party* an entry belongs
to: a bot's owner, or the account itself. `DELETE .../signups` is the entrant's
own withdrawal, session-authenticated, and removes whichever of the two the
caller is answerable for — which is how an owner swaps engines. Registration
stage only, like the host's `DELETE .../players/{playerId}`: once the pairings
exist they are built around the names in them.

Starting an event puts every engine in it **into reserve** — connected and idle
but unavailable for challenges or series until the event finishes, so its
scheduled matches are not lost to passers-by. Registration is not a reservation:
before the start an entered engine plays anything it likes. See
`internal/server/bot_reserve.go`.

Every entrant in every event must have verified their account with Discord;
there is no per-event switch. A signup from an unverified account is refused
with 403, and the stored handle is the one Discord vouched for rather than the
one typed into the form — so the handles a host contacts the field on are known
to resolve.

The question is asked of the **party**, not of the account playing, which is
what lets it apply to engines. A program has no Discord account and never will,
so what is checked for a bot is its owner: the same person the one-place rule is
about and the same person a host has to reach when the engine stops turning up.
That is also how a bot entry ends up carrying its author's handle instead of a
synthetic `bot.name` that reaches nobody. The `require_discord` column is
retained on existing rows and no longer read.

Tournament games are **rated**, like any other competitive game on the site. A
pairing where either side may not play for a rating — an unregistered account,
or one under a ranked-play sanction — is downgraded to casual for that game
rather than refused, the same move `challenge.go` makes, so a mixed field can
produce some rated games and some casual ones and the PGN says which. This
matters most for engines: the bot ladder is fitted from ranked bot-versus-bot
games, so a casual tournament was invisible to the ladder its games were best
placed to inform.

A pairing can be more than one game. `gamesPerMatch` (1 by default, 10 at most)
makes each scheduled match a short series: the games are recorded in
`tournament_match_games`, the match resolves on the aggregate once all of them
are played, and **the colours swap every game**. That last part is the reason
the setting exists — one side always moves first, so an even number of games is
what stops a close pairing being decided by which entrant drew the opening seat.
It also halves the single-game noise, which is what makes a bot event's table
worth reading. The aggregate is played out in full rather than stopped once a
side cannot be caught, because cutting a 4-game match at 3–0 would leave an odd
number of games played and hand one side that extra opening turn back.

Scheduled matches are played in the app, so the host normally never reports a
result. Each player readies up for one of their pending matches over the
WebSocket, and the server starts an ordinary game session as soon as both are
present:

```json
{"type":"tournament_ready","tournamentId":"...","matchId":12}
{"type":"tournament_withdraw","tournamentId":"...","matchId":12}
```

Readying up frees the player from spectating or matchmaking first, and a player
holds at most one readiness at a time. The match's first player takes Red. When
the game finishes for any reason — including resignation, timeout, and
abandonment — the server writes the result back to the schedule and stores the
game ID on the match. `PATCH /api/admin/.../matches/{matchId}` remains available
as a host override.

Every tournament change is broadcast to all connections as a `tournaments`
message, and `connection_ready.tournaments` carries the same payload on connect.
Each entry is the REST tournament plus a `matchStates` array holding the
server-memory state of a match: `readyUserIds`, and `live` with `gameId` while a
game is running. That is what lets the lobby show a match as watchable and tell
a player their opponent is waiting.

Ranked matchmaking compares the rating each player holds in the mode being
queued and starts within ±100 Elo. Its range grows quadratically with wait
time, gives an older search access to the closest eligible opponent, and
becomes unrestricted by Elo after two minutes. Mode and time-control selections
must still match exactly.

See [`docs/game-modes.md`](docs/game-modes.md) for the game mode extension
contract.

Opening-book analysis can be imported directly from RPSFish, browsed publicly,
and named without tying human taxonomy to an engine refresh. See
[`docs/opening-book.md`](docs/opening-book.md) for the export command, API, and
naming rules.
