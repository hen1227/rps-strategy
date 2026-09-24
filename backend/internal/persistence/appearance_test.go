package persistence

import (
	"errors"
	"testing"
)

// The shape is the whole of what this column enforces. It deliberately does not
// know that "forest" is a theme, so these are the only rules there are.
func TestNormalizeAppearanceGuardsTheShapeAndNothingElse(t *testing.T) {
	for _, testCase := range []struct {
		name  string
		input string
		want  string
	}{
		{name: "empty clears", input: "", want: ""},
		{name: "blank clears", input: "   ", want: ""},
		{
			name:  "keys are sorted so equal choices store equal bytes",
			input: `{"sound":"silent","theme":"midnight"}`,
			want:  `{"sound":"silent","theme":"midnight"}`,
		},
		{
			name:  "reordered input stores identically",
			input: `{"theme":"midnight","sound":"silent"}`,
			want:  `{"sound":"silent","theme":"midnight"}`,
		},
		{
			name:  "empty values are dropped rather than stored",
			input: `{"theme":"forest","board":""}`,
			want:  `{"theme":"forest"}`,
		},
		{name: "an object of empty values clears", input: `{"theme":""}`, want: ""},
		{
			// The point of the whole design: a preset this build has never
			// heard of is stored without complaint, because the catalogue lives
			// in the client and the client may be newer than the server.
			name:  "an unknown preset id is accepted",
			input: `{"theme":"a-theme-shipped-next-year"}`,
			want:  `{"theme":"a-theme-shipped-next-year"}`,
		},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			got, err := normalizeAppearance(testCase.input)
			if err != nil {
				t.Fatalf("normalizeAppearance(%q): %v", testCase.input, err)
			}
			if got != testCase.want {
				t.Fatalf("normalizeAppearance(%q) = %q, want %q", testCase.input, got, testCase.want)
			}
		})
	}

	for _, testCase := range []struct {
		name  string
		input string
	}{
		{name: "not JSON", input: "forest"},
		{name: "not an object", input: `["forest"]`},
		{name: "values that are not strings", input: `{"theme":3}`},
		{name: "a field this format does not have", input: `{"cursor":"crosshair"}`},
		{name: "an id long enough to be storage", input: `{"theme":"` + longID(65) + `"}`},
		{name: "a body long enough to be storage", input: `{"theme":"` + longID(600) + `"}`},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			if _, err := normalizeAppearance(testCase.input); !errors.Is(err, ErrBadAppearance) {
				t.Fatalf("expected %q to be refused, got %v", testCase.input, err)
			}
		})
	}
}

func longID(length int) string {
	id := make([]byte, length)
	for index := range id {
		id[index] = 'a'
	}
	return string(id)
}

func TestSetAccountAppearanceRoundTrips(t *testing.T) {
	store, err := Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	ctx := t.Context()

	if _, err := store.EnsureAccountWithProfileKey(
		ctx, "look-user", "Guest", testProfileKey,
	); err != nil {
		t.Fatal(err)
	}

	// A guest, deliberately: choosing a look is not something you should have to
	// register to keep.
	updated, err := store.SetAccountAppearance(
		ctx, "look-user", `{"theme":"parchment","board":"walnut"}`,
	)
	if err != nil {
		t.Fatal(err)
	}
	if updated.Appearance != `{"board":"walnut","theme":"parchment"}` {
		t.Fatalf("unexpected stored appearance: %q", updated.Appearance)
	}

	// It has to come back on every ordinary read of the account, since that is
	// what the socket sends on connect.
	reread, err := store.Account(ctx, "look-user")
	if err != nil {
		t.Fatal(err)
	}
	if reread.Appearance != updated.Appearance {
		t.Fatalf("appearance did not survive a re-read: %q", reread.Appearance)
	}

	cleared, err := store.SetAccountAppearance(ctx, "look-user", "")
	if err != nil {
		t.Fatal(err)
	}
	if cleared.Appearance != "" {
		t.Fatalf("expected clearing to empty the column, got %q", cleared.Appearance)
	}

	if _, err := store.SetAccountAppearance(ctx, "nobody", `{"theme":"forest"}`); !errors.Is(
		err, ErrAccountNotFound,
	) {
		t.Fatalf("expected a missing account to be reported, got %v", err)
	}
}
