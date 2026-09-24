package persistence

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"rps-strategy/backend/internal/game"
	"rps-strategy/backend/internal/textfilter"
)

// The bot registry.
//
// One durable token per bot, and the token *is* the bot. The website mints it,
// the owner pastes it into the client, and the client supplies a name and
// settings on first connect. Every later connection with the same token is
// recognised as the same bot, which is how the server tells a new bot from one
// that has simply restarted. There is no exchange step and no second secret,
// so the thing an owner saves is the thing they were given.
//
// A bot has its own row in `accounts`. That is the decision everything else
// rests on: ratings, game history, the PGN archive, spectating, head-to-head
// records, and the review screen then work for a bot through exactly the paths
// they already work through for a person, and seating a bot in a game is the
// same function call as seating anyone else.
//
// The bot's *name* lives on that account row and nowhere else. It could
// plausibly be duplicated here for convenience, and then the two copies could
// disagree — so instead every read joins. The account row also carries the
// uniqueness, through the same partial index registered accounts use, which is
// what stops a person from taking a bot's name and intercepting its
// challenges.

const (
	// BotTokenPrefix makes a bot token recognisable on sight, so it cannot be
	// mistaken for a session token or a profile key in a header.
	BotTokenPrefix = "rps_b_"
	botTokenBytes  = 32

	// MaximumBotsPerAccount is a spam limit that still leaves room for the
	// thing bot authors actually want: running a new version against the old
	// one. An admin can raise it for an individual account.
	MaximumBotsPerAccount = 5

	// BotAccountPrefix marks the account a bot plays under. It is what makes
	// the two ids a bot has tellable apart on sight: a bot id is bare hex, so
	// nothing but a bot *account* id can start with this.
	BotAccountPrefix = "bot-"

	// BotIconPixels is the largest icon edge accepted, and the size the
	// website draws one at. Smaller squares are allowed — refusing somebody's
	// 64x64 drawing would serve nobody — but nothing is scaled up.
	BotIconPixels = 128
	// MaximumBotIconBytes bounds what a client may send. Generous for the job:
	// a 128x128 PNG is usually a few kilobytes, and everything stored is
	// re-encoded at this size anyway.
	MaximumBotIconBytes = 64 << 10
)

var (
	// ErrBotNotFound covers an unknown bot id or an unknown token.
	ErrBotNotFound = errors.New("bot not found")
	// ErrBotDisabled is returned for a bot an admin has switched off.
	ErrBotDisabled = errors.New("bot is disabled")
	// ErrBotRetired is returned for a bot its owner has removed.
	ErrBotRetired = errors.New("bot has been retired")
	// ErrBotLimitReached is returned when an account already holds its
	// allowance of bots.
	ErrBotLimitReached = errors.New("bot limit reached for this account")
	// ErrBotIconInvalid covers anything that is not a square PNG of at most
	// BotIconPixels a side. Always wrapped with the particular reason, because
	// the owner is the one who has to fix the file.
	ErrBotIconInvalid = errors.New("bot icon rejected")

	// ErrInvalidBotReference is a designation that names no benchmark slot,
	// or a slot another engine already holds. See benchmarks.go.
	ErrInvalidBotReference = errors.New("invalid benchmark slot")
)

// Bot is one registered engine. It is safe to serialize: the token is stored
// only as a hash and is never a field here.
type Bot struct {
	BotID       string `json:"botId"`
	OwnerUserID string `json:"ownerUserId"`
	// UserID and Name are empty until the client first connects and claims the
	// slot, which is what the account page shows as "unclaimed".
	UserID           string `json:"userId,omitempty"`
	Name             string `json:"name,omitempty"`
	Description      string `json:"description"`
	AllowPublicPlay  bool   `json:"allowPublicPlay"`
	EnterTournaments bool   `json:"enterTournaments"`
	// EnterLadder is consent to the ranked pool: the server may pair this engine
	// against another every hour, for a rating.
	//
	// A third switch rather than a reuse of AllowPublicPlay, which the series
	// code argues against adding on the grounds that two near-identical consent
	// questions are worse than one. The difference that earns it: the other two
	// are permissions — somebody may challenge me, enter me in an event — and
	// this one is a standing commitment to burn CPU on somebody else's schedule
	// for as long as the engine is connected. An author on a laptop can
	// reasonably want the first two and not this.
	EnterLadder  bool   `json:"enterLadder"`
	EngineName   string `json:"engineName,omitempty"`
	EngineAuthor string `json:"engineAuthor,omitempty"`
	// EngineVersion is the build the engine last announced, empty for one that
	// announces none. What it is *now*; the history is BotEngineVersions.
	EngineVersion string   `json:"engineVersion,omitempty"`
	EngineModes   []string `json:"engineModes,omitempty"`
	// IconSHA256 is the digest of this bot's icon, and empty when it has none.
	// The digest rather than the image: it is what tells a client there is one
	// to fetch, and doubles as the cache key in the URL it fetches.
	IconSHA256       string `json:"iconSha256,omitempty"`
	Claimed          bool   `json:"claimed"`
	Disabled         bool   `json:"disabled"`
	Retired          bool   `json:"retired"`
	CreatedAtUnixMs  int64  `json:"createdAtUnixMs"`
	LastSeenAtUnixMs int64  `json:"lastSeenAtUnixMs,omitempty"`
	// The bot's record, read from the account row it already shares its name
	// with. Carried here so a directory or an owner's list is one request
	// rather than one request per bot, and zero on an unclaimed slot, which has
	// no account to have a record in yet.
	//
	// Elo is the strongest of its mode ratings, and deliberately not
	// `accounts.elo`, which looks like the obvious column and is not: ranked
	// play moves `account_mode_ratings` and leaves that one as the seed a new
	// mode starts from, so reading it would report RatingFloor for every engine
	// for ever. Same answer, and for the same reason, as the combined
	// leaderboard — see the note in Leaderboard. The counters beside it are
	// lifetime totals, which do move on every game.
	Elo         int `json:"elo"`
	Wins        int `json:"wins"`
	Losses      int `json:"losses"`
	Draws       int `json:"draws"`
	GamesPlayed int `json:"gamesPlayed"`
	// Title is the tag the engine wears, and empty for most of them. Nobody
	// chose it: an engine has no account page, so the sweep picks it out of
	// what the engine currently deserves. See bot_titles.go.
	Title TitleID `json:"title,omitempty"`
}

