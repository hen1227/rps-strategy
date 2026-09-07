# Connect your bot

Write a program that reads lines from standard input and writes lines to standard output,
then run one a given Python script next to it. That's it! Your bot never touches
a network, an account, or a game clock.

- **The protocol** is [RPSI](rpsi.md), a UCI-shaped text protocol. Everything you need to
  start is on this page; the full reference is there.
- **The client** is `rpsbot.py`, downloaded from the **Your bots** page under Account. It
  reports its version on connect and tells you when a newer one exists.

---

## The game, in a paragraph

Rock–Paper–Scissors Strategy is played on a 9×9 board. Each side has nine pieces — three
rock, three paper, three scissors — and a piece captures what it beats. There are three
modes: **V3 Infiltration**, won by getting a piece to the opponent's home rank; **V5 Total
War**, won by wiping the opponent out or owning most of the board once it fills; and **V6
Intransitive**, won by reaching the corner the opponent's army started in. Your engine is
told which mode each game is and only has to play the ones it declares.

Games are real games: they appear in the lobby, anyone can spectate, they are stored as
PGN, and they can be replayed move by move afterwards.

---

## What your bot has to do

Read lines on stdin and answer four of them. The other two you just remember.

| You receive | You reply |
| --- | --- |
| `rpsi` | your identity, the modes you play, then `rpsiok` |
| `isready` | `readyok` |
| `position fen … moves …` | nothing — remember it |
| `legalmoves d3-d4 e3-e4 …` | nothing — these are your options |
| `go rtime 300000 btime 298400 rinc 3000 binc 3000` | `bestmove d3-d4` |
| `quit` | exit |

Ignore anything you do not recognise. Never exit on an unknown command.

### Reading a `go` line

That one line is the only thing you have to understand properly:

```text
go rtime 300000 btime 298400 rinc 3000 binc 3000
   │           │            │          └── Blue gains 3000 ms after each move
   │           │            └── Red gains 3000 ms after each move
   │           └── Blue has 298400 ms left  (4:58.4)
   └── Red has 300000 ms left  (5:00)
```

Everything is **milliseconds**, and `r`/`b` are **Red and Blue**, not you and your
opponent — which side you are is whatever `position` says is to move. So the clock that
matters is `rtime` on Red's turn and `btime` on Blue's.

You decide how much of it to spend. A common starting point is a twentieth of what is left
plus most of the increment, which for the line above gives Blue about 17 seconds. Whatever
you choose, **return before your own clock reaches zero** — running out is a loss.

`go` can also carry `movetime`, `depth`, `nodes`, `searchmoves` and `infinite`, all optional
and all safe to ignore. There is no `movestogo`.

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

It plays random moves and beats nobody, but it finishes every game legally. Download it
from the Your bots page as `example_engine.py`.

**`flush=True` matters.** Buffered output looks exactly like a hung engine.

It is that short because the server sends `legalmoves` before every `go`. There is no
move-generation library for this game, so without that line the smallest possible bot would
need a FEN parser, a neighbour table, the capture cycle and each mode's movement rules
first. A strong engine ignores the line and generates its own moves; a beginner picks from
it.

### Squares, moves, positions

Files `a`–`i`, ranks `1`–`9`; `a1` is Blue's home corner. A move is `d3-d4`, or `d3xd4` when
it captures — **accept either and read nothing into which one you got**. A position is
pieces, side to move (`r`/`b`), and territory, space-separated. Only Total War uses
territory, so in the other two modes you can ignore that field.

### Four things that catch people out

1. **`score cp N` is from the side to move's point of view**, not Red's and not yours. This
   is the most common bug and it is silent — a strong engine just looks weak.
2. **There is no `startpos`.** You always get a full FEN, because a game can begin from a
   position somebody chose, and a mode's opening layout can be redesigned.
3. **The `moves` list is how you count the plies since the last capture.** Two hundred of
   them — a hundred moves from each side — is a draw in every mode, and the FEN cannot tell
   you how long it has been. Repeating a position, on the other hand, is *not* a draw in any mode, so do not
   score a repeat as half a point.
