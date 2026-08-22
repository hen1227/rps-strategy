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
`, userID, username, profileKeyHash, DefaultElo, now, now); err != nil {
		return Account{}, fmt.Errorf("authenticate account: create account: %w", err)
	}

	var storedHash string
	if err := transaction.QueryRowContext(ctx, `
SELECT profile_key_hash FROM accounts WHERE user_id = ?
`, userID).Scan(&storedHash); err != nil {
		return Account{}, fmt.Errorf("authenticate account: read profile key: %w", err)
	}
	if storedHash == "" {
		if _, err := transaction.ExecContext(ctx, `
UPDATE accounts SET profile_key_hash = ? WHERE user_id = ? AND profile_key_hash = ''
`, profileKeyHash, userID); err != nil {
			return Account{}, fmt.Errorf("authenticate account: claim existing account: %w", err)
		}
	} else if !profileKeyHashesMatch(storedHash, profileKeyHash) {
		return Account{}, ErrInvalidProfileKey
	}

	if _, err := transaction.ExecContext(ctx, `
UPDATE accounts
SET username = CASE WHEN ? = 'Guest' THEN username ELSE ? END,
    updated_at_unix_ms = ?
WHERE user_id = ?
`, username, username, now, userID); err != nil {
		return Account{}, fmt.Errorf("authenticate account: refresh account: %w", err)
	}
	if err := transaction.Commit(); err != nil {
		return Account{}, fmt.Errorf("authenticate account: commit: %w", err)
	}
	return store.Account(ctx, userID)
}

func (store *Store) UpdateAccountProfile(
	ctx context.Context,
	userID string,
	profileKey string,
	displayName string,
	discord string,
) (Account, error) {
	userID = strings.TrimSpace(userID)
	if userID == "" || utf8.RuneCountInString(userID) > 128 {
		return Account{}, fmt.Errorf(
			"%w: user ID must be between 1 and 128 characters",
			ErrInvalidAccountProfile,
		)
	}
	profileKeyHash, err := hashProfileKey(profileKey)
	if err != nil {
		return Account{}, err
	}
	displayName, discord, err = normalizeAccountProfile(displayName, discord)
	if err != nil {
		return Account{}, err
	}

	transaction, err := store.db.BeginTx(ctx, nil)
	if err != nil {
		return Account{}, fmt.Errorf("update account profile: begin transaction: %w", err)
	}
	defer func() { _ = transaction.Rollback() }()

	var storedHash string
	if err := transaction.QueryRowContext(ctx, `
SELECT profile_key_hash FROM accounts WHERE user_id = ?
`, userID).Scan(&storedHash); errors.Is(err, sql.ErrNoRows) {
		return Account{}, ErrAccountNotFound
	} else if err != nil {
		return Account{}, fmt.Errorf("update account profile: read profile key: %w", err)
	}
	if storedHash == "" {
		if _, err := transaction.ExecContext(ctx, `
UPDATE accounts SET profile_key_hash = ? WHERE user_id = ? AND profile_key_hash = ''
`, profileKeyHash, userID); err != nil {
			return Account{}, fmt.Errorf("update account profile: claim account: %w", err)
		}
	} else if !profileKeyHashesMatch(storedHash, profileKeyHash) {
		return Account{}, ErrInvalidProfileKey
	}

	if _, err := transaction.ExecContext(ctx, `
UPDATE accounts
SET username = ?, discord = ?, updated_at_unix_ms = ?
WHERE user_id = ?
`, displayName, discord, time.Now().UnixMilli(), userID); err != nil {
		return Account{}, fmt.Errorf("update account profile: save profile: %w", err)
	}
	if err := transaction.Commit(); err != nil {
		return Account{}, fmt.Errorf("update account profile: commit: %w", err)
	}
	return store.Account(ctx, userID)
}

func normalizeAccountProfile(displayName string, discord string) (string, string, error) {
	displayName = strings.TrimSpace(displayName)
	discord = strings.TrimSpace(discord)
	if utf8.RuneCountInString(displayName) < 1 || utf8.RuneCountInString(displayName) > 40 {
		return "", "", fmt.Errorf(
			"%w: display name must be between 1 and 40 characters",
			ErrInvalidAccountProfile,
		)
	}
	if strings.IndexFunc(displayName, unicode.IsControl) >= 0 {
		return "", "", fmt.Errorf(
			"%w: display name cannot contain control characters",
			ErrInvalidAccountProfile,
		)
	}
	if utf8.RuneCountInString(discord) < 2 || utf8.RuneCountInString(discord) > 64 {
		return "", "", fmt.Errorf(
			"%w: Discord must be between 2 and 64 characters",
			ErrInvalidAccountProfile,
		)
	}
	if strings.IndexFunc(discord, unicode.IsSpace) >= 0 ||
		strings.IndexFunc(discord, unicode.IsControl) >= 0 {
		return "", "", fmt.Errorf(
			"%w: Discord cannot contain spaces or control characters",
			ErrInvalidAccountProfile,
		)
	}
	return displayName, discord, nil
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
