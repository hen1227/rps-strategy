#!/usr/bin/env python3
"""A complete, legal RPS Strategy bot. It picks at random and never looks
at the board -- the server sends the legal moves, so it does not need to."""
import random, sys

moves = []
for line in sys.stdin:
    word = line.split()
    if not word:
        continue
    if word[0] == "rpsi":
        print("id name Dice\nid author example\nprotocol 1\nmode V3\nmode V5\nrpsiok", flush=True)
    elif word[0] == "isready":
        print("readyok", flush=True)
    elif word[0] == "legalmoves":
        moves = word[1:]
    elif word[0] == "go":
        print("bestmove " + random.choice(moves), flush=True)
    elif word[0] == "quit":
        break
