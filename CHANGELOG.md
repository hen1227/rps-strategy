# What's New

## v0.10.1 — unreleased

## v0.10.0 — 2026-10-18

- Learn Intransitive in four moves: short lessons on a real board, then a first game against Pebble. They open by themselves on your first visit, and from How to play after that.
- Signing in has a page of its own. When your Discord or Apple ID is new here, it asks whether you already play: make an account, or sign in the other way and both open the same account.
- After signing in you see every way into your account, with a button to add Discord or Apple. Your account page shows the same list near the top.
- A Sign in button on another page, such as a tournament's entry form, brings you back to that page afterwards.
- The first time you chat, choose a username, post feedback or name an opening, you're asked to agree to the community rules.
- Deleting your account turns off its match alerts on every device.
- The privacy policy now says what match alerts store, and that a report keeps the conversation around it.
- The site and apps count visits and games with Google Analytics, without names. In Europe you're asked first, and anyone can turn it off under Your account.
- A tidier analysis board on phones: Undo, Redo and Reset sit under the board, the coach shows how deep the engine has looked in its corner, and the board's tools share one grid.
- Playing an analysis position against a bot or with a friend now has a way back to the analysis board, with your line still there.
- The analysis board no longer jumps around while the engine is thinking.
- A dragged piece now glides to its square from where you let go, instead of jumping back to where it started first.
- The lobby only says it will call an away player back when they have match alerts on.
- Fixed match alerts not arriving when you left the app just after turning them on, or after your connection dropped and came back.
- Fixed Send a test sometimes switching match alerts off when pressed just after turning them on.
- The analysis board grows to fill a tall screen, such as an iPad or a large monitor, and its move list now runs to the bottom of the screen instead of stopping at the board's edge.
- Fixed the tournament page on iPad, where the player spotlight and match center ran off the right side of the screen.
- Live games, games you watch and game reviews fill a tall screen too: the board grows, and the moves and chat beside it reach the bottom of the screen.
- Fixed the Create a challenge panel on iPad, where the game preview ran off the right side of the screen.
- Fixed the scoreboard at the top of a bot series you watch on iPad, which was hidden under the Next game button.
- Fixed a game review on iPad pushing the chat's message box off the bottom of the screen while its series was still being played.
- A game review's Game record card puts its buttons under the text when space is short, instead of squeezing the text to a word per line.
- Watching two bots fight fills a tall screen too: the board grows, and the move list beside it reaches the bottom of the screen.
- Fixed watching two bots fight on an 11-inch iPad, where the buttons for stepping through the moves were below the bottom of the screen. A short browser window cut them off too.
- Fixed the move list beside a bot fight running past the bottom of the screen on iPad.
- Fixed going back from an analysis board opened from the menu: it now returns to the lobby underneath instead of sliding a new lobby in on top.
- If a second sign-in can't be linked straight away, the sign-in screen now says which button links it instead of showing an error code.
- Signed out, a game you set up in the lobby says Casual instead of Rated, which is what it plays as.
- Shorter, plainer text across the lobby, Bots, Leaderboard, Hourly Rounds, Weekend Arena, Tournaments, Credits and your account, with section labels that match from page to page.
- Your game history has one Review button per game. Copy a game's link from its review.
- On phones, a row of page links that doesn't fit on one line splits into even rows instead of leaving one link on a line by itself.
- Appearance choices and Weekend Arena time slots fill the width of their panel.
- Tabs that stretch across a row, such as the opening book's modes, now show which one is selected.
- The opening explorer's board is centred on an iPad held upright, and an empty opening book no longer squeezes its title into a narrow column on phones.
- Fixed "1 rounds", "1 moves" and "1 ROUNDS RUN", Hourly Rounds saying no engines were entered right above a line saying five were, and the tournament spotlight's win rate breaking onto two lines on iPad.
- A capture now plays out as its throw: rock smashes scissors, scissors snip paper, and paper wraps rock. Reduce Motion turns it off.
- Fixed captures playing the wrong sound: rock taking scissors sounded like paper taking rock.
- A dragged piece keeps its size instead of growing and shrinking as it moves.
- Fixed a piece sometimes vanishing for a moment as it set off on a move, mostly on phones.
- Fixed move and capture sounds going silent every other time on iPhone and iPad.

