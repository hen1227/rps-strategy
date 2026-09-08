#!bash

# --book points at the directory scripts/build_books.sh writes, which holds one
# book per mode by wire code. A mode with no book there -- or a book built under
# other evaluation weights -- is searched exactly as before, with the reason on
# an `info string`, so this flag is safe to leave on while a book is rebuilding.
cd /Users/henry/RockPaperScissors && python3 ./backend/internal/botclient/rpsbot.py -- ./RPSFish/target/release/rpsfish rpsi --hash-mb 512 --book ./RPSFish/book
