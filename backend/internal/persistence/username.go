package persistence

import (
	"errors"
	"fmt"
	"strings"
)

// Everything that decides whether a name may be used lives here.
//
// It used to live in three places — the WebSocket server, the account screen,
// and the tournament signup form — each with its own copy of the same two
// reserved names. A rule enforced in three copies is a rule that is eventually
// enforced in two, so this is the only copy, and the server publishes it to
// the frontend rather than the frontend restating it.
//
// Two different rules apply to two different things, and conflating them is
// the mistake to avoid:
//
//   - A *display name* is what an anonymous player is called. It is nearly
//     free-form, it is not unique, and `normalizeAccountProfile` owns it.
//   - A *username* is claimed: a registered account or a bot holds it
//     exclusively. It is the rule below.

const (
	// MinimumUsernameLength is short enough for a real handle and long enough
	// that single characters cannot be hoarded.
	MinimumUsernameLength = 3
	// MinimumBotUsernameLength is one shorter, for bots only. A bot's name is
	// its engine's name and those are often two letters, and the hoarding this
	// guards against is a person's problem rather than a bot's: a bot slot
	// costs an account, is capped per owner, and its name is only held while
	// the slot exists.
	MinimumBotUsernameLength = 2
	// MaximumUsernameLength is 32 because a bot's username is also its
	// tournament IGN, and `tournament_players.ign` stops there. A name that
	// could be registered but not entered into an event would be a trap.
	MaximumUsernameLength = 32
)

// ErrInvalidUsername is returned for a name that breaks the rule below.
// ErrUsernameTaken is returned when the name is valid but already claimed.
var (
	ErrInvalidUsername = errors.New("invalid username")
	ErrUsernameTaken   = errors.New("username is already taken")
)

// OwnerUsername is the handle the person who runs this server plays under.
//
// Claiming it already requires the host token — it is reserved, and the only
// way past that is a caller who is already an administrator or who pasted the
// shared secret. So holding this name is not evidence of who somebody is, it
// *is* the check: whoever the host let take it is the host. Granting the admin
// flag with the name closes the gap where the owner had to be handed
// privileges a second time, by a second door, after already proving themselves
// at the first one.
const OwnerUsername = "Henhen1227"

// reservedNames may not be claimed without the host token.
var reservedNames = []string{OwnerUsername, "webgoatguy"}

// IsOwnerUsername reports whether a claimed username is the owner handle.
//
// Case-insensitive, matching UsernameKey: names are unique under that folding,
// so "henhen1227" and "Henhen1227" are the same claim and must be the same
// answer here.
func IsOwnerUsername(username string) bool {
	return UsernameKey(username) == UsernameKey(OwnerUsername)
}

// ReservedNames is the published list, for the frontend to grey out before a
// player types a name it will only be refused for.
func ReservedNames() []string {
	names := make([]string, len(reservedNames))
	copy(names, reservedNames)
	return names
}

// UsernamePattern describes the rule for humans and for a `pattern` attribute.
const UsernamePattern = `^[A-Za-z0-9][A-Za-z0-9_.-]{2,31}$`

// BotUsernamePattern is the same rule one character shorter. Bots do not type
// their name into a field, so this exists to be published rather than applied.
const BotUsernamePattern = `^[A-Za-z0-9][A-Za-z0-9_.-]{1,31}$`

// IsReservedUsername reports whether a name may only be claimed with the host
// token.
//
// The username half of what used to be one check over two fields. They are
// different questions now: a username is claimed here and carries admin, so it
// stays reserved — while a Discord handle arrives already proven by Discord, so
// the impersonation the old rule prevented is no longer possible through it.
// See IsReservedContact for the half that still applies.
func IsReservedUsername(username string) bool {
	value := strings.TrimSpace(username)
	for _, reserved := range reservedNames {
		if strings.EqualFold(value, reserved) {
			return true
		}
	}
	return false
}

// IsReservedContact reports whether a *typed* contact handle is reserved.
//
// Still needed where somebody types a Discord handle into a form — tournament
// signup — because nothing there proves they own it. It must not be applied to
// a handle Discord vouched for: doing so would lock a real Discord user whose
// name happens to match out of the product entirely, to prevent an
// impersonation that verification has already made impossible.
func IsReservedContact(discord string) bool {
	value := strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(discord), "@"))
	for _, reserved := range reservedNames {
		if strings.EqualFold(value, reserved) {
			return true
		}
	}
	return false
}

// ValidateUsername checks a name that is about to be claimed and returns it
// trimmed. It does not check availability; that is a database question and is
// answered by the unique index inside the claiming transaction.
//
// The character set is deliberately narrow ASCII. Two reasons, both practical:
// a username doubles as a tournament IGN, which may not contain spaces; and
// SQLite's NOCASE collation only folds ASCII, so allowing Unicode would let
// "Аlice" with a Cyrillic А sit next to "Alice" as a distinct name and pass
// every uniqueness check we have.
func ValidateUsername(username string) (string, error) {
	return validateUsername(username, MinimumUsernameLength)
}