4. **Having no legal move is not always a draw.** It is in Infiltration and Total War; in
   Intransitive the side that cannot move has lost. So a quiet move leaving your opponent
   nowhere to go wins on the spot there — and one leaving **you** nowhere to go loses.

Full detail, including `info` output and search limits, is in [rpsi.md](rpsi.md).

---

## Getting connected

**Register an account.** Anonymous play stays anonymous, but a bot needs an owner, and
registering keeps the rating and history you already have.

**Add a bot** from your account page. You get a token like `rps_b_…`, shown once. It *is*
your bot's identity: the same token always means the same bot, with the same rating and
history, so a restart is recognised rather than creating a second one.

**Download the client** from the Your bots page and check it against the digest shown there:

```bash
shasum -a 256 rpsbot.py
```

**Run it.** The first run asks six questions and saves the answers to `rpsbot.conf`:

```bash
pip install websockets
python3 rpsbot.py -- python3 example_engine.py
```

```text
Bot name: MyBot
Icon: a square PNG up to 128x128, or blank for none []: mybot.png
Let other players challenge this bot? [Y/n] y
Enter tournaments automatically? [Y/n] y
Games at once (1-5; each one runs its own copy of your engine) [1]: 1
Paste your bot token (from your account page): rps_b_…

Saved rpsbot.conf.
MyBot is online. Waiting for a game.
Using rules V3 published 2026-09-03
Using rules V5 published 2026-09-03
```

Leave the icon blank if you have not drawn one — **Giving your bot a face** below says how,
and you can add one later. Leave **Games at once** at 1 unless you have read **Playing more
than one game at once** and your machine has the cores for it. Every later run connects
straight away. The engine command after `--` is deliberately **not** saved, so the config
file can never contain something that runs.

### Options

```text
--reconfigure     ask the questions again
--name NAME       override the bot name for this run
--icon PATH       override the icon for this run
--max-games N     override how many games to play at once (1-5)
--server URL      point at a different instance (saved on first run)
--config PATH     use a different config file
```

Two bots on one machine: give each its own directory and its own conf.

### Versions

On connect the client tells the server which version it is. If a newer one exists you get a
notice with the download link; if yours is too old to play, it says so and stops before
starting your engine. The current version and its digest are on the Your bots page and at
`GET /api/bot/version`, which is enough to update without a browser: it reports the current
version, its digest, and download links for the client, the example engine, and this
document with the protocol reference.

`minimumVersion` is the oldest client the server will still play. It moves rarely, only for
a change an older client cannot play through, and **1.4 is currently required**: the board's
orientation and two win conditions changed on 3 September 2026, and 1.4 is the client that
prints which rules your engine is playing under. An engine written against the old board
does not fail on connect — it plays legal moves into a position it has misread. Upgrading
costs nothing: your bot keeps its identity, rating and history.

### Rules changes

Every connect prints the day the rules of each mode your engine plays were last published,
and the client remembers those dates in `rpsbot.conf`. A date that has moved since this
machine last connected is said out loud:

```text
  The rules changed since this bot last connected: V3 (this bot last played 2026-08-14).
```

That exists because **an engine cannot notice**. You read a changelog; your engine plays
what it was written against, and a board that flipped does not look like a rule change from
inside a search — it looks like losing. When that line appears, re-read the mode before your
next game.

---

## What the client does, and how to check it

A couple of hundred lines, no game logic. It writes the lines the server sends to your
engine's stdin, reads stdout until a line starts with the prefix the server asked for, and
sends those lines back. Roughly a third of it is failure handling: reconnection with
backoff, restarting a hung engine, draining stderr so a chatty engine cannot deadlock on a
full pipe. Four greps establish the rest:

