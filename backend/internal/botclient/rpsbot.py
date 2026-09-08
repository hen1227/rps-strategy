#!/usr/bin/env python3
"""Connect a Rock-Paper-Scissors Strategy engine to the live server.

    pip install websockets
    python3 rpsbot.py -- ./your-engine

The server sends protocol lines; this pipes them to your engine's stdin and
sends back whatever it printed. There is no game logic here.

Ctrl-C asks the server for a graceful shutdown, which lets the games already on
the board finish. A second Ctrl-C stops now and abandons them.

A bot may play more than one game at once (max_games in rpsbot.conf). Each
concurrent game slot is its own connection and its own copy of your engine, so
pick a number your machine can afford; 1 plays best in ranked games.

With no configuration file, this asks a few questions and writes one.

See https://rps.henhen1227.com/account/bots/protocol for the protocol your
engine needs to speak.
"""

import argparse
import base64
import collections
import configparser
import json
import os
import queue
import secrets
import signal
import subprocess
import sys
import threading
import time

from websockets.sync.client import connect

CLIENT_VERSION = "1.4"
DEFAULT_SERVER = "wss://api-rps.henhen1227.com/ws"
CONFIG_PATH = "rpsbot.conf"

# The most slots one bot may open. Each one costs a connection and an engine.
MAX_GAMES = 5

# How long a later slot waits for the first one to register before giving up on
# it and connecting anyway.
FIRST_SLOT_TIMEOUT = 30

# What the website will accept as a bot's picture.
PNG_MAGIC = b"\x89PNG\r\n\x1a\n"
ICON_PIXELS = 128
MAX_ICON_BYTES = 64 * 1024

# The one line an engine can print to take itself out of play. Everything else
# it writes is passed on.
ENGINE_SHUTDOWN = "shutdown"


class GracefulExit(Exception):
    """The server has told us there is nothing left to finish."""


def ask(prompt, default=None):
    answer = input(f"{prompt}: " if default is None else f"{prompt} [{default}]: ").strip()
    return answer or default or ""


def ask_yes(prompt, default=True):
    answer = input(f"{prompt} [{'Y/n' if default else 'y/N'}] ").strip().lower()
    return default if not answer else answer.startswith("y")


def ask_count(prompt, default, highest):
    """Ask for a number in 1..highest, until one arrives."""
    while True:
        answer = ask(prompt, str(default))
        try:
            chosen = int(answer)
        except ValueError:
            print(f"  {answer!r} is not a number.", flush=True)
            continue
        if 1 <= chosen <= highest:
            return chosen
        print(f"  choose a number between 1 and {highest}.", flush=True)


def configure(path, server):
    """Ask the setup questions and write the answers down."""
    print("Setting up a new bot. Answers are saved to", path, flush=True)
    config = configparser.ConfigParser()
    config["bot"] = {
        "name": ask("Bot name"),
        "icon": ask("Icon: a square PNG up to 128x128, or blank for none", ""),
        "public_play": "yes" if ask_yes("Let other players challenge this bot?") else "no",
        "tournaments": "yes" if ask_yes("Enter tournaments automatically?") else "no",
        "max_games": str(ask_count(
            f"Games at once (1-{MAX_GAMES}; each one runs its own copy of your engine)",
            1, MAX_GAMES,
        )),
        "token": ask("Paste your bot token (from your account page)"),
        # Written down rather than asked about: almost nobody wants a server
        # other than the default, and `--server` is there for those who do.
        "server": server,
    }
    save(config, path)
    print(f"Saved {path}.", flush=True)
    read_icon(config["bot"]["icon"])
    return config["bot"]


def save(config, path):
    """Write the config file out, readable only by its owner."""
    with open(path, "w", encoding="utf-8") as handle:
        config.write(handle)
    os.chmod(path, 0o600)


def load(path, reconfigure, server):
    config = configparser.ConfigParser()
    if reconfigure or not config.read(path) or "bot" not in config:
        return configure(path, server)
    return config["bot"]


def read_max_games(settings, override=None):
    """How many games to play at once, as a number in 1..MAX_GAMES."""
    raw = override if override is not None else settings.get("max_games", "1")
    try:
        chosen = int(str(raw).strip() or 1)
    except ValueError:
        print(f"max_games: {raw!r} is not a number; playing one game at a time",
              file=sys.stderr, flush=True)
        return 1
    if chosen < 1 or chosen > MAX_GAMES:
        corrected = min(max(chosen, 1), MAX_GAMES)
        print(f"max_games: {chosen} is outside 1-{MAX_GAMES}; using {corrected}",
              file=sys.stderr, flush=True)
        return corrected
    return chosen


