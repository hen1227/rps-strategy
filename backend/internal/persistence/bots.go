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
)

// Bot is one registered engine. It is safe to serialize: the token is stored
// only as a hash and is never a field here.
type Bot struct {
	BotID       string `json:"botId"`
	OwnerUserID string `json:"ownerUserId"`
	// UserID and Name are empty until the client first connects and claims the
	// slot, which is what the account page shows as "unclaimed".
	UserID           string   `json:"userId,omitempty"`
	Name             string   `json:"name,omitempty"`
	Description      string   `json:"description"`
	AllowPublicPlay  bool     `json:"allowPublicPlay"`
	EnterTournaments bool     `json:"enterTournaments"`
	EngineName       string   `json:"engineName,omitempty"`
	EngineAuthor     string   `json:"engineAuthor,omitempty"`
	EngineModes      []string `json:"engineModes,omitempty"`
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
	// mode starts from, so reading it would report DefaultElo for every engine
	// for ever. Same answer, and for the same reason, as the combined
	// leaderboard — see the note in Leaderboard. The counters beside it are
	// lifetime totals, which do move on every game.
	Elo         int `json:"elo"`
	Wins        int `json:"wins"`
	Losses      int `json:"losses"`
	Draws       int `json:"draws"`
	GamesPlayed int `json:"gamesPlayed"`
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
}

// BotEngineIdentity is what the RPSI handshake reported, recorded so the bot's
// profile page can show which build is actually running.
type BotEngineIdentity struct {
	Name   string
	Author string
	Modes  []game.ModeID
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
	return nil
}

// botSelect joins the bot to the account that carries its name, so the two can
// never drift apart.
const botSelect = `
SELECT b.bot_id, b.owner_user_id, COALESCE(b.user_id, ''),
       COALESCE(a.username, ''), b.description,
       b.allow_public_play, b.enter_tournaments,
       b.engine_name, b.engine_author, b.engine_modes,
       COALESCE(i.sha256, ''),
       b.claimed_at_unix_ms IS NOT NULL, b.disabled,
       b.retired_at_unix_ms IS NOT NULL,
       b.created_at_unix_ms, b.last_seen_at_unix_ms,
       COALESCE((SELECT MAX(r.elo) FROM account_mode_ratings r
                  WHERE r.user_id = b.user_id), a.elo, 0),
       COALESCE(a.wins, 0), COALESCE(a.losses, 0),
       COALESCE(a.draws, 0), COALESCE(a.games_played, 0)
FROM bots b
LEFT JOIN accounts a ON a.user_id = b.user_id
LEFT JOIN bot_icons i ON i.bot_id = b.bot_id`

func scanBot(scanner interface{ Scan(...any) error }) (Bot, error) {
	var bot Bot
	var modesJSON string
	err := scanner.Scan(
		&bot.BotID, &bot.OwnerUserID, &bot.UserID, &bot.Name, &bot.Description,
		&bot.AllowPublicPlay, &bot.EnterTournaments,
		&bot.EngineName, &bot.EngineAuthor, &modesJSON, &bot.IconSHA256,
		&bot.Claimed, &bot.Disabled, &bot.Retired,
		&bot.CreatedAtUnixMs, &bot.LastSeenAtUnixMs,
		&bot.Elo, &bot.Wins, &bot.Losses, &bot.Draws, &bot.GamesPlayed,
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

	var existing int
	if err := transaction.QueryRowContext(ctx, `
SELECT COUNT(*) FROM bots WHERE owner_user_id = ? AND retired_at_unix_ms IS NULL
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
	description := strings.TrimSpace(settings.Description)
	if len(description) > 280 {
		description = description[:280]
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
`, accountID, AccountKindBot, name, UsernameKey(name), sealedHash, DefaultElo, now, now); err != nil {
			if isUniqueConstraint(err) {
				return Bot{}, ErrUsernameTaken
			}
			return Bot{}, fmt.Errorf("claim bot: create bot account: %w", err)
		}
		if _, err := transaction.ExecContext(ctx, `
UPDATE bots
SET user_id = ?, description = ?, allow_public_play = ?, enter_tournaments = ?,
    claimed_at_unix_ms = ?, last_seen_at_unix_ms = ?, updated_at_unix_ms = ?
WHERE bot_id = ?
`, accountID, description, boolToInt(settings.AllowPublicPlay),
			boolToInt(settings.EnterTournaments), now, now, now, botID); err != nil {
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
    last_seen_at_unix_ms = ?, updated_at_unix_ms = ?
WHERE bot_id = ?
`, description, boolToInt(settings.AllowPublicPlay),
			boolToInt(settings.EnterTournaments), now, now, botID); err != nil {
			return Bot{}, fmt.Errorf("claim bot: %w", err)
		}
	}

	if err := transaction.Commit(); err != nil {
		return Bot{}, fmt.Errorf("claim bot: commit: %w", err)
	}
	return store.Bot(ctx, botID)
}

// RecordBotEngineIdentity stores what the RPSI handshake reported.
func (store *Store) RecordBotEngineIdentity(
	ctx context.Context,
	botID string,
	identity BotEngineIdentity,
) error {
	modes, err := json.Marshal(identity.Modes)
	if err != nil {
		return fmt.Errorf("record engine identity: %w", err)
	}
	if _, err := store.db.ExecContext(ctx, `
UPDATE bots SET engine_name = ?, engine_author = ?, engine_modes = ?, updated_at_unix_ms = ?
WHERE bot_id = ?
`, identity.Name, identity.Author, string(modes), time.Now().UnixMilli(), botID); err != nil {
		return fmt.Errorf("record engine identity: %w", err)
	}
	return nil
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
	description string,
) (Bot, error) {
	description = strings.TrimSpace(description)
	if len(description) > 280 {
		description = description[:280]
	}
	result, err := store.db.ExecContext(ctx, `
UPDATE bots
SET allow_public_play = ?, enter_tournaments = ?, description = ?, updated_at_unix_ms = ?
WHERE bot_id = ? AND retired_at_unix_ms IS NULL
`, boolToInt(allowPublicPlay), boolToInt(enterTournaments), description,
		time.Now().UnixMilli(), strings.TrimSpace(botID))
	if err != nil {
		return Bot{}, fmt.Errorf("update bot: %w", err)
	}
	if affected, _ := result.RowsAffected(); affected == 0 {
		return Bot{}, ErrBotNotFound
	}
	return store.Bot(ctx, botID)
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