// BotSettings is what the client asserts on every connect. The config file on
// the author's machine is the source of truth at connection time; the website
// may change either value while the bot is online, and a restart re-applies
// the file.
type BotSettings struct {
	Name             string
	Description      string
	AllowPublicPlay  bool
	EnterTournaments bool
	// EnterLadder is nil when the client did not mention it, and that
	// distinction is load-bearing rather than fussy.
	//
	// A bot re-asserts its whole configuration on every connect — rpsbot.conf is
	// the authority, deliberately, so that changing a file and restarting is all
	// it takes. A plain bool would therefore mean that every client written
	// before the ranked pool existed silently opted its engine out of the pool
	// the moment this shipped, because an absent JSON field decodes to false and
	// the reconnect would write it over the column's default. Their authors
	// would find their bots unrated and have no way to guess why.
	//
	// Absent means "leave it as it is", so an old client keeps whatever the
	// website last set — which for a new bot is the default, in. Raising the
	// minimum client version instead was the alternative, and locking people out
	// over an optional feature is what that policy exists to avoid.
	EnterLadder *bool
}

// enterLadderArgument is the settings value as SQL wants it: NULL for "leave it
// alone", which the COALESCE in each write turns back into the stored value.
func (settings BotSettings) enterLadderArgument() any {
	if settings.EnterLadder == nil {
		return nil
	}
	return boolToInt(*settings.EnterLadder)
}

// BotEngineIdentity is what the RPSI handshake reported, recorded so the bot's
// profile page can show which build is actually running.
type BotEngineIdentity struct {
	Name   string
	Author string
	// Version is the build the engine declared, and empty for one that declared
	// none. Kept apart from Name because they answer different questions: the
	// name is what to call this engine and the build is which one of it played.
	// See rpsi.Handshake.Version.
	Version string
	Modes   []game.ModeID
}

func (store *Store) ensureBotSchema(ctx context.Context) error {
	const schema = `
CREATE TABLE IF NOT EXISTS bots (
    bot_id TEXT PRIMARY KEY,
    owner_user_id TEXT NOT NULL REFERENCES accounts(user_id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    user_id TEXT UNIQUE REFERENCES accounts(user_id) ON DELETE SET NULL,
    description TEXT NOT NULL DEFAULT '',
    allow_public_play INTEGER NOT NULL DEFAULT 1 CHECK (allow_public_play IN (0, 1)),
    enter_tournaments INTEGER NOT NULL DEFAULT 1 CHECK (enter_tournaments IN (0, 1)),
    enter_ladder INTEGER NOT NULL DEFAULT 1 CHECK (enter_ladder IN (0, 1)),
    engine_name TEXT NOT NULL DEFAULT '',
    engine_author TEXT NOT NULL DEFAULT '',
    engine_modes TEXT NOT NULL DEFAULT '[]',
    claimed_at_unix_ms INTEGER,
    retired_at_unix_ms INTEGER,
    last_seen_at_unix_ms INTEGER NOT NULL DEFAULT 0,
    disabled INTEGER NOT NULL DEFAULT 0 CHECK (disabled IN (0, 1)),
    created_at_unix_ms INTEGER NOT NULL,
    updated_at_unix_ms INTEGER NOT NULL,
    CHECK (user_id IS NULL OR user_id <> owner_user_id)
);

-- The icon its owner ships with the client, in a table of its own so that
-- listing bots never reads a megabyte of images to draw a page of names.
CREATE TABLE IF NOT EXISTS bot_icons (
    bot_id TEXT PRIMARY KEY REFERENCES bots(bot_id) ON DELETE CASCADE,
    png BLOB NOT NULL,
    sha256 TEXT NOT NULL,
    updated_at_unix_ms INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS bots_owner_idx
    ON bots(owner_user_id, created_at_unix_ms);
CREATE INDEX IF NOT EXISTS bots_public_idx
    ON bots(disabled, allow_public_play);
`
	if _, err := store.db.ExecContext(ctx, schema); err != nil {
		return fmt.Errorf("migrate bot schema: %w", err)
	}
	// CREATE TABLE IF NOT EXISTS does nothing to a table that already exists,
	// so a database from before the yardsticks needs the column added.
	columns, err := tableColumns(ctx, store.db, "bots")
	if err != nil {
		return fmt.Errorf("inspect bot schema: %w", err)
	}
	if !columns["reference_kind"] {
		if _, err := store.db.ExecContext(ctx,
			"ALTER TABLE bots ADD COLUMN reference_kind TEXT NOT NULL DEFAULT ''",
		); err != nil {
			return fmt.Errorf("add bot reference column: %w", err)
		}
	}
	// Default 1, so an engine already running is entered when this ships rather
	// than quietly dropping off a ladder it cannot know it needs to opt back
	// into. The switch is prominent and its owner can turn it off in one click;
	// the alternative — everybody defaulted out — is a ladder with nothing on it
	// and no way for anyone to discover why.
	if !columns["enter_ladder"] {
		if _, err := store.db.ExecContext(ctx,
			"ALTER TABLE bots ADD COLUMN enter_ladder INTEGER NOT NULL DEFAULT 1"+
				" CHECK (enter_ladder IN (0, 1))",
		); err != nil {
			return fmt.Errorf("add bot ladder column: %w", err)
		}
	}
	// Empty for every engine that has not declared a build, which on the day
	// this ships is all of them. There is no useful default: a build stamp
	// nobody sent is not a build, and guessing one from engine_name would be
	// re-creating the ambiguity the column exists to remove.
	if !columns["engine_version"] {
		if _, err := store.db.ExecContext(ctx,
			"ALTER TABLE bots ADD COLUMN engine_version TEXT NOT NULL DEFAULT ''",
		); err != nil {
			return fmt.Errorf("add bot engine version column: %w", err)
		}
	}

	// One row per build an engine has been seen running, which is what answers
	// "when did this change" — the column above cannot, because it is
	// overwritten.
	//
	// Per distinct build rather than per connect. A bot with five slots that
	// reconnects on a blip announces itself dozens of times a day and the build
	// is the same every time; a row each would be a log of reconnections
	// wearing a version number.
	const versions = `
CREATE TABLE IF NOT EXISTS bot_engine_versions (
    bot_id TEXT NOT NULL REFERENCES bots(bot_id) ON DELETE CASCADE,
    version TEXT NOT NULL,
    first_seen_at_unix_ms INTEGER NOT NULL,
    last_seen_at_unix_ms INTEGER NOT NULL,
    PRIMARY KEY (bot_id, version)
);

CREATE INDEX IF NOT EXISTS bot_engine_versions_history_idx
    ON bot_engine_versions(bot_id, first_seen_at_unix_ms DESC);
`
	if _, err := store.db.ExecContext(ctx, versions); err != nil {
		return fmt.Errorf("migrate bot engine version schema: %w", err)
	}
	return nil
}

