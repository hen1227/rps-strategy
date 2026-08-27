#!/usr/bin/env python3
"""Connect a Rock-Paper-Scissors Strategy engine to the live server.

    pip install websockets
    python3 rpsbot.py -- ./your-engine

On connect this reports its version to the server. If a newer one exists you
are told where to get it; if this one is too old to talk to the server, it
says so and stops.

Ctrl-C, or a SIGTERM from something like `systemctl stop`, asks the server
for a graceful shutdown: no new games, finish what is already owed, then
exit. Press it a second time to stop immediately, which abandons the game on
the board. Your engine can ask for the same thing itself by printing
`shutdown` on its own stdout.

The first run asks six questions and saves the answers to rpsbot.conf.
Every run after that connects straight away.

This script contains no game logic. The server sends the engine protocol
lines; this pipes them to your engine's stdin and pipes back what your engine
printed. Before running it, four greps tell you everything it does:

    grep -n subprocess      one Popen, argv exactly what you typed after --
    grep -n 'wss\\?://'      one destination, the `server` value below
    grep -n "open("         two files: rpsbot.conf, and your icon read as bytes
    grep -nE 'eval|exec|pickle|os.system|shell=True'      no matches

The engine command is never saved, so the config file cannot contain
anything that runs. The one path it does hold is your icon, which is read
as bytes, size-checked, and sent. See docs/rpsi.md for the protocol your
engine speaks.
"""

import argparse
import base64
import configparser
import json
import os
import queue
import signal
import subprocess
import sys
import threading
import time

from websockets.sync.client import connect

CLIENT_VERSION = "1.2"
DEFAULT_SERVER = "wss://api-rps.henhen1227.com/ws"
CONFIG_PATH = "rpsbot.conf"

# What the website will accept as a bot's picture. Checked here as well as
# there so a wrong file is named on your own terminal, next to its path,
# rather than coming back as a remark from a server.
PNG_MAGIC = b"\x89PNG\r\n\x1a\n"
ICON_PIXELS = 128
MAX_ICON_BYTES = 64 * 1024

# The one line an engine can print to take itself out of play. Everything else
# it writes is protocol or diagnostics; this is the only word this script acts
# on rather than forwards. See docs/rpsi.md.
ENGINE_SHUTDOWN = "shutdown"


class GracefulExit(Exception):
    """The server has told us there is nothing left to finish.

    Distinct from every other way out of serve(), because it is the one that
    must not reconnect: the retry loop exists for a server that went away, and
    coming back after a shutdown would undo the shutdown.
    """


def ask(prompt, default=None):
    answer = input(f"{prompt}: " if default is None else f"{prompt} [{default}]: ").strip()
    return answer or default or ""


def ask_yes(prompt, default=True):
    answer = input(f"{prompt} [{'Y/n' if default else 'y/N'}] ").strip().lower()
    return default if not answer else answer.startswith("y")


def configure(path, server):
    """Ask the six questions and write them down."""
    print("Setting up a new bot. Answers are saved to", path, flush=True)
    config = configparser.ConfigParser()
    config["bot"] = {
        "name": ask("Bot name"),
        # Asked here, and checked here, because a path typed at a prompt is
        # where a typo goes — better to hear about it now than to wonder later
        # why the website is still showing two letters on a coloured square.
        "icon": ask("Icon: a square PNG up to 128x128, or blank for none", ""),
        "public_play": "yes" if ask_yes("Let other players challenge this bot?") else "no",
        "tournaments": "yes" if ask_yes("Enter tournaments automatically?") else "no",
        "token": ask("Paste your bot token (from your account page)"),
        # Asked rather than assumed: someone running a server of their own gets
        # a baffling error otherwise, because the default is the public one.
        "server": ask("Server", server),
    }
    with open(path, "w", encoding="utf-8") as handle:
        config.write(handle)
    os.chmod(path, 0o600)
    print(f"Saved {path}.", flush=True)
    read_icon(config["bot"]["icon"])
    return config["bot"]


