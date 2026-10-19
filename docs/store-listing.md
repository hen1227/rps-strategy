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
| Version / build | 1.0.0 (1) |
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
| Works offline | Bots, local two-player games, the analysis board. Online play needs a connection |

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
| Identifiers → Device ID | The APNs push token | Only for accounts that turn match alerts on — mark as optional |
| User Content → Other User Content | In-game chat, and opening names players publish | Chat is held in server memory for the length of the game and never written to the database. It is still collected, so it is still declared |
| Other Data | Finished game records, per-mode ratings, win/loss/draw totals, tournament entries | Product Interaction under Usage Data is the other defensible home for this. Pick one and use the same choice on Play |
| Diagnostics → Other Diagnostic Data | IP addresses in ordinary web-server logs | **Not** linked to the user — they are not part of a game record. Purpose: App Functionality |
| Usage Data → Product Interaction | Screens opened and actions taken (sign-in, queue, games started and finished with mode and result, challenges, feedback, copied links), sent to Google Analytics | **Not** linked to the user and **not** used for tracking. Purpose: **Analytics**. Optional: on by default outside Europe, asked first in the EU/EEA/UK/CH, and switchable under Your account → Usage stats |
| Identifiers → Device ID | A random analytics ID the app makes for itself (not the IDFA or IDFV), deleted when stats are turned off | **Not** linked to the user, **not** tracking. Purpose: **Analytics** |

Not collected: contact info, location, health, financial, contacts, browsing
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

Apple's current tiers are 4+, 9+, 13+, 16+ and 18+.

| Question | Answer |
| --- | --- |
| Cartoon or Fantasy Violence | None — captures are abstract tokens leaving a grid |
| Realistic Violence, Sexual Content, Profanity, Horror | None |
| Alcohol, Tobacco, Drugs; Gambling | None. Tournaments have no entry fee and no prizes |
| Contests | None |
| Unrestricted Web Access | No — outbound links go to fixed URLs (YouTube, Discord, `meaf.us`) |
| In-app messaging or chat | **Yes** — chat between the two players and every spectator |
| User-generated content | **Yes** — usernames, chat, bot descriptions, and published opening names |
| Advertisements | None |

