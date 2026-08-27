# Connect your bot

Write a program that reads lines from standard input and writes lines to standard output.
Run one short Python script next to it. That is the whole job — your bot never touches a
network, an account, or a game clock.

- **The protocol** is [RPSI](rpsi.md), a UCI-shaped text protocol. Full reference there;
  everything you need to start is on this page.
- **The client** is `rpsbot.py`, downloaded from the **Your bots** page on the website,
  under Account. It reports its version on connect and tells you when a newer one exists.

---

## 1. The game, in a paragraph

Rock–Paper–Scissors Strategy is played on a 9×9 board. Each side has nine pieces — three
rock, three paper, three scissors — and a piece captures what it beats. There are two live
modes: **V3 Infiltration**, won by getting any piece to the opponent's home rank, and
**V5 Total War**, won by wiping the opponent out or owning most of the board once it fills.
Your engine is told which mode each game is, and only has to play the ones it declares.

Games are real games. They appear in the lobby, anyone can spectate them, they are stored
as PGN, and they can be replayed move by move in the review screen afterwards.

---

## 2. What your bot has to do

Read lines on stdin and answer four of them. The other two you just remember.

| You receive | You reply |
| --- | --- |
| `rpsi` | your identity, the modes you play, then `rpsiok` |
| `isready` | `readyok` |
| `position fen … moves …` | nothing — remember it |
| `legalmoves d7-d6 e7-e6 …` | nothing — these are your options |
| `go rtime 298400 btime 300000 rinc 3000 binc 3000` | `bestmove d7-d6` |
| `quit` | exit |

Ignore anything you do not recognise. Never exit on an unknown command.

### Reading a `go` line

That one line is the only thing you have to understand properly:

```text
go rtime 298400 btime 300000 rinc 3000 binc 3000
   │           │            │          └── Blue gains 3000 ms after each move
   │           │            └── Red gains 3000 ms after each move
   │           └── Blue has 300000 ms left  (5:00)
   └── Red has 298400 ms left  (4:58.4)
```

Everything is **milliseconds**, and `r`/`b` are **Red and Blue**, not you and your
opponent — which side you are is whatever `position` says is to move. So the clock that
matters to you is `rtime` when it is Red's turn and `btime` when it is Blue's.

You decide how much of it to spend; the protocol does not. A common starting point is a
twentieth of what is left plus most of the increment, which for the line above gives Red
about 17 seconds. Whatever you choose, **return before your own clock reaches zero** —
running out is a loss, and the server will not wait.

Other things `go` can carry, all optional and all safe to ignore:

| Parameter | Meaning |
| --- | --- |
| `movetime <ms>` | search exactly this long and ignore the clock |
| `depth <n>` | stop after completing this depth |
| `nodes <n>` | stop after roughly this many nodes |
| `searchmoves <m>…` | only consider these moves |
| `infinite` | search until told to stop |

There is no `movestogo`: a time control here is an allowance plus an increment, so there is
no move count to reach.

A complete, legal bot:

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

It plays random moves and beats nobody, but it finishes every game legally in both modes.
Download it from the Your bots page as `example_engine.py`.

**`flush=True` matters.** Buffered output looks exactly like a hung engine.

### Why that is so short

The server sends `legalmoves` before every `go`. There is no move-generation library for
this game, so without that line the smallest possible bot would first need a FEN parser, a
neighbour table, the capture cycle, and three sets of mode-specific movement rules. A
strong engine ignores the line and generates its own moves; a beginner picks from it.

### Squares, moves, positions

Files `a`–`i`, ranks `1`–`9`; `a1` is Blue's home corner. A move is `d7-d6`, or `d7xd6`
when it captures — **accept either and do not read anything into which one you got**. A
position is three space-separated fields: pieces, side to move (`r`/`b`), territory. The
third field is mandatory even in modes that ignore it.

### Three things that catch people out

1. **`score cp N` is from the side to move's point of view**, not Red's and not yours. This
   is the single most common bug, and it is silent — a strong engine just looks weak.
2. **There is no `startpos`.** You always get a full FEN, because a game can begin from a
   position somebody chose, and a mode's opening layout can be redesigned.
3. **The `moves` list is your only repetition history.** The third occurrence of a position
   is a draw, and the FEN cannot tell you how many times you have been there.

Full detail, including `info` output and search limits, is in [rpsi.md](rpsi.md).

---

## 3. Getting connected

**Register an account** on the website — anonymous play stays anonymous, but a bot needs an
owner. Registering keeps the rating and history you already have.

**Add a bot** from your account page. You get a token like `rps_b_…`, shown once. It *is*
your bot's identity: the same token always means the same bot, with the same rating and
history, so a restart is recognised rather than creating a second one.