# One slot is one connection to the server plus one copy of the engine, playing
# one game at a time. Playing several games at once means running several slots,
# one thread each: `index` numbers them, `count` is how many there are, and
# `session` is the same random id on all of them, so the server can tell this
# process's slots apart from a second copy of the bot somebody left running
# elsewhere (which it displaces).
#
# Slot 0 leads. It claims the bot's account, uploads the icon and reports the
# rules; the others wait for it to register, then say nothing about any of that.
# A shutdown belongs to the bot rather than to one of its connections, so every
# slot shares one Stopping.
Slot = collections.namedtuple("Slot", "index count session")

def slot_printer(slot):
    """Print with a slot label, when there is more than one slot to confuse."""
    label = "" if slot.count == 1 else f"[{slot.index + 1}/{slot.count}] "

    def note(text, error=False):
        stream = sys.stderr if error else sys.stdout
        for line in str(text).splitlines() or [""]:
            print(label + line, file=stream, flush=True)

    return note


def report_rules(rules, settings, path, note):
    """Print the rules each mode was last published under, and warn about any
    that changed since this bot's last connect. The dates are remembered in the
    config file.
    """
    if not rules:
        return
    seen = dict(
        pair.split(":", 1)
        for pair in settings.get("rules_seen", "").split() if ":" in pair
    )
    changed = []
    for mode in sorted(rules):
        note(f"Using rules {mode} published {rules[mode]}")
        if mode in seen and seen[mode] != rules[mode]:
            changed.append(f"{mode} (this bot last played {seen[mode]})")
    if changed:
        note("  The rules changed since this bot last connected: "
             + ", ".join(changed) + ".", error=True)

    current = " ".join(f"{mode}:{rules[mode]}" for mode in sorted(rules))
    if current == settings.get("rules_seen", ""):
        return
    settings["rules_seen"] = current

    stored = configparser.ConfigParser()
    if not stored.read(path) or "bot" not in stored:
        return
    stored["bot"]["rules_seen"] = current
    try:
        save(stored, path)
    except OSError as error:
        # Not worth refusing to play over.
        note(f"could not record the rules date ({error})", error=True)


def read_icon(path):
    """The icon as base64, "" for none, or None when it could not be read."""
    path = (path or "").strip()
    if not path:
        return ""

    def refuse(reason):
        print(f"icon: {path} {reason}; leaving the current one alone",
              file=sys.stderr, flush=True)
        return None

    try:
        with open(path, "rb") as handle:
            data = handle.read(MAX_ICON_BYTES + 1)
    except OSError as error:
        return refuse(f"could not be read ({error.strerror or error})")

    if len(data) > MAX_ICON_BYTES:
        return refuse(f"is larger than {MAX_ICON_BYTES // 1024} KiB")
    if not data.startswith(PNG_MAGIC) or data[12:16] != b"IHDR":
        return refuse("is not a PNG")
    width = int.from_bytes(data[16:20], "big")
    height = int.from_bytes(data[20:24], "big")
    if width != height:
        return refuse(f"is {width}x{height}, and an icon has to be square")
    if not 1 <= width <= ICON_PIXELS:
        return refuse(f"is {width}x{height}, and the limit is "
                      f"{ICON_PIXELS}x{ICON_PIXELS}")
    return base64.b64encode(data).decode("ascii")