Answered honestly, the chat and UGC capabilities put this at **13+ or higher**.
Apple asks separately whether the content is moderated; it is — filter, report,
block, and a host who reads the queue. See [What is already
in](#what-is-already-in) for the wording to reuse.

### App Review Information

Contact: Henry Abrahamsen, `support@henhen1227.com`.
Sign-in required: **Yes**. User name and Password are the `apple` review
account's, from [Review accounts](#review-accounts). They go into App Store
Connect and nowhere else.

It used to say No, and that was wrong: signed out, online play is casual only,
and blocking — which guideline 1.2 checks for — says "Sign in to block players."

**Notes for the reviewer** — 1,891/4,000:

```
Sign in with the user name and password above. Tap the You tab to open the Account screen, then tap "Sign in with a password", the small link under the Discord and Apple buttons. Sign in with Apple works too, with your own Apple ID: it asks for no name or email, and makes an ordinary account.

The app works without signing in too: every player starts with an account created on the device on first launch, without any third-party service. Signing in adds ranked play, blocking, and your own bots.

To see a game without waiting for another player:
1. On the lobby, choose a mode and tap "Play a bot". The opponent is an analysis engine bundled in the app and runs entirely offline.
2. "Play someone next to you" opens a two-player board on this one device.
3. The Study section's analysis board and the opening explorer need no opponent at all.
Ranked online play matches you with whoever is in the queue, so it may wait if nobody else is online.

Moderation: every chat message that is not yours has a ⋯ menu with Report, and every player's page has REPORT and BLOCK. Blocking needs the signed-in account.

Account deletion: at the bottom of the Account screen, "Delete account". Please try it after signing out. That deletes the account this device made for you and leaves the review account working for the next review. It works the same way while signed in.

Linking Discord or Apple is turned off for the review account, so that its password keeps working. Entering a tournament needs a Discord-verified account, because the host reaches entrants through Discord, and posting on the feedback board needs an account signed in with Discord or Apple. You can browse both without one.

The three game modes were invented by the YouTube creator WebGoatGuy. This app credits him on its own Credits page and links to his implementation and community rather than presenting the games as ours.
```

The old notes also said Discord "only links" an account for use on another
device. That stopped being true once ranked play and blocking needed a sign-in,
so the claim is gone. Whether what is left is enough for guideline 4.8 is a
decision rather than a fact: see [Before you submit](#before-you-submit).

### Assets

| Asset | Requirement | Status |
| --- | --- | --- |
| App icon | 1024×1024 PNG, no alpha channel, no rounded corners | `frontend/assets/icon.png` is 1024×1024, 8-bit RGB, no alpha — ready to upload as is |
| iPhone 6.9" screenshots | 1290×2796 or 1320×2868 portrait, 3–10 of them | Required — see [Screenshot plan](#screenshot-plan) |
| iPad 13" screenshots | 2064×2752 or 2048×2732 portrait | Required **only while `supportsTablet` is `true`** |
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
| Data deletion | Requires a URL — see [Before you submit](#before-you-submit) |

### App access

Answer **All or some functionality in my app is restricted**. Signed out,
online play is casual only, and ranked play, blocking and your own bots need a
sign-in. Add one set of instructions:

| Field | Value |
| --- | --- |
| Name | Review account |
| Username | The `google` review account's, from [Review accounts](#review-accounts) |
| Password | Its password, from the same place. Never written in this file |

**Any other information required to access your app** — 478 characters:

```
On the Account screen (the You tab), tap "Sign in with a password", the small link under the Discord button. Signed in, you can play ranked games, block players and add your own bots. Discord linking is turned off for this account so its password keeps working. Tournament entry and the feedback board need a Discord-verified account; both can be browsed without one. To try account deletion, sign out first: that deletes the account this device made and keeps this one working.
```

### Data safety form

**Does your app collect or share any required user data?** Yes, collects. **No
data is shared with third parties** — Google Analytics receives events as our
service provider, which the form does not count as sharing. All data is **encrypted in transit** (TLS
and WSS). Users **can request that data be deleted** — and can delete it
themselves, in the app or at `https://rps.henhen1227.com/account`, which is the
URL this form wants.

| Data type | Collected | Required? | Purpose |
| --- | --- | --- | --- |
| Personal info → User IDs | Yes | Required | App functionality, Account management |
| Messages → Other in-app messages | Yes | Optional | App functionality |
| App activity → Other actions (game results, ratings, tournament entries) | Yes | Required | App functionality |
| Device or other IDs | Yes | Optional | App functionality (match alerts); Analytics (a random analytics ID) |
| App activity → App interactions | Yes | Optional | Analytics |
| App info and performance → Other app performance data | Yes | Optional | Analytics (device model, OS and app version, language, screen size) |

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
- **Users can share content** — chat text, bot descriptions, and published
  opening names.
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
| App icon | 512×512 32-bit PNG, under 1 MB | Generate from `assets/icon.png` |
| Feature graphic | 1024×500 PNG or JPEG, no alpha | **Missing — must be created.** It is shown before any screenshot |
| Phone screenshots | 2–8, 9:16 portrait, 1080×1920 or larger | See [Screenshot plan](#screenshot-plan) |
| 7" and 10" tablet screenshots | Optional, but required for the tablet placements and for a "Designed for tablets" badge | Recommended |
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
minute per username, so anybody who knows one can keep a reviewer locked out
for as long as they keep trying. Pick names that do not say what they are.

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
game is deleted outright; one that has played is stripped of its name, Discord
link, titles and sign-in, with the name replaced by "Deleted player" in the game
records, in the archive, and inside the stored PGN text. Any bots it owns are
retired. What is kept, and why, is said in the confirmation dialog rather than
only in the policy: a game belongs to two people, and removing one player's copy
would rewrite the other's history and rating.

For the Play Data safety form's account-deletion URL, the same page is reachable
on the web at `https://rps.henhen1227.com/account`.

**A filter on what gets posted.** Chat messages, usernames, bot descriptions and
published opening names all go through `backend/internal/textfilter`, which
refuses slurs and strong profanity outright — the message is never posted and
the sender is told why. It handles the lazy evasions (spacing, punctuation,
digit substitution, stretched spellings) and is deliberately narrow beyond that:
it catches what is unambiguous and leaves arguments to the report queue. The
term list is `terms.txt` in that package, editable without touching code.

**Reporting.** A `⋯` on every chat message that is not yours, and **REPORT** on
every player's page. The form's reasons come from the server, and a report from
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
Credits page, and `@henhen1227` on the policy page and inside the report form
for anything the queue cannot handle.

---

## Before you submit

Two things will not pass as they stand. The two that used to head this list —
account deletion and the guideline 1.2 affordances — are done; they are described under [What is
already in](#what-is-already-in) so the questionnaire answers below can be
filled in from it.

**1. Android needs two things the repository cannot hold.** The app is
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
  `RPS_FCM_CREDENTIALS_PATH` (see `backend/README.md`). Until both are in place,
  Android players are told alerts are unavailable rather than offered them.

`targetSdk` is 36 under Expo 57, which meets Play's current requirement.

**2. A new personal Play developer account has to run a closed test with 12
testers for 14 days** before it can apply for production access. Start that
clock early; it is the longest lead time on this whole list, and it is not
something a code change can shorten.

Three more worth a decision rather than a fix:

- **Guideline 4.8, login services.** Answered by Sign in with Apple, which
  sits beside Discord on the iPhone as an equal button, asks for no name or
  email, and opens the same account Discord does once the two are linked from
  the Account screen. Before submitting the first build that has it: the App ID
  needs the Sign in with Apple capability, the build needs the
  `com.apple.developer.applesignin` entitlement (prebuild adds it), the server
  needs `RPS_APPLE_KEY_PATH`, `RPS_APPLE_KEY_ID` and `RPS_APPLE_TEAM_ID` (see
  `backend/deploy/rps-strategy.env.example`), and its boot log should say Apple
  accepts the key. Without the server half the app hides the button, and 4.8 is
  open again.

- **The games are someone else's invention.** Intransitive, Total War and
  Infiltration were designed by WebGoatGuy, who has his own implementation at
  `meaf.us/rps2`. The Credits page handles this gracefully in-app, and the
  description above says "This is a fan build" for the same reason. Apple's
  guideline 4.1 (Copycats) and the Content Rights question both live here.
  Getting a line of written permission from him — a Discord message is fine —
  before you submit costs nothing and answers the only question a reviewer could
  reasonably ask.
- **`orientation` is `portrait` while `ios.supportsTablet` is `true`.** That
  ships an iPad app that cannot be rotated, and it obliges you to produce 13"
  iPad screenshots. Either set `supportsTablet: false` and ship iPhone-only for
  1.0, or support landscape on tablets properly. The first is a one-line change
  and drops a whole screenshot set.

Cleared already, worth knowing: the nine Chess.com sound files are gone —
`frontend/assets/sounds/` is eight self-authored `.wav` files, so there is no
third-party audio in the bundle. `MIGRATION.md` §2.4 has the history.

---

## Not doing yet

- **Localization.** English only for 1.0. The description is the only long
  string, so adding a language later is cheap.
- **App previews / promo video.** Screenshots carry a board game fine.
- **A Play Store pre-registration or Apple pre-order.** Neither helps an app
  with no marketing behind it.
