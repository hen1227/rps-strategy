# Backend

Go HTTP/WebSocket service for RPS Strategy.

## Layout

```text
backend/
├── cmd/server/          # Executable entry point and process lifecycle
├── deploy/              # systemd, Nginx, and production environment templates
├── docs/                # Backend-specific development documentation
├── internal/game/       # Game state, rules, modes, clocks, and tests
├── internal/persistence/ # SQLite schema, account stats, history, and Elo transactions
├── internal/server/     # HTTP, WebSocket protocol, sessions, and matchmaking
├── go.mod
└── go.sum
```

Code under `internal/` cannot be imported by projects outside this Go module.
The game package is transport-independent; the server package owns all HTTP and
WebSocket concerns and depends on the game package.

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

Merge the three values in `/tmp/rps-strategy.env.example` into the existing
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
`data/rps-strategy.sqlite`). Accounts begin at 1200 Elo; ranked results use a
K-factor of 32. Game insertion, aggregate win/loss/draw changes, and both Elo
updates share one idempotent SQLite transaction.

Read APIs:

```text
GET /api/accounts/{userId}
GET /api/accounts/{userId}/games?limit=20&offset=0
GET /api/accounts/{userId}/record/{opponentId}
```

Ranked matchmaking starts within ±100 Elo. Its range grows quadratically with
wait time, gives an older search access to the closest eligible opponent, and
becomes unrestricted by Elo after two minutes. Mode and time-control selections
must still match exactly.

See [`docs/game-modes.md`](docs/game-modes.md) for the game mode extension
contract.
