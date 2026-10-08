package persistence

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log"
	"strconv"
	"strings"
	"time"
)

// Linking an identity somebody else vouches for — Discord, and Apple beside it —
// to one of our accounts.
//
// The rule that shapes this file is the same one that shaped registration
// before it: an account is *upgraded*, never replaced. Somebody who has been
// clicking around anonymously for months has a user ID, an Elo in three modes,
// and a pile of archived games; signing in attaches an identity to that same
// row.
//
// An identity is a provider and the subject that provider gives this person,
// and it lives in `account_identities` rather than in columns on `accounts`.
// Discord used to have columns — `discord_user_id` and its link time — and a
// second provider written the same way would have meant two more columns,
// another copy of every "is this account linked" test, and a third set for
// Google after it. So the table is keyed by provider and subject, and the
// linking below is written once for all of them. Adding a provider is a
// constant, a way to reach a ticket, and nothing in this file.
//
// The key carries two rules:
//
//   - One identity, one account: the primary key. One Discord login, or one
//     Apple ID, means one player.
//   - One identity per provider per account: UNIQUE (user_id, provider). Two
//     Apple IDs on one account would make "which Apple ID is this" a question
//     with two answers, and nothing needs it.
//
// Discord's handle is not part of the identity. It stays in `accounts.discord`,
// where the profile page and the tournament sign-up already read it, because it
// is only the display form — the thing you type into Discord's search box —
// and Discord lets people change it. Never match on it.
//
// # The Discord columns, for one release
//
// The old columns are still written whenever Discord is linked or cleared, in
// the same transaction as the table. That is what makes this change safe to
// roll back: the build before it reads only the columns, so without the double
// write every Discord link made after the deploy would read as a guest the
// moment the binary went back. Apple has no columns and cannot be helped by
// one — a rolled-back server sees an Apple account as a guest until it rolls
// forward again.
//
// While both are written the columns are the truth for Discord, and the table
// is brought back into line with them at every boot (see
// reconcileDiscordIdentities). That is what keeps a rollback and a roll forward
// from leaving the two disagreeing: whatever the old build did to the columns
// in between is what the table becomes. A later change stops writing the
// columns, and then drops them.

const (
	// ProviderDiscord's subject is the snowflake: stable, unique, and the only
	// field of Discord's user object worth matching on.
	ProviderDiscord = "discord"
	// ProviderApple's subject is Apple's `sub`. Stable for as long as the app
	// stays with the same Apple developer team, and different for every team —
	// so moving the app to another team changes every one of them, and Apple's
	// migration for that has a deadline. Apple gives nothing else here: no name
	// and no email are asked for.
	ProviderApple = "apple"
)

// identityProviders is every provider this server links, in the order an
// account's owner sees them listed.
var identityProviders = []string{ProviderDiscord, ProviderApple}

// knownProvider is whether a string names one of identityProviders. Asked
// before anything is written, because the provider is spliced into SQL as a
// literal by the shared fragments in account_auth.go.
func knownProvider(provider string) bool {
	for _, known := range identityProviders {
		if provider == known {
			return true
		}
	}
	return false
}

// providerIdentityNoun is how a refusal names a provider's identity to the
// person reading it: "that Apple ID", "that Discord account".
func providerIdentityNoun(provider string) string {
	switch provider {
	case ProviderDiscord:
		return "Discord account"
	case ProviderApple:
		return "Apple ID"
	default:
		return "sign-in"
	}
}

// Identity is one provider's answer to "who is this".
type Identity struct {
	Provider string
	Subject  string
	// Handle is the name the provider vouches for, for the provider that has
	// one people look each other up by: Discord's username. Apple has none.
	Handle string
	// RefreshToken is Apple's, from redeeming the authorization code at
	// sign-in. It is kept for one purpose: revoking this app's access when the
	// account is deleted, which Apple asks every app offering its sign-in to
	// do. Empty when that redemption failed, and always for Discord, whose
	// tokens are not kept at all.
	RefreshToken string
	// TokenClientID is the client the refresh token was issued to: the app's
	// bundle id for a sign-in on the phone, the Services ID for one on the
	// website. Apple accepts a revocation only from the client that minted it.
	TokenClientID string
}

