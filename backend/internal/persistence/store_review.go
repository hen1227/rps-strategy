package persistence

import (
	"context"
	"crypto/rand"
	"database/sql"
	"errors"
	"fmt"
	"math/big"
	"regexp"
	"strings"
	"time"
)

// Store review accounts: the sign-ins handed to App Review and to Google Play's
// reviewers.
//
// Both stores want a working login for anything that sits behind one, and here
// that is a lot: ranked play, blocking, your own bots. Discord cannot be that
// login. A reviewer signing in to Discord from somewhere new is often asked to
// confirm it by email, which they cannot do, and both stores want credentials
// that keep working wherever the reviewer happens to be. So a reviewer gets a
// password account — the one kind no player can create any more — and this
// file is the only place in production that derives a new password hash. It
// only ever derives one for an account it made itself.
//
// Each account belongs to a label, "apple" or "google", so that one store's
// reviewer deleting theirs cannot break the other's. The table remembers the
// name the store has on file, because a reviewer can rename the account and the
// reset has to put it back without being told what it was.
//
// Three rules keep the credentials the stores hold working between reviews:
//
//   - No identity can be linked to one, from any provider. Linking deletes the
//     password (see LinkIdentity), and the password is what the store holds.
//     It would also pin a reviewer's own Discord account or Apple ID to a
//     shared account. A reviewer who signs in with their own Apple ID gets an
//     ordinary account of their own, which is the other way through review.
//   - It cannot be made an administrator. Its password sits in two consoles
//     that other people read.
//   - Deleting it is not refused. Reviewers test account deletion and it has to
//     work, so ResetStoreReviewAccount makes a new account when it finds the old
//     one gone, and says so, because the store then needs the new password.

var (
	// ErrStoreReviewLink refuses every identity on a store review account. What
	// a reviewer reads names the provider — see StoreReviewLinkRefusal — and
	// this is what callers match it on.
	ErrStoreReviewLink = errors.New("this app review account can't link another sign-in")
	// ErrStoreReviewAdmin refuses to promote a store review account.
	ErrStoreReviewAdmin = errors.New("an app review account cannot be an administrator")
	// ErrInvalidStoreReview covers a reset that was asked for wrongly: a bad
	// label, a missing name, a reserved one.
	ErrInvalidStoreReview = errors.New("invalid store review account")
)

// storeReviewLabelPattern is deliberately narrow. A label is one word naming a
// store, typed on a command line, and it ends up in a URL path.
var storeReviewLabelPattern = regexp.MustCompile(`^[a-z][a-z0-9-]{0,31}$`)

// storeReviewPasswordAlphabet leaves out the characters a reviewer could misread
// in a console and then mistype on a phone: 0 and o, 1 and l and i.
const storeReviewPasswordAlphabet = "abcdefghjkmnpqrstuvwxyz23456789"

// StoreReviewAccount is one store's reviewer sign-in, as the admin tools show it.
type StoreReviewAccount struct {
	Label string `json:"label"`
	// Username is the name the store has on file, which every reset puts the
	// account back to. The account can wear a different one in between, if a
	// reviewer renamed it.
	Username string `json:"username"`
	// UserID is empty once the account has been deleted and not yet made again.
	UserID string `json:"userId,omitempty"`
	// SignsIn is whether that name and a password would get somebody in right
	// now: the account exists, still wears the name, is enabled, and has a
	// password. False is what the next reset repairs.
	SignsIn bool `json:"signsIn"`
}

// StoreReviewReset is what one reset did.
//
// Password is the field that matters. It is set only when the password changed,
// this is the only time it is ever shown, and a store still holding the old one
// will fail its next review.
type StoreReviewReset struct {
	StoreReviewAccount
	// Created is a new account: the first reset for this label, or the old
	// account was deleted since the last one.
	Created     bool   `json:"created"`
	RenamedFrom string `json:"renamedFrom,omitempty"`
	ReEnabled   bool   `json:"reEnabled,omitempty"`
	// SessionsRevoked counts the devices signed out, which is every previous
	// reviewer who never signed out themselves.
	SessionsRevoked int64  `json:"sessionsRevoked"`
	Password        string `json:"password,omitempty"`
}

