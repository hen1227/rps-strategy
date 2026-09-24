package persistence

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"
)

// Linking a Discord account to one of ours.
//
// The rule that shapes this file is the same one that shaped registration
// before it: an account is *upgraded*, never replaced. Somebody who has been
// clicking around anonymously for months has a user ID, an Elo in three modes,
// and a pile of archived games; signing in with Discord attaches an identity to
// that same row.
//
// Two columns carry the link, and the distinction between them matters:
//
//   - `discord_user_id` is the snowflake. It is the identity: Discord promises
//     it is stable and unique, and it is what we match on.
//   - `discord` is the handle. It is only the display form, the thing you type
//     into Discord's search box to find somebody, and Discord lets people
//     change it. Never match on it.

// ErrIdentityAlreadyLinked is returned when a Discord account is already
// attached to a different account here. One Discord login means one player.
var ErrIdentityAlreadyLinked = errors.New("that Discord account is already linked to another player")

// ErrInvalidDiscordIdentity is returned for an empty or unusable snowflake,
// which should only ever happen if Discord's answer was not what we expect.
var ErrInvalidDiscordIdentity = errors.New("invalid Discord identity")

// discordHandleLimit matches the `discord` column's own validation ceiling, so
// a verified handle cannot be stored in a shape a typed one would be refused
// in.
const discordHandleLimit = 64

// storedDiscordHandle picks what goes in the `discord` column.
//
// Discord offers two names and only one of them belongs here. `global_name` is
// a display name — free-form, and it may contain spaces, which the handle
// column has always refused. `username` is the actual handle, restricted to
// lowercase letters, digits, underscore and dot, and it is what somebody types
// to find this player. So the username is the handle, and `global_name` is only
// ever a *suggestion* for the in-game name, which is a different question
// answered in username.go.
func storedDiscordHandle(discordUsername string) string {
	handle := strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(discordUsername), "@"))
	if len(handle) > discordHandleLimit {
		handle = handle[:discordHandleLimit]
	}
	return handle
}

// AccountForDiscordIdentity finds the account a snowflake is linked to.
//
// Returns ErrAccountNotFound when nobody holds it, which is the signal that
// this is a first sign-in rather than a returning player.
func (store *Store) AccountForDiscordIdentity(
	ctx context.Context,
	discordUserID string,
) (Account, error) {
	discordUserID = strings.TrimSpace(discordUserID)
	if discordUserID == "" {
		return Account{}, ErrInvalidDiscordIdentity
	}
	var userID string
	err := store.db.QueryRowContext(ctx,
		`SELECT user_id FROM accounts WHERE discord_user_id = ?`, discordUserID,
	).Scan(&userID)
	if errors.Is(err, sql.ErrNoRows) {
		return Account{}, ErrAccountNotFound
	}
	if err != nil {
		return Account{}, fmt.Errorf("find discord identity: %w", err)
	}
	return store.Account(ctx, userID)
}

