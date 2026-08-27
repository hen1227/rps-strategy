package persistence

import (
	"database/sql"
	"errors"
	"path/filepath"
	"testing"
)

const testProfileKey = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

func TestAccountProfileBelongsToRegisteredAccounts(t *testing.T) {
	store, err := Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	ctx := t.Context()

	account, err := store.EnsureAccountWithProfileKey(ctx, "profile-user", "Guest", testProfileKey)
	if err != nil {
		t.Fatal(err)
	}
	if account.Username != "Guest" || account.Discord != "" {
		t.Fatalf("unexpected initial account: %#v", account)
	}
	// An anonymous browser identity has no profile to edit. Naming yourself is
	// what registering is for.
	if _, err := store.UpdateAccountProfile(
		ctx, "profile-user", "RockStar", "rock.star",
	); !errors.Is(err, ErrNotRegistered) {
		t.Fatalf("expected an anonymous profile edit to be refused, got %v", err)
	}

	// A legacy account on purpose: a typed Discord handle is only editable
	// while the account has no verified one, so this is the shape that still
	// exercises the field.
	seedLegacyPasswordAccount(t, store, "profile-user", "RockStar", authTestPassword)
	updated, err := store.UpdateAccountProfile(ctx, "profile-user", "RockStar", "rock.star")
	if err != nil {
		t.Fatal(err)
	}
	if updated.Username != "RockStar" || updated.Discord != "rock.star" {
		t.Fatalf("profile was not updated: %#v", updated)
	}

	// A rename has to move the uniqueness key with it, or the old name stays
	// claimed and the new one never is.
	renamed, err := store.UpdateAccountProfile(ctx, "profile-user", "Rock.Star-2", "")
	if err != nil {
		t.Fatal(err)
	}
	if renamed.Username != "Rock.Star-2" || renamed.Discord != "" {
		t.Fatalf("rename did not take: %#v", renamed)
	}
	if _, err := store.AuthenticateAccount(ctx, "Rock.Star-2", authTestPassword); err != nil {
		t.Fatalf("the new name should sign in: %v", err)
	}
	if _, err := store.AuthenticateAccount(ctx, "RockStar", authTestPassword); !errors.Is(
		err, ErrInvalidCredentials,
	) {
		t.Fatalf("the released name should no longer sign in: %v", err)
	}
}

func TestAccountProfileRenameCannotTakeAClaimedName(t *testing.T) {
	store, err := Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	ctx := t.Context()
	const otherKey = "abababababababababababababababababababababababababababababababab"

	for _, account := range []struct{ userID, username, key string }{
		{"rename-first", "Taken", testProfileKey},
		{"rename-second", "Renamer", otherKey},
	} {
		if _, err := store.EnsureAccountWithProfileKey(
			ctx, account.userID, "Guest", account.key,
		); err != nil {
			t.Fatal(err)
		}
		if _, err := store.ClaimAccountWithDiscord(
			ctx, account.userID, account.username, "discord-"+account.userID, account.username,
		); err != nil {
			t.Fatal(err)
		}
	}

	if _, err := store.UpdateAccountProfile(ctx, "rename-second", "taken", ""); !errors.Is(
		err, ErrUsernameTaken,
	) {
		t.Fatalf("expected a claimed name to be refused, got %v", err)
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
	// The display name they have been playing under for months comes with them
	// into the account system, minus the space the username rule does not take.
	registered, err := store.ClaimAccountWithDiscord(
		t.Context(), "legacy-user", "LegacyName", "discord-legacy-user", "legacyname",
	)
	if err != nil {
		t.Fatal(err)
	}
	if registered.Username != "LegacyName" || !registered.Registered {
		t.Fatalf("legacy account did not carry into a real one: %#v", registered)
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
	ctx := t.Context()
	if _, err := store.EnsureAccountWithProfileKey(
		ctx, "validation-user", "Guest", testProfileKey,
	); err != nil {
		t.Fatal(err)
	}
	// Legacy for the same reason as above: validateDiscord guards the typed
	// handle, and a verified one never passes through it.
	seedLegacyPasswordAccount(t, store, "validation-user", "Validator", authTestPassword)

	for _, testCase := range []struct {
		name    string
		discord string
		want    error
	}{
		{"", "valid.discord", ErrInvalidUsername},
		{"has spaces", "valid.discord", ErrInvalidUsername},
		{"Valid", "has spaces", ErrInvalidAccountProfile},
		{"Valid", "x", ErrInvalidAccountProfile},
	} {
		if _, err := store.UpdateAccountProfile(
			ctx, "validation-user", testCase.name, testCase.discord,
		); !errors.Is(err, testCase.want) {
			t.Fatalf("expected %v for %#v, got %v", testCase.want, testCase, err)
		}
	}

	// Discord is optional: registering asks for a username and a password, and
	// nothing else is required to play.
	if _, err := store.UpdateAccountProfile(ctx, "validation-user", "Validator", ""); err != nil {
		t.Fatalf("an empty Discord handle should be allowed: %v", err)
	}
}
