package persistence

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

const (
	minimumProfileKeyLength = 32
	maximumProfileKeyLength = 256
)

func (store *Store) ensureAccountProfileColumns(ctx context.Context) error {
	columns, err := tableColumns(ctx, store.db, "accounts")
	if err != nil {
		return fmt.Errorf("inspect account profile schema: %w", err)
	}
	for _, migration := range []struct {
		name       string
		definition string
	}{
		{name: "discord", definition: "TEXT NOT NULL DEFAULT ''"},
		{name: "profile_key_hash", definition: "TEXT NOT NULL DEFAULT ''"},
		// The title worn in front of the name. One column rather than a join,
		// because every read of an account needs it and at most one title is
		// ever worn; the collection it is chosen from lives in
		// `account_titles`. Empty means no tag, which is the default and stays
		// allowed forever.
		{name: "title", definition: "TEXT NOT NULL DEFAULT ''"},
		// The look this player chose: a small JSON object of preset ids, or
		// empty for an account that has never said. One column rather than a
		// table for the same reason as the title above — every read of an
		// account needs it and there is at most one — and opaque on purpose:
		// the catalogue of themes, boards, piece sets and sound packs lives in
		// the client, and a server that validated ids against its own copy
		// would reject every look added by a build newer than itself. See
		// SetAccountAppearance for the limits that are enforced.
		{name: "appearance", definition: "TEXT NOT NULL DEFAULT ''"},
	} {
		if columns[migration.name] {
			continue
		}
		statement := fmt.Sprintf(
			"ALTER TABLE accounts ADD COLUMN %s %s",
			migration.name,
			migration.definition,
		)
		if _, err := store.db.ExecContext(ctx, statement); err != nil {
			return fmt.Errorf("add account %s column: %w", migration.name, err)
		}
	}
	return nil
}

func tableColumns(ctx context.Context, database *sql.DB, table string) (map[string]bool, error) {
	rows, err := database.QueryContext(ctx, "PRAGMA table_info("+table+")")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	columns := make(map[string]bool)
	for rows.Next() {
		var index int
		var name, columnType string
		var notNull, primaryKey int
		var defaultValue any
		if err := rows.Scan(
			&index,
			&name,
			&columnType,
			&notNull,
			&defaultValue,
			&primaryKey,
		); err != nil {
			return nil, err
		}
		columns[name] = true
	}
	return columns, rows.Err()
}

func (store *Store) EnsureAccountWithProfileKey(
	ctx context.Context,
	userID string,
	username string,
	profileKey string,
) (Account, error) {
	userID, username, err := normalizeIdentity(userID, username)
	if err != nil {
		return Account{}, err
	}
	profileKeyHash, err := hashProfileKey(profileKey)
	if err != nil {
		return Account{}, err
	}

	transaction, err := store.db.BeginTx(ctx, nil)
	if err != nil {
		return Account{}, fmt.Errorf("authenticate account: begin transaction: %w", err)
	}
	defer func() { _ = transaction.Rollback() }()
	now := time.Now().UnixMilli()
	if _, err := transaction.ExecContext(ctx, `
INSERT INTO accounts (
    user_id, username, discord, profile_key_hash, elo,
    created_at_unix_ms, updated_at_unix_ms
) VALUES (?, ?, '', ?, ?, ?, ?)
ON CONFLICT(user_id) DO NOTHING
`, userID, username, profileKeyHash, RatingFloor, now, now); err != nil {
		return Account{}, fmt.Errorf("authenticate account: create account: %w", err)
	}

	var storedHash, storedPasswordHash, storedDiscordUserID, kind string
	var disabled int
	if err := transaction.QueryRowContext(ctx, `
SELECT profile_key_hash, password_hash, discord_user_id, kind, disabled
FROM accounts WHERE user_id = ?
`, userID).Scan(
		&storedHash, &storedPasswordHash, &storedDiscordUserID, &kind, &disabled,
	); err != nil {
		return Account{}, fmt.Errorf("authenticate account: read profile key: %w", err)
	}
	if disabled != 0 {
		return Account{}, ErrAccountDisabled
	}
	// Only an anonymous, unregistered account may be claimed by whoever turns
	// up with a key. "Unregistered" has to mean no credential *of any kind*:
	// a Discord account has no password, so testing the password alone would
	// hand every Discord account to anyone who read its user ID. Every user ID in this database is public — it appears in
	// live-game listings, PGN tags, and history rows — so without this guard
	// anyone could connect as somebody else's bot, or as a registered player
	// whose row happened to have no key, and play as them. Bot accounts are
	// additionally sealed with a discarded random key at creation, making this
	// the second of two locks rather than the only one.
	claimable := kind == AccountKindHuman &&
		!accountIsRegistered(storedPasswordHash, storedDiscordUserID)
	if storedHash == "" {
		if !claimable {
			return Account{}, ErrInvalidProfileKey
		}
		if _, err := transaction.ExecContext(ctx, `
UPDATE accounts SET profile_key_hash = ? WHERE user_id = ? AND profile_key_hash = ''
`, profileKeyHash, userID); err != nil {
			return Account{}, fmt.Errorf("authenticate account: claim existing account: %w", err)
		}
	} else if !profileKeyHashesMatch(storedHash, profileKeyHash) {
		return Account{}, ErrInvalidProfileKey
	}

	// A claimed name belongs to its owner, so the display name a client sends
	// on connect may only rename an anonymous account. Letting it through for
	// a registered account would desynchronise username from username_lower —
	// renaming without touching the unique index, which is how one player ends
	// up wearing another's name.
	if _, err := transaction.ExecContext(ctx, `
UPDATE accounts
SET username = CASE WHEN ? = 'Guest' THEN username ELSE ? END,
    updated_at_unix_ms = ?
WHERE user_id = ? AND username_lower = '' AND kind = ?
`, username, username, now, userID, AccountKindHuman); err != nil {
		return Account{}, fmt.Errorf("authenticate account: refresh account: %w", err)
	}
	if _, err := transaction.ExecContext(ctx, `
UPDATE accounts SET updated_at_unix_ms = ? WHERE user_id = ?
`, now, userID); err != nil {
		return Account{}, fmt.Errorf("authenticate account: touch account: %w", err)
	}
	if err := transaction.Commit(); err != nil {
		return Account{}, fmt.Errorf("authenticate account: commit: %w", err)
	}
	return store.Account(ctx, userID)
}