// StoreReviewOptions is what a reset may change beyond repairing the account.
type StoreReviewOptions struct {
	// Username is the name to give the store. Required the first time; after
	// that, empty keeps the one on file and anything else replaces it.
	Username string
	// NewPassword replaces a password that still works. Without it the password
	// only changes when the account had to be made again.
	NewPassword bool
}

func (store *Store) ensureStoreReviewSchema(ctx context.Context) error {
	// user_id goes to NULL when its account row is deleted, which is what
	// AnonymizeAccount does to an account that never finished a game. The label
	// and the name survive that, and the next reset starts again from them.
	const schema = `
CREATE TABLE IF NOT EXISTS store_review_accounts (
    label TEXT PRIMARY KEY,
    username TEXT NOT NULL,
    user_id TEXT UNIQUE REFERENCES accounts(user_id) ON DELETE SET NULL,
    created_at_unix_ms INTEGER NOT NULL,
    updated_at_unix_ms INTEGER NOT NULL
);
`
	if _, err := store.db.ExecContext(ctx, schema); err != nil {
		return fmt.Errorf("migrate store review accounts: %w", err)
	}
	return nil
}

// ResetStoreReviewAccount makes one store's reviewer account, or puts it back
// the way the store was told it is.
//
// Run before every submission. It repairs what a reviewer can change — the
// name, a typed Discord handle, a device still signed in — and what the store
// needs: an enabled account with a password. The password it finds is kept,
// because the store already has it; a new one is made only when the account had
// to be made again, or when asked for.
func (store *Store) ResetStoreReviewAccount(
	ctx context.Context,
	label string,
	options StoreReviewOptions,
) (StoreReviewReset, error) {
	label = strings.TrimSpace(label)
	if !storeReviewLabelPattern.MatchString(label) {
		return StoreReviewReset{}, fmt.Errorf(
			"%w: a label is one lowercase word, such as apple or google", ErrInvalidStoreReview,
		)
	}
	requested := strings.TrimSpace(options.Username)
	if requested != "" {
		cleaned, err := ValidateUsername(requested)
		if err != nil {
			return StoreReviewReset{}, err
		}
		// A reserved name carries admin — the owner handle is granted it the
		// moment it is claimed — and this account's password is read by
		// strangers.
		if IsReservedUsername(cleaned) {
			return StoreReviewReset{}, fmt.Errorf(
				"%w: %s is a reserved name", ErrInvalidStoreReview, cleaned,
			)
		}
		requested = cleaned
	}

	// The derivation is most of a second, so it happens out here rather than
	// inside the transaction, where it would hold the store's one connection
	// while the game loop waits behind it. It is thrown away whenever the reset
	// keeps the password it finds.
	password, err := generateStoreReviewPassword()
	if err != nil {
		return StoreReviewReset{}, err
	}
	credential, err := hashPassword(password)
	if err != nil {
		return StoreReviewReset{}, err
	}

	transaction, err := store.db.BeginTx(ctx, nil)
	if err != nil {
		return StoreReviewReset{}, fmt.Errorf("reset store review account: begin transaction: %w", err)
	}
	defer func() { _ = transaction.Rollback() }()

	var onFile string
	var linked sql.NullString
	err = transaction.QueryRowContext(ctx,
		`SELECT username, user_id FROM store_review_accounts WHERE label = ?`, label,
	).Scan(&onFile, &linked)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return StoreReviewReset{}, fmt.Errorf("reset store review account: read label: %w", err)
	}
	username := requested
	if username == "" {
		username = onFile
	}
	if username == "" {
		return StoreReviewReset{}, fmt.Errorf(
			"%w: the first reset for %q needs a username", ErrInvalidStoreReview, label,
		)
	}

	reset := StoreReviewReset{StoreReviewAccount: StoreReviewAccount{
		Label: label, Username: username, SignsIn: true,
	}}
	now := time.Now().UnixMilli()

	live, err := readStoreReviewAccount(ctx, transaction, linked.String)
	if err != nil {
		return StoreReviewReset{}, err
	}
	if live.userID == "" {
		// The first time, or a reviewer deleted it. A deleted account stays
		// deleted — its games already say "Deleted player" — so this is a new
		// one with the same name, which the unique index refuses if somebody
		// else has claimed the name since.
		userID, err := randomToken(16)
		if err != nil {
			return StoreReviewReset{}, err
		}
		// A fresh, discarded profile key rather than an empty one, for the
		// reason ClaimAccountWithIdentity gives: an empty hash is the "adopt me"
		// marker, and this account has no browser behind it.
		sealedHash, err := sealedProfileKeyHash()
		if err != nil {
			return StoreReviewReset{}, err
		}
		if _, err := transaction.ExecContext(ctx, `
INSERT INTO accounts (
    user_id, kind, username, username_lower, discord, profile_key_hash, elo,
    password_hash, password_salt, password_algorithm, password_iterations,
    password_updated_at_unix_ms, created_at_unix_ms, updated_at_unix_ms
) VALUES (?, ?, ?, ?, '', ?, ?, ?, ?, ?, ?, ?, ?, ?)
`,
			userID, AccountKindHuman, username, UsernameKey(username), sealedHash, RatingStart,
			credential.hash, credential.salt, credential.algorithm, credential.iterations,
			now, now, now,
		); err != nil {
			return StoreReviewReset{}, claimConflictError(err, "")
		}
		reset.UserID = userID
		reset.Created = true
		reset.Password = password
	} else {
		reset.UserID = live.userID
		if live.linked {
			// Nothing should be able to get here: every link path refuses a
			// store review account. Stopping says so, where repairing it would
			// quietly unpin somebody's real Discord account or Apple ID.
			return StoreReviewReset{}, fmt.Errorf(
				"%w: a sign-in identity is linked to %q, which should be impossible; "+
					"delete the account and reset again", ErrInvalidStoreReview, label,
			)
		}
		if live.username != username {
			reset.RenamedFrom = live.username
		}
		reset.ReEnabled = live.disabled
		if _, err := transaction.ExecContext(ctx, `
UPDATE accounts
SET username = ?, username_lower = ?, discord = '', disabled = 0, updated_at_unix_ms = ?
WHERE user_id = ?
`, username, UsernameKey(username), now, live.userID); err != nil {
			return StoreReviewReset{}, claimConflictError(err, "")
		}
		if options.NewPassword || !live.credential.isSet() {
			if _, err := transaction.ExecContext(ctx, `
UPDATE accounts
SET password_hash = ?, password_salt = ?, password_algorithm = ?,
    password_iterations = ?, password_updated_at_unix_ms = ?
WHERE user_id = ?
`,
				credential.hash, credential.salt, credential.algorithm, credential.iterations,
				now, live.userID,
			); err != nil {
				return StoreReviewReset{}, fmt.Errorf("reset store review account: set password: %w", err)
			}
			reset.Password = password
		}
		revoked, err := transaction.ExecContext(ctx,
			`DELETE FROM account_sessions WHERE user_id = ?`, live.userID)
		if err != nil {
			return StoreReviewReset{}, fmt.Errorf("reset store review account: sign out: %w", err)
		}
		reset.SessionsRevoked, _ = revoked.RowsAffected()
	}

	if _, err := transaction.ExecContext(ctx, `
INSERT INTO store_review_accounts (
    label, username, user_id, created_at_unix_ms, updated_at_unix_ms
) VALUES (?, ?, ?, ?, ?)
ON CONFLICT(label) DO UPDATE SET
    username = excluded.username,
    user_id = excluded.user_id,
    updated_at_unix_ms = excluded.updated_at_unix_ms
`, label, username, reset.UserID, now, now); err != nil {
		return StoreReviewReset{}, fmt.Errorf("reset store review account: record label: %w", err)
	}
	if err := transaction.Commit(); err != nil {
		return StoreReviewReset{}, fmt.Errorf("reset store review account: commit: %w", err)
	}
	return reset, nil
}

