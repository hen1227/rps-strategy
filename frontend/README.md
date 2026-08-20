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