// UpdateAccountProfile renames a registered account and sets its Discord
// handle.
//
// There is no profile key here because there is no anonymous profile left to
// edit: the route behind this holds a session, and only a registered account
// has a name of its own. An anonymous browser identity plays as "Guest" until
// it registers, which is what makes a name in this game mean one person rather
// than whoever typed it last.
func (store *Store) UpdateAccountProfile(
	ctx context.Context,
	userID string,
	username string,
	discord string,
) (Account, error) {
	userID = strings.TrimSpace(userID)
	username, err := ValidateUsername(username)
	if err != nil {
		return Account{}, err
	}
	var passwordHash, discordUserID, storedDiscord string
	var disabled int
	err = store.db.QueryRowContext(ctx, `
SELECT password_hash, discord_user_id, discord, disabled FROM accounts WHERE user_id = ?
`, userID).Scan(&passwordHash, &discordUserID, &storedDiscord, &disabled)
	if errors.Is(err, sql.ErrNoRows) {
		return Account{}, ErrAccountNotFound
	}
	if err != nil {
		return Account{}, fmt.Errorf("update account profile: read account: %w", err)
	}
	if disabled != 0 {
		return Account{}, ErrAccountDisabled
	}
	if !accountIsRegistered(passwordHash, discordUserID) {
		return Account{}, ErrNotRegistered
	}

	// A verified handle is Discord's answer, not the account holder's, so it is
	// not editable here. Ignored rather than refused: a client that read the
	// account and sent it back unchanged would otherwise get an error for a
	// field it never touched, and the reply below carries the authoritative
	// value anyway.
	//
	// Skipping validateDiscord with it is deliberate. That rule was written for
	// a handle somebody typed, and Discord is not obliged to satisfy it.
	if discordUserID != "" {
		discord = storedDiscord
	} else if discord, err = validateDiscord(discord); err != nil {
		return Account{}, err
	}

	// The WHERE clause repeats both checks so the write cannot land on a row
	// that stopped qualifying between the read and here.
	if _, err := store.db.ExecContext(ctx, `
UPDATE accounts
SET username = ?, username_lower = ?, discord = ?, updated_at_unix_ms = ?
WHERE user_id = ? AND `+registeredSQL("")+` AND disabled = 0
`, username, UsernameKey(username), discord, time.Now().UnixMilli(), userID); err != nil {
		if isUniqueConstraint(err) {
			return Account{}, ErrUsernameTaken
		}
		return Account{}, fmt.Errorf("update account profile: save profile: %w", err)
	}
	// Renaming is the other way to claim a name, and it reaches the same rule.
	if err := grantOwnerAdmin(ctx, store.db, userID, username); err != nil {
		return Account{}, err
	}
	return store.Account(ctx, userID)
}

// validateDiscord checks the one free-form field an account still has.
//
// It is optional. Registering asks for a username and a password, and a player
// who never enters a tournament never needs to be reachable on Discord.
func validateDiscord(discord string) (string, error) {
	discord = strings.TrimSpace(discord)
	if discord == "" {
		return "", nil
	}
	if utf8.RuneCountInString(discord) < 2 || utf8.RuneCountInString(discord) > 64 {
		return "", fmt.Errorf(
			"%w: Discord must be between 2 and 64 characters",
			ErrInvalidAccountProfile,
		)
	}
	if strings.IndexFunc(discord, unicode.IsSpace) >= 0 ||
		strings.IndexFunc(discord, unicode.IsControl) >= 0 {
		return "", fmt.Errorf(
			"%w: Discord cannot contain spaces or control characters",
			ErrInvalidAccountProfile,
		)
	}
	return discord, nil
}

func hashProfileKey(profileKey string) (string, error) {
	profileKey = strings.TrimSpace(profileKey)
	if len(profileKey) < minimumProfileKeyLength || len(profileKey) > maximumProfileKeyLength {
		return "", ErrInvalidProfileKey
	}
	hash := sha256.Sum256([]byte(profileKey))
	return hex.EncodeToString(hash[:]), nil
}

func profileKeyHashesMatch(stored string, provided string) bool {
	return subtle.ConstantTimeCompare([]byte(stored), []byte(provided)) == 1
}
