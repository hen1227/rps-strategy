package spec

// The rule language, as a document.
//
// Embedded so the server can hand it to the Lab's agent, which learns the format
// from the build that is actually going to validate what it writes rather than
// from whatever it remembers. `go:embed` cannot reach out of its own directory,
// so this is a copy of `docs/rulespec.md` and `language_test.go` fails when the
// two differ — the same arrangement `internal/botclient` lives with, for the same
// reason.

import _ "embed"

//go:embed rulespec.md
var languageReference string

// LanguageReference is docs/rulespec.md. Served at GET /api/lab/language.
func LanguageReference() string { return languageReference }
