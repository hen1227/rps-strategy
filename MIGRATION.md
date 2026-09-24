# Migration plan: three repos → `rps-strategy` + `rpsfish`

Target end state:

| Repo | Contents | License | CLA |
|---|---|---|---|
| `rps-strategy` | `backend/`, `frontend/`, `docs/`, `deploy/`, root docs | AGPL-3.0-or-later | yes |
| `rpsfish` | the Rust engine, unchanged | LGPL-3.0-or-later | no |

> **Updated 2026-09-24.** `rps-strategy` is **AGPL-3.0-or-later**, not the
> GPL-3.0-or-later this plan was written for. The backend is a network service,
> and plain GPL lets anyone run a modified, closed copy of it; AGPL §13 closes
> that. Everything below about the CLA holds unchanged, because the AGPL
> contains every GPL term the App Store conflicts with. If anything, the CLA
> matters more: without it, one merged contribution would bind the production
> server itself under §13. `rpsfish` has **no CLA** (decided 2026-09-05; see
> §2.1). Read "GPL-3.0" below as the licence the plan started from.

---

## 0. State of play (measured, not assumed)

**Three git repos, one unversioned parent.**

```
RockPaperScissors/          ← NOT a git repo
├── README.md   (44 KB)     ← in no repo
├── PRIVACY.md              ← in no repo
├── EVAL_TRAINING.md        ← in no repo
├── docs/       (5 files)   ← in no repo
├── deploy-backend.sh       ← in no repo
├── deploy-engine.sh        ← in no repo
├── start-*.sh, *.conf      ← in no repo (conf files hold live bot tokens)
├── *.png  (bot icons)      ← in no repo
├── frontend/   → github.com/hen1227/RockPaperScissors
├── backend/    → github.com/hen1227/RockPaperScissorsBackend
└── RPSFish/    → no remote at all
```

The single most valuable part of the project — the 44 KB README, the privacy
policy, the protocol and bot-author docs, and both deploy scripts — is
currently backed up by nothing.

**Repo state:**

| | frontend | backend | RPSFish |
|---|---|---|---|
| commits | 14 | 4 | 2 |
| `.git` size | 9.9 MB | 14 MB | 512 KB |
| uncommitted files | **77** | **169** | **34** |
| unpushed commits | 1 | 2 | n/a (no remote) |
| current branch | `typescript-refactor` | `main` | `main` |

`typescript-refactor` is 8 ahead of `main` and 0 behind — a clean
fast-forward, so there is no branch reconciliation to do.

**Things the merge should fix or clear, found while looking:**

1. `backend` history carries two 9.3 MB compiled Go binaries (`pgnseed`,
   `seedtitles`) — 18.6 MB of dead weight in a repo whose source is ~1 MB.
2. `backend/.idea/workspace.xml` is **tracked** and embeds `/Users/henry/...`
   paths.
3. `frontend/LICENSE` is Expo's `create-expo-app` boilerplate:
   *"Copyright (c) 2015-present 650 Industries, Inc. (aka Expo)"*. Publishing
   that as the project's licence misattributes copyright.
4. `frontend/.env.production` is **tracked**. Expo bakes `EXPO_PUBLIC_*` into
   the bundle so those are public by design — confirm nothing else is in it.
5. The docs drift guard is **currently red**:
   ```
   --- FAIL: TestEmbeddedDocsMatchTheRepositoryCopies
       backend/internal/botclient/rpsi.md has drifted from ../../../docs/rpsi.md
       backend/internal/botclient/notation.md has drifted from ../../../docs/notation.md
   ```
   The canonical `docs/` copies are the newer, better-written ones; the embedded
   copies are stale drafts. This is the split failing exactly where it was
   predicted to: a test cannot hold an invariant across a repo boundary when one
   side of the invariant lives in no repo at all.
6. **No real secrets in any history.** Every hit on a token/secret/password scan
   across all three histories is either a test fixture
   (`"an-admin-token-of-at-least-32-chars"`), a placeholder in
   `.env.example`, or an `os.Getenv` read. Nothing needs history surgery for
   secrets.

