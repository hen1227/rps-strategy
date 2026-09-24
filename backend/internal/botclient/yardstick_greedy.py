#!/usr/bin/env python3
"""The first rung above chance: take a piece when one is there to take.

This is the second fixed point of the published scale. The anchor beside it --
yardstick_random.py -- is the definition of rating 1, and the gap from there to
a real engine is too wide for a game to measure in one step: a strong engine
beats a random mover essentially always, and a matchup nobody can lose carries
no information. This engine sits in that gap, close enough to chance to lose to
it occasionally and close enough to a first submission to be a real test of one.

    ***  DO NOT CHANGE THE BEHAVIOUR OF THIS FILE.  ***

Every rating measured through this rung moves if it does. The anchor's file says
the same thing and means it more strongly, because chance is chance and this is
"greedy under the rules of September 2026" -- but the practical rule here is the
same one: if you want a different reference engine, add a slot and leave this
one alone. See benchmarks.go for how the slots are declared and how a
declaration is corrected when a rung turns out not to be worth what it says.

# The algorithm, in one sentence

Among the legal moves the server sent, play one that lands on an occupied
square; if none does, play at random.

That is the whole of it, and the thing that makes it cheap to be sure about is a
rule the server enforces rather than anything decided here: a move onto an
occupied square is only legal when the mover beats what is standing there, and a
move onto your own piece is never legal. So *every* legal move onto an occupied
square is a capture this side wins. This engine never has to know the capture
cycle, never has to work out who would survive, and cannot fall out of step with
a change to either.

It does need to know where the pieces are, which the anchor does not, and that
is the one piece of rules knowledge here. The host sends the position the game
began from plus every move since, so the board is rebuilt by replaying them --
and replaying a move is "put the mover on the destination, empty the square it
left", which is what every mode does and the only thing any of them does.

# Reading a position

Three space-separated fields: pieces, side to move, territory. Rows run rank 1
to rank 9 separated by `/`, digits count consecutive empty tiles, uppercase is
Blue and lowercase is Red. Territory is only used by Total War and is ignored
here -- a capture is a capture in all three modes.

Run it the way any other engine is run:

    python3 rpsbot.py --config yardstick_greedy.conf -- python3 yardstick_greedy.py
"""
import random
import re
import sys

MODES = ("V3", "V5", "V6")

# A move is two squares with a separator between them. `-` and `x` mean the same
# thing and a leading piece letter is allowed, so the squares are picked out
# rather than the string being split: `d3-d4`, `d3xd4` and `Rd3xd4` are one move
# spelled three ways, and an engine that read anything into the difference would
# be reading something the protocol says is not there.
MOVE = re.compile(r"([a-i][1-9])[-x]([a-i][1-9])")


def square(file_index, rank_index):
    """The name of a square, from its two zero-based indices."""
    return chr(ord("a") + file_index) + str(rank_index + 1)


def read_pieces(field):
    """The occupied squares of a pieces field, as {square: piece letter}."""
    board = {}
    for rank_index, row in enumerate(field.split("/")):
        file_index = 0
        for character in row:
            if character.isdigit():
                file_index += int(character)
            else:
                board[square(file_index, rank_index)] = character
                file_index += 1
    return board


def replay(board, move):
    """Apply one move: the mover lands, and whatever was there is gone.

    No capture resolution, because there is none to do. The server only ever
    sends legal moves, and a legal move onto an occupied square has already been
    decided in the mover's favour.
    """
    found = MOVE.search(move)
    if not found:
        return
    start, end = found.group(1), found.group(2)
    piece = board.pop(start, None)
    if piece is None:
        # A move from an empty square means this engine's picture of the board
        # has drifted from the server's. Dropping the destination keeps the two
        # from disagreeing about a piece that is not there; the next `position`
        # rebuilds from scratch anyway, so a bad frame costs one move and not
        # the game.
        board.pop(end, None)
        return
    board[end] = piece


def read_position(words):
    """Rebuild the board from `position fen <pieces> <side> <territory> [moves …]`."""
    fields = []
    moves = []
    reading_moves = False
    for word in words[1:]:
        if word == "fen":
            continue
        if word == "moves":
            reading_moves = True
            continue
        if reading_moves:
            moves.append(word)
        else:
            fields.append(word)
    if not fields:
        return {}
    board = read_pieces(fields[0])
    for move in moves:
        replay(board, move)
    return board


def choose(board, moves):
    """A capture if there is one, otherwise a move at random.

    Uniform among the captures rather than picking the first, and uniform among
    the rest when there are none. Every piece is worth the same in this game, so
    there is nothing to prefer between two captures -- and a yardstick that broke
    the tie by move order would be a yardstick whose strength depended on the
    order the server happens to generate moves in.
    """
    taking = [move for move in moves if MOVE.search(move) and
              MOVE.search(move).group(2) in board]
    return random.choice(taking or moves)


def main():
    board = {}
    moves = []
    for line in sys.stdin:
        word = line.split()
        if not word:
            continue
        if word[0] == "rpsi":
            print("id name Yardstick Greedy\nid author rps-strategy", flush=True)
            print("protocol 1", flush=True)
            for mode in MODES:
                print("mode " + mode, flush=True)
            print("rpsiok", flush=True)
        elif word[0] == "isready":
            print("readyok", flush=True)
        elif word[0] == "newgame":
            board, moves = {}, []
        elif word[0] == "position":
            board = read_position(word)
        elif word[0] == "legalmoves":
            moves = word[1:]
        elif word[0] == "go":
            # No search and no clock, for the reason the anchor gives: a
            # yardstick that thought about the position would get slower on a
            # busy server, and a rung whose strength depends on server load is
            # not a rung.
            if moves:
                print("bestmove " + choose(board, moves), flush=True)
        elif word[0] == "quit":
            break


if __name__ == "__main__":
    main()
