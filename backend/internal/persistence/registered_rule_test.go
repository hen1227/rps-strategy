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
// One file is sanctioned, and what makes it the only one is that the two
// fragments in it are the definitions rather than copies of them. Both are
// deliberately asking a *narrow* question about credentials — "does this account
// have a password", "is it still on one and unlinked" — rather than the broad
// one this package means by "registered". Everything else that has ever spelled
// the test out by hand meant the broad one and got it wrong.
func TestOnlyTheSharedHelpersDefineRegistered(t *testing.T) {
	const rule = "password_hash <> ''"
	sanctioned := map[string]int{
		// registeredSQL and awaitingDiscordLinkSQL, which build the two
		// fragments everybody else asks for. The second used to be written out
		// at its one call site, and stopped being allowed to be when a second
		// caller wanted it: a predicate about credentials with two hand-written
		// copies is the exact shape this test exists to catch.
		"account_auth.go": 2,
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
