#!/usr/bin/env python3
# SPDX-FileCopyrightText: 2026 Henhen1227, LLC
# SPDX-License-Identifier: MIT
#
# MIT, unlike the AGPL-3.0 the rest of RPS Strategy is under, so you can copy
# or change this file for your own bot and license the result however you
# like. The licence text is at https://opensource.org/license/mit.
"""The anchor. Every rating in this game is a distance from this engine.

It plays a uniformly random legal move and looks at nothing else. That is the
definition of rating 1 -- "no better than chance" -- and it is the reason this
particular engine, rather than any of the stronger yardsticks beside it, is the
one the scale is pinned to: it is the only engine whose description does not rot.
A greedy bot is "greedy under the rules of September 2026". Chance is chance.

    ***  DO NOT CHANGE THE BEHAVIOUR OF THIS FILE.  ***

Not to make it stronger, not to make it smarter about a mode, not to break ties
differently. Every published rating on the server is measured through it, so a
change here silently restates the whole board -- and unlike a rules change,
nothing else would look wrong afterwards. If you need a different reference
engine, add one as a new yardstick with a new name and leave this one alone.

Two properties are load-bearing and easy to lose by accident:

  * Uniform over the legal moves the server sent. Not over squares, not over
    pieces, not weighted by anything. `random.choice` on the server's own list
    is the whole algorithm, and it means this engine needs no rules knowledge
    and therefore cannot fall behind a rules change.

  * Every mode, unconditionally. The anchor has to be available in any mode the
    ladder rates, or that mode has no scale. Modes are declared from the list
    the server hands over at handshake rather than hard-coded, so a new mode is
    anchored the day it ships.

Run it the way any other engine is run:

    python3 rpsbot.py --config yardstick_random.conf -- python3 yardstick_random.py
"""
import random
import sys

MODES = ("V3", "V5", "V6")

moves = []
for line in sys.stdin:
    word = line.split()
    if not word:
        continue
    if word[0] == "rpsi":
        print("id name Yardstick\nid author rps-strategy", flush=True)
        print("protocol 1", flush=True)
        for mode in MODES:
            print("mode " + mode, flush=True)
        print("rpsiok", flush=True)
    elif word[0] == "isready":
        print("readyok", flush=True)
    elif word[0] == "legalmoves":
        moves = word[1:]
    elif word[0] == "go":
        # No search, no evaluation, no clock. A yardstick that thought about the
        # position would be a yardstick that got slower on a busy server, and an
        # anchor whose strength depended on server load is not an anchor.
        print("bestmove " + random.choice(moves), flush=True)
    elif word[0] == "quit":
        break
