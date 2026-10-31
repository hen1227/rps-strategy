# Store listing — RPS Strategy

Everything App Store Connect and the Google Play Console ask for, written out
ready to paste, plus the answers to the privacy, data-safety and age-rating
questionnaires. Character counts are given as `used/limit` against each field.

---

## At a glance

| | |
| --- | --- |
| App name | RPS Strategy |
| Developer / seller | Henry Abrahamsen (`@henhen1227`) |
| Version / build | 1.0.0. EAS sets the build number (remote, auto-incremented): the next are iOS 6 and Android 3 |
| Price | Free, no in-app purchases, no ads |
| iOS bundle ID | `com.henhen1227.rps-strategy` |
| Android application ID | `com.henhen1227.rpsstrategy` |
| Primary language | English (U.S.) |
| Marketing URL | `https://rps.henhen1227.com` |
| Support URL | `https://henhen1227.com/support` (carries the contact line) |
| Privacy policy URL | `https://rps.henhen1227.com/policy` |
| Copyright | `© 2026 Henhen1227, LLC` |
| Account required | No — an account is created on the device on first launch; signing in with Discord or Apple is optional |
| Reviewer sign-in | One password account per store, made and reset by `deploy/store-review-account.sh`. The credentials live in the two consoles, never in this repository — see [Review accounts](#review-accounts) |
| Works offline | Bots, pass and play, the lessons and the analysis board. Online play needs a connection |

---

## Apple App Store

### App Store Connect fields

**App Name** — 12/30

```
RPS Strategy
```

**Subtitle** — 29/30

```
9x9 rock-paper-scissors chess
```

Alternates, if the primary reads too cute: `Ranked rock-paper-scissors` (26),
`The strategy game, ranked` (25), `Board strategy with an engine` (29).

**Promotional Text** — 134/170 *(editable any time without shipping a build — use it for whatever landed most recently)*

```
New: the opening explorer, built from every game people have actually played. Move pieces on a board and see what the field does next.
```

**Keywords** — 97/100 *(comma-separated, no spaces after commas; do not repeat words already in the name or subtitle — those are indexed separately)*

```
board,tactics,turn based,multiplayer,online,elo,ranked,duel,engine,analysis,openings,1v1,abstract
```

**Description** — 2,114/4,000

```
Rock, paper, scissors is a coin flip. Give each side an army of them on a 9x9 board and it becomes a game you can be good at.

RPS Strategy is a turn-based strategy game. Every piece is a rock, a paper, or a pair of scissors. Pieces move one square in any of the eight directions, and can only capture a neighbour they beat: rock takes scissors, scissors takes paper, paper takes rock. Nothing is hidden. Nothing is random. What you do next is the whole game.

THREE WAYS TO WIN

- Intransitive — race for the corner your opponent's army started in. One square, straight down the diagonal, and they are running at yours.
- Total War — every square you land on turns your colour for good. Take all of their pieces, or own more of the board once no neutral squares are left.
- Infiltration — land any piece on their home row. Every attacker you send is one less defender.

PLAY

- Ranked online matches with real clocks, a separate rating for every mode, and a permanent record of every game you have played.
- Six practice bots, from Pebble to Obsidian, running entirely on your device. No connection needed, and Hint and Undo are there while you learn.
- Two players, one device, for whoever is sitting next to you.
- Post a challenge with your own time control, or watch any live game from the board it is being played on.
- Tournaments, a weekend arena, a leaderboard, and titles to earn.

STUDY

- RPSFish, a real analysis engine, runs on your phone — no server, no account, no queue. Principal variations, best moves drawn on the board, and an evaluation you can step through move by move.
- Review any finished game: every move graded, an evaluation chart across the whole game, and an accuracy percentage for each player.
- An opening explorer built from the games people actually played, keyed to the board in front of you, with the most popular continuations drawn as arrows.

Free, and free of the usual: no ads, nothing to buy.

The games themselves were invented by WebGoatGuy, who has an implementation and a community of his own — both linked from the Credits page inside the app. This is a fan build.
```

**What's New in This Version** — 1.0.0, 191/4,000

```
First release. Three game modes, ranked online play with a rating per mode, six practice bots that run on the device, tournaments, full game review with move grades, and the opening explorer.
```

**Categories**

- Primary: **Games → Board**
- Secondary: **Games → Strategy**

**Other fields**

| Field | Value |
| --- | --- |
| SKU | `RPS-STRATEGY-001` |
| Price | Free (all territories) |
| Availability | All territories |
| Content Rights | Contains third-party content — see [Before you submit](#before-you-submit) |
| Made for Kids | No |
| Uses IDFA | No |
| Third-party analytics | Google Analytics (Measurement Protocol, relayed by our server; no SDK in the app) |

### Export compliance

The app talks to its server over HTTPS and WSS and does nothing else with
cryptography, which is exempt. Add this to the iOS `Info.plist` so App Store
Connect stops asking on every upload:

```xml
<key>ITSAppUsesNonExemptEncryption</key>
<false/>
```

In Expo terms, put it under `ios.infoPlist` in `app.json` so `expo prebuild`
does not drop it.

### App Privacy (the nutrition label)

Answer **No** to tracking across apps and websites. Every item below is
**Linked to the user** and used for **App Functionality** only, except where
noted.

| Data type | What it is | Notes |
| --- | --- | --- |
| Identifiers → User ID | The device-generated account UUID, the username, and once you sign in, the Discord user ID and handle or the identifier Apple makes for this app | Discord is asked only for `identify` and Apple for no scopes, so no name or email address is ever received. Apple's refresh token is kept only to revoke the app's access when the account is deleted |
| Identifiers → Device ID | The APNs push token | Only for accounts that turn match alerts on. Apple's label has no "optional" setting, so the note is for you, not the form |
| Contact Info → Other User Contact Info | A Discord handle: the one Discord vouched for, or one typed on a profile or a tournament entry | The host uses it to reach tournament entrants |
| User Content → Gameplay Content | Finished game records, per-mode ratings, win/loss/draw totals, tournament entries | Apple's own definition of Gameplay Content includes "multiplayer matching or gameplay logic". Use the matching choice on Play (App activity) |
| User Content → Other User Content | In-game chat, feedback posts and replies, bot names, descriptions and pictures, and opening names players publish | Chat is held in server memory for the length of a game, except the recent conversation a report carries, which is stored with the report |
| Diagnostics → Other Diagnostic Data | App version and platform on bug reports, which the feedback board shows with the post | Linked. Purpose: App Functionality |
| Diagnostics → Other Diagnostic Data | IP addresses in ordinary web-server logs | **Not** linked to the user — they are not part of a game record. Purpose: App Functionality |
| Diagnostics → Other Diagnostic Data | Device model and brand, OS version, screen size and language, sent with usage statistics | **Not** linked to the user. Purpose: **Analytics** |
| Usage Data → Product Interaction | Screens opened and actions taken (sign-in, queue, games started and finished with mode and result, challenges, feedback, copied links), sent to Google Analytics | **Not** linked to the user and **not** used for tracking. Purpose: **Analytics**. On by default outside Europe, asked first in the EU/EEA/UK/CH, and switchable under Your account → Usage stats |
| Identifiers → Device ID | A random analytics ID the app makes for itself (not the IDFA or IDFV), deleted when stats are turned off | **Not** linked to the user, **not** tracking. Purpose: **Analytics** |

Not collected: location, health, financial, contacts, browsing
history, search history. Location stays "not collected": the app sends the
phone's *region setting* as a country, never a location, and Google never sees
the phone's IP address because events go through our server. Analytics events
carry no username, account ID or game ID, which is what makes "not linked"
true — keep it that way (see `docs/analytics.md`). Legacy accounts predating Discord sign-in hold a
salted PBKDF2 password hash; no player's new account can have one and the hash
is deleted the moment Discord or Apple is linked. The two store review
accounts have one too, and they are ours rather than any user's. If you want
that on the label, it belongs under Other Data.

### Age rating questionnaire

Apple's current tiers are 4+, 9+, 13+, 16+ and 18+, from a questionnaire that
asks how often (none, infrequent, frequent) for content and yes or no for
capabilities. Checked against Apple's "Age ratings values and definitions" on
2026-10-23.

| Question | Answer |
| --- | --- |
| Cartoon or Fantasy Violence, Realistic Violence, Guns or Other Weapons | None — captures are abstract tokens leaving a grid |
| Sexual Content, Profanity or Crude Humor, Horror, Mature Themes | None |
| Alcohol, Tobacco or Drugs; Medical; Health | None |
| Gambling, Simulated Gambling, Loot Boxes | None. Tournaments have no entry fee and no prizes |
| Contests | **Frequent** — Apple counts events where people "compete for rankings", which is what the ranked ladders, leaderboards, tournaments and weekend arena are. Frequent contests are a 13+ answer |
| Messaging and Chat | **Yes** — chat between the two players and every spectator |
| User-Generated Content | **Yes** — usernames, chat, feedback posts and replies, bot names, descriptions and pictures, and published opening names |
| Social Media | **No** — the feedback board is a support board for bugs and suggestions, not a feed that spreads posts. Answering Yes would not change the rating, which Contests already sets at 13+ |
| Unrestricted Web Access | No — links open outside the app, in the browser, and there is no in-app browsing. A feedback post can carry a link, and it opens in the browser too |
| Advertising | None |
| Parental Controls; Age Assurance (In-App Controls) | No; No |

Expect **13+**, from Contests. Apple asks separately whether the content is
moderated; it is — filter, report, block, and a host who reads the queue. See
[What is already in](#what-is-already-in) for the wording to reuse.

### App Review Information

Contact: Henry Abrahamsen, `support@henhen1227.com`.
Sign-in required: **Yes**. User name and Password are the `apple` review
account's, from [Review accounts](#review-accounts). They go into App Store
Connect and nowhere else.

It used to say No, and that was wrong: signed out, online play is casual only,
and blocking — which guideline 1.2 checks for — says "Sign in to block players."

**Notes for the reviewer** — 2,099/4,000:

```
Sign in with the user name and password above. A new install opens a short lesson first: tap ‹ Lobby at its top left. Then tap the You tab (on a large iPad, Account in the left sidebar), tap "Sign in with a password", the small link under CONTINUE WITH DISCORD and Continue with Apple, enter the details and tap SIGN IN.

Sign in with Apple works too, with your own Apple ID. It asks for no name or email: choose "Create an account", pick a username and agree to the community rules.

Without signing in, every player has an account created on the device. Signing in adds ranked play, blocking and your own bots.

To see a game without waiting for another player:
1. Bots tab, "Play a bot": pick a bot and tap PLAY INTRANSITIVE ▶. The engine runs on the device, offline.
2. Play tab, "Pass and play": tap INTRANSITIVE ▶ for a two-player game on this device.
3. Study tab: Explorer and Analysis Board, in the row at the top, need no opponent.
Ranked online play matches you with whoever is queued, so it may wait.

Moderation: ⋯ beside any chat message that is not yours opens "Report to the host" and "Block". Every player's page has REPORT and BLOCK, a bot's page has REPORT, and so does every feedback post and reply. Blocking needs a signed-in account.

Account deletion: at the bottom of the account page, tap DELETE ACCOUNT, type the name shown and tap DELETE FOR GOOD. With the review account, tap SIGN OUT (in the Online identity panel) first: that deletes the account this device made and keeps the review account working. If you signed in with your own Apple ID, delete while still signed in; that also disconnects the app from your Apple ID.

Linking Discord or Apple is off for the review account so its password keeps working. Tournament entry needs a Discord-verified account, because the host reaches entrants through Discord. Posting on the feedback board (You tab, Feedback) needs Discord or Apple. Both can be browsed without one.

The three modes were invented by the YouTube creator WebGoatGuy. The Credits page (You tab) credits him and links to his implementation and community.
```

The old notes also said Discord "only links" an account for use on another
device. That stopped being true once ranked play and blocking needed a sign-in,
so the claim is gone. Whether what is left is enough for guideline 4.8 is a
decision rather than a fact: see [Before you submit](#before-you-submit).

### Assets

| Asset | Requirement | Status |
| --- | --- | --- |
| App icon | 1024×1024 PNG, no alpha channel, no rounded corners | `frontend/assets/icon.png` is 1024×1024, 8-bit RGB, no alpha — ready to upload as is |
| iPhone 6.9" screenshots | 1260×2736, 1290×2796 or 1320×2868 portrait, 1–10 of them, no alpha | Upload `screenshots/uncaptioned/iphone-6.9`, which is 1320×2868 RGB. The captioned `screenshots/app-store/iphone-6.9` set is 1242×2688 **with an alpha channel**, which App Store Connect refuses: re-render its captions onto the 1320×2868 captures, or flatten it and use it in the 6.5" slot. Apple's spec page now names the 6.3" size (1206×2622) as the required one while saying it scales from the larger sets — if App Store Connect asks for it, capture on the iPhone 17 Pro simulator, which is natively 1206×2622 |
| iPad 13" screenshots | 2064×2752 or 2048×2732 portrait | Required, because the app runs on iPad. `screenshots/app-store/ipad-13` is 2064×2752 RGB and ready |
| App previews | 15–30s video, optional | Skip for 1.0 |

---

## Google Play

### Store listing

**App name** — 12/30

```
RPS Strategy
```

**Short description** — 76/80

```
Rock-paper-scissors on a 9x9 board: ranked online play, bots, real analysis.
```

**Full description** — 2,114/4,000

Use the same text as the Apple **Description** above. Play renders a small
amount of formatting, so the `-` bullets and the capitalised section headings
survive as written. Play has no keywords field — the short and full
descriptions are what gets indexed, which is why both name the modes and the
words people would actually search.

**Release notes** — 191/500

```
First release. Three game modes, ranked online play with a rating per mode, six practice bots that run on the device, tournaments, full game review with move grades, and the opening explorer.
```

### Category and tags

- App category: **Games → Board**
- Tags: up to five, chosen from Play Console's fixed list. Closest matches, in
  order of preference: **Board Games**, **Turn-Based Strategy**, **Strategy**,
  **Multiplayer**, **Abstract Strategy**. Take the nearest available if a name
  has changed.

### Store settings and declarations

| Field | Value |
| --- | --- |
| Contact email | `support@henhen1227.com` |
| Contact website | `https://rps.henhen1227.com` |
| Privacy policy | `https://rps.henhen1227.com/policy` |
| Contains ads | **No** |
| In-app purchases | **No** |
| Target audience | 13+ (see the content rating below) |
| Appeals to children | No |
| News app | No |
| COVID-19 contact tracing | No |
| Government app | No |
| Financial features | None |
| Data deletion | `https://rps.henhen1227.com/delete-account` — the steps, including an email route for an account that can no longer be opened, and what is deleted and kept |
| Advertising ID | **No** — the release manifest has no `AD_ID` permission |

### App access

Answer **All or some functionality in my app is restricted**. Signed out,
online play is casual only, and ranked play, blocking and your own bots need a
sign-in. Add one set of instructions:

| Field | Value |
| --- | --- |
| Name | Review account |
| Username | The `google` review account's, from [Review accounts](#review-accounts) |
| Password | Its password, from the same place. Never written in this file |

**Any other information required to access your app** — 487/500:

```
On first launch, tap ‹ Lobby to leave the lesson. Open the You tab and tap "Sign in with a password", the small link under CONTINUE WITH DISCORD. Signed in, you can play ranked, block players and add bots. Discord linking is off for this account so the password keeps working. Tournament entry and posting feedback need Discord; both can be browsed. To test deletion, tap SIGN OUT first, then DELETE ACCOUNT at the bottom of the account page: type the name shown and tap DELETE FOR GOOD.
```

### Data safety form

**Does your app collect or share any required user data?** Yes, both. **Shared:**
usernames and finished game records, through the public game archive published
daily on Hugging Face (CC0). Play exempts only service providers, legal
requests, transfers the user starts, and fully anonymised data, and a scheduled
public upload of usernames is none of those. Google Analytics receives events as
our service provider, which the form does not count as sharing. All data is
**encrypted in transit** (TLS and WSS). Users **can request that data be
deleted**, and can delete it themselves in the app; the form's URL is
`https://rps.henhen1227.com/delete-account`.

| Data type | Collected | Shared | Required? | Purpose |
| --- | --- | --- | --- | --- |
| Personal info → User IDs | Yes | Yes (archive: usernames) | Required | App functionality, Account management |
| Messages → Other in-app messages | Yes | No | Optional | App functionality |
| App activity → Other actions (game results, ratings, tournament entries) | Yes | Yes (archive: game records) | Required | App functionality |
| App activity → Other user-generated content (feedback posts, bot descriptions, opening names) | Yes | No | Optional | App functionality |
| Device or other IDs | Yes | No | Optional | App functionality (match alerts); Analytics (a random analytics ID) |
| App activity → App interactions | Yes | No | Optional | Analytics |
| App info and performance → Other app performance data | Yes | No | Optional | Analytics (device model and brand, OS and app version, language, screen size) |

"Device or other IDs" is optional only because Firebase is kept from starting
by itself (`frontend/plugins/withFirebaseAutoInitOff.js`). Without that, it
fetches a push token on every first launch, before anybody turns alerts on.

Nothing under Location, Financial info, Health, Photos, Files, Contacts,
Calendar, or Web browsing. There is no crash or analytics SDK in the app:
analytics events go to our server, which forwards them to Google Analytics.
The analytics rows are **optional** because the player can turn them off. Keep the "app activity" choice consistent with
whichever category you picked for game records on Apple's label.

### Content rating questionnaire (IARC)

Category: **Game**. Answer no to violence, sexuality, language, controlled
substances, gambling and simulated gambling — the whole game is abstract tokens
on a grid.

Answer **yes** to:

- **Users can interact** — online multiplayer with chat.
- **Users can share content** — chat text, feedback posts and replies, bot
  names, descriptions and pictures, and published opening names.
- **Does the app share the user's current physical location?** No.
- **Is content moderated?** **Yes.** A server-side word filter refuses slurs and
  strong profanity before anything is posted; every message and every player can
  be reported to the host, who reads the queue and can mute, bar or remove an
  account; and any player can block another. See [What is already
  in](#what-is-already-in).

Expect **Teen** (ESRB) / **PEGI 12** / equivalents, with a "Users Interact"
descriptor.

### Assets

| Asset | Requirement | Status |
| --- | --- | --- |
| App icon | 512×512 32-bit PNG, under 1 MB | `frontend/assets/icon512.png` — 512×512, every pixel opaque, 237 KB. Ready |
| Feature graphic | 1024×500 PNG or JPEG, no alpha | `docs/store-assets/google-play-feature-graphic-v4.png` — 1024×500 RGB, the cleanup of v3. Ready |
| Phone screenshots | 2–8, 9:16 portrait, 1080×1920 or larger | `screenshots/google-play/phone` — seven at 1440×2560 RGB. Ready |
| 7" and 10" tablet screenshots | Optional, but required for the tablet placements and for a "Designed for tablets" badge | `screenshots/google-play/tablet` — seven at 1800×3200 RGB. Ready |
| Promo video | YouTube URL, optional | Skip for 1.0 |

---

## Review accounts

Each store gets a password account of its own for its reviewers. Discord cannot
sign a reviewer in: it asks somebody logging in from a new place to confirm by
email, which a reviewer cannot do. No player can create a password account, so
`deploy/store-review-account.sh` makes these, one per store. The route it calls
ships with the backend, so deploy that first; the script says so if you have
not.

**Before every submission**, reset the store you are submitting to:

```sh
./deploy/store-review-account.sh apple --username <name>    # the first time
./deploy/store-review-account.sh apple                      # every time after
./deploy/store-review-account.sh google --username <name>   # the same for Play
./deploy/store-review-account.sh --list                     # both, changing nothing
```

A reset puts the account back the way the store was told it is: its name,
switched on, every device signed out. It keeps the password, because the store
already has it. It prints a new password only when there is one: the first
time, after a reviewer deleted the account, or with `--new-password`. Paste a
new one into the console before you submit, or the review cannot sign in.

**Where the credentials live.** App Store Connect, the Play Console, and your
password manager. Not in this file, and not anywhere else in this repository,
which is public. That includes the usernames. Sign-in allows eight attempts a
minute per username, but not for these two: their passwords are the reset
script's 79 random bits, so only the limit on the address signing in applies,
and wrong guesses from elsewhere cannot lock a reviewer out. Still pick names
that do not say what they are. Don't reset an account while its review is
running: a reset signs every device out.

**What the accounts can and cannot do.** They sign in like any player, and can
play ranked, block, report and add bots. They cannot link Discord or Apple,
because linking deletes the password and the password is what the store holds.
So tournament entry, which needs Discord, and the feedback board, which needs
Discord or Apple, stay browse-only on the review account, and the notes say so.
An App Store reviewer who signs in with their own Apple ID gets an ordinary
account instead, which can post on the board. They cannot be made
administrators. Deleting one works, as both stores require, and the next reset
makes a new account and prints its password. The notes ask reviewers to try
deletion signed out instead, so it should rarely come to that.

Two accounts rather than one, so that a reviewer at one store deleting theirs
cannot break a review in progress at the other.

---

## Screenshot plan

Delivered 2026-09-29 as seven shots per store size in
`docs/store-assets/screenshots`, whose README lists the captions and which
console field each set goes to. The plan they were made from:

Six shots, in this order, on both stores. The board is the product, so it goes
first and it goes in twice.

1. **A live match mid-game** — full board, both player bars, clocks running,
   captured tallies filled in. Caption: *Rock, paper, scissors, with a board and
   a clock.*
2. **Intransitive with the goal corner lit** — a runner two squares from the
   corner. Caption: *Race for the corner their army started in.*
3. **Total War with territory painted** — both colours well into the middle.
   Caption: *Every square you land on is yours for good.*
4. **The analysis board with arrows and a principal variation** — Caption: *A
   real engine, running on your phone.*
5. **The review screen** — evaluation chart, graded move list, accuracy for both
   players. Caption: *Every move graded. Both accuracies.*
6. **The lobby** — modes, live games, who is online. Caption: *Ranked matches,
   bots, tournaments, and whoever is next to you.*

Capture them from the iOS build rather than the web build, so the status bar and
safe areas are real. `frontend/README.md` has the local-game and bot-game routes
that produce a full board with no second player needed.

---

## What is already in

The four things Apple's guideline 1.2 asks for, plus 5.1.1(v). Written out here
because every one of them is also an answer on a questionnaire below.

**Account deletion, from inside the app.** Account screen, bottom of the page:
**Delete account**. You type your username to confirm and it happens on the
spot — `DELETE /api/accounts/{userId}`, no message to the host and no waiting.
It works for a signed-in account and for a guest, since every browser owns an
account here whether or not it ever signed in. An account that never finished a
game is deleted outright; one that has played, or whose bot ran a series, is
stripped of its name, Discord and Apple links, titles and sign-in, with the name
replaced by "Deleted player" in the game records, inside the stored PGN text,
and in every public export from then on. Files already published are never
rewritten, and the policy says so. Any bots it owns are retired, and the opening
names it published lose its name. What is kept, and why, is said in the
confirmation dialog rather than only in the policy: a game belongs to two
people, and removing one player's copy would rewrite the other's history and
rating.

For the Play Data safety form's account-deletion URL, use
`https://rps.henhen1227.com/delete-account`. It is the policy's deletion section
on a page of its own: the steps in the app and on the web, an email route for an
account that can no longer be opened, and what is deleted and kept. Not
`/account`: on the web that is the browser's own account, which a phone's guest
is not.

**A filter on what gets posted.** Chat messages, usernames, bot names and
descriptions, the names engines give themselves, typed Discord handles,
feedback posts and published opening names all go through
`backend/internal/textfilter`, which refuses slurs and strong profanity
outright — the message is never posted and the sender is told why. A tournament
entry carries the entrant's own username, so it has been through the filter
too. It handles the lazy evasions (spacing, punctuation,
digit substitution, stretched spellings) and is deliberately narrow beyond that:
it catches what is unambiguous and leaves arguments to the report queue. The
term list is `terms.txt` in that package, editable without touching code.

**Reporting.** A `⋯` on every chat message that is not yours, **REPORT** on
every player's and every bot's page, and **REPORT** on every feedback post and
reply that is not yours, which carries the post's text with it. The form's reasons come from the server, and a report from
a chat room carries the surrounding conversation with it — chat is never written
to the database, so a report that only named a message would be about something
that no longer exists by the time it is read. Anyone can file one, signed in or
not. Reports land on **Admin → Reports**, filterable by open / actioned /
dismissed, with a link to the reported player and a count of their other open
reports.

**Blocking.** **BLOCK** on a player's page and in the chat sheet. A blocked
player's messages stop reaching you and yours stop reaching them, in the live
room and in the history handed to anyone joining it; neither of you can
challenge the other by name. Matchmaking can still pair you, which is a
deliberate choice on a site this size and is said plainly in the UI and the
policy. Blocking needs an account, because a guest's list would be thrown away
with the browser key it hangs off. The list is managed at **Account → Blocked
players**, which is the only place to undo one.

**Published contact details.** The Discord link in the sidebar and on the
Credits page, `@henhen1227` inside the report form for anything the queue cannot
handle, and both `support@henhen1227.com` and `@henhen1227` on the policy page.

---

## Before you submit

Account deletion and the guideline 1.2 affordances are done; they are described
under [What is already in](#what-is-already-in) so the questionnaire answers
above can be filled in from it. What is left is order, configuration, and a few
checks only you can make. Rechecked 2026-10-23.

**1. Deploy the backend and the website from the release commit first.** The
app asks the server for what that commit's server answers. Challenge links are
the visible case: an older server answers "unknown message type" while the share
sheet waits for a link. The universal-link files ship with the website
(`npm run deploy`), and the nginx block in `deploy/nginx-rps-well-known.conf`
has to be in place to serve them. Don't deploy while a build is in review: a
drain refuses new games for up to twelve minutes.

**2. Android needs three things the repository cannot hold.** The app is
configured (`com.henhen1227.rpsstrategy`; an application ID may not contain a
hyphen, so it cannot match the iOS bundle ID), and RPSFish runs on it. But:

- **The engine is a build artifact.** Run `npm run build:rpsfish:android` in
  `frontend/` before an EAS build, as `build:rpsfish:ios` is for iOS. The
  libraries are gitignored and travel to EAS by the root `.easignore`.
- **Match alerts need the Firebase project's two halves.** The app's is
  `frontend/google-services.json` (project `rps-strategy-8136a`). It is
  gitignored, because this repository is public, and `frontend/app.config.js`
  names it only when it is there, so it has to be on the machine an EAS build is
  started from. The server's is a service account key from the same project, as
  `RPS_FCM_CREDENTIALS_PATH` (see `backend/README.md`); production reported
  `fcm: true` on 2026-10-21. A wrong project shows only at send time, so press
  SEND A TEST on a real release build.
- **App links need the signing key's fingerprint.** Put the Play App Signing
  key's SHA-256 (Play Console → App integrity → App signing) in
  `frontend/public/.well-known/assetlinks.json` in place of the placeholder, plus
  the EAS upload key's if internal builds should open links too, then deploy the
  website.

`targetSdk` is 36 under Expo 57, which meets Play's rule for new apps since
2026-08-31.

**3. A new personal Play developer account has to run a closed test with 12
testers for 14 days** before it can apply for production access. Start that
clock early; it is the longest lead time on this whole list, and it is not
something a code change can shorten. `eas submit` sends Android builds to the
closed track (`alpha`) as a draft (`frontend/eas.json`), because Play refuses
anything but a draft on an app that has never been published. Roll the draft
out to the testers in the Console. Internal testing does not count toward the
14 days. Once the app has a published release, drop `releaseStatus` if
submissions should go out on their own.

**4. App Store Connect, outside the build.** Declare EU trader status, or the
app is not offered in the EU. Enter the age rating and App Privacy answers
above; both changed on 2026-10-23.

**5. Checks only production can answer.**

- `/api/auth/providers` answers `apple: true`, and the boot log says Apple
  accepts this server's key for `com.henhen1227.rps-strategy`. Without them the
  iPhone shows Discord alone, which is guideline 4.8, and a deleted account's
  Apple token is never revoked.
- `./deploy/store-review-account.sh --list` shows both accounts signing in.
- On a TestFlight build: turn alerts on, wait a minute, press SEND A TEST.
  Device builds hold sandbox tokens, so only TestFlight proves production APNs.
- An Android release build against production: sign in, play a game, press
  SEND A TEST. Cloudflare already refuses Python's default user agent on this
  API, and no Android build has talked to production yet.
- nginx on the server: with Cloudflare in front, `set_real_ip_from` its ranges
  and `real_ip_header CF-Connecting-IP`. Otherwise every sign-in and posting
  limit is shared by everybody behind one Cloudflare edge.
- `support@henhen1227.com` delivers, because the policy and the deletion page
  now give it, and `https://henhen1227.com/support` loads.

**After approval.** Set `IOS_APP_URL` in `frontend/src/navigation/links.ts` to
the App Store address, so the website's button says "Get the iOS app". When a
later server change needs a newer app, set `RPS_MIN_APP_VERSION_IOS` or
`RPS_MIN_APP_VERSION_ANDROID`, and `RPS_IOS_STORE_URL` with it (see
`backend/README.md`): older builds then show an update screen instead of
failing.

Two more worth a decision rather than a fix:

- **Guideline 4.8, login services.** Answered by Sign in with Apple, which
  sits beside Discord on the iPhone as an equal button, asks for no name or
  email, and opens the same account Discord does once the two are linked from
  the Account screen. The App ID needs the Sign in with Apple capability, the
  build needs the `com.apple.developer.applesignin` entitlement (prebuild adds
  it), and the server needs `RPS_APPLE_KEY_PATH`, `RPS_APPLE_KEY_ID` and
  `RPS_APPLE_TEAM_ID` (see `backend/deploy/rps-strategy.env.example`). A server
  that answers without Apple hides the button, which reopens 4.8; one that
  cannot be reached at all leaves both buttons up.
- **The games are someone else's invention.** Intransitive, Total War and
  Infiltration were designed by WebGoatGuy, who has his own implementation at
  `meaf.us/rps2`. The Credits page handles this gracefully in-app, and the
  description above says "This is a fan build" for the same reason. Apple's
  guideline 4.1 (Copycats) and the Content Rights question both live here.
  Getting a line of written permission from him — a Discord message is fine —
  before you submit costs nothing and answers the only question a reviewer could
  reasonably ask.

Cleared already, worth knowing:

- The iPad app rotates and multitasks. `orientation` is `portrait`, but prebuild
  declares all four orientations on iPad and `UIRequiresFullScreen` false, so
  the upload passes the multitasking check. Landscape and Split View were
  checked on simulators on 2026-10-17; look once on a device.
- The nine Chess.com sound files are gone. `frontend/assets/sounds/` is
  self-authored, so there is no third-party audio in the bundle. `MIGRATION.md`
  §2.4 has the history.
- No microphone purpose string is needed: expo-audio's plugin is not applied and
  the app only plays sound. If Apple ever emails ITMS-90683 about the
  microphone, add the plugin with a truthful `microphonePermission` and
  `enableBackgroundPlayback: false`, never the bare plugin, whose defaults add
  background audio.
- Keep `eas.json` on its default iOS image (Xcode 26 for SDK 57). EAS's
  `latest` is Xcode 27, and apps built with that SDK need UIScene support that
  this one does not have.

---

## Not doing yet

- **Localization.** English only for 1.0. The description is the only long
  string, so adding a language later is cheap.
- **App previews / promo video.** Screenshots carry a board game fine.
- **A Play Store pre-registration or Apple pre-order.** Neither helps an app
  with no marketing behind it.
