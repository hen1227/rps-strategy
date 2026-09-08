#!bash

# See start-rps-fish.sh for what --book does. Drop it here if you want ALTFish
# kept as a bookless control to measure the book against.
cd /Users/henry/RockPaperScissors && python3 ./backend/internal/botclient/rpsbot.py --config altbot.conf -- ./RPSFish/target/release/rpsfish rpsi --hash-mb 512 --book ./RPSFish/book