// ClaimAccountWithDiscord attaches a verified identity and a chosen username.
//
// This is the door that replaces RegisterAccount, and it serves both first-time
// paths: pass the user ID of an anonymous account to upgrade it in place, or
// pass an empty one to mint a fresh account for somebody with no local history
// to keep.
//
// It refuses an account that already has a password. That is not the same
// operation — see LinkDiscordIdentity — and conflating them would let this
// route overwrite the username of an established account.
func (store *Store) ClaimAccountWithDiscord(
	ctx context.Context,
	userID string,
	username string,
	discordUserID string,
	discordUsername string,
) (Account, error) {
	userID = strings.TrimSpace(userID)
	discordUserID = strings.TrimSpace(discordUserID)
	if discordUserID == "" {
		return Account{}, ErrInvalidDiscordIdentity
	}
	username, err := ValidateUsername(username)
	if err != nil {
		return Account{}, err
	}
	handle := storedDiscordHandle(discordUsername)

	transaction, err := store.db.BeginTx(ctx, nil)
	if err != nil {
		return Account{}, fmt.Errorf("claim account: begin transaction: %w", err)
	}
	defer func() { _ = transaction.Rollback() }()

	// Checked explicitly rather than left to the unique index, so the caller
	// gets an error that says which of the two collisions happened. The index
	// stays as the backstop against a race.
	holder, err := discordIdentityHolder(ctx, transaction, discordUserID)
	if err != nil {
		return Account{}, err
	}
	if holder != "" && holder != userID {
		return Account{}, ErrIdentityAlreadyLinked
	}

	now := time.Now().UnixMilli()
	if userID == "" {
		if userID, err = randomToken(16); err != nil {
			return Account{}, err
		}
	}
	// A fresh, discarded profile key rather than an empty one. An empty hash is
	// the "unclaimed, adopt me" marker that EnsureAccountWithProfileKey looks
	// for, so an account created here without one would be adoptable by anyone
	// who read its user ID.
	sealedHash, err := sealedProfileKeyHash()
	if err != nil {
		return Account{}, err
	}
	if _, err := transaction.ExecContext(ctx, `
INSERT INTO accounts (
    user_id, kind, username, discord, profile_key_hash, elo,
    created_at_unix_ms, updated_at_unix_ms
) VALUES (?, ?, ?, '', ?, ?, ?, ?)
ON CONFLICT(user_id) DO NOTHING
`, userID, AccountKindHuman, username, sealedHash, RatingFloor, now, now); err != nil {
		return Account{}, fmt.Errorf("claim account: create account: %w", err)
	}

	var kind, storedPasswordHash, storedDiscordUserID string
	var disabled int
	if err := transaction.QueryRowContext(ctx, `
SELECT kind, disabled, password_hash, discord_user_id FROM accounts WHERE user_id = ?
`, userID).Scan(&kind, &disabled, &storedPasswordHash, &storedDiscordUserID); err != nil {
		return Account{}, fmt.Errorf("claim account: read account: %w", err)
	}
	if disabled != 0 {
		return Account{}, ErrAccountDisabled
	}
	if kind != AccountKindHuman {
		return Account{}, ErrInvalidProfileKey
	}
	if storedDiscordUserID != "" && storedDiscordUserID != discordUserID {
		return Account{}, ErrIdentityAlreadyLinked
	}
	if storedPasswordHash != "" {
		return Account{}, ErrAlreadyRegistered
	}

	if _, err := transaction.ExecContext(ctx, `
UPDATE accounts
SET username = ?, username_lower = ?, discord = ?, discord_user_id = ?,
    discord_linked_at_unix_ms = ?, updated_at_unix_ms = ?
WHERE user_id = ?
`, username, UsernameKey(username), handle, discordUserID, now, now, userID); err != nil {
		return Account{}, claimConflictError(err)
	}
	// The same grant registration used to make, from the new door. A rule
	// enforced on one of two doors is not enforced; the reservation check that
	// guards *reaching* this call lives in the route.
	if err := grantOwnerAdmin(ctx, transaction, userID, username); err != nil {
		return Account{}, err
	}
	if err := transaction.Commit(); err != nil {
		return Account{}, fmt.Errorf("claim account: commit: %w", err)
	}
	return store.Account(ctx, userID)
}