**Dependency licences are clean for GPL-3.0.** Go: MIT / BSD-2 / BSD-3 only.
npm: MIT throughout (React, Expo, RN, zustand). RPSFish has **zero** Rust
dependencies, which makes the LGPL boundary as simple as it can possibly be.

---

## 1. The one decision that shapes everything: the engine boundary

Right now the website and the engine are welded together by **relative paths in
both directions**:

```jsonc
// frontend/package.json
"build:rpsfish":     "../RPSFish/scripts/build_web.sh",
"build:rpsfish:ios": "../RPSFish/scripts/build_ios.sh",
```
```bash
# RPSFish/scripts/build_web.sh:26
RPSFISH_WEB_DIR=$(dirname -- "$RPSFISH_ENGINE_DIR")/frontend/public/rpsfish
```

The engine's build script *writes into the website's tree* by walking up and
back down. After the merge `frontend/` sits one level deeper inside the
monorepo, so this breaks even if someone clones both repos as siblings. This
has to be replaced, and how you replace it is the fork in the plan.

### Option A — publish engine artifacts, consume by version ✅ **CHOSEN**

`rpsfish` CI builds `rpsfish.wasm` + the `xcframework` on tag and attaches them
to a GitHub Release. The website gets `frontend/scripts/fetch-engine.sh`, which
downloads a **pinned version + sha256** into `public/rpsfish/` and
`modules/rpsfish/ios/`, with `RPSFISH_DIR=../rpsfish` as a from-source override
for when you're working on the engine.

- A website contributor needs **only Node** — no Rust, no `wasm32` target, no
  Xcode — to run the app. That is the difference between "I'll try a PR" and "I
  gave up during setup."
- CI for the website becomes trivial and hermetic.
- The tagged release is a clean anchor for the LGPL relinking obligation.
- Costs you a small release pipeline, and a version bump each time the engine
  moves. While you're actively tuning weights, `RPSFISH_DIR` covers that.

### Option B — git submodule

`rps-strategy` pins `engine/` as a submodule of `rpsfish`. One clone, builds
stay one command, relinking obligation trivially satisfied. But submodules are a
well-known drive-by-contributor tarpit, every contributor still needs the Rust
toolchain, and it half-undoes the separation you're doing this for.

### Option C — env var + sibling checkout

`RPSFISH_DIR` defaulting to `../rpsfish`, documented in the README. Cheapest
change by far; entirely manual; no reproducibility guarantee about which engine
build produced a given site build.

**Decided: A, with C as the built-in developer override.** They are the same
script with two branches, so this is not really two pieces of work.

---

## 2. Licensing prep

> Not legal advice — worth an hour with a lawyer before you flip the switch,
> particularly on the CLA text.

### 2.1 GPL-3.0 and the App Store: you need the CLA before the first PR

This is the part that is easy to get wrong and expensive to undo.

Apple's App Store terms impose restrictions (device limits, DRM) that GPL-3.0
§6 forbids you to add. Shipping GPL-3.0 code on the App Store is the conflict
that got VLC pulled. **Today you are fine**, because you are the sole copyright
holder and a copyright holder is not bound by the licence they grant to others
— you publish under GPL-3.0 to the world and ship your own build under your own
terms. That is straightforward dual-licensing.

It stops being true the moment you merge someone else's patch. Their
contribution is theirs, licensed to you under GPL-3.0 only, and your App Store
build now contains code you have no permission to ship that way.

So: **the CLA has to be in place and enforced before the repo is public**, not
added later. Retrofitting means chasing down every contributor for a signature,
and one unreachable person can pin you.

The same argument applies to `librpsfish.a`. It is **statically linked** into
the iOS app, which is LGPLv3 §4(d)(0) territory — a third party doing that would
owe relinkable object files. *(Reversed 2026-09-05: `rpsfish` takes no CLA. The
App Store build meets LGPL §4(d) itself, by offering the relinkable objects once
the engine contains anyone else's code. The paragraph below is the original
reasoning.)* You don't, for the same reason, and the CLA on
`rpsfish` is what keeps that true. (The web build is already clean: the `.wasm`
is a separate file fetched at runtime, which is the §4(d)(1) shared-library
path.)

