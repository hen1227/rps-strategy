# Connect your bot

Write an engine that reads and writes lines, then connect it with `rpsbot.py`.
The client handles the network and account; your engine chooses moves.

Download the client from **Bots → Your bots**. See [RPSI](rpsi.md) for the full
protocol and [Records and notation](notation.md) for PGN and FEN formats.

## Game rules

Rock–Paper–Scissors Strategy uses a 9×9 board. Rock captures scissors, scissors
captures paper, and paper captures rock. In **V3 Infiltration**, reach the enemy
home row. In **V5 Total War**, capture every enemy piece or hold more territory
when the board fills. In **V6 Intransitive**, reach the enemy starting corner.
Declare only the modes your engine supports. Games can be watched live and
replayed from their saved PGN.

## Engine basics

Read commands from stdin and flush each reply to stdout.

| You receive | You reply |
| --- | --- |
| `rpsi` | Identity and supported modes, then `rpsiok`. |
| `isready` | `readyok` |
| `position fen … moves …` | No reply. Save the position and history. |
| `legalmoves d3-d4 e3-e4 …` | No reply. Save the legal moves. |
| `go rtime 300000 btime 298400 rinc 3000 binc 3000` | `bestmove d3-d4` |
| `quit` | Exit. |

Ignore unknown commands. Do not exit when you receive one.

### Reading a `go` line

```text
go rtime 300000 btime 298400 rinc 3000 binc 3000
```

Times are milliseconds. `rtime` and `btime` are Red's and Blue's remaining time;
`rinc` and `binc` are their per-move increments. Your side is the side to move
in `position`.

Choose your own search budget. A starting estimate is one twentieth of remaining
time plus most of the increment. **Return before your clock reaches zero**, with
a margin for the network. Optional limits include `movetime`, `depth`, `nodes`,
`searchmoves`, and `infinite`. There is no `movestogo`.

### A complete, legal bot

```python
#!/usr/bin/env python3
import random, sys

moves = []
for line in sys.stdin:
    word = line.split()
    if not word:
        continue
    if word[0] == "rpsi":
        print("id name Dice\nid author me\nprotocol 1\nmode V3\nmode V5\nrpsiok", flush=True)
    elif word[0] == "isready":
        print("readyok", flush=True)
    elif word[0] == "legalmoves":
        moves = word[1:]
    elif word[0] == "go":
        print("bestmove " + random.choice(moves), flush=True)
    elif word[0] == "quit":
        break
```

This bot picks random legal moves. Download it as `example_engine.py` from
**Your bots**. Keep `flush=True`; buffered replies can make an engine time out.
The server sends `legalmoves` before every search, so a simple bot needs no move
generator. More advanced engines can generate their own moves.

### Squares, moves, positions

Files run `a`–`i`, ranks `1`–`9`, with `a1` at Blue's home corner. Moves look like
`d3-d4` or `d3xd4`. Accept either separator; the board determines captures.
Positions contain pieces, side to move (`r`/`b`), and territory. Only Total War
uses territory.

### Four things that catch people out

1. **Scores use the side to move's perspective.** Positive `score cp N` favours that side.
2. **Use the supplied FEN.** There is no `startpos`; games can start from custom positions.
3. **Count captures from the move list.** All modes draw after 200 plies without a capture (100 moves per side). FEN has no counter. Repetition is not a draw.
4. **No legal moves means a loss in Intransitive**, but a draw in Infiltration and Total War.

## Quick start

1. Sign in with Discord. Your existing games and rating stay with you.
2. Add a bot under **Bots → Your bots**. Save its `rps_b_…` token, which is shown once. Reusing it keeps the same bot and history.
3. Download `rpsbot.py` and compare its digest with the one shown on the page:

```bash
shasum -a 256 rpsbot.py
```

4. Install the dependency and run your engine through the client:

```bash
pip install websockets
python3 rpsbot.py -- python3 example_engine.py
```

On first run, enter a name, optional icon, game settings, and bot token. Answers
are saved to `rpsbot.conf`; later runs connect directly. The engine command after
`--` is not saved. Start with one game at a time until you know your machine can
handle more.

### Options

```text
--reconfigure     ask the setup questions again
--name NAME       override the bot name for this run
--icon PATH       override the icon for this run
--max-games N     set concurrent games (1-5)
--server URL      use another server (saved on first run)
--config PATH     use another config file
```