def load(path, reconfigure, server):
    config = configparser.ConfigParser()
    if reconfigure or not config.read(path) or "bot" not in config:
        return configure(path, server)
    return config["bot"]


def read_icon(path):
    """The icon to send, base64, or None to leave the server's copy alone.

    Three answers, because the server distinguishes three cases. An empty
    string means "no icon", which takes down whatever it is showing. None
    means "do not touch it", which is what an unreadable file has to mean:
    running from the wrong directory should not wipe your bot's picture off
    the website until you notice.
    """
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

    def __init__(self, argv, on_shutdown=None):
        self.argv = argv
        self.on_shutdown = on_shutdown
        self.process = subprocess.Popen(
            argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, text=True, bufsize=1,
        )
        self.lines = queue.Queue()
        # Two drains. stdout feeds the queue; stderr goes to our own stderr so
        # a chatty engine can never fill a pipe buffer and deadlock itself.
        self._pump(self.process.stdout, self._read)
        self._pump(self.process.stderr, lambda line: sys.stderr.write(f"[engine] {line}"))

    def _read(self, line):
        """Queue a line for the exchange, unless it is one meant for us.

        Watched here rather than inside exchange() because an idle engine is
        not in an exchange: nothing is asked of a bot with no game, so a
        `shutdown` printed then would sit unread until somebody challenged it —
        which is the one moment it was trying to avoid.
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
            # Bound the memory an engine that prints forever can cost us. The
            # newest lines are the interesting ones, so drop from the front.
            del collected[:-64]

    def close(self):
        try:
            self.process.terminate()
            self.process.wait(timeout=5)
        except Exception:
            self.process.kill()


def serve(settings, argv, stopping):
    """One connection: hand every frame to the engine, send back its answer.

    The engine is not started until the server has accepted us, so an out-of-date
    client says so and stops rather than launching a process it cannot use.

    `stopping` is the shared flag the signal handler sets, so that a Ctrl-C
    arriving between two connections is still remembered by the next one.
    """
    engine = None
    try:
        with connect(settings["server"], max_size=None) as socket:

            def request_drain(reason):
                """Ask the server to take this bot out of play.

                Sent rather than acted on locally, because only the server knows
                what this bot still owes — a game on the board, half a pair of a
                series, four matches of a round robin. It answers with
                bot_draining now and bot_shutdown when there is nothing left.

                Sends are safe from any thread: websockets' threading client
                holds a mutex across one, which is what lets the engine watcher
                and a signal handler both reach it.
                """
                try:
                    socket.send(json.dumps(
                        {"type": "bot_drain", "exit": True, "reason": reason}
                    ))
                except Exception as error:
                    print(f"could not ask the server to shut down: {error}",
                          file=sys.stderr, flush=True)

            stopping.send = request_drain
            if stopping.requested:
                # A drain asked for on a socket that has since dropped. Ask
                # again rather than quietly coming back as an available bot:
                # the request lived on that connection and died with it.
                request_drain("the client")
            registration = {
                "type": "authenticate_bot",
                "clientVersion": CLIENT_VERSION,
                "token": settings["token"],
                "name": settings["name"],
                "publicPlay": settings.getboolean("public_play", True),
                "enterTournaments": settings.getboolean("tournaments", True),
            }
            # Read every connect, so replacing the file and restarting is all
            # it takes to change the picture. Omitted entirely when it could
            # not be read: see read_icon.
            icon = read_icon(settings.get("icon", ""))
            if icon is not None:
                registration["icon"] = icon
            socket.send(json.dumps(registration))
            for raw in socket:
                message = json.loads(raw)
                kind = message.get("type")
                if kind == "bot_ready":
                    print(f"{message.get('name')} is online. Waiting for a game.", flush=True)
                    warning = message.get("iconWarning")
                    if warning:
                        print(f"  icon: {warning}", file=sys.stderr, flush=True)
                    update = message.get("clientUpdate")
                    if update:
                        print(
                            f"\n  A newer rpsbot.py is available (you have {CLIENT_VERSION},"
                            f" latest is {update.get('version')}).\n"
                            f"  Download it from {update.get('url')}\n",
                            file=sys.stderr, flush=True,
                        )
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
                    print(message.get("message", "shutting down"), flush=True)
                    continue
                if kind == "bot_shutdown":
                    raise GracefulExit(message.get("message", "shutting down"))
                if kind == "bot_rejected":
                    raise SystemExit(f"server refused this bot: {message.get('message')}")
                if kind != "engine":
                    continue
                # First frame the server sends is the engine handshake, so this
                # is where the subprocess is actually needed.
                engine = engine or Engine(argv, on_shutdown=lambda reason: request_drain(
                    f"the engine ({reason})" if reason else "the engine"
                ))

                reply = {"type": "engine_reply", "gameId": message.get("gameId"),
                         "seq": message.get("seq")}
                try:
                    reply["lines"] = engine.exchange(
                        message["lines"], message["expect"],
                        message.get("timeoutMs", 30000) / 1000,
                    )
                except (queue.Empty, BrokenPipeError, OSError) as error:
                    # A timed-out engine may still be about to print, which
                    # would poison the next exchange. Restarting makes that
                    # unrepresentable instead of something to reason about.
                    reply = {"type": "engine_error", "gameId": message.get("gameId"),
                             "seq": message.get("seq"),
                             "reason": "timeout" if isinstance(error, queue.Empty) else "crashed"}
                    on_shutdown = engine.on_shutdown
                    engine.close()
                    engine = Engine(argv, on_shutdown=on_shutdown)
                socket.send(json.dumps(reply))
    finally:
        stopping.send = None
        if engine:
            engine.close()


class Stopping:
    """Whether a graceful shutdown has been asked for on this machine.

    One object shared across reconnects, because a Ctrl-C is interesting in
    both of the states this script has. Connected, it is a request to drain,
    and `send` is how to make it. Between sockets there is nobody to ask, and
    `requested` is what carries the intent to the connection after this one.
    """

    def __init__(self):
        self.requested = False
        # The live connection's drain sender, or None between connections.
        self.send = None

    def request(self):
        """Ask for a graceful shutdown. False when there is nobody to ask."""
        self.requested = True
        sender = self.send
        if sender is None:
            return False
        sender("the client")
        return True


def install_signal_handlers(stopping):
    """Turn Ctrl-C and SIGTERM into a graceful shutdown.

    The first one asks and keeps playing; the second one goes now. That order
    is the point: the default for both signals is to die immediately, which
    abandons the game on the board and hands the opponent a win nobody played
    for. Somebody who genuinely wants that can still have it by pressing again.

    With no connection there is nothing to be graceful towards — the server
    stopped hearing from this bot when the socket went — so a signal then is
    simply a stop.
    """

    def handle(signum, frame):
        if not stopping.requested and stopping.request():
            print("\n  Shutting down gracefully: no new games, finishing what is owed."
                  "\n  Press Ctrl-C again to stop now and abandon the game on the board.\n",
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

    stopping = Stopping()
    install_signal_handlers(stopping)

    delay = 1
    # The KeyboardInterrupt is caught out here rather than around serve(),
    # because the reconnect backoff below is exactly where somebody gives up
    # waiting and presses Ctrl-C, and a traceback is not an answer to that.
    try:
        while True:
            try:
                serve(settings, argv, stopping)
                delay = 1
            except GracefulExit as done:
                print(done, flush=True)
                return
            except SystemExit:
                raise
            except Exception as error:
                print(f"disconnected ({error}); retrying in {delay}s", file=sys.stderr)
            time.sleep(delay)
            delay = min(delay * 2, 30)
    except KeyboardInterrupt:
        return


if __name__ == "__main__":
    main()
