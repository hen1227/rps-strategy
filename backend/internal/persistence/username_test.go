package persistence

import (
	"errors"
	"strings"
	"testing"
)

func TestValidateUsernameAcceptsHandlesAndRejectsTraps(t *testing.T) {
	for _, name := range []string{"Ada", "rps_fish", "bot.v2", "MyBot-3", "a1b"} {
		if _, err := ValidateUsername(name); err != nil {
			t.Errorf("%q should be a valid username: %v", name, err)
		}
	}

	for _, testCase := range []struct {
		name   string
		reason string
	}{
		{"ab", "too short"},
		{"", "empty"},
		{"this-name-is-far-too-long-to-be-allowed", "over 32 characters"},
		{"has space", "a username doubles as a tournament IGN, which forbids spaces"},
		{"_leading", "punctuation first reads as decoration, not a name"},
		{".hidden", "a leading dot hides a name in some listings"},
		{"emoji🙂", "outside ASCII"},
		// The important one. SQLite's NOCASE folds ASCII only, so a Cyrillic А
		// would sit beside a Latin A as a separate name and pass every
		// uniqueness check while looking identical to a human.
		{"Аlice", "Cyrillic homoglyph"},
		{"drop;table", "punctuation outside the allowed set"},
	} {
		if _, err := ValidateUsername(testCase.name); !errors.Is(err, ErrInvalidUsername) {
			t.Errorf("%q should be rejected (%s), got %v", testCase.name, testCase.reason, err)
		}
	}
}

func TestUsernameKeyFoldsCaseAndSurroundingSpace(t *testing.T) {
	if UsernameKey("  Ada  ") != "ada" {
		t.Errorf("username key should trim and fold, got %q", UsernameKey("  Ada  "))
	}
	if UsernameKey("MyBot") != UsernameKey("mybot") {
		t.Error("two spellings of one name must share a key")
	}
}

func TestReservedIdentitiesAreMatchedLoosely(t *testing.T) {
	if !IsReservedUsername("henhen1227") {
		t.Error("reserved names must match case-insensitively")
	}
	if !IsReservedContact("@WebGoatGuy") {
		t.Error("a leading @ is how people write a Discord handle")
	}
	if IsReservedUsername("someone") || IsReservedContact("someone-else") {
		t.Error("ordinary names must not be reserved")
	}
	// A username is not a contact handle, and only the second strips a leading
	// "@": stripping it from a username would let "@Henhen1227" through as a
	// name, which is not a name anybody can claim anyway.
	if IsReservedUsername("@Henhen1227") {
		t.Error("the username rule must not strip punctuation it does not allow")
	}
	// The published list must be a copy: a caller that mutates what it is
	// given must not be able to un-reserve a name.
	names := ReservedNames()
	if len(names) == 0 {
		t.Fatal("expected reserved names")
	}
	names[0] = "mutated"
	if IsReservedUsername("mutated") {
		t.Error("ReservedNames must hand out a copy, not the live slice")
	}
}

func TestSuggestUsernameHandlesTheNamesDiscordActuallyProduces(t *testing.T) {
	for _, testCase := range []struct {
		name       string
		candidates []string
		want       string
	}{
		{
			name:       "a display name with a space",
			candidates: []string{"Rock Star", "rockstar"},
			want:       "RockStar",
		},
		{
			name:       "emoji are dropped, the rest survives",
			candidates: []string{"yuki 🎮", "yuki"},
			want:       "yuki",
		},
		{
			name: "an all-emoji display name falls through to the handle",
			// The reason this function takes a list rather than one string.
			candidates: []string{"🎮🎮🎮", "yuki.plays"},
			want:       "yuki.plays",
		},
		{
			name:       "nothing usable at all falls back to a placeholder",
			candidates: []string{"🎮", "??"},
			want:       FallbackUsername,
		},
		{
			name: "a two-character handle is below our minimum",
			// Discord allows two; we require three. Falls through rather than
			// suggesting a name that would be refused on submit.
			candidates: []string{"ab", "abby"},
			want:       "abby",
		},
		{
			name:       "leading punctuation is dropped, not moved",
			candidates: []string{".hidden"},
			want:       "hidden",
		},
		{
			name:       "an over-long name is truncated to the limit",
			candidates: []string{strings.Repeat("a", 40)},
			want:       strings.Repeat("a", MaximumUsernameLength),
		},
		{
			name: "truncation does not strand a separator on the end",
			// 31 characters then a dot: cutting at 32 would leave "...a." which
			// is legal but reads as damage.
			candidates: []string{strings.Repeat("a", 31) + "." + "bbbb"},
			want:       strings.Repeat("a", 31),
		},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			got := SuggestUsername(testCase.candidates...)
			if got != testCase.want {
				t.Fatalf("SuggestUsername(%q) = %q, want %q",
					testCase.candidates, got, testCase.want)
			}
			// Whatever comes out must be something the claim will accept,
			// which is the entire promise of this function.
			if _, err := ValidateUsername(got); err != nil {
				t.Fatalf("suggested a name the rule refuses: %q (%v)", got, err)
			}
		})
	}
}

func TestSuggestAvailableUsernameStepsAroundNamesAlreadyTaken(t *testing.T) {
	store := authTestStore(t)
	ctx := t.Context()

	anonymousAccount(t, store, "holder", "Yuki")
	if _, err := store.ClaimAccountWithDiscord(ctx, "holder", "Yuki", "1", "yuki"); err != nil {
		t.Fatalf("claim: %v", err)
	}

	suggestion, err := store.SuggestAvailableUsername(ctx, "Yuki")
	if err != nil {
		t.Fatalf("suggest: %v", err)
	}
	if suggestion == "Yuki" {
		t.Fatal("suggested a name that is already claimed")
	}
	if suggestion != "Yuki2" {
		t.Fatalf("expected the first free sequential name, got %q", suggestion)
	}
}

func TestSuggestAvailableUsernameKeepsTheSuffixWhenTrimming(t *testing.T) {
	store := authTestStore(t)
	ctx := t.Context()

	long := strings.Repeat("a", MaximumUsernameLength)
	anonymousAccount(t, store, "holder", long)
	if _, err := store.ClaimAccountWithDiscord(ctx, "holder", long, "1", "a"); err != nil {
		t.Fatalf("claim: %v", err)
	}

	suggestion, err := store.SuggestAvailableUsername(ctx, long)
	if err != nil {
		t.Fatalf("suggest: %v", err)
	}
	// The stem is what gives, not the suffix: a stem truncated to the same 32
	// characters as somebody else is exactly the collision being resolved.
	if len(suggestion) > MaximumUsernameLength {
		t.Fatalf("suggestion is over the limit: %q", suggestion)
	}
	if suggestion == long {
		t.Fatal("suggested the taken name unchanged")
	}
	if _, err := ValidateUsername(suggestion); err != nil {
		t.Fatalf("suggested an invalid name %q: %v", suggestion, err)
	}
}
