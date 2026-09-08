package persistence

import (
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// The emptiness test on password_hash has been written out by hand at four
// separate sites over this package's life, and they drifted: the human
// leaderboard filter and the admin badge each kept a private copy of a rule
// that was supposed to have one answer. Discord turns that from untidy into
// wrong, because an account can now be real without ever having had a
// password, so a stale copy does not merely duplicate the rule — it answers a
// different question.
//
// registeredSQL and accountIsRegistered are therefore the only two places
// allowed to know what "registered" means, and this test is what keeps it that
// way. It reads the package's own source rather than testing behaviour,
// because the failure it guards against is a *new* call site written months
// from now by somebody who never read this file, and no behavioural test can
// fail for code that does not exist yet.
//
// It inspects string literals through the AST rather than grepping the text, so
// that prose about the rule does not trip it.
//
// Two sites are sanctioned, and the distinction between them and everybody else
// is the point: these two are deliberately asking the *narrow* question — "does
// this account have a password" — rather than the broad one this package means
// by "registered". Everything else that has ever spelled the test out by hand
// meant the broad one and got it wrong.
func TestOnlyTheSharedHelpersDefineRegistered(t *testing.T) {
	const rule = "password_hash <> ''"
	sanctioned := map[string]int{
		// registeredSQL, which builds the fragment everybody else asks for.
		"account_auth.go": 1,
		// reportPasswordAccountsRemaining, which counts how much of the
		// password era is left. It genuinely wants accounts that have a
		// password *and* no identity — the one question registeredSQL cannot
		// answer, because it is the inverse of what registeredSQL is for.
		"sqlite.go": 1,
	}

	entries, err := os.ReadDir(".")
	if err != nil {
		t.Fatalf("read package directory: %v", err)
	}
	for _, entry := range entries {
		name := entry.Name()
		if entry.IsDir() || filepath.Ext(name) != ".go" || strings.HasSuffix(name, "_test.go") {
			continue
		}

		fileSet := token.NewFileSet()
		parsed, err := parser.ParseFile(fileSet, name, nil, 0)
		if err != nil {
			t.Fatalf("parse %s: %v", name, err)
		}
		var lines []int
		ast.Inspect(parsed, func(node ast.Node) bool {
			literal, ok := node.(*ast.BasicLit)
			if !ok || literal.Kind != token.STRING {
				return true
			}
			if strings.Contains(literal.Value, rule) {
				lines = append(lines, fileSet.Position(literal.Pos()).Line)
			}
			return true
		})

		if allowed, ok := sanctioned[name]; ok {
			if len(lines) != allowed {
				t.Errorf(
					"%s spells out %q in %d string(s) (lines %v), want %d: only the "+
						"sanctioned narrow tests may, and a new one needs a reason here",
					name, rule, len(lines), lines, allowed,
				)
			}
			continue
		}
		if len(lines) != 0 {
			t.Errorf(
				"%s spells out %q at line(s) %v; ask registeredSQL or "+
					"accountIsRegistered instead, or a Discord account will read "+
					"as unregistered here and registered everywhere else",
				name, rule, lines,
			)
		}
	}
}