// The yardsticks: the server's own engines, and the only rows in `bots` that
// the ladder treats differently from anybody else's submission.
//
// A yardstick is a bot whose `reference_kind` names a benchmark slot. What the
// slots are, what each is worth, and why the scale is declared at several points
// rather than one are all in benchmarks.go; what is here is how a designation is
// stored and read back.
//
// Two things the ladder does differently for them, both of which follow from the
// declaration rather than adding to it. Their strengths are held fixed in the
// fit, so they are the frame everybody else is measured in. And a yardstick
// opponent is exempt from the opponent-count prune, which is the on-ramp: see
// botRatingMinimumOpponents. The second is what makes a newcomer's first hour
// produce a real rating instead of nothing.
//
// The other thing they buy is that a yardstick plays everybody, so the ladder is
// connected by construction and a newcomer is never stranded in a component of
// its own waiting for somebody to challenge it.

// BotYardsticks names the reference engines rated in this database.
//
// Read once per fit rather than passed in from configuration, because which
// account holds the anchor is a fact about the data the ratings were computed
// from. A fit and the record it came from have to agree about where zero is, and
// the way to guarantee that is to read both from the same transaction.
type BotYardsticks struct {
	// Anchor is the account holding BenchmarkRandom, whose rating is RatingFloor
	// by definition. Empty if this database has no anchor, which is a real state
	// — a fresh install, or a deployment before the yardsticks are seeded — and
	// one the fit answers by publishing nothing rather than by guessing.
	Anchor string
	// Slots is every designated account, by user id, naming the benchmark slot it
	// holds. The anchor is in here too: it is a rung like the others as far as
	// the fit is concerned, and differs only in being the one the scale is named
	// after and the one the fit refuses to run without.
	Slots map[string]string
}

// known reports whether an account is one of the server's own engines.
func (yardsticks BotYardsticks) known(userID string) bool {
	if userID == "" {
		return false
	}
	_, designated := yardsticks.Slots[userID]
	return designated
}

// pinned is the rating each designated account is declared to hold, which is
// what the fit holds fixed. Empty for a database with no yardsticks.
func (yardsticks BotYardsticks) pinned() map[string]int {
	ratings := make(map[string]int, len(yardsticks.Slots))
	for userID, slot := range yardsticks.Slots {
		ratings[userID] = benchmarkRating(slot)
	}
	return ratings
}

// botYardsticksTx reads the reference engines.
//
// A retired or disabled yardstick still counts. Retirement releases a name and
// frees a slot against its owner's quota; it does not unsay the games, and the
// anchor's games are what every other rating is measured through. An anchor that
// stopped counting the moment somebody clicked the wrong button would take the
// whole board's scale with it.
func botYardsticksTx(ctx context.Context, transaction *sql.Tx) (BotYardsticks, error) {
	rows, err := transaction.QueryContext(ctx, `
SELECT COALESCE(user_id, ''), reference_kind FROM bots WHERE reference_kind <> ''
`)
	if err != nil {
		return BotYardsticks{}, fmt.Errorf("read yardsticks: %w", err)
	}
	defer rows.Close()

	yardsticks := BotYardsticks{Slots: make(map[string]string)}
	for rows.Next() {
		var userID, slot string
		if err := rows.Scan(&userID, &slot); err != nil {
			return BotYardsticks{}, fmt.Errorf("read yardstick row: %w", err)
		}
		// An unclaimed slot has a bot row and no account yet, which is the state
		// between minting the token and the engine first connecting. Nothing to
		// pin: the fit is keyed on accounts.
		if userID == "" {
			continue
		}
		if slot == BenchmarkRandom {
			yardsticks.Anchor = userID
		}
		yardsticks.Slots[userID] = slot
	}
	if err := rows.Err(); err != nil {
		return BotYardsticks{}, fmt.Errorf("read yardsticks: %w", err)
	}
	return yardsticks, nil
}