// DiscordIdentity is the identity Discord vouched for.
func DiscordIdentity(snowflake string, username string) Identity {
	return Identity{Provider: ProviderDiscord, Subject: snowflake, Handle: username}
}

// AppleIdentity is the identity Apple vouched for, with the token that lets it
// be revoked later. The token is optional: see Identity.RefreshToken.
func AppleIdentity(subject string, refreshToken string, clientID string) Identity {
	return Identity{
		Provider: ProviderApple, Subject: subject,
		RefreshToken: refreshToken, TokenClientID: clientID,
	}
}

// normalized trims an identity and checks it is one this server can store.
func (identity Identity) normalized() (Identity, error) {
	identity.Provider = strings.TrimSpace(identity.Provider)
	identity.Subject = strings.TrimSpace(identity.Subject)
	identity.RefreshToken = strings.TrimSpace(identity.RefreshToken)
	identity.TokenClientID = strings.TrimSpace(identity.TokenClientID)
	if !knownProvider(identity.Provider) || identity.Subject == "" || len(identity.Subject) > 255 {
		return Identity{}, ErrInvalidIdentity
	}
	if identity.Provider == ProviderDiscord {
		identity.Handle = storedDiscordHandle(identity.Handle)
	} else {
		identity.Handle = ""
	}
	// A token is useless without the client that minted it, and a client with
	// no token is nothing to revoke. Kept as a pair or not at all.
	if identity.RefreshToken == "" || identity.TokenClientID == "" {
		identity.RefreshToken, identity.TokenClientID = "", ""
	}
	return identity, nil
}

var (
	// ErrIdentityAlreadyLinked is what every collision between an identity and
	// an account is, underneath its wording: the identity belongs to another
	// account, or this account already holds a different one from the same
	// provider. One identity means one player.
	ErrIdentityAlreadyLinked = errors.New("that sign-in is already linked to another account")
	// ErrInvalidIdentity is returned for an empty or unusable subject, which
	// should only ever happen if a provider's answer was not what we expect.
	ErrInvalidIdentity = errors.New("invalid sign-in identity")
)

// identityRefusal is a refusal that names the provider it is about.
//
// Callers branch on the sentinel, through errors.Is; the person reads the
// message, and "that sign-in is already linked" leaves somebody with two
// sign-ins guessing which one was meant. So each refusal carries both.
type identityRefusal struct {
	sentinel error
	message  string
}

func (refusal *identityRefusal) Error() string { return refusal.message }

func (refusal *identityRefusal) Is(target error) bool { return target == refusal.sentinel }

// identityHeldElsewhere is the identity belonging to some other account.
func identityHeldElsewhere(provider string) error {
	return &identityRefusal{
		sentinel: ErrIdentityAlreadyLinked,
		message:  "that " + providerIdentityNoun(provider) + " is already linked to another account",
	}
}

// accountHoldsAnotherIdentity is this account already holding a different
// identity from the same provider.
func accountHoldsAnotherIdentity(provider string) error {
	return &identityRefusal{
		sentinel: ErrIdentityAlreadyLinked,
		message: "this account is already linked to a different " +
			providerIdentityNoun(provider),
	}
}

// StoreReviewLinkRefusal is a link refused to a store review account. The text
// is what a reviewer reads if they press a link button, so it is written for
// them, and the routes that refuse before a sign-in has even started use it
// too. See store_review.go.
func StoreReviewLinkRefusal(provider string) error {
	object := "another sign-in"
	switch provider {
	case ProviderDiscord:
		object = "Discord"
	case ProviderApple:
		object = "an Apple ID"
	}
	return &identityRefusal{
		sentinel: ErrStoreReviewLink,
		message:  "this app review account can't link " + object,
	}
}

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