**What the CLA must grant you**, if it's going to do this job:
- a broad, irrevocable copyright licence *including the right to relicense and
  sublicense* — this is the clause that permits the proprietary App Store build;
- a patent grant;
- a warranty that the contributor has the right to contribute.

Apache's ICLA is the standard starting point. *(Done 2026-09-24: `CLA.md`
adapts it. CLA Assistant turned out to be a dead end: the Lite action was
archived in March 2026 and the hosted service has had no commit since 2023. So
the check is `.github/workflows/cla.yml`, a small workflow in this repository
that keeps its signatures on a `cla-signatures` branch.)* Automate it with
[CLA Assistant](https://github.com/cla-assistant/cla-assistant) as a required
status check.

**A DCO is not a substitute.** A DCO only certifies provenance; it grants you no
relicensing right at all. If you set up a DCO thinking it protects the App Store
build, it does not.

### 2.2 Third-party material to clear before going public

| Item | Status | Resolution |
|---|---|---|
| `frontend/assets/sounds/*.mp3` | 🚨 **RELEASE BLOCKER — confirmed scraped from Chess.com.** Proprietary; no licence permits redistribution, under GPL-3.0 or otherwise. | **Must be replaced before publication.** See §2.4. Nine files: `capture`, `move-self`, `move-check`, `move-opponent`, `promote`, `notify`, `rock_captures`, `paper_captures`, `scissor_captures`. |
| `backend/internal/meafarchive/games_export.txt` | ⚠️ Games are public, but they are Meaf's to publish. Not to be tracked on GitHub pending an arrangement with Meaf. | Keep untracked. **But `//go:embed` makes this a build break** — see §2.5 for the fix. |
| `frontend/LICENSE` | ✅ Deleted 2026-09-24. No Expo template code was left, so there was no notice to carry. Was: Expo's MIT boilerplate, carrying *650 Industries'* copyright line. | Delete. Real `LICENSE` at the monorepo root; Expo's notice moves to `NOTICE.md`. |
| `frontend/assets/pieces/`, `assets/bots/` | ✅ Henry confirmed 2026-09-24: all artwork is his, some of it AI-generated and then edited. `NOTICE.md` says so. | Confirm they're yours; state it in `NOTICE.md`. Given the sounds, worth an explicit check. |

### 2.4 Replacing the sound set — ✅ done in the working tree

Henry generated a replacement set with a Python script (2026-09-05). All nine
Chess.com `.mp3` files are removed and eight self-authored `.wav` files are in
their place: `move`, `notify`, `start`, `end`, `illegal`, and one per capture —
`rock_takes_scissors`, `scissors_takes_paper`, `paper_takes_rock`.

Self-authored is the strongest possible outcome here. He owns them outright, so
there is no third-party right to track, nothing to put in `NOTICE.md`, and no
constraint on the GPL-3.0 repo, the App Store build, or monetization — the three
things that ruled out every Lichess set (see the git history of this file).

All 16-bit PCM mono 44.1 kHz, 0.10–0.24s. That is the most portable WAV encoding
there is: Core Audio, ExoPlayer and every browser handle it. Expo SDK 57's audio
docs confirm `require()` of a local asset, and `wav` is in Metro's default
`assetExts`, so no bundler configuration was needed.

> ⚠️ **The Chess.com files are still in the frontend's git history.** Removing
> them from `HEAD` is not enough. The §4 filter-repo pass is exactly the right
> moment to strip them, and the command below does it. The repo is still private,
> so this costs nothing today and is expensive to fix later.

**The same test still applies to `assets/pieces/` and `assets/bots/`**, which
remain unverified. Anything third-party there has to clear all three constraints,
not just "is it open source".

### 2.5 Keeping the meaf.us export off GitHub without breaking the build

`internal/meafarchive/embed.go` does:

```go
//go:embed games_export.txt
var Export string
```

`go:embed` is a **compile-time** dependency. Simply untracking the file means
`go build ./...` fails on every fresh clone with *"pattern games_export.txt: no
matching files found"* — the public repo would not compile.

**Recommended fix — a build tag:**

- `meafarchive/export_meaf.go`, tagged `//go:build meaf`, keeps the `go:embed`.
- `meafarchive/export_stub.go`, tagged `//go:build !meaf`, sets `Export = ""`.
- `games_export.txt` goes in `.gitignore`.
- Your deploys build with `-tags meaf`; `deploy-backend.sh` needs that flag.
- The tests that read the export get the same tag.

A public clone then builds and tests clean, with the meaf segment simply absent
— a visible, honest gap rather than a silent one. If you and Meaf later agree on
redistribution, deleting the tag is a one-line change.

### 2.3 Licence identifiers

Pick `-or-later` vs `-only` deliberately. `GPL-3.0-or-later` is the FSF default
and lets you move to a future GPL; `-only` locks the terms. RPSFish already
declares `license = "LGPL-3.0-or-later"` in `Cargo.toml` and ships both
`COPYING` and `COPYING.LESSER` correctly, so matching `-or-later` on the website
keeps the pair consistent.

---

## 3. Pre-flight (do this while it is still three repos)

Nothing here is destructive and every step is easier before the histories move.

1. ⏳ **Commit or stash all 280 uncommitted files.** *Blocking everything below.* The merge rewrites history in
   scratch clones; anything not committed is invisible to it. This is the
   highest-risk step in the whole plan simply because there is so much of it.
   ```bash
   git -C frontend status --short   # 77
   git -C backend  status --short   # 169
   git -C RPSFish  status --short   # 34
   ```
2. **Push everything.**
   - ✅ RPSFish — `github.com/hen1227/rpsfish` created (private), `main` pushed.
     It previously existed on this disk and nowhere else. SSH remote, matching
     the other two repos; `gh repo create` sets HTTPS, which can't authenticate
     non-interactively here.
   - ⏳ frontend (1 ahead) and backend (2 ahead) — blocked by step 1.
3. ⏳ **Fast-forward `main` to `typescript-refactor`** — *blocked by step 1;
   `git checkout main` aborts against the 77 uncommitted files.* so the import has one obvious
   branch to take:
   ```bash
   git -C frontend checkout main && git -C frontend merge --ff-only typescript-refactor
   ```
4. ✅ **Untrack the IDE state** — done, staged.
   (`.idea/` was already in `.gitignore` at line 20; the files predated the rule,
   which is why ignoring never took effect.)
   ```bash
   git -C backend rm -r --cached .idea && echo ".idea/" >> backend/.gitignore
   ```
5. ✅ **Fix the red drift test** — done, `go test ./internal/botclient/` is green:
   ```bash
   cp docs/bots.md docs/rpsi.md docs/notation.md backend/internal/botclient/
   ```
6. **Verify `frontend/.env.production`** holds only `EXPO_PUBLIC_*` values.
7. **Confirm `altbot.conf` / `rpsbot.conf` never get committed.** They hold live
   bot tokens (`token = ...`). They go in `.gitignore`; ship
   `deploy/bots/*.conf.example` with placeholders instead.

---

## 4. Merge mechanics

Both histories are preserved with correct paths, and the backend's 18.6 MB of
committed binaries is dropped on the way through. Everything happens in scratch
clones — the working repos are never rewritten.

```bash
brew install git-filter-repo
SCRATCH=~/rps-migration && mkdir -p "$SCRATCH" && cd "$SCRATCH"
```

**Rewrite the frontend into `frontend/`.** `--no-local` forces a real object
copy rather than hardlinks, so filter-repo cannot reach back into the original.

```bash
git clone --no-local ~/RockPaperScissors/frontend fe && cd fe
# Drop the Chess.com sound files from every commit that ever held them (§2.4).
git filter-repo --invert-paths --path-glob 'assets/sounds/*.mp3'
git filter-repo --to-subdirectory-filter frontend --force
cd ..
```

**Rewrite the backend into `backend/`, dropping the binaries.** Two passes:
paths are stripped using their *original* names, then everything moves.

```bash
git clone --no-local ~/RockPaperScissors/backend be && cd be
git filter-repo --invert-paths --path pgnseed --path seedtitles --path .idea/
git filter-repo --to-subdirectory-filter backend --force
cd ..
```

**Build the monorepo.**

```bash
mkdir ~/rps-strategy && cd ~/rps-strategy
git init -b main
git commit --allow-empty -m "Root of the RPS Strategy monorepo"

git remote add fe "$SCRATCH/fe" && git fetch fe
git merge --allow-unrelated-histories fe/main -m "Import the frontend history under frontend/"

git remote add be "$SCRATCH/be" && git fetch be
git merge --allow-unrelated-histories be/main -m "Import the backend history under backend/"

git remote remove fe && git remote remove be
```

**Then move the unversioned root in** — README.md, PRIVACY.md, docs/, the
deploy and start scripts, the bot icons — as one commit that finally puts them
under version control.

`EVAL_TRAINING.md`, `RPSFishIcon.png` and `ALTFishIcon.png` are engine-side;
they belong in `rpsfish`, not here. The bot `.conf.example` files and
`start-*.sh` pair with the bot icons under `deploy/bots/`.

**Verify before pushing:**

```bash
git log --oneline --graph --all | head -30
du -sh .git                      # expect well under the 24 MB of the two originals
git log --all --oneline -- backend/pgnseed              # expect empty
git log --all --oneline -- 'frontend/assets/sounds/*.mp3'  # expect empty
cd backend && go test ./...
cd ../frontend && npm ci && npm test
```

**Do not import the frontend's `dist` branch.** It is gh-pages build output;
`git clone` of the local repo won't bring it, since it only exists on the
remote. Re-establish web deploys from the merged repo instead (§5).

---

## 5. Post-merge wiring

- **Engine consumption** — implement whichever of §1 you chose. Delete both
  `build:rpsfish*` scripts' relative paths; fix
  `RPSFish/scripts/build_web.sh:26` to take an explicit output directory
  argument rather than deriving one from its own location.
- **Deploy** — the site is **self-hosted**; `gh-pages` is not serving it. The
  `deploy` script is only a way to get a built bundle onto a `dist` branch, and
  it publishes to whatever `origin` is. So there is nothing to repoint: give
  the monorepo a remote and `npm run deploy` carries the build to that repo's
  `dist` branch instead of the old one. A GitHub Actions Pages workflow would
  be the wrong answer here — it solves a hosting problem that does not exist.
- **CI** — one workflow, two jobs: `go test ./...` in `backend/`, and
  `tsc --noEmit && node --test` in `frontend/` after fetching the engine
  artifact. Add the CLA Assistant check as required.
- **Community files** — `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md`,
  `NOTICE.md`, issue and PR templates. `SECURITY.md` matters here: the backend
  handles Discord OAuth, JWTs, VAPID push keys and an admin token, so you want
  a stated private disclosure path before the code is readable by everyone.
- **`docs/` is now genuinely canonical.** The drift guard finally has both sides
  of its invariant inside one repo, which is the structural fix for §0.5.
- **Archive the old repos** rather than deleting — GitHub archive mode keeps
  existing clone URLs and issue links alive, with a banner pointing at the new
  home.

---

## 6. Flip to public

Order matters, and two of these are hard gates:

1. 🚨 **Replace the Chess.com sound files** (§2.4). Nothing else on this list
   matters if proprietary audio is in the public history.
2. 🚨 **Land the CLA** — document, CLA Assistant, required status check — while
   the repo is still private. Every day it is public without one is a day a PR
   can arrive that you cannot ship on the App Store.
3. `LICENSE` (AGPL-3.0), `NOTICE.md`, community files merged. *(LICENSE, NOTICE,
   CONTRIBUTING, CLA and REUSE.toml are in the working tree as of 2026-09-24;
   SECURITY.md and CODE_OF_CONDUCT.md are not.)*
4. meaf.us export untracked and the `meaf` build tag in place (§2.5), with
   `go build ./...` verified clean on a *fresh clone* — not just on this machine,
   where the file happens to exist.
5. `frontend/LICENSE` (Expo's) deleted; piece and bot artwork provenance stated.
6. Fresh secret scan on the *merged* history (`gitleaks detect --no-git=false`)
   — cheap, and the merge is a new artifact.
7. Rotate the bot tokens in `altbot.conf` / `rpsbot.conf`. Never committed, but
   rotating before a release is free insurance.
8. Flip `rps-strategy` public. Watch it for a day.
9. Flip `rpsfish` public. *(Already public: it went first.)*

---

## Sequenced checklist

**Pre-flight**
- [x] Create `hen1227/rpsfish` (private), push `main` — engine was unbacked-up
- [x] Untrack `backend/.idea/` (staged)
- [x] Fix the red docs drift test — `go test ./internal/botclient/` green
- [x] **Commit the uncommitted files** — 135 frontend + 188 backend, one
      snapshot commit each, 2026-09-07
- [ ] Push frontend and backend — deliberately not done; the monorepo is local
      only for now, and the old repos are for archiving rather than pushing
- [x] Fast-forward frontend `main` to `typescript-refactor` — done in the
      scratch clone by `clone --single-branch --branch`, so the live repo's
      working tree was never disturbed
- [x] Verify `frontend/.env.production` holds only `EXPO_PUBLIC_*` values —
      confirmed 2026-09-07: one variable, `EXPO_PUBLIC_WS_URL`, and the file
      says so at the top. Public by design; nothing to remove

**Decisions** — all four resolved
- [x] Engine boundary → **`RPSFISH_DIR` + sibling autodiscovery only** (§1).
      The published-artifact half needs a release pipeline inside `rpsfish`,
      and that repo is being left alone; revisit before going public.
- [x] meaf.us data → untracked, `meaf` build tag (§2.5)
- [x] Sounds → Chess.com, must be replaced (§2.4)
- [x] Scope → pre-flight only for now

**Merge**
- [x] Run §4 filter-repo merge into `rps-strategy` — 25 commits, `.git` 6.0 MB
      down from 30 MB; binaries, `.idea/` and every `.mp3` gone
- [x] Verify history intact, `go test ./...` and `npm test` green — 16/16 in
      `~/rps-migration-scripts/verify-monorepo.sh`
- [x] Import the unversioned root (README, PRIVACY, docs/, deploy scripts, icons)
- [x] Rewire the engine build and CI — `frontend/scripts/build-engine.sh`,
      verified against the real engine
- [ ] Give the monorepo a remote — the only thing `npm run deploy` is waiting
      for. The site is self-hosted, so the `dist` branch is just a build
      carrier and follows `origin` wherever it points

**Release gates**
- [x] Replace the nine Chess.com sound files — self-authored WAVs, in the working tree
- [x] 🚨 Strip the Chess.com mp3s from git history during the §4 merge —
      verified: no `.mp3` blob is reachable from any ref
- [x] 🚨 CLA drafted (`CLA.md`), and the check that enforces it written
      (`.github/workflows/cla.yml`, tested in `.github/cla/`)
- [x] 🚨 Make **CLA** a required check on `main`, and protect the
      `cla-signatures` branch from deletion. Done 2026-09-24 with rulesets
      23958109 and 23958110; the repository admin bypasses the first
- [x] LICENSE (AGPL-3.0) / NOTICE / CONTRIBUTING / REUSE.toml added;
      `frontend/LICENSE` deleted; the bot kit and protocol docs marked MIT
- [x] SECURITY.md (reports to support@henhen1227.com)
- [ ] CODE_OF_CONDUCT.md (optional)
- [x] `meaf` build tag in place; both build modes verified — untagged builds
      and tests clean with no export present, `-tags meaf` green with it
- [x] Secret scan on merged history. 2026-09-24: every ref, `dist` included,
      and the working tree. No keys or tokens, and nothing sensitive tracked
- [ ] Rotate the bot tokens (optional: they were never committed)
- [x] CI green on Linux. The backend's one failing test was a real bug in the
      listener's socket cleanup, fixed in `18ca1f8`
- [ ] Public: `rps-strategy`. (`rpsfish` went first and is already public.)
- [ ] Archive the two old repos with a pointer to the new one. Keep them
      private: the frontend one still has the Chess.com mp3s in its history