// ValidateBotUsername is ValidateUsername with the shorter minimum, for a name
// a bot client is claiming for itself.
//
// Only the length differs, and it differs in one direction: every name a person
// may claim a bot may claim too. So this is the same function with the bound
// passed in rather than a second copy of the character rule — the character set
// is the part that uniqueness depends on, and two copies of it would be two
// answers to what "the same name" means.
func ValidateBotUsername(username string) (string, error) {
	return validateUsername(username, MinimumBotUsernameLength)
}

func validateUsername(username string, minimumLength int) (string, error) {
	username = strings.TrimSpace(username)
	if len(username) < minimumLength || len(username) > MaximumUsernameLength {
		return "", fmt.Errorf(
			"%w: must be between %d and %d characters",
			ErrInvalidUsername,
			minimumLength,
			MaximumUsernameLength,
		)
	}
	for index, character := range username {
		switch {
		case character >= 'A' && character <= 'Z',
			character >= 'a' && character <= 'z',
			character >= '0' && character <= '9':
			continue
		case character == '_' || character == '.' || character == '-':
			// A name may not lead with punctuation: "..." and "-" read as
			// decoration rather than as somebody, and a leading dot hides a
			// name in some listings.
			if index == 0 {
				return "", fmt.Errorf(
					"%w: must start with a letter or a digit",
					ErrInvalidUsername,
				)
			}
		default:
			return "", fmt.Errorf(
				"%w: may contain only letters, digits, and _ . -",
				ErrInvalidUsername,
			)
		}
	}
	return username, nil
}

// FallbackUsername is what a name is suggested as when nothing usable can be
// made of the one the player arrived with. It is deliberately plain: the
// suggestion is editable, and a wrong guess dressed up as a real name is worse
// than an obvious placeholder.
const FallbackUsername = "Player"

// SuggestUsername turns the names an identity provider gives us into one this
// system will accept, trying each candidate in turn.
//
// Discord is the reason this exists and it breaks the rule in every direction:
// a display name may hold spaces and emoji, a handle may be two characters
// where the minimum here is three, and neither is unique. So this only ever
// produces a *suggestion* — the player confirms it, and availability is a
// separate question, answered against the database by SuggestAvailableUsername.
func SuggestUsername(candidates ...string) string {
	for _, candidate := range candidates {
		if name := sanitizedUsername(candidate); name != "" {
			return name
		}
	}
	return FallbackUsername
}

// sanitizedUsername returns the candidate reduced to the allowed character set,
// or "" when nothing acceptable is left of it.
func sanitizedUsername(candidate string) string {
	var builder strings.Builder
	for _, character := range candidate {
		switch {
		case character >= 'A' && character <= 'Z',
			character >= 'a' && character <= 'z',
			character >= '0' && character <= '9':
			builder.WriteRune(character)
		case character == '_' || character == '.' || character == '-':
			// Dropped rather than moved when it would lead. A name may not
			// start with punctuation, and shuffling the character elsewhere
			// would suggest a name the player is not actually called.
			if builder.Len() > 0 {
				builder.WriteRune(character)
			}
		}
	}
	name := builder.String()
	if len(name) > MaximumUsernameLength {
		name = name[:MaximumUsernameLength]
	}
	// Truncating can strand a separator on the end. That is legal, but it reads
	// as damage rather than as a name.
	name = strings.TrimRight(name, "_.-")
	if _, err := ValidateUsername(name); err != nil {
		return ""
	}
	return name
}

// UsernameWithSuffix appends a de-duplicating suffix, trimming the stem so the
// result still fits. The suffix is the part that must survive: a stem truncated
// to the same 32 characters as somebody else is exactly the collision being
// resolved.
func UsernameWithSuffix(stem string, suffix string) string {
	if len(stem)+len(suffix) > MaximumUsernameLength {
		stem = stem[:MaximumUsernameLength-len(suffix)]
		stem = strings.TrimRight(stem, "_.-")
	}
	return stem + suffix
}

// UsernameKey is the uniqueness key stored in accounts.username_lower.
//
// Held as its own column rather than computed in a query so the unique index
// can be a plain one, and so Go and SQLite can never disagree about what two
// names being "the same" means.
func UsernameKey(username string) string {
	return strings.ToLower(strings.TrimSpace(username))
}

// UsernamePolicy is published at /api/identity/policy so a client can apply
// the same rule without restating it.
type UsernamePolicy struct {
	MinLength     int      `json:"minLength"`
	MaxLength     int      `json:"maxLength"`
	Pattern       string   `json:"pattern"`
	ReservedNames []string `json:"reservedNames"`
	// BotMinLength and BotPattern are the same rule as it applies to a bot,
	// which may be one character shorter. Published so a page that lists bot
	// names, or documents how to configure one, does not have to restate the
	// exception — and so a client never reports a legal bot name as too short.
	BotMinLength int    `json:"botMinLength"`
	BotPattern   string `json:"botPattern"`
}

// Policy returns the published rule.
func Policy() UsernamePolicy {
	return UsernamePolicy{
		MinLength:     MinimumUsernameLength,
		MaxLength:     MaximumUsernameLength,
		Pattern:       UsernamePattern,
		ReservedNames: ReservedNames(),
		BotMinLength:  MinimumBotUsernameLength,
		BotPattern:    BotUsernamePattern,
	}
}
