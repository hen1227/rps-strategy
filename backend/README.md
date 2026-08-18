# Backend

Go HTTP/WebSocket service for RPS Strategy.

## Layout

```text
backend/
├── cmd/server/          # Executable entry point and process lifecycle
├── docs/                # Backend-specific development documentation
├── internal/game/       # Game state, rules, modes, clocks, and tests
├── internal/persistence/ # SQLite schema, account stats, history, and Elo transactions
├── internal/server/     # HTTP, WebSocket protocol, sessions, and matchmaking
├── ecosystem.config.cjs # PM2 production configuration
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

Build the production binary expected by PM2:

```sh
mkdir -p bin
go build -o bin/rps-server ./cmd/server
```

The server listens on `PORT` (default `8080`). Set `RPS_ALLOWED_ORIGINS` to a
comma-separated list of permitted browser origins. Native WebSocket clients and
local development origins are accepted without extra configuration.

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