Give each bot its own directory and config file.

### Versions

The client checks its version on connect. It offers an update link when needed
and stops if it is too old to play. **Your bots** and `GET /api/bot/version` list
the current version, digest, minimum supported version, and download links.
Updating the client keeps your bot's identity, rating, and history.

### Rules changes

The client prints each mode's rules date and saves it in `rpsbot.conf`. If that
date changes, it warns you on connect. Check the updated rules before playing;
an engine using old rules may still connect and make legal but poor moves.

### Which build is running

The bot's profile lists engine builds and when each first appeared. Report a
build in the handshake:

```text
id name MyBot
id author Me
id version 2.3.1
```

Use a version, commit, or date. Alternatively, set `version = 2.3.1` in
`rpsbot.conf`. The config value is used only if the engine sends no `id version`.
Update it when you rebuild. Build information is optional. Keep the build out
of `id name` if you want it listed separately.

## Client internals

The client forwards commands and replies, reconnects after network failures,
restarts failed engine processes, and drains stderr. It does not implement game rules.

| Check | What to look for |
| --- | --- |
| `grep -n subprocess rpsbot.py` | Engine processes use the command after `--`, once per slot. |
| `grep -n 'wss\?://' rpsbot.py` | The configured server address. |
| `grep -n 'open(' rpsbot.py` | Config access and icon reads; config permissions are `0600`. |
| `grep -nE 'eval\|exec\|pickle\|os.system\|shell=True' rpsbot.py` | No matches. |

## Connection problems

| Message or symptom | What to do |
| --- | --- |
| `<server> does not support bots` | Check the server address and version. Use `wss://` publicly or `ws://` locally, with a path ending in `/ws`. |
| `that bot token is not recognised` | Check the token and server. Tokens belong to one server. |
| `that bot name is already taken` | Choose another name in `rpsbot.conf`. Bots and players share names. |
| `this copy of rpsbot.py is too old` | Download the version linked in the message. |
| `Waiting for a game.` | Connected successfully. Leave the client running for a challenge, series, or scheduled game. |

## Settings

```ini
[bot]
public_play = yes
ladder = yes
tournaments = yes
max_games = 1
version =
```

Edit these values in your existing config. `ladder` enters hourly ranked rounds;
`tournaments` enters supported events automatically. `version` is optional.

With `public_play = no`, only you can challenge your bot or put it in a series.
The website can change switches while the client runs. **Reconnecting restores
the config values**, so update the file for lasting changes.

### Playing more than one game at once

`max_games` creates up to five slots, each with its own connection and engine
process. Your engine still handles one game at a time. Allow enough memory and
CPU for every process; overloaded engines can lose on time.

All slots share one bot name, rating, leaderboard row, and tournament entry.
Players can challenge it while a slot is free. Shutdown and pause apply to all slots.

### Giving your bot a face

Set `icon` to a square PNG, at most **128×128 pixels and 64 KiB**:

```ini
icon = mybot.png
```

The path is relative to the client’s working directory. Replace the file and
reconnect to update it. A blank or missing `icon` setting
removes the current icon. An unreadable or invalid file leaves the old icon in
place and prints an error. The bot can still play.

## Stopping safely

A graceful shutdown stops new games, finishes commitments, then exits.

| Where | How |
| --- | --- |
| Website | **Your bots → FINISH AND STOP**, or **PAUSE** to stay connected. |
| Client machine | Ctrl-C or `SIGTERM`. |
| Engine | Print `shutdown` to stdout. |

**A second Ctrl-C stops immediately and abandons active games.** The client
isolates engines from the first signal. For a systemd service, use
`KillMode=mixed` so the client can let engines finish.

| Commitment | What happens |
| --- | --- |
| Active games | Finish each game. |
| Series | Finish the current pair, then stop the series. |
| Started tournament | Play every remaining match. |
| Tournament not started | Withdraw. |

**PAUSE** finishes the same commitments but stays connected. **RESUME** cancels
the pause or pending shutdown. Restarting the client clears it too. A network
reconnection preserves it, so a brief outage does not re-enter a paused bot.

## Reconnecting

The client reconnects automatically, starting with a one-second backoff.
**The server holds an active seat for 15 seconds.** The first slot to reconnect
and finish its handshake resumes the game.

Your clock keeps running while disconnected. If it reaches zero first, you lose
on time. Missing the reconnection window is recorded as abandonment.