// storeReviewAccountRow is the part of an account row a reset decides from.
type storeReviewAccountRow struct {
	userID     string
	username   string
	disabled   bool
	linked     bool
	credential passwordCredential
}

// readStoreReviewAccount reads the account a label points at, and answers with
// an empty row when there is nothing live to reset: no account, or one a
// reviewer deleted.
func readStoreReviewAccount(
	ctx context.Context,
	transaction *sql.Tx,
	userID string,
) (storeReviewAccountRow, error) {
	if userID == "" {
		return storeReviewAccountRow{}, nil
	}
	var row storeReviewAccountRow
	var usernameLower, kind string
	var disabled int
	err := transaction.QueryRowContext(ctx, `
SELECT user_id, username, username_lower, kind, disabled, `+hasIdentitySQL("")+`,
       password_hash, password_salt, password_algorithm, password_iterations
FROM accounts WHERE user_id = ?
`, userID).Scan(
		&row.userID, &row.username, &usernameLower, &kind, &disabled, &row.linked,
		&row.credential.hash, &row.credential.salt, &row.credential.algorithm,
		&row.credential.iterations,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return storeReviewAccountRow{}, nil
	}
	if err != nil {
		return storeReviewAccountRow{}, fmt.Errorf("reset store review account: read account: %w", err)
	}
	// An anonymized account keeps its row and loses its name, which is the
	// mark of a reviewer testing deletion. That deletion stands.
	if usernameLower == "" || kind != AccountKindHuman {
		return storeReviewAccountRow{}, nil
	}
	row.disabled = disabled != 0
	return row, nil
}