func (store *Store) ensureIdentitySchema(ctx context.Context) error {
	// ON DELETE CASCADE because an identity is a fact about one account row
	// and means nothing without it. A cascade does fire the revocation trigger
	// in identity_revocation.go, which is what makes deleting an account the
	// one step that also lets go of its Apple token, whichever path deletes it.
	const schema = `
CREATE TABLE IF NOT EXISTS account_identities (
    provider TEXT NOT NULL,
    subject TEXT NOT NULL,
    user_id TEXT NOT NULL REFERENCES accounts(user_id) ON DELETE CASCADE,
    linked_at_unix_ms INTEGER NOT NULL,
    refresh_token TEXT NOT NULL DEFAULT '',
    token_client_id TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (provider, subject),
    UNIQUE (user_id, provider)
);
`
	if _, err := store.db.ExecContext(ctx, schema); err != nil {
		return fmt.Errorf("migrate account identities: %w", err)
	}
	return store.reconcileDiscordIdentities(ctx)
}

// reconcileDiscordIdentities brings the table into line with the Discord
// columns, which are the truth for Discord while both are written. See the
// note at the top of this file.
//
// On the first boot of this build it is the migration: every linked snowflake
// is copied in. After that it finds nothing to do, unless an older build ran in
// between and linked or cleared somebody through the columns alone — and then
// it carries that across, in both directions, rather than leaving a deleted
// account still holding an identity or a new link invisible.
func (store *Store) reconcileDiscordIdentities(ctx context.Context) error {
	transaction, err := store.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("reconcile discord identities: begin transaction: %w", err)
	}
	defer func() { _ = transaction.Rollback() }()

	stale, err := transaction.ExecContext(ctx, `
DELETE FROM account_identities
WHERE provider = 'discord'
  AND NOT EXISTS (
      SELECT 1 FROM accounts a
      WHERE a.user_id = account_identities.user_id
        AND a.discord_user_id = account_identities.subject
  )
`)
	if err != nil {
		return fmt.Errorf("reconcile discord identities: drop stale links: %w", err)
	}
	added, err := transaction.ExecContext(ctx, `
INSERT INTO account_identities (provider, subject, user_id, linked_at_unix_ms)
SELECT 'discord', a.discord_user_id, a.user_id, a.discord_linked_at_unix_ms
FROM accounts a
WHERE a.discord_user_id <> ''
  AND NOT EXISTS (
      SELECT 1 FROM account_identities i
      WHERE i.provider = 'discord' AND i.subject = a.discord_user_id
  )
`)
	if err != nil {
		return fmt.Errorf("reconcile discord identities: copy links: %w", err)
	}
	if err := transaction.Commit(); err != nil {
		return fmt.Errorf("reconcile discord identities: commit: %w", err)
	}
	dropped, _ := stale.RowsAffected()
	copied, _ := added.RowsAffected()
	if dropped > 0 || copied > 0 {
		// Expected once, on the first boot of this build. Seen again, it means
		// an older build ran in between, which is worth knowing about.
		log.Printf("Discord links: copied %d into account_identities, removed %d stale", copied, dropped)
	}
	return nil
}

// AccountForIdentity finds the account an identity is linked to.
//
// Returns ErrAccountNotFound when nobody holds it, which is the signal that
// this is a first sign-in rather than a returning player.
func (store *Store) AccountForIdentity(
	ctx context.Context,
	provider string,
	subject string,
) (Account, error) {
	identity, err := Identity{Provider: provider, Subject: subject}.normalized()
	if err != nil {
		return Account{}, err
	}
	holder, err := identityHolder(ctx, store.db, identity.Provider, identity.Subject)
	if err != nil {
		return Account{}, err
	}
	if holder == "" {
		return Account{}, ErrAccountNotFound
	}
	return store.Account(ctx, holder)
}