| Series state | What happens |
| --- | --- |
| Reconnect within the window during a game | Resume that game. |
| Reconnect within the window between games | Continue with the next game, including the swapped half of a pair. |
| Miss the window | Stop the series; completed games still count. |
| A spare slot disconnects | The series continues on its active slot. |

## Move timing

Moves are spaced at least 0.2 seconds apart. Faster replies wait on the server;
slower replies play immediately. **This wait uses neither clock** and does not
trigger another search. Your engine is charged only for its thinking time.

## Engine errors

| Problem | Result |
| --- | --- |
| Illegal `bestmove` | One retry, then the game ends. |
| No reply before the deadline | The game ends. |
| Engine process crashes | The client restarts that slot; the game ends. |
| Clock runs out | Loss on time. |
| Network disconnects | Seat held for up to 15 seconds. |

Faults are recorded as abandonment. The cause is sent to you and shown on the
bot's page. Return a legal move promptly if there is no time to search.

## Ratings and events

Your bot has its own rating and game history. You can register **five bots per
account**. If you lose a token, rotate it under **Your bots** to keep the bot's
identity and history.

### What a rating means

Every 20 rating points doubles the estimated odds of winning: a 20-point lead
means 2:1 odds; 40 points means 4:1.

When reference engines are active, they anchor the scale:

| Rating | Reference engine |
| --- | --- |
| 1 | Random legal moves: `GET /api/bot/yardstick_random.py` |
| 100 | Capture when possible, otherwise random: `GET /api/bot/yardstick_greedy.py` |
| 400 | RPSFish at 5 plies, without clock or opening book. |
| 600 | RPSFish at 8 plies, without clock or opening book. |

The Python references and their digests are public. Without designated reference
engines, ratings are relative to the field: 1 is the weakest ranked engine.
The leaderboard explains which scale is in use. Changing reference ratings
recalculates the scale.

### Where a rating comes from

**Rated bot games use server-selected opponents and settings.** Hourly rounds
start on the hour and play two Intransitive games per pair, with colours swapped.
Set `ladder = yes` to enter. **PLAY NOW** requests an extra ranked pair; the server
still chooses the opponent and settings.

Keep the client online at the hour. Missed server rounds are skipped. Busy
engines are paired and wait for a free slot; a pairing still waiting at the next
hour expires. Hourly rounds schedule at most two games per engine per hour.

The pool prefers useful matchups: similar strength, unfamiliar opponents, and
uncertain ratings. With reference engines active, new bots play one first.

Challenges and manually arranged series do not affect bot ratings. Bot games
against people are also casual, except for human ratings against reference engines.
Infiltration and Total War keep their historical ratings but get no new hourly rounds.

### Why it is not a running total

Bot ratings are fitted from the head-to-head record, with limits on repeated
matchups and shared ownership:

- After about twenty games against the same engine, the result ratio matters more than the count.
- Engines need enough independent opponents to establish a rating. Reference engines anchor otherwise uncertain comparisons.
- An unplayed engine has unknown strength; beating it does not assume it was average.
- Engines with the same owner do not rate each other.

Insufficient evidence shows as **Not enough data to rank**; thin ratings are
**Provisional**. Results lose half their weight every three months, so inactive
ratings become less certain.

### Series and tournaments

A **series** plays pairs from shared opening positions, with colours swapped.
Seeded opening moves are excluded from accuracy scores. Games are watchable,
archived, and **casual**. Website series allow up to **3 pairs**, **10 minutes per
side**, and **one active series per person**. Both bots must allow public play or
belong to the person starting it. Stopping a series lets its current pair finish.

For **engine tournaments**, set `tournaments = yes` and stay online. Every eligible
engine enters when the event starts; you can enter multiple bots. Turn the switch
off to keep a bot out of future events. Your Discord account must be verified.
Draining, unsupported, or barred engines are skipped; the event page shows why.

The server starts tournament matches automatically. Multiple games per match
swap colours and use the aggregate result. During an event, engines are reserved
for its matches and cannot accept challenges or series until it ends. Host-created
tournaments are casual.

The **weekend arena** builds its field from eligible online engines. It is called
off if too few are available. Use the weekend page to vote on the clock and mark
available times in your timezone. The leading time slot sets the following
weekend's schedule; ties keep the current slot. Weekend results and titles appear
on that page.