// botSelect joins the bot to the account that carries its name, so the two can
// never drift apart.
const botSelect = `
SELECT b.bot_id, b.owner_user_id, COALESCE(b.user_id, ''),
       COALESCE(a.username, ''), b.description,
       b.allow_public_play, b.enter_tournaments, b.enter_ladder,
       b.engine_name, b.engine_author, b.engine_version, b.engine_modes,
       COALESCE(i.sha256, ''),
       b.claimed_at_unix_ms IS NOT NULL, b.disabled,
       b.retired_at_unix_ms IS NOT NULL,
       b.created_at_unix_ms, b.last_seen_at_unix_ms,
       COALESCE((SELECT MAX(r.elo) FROM account_mode_ratings r
                  WHERE r.user_id = b.user_id), a.elo, 0),
       COALESCE(a.wins, 0), COALESCE(a.losses, 0),
       COALESCE(a.draws, 0), COALESCE(a.games_played, 0),
       COALESCE(a.title, '')
FROM bots b
LEFT JOIN accounts a ON a.user_id = b.user_id
LEFT JOIN bot_icons i ON i.bot_id = b.bot_id`

func scanBot(scanner interface{ Scan(...any) error }) (Bot, error) {
	var bot Bot
	var modesJSON string
	err := scanner.Scan(
		&bot.BotID, &bot.OwnerUserID, &bot.UserID, &bot.Name, &bot.Description,
		&bot.AllowPublicPlay, &bot.EnterTournaments, &bot.EnterLadder,
		&bot.EngineName, &bot.EngineAuthor, &bot.EngineVersion, &modesJSON,
		&bot.IconSHA256,
		&bot.Claimed, &bot.Disabled, &bot.Retired,
		&bot.CreatedAtUnixMs, &bot.LastSeenAtUnixMs,
		&bot.Elo, &bot.Wins, &bot.Losses, &bot.Draws, &bot.GamesPlayed,
		&bot.Title,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return Bot{}, ErrBotNotFound
	}
	if err != nil {
		return Bot{}, fmt.Errorf("read bot: %w", err)
	}
	_ = json.Unmarshal([]byte(modesJSON), &bot.EngineModes)
	return bot, nil
}

// MintBotToken creates an unclaimed bot slot for an owner and returns its
// token in plaintext exactly once.
//
// The cap is enforced here rather than at claim time so an owner is told they
// are out of room while they are still on the website, instead of discovering
// it from a script on another machine.
func (store *Store) MintBotToken(ctx context.Context, ownerUserID string) (Bot, string, error) {
	ownerUserID = strings.TrimSpace(ownerUserID)

	transaction, err := store.db.BeginTx(ctx, nil)
	if err != nil {
		return Bot{}, "", fmt.Errorf("mint bot token: begin transaction: %w", err)
	}
	defer func() { _ = transaction.Rollback() }()

	var passwordHash, discordUserID, kind string
	var disabled int
	err = transaction.QueryRowContext(ctx, `
SELECT password_hash, discord_user_id, kind, disabled FROM accounts WHERE user_id = ?
`, ownerUserID).Scan(&passwordHash, &discordUserID, &kind, &disabled)
	if errors.Is(err, sql.ErrNoRows) {
		return Bot{}, "", ErrAccountNotFound
	}
	if err != nil {
		return Bot{}, "", fmt.Errorf("mint bot token: read owner: %w", err)
	}
	if disabled != 0 {
		return Bot{}, "", ErrAccountDisabled
	}
	// Requiring a registered owner is the anti-spam control: anonymous
	// accounts are free and unlimited, so bots hanging off them would be too.
	if kind != AccountKindHuman || !accountIsRegistered(passwordHash, discordUserID) {
		return Bot{}, "", ErrNotRegistered
	}

	// Yardsticks do not count against the quota. It is an anti-spam control
	// aimed at people, and the server's own reference engines are neither spam
	// nor a person's — an administrator put them there deliberately, and the
	// number of rungs the scale needs is a question about measurement rather
	// than about how many bots one account may run.
	var existing int
	if err := transaction.QueryRowContext(ctx, `
SELECT COUNT(*) FROM bots
WHERE owner_user_id = ? AND retired_at_unix_ms IS NULL AND reference_kind = ''
`, ownerUserID).Scan(&existing); err != nil {
		return Bot{}, "", fmt.Errorf("mint bot token: count bots: %w", err)
	}
	if existing >= MaximumBotsPerAccount {
		return Bot{}, "", ErrBotLimitReached
	}

	botID, err := randomToken(12)
	if err != nil {
		return Bot{}, "", err
	}
	token, err := randomToken(botTokenBytes)
	if err != nil {
		return Bot{}, "", err
	}
	token = BotTokenPrefix + token
	now := time.Now().UnixMilli()
	if _, err := transaction.ExecContext(ctx, `
INSERT INTO bots (bot_id, owner_user_id, token_hash, created_at_unix_ms, updated_at_unix_ms)
VALUES (?, ?, ?, ?, ?)
`, botID, ownerUserID, hashBotToken(token), now, now); err != nil {
		return Bot{}, "", fmt.Errorf("mint bot token: %w", err)
	}
	if err := transaction.Commit(); err != nil {
		return Bot{}, "", fmt.Errorf("mint bot token: commit: %w", err)
	}
	bot, err := store.Bot(ctx, botID)
	return bot, token, err
}