class Engine:
    """The engine subprocess, and the only thing this script executes."""

    def __init__(self, argv, on_shutdown=None, label=""):
        self.argv = argv
        self.on_shutdown = on_shutdown
        self.process = subprocess.Popen(
            argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, text=True, bufsize=1,
        )
        self.lines = queue.Queue()
        # stdout feeds the queue; stderr is copied to ours, labelled with the
        # slot, so a chatty engine cannot fill a pipe buffer and deadlock.
        self._pump(self.process.stdout, self._read)
        self._pump(self.process.stderr,
                   lambda line: sys.stderr.write(f"[engine{label}] {line}"))

    def _read(self, line):
        """Queue a line for the exchange, unless it is one meant for us.

        Watched here rather than in exchange(), so the word is not missed while
        the engine is idle.
        """
        word = line.split()
        if word and word[0] == ENGINE_SHUTDOWN and self.on_shutdown:
            self.on_shutdown(" ".join(word[1:]).strip())
            return
        self.lines.put(line)

    @staticmethod
    def _pump(stream, sink):
        threading.Thread(target=lambda: [sink(line) for line in stream], daemon=True).start()

    def exchange(self, lines, expect, timeout):
        """Write lines, then read until one starts with `expect`."""
        for line in lines:
            self.process.stdin.write(line + "\n")
        self.process.stdin.flush()

        collected, deadline = [], time.monotonic() + timeout
        while True:
            line = self.lines.get(timeout=max(deadline - time.monotonic(), 0)).rstrip("\n")
            collected.append(line)
            if line.startswith(expect):
                return collected
            # Keep only the newest lines, so an engine that prints forever
            # cannot grow this without bound.
            del collected[:-64]

    def close(self):
        try:
            self.process.terminate()
            self.process.wait(timeout=5)
        except Exception:
            self.process.kill()


def serve(settings, argv, stopping, slot, claimed, note, config_path):
    """One slot's connection: hand every frame to the engine, send its answer.

    The engine is not started until the server sends the first frame for it.
    `stopping` is the shared shutdown state, so a Ctrl-C between two
    connections is still remembered by the next one; `claimed` is set once any
    slot has registered. See Slot.
    """
    engine = None
    try:
        with connect(settings["server"], max_size=None) as socket:

            def request_drain(reason, exit_when_done=True):
                """Ask the server to take this bot out of play.

                Only the server knows what the bot still owes — a game on the
                board, half a pair of a series, four matches of a round robin —
                so it is asked rather than decided here. It answers with
                bot_draining now and bot_shutdown when there is nothing left.

                Safe from any thread: websockets' threading client holds a mutex
                across a send.
                """
                stopping.drain = (exit_when_done, reason)
                try:
                    socket.send(json.dumps(
                        {"type": "bot_drain", "exit": exit_when_done,
                         "reason": reason}
                    ))
                except Exception as error:
                    note(f"could not ask the server to shut down: {error}",
                         error=True)

            stopping.register(slot.index, request_drain)
            registration = {
                "type": "authenticate_bot",
                "clientVersion": CLIENT_VERSION,
                "token": settings["token"],
                "name": settings["name"],
                "publicPlay": settings.getboolean("public_play", True),
                "enterTournaments": settings.getboolean("tournaments", True),
                "maxGames": slot.count,
                "sessionId": slot.session,
                "slot": slot.index,
            }
            # Read every connect, so replacing the file and restarting is all
            # it takes to change the picture. Omitted when it could not be read
            # (see read_icon), and sent by slot 0 only.
            if slot.index == 0:
                icon = read_icon(settings.get("icon", ""))
                if icon is not None:
                    registration["icon"] = icon
            socket.send(json.dumps(registration))
            for raw in socket:
                message = json.loads(raw)
                kind = message.get("type")
                if kind == "bot_ready":
                    # First: the other slots are waiting on this.
                    claimed.set()
                    note(f"{message.get('name')} is online. Waiting for a game.")
                    # Slot 0 only: every slot plays the same rules, and saying
                    # so five times buries the connect where they changed.
                    if slot.index == 0:
                        report_rules(message.get("rules"), settings, config_path, note)
                    warning = message.get("iconWarning")
                    if warning:
                        note(f"  icon: {warning}", error=True)
                    update = message.get("clientUpdate")
                    if update:
                        note(
                            f"\n  A newer rpsbot.py is available (you have {CLIENT_VERSION},"
                            f" latest is {update.get('version')}).\n"
                            f"  Download it from {update.get('url')}\n",
                            error=True,
                        )
                    # The server keeps a drain on the connection, so that
                    # restarting the bot puts it back in play — which leaves
                    # this process the only thing able to tell a restart from a
                    # dropped socket. Re-asked here, and not before the
                    # registration above, because the server reads the first
                    # frame of a connection as a registration.
                    if stopping.drain:
                        exit_when_done, source = stopping.drain
                        request_drain(source, exit_when_done)
                    continue
                if kind == "authentication_failed":
                    raise SystemExit(
                        f"{settings['server']} does not support bots.\n"
                        "  That server is older than this client, or it is not an RPS Strategy\n"
                        "  server at all. Check the `server` line in rpsbot.conf.\n"
                        f"  (it said: {message.get('message')})"
                    )
                if kind == "bot_draining":
                    # Progress, not a verdict: the server has stopped offering
                    # this bot and is naming what it still has to finish.
                    note(message.get("message", "shutting down"))
                    # Written down because the next connection has to ask for
                    # the drain again. A cancellation — from the website, say —
                    # arrives the same way.
                    state = message.get("drain") or {}
                    if state.get("draining"):
                        stopping.drain = (
                            bool(state.get("exitWhenDone")),
                            state.get("source") or "the website",
                        )
                    else:
                        stopping.drain = None
                        stopping.requested = False
                    continue
                if kind == "bot_shutdown":
                    raise GracefulExit(message.get("message", "shutting down"))
                if kind == "bot_rejected":
                    raise SystemExit(f"server refused this bot: {message.get('message')}")
                if kind != "engine":
                    continue
                # First frame the server sends is the engine handshake, so this
                # is where the subprocess is actually needed.
                engine = engine or Engine(
                    argv,
                    on_shutdown=lambda reason: request_drain(
                        f"the engine ({reason})" if reason else "the engine"
                    ),
                    label="" if slot.count == 1 else f" {slot.index + 1}",
                )

                reply = {"type": "engine_reply", "gameId": message.get("gameId"),
                         "seq": message.get("seq")}
                try:
                    reply["lines"] = engine.exchange(
                        message["lines"], message["expect"],
                        message.get("timeoutMs", 30000) / 1000,
                    )
                except (queue.Empty, BrokenPipeError, OSError) as error:
                    # A timed-out engine may still be about to print, which
                    # would poison the next exchange, so it is restarted.
                    reply = {"type": "engine_error", "gameId": message.get("gameId"),
                             "seq": message.get("seq"),
                             "reason": "timeout" if isinstance(error, queue.Empty) else "crashed"}
                    on_shutdown = engine.on_shutdown
                    label = "" if slot.count == 1 else f" {slot.index + 1}"
                    engine.close()
                    engine = Engine(argv, on_shutdown=on_shutdown, label=label)
                socket.send(json.dumps(reply))
    finally:
        stopping.unregister(slot.index)
        if engine:
            engine.close()