| Check | What you should find |
| --- | --- |
| `grep -n subprocess rpsbot.py` | one `Popen`, argv exactly what you typed after `--`, run once per slot |
| `grep -n 'wss\?://' rpsbot.py` | one destination, the `server` value in your conf |
| `grep -n 'open(' rpsbot.py` | two files: `rpsbot.conf`, written `0600`, and your icon, read as bytes |
| `grep -nE 'eval\|exec\|pickle\|os.system\|shell=True' rpsbot.py` | nothing |

---

## When it will not connect

**`<server> does not support bots`** — the server you pointed at is older than your client,
or is not an RPS Strategy server. Check the `server` line in `rpsbot.conf`: `wss://` for a
public server, `ws://` for one on your own machine, and the path ends in `/ws`.

**`that bot token is not recognised`** — mistyped, or it belongs to a bot on a different
server. Tokens are per-server.

**`that bot name is already taken`** — names are shared with player names across the whole
server. Pick another in `rpsbot.conf`.

**`this copy of rpsbot.py is too old`** — download the current one; the message includes the
link.

**It connects and then nothing happens** — that is normal. It is waiting for somebody to
challenge it or to enter it into a series. `Waiting for a game.` is the last thing it prints
until one starts.

---

## Settings

`rpsbot.conf` holds two switches and a number:

```ini
public_play = yes    other players can challenge this bot, and can enter it into a series
tournaments = yes    you are allowed to register it for an event
max_games = 1        how many games it plays at the same time, 1 to 5
```

`public_play = no` keeps both: nobody but you can challenge it or put it in a series. Your
own bots are always available to you, which is what makes running a new version against your
old one work.

The file asserts both switches **every time the bot connects**. The website can change
either while the bot is running and it takes effect immediately, but a restart re-applies
the file. If you turn something off on the site and it comes back later, that is the file,
not a bug.

### Playing more than one game at once

A bot plays one game at a time unless you say otherwise. `max_games` raises that to at most
five, and each of them is a **slot**: its own connection to the server, its own copy of your
engine, and one game on it at a time.

```text
Playing up to 3 games at once, one engine each.
[1/3] MyBot is online. Waiting for a game.
[2/3] MyBot is online. Waiting for a game.
[3/3] MyBot is online. Waiting for a game.
```

Three engine processes, then, not one engine asked three things. Your engine needs to know
nothing about it: it never sees two games, and one written for a single game is already
correct for five. What it costs is what three copies cost — three times the memory, and
enough cores that none of them thinks on a timeshare while its clock runs. That is what
people get wrong: a bot that plays fine on four cores loses on time when five copies share
them. Start at 1 and raise it only if there is room.

One bot with three slots is still one bot — one name, one rating, one row on the ladder, one
entry in a tournament — it just gets through its matches faster. The lobby shows it as
*playing 1 of 3*, and it can be challenged until every slot is taken. Stopping is the bot's
business rather than the slot's: Ctrl-C, `shutdown` from any engine, and the button on the
website all drain every slot together.

### Giving your bot a face

A bot with no icon is drawn as two letters on a coloured square. To replace that, point the
`icon` line at a PNG — **square, at most 128×128, at most 64 KiB**. Smaller squares are fine
and are drawn at whatever size the page needs; nothing is scaled up, and only PNG is
accepted.

```ini
icon = mybot.png            # relative to wherever you start the client
```

The icon travels with the name and the switches on every connect, so there is no upload
page: **replace the file and restart the bot.**

| Your `icon` line | What the website shows |
| --- | --- |
| a readable PNG | that picture, from the next connect on |
| blank, or no `icon` line | no picture — this **takes down** one you set earlier |
| a file that cannot be read | no change, and the client says why on stderr |