## v0.9.3 — 2026-10-09

- Ratings are rebuilt for players and bots alike: a new rating starts at 1150, climbs as you play, and has no ceiling.
- Every past ranked game has been re-scored, so leaderboards, profiles and game records all show the new numbers.
- Fixed the leaderboards showing nearly every bot and player at 1 or as "Not enough data to rank".
- A rating is marked provisional for roughly its first dozen ranked games, and drifts down slowly while you are away.
- Leaderboards list only players and bots with a ranked game in the mode.
- Matchmaking pairs a new player with players of average strength rather than with the lowest-rated ones.
- Rating titles are earned at 1600, 1800, 2000 and 2200.

## v0.9.2

- The Play page leads with Intransitive, the main game; Total War and Infiltration are listed below it under More modes.
- The Bots page's practice panel leads with Intransitive too, with smaller Total War and Infiltration buttons under it.
- Open games and challenges sent to you are near the top of the Play page, in a row that stays put when a new one arrives instead of pushing the page down.
- A cleaner look: cards stand out from the page, buttons and tags share one style, green is kept for the buttons that start something, and faint text is easier to read.
- Board pictures on the Play page and in the Right now panel use softer colours. The board you play on is unchanged.
- On the website, sidebar links and buttons light up under the pointer.
- Tournaments lead with larger standings and player performance, with filters for live matches, results, and rounds.
- Watching a bot series on a wide screen, the series scoreboard sits in the header beside the game's name, so the board is bigger.
- Fixed the Link Discord button spilling out of its card on the Account screen.
- Your account page shows a dash instead of a rating until you have played enough ranked games to be rated.
- Hourly rounds pause for the arena; entrants can't join series.
- Players level on points share their place in tournament standings, and a tie for first names every winner.
- Fixed a drawn knockout final awarding the tournament title to both finalists, not just the one who goes through.
- The Weekend Bot Arena plays seven rounds when its field is too big for everybody to meet, up from four or five.
- Fixed the Weekend Bot Arena giving up on bots that were busy playing their other arena matches. When everybody played everybody, the arena ended after the first round and scored the rest as no-shows.
- Admins can run ranked bot series, and can switch a finished bot game or series between ranked and casual.
- A bot series' page says whether its games were ranked or casual.
- On the Bots page, choose Ranked or Casual for any bot series. Ranked works with any two bots, or one bot against a random opponent; casual never changes a rating.
- Ranked bot matches, PLAY NOW included, always play both games; only an admin can stop one once it starts.
- Recent runs show whether each series was ranked or casual, and how it was paired: hourly round, random opponent, chosen matchup, tournament or Weekend Arena.
- Live bot series in the Right now panel show whether they are ranked.
- Fixed the side picker saying Red moves first. Blue does.
- A pasted game record with no starting position now opens on its own mode's board. Intransitive records used to be refused.
- Fixed the example game on the Records and notation page, whose final position did not match its moves, and the example move list on the engine protocol page, which left most legal moves out.
- Fixed match alerts going to your guest account instead of you after you sign in on the same device.
- Fixed a search staying open after you closed the tab or app when notifications were switched off in your settings. The game it found would never reach you.
- Send a test says when nothing was sent, instead of reporting a refused notification as delivered.
- You can sign in with Apple, and link Apple and Discord to one account from the Account screen.
- Accounts that sign in with Apple can post on the feedback board. Tournaments still need Discord.
- Fixed a phone staying signed in to your account after you signed out.
- Fixed sign-in on a phone spinning forever when it could not finish.


## v0.9.1

- On the website, the sidebar links to the iOS beta on TestFlight and to the source code on GitHub.
- On a phone, the move list fills the width of the screen and no longer runs off the edge while you look back through a game.
- Player bars no longer show Discord names, and on a phone the pieces a player has taken sit under their name.


## v0.9.0 — Initial release of the project

- The entire state of the project up to this point.