class Stopping:
    """Whether this bot is on its way out of play, and how it was asked.

    One object shared across reconnects and across slots, because a drain
    belongs to the bot and outlives the socket it was asked on.

    `drain` is "this bot is leaving", whoever said so, including the website,
    and is what the next connection re-asserts. `requested` is "somebody at
    this machine asked", which a second Ctrl-C reads as meaning *now*. `fatal`
    is what ended the run for good, set on a slot's thread and printed by the
    main one.
    """

    def __init__(self):
        self.requested = False
        # (exit_when_done, source) for a drain in effect, or None.
        self.drain = None
        # The first thing that ended this run for good, or None.
        self.fatal = None
        # One drain sender per connected slot, keyed by slot index. Guarded,
        # because slots add and drop theirs on their own threads while a signal
        # handler on the main one is reading the lot.
        self._mutex = threading.Lock()
        self._senders = {}

    def register(self, index, sender):
        with self._mutex:
            self._senders[index] = sender

    def unregister(self, index):
        with self._mutex:
            self._senders.pop(index, None)

    def request(self):
        """Ask for a graceful shutdown. False when there is nobody to ask.

        Every connected slot is told, rather than the first one that answers: a
        slot that is offline right now picks it up from `drain` on its next
        connection, and one that is up should not wait for that.
        """
        self.requested = True
        # Recorded even with nobody to tell, which is what carries the intent
        # to the connection after this one.
        self.drain = (True, "the client")
        with self._mutex:
            senders = list(self._senders.values())
        for sender in senders:
            sender("the client")
        return bool(senders)

    def stop(self, reason):
        """Record what ended the run, keeping the first thing that said so."""
        with self._mutex:
            if self.fatal is None:
                self.fatal = reason


