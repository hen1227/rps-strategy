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
├── internal/persistence/ # SQLite schema, account stats, history, Elo, and the game archive
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
export endpoints, and the replay API.

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

### 1. Build and upload the ARM64 binary

On the development machine:

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
point. Accounts begin at 1200 Elo, ranked results use a K-factor of 32, and the
shared value stays put as the seed for modes not played yet. Game insertion,
lifetime win/loss/draw changes, and both mode-rating updates share one
idempotent SQLite transaction.

Read APIs:

```text
GET /api/accounts/{userId}
GET /api/accounts/{userId}/games?limit=20&offset=0
GET /api/accounts/{userId}/record/{opponentId}
```

Account profiles also support:

```text
PATCH /api/accounts/{userId}
Authorization: Bearer <local-profile-key>

{"displayName":"Player name","discord":"discord.username"}
```

The browser creates a random local profile key and sends it with the account ID
in the WebSocket's first `authenticate` message. The database stores only its
SHA-256 hash. Existing accounts with no key are claimed by the first local key
they authenticate with. The saved display name and Discord username are copied
into every newly created online game and returned in both player profiles.

Tournament APIs:

```text
GET  /api/tournaments
GET  /api/tournaments/{tournamentId}
POST /api/tournaments/{tournamentId}/signups

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