// LinkDiscordIdentity attaches an identity to an account that already has a
// name, which is how a legacy password account migrates.
//
// The password goes in the same transaction as the link. Leaving it would mean
// the account still had two ways in, one of them the way we are retiring.
//
// It deliberately does not revoke sessions. Changing a password did, because
// that is the standard way to evict somebody else who is signed in; linking is
// not that, and signing this player out of their own phone for no visible
// reason is a worse outcome than the hygiene is worth.
func (store *Store) LinkDiscordIdentity(
	ctx context.Context,
	userID string,
	discordUserID string,
	discordUsername string,
) (Account, error) {
	userID = strings.TrimSpace(userID)
	discordUserID = strings.TrimSpace(discordUserID)
	if discordUserID == "" {
		return Account{}, ErrInvalidDiscordIdentity
	}
	handle := storedDiscordHandle(discordUsername)

	transaction, err := store.db.BeginTx(ctx, nil)
	if err != nil {
		return Account{}, fmt.Errorf("link identity: begin transaction: %w", err)
	}
	defer func() { _ = transaction.Rollback() }()

	var kind, storedDiscordUserID string
	var disabled int
	err = transaction.QueryRowContext(ctx, `
SELECT kind, disabled, discord_user_id FROM accounts WHERE user_id = ?
`, userID).Scan(&kind, &disabled, &storedDiscordUserID)
	if errors.Is(err, sql.ErrNoRows) {
		return Account{}, ErrAccountNotFound
	}
	if err != nil {
		return Account{}, fmt.Errorf("link identity: read account: %w", err)
	}
	if disabled != 0 {
		return Account{}, ErrAccountDisabled
	}
	if kind != AccountKindHuman {
		return Account{}, ErrInvalidProfileKey
	}
	// Linking the identity this account already holds is a no-op rather than an
	// error, so that a retried request — a double-tap, a redelivered callback —
	// succeeds instead of confusing somebody who is already done.
	if storedDiscordUserID != "" && storedDiscordUserID != discordUserID {
		return Account{}, ErrIdentityAlreadyLinked
	}
	holder, err := discordIdentityHolder(ctx, transaction, discordUserID)
	if err != nil {
		return Account{}, err
	}
	if holder != "" && holder != userID {
		return Account{}, ErrIdentityAlreadyLinked
	}

	if _, err := transaction.ExecContext(ctx, `
UPDATE accounts
SET discord = ?, discord_user_id = ?, discord_linked_at_unix_ms = ?,
    password_hash = '', password_salt = '', password_algorithm = '',
    password_iterations = 0, updated_at_unix_ms = ?
WHERE user_id = ?
`, handle, discordUserID, time.Now().UnixMilli(), time.Now().UnixMilli(), userID); err != nil {
		return Account{}, claimConflictError(err)
	}
	if err := transaction.Commit(); err != nil {
		return Account{}, fmt.Errorf("link identity: commit: %w", err)
	}
	return store.Account(ctx, userID)
}

// LinkDiscordIdentityWithPassword links an identity to the account a username
// and password name.
//
// This is the same operation as LinkDiscordIdentity, authenticated differently,
// and it exists because of the one path the session-authenticated version
// cannot serve: somebody whose account predates Discord, signed out, pressing
// the Discord button. They have no session to prove which account is theirs and
// no way to get one except the password route they are being moved off — so
// without this the front door has no exit for them, and the naming step they
// land on can only offer them a *second* account.
//
// The password is the proof, which is exactly the proof the password sign-in
// they would otherwise use asks for. Nothing weaker is accepted and nothing is
// created: this either lands on an account that already exists or fails.
//
// An account already linked to Discord has no password left — LinkDiscordIdentity
// clears it — so AuthenticateAccount refuses it, and this route can only ever
// reach the legacy accounts it is for.
func (store *Store) LinkDiscordIdentityWithPassword(
	ctx context.Context,
	username string,
	password string,
	discordUserID string,
	discordUsername string,
) (Account, error) {
	if strings.TrimSpace(discordUserID) == "" {
		return Account{}, ErrInvalidDiscordIdentity
	}
	account, err := store.AuthenticateAccount(ctx, username, password)
	if err != nil {
		return Account{}, err
	}
	return store.LinkDiscordIdentity(ctx, account.UserID, discordUserID, discordUsername)
}

