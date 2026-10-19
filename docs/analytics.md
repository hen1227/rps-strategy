# Google Analytics

What the site and apps send to Google Analytics 4 (GA4), how it gets there, and
the one-time setup a deployment needs. Nothing is sent until the IDs below are
set. A fresh checkout, a fork, or a development server sends nothing and shows
no consent prompt.

## How it gets there

| Source | Path | Code |
| --- | --- | --- |
| Website | gtag.js, loaded only once consent is in hand | `frontend/src/analytics/transport.web.ts` |
| iOS and Android apps | batched to `POST /api/analytics`, then forwarded by the server over the Measurement Protocol | `frontend/src/analytics/relay.ts`, `backend/internal/server/google_analytics.go` |
| Server | Measurement Protocol, under one fixed client ID | `backend/internal/server/google_analytics.go` |

The apps go through the server for two reasons. The Measurement Protocol needs
an API secret, which can't ship inside a public app. Relaying also means Google
never sees a phone's IP address.

## Consent

Consent is decided per device (`frontend/src/analytics/consent.ts`).

- **EU, EEA, UK, Switzerland:** nothing is sent until the player answers a
  one-time card at the bottom of the screen.
  - "Where" is judged from the time zone. A zone that names no place, such as
    UTC, is treated as Europe.
- **Everywhere else:** on by default.
  - A browser sending Global Privacy Control starts with it off.
- **Changing it:** Your account → Usage stats.
  - Turning it off on the web deletes the `_ga` cookies.
  - Turning it off in the apps deletes the analytics ID.

## Setup

1. **Create the property.** Create a GA4 property in analytics.google.com, then
   add one **Web** data stream for `https://rps.henhen1227.com`.
   - The apps report into this same stream, with a `platform` user property
     set to `ios` or `android`.
   - Don't add iOS or Android streams. Those are Firebase streams, and nothing
     here uses Firebase.
2. **Set the measurement ID in the website build.** Put the stream's `G-…` ID
   in `frontend/.env.production` as `EXPO_PUBLIC_GA_MEASUREMENT_ID=G-…`.
   - The ID is public and safe to commit; every page that loads the tag prints
     it.
   - Rebuild with `--clear`. Metro caches inlined env values, and a warm cache
     ships the old answer.
   - The same file feeds EAS, so the next app build picks it up too.
3. **Configure the server.** On the stream, create a key under **Measurement
   Protocol API secrets**. Then set both variables in the server's `.env`:
   `RPS_GA_MEASUREMENT_ID` (the same `G-…`) and `RPS_GA_API_SECRET`.
   - Never put the secret in the frontend or commit it.
   - Half-configured is logged at boot and stays off.
4. **Stream settings.** Under Enhanced measurement, turn off **Page changes
   based on browser history events**.
   - The app sends its own page views, with names and game IDs stripped from
     the address.
   - The automatic ones would report full URLs, which can contain usernames and
     sign-in tickets, and would double-count every page.
5. **Property settings.** These are what the privacy policy promises, so keep
   them matching it:
   - **Data retention → 14 months**, with **Reset user data on new activity
     off**. The policy promises 14 months; with the reset on, a regular
     player's data would never expire. If you change either, change the policy
     sentence in `PRIVACY.md` and `PolicyScreen.tsx`.
   - **Google signals → off.**
   - No Google Ads link.
6. **Custom definitions.** Register the dimensions below so reports can break
   down by them. Events are recorded without this step, but you can't slice by
   a parameter until it is registered.

## Events

The client events are typed in `frontend/src/analytics/events.ts`, so `track()`
refuses anything not listed there.

| Event | Sent by | Parameters |
| --- | --- | --- |
| `page_view` | web, apps | `page_location` (path plus `mode`/`tab` only), `page_title` (the path) |
| `sign_up` | web, apps | `method`: discord, apple, unknown |
| `login` | web, apps | `method`: discord, apple, password, unknown |
| `queue_join` | web, apps | `mode` |
| `challenge_post` | web, apps | `mode`, `ranked`, `time_control`, `kind` (open or direct) |
| `game_start` | web, apps | `mode`, `kind` (online, practice, local), `opponent` (human or bot), `time_control` |
| `game_end` | web, apps | `mode`, `kind`, `opponent`, `result` (win, loss, draw, or decided for pass-and-play), `end_reason`, `moves` |
| `bot_match_start` | web, apps | `mode`, `where` (device or server), `ranked` |
| `tournament_signup` | web, apps | none |
| `feedback_post` | web, apps | `kind` |
| `alerts_enable` | web, apps | `platform` |
| `share` | web, apps | `content_type` (the kind of page, e.g. review or player), `method`: copy |
| `tutorial_begin` | web, apps | `source`: first_launch (opened by itself on a new device), how_to_play, or link |
| `tutorial_complete` | web, apps | none. Every lesson answered |
| `game_finished` | server | `mode`, `ranked`, `players` (human_vs_human, human_vs_bot, bot_vs_bot), `setting` (match, tournament, arena, bot_series), `winner` (red, blue, draw), `end_reason`, `moves`, `duration_sec`, `time_control` |
| `bot_connected` | server | `bot` (public name), `engine`, `engine_version`, `client_version` |

**One rule:** what was played and pressed, never who. No username, account ID,
game ID, opponent, Discord or Apple ID, or free text. The store labels
("not linked to the user") and the policy depend on this.

**Players vs. games:** `game_end` counts games from a player's side, and only
for players who allowed stats. `game_finished` counts every game exactly once,
including bot-vs-bot, so use it for "games played". It comes from one
synthetic user, client ID `1.1`.

**Bot reconnects:** `bot_connected` fires when an engine comes online after
more than 15 seconds away (the server's reconnect grace). A dropped socket that
is back within a second isn't counted. A deploy restarts the server, so every
engine counts once per deploy.

### Custom dimensions to register

- **Event-scoped:** `mode`, `kind`, `opponent`, `result`, `end_reason`,
  `ranked`, `time_control`, `method`, `where`, `content_type`, `players`,
  `setting`, `winner`, `bot`, `engine`, `engine_version`, `client_version`,
  `source`.
- **User-scoped:** `platform`, `app_version`. The apps set these.
- **Custom metrics (event-scoped):** `moves`, `duration_sec`.

## Checking it works

- **Web.** A development build with `EXPO_PUBLIC_GA_MEASUREMENT_ID` set in
  `frontend/.env.development` sends with `debug_mode`, so its events appear in
  Admin → DebugView.
- **Apps.** Point a development build at a local server that has both
  `RPS_GA_*` variables set; its events carry `debug_mode` too.
- **Validate a request.** Google answers 2xx to any well-formed Measurement
  Protocol request, valid or not, so the server can't tell you an event was
  dropped. To check one, post the same body to
  `https://www.google-analytics.com/debug/mp/collect?measurement_id=…&api_secret=…`,
  which answers with validation messages.