def run_slot(slot, settings, argv, stopping, claimed, note, config_path):
    """One slot's connect-play-reconnect loop, on its own thread.

    Threads rather than processes because the work here is a socket and a pipe:
    the thinking happens in the engine subprocess this starts.
    """
    # Later slots wait for the first one to register. See Slot.
    if slot.index and not claimed.wait(FIRST_SLOT_TIMEOUT):
        note("the first slot has not come up yet; connecting anyway", error=True)

    delay = 1
    while True:
        try:
            serve(settings, argv, stopping, slot, claimed, note, config_path)
            delay = 1
        except GracefulExit as done:
            note(done)
            return
        except SystemExit as refused:
            # Handed to main(), which is the thread that can exit with it;
            # raising it again here would only end this thread silently.
            stopping.stop(str(refused))
            return
        except Exception as error:
            note(f"disconnected ({error}); retrying in {delay}s", error=True)
        if stopping.fatal:
            # Another slot heard something that applies to all of them: a token
            # that is not recognised, a bot that has been retired, this process
            # replaced by another one holding the same token.
            return
        time.sleep(delay)
        delay = min(delay * 2, 30)


def install_signal_handlers(stopping):
    """Turn Ctrl-C and SIGTERM into a graceful shutdown.

    The first one asks and keeps playing; the second one goes now. The default
    for both signals is to die immediately, which abandons the games on the
    board and hands the opponents wins nobody played for.
    """

    def handle(signum, frame):
        if not stopping.requested and stopping.request():
            print("\n  Shutting down gracefully: no new games, finishing what is owed."
                  "\n  Press Ctrl-C again to stop now and abandon the games on the board.\n",
                  flush=True)
            return
        # Restore the default, so a third one gets through even if something
        # below is wedged.
        signal.signal(signum, signal.SIG_DFL)
        raise KeyboardInterrupt

    for received in (signal.SIGINT, signal.SIGTERM):
        try:
            signal.signal(received, handle)
        except ValueError:
            # Not the main thread, or a platform without this signal. Neither
            # is a reason to refuse to play.
            pass


def main():
    parser = argparse.ArgumentParser(description="Run an engine on RPS Strategy.")
    parser.add_argument("--config", default=CONFIG_PATH)
    parser.add_argument("--server", help="override the server URL")
    parser.add_argument("--name", help="override the bot name")
    parser.add_argument("--icon", help="override the icon PNG for this run")
    parser.add_argument("--max-games", type=int, metavar="N",
                        help=f"override how many games to play at once (1-{MAX_GAMES})")
    parser.add_argument("--reconfigure", action="store_true", help="ask the questions again")
    parser.add_argument("engine", nargs=argparse.REMAINDER,
                        help="-- followed by the command that runs your engine")
    options = parser.parse_args()

    argv = [word for word in options.engine if word != "--"]
    if not argv:
        parser.error("name your engine after --, for example: rpsbot.py -- ./rpsfish rpsi")

    # The server goes in before the wizard runs, so someone pointing this at
    # their own instance is not asked for --server on every later run.
    settings = load(options.config, options.reconfigure, options.server or DEFAULT_SERVER)
    for key, value in (("server", options.server), ("name", options.name),
                       ("icon", options.icon)):
        if value:
            settings[key] = value
    # A config file written before the wizard recorded the server has no line
    # for it, and no destination is not a reason to refuse to play.
    if not settings.get("server"):
        settings["server"] = DEFAULT_SERVER

    count = read_max_games(settings, options.max_games)

    stopping = Stopping()
    install_signal_handlers(stopping)

    # One id for the whole process, shared by all of its slots. See Slot.
    session = secrets.token_hex(8)
    claimed = threading.Event()
    if count > 1:
        print(f"Playing up to {count} games at once, one engine each.", flush=True)

    slots = []
    for index in range(count):
        slot = Slot(index=index, count=count, session=session)
        worker = threading.Thread(
            target=run_slot,
            args=(slot, settings, argv, stopping, claimed, slot_printer(slot),
                  options.config),
            # Daemons, so the second Ctrl-C — the one that means *now* — is not
            # held up by a slot waiting on a socket or a backoff.
            daemon=True,
            name=f"slot-{index + 1}",
        )
        worker.start()
        slots.append(worker)

    # Polled rather than joined, because a signal only reaches the main thread
    # while it is running Python: a bare join can sit through the Ctrl-C that
    # was meant to be the second one.
    try:
        while any(worker.is_alive() for worker in slots):
            time.sleep(0.2)
    except KeyboardInterrupt:
        return
    if stopping.fatal:
        raise SystemExit(stopping.fatal)


if __name__ == "__main__":
    main()
