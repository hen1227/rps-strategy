package persistence

import (
	"database/sql"
	"errors"
	"path/filepath"
	"testing"
)

const testProfileKey = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

func TestAccountProfileUsesLocalKeyAndPersistsDiscord(t *testing.T) {
	store, err := Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()

	account, err := store.EnsureAccountWithProfileKey(
		t.Context(), "profile-user", "Guest", testProfileKey,
	)
	if err != nil {
		t.Fatal(err)
	}
	if account.Username != "Guest" || account.Discord != "" {
		t.Fatalf("unexpected initial account: %#v", account)
	}

	updated, err := store.UpdateAccountProfile(
		t.Context(), "profile-user", testProfileKey, "Rock Star", "rock.star",
	)
	if err != nil {
		t.Fatal(err)
	}
	if updated.Username != "Rock Star" || updated.Discord != "rock.star" {
		t.Fatalf("profile was not updated: %#v", updated)
	}

	if _, err := store.EnsureAccountWithProfileKey(
		t.Context(), "profile-user", "Guest", testProfileKey,
	); err != nil {
		t.Fatalf("the same local key should reconnect: %v", err)
	}
	if _, err := store.EnsureAccountWithProfileKey(
		t.Context(),
		"profile-user",
		"Guest",
		"ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
	); !errors.Is(err, ErrInvalidProfileKey) {
		t.Fatalf("expected the wrong local key to be rejected, got %v", err)
	}
	if _, err := store.UpdateAccountProfile(
		t.Context(),
		"profile-user",
		"ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
		"Impostor",
		"impostor",
	); !errors.Is(err, ErrInvalidProfileKey) {
		t.Fatalf("expected an unauthorized edit to be rejected, got %v", err)
	}

	persisted, err := store.Account(t.Context(), "profile-user")
	if err != nil {
		t.Fatal(err)
	}
	if persisted.Username != "Rock Star" || persisted.Discord != "rock.star" {
		t.Fatalf("unauthorized edit changed the profile: %#v", persisted)
	}
}

func TestExistingAccountIsClaimedByFirstLocalKey(t *testing.T) {
	store, err := Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	if _, err := store.EnsureAccount(t.Context(), "legacy-user", "Legacy Name"); err != nil {
		t.Fatal(err)
	}

	account, err := store.EnsureAccountWithProfileKey(
		t.Context(), "legacy-user", "Guest", testProfileKey,
	)
	if err != nil {
		t.Fatal(err)
	}
	if account.Username != "Legacy Name" {
		t.Fatalf("claiming should retain an existing display name: %#v", account)
	}
	if _, err := store.UpdateAccountProfile(
		t.Context(), "legacy-user", testProfileKey, "Claimed Name", "claimed.user",
	); err != nil {
		t.Fatal(err)
	}
}

func TestAccountProfileMigrationAddsColumnsToExistingDatabase(t *testing.T) {
	path := filepath.Join(t.TempDir(), "legacy.sqlite")
	database, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	_, err = database.Exec(`
CREATE TABLE accounts (
    user_id TEXT PRIMARY KEY,
    username TEXT NOT NULL,
    elo INTEGER NOT NULL DEFAULT 1200,
    wins INTEGER NOT NULL DEFAULT 0,
    losses INTEGER NOT NULL DEFAULT 0,
    draws INTEGER NOT NULL DEFAULT 0,
    games_played INTEGER NOT NULL DEFAULT 0,
    created_at_unix_ms INTEGER NOT NULL,
    updated_at_unix_ms INTEGER NOT NULL
);
INSERT INTO accounts (
    user_id, username, created_at_unix_ms, updated_at_unix_ms
) VALUES ('legacy-migration', 'Old Player', 1, 1);
`)
	if err != nil {
		t.Fatal(err)
	}
	if err := database.Close(); err != nil {
		t.Fatal(err)
	}

	store, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	account, err := store.EnsureAccountWithProfileKey(
		t.Context(), "legacy-migration", "Guest", testProfileKey,
	)
	if err != nil {
		t.Fatal(err)
	}
	if account.Username != "Old Player" || account.Discord != "" {
		t.Fatalf("migration did not preserve the account: %#v", account)
	}
}

func TestAccountProfileValidation(t *testing.T) {
	store, err := Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	if _, err := store.EnsureAccountWithProfileKey(
		t.Context(), "validation-user", "Guest", testProfileKey,
	); err != nil {
		t.Fatal(err)
	}

	for _, testCase := range []struct {
		name    string
		discord string
	}{
		{"", "valid.discord"},
		{"Valid Name", "has spaces"},
		{"Valid Name", "x"},
	} {
		if _, err := store.UpdateAccountProfile(
			t.Context(),
			"validation-user",
			testProfileKey,
			testCase.name,
			testCase.discord,
		); !errors.Is(err, ErrInvalidAccountProfile) {
			t.Fatalf("expected validation error for %#v, got %v", testCase, err)
		}
	}
}