// ClaimBot resolves a token to its bot, claiming the slot on first use.
//
// Both outcomes are the same call because the caller cannot know which one it
// is: a client that has just been configured and one that has been restarted
// send exactly the same thing. The distinction is a fact about the database,
// not about the request.
func (store *Store) ClaimBot(ctx context.Context, token string, settings BotSettings) (Bot, error) {
	name, err := ValidateBotUsername(settings.Name)
	if err != nil {
		return Bot{}, err
	}
	if IsReservedUsername(name) {
		return Bot{}, fmt.Errorf("%w: that name is reserved", ErrInvalidUsername)
	}

	transaction, err := store.db.BeginTx(ctx, nil)
	if err != nil {
		return Bot{}, fmt.Errorf("claim bot: begin transaction: %w", err)
	}
	defer func() { _ = transaction.Rollback() }()

	var botID, ownerUserID string
	var userID sql.NullString
	var claimedAt, retiredAt sql.NullInt64
	var disabled int
	err = transaction.QueryRowContext(ctx, `
SELECT bot_id, owner_user_id, user_id, claimed_at_unix_ms, retired_at_unix_ms, disabled
FROM bots WHERE token_hash = ?
`, hashBotToken(token)).Scan(&botID, &ownerUserID, &userID, &claimedAt, &retiredAt, &disabled)
	if errors.Is(err, sql.ErrNoRows) {
		return Bot{}, ErrBotNotFound
	}
	if err != nil {
		return Bot{}, fmt.Errorf("claim bot: read bot: %w", err)
	}
	if retiredAt.Valid {
		return Bot{}, ErrBotRetired
	}
	if disabled != 0 {
		return Bot{}, ErrBotDisabled
	}

	now := time.Now().UnixMilli()
	description, err := publishableDescription(settings.Description)
	if err != nil {
		return Bot{}, err
	}

	if !claimedAt.Valid || !userID.Valid {
		// First connect. Create the bot's own account, sealed with a profile
		// key nobody holds: the bot authenticates with its token, and leaving
		// the key empty would make the account claimable by anyone who read
		// its user ID off a live-game listing.
		accountID, err := randomToken(12)
		if err != nil {
			return Bot{}, err
		}
		accountID = BotAccountPrefix + accountID
		sealed, err := randomToken(32)
		if err != nil {
			return Bot{}, err
		}
		sealedHash, err := hashProfileKey(sealed)
		if err != nil {
			return Bot{}, fmt.Errorf("claim bot: seal account: %w", err)
		}
		if _, err := transaction.ExecContext(ctx, `
INSERT INTO accounts (user_id, kind, username, username_lower, discord, profile_key_hash,
                      elo, created_at_unix_ms, updated_at_unix_ms)
VALUES (?, ?, ?, ?, '', ?, ?, ?, ?)
`, accountID, AccountKindBot, name, UsernameKey(name), sealedHash, RatingFloor, now, now); err != nil {
			if isUniqueConstraint(err) {
				return Bot{}, ErrUsernameTaken
			}
			return Bot{}, fmt.Errorf("claim bot: create bot account: %w", err)
		}
		if _, err := transaction.ExecContext(ctx, `
UPDATE bots
SET user_id = ?, description = ?, allow_public_play = ?, enter_tournaments = ?,
    enter_ladder = COALESCE(?, enter_ladder),
    claimed_at_unix_ms = ?, last_seen_at_unix_ms = ?, updated_at_unix_ms = ?
WHERE bot_id = ?
`, accountID, description, boolToInt(settings.AllowPublicPlay),
			boolToInt(settings.EnterTournaments), settings.enterLadderArgument(),
			now, now, now, botID); err != nil {
			return Bot{}, fmt.Errorf("claim bot: %w", err)
		}
	} else {
		// A restart. Renaming is allowed, but only into a free name — an
		// owner should not be able to take a name by pointing a config file
		// at it.
		if _, err := transaction.ExecContext(ctx, `
UPDATE accounts SET username = ?, username_lower = ?, updated_at_unix_ms = ?
WHERE user_id = ?
`, name, UsernameKey(name), now, userID.String); err != nil {
			if isUniqueConstraint(err) {
				return Bot{}, ErrUsernameTaken
			}
			return Bot{}, fmt.Errorf("claim bot: rename: %w", err)
		}
		if _, err := transaction.ExecContext(ctx, `
UPDATE bots
SET description = ?, allow_public_play = ?, enter_tournaments = ?,
    enter_ladder = COALESCE(?, enter_ladder),
    last_seen_at_unix_ms = ?, updated_at_unix_ms = ?
WHERE bot_id = ?
`, description, boolToInt(settings.AllowPublicPlay),
			boolToInt(settings.EnterTournaments), settings.enterLadderArgument(),
			now, now, botID); err != nil {
			return Bot{}, fmt.Errorf("claim bot: %w", err)
		}
	}

	if err := transaction.Commit(); err != nil {
		return Bot{}, fmt.Errorf("claim bot: commit: %w", err)
	}
	return store.Bot(ctx, botID)
}