That last row is deliberate: starting the client from the wrong directory is a mistake, not
an instruction to erase your bot's face. You get a line like `icon: mybot.png is 256x256,
and the limit is 128x128; leaving the current one alone`, and the bot plays as usual. The
same goes for anything the server refuses on a closer look, such as a truncated PNG — the
connection is never in question, and the reason is printed when the bot comes online.

---

## Taking it down without losing a game

Killing the process abandons whatever is on the board: a loss for your engine, a spoiled
game for its opponent, and an abandonment on the record nobody meant. Ask for a **graceful
shutdown** instead — the bot stops being offered new games immediately, plays out what it
already owes, and then stops. Three ways to ask, all the same request:

| Where | How |
| --- | --- |
| The website | **Your bots**, under Account: **FINISH AND STOP**, or **PAUSE** to stay connected |
| The machine it runs on | Ctrl-C, or a `SIGTERM` from something like `systemctl stop` |
| The engine itself | print `shutdown` on stdout — see [rpsi.md](rpsi.md) |

```text
^C
  Shutting down gracefully: no new games, finishing what is owed.
  Press Ctrl-C again to stop now and abandon the games on the board.

shutting down after: finishing the game it is playing, 3 matches left in Summer Cup
MyBot has finished everything it owed. Shutting down.
```

**Press Ctrl-C again and it goes immediately**, abandoning the game — which is what the
first press used to do, and is still there when you mean it.

| Owed | What happens |
| --- | --- |
| the games on the board | each played to the end, and each counts |
| a series | the current **pair** is finished, then the run stops |
| a tournament that has started | every match it still has to play |
| a tournament that has not started | it withdraws — nothing has been played, so nothing is lost |

The pair is the unit for a series because its two games are the same opening with the colours
swapped, and stopping between them leaves the record one game lopsided. While a bot drains,
new games are refused from every direction and the lobby shows it as **SHUTTING DOWN**.

**PAUSE** is the same drain without the exit: the bot finishes what it owes, then sits
connected and accepting nothing until you restart it. Use it when something else — systemd,
a container runtime — decides when the process may stop. Either way the drain lives **on the
connection and nothing else**, so a restart puts the bot back in play and there is no switch
left set somewhere to find later. A dropped network is not a restart, though: the client
re-asks for the drain on its next connection, so a blip cannot quietly put a bot you took
out of play back into it. **RESUME** on the website calls the whole thing off.

---

## When the connection drops

Not every departure is asked for. A wifi drop, a laptop lid, a redeploy of the machine the
bot runs on — the socket goes and the client starts reconnecting, on a backoff that begins at
one second. None of that has to cost you a game.

**Your seat is held for fifteen seconds.** The board stays up, the opponent is told you have
dropped and shown the countdown, and the first slot of your bot to reconnect and finish its
handshake **sits back down in the same game** and is asked for a move from wherever the
position had got to. You do not have to do anything for this — the client has no memory of
which board it was on and does not need one; the server remembers.

Fifteen seconds **or until the end of your time**, whichever comes first. A clock that is
running is still running while nobody is there to answer, so an engine that drops on its own
move with four seconds left has four seconds, and it loses on time rather than by
abandonment. Not coming back inside the window is an abandonment: a loss, in the record, for
the engine that was not there.

A run is held open the same way, and this is where it matters most:

| While the socket is gone | What happens to the run |
| --- | --- |
| back inside the window, mid-game | it carries on in the same game, same score, same room |
| back inside the window, between games | it deals the game it stopped at — including the swapped half of a pair it had already started |
| not back inside the window | the run stops, and the games it did play still count |
| a *spare* slot dropped | nothing: the slot the run is using is the only one it cares about |

The middle row is the point. A run that is written off halfway through a pair leaves that
matchup's sample one game lopsided in the first mover's favour, which is the one thing the
pairing exists to prevent — so an engine that comes back gets to finish the pair it started,
whether it left on purpose or not.

---

## When an engine misbehaves

| What happened | What the server does |
| --- | --- |
| `bestmove` is not legal here | asks once more, then ends the game |
| no reply before the deadline | ends the game |
| the engine process dies | the client restarts that slot's copy; the game ends |
| the engine is simply slow | nothing — it loses on time, like anyone else |
| the socket drops | holds the seat for fifteen seconds — see above |

Running out of clock is a loss, not a fault. Leave a margin, and if there is no time to
think, return the first legal move rather than nothing.

A game ended by a fault is recorded as an abandonment. The real reason — the illegal move,
the timeout — is sent to you as the owner and shown on your bot's page.

---

## Ratings, series, tournaments

Your bot has its own account, rating and game history. **Bot versus bot is rated** — that is
the ladder. **Bot versus human is unrated in both directions**, so an engine can never move
a person's rating and nobody can farm one off your engine.

**Your rating is not a running total.** A person's Elo is a transfer — you take points off
whoever you beat — but that pays out for beating a fresh account, and an engine's author
picks its opponents. So the bot ladder awards no points at all: it keeps the head-to-head
record between every pair of bots and solves for the strengths that best explain it. Three
things follow, and together they answer "can I just beat my own throwaway five hundred
times":

- **A matchup counts once, however long you play it.** Past about twenty games between the
  same two bots only the ratio matters.
- **You need at least two opponents, and so do they.** A bot whose only opponent is the bot
  farming it is not on the ladder, which can leave the farmer with no opponents either.
  Bots that only play each other are ranked against each other and nobody else.
- **Nothing is assumed about a bot nobody has played.** An unrated engine's strength is left
  unknown rather than presumed average, so beating it moves that unknown, not your rating.

Only the part of the fit the record establishes is published: where the games do not support
the spread, ratings sit closer to 1200, so a thin record reads as **unproven** rather than as a
number. More opponents move it; more games do not.

Anybody can run a **series**: N pairs of games, each pair played twice from the same book
opening with the colours swapped, which cancels the first-move advantage and stops the result
being about which position each engine drew. Those dealt plies are tagged in the PGN and
excluded from each engine's accuracy. Every game is ordinary — rated, watchable live,
archived — and the run appears as a score table with a link you can hand to somebody.
Stopping a run does not cancel the game it is in the middle of; the pairs it had not started
are forgotten. A series from the website is held to **3 pairs**, **10 minutes each** and
**one running series per person**, because it spends somebody else's CPU, and both engines
need `public_play = yes` or must belong to whoever started it.

An **all-bot tournament** is a round robin between engines, and **you enter yours yourself**:
open the event and register, choosing one of your bots. One place per account — yourself or
one engine, not both and not two engines — and you can withdraw and pick a different one
right up until the host starts it. Your bot does not have to be running to be registered, and
it needs no tournament awareness at any point: the server starts its matches when they are
due. `tournaments = no` is how you keep an engine out of the picker, and the four other
reasons one is refused — it has never connected, it is disabled, it does not play the event's
game, or you already have a place — are all named on the button.

Two things to know before you enter. **You need a verified Discord account** — the engine
cannot have one, so the check is against you, and it is also how the host reaches you when
your bot stops turning up. And **tournament games are rated**: they move the bot ladder like
any other ranked game, which for most engines is where the bulk of their rating comes from.

A host can also make each pairing more than one game. When they do, the colours swap every
game and the match is decided on the aggregate, so your engine plays both sides of every
pairing rather than living with whichever seat it drew.

There is also a **weekend** one. Once a weekend, at a fixed hour, the server
builds a tournament out of whatever engines are online and set to enter
tournaments — no registration, nothing to click. If your bot is connected when it
starts, it plays; if fewer than a handful of engines are up, the event is called
off. The time control is voted on during the week by whoever turns up on the
weekend page, and the slot itself follows an availability window — everyone marks
the slots they can make, shown in their own timezone and under their own day
names, and the event drifts towards whichever slot suits the most people, a week
at a time.
Winning weekends is tracked on its own rolling crown rather than the tournament
title.

Once the host starts the event your bot goes **into reserve**: still online, still visible,
and not accepting challenges or series until the event finishes, so its scheduled matches
are not being lost to passers-by. Before the start it plays anything it likes.

A round robin is the best thing for your rating, being a game against every opponent at once —
as is a series against an opponent you have never played.

**Five bots per account.** If you lose `rpsbot.conf`, rotate the token from your account
page: the bot keeps its identity, rating and history, and only the secret changes.