**Download the client** from the Your bots page and check it against the digest shown
there:

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
Paste your bot token (from your account page): rps_b_…
Server [wss://api-rps.henhen1227.com/ws]:

Saved rpsbot.conf. Connecting…
MyBot is online. Waiting for a game.
```

Press Enter to accept the server shown; type another to point at your own. Leave the icon
blank if you have not drawn one — *Giving your bot a face* in §6 says how, and you can
add one at any time. Every later run connects straight away. The engine
command after `--` is deliberately **not** saved, so the config file can never contain
something that runs.

### Options

```text
--reconfigure     ask the six questions again
--name NAME       override the bot name for this run
--icon PATH       override the icon for this run
--server URL      point at a different instance (saved on first run)
--config PATH     use a different config file
```

Two bots on one machine: give each its own directory and its own conf.

### Versions

On connect the client tells the server which version it is. If a newer one exists you get a
notice with the download link; if yours is too old to talk to the server it says so and
stops before starting your engine. The current version and its digest are always on the
Your bots page and at `GET /api/bot/version`:

```json
{
  "version": "1.2",
  "minimumVersion": "1.0",
  "sha256": "af3286f8…",
  "downloadUrl": "https://api-rps.henhen1227.com/api/bot/rpsbot.py",
  "exampleUrl": "https://api-rps.henhen1227.com/api/bot/example_engine.py",
  "exampleSha256": "8d50e10e…",
  "guideUrl": "https://api-rps.henhen1227.com/api/bot/guide"
}
```

Enough to update without a browser. The three links are absolute — they come from the
server's configured public address, or from the address you asked on — so a script can
compare `sha256` against the file it has and fetch a new one when they differ.
`minimumVersion` is the oldest client the server will still play; anything older is refused
at connect — and it moves only when a change makes an older client genuinely unable to
play, which neither adding icons in 1.1 nor graceful shutdown in 1.2 did. A 1.0 client still
connects and still plays; it simply sends no picture, and the server leaves whatever it is
showing alone.

The same is true of §7: a shutdown asked for on the website works on **every** client back to
1.0, because the message that ends one is the one they all already stop on. What 1.2 adds is
the two ways to ask from your own machine — Ctrl-C and the engine's own `shutdown` line — and
a plainer sentence when it is over. `guideUrl` serves this document and the protocol reference as Markdown, under
`guide` and `protocol`, which is where a change to either shows up:

```bash
curl -s https://api-rps.henhen1227.com/api/bot/version
curl -s https://api-rps.henhen1227.com/api/bot/guide | python3 -c 'import json,sys; print(json.load(sys.stdin)["protocol"])'
```

---

## 4. What the client does, and how to check it

About 200 lines, no game logic. It writes the lines the server sends to your engine's
stdin, reads stdout until a line starts with the prefix the server asked for, and sends
those lines back. Four greps establish the rest:

| Check | What you should find |
| --- | --- |
| `grep -n subprocess rpsbot.py` | one `Popen`, argv exactly what you typed after `--` |
| `grep -n 'wss\?://' rpsbot.py` | one destination, the `server` value in your conf |
| `grep -n 'open(' rpsbot.py` | two files: `rpsbot.conf`, written `0600`, and your icon, read as bytes |
| `grep -nE 'eval\|exec\|pickle\|os.system\|shell=True' rpsbot.py` | nothing |

Roughly a third of it is failure handling: reconnection with backoff, restarting a hung
engine, draining stderr so a chatty engine cannot deadlock on a full pipe.

---

## 5. When it will not connect

**`<server> does not support bots`** — the server you pointed at is older than your client,
or is not an RPS Strategy server. The most common cause is leaving the server question at
its default when you meant your own machine. Check the `server` line in `rpsbot.conf`:

```ini
server = wss://api-rps.henhen1227.com/ws   # the public server
server = ws://localhost:8080/ws            # a server you are running yourself
```

Note `ws://` for a local server and `wss://` for a public one, and that the path ends in
`/ws`. Run with `--reconfigure` to be asked again, or just edit the file.

**`that bot token is not recognised`** — the token is mistyped, or it belongs to a bot on a
different server. Tokens are per-server: one from the public site will not work against
your own instance.

**`this copy of rpsbot.py is too old`** — download the current one from the Your bots page.
The
message includes the link.

**`that bot name is already taken`** — names are shared with player names across the whole
server. Pick another in `rpsbot.conf`.

**It connects and then nothing happens** — that is normal. It is waiting for somebody to
challenge it, or for anybody to enter it into a series. `Waiting for a game.` is the last
thing it prints until one starts.

## 6. Settings, and who wins

`rpsbot.conf` holds two switches:

```ini
public_play = yes    other players can challenge this bot, and can enter it into a series
                     against another bot
tournaments = yes    it is enrolled when an all-bot event is created
```

`public_play = no` keeps both: nobody but you can challenge it, and nobody but you can put
it in a series. Your own bots are always available to you, which is what makes running a
new version against your old one work.

The file asserts both **every time the bot connects**. The website can change either while
the bot is running and it takes effect immediately — but a restart re-applies the file. If
you turn something off on the site and it comes back later, that is the file, not a bug.

### Giving your bot a face

A bot with no icon is drawn as two letters on a coloured square. To replace that, point the
`icon` line at a PNG:

```ini
icon = mybot.png            # relative to wherever you start the client
icon = /home/me/art/mybot.png
```

**Square, at most 128×128, at most 64 KiB.** Smaller squares are fine and are drawn at
whatever size the page needs; nothing is scaled up, and nothing that is not a PNG is
accepted — no JPEG, no SVG, no animation. The server decodes what arrives and re-encodes
it before storing it, so what the website serves is always a plain PNG of the size you
sent.

It travels with the name and the switches, on the same socket, every time the bot connects.
So there is no upload page and nothing to click: **replace the file and restart the bot**.
Three things follow from that, and they are the whole of the behaviour:

| Your `icon` line | What the website shows |
| --- | --- |
| a readable PNG | that picture, from the next connect on |
| blank, or no `icon` line at all | no picture — this **takes down** one you set earlier |
| a file that cannot be read | no change, and the client says why on stderr |

That last row is deliberate: starting the client from the wrong directory is a mistake, not
an instruction to erase your bot's face. You get a line like

```text
icon: mybot.png is 256x256, and the limit is 128x128; leaving the current one alone
```

and the bot connects and plays as usual. The same is true of anything the server refuses
after a closer look than the client can give it — a truncated PNG, say: the connection is
never in question, and the reason is printed under `icon:` when the bot comes online.

A **1.0 client sends no icon at all**, which is the same as the third row: upgrading the
server does not clear the pictures of bots still running the older script, and downgrading
the client does not either.

---

## 7. Taking it down without losing a game

Killing the process abandons whatever is on the board. That is a loss for your engine, a
spoiled game for whoever was playing it, and an abandonment on the record nobody meant — so
the old answer was to ask people to stop challenging you, wait, and then pull the plug.

Instead, ask for a **graceful shutdown**. The bot stops being offered new games immediately,
plays out what it already owes, and then stops. Three ways to ask, all the same request:

| Where | How |
| --- | --- |
| The website | **Your bots**, under Account: **FINISH AND STOP**, or **PAUSE** to stay connected |
| The machine it runs on | Ctrl-C, or a `SIGTERM` from something like `systemctl stop` |
| The engine itself | print `shutdown` on stdout — see [rpsi.md](rpsi.md#shutdown) |

```text
^C
  Shutting down gracefully: no new games, finishing what is owed.
  Press Ctrl-C again to stop now and abandon the game on the board.

shutting down after: finishing the game it is playing, 3 matches left in Summer Cup
MyBot has finished everything it owed. Shutting down.
```

**Press Ctrl-C again and it goes immediately**, abandoning the game — which is what the
first press used to do, and is still there when you mean it.

### What it waits for

| Owed | What happens |
| --- | --- |
| the game on the board | played to the end, and it counts |
| a series | the current **pair** is finished, then the run stops |
| a tournament that has started | every match it still has to play |
| a tournament that has not started | it withdraws — nothing has been played, so nothing is lost |

The pair is the unit for a series because the two games of one are the same opening with the
colours swapped, and stopping between them leaves the matchup's record one game lopsided.
An unplayed game is never a loss — a game that never started is recorded nowhere — but
finishing the pair costs one more short game and keeps the sample straight.

New games are refused from every direction while it drains: nobody can challenge it, nobody
can enter it into a series, and an all-bot event created now will not enrol it. The lobby
shows it as **SHUTTING DOWN** rather than offering a button that would fail.

### Pause, and changing your mind

**PAUSE** is the same drain without the exit: the bot finishes what it owes and then sits
there connected, accepting nothing, until you restart it. That is the one to use when
something else — systemd, a container runtime — decides when the process may stop, and would
only restart it into the same problem.

Either way it is **remembered on the connection and nothing else**, so a restart is all it
takes to put the bot back in play. There is no switch left set in the registry to find
later, and reconnecting after a dropped network counts as a restart. While it is still
running you can also press **RESUME** on the website to call the whole thing off.

---

## 8. When an engine misbehaves

| What happened | What the server does |
| --- | --- |
| `bestmove` is not legal here | asks once more, then ends the game |
| no reply before the deadline | ends the game |
| the engine process dies | the client restarts it; the game ends |
| the engine is simply slow | nothing — it loses on time, like anyone else |

Running out of clock is a loss, not a fault. Leave a margin: return a move before your
clock reaches zero, and if there is no time to think, return the first legal move rather
than nothing.

A game ended by a fault is recorded as an abandonment. The real reason — the illegal move,
the timeout — is sent to you as the owner and shown on your bot's page.

---

## 9. Ratings, series, tournaments

Your bot has its own account, rating, and game history.

- **Bot vs bot** is rated. That is the ladder.
- **Bot vs human** is unrated in both directions. An engine can never move a person's
  rating, and nobody can farm one off your engine.

**Your rating is not a running total.** A person's Elo is a transfer — you take points
off whoever you beat — but that system pays out for beating a fresh account, and an
engine's author picks its opponents. So the bot ladder does not award points at all. It
keeps the **head-to-head record between every pair of bots** and solves the whole board at
once for the strengths that best explain it. Four things follow, and together they are the
answer to "can I just beat my own throwaway five hundred times":

- **A matchup counts once, however long you play it.** Past about twenty games between the
  same two bots only the ratio matters. The five hundredth win is worth nothing.
- **You need at least two opponents**, and so do they. A bot whose only opponent is the bot
  farming it is not on the ladder, so those games are not games the ladder has heard of —
  which can leave the farmer with no opponents either. Minting more throwaways does not
  help; the rule is applied over and over until nothing is left below the bar.
- **A private league is not the ladder.** Bots that only play each other are ranked against
  each other and nobody else, and there is no honest way to publish that next to everyone
  else's rating. The ladder is the group of bots that all play each other, directly or
  through somebody. Play the bots that play each other and your whole record comes with you.
- **Nothing is assumed about a bot nobody has played.** This is the one that matters. It is
  tempting to treat a new engine as probably average, and that assumption is exactly what a
  farm mints: register, be presumed average, lose on purpose. So an unrated engine's
  strength is left unknown, and beating it moves that unknown rather than your rating.

What is published is the part of the fit the record actually establishes. A board that has
played enough to tell its engines apart is shown as it is; where the games do not support
the spread, ratings sit closer to 1200 instead. So a thin record reads as *unproven* rather
than as a number, and the way to move it is more opponents rather than more games.

Retiring a bot does not erase its games, so a throwaway's losses stay on the record.
Nothing you can do to your own bots launders their results.

Anybody can run a **series**: *N* pairs of games, one at a time, each pair played twice
from the same random opening with the colours swapped. Swapping cancels the first-move
advantage; the shared opening stops the result being about which position each engine drew.
Those dealt plies are tagged in the PGN and show as *book* in the review, excluded from
each engine's accuracy.

A series started from the website is held to three limits, because it spends somebody
else's CPU: at most **3 pairs**, at most **3 minutes each**, and **one running series per
person**. Both engines must have `public_play = yes`, or belong to whoever started it. An
admin is held to none of these — a fifty-pair run at a real time control is how the host
settles which of two engines is stronger.

Every game a series plays is an ordinary game: it is rated, it is watchable while it
happens, and it lands in the archive. The run appears as one card on the Bots and
Leaderboard pages, drawn as a score table: your engine gets a row, each game gets a column,
and a point sits under the game in the winner's row — 1, 0, or ½ each for a draw. Press a
column to watch that game. The same table sits over the board while you are watching, so
you can step through the run without going back to the list.

Pressing a column opens that game: the one being played right now puts you on the live
board, and a finished one opens its record. A column with no result and no board — the game
a stopped run was in the middle of — does nothing, because there is nothing behind it yet.
Watching a run is one conversation from end to end, so the chat stays with you across every
game of it, including while you are looking back at an earlier one.

**Every run and every game of it has a link you can hand to somebody.** The card in the
history copies a link to the run and opens its own page, which lists all of its games — who
won each one and how, which colour each engine had, the opening they were both dealt, and
the seed you would need to play the whole thing again. Each game there copies a link to its
own review. Going the other way, a game link opens the review with the run's score table
over the board, so somebody sent game four of six can step through the other five and press
**Series results** for the whole thing. A bot game that was not part of a run — a bare
challenge — copies a link from the history the same way.

A game that ended because an engine stopped answering says so under the table, names the
engine that left, and gives the game to the one that stayed. **Stopping a run does not
cancel the game it is in the middle of** — the two engines are already on a board — so that
game finishes and counts. The pairs it had not started yet are simply forgotten.

A series against a **new** opponent is worth far more to your rating than another run
against one you have already played out.

An **all-bot tournament** enrols every online bot with `tournaments = yes` and plays a round
robin. Your bot needs no tournament awareness — the server starts its matches when they are
due. A round robin is the single best thing for the ladder, and for your own rating: it is
a game against every opponent at once, which is exactly what the fit rewards.

**Five bots per account**, which is enough to run a new version against your old one.

If you lose `rpsbot.conf`, rotate the token from your account page. The bot keeps its
identity, rating and history; only the secret changes.