// RecordBotEngineIdentity stores what the RPSI handshake reported, and files
// the build in the engine's version history.
//
// The history is appended to here rather than anywhere else because this is the
// one place a build is ever observed: an engine announces itself on connect and
// at no other time, so a build that never connects never existed as far as this
// site is concerned.
func (store *Store) RecordBotEngineIdentity(
	ctx context.Context,
	botID string,
	identity BotEngineIdentity,
) error {
	modes, err := json.Marshal(identity.Modes)
	if err != nil {
		return fmt.Errorf("record engine identity: %w", err)
	}
	now := time.Now().UnixMilli()
	if _, err := store.db.ExecContext(ctx, `
UPDATE bots SET engine_name = ?, engine_author = ?, engine_version = ?,
                engine_modes = ?, updated_at_unix_ms = ?
WHERE bot_id = ?
`, identity.Name, identity.Author, identity.Version, string(modes), now, botID); err != nil {
		return fmt.Errorf("record engine identity: %w", err)
	}
	if identity.Version == "" {
		return nil
	}
	// first_seen is kept and last_seen moves, so a build that is reverted to
	// keeps the date it actually first appeared. That is the honest reading:
	// going back to last week's binary is not shipping a new one, and a history
	// that restated the date would hide the revert rather than show it.
	if _, err := store.db.ExecContext(ctx, `
INSERT INTO bot_engine_versions (bot_id, version, first_seen_at_unix_ms, last_seen_at_unix_ms)
VALUES (?1, ?2, ?3, ?3)
ON CONFLICT(bot_id, version) DO UPDATE SET last_seen_at_unix_ms = ?3
`, botID, identity.Version, now); err != nil {
		return fmt.Errorf("record engine version: %w", err)
	}
	return nil
}

// BotEngineVersion is one build an engine has been seen running.
type BotEngineVersion struct {
	Version           string `json:"version"`
	FirstSeenAtUnixMs int64  `json:"firstSeenAtUnixMs"`
	LastSeenAtUnixMs  int64  `json:"lastSeenAtUnixMs"`
}

// BotEngineVersions is an engine's build history, newest first.
//
// Tie-broken on rowid, which is insertion order, because the timestamp has
// millisecond resolution and two builds can be filed inside one of them — an
// engine restarted straight onto a new binary, or a test. Without it the order
// of such a pair is whatever the query planner felt like, and the history would
// occasionally show an upgrade upside down.
func (store *Store) BotEngineVersions(
	ctx context.Context,
	botID string,
) ([]BotEngineVersion, error) {
	rows, err := store.db.QueryContext(ctx, `
SELECT version, first_seen_at_unix_ms, last_seen_at_unix_ms
FROM bot_engine_versions WHERE bot_id = ?
ORDER BY first_seen_at_unix_ms DESC, rowid DESC
`, strings.TrimSpace(botID))
	if err != nil {
		return nil, fmt.Errorf("read engine versions: %w", err)
	}
	defer rows.Close()

	versions := make([]BotEngineVersion, 0, 8)
	for rows.Next() {
		var version BotEngineVersion
		if err := rows.Scan(
			&version.Version, &version.FirstSeenAtUnixMs, &version.LastSeenAtUnixMs,
		); err != nil {
			return nil, fmt.Errorf("read engine versions: %w", err)
		}
		versions = append(versions, version)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("read engine versions: %w", err)
	}
	return versions, nil
}

// Bot reads one bot by id.
func (store *Store) Bot(ctx context.Context, botID string) (Bot, error) {
	return scanBot(store.db.QueryRowContext(ctx, botSelect+`
WHERE b.bot_id = ?`, strings.TrimSpace(botID)))
}

// BotForAccount reads the bot backing a bot account, which is how a game
// result finds its way back to a bot's profile.
func (store *Store) BotForAccount(ctx context.Context, userID string) (Bot, error) {
	return scanBot(store.db.QueryRowContext(ctx, botSelect+`
WHERE b.user_id = ?`, strings.TrimSpace(userID)))
}

// BotsForOwner lists an owner's bots, unclaimed slots included.
func (store *Store) BotsForOwner(ctx context.Context, ownerUserID string) ([]Bot, error) {
	rows, err := store.db.QueryContext(ctx, botSelect+`
WHERE b.owner_user_id = ? AND b.retired_at_unix_ms IS NULL
ORDER BY b.created_at_unix_ms`, strings.TrimSpace(ownerUserID))
	if err != nil {
		return nil, fmt.Errorf("list bots: %w", err)
	}
	defer rows.Close()
	return collectBots(rows)
}

// Bots lists every claimed, enabled bot, which is the public directory.
func (store *Store) Bots(ctx context.Context) ([]Bot, error) {
	rows, err := store.db.QueryContext(ctx, botSelect+`
WHERE b.retired_at_unix_ms IS NULL AND b.disabled = 0 AND b.claimed_at_unix_ms IS NOT NULL
ORDER BY a.username COLLATE NOCASE`)
	if err != nil {
		return nil, fmt.Errorf("list bots: %w", err)
	}
	defer rows.Close()
	return collectBots(rows)
}

func collectBots(rows *sql.Rows) ([]Bot, error) {
	bots := make([]Bot, 0)
	for rows.Next() {
		bot, err := scanBot(rows)
		if err != nil {
			return nil, err
		}
		bots = append(bots, bot)
	}
	return bots, rows.Err()
}

// UpdateBotSettings changes what the website can change while a bot is
// running. The client re-asserts its own values on the next connect, which is
// documented rather than prevented: the config file is the owner's copy.
func (store *Store) UpdateBotSettings(
	ctx context.Context,
	botID string,
	allowPublicPlay bool,
	enterTournaments bool,
	enterLadder bool,
	description string,
) (Bot, error) {
	description, err := publishableDescription(description)
	if err != nil {
		return Bot{}, err
	}
	result, err := store.db.ExecContext(ctx, `
UPDATE bots
SET allow_public_play = ?, enter_tournaments = ?, enter_ladder = ?,
    description = ?, updated_at_unix_ms = ?
WHERE bot_id = ? AND retired_at_unix_ms IS NULL
`, boolToInt(allowPublicPlay), boolToInt(enterTournaments), boolToInt(enterLadder),
		description,
		time.Now().UnixMilli(), strings.TrimSpace(botID))
	if err != nil {
		return Bot{}, fmt.Errorf("update bot: %w", err)
	}
	if affected, _ := result.RowsAffected(); affected == 0 {
		return Bot{}, ErrBotNotFound
	}
	return store.Bot(ctx, botID)
}

