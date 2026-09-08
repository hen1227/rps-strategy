# Privacy Policy & Online Play Agreement

*Last updated: August 22, 2026*

RPS Strategy is a small game run by one person (Henry, `@henhen1227`) on his own
hardware, mostly for friends. This page is the short, honest version of what
gets stored and how to behave. The same text is in the app under
**Privacy & Play**.

## The short version

**Every online game you play is recorded and kept, tied to your account.** Play
nice, play your own games, and don't cheat.

## What I store

**Your account** — a random account ID your browser generates, your username,
and a SHA-256 hash of your local account key. Never the key itself.

**From Discord, once you sign in with it** — your Discord user ID and your
Discord handle, as Discord reports them. Nothing else: the sign-in asks Discord
only for `identify`, which is your account's name and id, so I never see your
email address, your servers, or anything you do on Discord. The permission that
grants this is one you can withdraw at any time from Discord's own settings,
under Authorised Apps.

**A password, if your account predates Discord sign-in** — a salted PBKDF2 hash
of it, never the password itself. No new account can be created with a password,
and the hash is deleted the moment you link a Discord account.

**Every finished online game, kept indefinitely and linked to both players** —
who played, the game mode, who won, how it ended (resign, timeout, abandonment,
draw, and so on), whether it was ranked, both ratings before and after, the
number of moves, the time control, and when it started and finished.

**Your totals** — wins, losses, draws, games played, and a separate Elo rating
per game mode.

**Tournaments** — your entry name, Discord handle, your matches, and their
results.

## What other players can see

Your username, Discord handle, rating, and record are shown to your
opponent during a game and in the lobby's live-game list. **Any player can
spectate a live game**, including yours.

In-game chat is **not filtered or moderated**. Your opponent and every spectator
can read it. Chat lives in the server's memory for the length of the game and is
not written to the database — but assume anyone in the room can screenshot it.

## What I don't do

No ads, no analytics SDKs, no trackers, and I don't sell or share any of this.
I'm the only person with access to the database. Ordinary web-server logs record
IP addresses so the server can be operated and debugged; they aren't part of
your game record.

## Deleting your data

Message me and I'll delete your account and profile. Finished games involve
another player, so I may keep the bare result with your name removed — otherwise
your opponents' histories and ratings would break.

Clearing this site's browser data also throws away your local account key. If
you have an account, signing in with Discord gets you back in; if you have not,
that key was the only way back, and clearing it means a new account.

## The play agreement

By playing online, you agree to:

- **Be nice.** No harassment, slurs, threats, or bigotry — in chat, usernames,
  or Discord handles.
- **Play your own games.** No engines, bots, or outside help during a live game.
  The RPSFish analysis board is for before and after, not during.
- **Don't rig results.** No throwing games to farm ratings, no sandbagging, no
  alt accounts to dodge opponents or inflate your own Elo.
- **Don't stall.** Don't sit on the clock to burn your opponent out, and don't
  disappear mid-game to avoid a loss.
- **Don't attack the server.** No exploiting bugs for advantage, scraping, or
  flooding. If you find a bug, tell me — I'd rather hear it from you.
- **Accept the consequences.** I may void a game, reset a rating, or remove an
  account over any of the above. There's no formal appeal process; just message
  me and we'll sort it out like people.

## Changes

I'll edit this page when something changes and bump the date at the top. If you
keep playing, that's your agreement to the current version.

Questions, deletion requests, or bug reports: Discord `@henhen1227`.
