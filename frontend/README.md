# RPS Strategy frontend

The production web build connects to `wss://api-rps.henhen1227.com/ws` and is
published to the repository's `dist` branch.

Each game-mode card also opens a local self-analysis board. RPSFish runs as
WebAssembly in a dedicated browser worker, ranks the top three moves, draws
their arrows, maintains a Red/Blue evaluation bar, and grades every move the
player makes while controlling both sides. Analysis does not require a server
connection. The analysis screen updates after every completed search depth and
offers a **Go Deep** mode that continuously ranks three principal variations.
The deep preset is bounded to one worker thread, depth 127, 100 million nodes,
and 30 seconds; the client API also accepts custom `maxDepth`, `maxNodes`,
`maxTimeMs`, `variations`, and inter-iteration `throttleMs` values.

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