// ErrInvalidBotDescription is what a description the server will not publish
// produces. Its own error so the route can answer 400 rather than 500.
var ErrInvalidBotDescription = errors.New("invalid bot description")

// publishableDescription trims a bot's description to its ceiling and refuses
// one this server will not carry.
//
// A description is drawn on the bot's directory row and its profile page, in
// front of everybody, and it comes from a config file on a stranger's machine
// rather than from a form somebody filled in here. So it goes through the same
// filter a username does — see internal/textfilter — and for the same reason:
// it is a published label rather than something said once in a room.
func publishableDescription(description string) (string, error) {
	description = strings.TrimSpace(description)
	if len(description) > 280 {
		description = description[:280]
	}
	if !textfilter.Clean(description) {
		return "", fmt.Errorf("%w: rewrite it", ErrInvalidBotDescription)
	}
	return description, nil
}

// SetBotDisabled is the admin switch. A disabled bot cannot connect and does
// not appear in the directory, but keeps its account, rating and history.
func (store *Store) SetBotDisabled(ctx context.Context, botID string, disabled bool) error {
	result, err := store.db.ExecContext(ctx, `
UPDATE bots SET disabled = ?, updated_at_unix_ms = ? WHERE bot_id = ?
`, boolToInt(disabled), time.Now().UnixMilli(), strings.TrimSpace(botID))
	if err != nil {
		return fmt.Errorf("set bot disabled: %w", err)
	}
	if affected, _ := result.RowsAffected(); affected == 0 {
		return ErrBotNotFound
	}
	return nil
}

// RotateBotToken issues a new token for an existing bot and invalidates the
// old one.
//
// This is what makes losing the config file survivable: the bot keeps its
// account, its rating and its games, and only the secret changes.
func (store *Store) RotateBotToken(ctx context.Context, botID string) (string, error) {
	token, err := randomToken(botTokenBytes)
	if err != nil {
		return "", err
	}
	token = BotTokenPrefix + token
	result, err := store.db.ExecContext(ctx, `
UPDATE bots SET token_hash = ?, updated_at_unix_ms = ?
WHERE bot_id = ? AND retired_at_unix_ms IS NULL
`, hashBotToken(token), time.Now().UnixMilli(), strings.TrimSpace(botID))
	if err != nil {
		return "", fmt.Errorf("rotate bot token: %w", err)
	}
	if affected, _ := result.RowsAffected(); affected == 0 {
		return "", ErrBotNotFound
	}
	return token, nil
}

// RetireBot removes a bot from play and frees its name.
//
// The account row stays, because it is referenced by every game the bot
// played; it is renamed and released rather than deleted, the same treatment
// an anonymized person's account gets.
func (store *Store) RetireBot(ctx context.Context, botID string) error {
	botID = strings.TrimSpace(botID)
	transaction, err := store.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("retire bot: begin transaction: %w", err)
	}
	defer func() { _ = transaction.Rollback() }()

	var userID sql.NullString
	var name sql.NullString
	err = transaction.QueryRowContext(ctx, `
SELECT b.user_id, a.username FROM bots b
LEFT JOIN accounts a ON a.user_id = b.user_id
WHERE b.bot_id = ? AND b.retired_at_unix_ms IS NULL
`, botID).Scan(&userID, &name)
	if errors.Is(err, sql.ErrNoRows) {
		return ErrBotNotFound
	}
	if err != nil {
		return fmt.Errorf("retire bot: read bot: %w", err)
	}

	now := time.Now().UnixMilli()
	if userID.Valid {
		// Keep the old name visible for anyone reading history, but release
		// the claim so somebody else can register it.
		retiredName := name.String
		if retiredName == "" {
			retiredName = "Retired bot"
		}
		if _, err := transaction.ExecContext(ctx, `
UPDATE accounts SET username = ?, username_lower = '', updated_at_unix_ms = ?
WHERE user_id = ?
`, retiredName, now, userID.String); err != nil {
			return fmt.Errorf("retire bot: release name: %w", err)
		}
	}
	if _, err := transaction.ExecContext(ctx, `
UPDATE bots SET retired_at_unix_ms = ?, updated_at_unix_ms = ? WHERE bot_id = ?
`, now, now, botID); err != nil {
		return fmt.Errorf("retire bot: %w", err)
	}
	return transaction.Commit()
}

// TouchBot records that a bot connected.
func (store *Store) TouchBot(ctx context.Context, botID string) error {
	if _, err := store.db.ExecContext(ctx,
		`UPDATE bots SET last_seen_at_unix_ms = ? WHERE bot_id = ?`,
		time.Now().UnixMilli(), strings.TrimSpace(botID),
	); err != nil {
		return fmt.Errorf("touch bot: %w", err)
	}
	return nil
}

func hashBotToken(token string) string {
	return hashSessionToken(token)
}

func randomToken(length int) (string, error) {
	buffer := make([]byte, length)
	if _, err := rand.Read(buffer); err != nil {
		return "", fmt.Errorf("generate random token: %w", err)
	}
	if length <= 12 {
		return hex.EncodeToString(buffer), nil
	}
	return base64.RawURLEncoding.EncodeToString(buffer), nil
}