// UsernameCanLinkWithPassword reports whether a name belongs to an account that
// a password would link a Discord identity to.
//
// Only for telling one kind of collision from another *after* a claim has
// already failed, so that somebody who typed the name of their own older
// account is told what to do about it rather than merely told no. It is not a
// pre-flight check and must not be used as one — see SuggestAvailableUsername
// for why the claim itself stays the thing that decides.
//
// The conditions are the ones LinkDiscordIdentityWithPassword will enforce
// anyway, asked here only so the refusal can be the useful one. Offering a
// password box for a name held by an account that has no password — one already
// signing in with Discord — would be a dead end dressed up as a way forward.
func (store *Store) UsernameCanLinkWithPassword(
	ctx context.Context,
	username string,
) (bool, error) {
	var found int
	err := store.db.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM accounts
WHERE username_lower = ? AND kind = ? AND disabled = 0 AND `+awaitingDiscordLinkSQL(""),
		UsernameKey(username), AccountKindHuman,
	).Scan(&found)
	if err != nil {
		return false, fmt.Errorf("check username for a password link: %w", err)
	}
	return found > 0, nil
}

// SuggestAvailableUsername is SuggestUsername plus the database question.
//
// A suggestion the player cannot accept is worse than no suggestion: they press
// the obvious button, are told the name is taken, and have to invent one anyway
// — having been given the impression the work was already done. So availability
// is settled here, before the name is ever shown.
//
// The answer is advisory. Nothing is reserved by asking, and the claim itself
// still races against the unique index, which is where a genuine collision is
// caught.
func (store *Store) SuggestAvailableUsername(
	ctx context.Context,
	candidates ...string,
) (string, error) {
	stem := SuggestUsername(candidates...)
	free, err := store.usernameIsFree(ctx, stem)
	if err != nil {
		return "", err
	}
	if free {
		return stem, nil
	}
	// Sequential first, because "Yuki2" is a name somebody would have picked
	// themselves. It gives up quickly: past a handful of collisions the digits
	// stop reading as a choice and the probing stops being worth the queries.
	for suffix := 2; suffix <= 9; suffix++ {
		candidate := UsernameWithSuffix(stem, strconv.Itoa(suffix))
		free, err := store.usernameIsFree(ctx, candidate)
		if err != nil {
			return "", err
		}
		if free {
			return candidate, nil
		}
	}
	for attempt := 0; attempt < 5; attempt++ {
		token, err := randomToken(3)
		if err != nil {
			return "", err
		}
		candidate := UsernameWithSuffix(stem, sanitizedUsername(token))
		free, err := store.usernameIsFree(ctx, candidate)
		if err != nil {
			return "", err
		}
		if free {
			return candidate, nil
		}
	}
	// Every suggestion collided, which at this point means something stranger
	// than a popular name. Hand back the stem and let the claim fail with a
	// message about the real problem rather than looping here.
	return stem, nil
}

func (store *Store) usernameIsFree(ctx context.Context, username string) (bool, error) {
	if _, err := ValidateUsername(username); err != nil {
		return false, nil
	}
	var taken int
	err := store.db.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM accounts WHERE username_lower = ?`, UsernameKey(username),
	).Scan(&taken)
	if err != nil {
		return false, fmt.Errorf("check username availability: %w", err)
	}
	return taken == 0, nil
}

func discordIdentityHolder(
	ctx context.Context,
	runner interface {
		QueryRowContext(context.Context, string, ...any) *sql.Row
	},
	discordUserID string,
) (string, error) {
	var holder string
	err := runner.QueryRowContext(ctx,
		`SELECT user_id FROM accounts WHERE discord_user_id = ?`, discordUserID,
	).Scan(&holder)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	if err != nil {
		return "", fmt.Errorf("read discord identity holder: %w", err)
	}
	return holder, nil
}

// sealedProfileKeyHash mints a key nobody keeps, for an account that has no
// browser behind it. See the comment at its call site for why an empty hash
// would be the wrong thing to store.
func sealedProfileKeyHash() (string, error) {
	sealed, err := randomToken(32)
	if err != nil {
		return "", err
	}
	hash, err := hashProfileKey(sealed)
	if err != nil {
		return "", fmt.Errorf("seal account: %w", err)
	}
	return hash, nil
}

// claimConflictError tells the two unique indexes apart.
//
// Both guard this write — the username and the snowflake — and answering
// "taken" for the wrong one sends the caller off to fix something that is not
// broken.
func claimConflictError(err error) error {
	if !isUniqueConstraint(err) {
		return fmt.Errorf("claim account: %w", err)
	}
	if strings.Contains(strings.ToLower(err.Error()), "discord") {
		return ErrIdentityAlreadyLinked
	}
	return ErrUsernameTaken
}