// StoreReviewAccounts lists every label, with whether its name and password
// would get a reviewer in right now.
func (store *Store) StoreReviewAccounts(ctx context.Context) ([]StoreReviewAccount, error) {
	rows, err := store.db.QueryContext(ctx, `
SELECT r.label, r.username, COALESCE(r.user_id, ''), COALESCE(a.username_lower, ''),
       COALESCE(a.kind, ''), COALESCE(a.disabled, 1), COALESCE(a.password_hash, '')
FROM store_review_accounts r
LEFT JOIN accounts a ON a.user_id = r.user_id
ORDER BY r.label
`)
	if err != nil {
		return nil, fmt.Errorf("list store review accounts: %w", err)
	}
	defer rows.Close()

	accounts := make([]StoreReviewAccount, 0)
	for rows.Next() {
		var account StoreReviewAccount
		var usernameLower, kind string
		var disabled int
		var credential passwordCredential
		if err := rows.Scan(
			&account.Label, &account.Username, &account.UserID, &usernameLower, &kind,
			&disabled, &credential.hash,
		); err != nil {
			return nil, fmt.Errorf("list store review accounts: %w", err)
		}
		account.SignsIn = kind == AccountKindHuman && disabled == 0 &&
			usernameLower == UsernameKey(account.Username) && credential.isSet()
		accounts = append(accounts, account)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("list store review accounts: %w", err)
	}
	return accounts, nil
}

// IsStoreReviewAccount reports whether an account is one of the reviewer
// sign-ins, for the routes that refuse one before any work is done.
func (store *Store) IsStoreReviewAccount(ctx context.Context, userID string) (bool, error) {
	return isStoreReviewAccount(ctx, store.db, userID)
}

func isStoreReviewAccount(
	ctx context.Context,
	runner interface {
		QueryRowContext(context.Context, string, ...any) *sql.Row
	},
	userID string,
) (bool, error) {
	var found int
	if err := runner.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM store_review_accounts WHERE user_id = ?`, strings.TrimSpace(userID),
	).Scan(&found); err != nil {
		return false, fmt.Errorf("check store review account: %w", err)
	}
	return found > 0, nil
}

// generateStoreReviewPassword makes four groups of four from the alphabet
// above: about 79 bits, which is far past guessing through a login that allows
// eight tries a minute, and still something a person can type on a phone.
func generateStoreReviewPassword() (string, error) {
	size := big.NewInt(int64(len(storeReviewPasswordAlphabet)))
	var password strings.Builder
	for index := range 16 {
		if index > 0 && index%4 == 0 {
			password.WriteByte('-')
		}
		pick, err := rand.Int(rand.Reader, size)
		if err != nil {
			return "", fmt.Errorf("generate store review password: %w", err)
		}
		password.WriteByte(storeReviewPasswordAlphabet[pick.Int64()])
	}
	return password.String(), nil
}