func boolToInt(value bool) int {
	if value {
		return 1
	}
	return 0
}

// SetBotBenchmarkSlot puts a bot in one of the scale's fixed slots, or takes it
// out of one when slot is empty.
//
// Deliberately not part of BotSettings and not reachable from PATCH /api/bots:
// which engines define the scale is not a preference, and an owner who could set
// it could rewrite every rating in the game by declaring their own bot to be
// chance itself.
//
// One engine per slot, enforced here and in a transaction rather than by the
// caller looking first. Two engines sharing a slot is not a state with a sensible
// reading — the fit would pin two different bots to the same number and the
// board would be measured against whichever the query returned — and a check in
// the HTTP handler is a check two administrators can both pass at once.
//
// Moving a slot from one engine to another is done by clearing it first. That is
// one more call than strictly necessary, and it is the point: a slot changing
// hands restates every rating in the game, so it should not be something that
// happens as a side effect of designating something else.
func (store *Store) SetBotBenchmarkSlot(ctx context.Context, botID string, slot string) error {
	if err := ValidateBenchmarkSlot(slot); err != nil {
		return err
	}
	transaction, err := store.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("set benchmark slot: begin transaction: %w", err)
	}
	defer func() { _ = transaction.Rollback() }()

	if slot != "" {
		var holder string
		err := transaction.QueryRowContext(ctx, `
SELECT bot_id FROM bots WHERE reference_kind = ? LIMIT 1
`, slot).Scan(&holder)
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			return fmt.Errorf("set benchmark slot: read the current holder: %w", err)
		}
		if holder != "" && holder != botID {
			return fmt.Errorf(
				"%w: the %s slot is held by %s; clear it first",
				ErrInvalidBotReference, slot, holder,
			)
		}
	}

	result, err := transaction.ExecContext(ctx, `
UPDATE bots SET reference_kind = ?, updated_at_unix_ms = ? WHERE bot_id = ?
`, slot, time.Now().UnixMilli(), botID)
	if err != nil {
		return fmt.Errorf("set benchmark slot: %w", err)
	}
	if affected, err := result.RowsAffected(); err == nil && affected == 0 {
		return ErrBotNotFound
	}
	if err := transaction.Commit(); err != nil {
		return fmt.Errorf("set benchmark slot: commit: %w", err)
	}
	return nil
}

// PublicBotYardsticks is the server's reference engines, for a caller outside
// the rating code: the anchor's bot id and user id, and the rungs beside it.
//
// A separate shape from the internal BotYardsticks, which is keyed on user ids
// because that is what a head-to-head record is keyed on. An administrator's
// screen and the ladder pool both want the bot id instead, and an anchor that is
// minted but not yet claimed has one of those and not the other.
type PublicBotYardsticks struct {
	AnchorBotID  string   `json:"anchorBotId"`
	AnchorUserID string   `json:"anchorUserId"`
	RungBotIDs   []string `json:"rungBotIds"`
	RungUserIDs  []string `json:"rungUserIds"`
	// Held is the declared ladder with its occupants filled in, weakest first,
	// including the slots nobody holds yet.
	//
	// The empty rows are the useful half: standing the yardsticks up is a job
	// with a checklist, and a screen that only listed what exists cannot show
	// what is missing. It is also what the fit's refusal to publish looks like
	// from outside — no anchor, no board.
	Held []HeldBenchmark `json:"held"`
}

// HeldBenchmark is one declared slot and whoever is in it.
type HeldBenchmark struct {
	Benchmark
	// BotID and UserID are empty for a slot nobody holds. A slot can have the
	// first and not the second, which is a yardstick minted but not yet
	// connected — it has a registry row and no account to pin.
	BotID  string `json:"botId,omitempty"`
	UserID string `json:"userId,omitempty"`
}

// BotYardsticks reads the reference engines outside a transaction.
func (store *Store) BotYardsticks(ctx context.Context) (PublicBotYardsticks, error) {
	rows, err := store.db.QueryContext(ctx, `
SELECT bot_id, COALESCE(user_id, ''), reference_kind
FROM bots WHERE reference_kind <> '' ORDER BY bot_id
`)
	if err != nil {
		return PublicBotYardsticks{}, fmt.Errorf("read yardsticks: %w", err)
	}
	defer rows.Close()

	holders := make(map[string]HeldBenchmark)
	var yardsticks PublicBotYardsticks
	for rows.Next() {
		var botID, userID, slot string
		if err := rows.Scan(&botID, &userID, &slot); err != nil {
			return PublicBotYardsticks{}, fmt.Errorf("read yardstick row: %w", err)
		}
		holders[slot] = HeldBenchmark{BotID: botID, UserID: userID}
		if slot == BenchmarkRandom {
			yardsticks.AnchorBotID, yardsticks.AnchorUserID = botID, userID
			continue
		}
		yardsticks.RungBotIDs = append(yardsticks.RungBotIDs, botID)
		if userID != "" {
			yardsticks.RungUserIDs = append(yardsticks.RungUserIDs, userID)
		}
	}
	if err := rows.Err(); err != nil {
		return PublicBotYardsticks{}, fmt.Errorf("read yardsticks: %w", err)
	}

	// Driven by the catalogue rather than by the rows, so the answer is the
	// whole ladder in declared order with the gaps visible, and a row holding a
	// slot this binary no longer declares simply does not appear.
	yardsticks.Held = make([]HeldBenchmark, 0, len(benchmarkLadder))
	for _, benchmark := range benchmarkLadder {
		held := holders[benchmark.Slot]
		held.Benchmark = benchmark
		yardsticks.Held = append(yardsticks.Held, held)
	}
	return yardsticks, nil
}