// ClaimAccountWithIdentity attaches a verified identity and a chosen username.
//
// This is the door that replaced RegisterAccount, and it serves both first-time
// paths: pass the user ID of an anonymous account to upgrade it in place, or
// pass an empty one to mint a fresh account for somebody with no local history
// to keep.
//
// It refuses an account that is already registered — a password, or an
// identity of any provider. That is not the same operation — see LinkIdentity
// — and conflating them would let this route overwrite the username of an
// established account. Claiming the one identity the account already holds is
// answered with the account unchanged, so a naming step sent twice does not
// rename anybody.
func (store *Store) ClaimAccountWithIdentity(
	ctx context.Context,
	userID string,
	username string,
	identity Identity,
) (Account, error) {
	userID = strings.TrimSpace(userID)
	identity, err := identity.normalized()
	if err != nil {
		return Account{}, err
	}
	username, err = ValidateUsername(username)
	if err != nil {
		return Account{}, err
	}

	transaction, err := store.db.BeginTx(ctx, nil)
	if err != nil {
		return Account{}, fmt.Errorf("claim account: begin transaction: %w", err)
	}
	defer func() { _ = transaction.Rollback() }()

	// Checked explicitly rather than left to the primary key, so the caller
	// gets an error that says which of the two collisions happened. The key
	// stays as the backstop against a race.
	holder, err := identityHolder(ctx, transaction, identity.Provider, identity.Subject)
	if err != nil {
		return Account{}, err
	}
	if holder != "" && holder != userID {
		return Account{}, identityHeldElsewhere(identity.Provider)
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

	state, err := readLinkState(ctx, transaction, userID, identity.Provider)
	if err != nil {
		return Account{}, err
	}
	if state.disabled {
		return Account{}, ErrAccountDisabled
	}
	if state.kind != AccountKindHuman {
		return Account{}, ErrInvalidProfileKey
	}
	if state.subject == identity.Subject {
		if err := transaction.Commit(); err != nil {
			return Account{}, fmt.Errorf("claim account: commit: %w", err)
		}
		return store.Account(ctx, userID)
	}
	if state.subject != "" {
		return Account{}, accountHoldsAnotherIdentity(identity.Provider)
	}
	if state.registered {
		return Account{}, ErrAlreadyRegistered
	}

	if _, err := transaction.ExecContext(ctx, `
UPDATE accounts SET username = ?, username_lower = ?, updated_at_unix_ms = ? WHERE user_id = ?
`, username, UsernameKey(username), now, userID); err != nil {
		return Account{}, claimConflictError(err, identity.Provider)
	}
	if err := writeIdentityTx(ctx, transaction, userID, identity, now); err != nil {
		return Account{}, err
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

// LinkIdentity attaches an identity to an account that already exists and
// already has a name: a legacy password account migrating, or a signed-in
// player adding a second way in — Apple to an account made with Discord, or the
// other way round.
//
// A password goes in the same transaction as the link. Leaving it would mean
// the account still had two ways in, one of them the way we are retiring. An
// identity the account already holds from another provider is untouched:
// adding Apple does not take Discord away.
//
// It deliberately does not revoke sessions. Changing a password did, because
// that is the standard way to evict somebody else who is signed in; linking is
// not that, and signing this player out of their own phone for no visible
// reason is a worse outcome than the hygiene is worth.
func (store *Store) LinkIdentity(
	ctx context.Context,
	userID string,
	identity Identity,
) (Account, error) {
	userID = strings.TrimSpace(userID)
	identity, err := identity.normalized()
	if err != nil {
		return Account{}, err
	}

	transaction, err := store.db.BeginTx(ctx, nil)
	if err != nil {
		return Account{}, fmt.Errorf("link identity: begin transaction: %w", err)
	}
	defer func() { _ = transaction.Rollback() }()

	state, err := readLinkState(ctx, transaction, userID, identity.Provider)
	if err != nil {
		return Account{}, err
	}
	if state.disabled {
		return Account{}, ErrAccountDisabled
	}
	if state.kind != AccountKindHuman {
		return Account{}, ErrInvalidProfileKey
	}
	// The password this would clear is the one two app stores hold for their
	// reviewers, and the identity would be a reviewer's own. See
	// store_review.go.
	review, err := isStoreReviewAccount(ctx, transaction, userID)
	if err != nil {
		return Account{}, fmt.Errorf("link identity: %w", err)
	}
	if review {
		return Account{}, StoreReviewLinkRefusal(identity.Provider)
	}
	// Linking the identity this account already holds is a no-op rather than an
	// error, so that a retried request — a double-tap, a redelivered callback —
	// succeeds instead of confusing somebody who is already done. It still
	// keeps the newer token, which is the only thing a retry can bring.
	if state.subject == identity.Subject {
		if err := recordIdentityTokenTx(ctx, transaction, identity); err != nil {
			return Account{}, err
		}
		if err := transaction.Commit(); err != nil {
			return Account{}, fmt.Errorf("link identity: commit: %w", err)
		}
		return store.Account(ctx, userID)
	}
	if state.subject != "" {
		return Account{}, accountHoldsAnotherIdentity(identity.Provider)
	}
	holder, err := identityHolder(ctx, transaction, identity.Provider, identity.Subject)
	if err != nil {
		return Account{}, err
	}
	if holder != "" && holder != userID {
		return Account{}, identityHeldElsewhere(identity.Provider)
	}

	now := time.Now().UnixMilli()
	if _, err := transaction.ExecContext(ctx, `
UPDATE accounts
SET password_hash = '', password_salt = '', password_algorithm = '',
    password_iterations = 0, updated_at_unix_ms = ?
WHERE user_id = ?
`, now, userID); err != nil {
		return Account{}, fmt.Errorf("link identity: retire password: %w", err)
	}
	if err := writeIdentityTx(ctx, transaction, userID, identity, now); err != nil {
		return Account{}, err
	}
	if err := transaction.Commit(); err != nil {
		return Account{}, fmt.Errorf("link identity: commit: %w", err)
	}
	return store.Account(ctx, userID)
}

// LinkIdentityWithPassword links an identity to the account a username and
// password name.
//
// This is the same operation as LinkIdentity, authenticated differently, and it
// exists because of the one path the session-authenticated version cannot
// serve: somebody whose account predates Discord, signed out, pressing a
// sign-in button. They have no session to prove which account is theirs and no
// way to get one except the password route they are being moved off — so
// without this the front door has no exit for them, and the naming step they
// land on can only offer them a *second* account.
//
// The password is the proof, which is exactly the proof the password sign-in
// they would otherwise use asks for. Nothing weaker is accepted and nothing is
// created: this either lands on an account that already exists or fails.
//
// An account that already holds an identity has no password left — LinkIdentity
// clears it — so AuthenticateAccount refuses it, and this route can only ever
// reach the legacy accounts it is for.
func (store *Store) LinkIdentityWithPassword(
	ctx context.Context,
	username string,
	password string,
	identity Identity,
) (Account, error) {
	if _, err := identity.normalized(); err != nil {
		return Account{}, err
	}
	account, err := store.AuthenticateAccount(ctx, username, password)
	if err != nil {
		return Account{}, err
	}
	return store.LinkIdentity(ctx, account.UserID, identity)
}

// RecordIdentityToken keeps the newest refresh token for an identity that is
// already linked, which is what a returning sign-in brings.
//
// Overwriting rather than revoking the old one, on purpose. Revoking any of
// Apple's tokens withdraws the player's whole authorization of this app, so
// tidying up an old token would sign them out of the sign-in they just made.
// And a token that was never stored — the code exchange failed the first time —
// is filled in here, by the next sign-in.
func (store *Store) RecordIdentityToken(ctx context.Context, identity Identity) error {
	identity, err := identity.normalized()
	if err != nil {
		return err
	}
	return recordIdentityTokenTx(ctx, store.db, identity)
}

func recordIdentityTokenTx(ctx context.Context, runner statementRunner, identity Identity) error {
	if identity.RefreshToken == "" {
		return nil
	}
	if _, err := runner.ExecContext(ctx, `
UPDATE account_identities SET refresh_token = ?, token_client_id = ?
WHERE provider = ? AND subject = ?
`, identity.RefreshToken, identity.TokenClientID, identity.Provider, identity.Subject); err != nil {
		return fmt.Errorf("record identity token: %w", err)
	}
	return nil
}

// AccountHoldsIdentity reports whether an account has an identity linked, from
// any provider.
//
// Asked of the account a device key names before that key is allowed to say
// which account a sign-in upgrades. A device key proves a guest; an account that
// already holds an identity was upgraded in place and kept the device's key,
// so the key no longer says who is holding the phone.
func (store *Store) AccountHoldsIdentity(ctx context.Context, userID string) (bool, error) {
	var linked bool
	err := store.db.QueryRowContext(ctx,
		`SELECT `+hasIdentitySQL("")+` FROM accounts WHERE user_id = ?`,
		strings.TrimSpace(userID),
	).Scan(&linked)
	if errors.Is(err, sql.ErrNoRows) {
		return false, ErrAccountNotFound
	}
	if err != nil {
		return false, fmt.Errorf("read account identities: %w", err)
	}
	return linked, nil
}

// SignInMethods is what an account signs in with, as its owner's Account
// screen needs to know it.
//
// It is never part of the account itself, which GET /api/accounts/{id} serves
// to anybody. How somebody signs in is theirs to know, and the answer would
// also point at the store review accounts, whose names are kept out of sight
// because knowing one is enough to keep a reviewer locked out.
type SignInMethods struct {
	// Methods names the providers linked to the account, in the order the
	// Account screen lists them.
	Methods []string `json:"methods"`
	// AwaitingLink is a password account that has not linked an identity yet:
	// the account the "Link your Discord" prompt is for. It is
	// awaitingIdentityLinkSQL, so a store review account, which is on a
	// password for good and is refused a link, is never told to make one.
	AwaitingLink bool `json:"awaitingLink"`
	// CanLink is whether a link would be accepted at all. False for a store
	// review account, so its screen offers no button the server will refuse.
	CanLink bool `json:"canLink"`
}

// SignInMethods reads an account's sign-in methods.
func (store *Store) SignInMethods(ctx context.Context, userID string) (SignInMethods, error) {
	userID = strings.TrimSpace(userID)
	var awaiting, review bool
	err := store.db.QueryRowContext(ctx, `
SELECT `+awaitingIdentityLinkSQL("")+`,
       EXISTS (SELECT 1 FROM store_review_accounts r WHERE r.user_id = accounts.user_id)
FROM accounts WHERE user_id = ?
`, userID).Scan(&awaiting, &review)
	if errors.Is(err, sql.ErrNoRows) {
		return SignInMethods{}, ErrAccountNotFound
	}
	if err != nil {
		return SignInMethods{}, fmt.Errorf("read sign-in methods: %w", err)
	}
	linked, err := store.linkedProviders(ctx, userID)
	if err != nil {
		return SignInMethods{}, err
	}
	methods := SignInMethods{Methods: []string{}, AwaitingLink: awaiting, CanLink: !review}
	for _, provider := range identityProviders {
		if linked[provider] {
			methods.Methods = append(methods.Methods, provider)
		}
	}
	return methods, nil
}

func (store *Store) linkedProviders(ctx context.Context, userID string) (map[string]bool, error) {
	rows, err := store.db.QueryContext(ctx,
		`SELECT provider FROM account_identities WHERE user_id = ?`, userID)
	if err != nil {
		return nil, fmt.Errorf("read linked providers: %w", err)
	}
	defer rows.Close()
	linked := make(map[string]bool)
	for rows.Next() {
		var provider string
		if err := rows.Scan(&provider); err != nil {
			return nil, fmt.Errorf("read linked provider: %w", err)
		}
		linked[provider] = true
	}
	return linked, rows.Err()
}

// UsernameCanLinkWithPassword reports whether a name belongs to an account that
// a password would link an identity to.
//
// Only for telling one kind of collision from another *after* a claim has
// already failed, so that somebody who typed the name of their own older
// account is told what to do about it rather than merely told no. It is not a
// pre-flight check and must not be used as one — see SuggestAvailableUsername
// for why the claim itself stays the thing that decides.
//
// The conditions are the ones LinkIdentityWithPassword will enforce anyway,
// asked here only so the refusal can be the useful one. Offering a password box
// for a name held by an account that has no password — one already signing in
// with Discord or Apple — would be a dead end dressed up as a way forward.
func (store *Store) UsernameCanLinkWithPassword(
	ctx context.Context,
	username string,
) (bool, error) {
	var found int
	err := store.db.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM accounts
WHERE username_lower = ? AND kind = ? AND disabled = 0 AND `+awaitingIdentityLinkSQL(""),
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

// rowQuerier is the part of *sql.DB and *sql.Tx a single-row read needs.
type rowQuerier interface {
	QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row
}

// identityHolder names the account an identity is linked to, or "" for none.
func identityHolder(
	ctx context.Context,
	runner rowQuerier,
	provider string,
	subject string,
) (string, error) {
	var holder string
	err := runner.QueryRowContext(ctx,
		`SELECT user_id FROM account_identities WHERE provider = ? AND subject = ?`,
		provider, subject,
	).Scan(&holder)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	if err != nil {
		return "", fmt.Errorf("read identity holder: %w", err)
	}
	return holder, nil
}

// linkState is what a claim or a link decides from: the account, and the
// subject it already holds from the provider being linked, if any.
type linkState struct {
	kind       string
	disabled   bool
	registered bool
	subject    string
}

func readLinkState(
	ctx context.Context,
	transaction *sql.Tx,
	userID string,
	provider string,
) (linkState, error) {
	var state linkState
	var disabled int
	err := transaction.QueryRowContext(ctx, `
SELECT kind, disabled, `+registeredSQL("")+`,
       COALESCE((SELECT subject FROM account_identities i
                  WHERE i.user_id = accounts.user_id AND i.provider = ?), '')
FROM accounts WHERE user_id = ?
`, provider, userID).Scan(&state.kind, &disabled, &state.registered, &state.subject)
	if errors.Is(err, sql.ErrNoRows) {
		return linkState{}, ErrAccountNotFound
	}
	if err != nil {
		return linkState{}, fmt.Errorf("read account for link: %w", err)
	}
	state.disabled = disabled != 0
	return state, nil
}

// writeIdentityTx records a link: the row, and for Discord the handle and the
// old columns beside it. See the note at the top of this file for why both.
func writeIdentityTx(
	ctx context.Context,
	transaction *sql.Tx,
	userID string,
	identity Identity,
	now int64,
) error {
	if _, err := transaction.ExecContext(ctx, `
INSERT INTO account_identities (
    provider, subject, user_id, linked_at_unix_ms, refresh_token, token_client_id
) VALUES (?, ?, ?, ?, ?, ?)
`,
		identity.Provider, identity.Subject, userID, now,
		identity.RefreshToken, identity.TokenClientID,
	); err != nil {
		return claimConflictError(err, identity.Provider)
	}
	if identity.Provider != ProviderDiscord {
		return nil
	}
	if _, err := transaction.ExecContext(ctx, `
UPDATE accounts
SET discord = ?, discord_user_id = ?, discord_linked_at_unix_ms = ?, updated_at_unix_ms = ?
WHERE user_id = ?
`, identity.Handle, identity.Subject, now, now, userID); err != nil {
		return claimConflictError(err, identity.Provider)
	}
	return nil
}

// deleteAccountIdentitiesTx lets go of every identity an account holds, for
// the two paths that remove a person: anonymizing and purging.
//
// Deleting the rows is also what queues the revocation of any Apple token they
// held — the trigger in identity_revocation.go does it, in the same
// transaction, so the deletion and the promise to tell Apple commit together or
// not at all. The Discord columns are cleared by the caller's own write, which
// already rewrites the row.
func deleteAccountIdentitiesTx(ctx context.Context, transaction *sql.Tx, userID string) error {
	if _, err := transaction.ExecContext(ctx,
		`DELETE FROM account_identities WHERE user_id = ?`, userID,
	); err != nil {
		return fmt.Errorf("delete account identities: %w", err)
	}
	return nil
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

// claimConflictError tells the unique indexes apart.
//
// Several guard a claim — the username, the identity, the one-per-provider
// rule, and Discord's old column — and answering "taken" for the wrong one
// sends the caller off to fix something that is not broken.
func claimConflictError(err error, provider string) error {
	if !isUniqueConstraint(err) {
		return fmt.Errorf("claim account: %w", err)
	}
	message := strings.ToLower(err.Error())
	switch {
	case strings.Contains(message, "account_identities.user_id"):
		return accountHoldsAnotherIdentity(provider)
	case strings.Contains(message, "account_identities"),
		strings.Contains(message, "discord_user_id"):
		return identityHeldElsewhere(provider)
	default:
		return ErrUsernameTaken
	}
}
