package persistence

import (
	"crypto/pbkdf2"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"errors"
	"fmt"
)

// Password hashing for the accounts that still have one.
//
// This file is on its way out. Discord is the only way to create an account
// now, so nothing in production derives a *new* hash any more: hashPassword and
// the length rule below survive because the tests that cover legacy sign-in
// have to build a legacy fixture, and a fixture built with anything other than
// the real derivation would not be testing the real thing. The read path —
// verifyPassword and burnPasswordTime — is still live, and stays until the last
// password account has linked a Discord identity.
//
// The profile key next door is a 256-bit random string, so an unsalted SHA-256
// of it is fine: there is nothing to guess. A password is the opposite — low
// entropy, reused across sites — and needs a deliberately slow, salted
// derivation. The two must never share a code path, which is why they do not
// share a file.
//
// PBKDF2-HMAC-SHA256 from the standard library, rather than bcrypt or argon2
// from golang.org/x/crypto. The backend builds with CGO disabled against a
// pure-Go SQLite and has exactly two direct dependencies; adding a third for
// something the standard library now covers is not worth it. PBKDF2 at OWASP's
// iteration count is a supported answer, not a compromise.

const (
	// passwordAlgorithm is stored per row so a future migration to a different
	// derivation can rehash on next login instead of locking everyone out.
	passwordAlgorithm = "pbkdf2-sha256"
	// defaultPasswordIterations follows OWASP's guidance for PBKDF2-HMAC-SHA256.
	// Stored per row for the same reason as the algorithm: raising the cost
	// later must not invalidate existing hashes.
	defaultPasswordIterations = 600_000
	passwordSaltBytes         = 16
	passwordKeyBytes          = 32

	// MinimumPasswordLength is deliberately low while the game is small and
	// nobody's account is worth stealing. There is no second factor here, so
	// raising it is the obvious hardening step before this is public.
	MinimumPasswordLength = 4
	// MaximumPasswordLength bounds the work an unauthenticated caller can ask
	// for: PBKDF2's cost grows with the password's length through HMAC's key
	// schedule, so an unbounded password is a denial-of-service lever.
	MaximumPasswordLength = 256
)

// ErrInvalidPassword covers a password that fails the length rule.
var ErrInvalidPassword = errors.New("invalid password")

// passwordIterations is the cost new hashes are written with.
//
// A variable rather than a constant only so that tests can turn it down: at
// the production figure a single hash is most of a second, and a test suite
// that registers a dozen accounts would spend ten seconds doing arithmetic
// nobody is measuring. Lowering it is safe because verification reads the
// count back from the row rather than assuming this value, which is the same
// property that lets the cost be raised later.
var passwordIterations = defaultPasswordIterations

// passwordCredential is everything needed to verify one account's password.
// Deliberately not part of Account, which is serialized straight to JSON.
type passwordCredential struct {
	hash       string
	salt       string
	algorithm  string
	iterations int
}

func (credential passwordCredential) isSet() bool {
	return credential.hash != ""
}

// validatePassword applies the length rule before any expensive work.
func validatePassword(password string) error {
	if len(password) < MinimumPasswordLength || len(password) > MaximumPasswordLength {
		return fmt.Errorf(
			"%w: must be between %d and %d characters",
			ErrInvalidPassword,
			MinimumPasswordLength,
			MaximumPasswordLength,
		)
	}
	return nil
}

// hashPassword derives a new credential with a fresh random salt.
func hashPassword(password string) (passwordCredential, error) {
	if err := validatePassword(password); err != nil {
		return passwordCredential{}, err
	}
	salt := make([]byte, passwordSaltBytes)
	if _, err := rand.Read(salt); err != nil {
		return passwordCredential{}, fmt.Errorf("generate password salt: %w", err)
	}
	key, err := pbkdf2.Key(sha256.New, password, salt, passwordIterations, passwordKeyBytes)
	if err != nil {
		return passwordCredential{}, fmt.Errorf("derive password hash: %w", err)
	}
	return passwordCredential{
		hash:       hex.EncodeToString(key),
		salt:       hex.EncodeToString(salt),
		algorithm:  passwordAlgorithm,
		iterations: passwordIterations,
	}, nil
}

// verifyPassword reports whether password derives to the stored hash.
//
// It returns false rather than an error for every kind of mismatch, including
// an unknown algorithm, because the caller must not be able to tell the
// difference and neither must the person on the other end of the request.
func verifyPassword(credential passwordCredential, password string) bool {
	if !credential.isSet() || credential.algorithm != passwordAlgorithm {
		return false
	}
	salt, err := hex.DecodeString(credential.salt)
	if err != nil {
		return false
	}
	iterations := credential.iterations
	if iterations <= 0 {
		iterations = passwordIterations
	}
	key, err := pbkdf2.Key(sha256.New, password, salt, iterations, passwordKeyBytes)
	if err != nil {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(hex.EncodeToString(key)), []byte(credential.hash)) == 1
}

// burnPasswordTime performs the same derivation against a throwaway salt.
//
// Called when the account does not exist or has no password, so that a login
// attempt takes the same time either way. Without it the response time is an
// account-enumeration oracle: the whole point of a slow hash is that skipping
// it is measurable from across the internet.
func burnPasswordTime(password string) {
	salt := make([]byte, passwordSaltBytes)
	_, _ = pbkdf2.Key(sha256.New, password, salt, passwordIterations, passwordKeyBytes)
}
