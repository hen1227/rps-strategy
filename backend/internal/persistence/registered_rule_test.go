package persistence

import (
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
)

// The emptiness test on password_hash has been written out by hand at four
// separate sites over this package's life, and they drifted: the human
// leaderboard filter and the admin badge each kept a private copy of a rule
// that was supposed to have one answer. Discord turned that from untidy into
// wrong, because an account can be real without ever having had a password, so
// a stale copy does not merely duplicate the rule — it answers a different
// question. Apple made it two providers, and the answer a lookup in
// `account_identities` rather than a column.
//
// The tests in this file are what keep the rules in one place. They read the
// package's own source rather than testing behaviour, because the failure they
// guard against is a *new* call site written months from now by somebody who
// never read account_auth.go, and no behavioural test can fail for code that
// does not exist yet.
//
// They inspect string literals through the AST rather than grepping the text,
// so that prose about the rules does not trip them.

// TestOnlyTheSharedHelpersDefineRegistered keeps "registered" in registeredSQL.
//
// One file is sanctioned, and what makes it the only one is that the two
// fragments in it are the definitions rather than copies of them. Both are
// deliberately asking a *narrow* question about credentials — "does this
// account have a password", "is it still on one and unlinked" — rather than the
// broad one this package means by "registered". Everything else that has ever
// spelled the test out by hand meant the broad one and got it wrong.
func TestOnlyTheSharedHelpersDefineRegistered(t *testing.T) {
	assertLiteralConfined(t, "password_hash <> ''", map[string]int{
		// registeredSQL and awaitingIdentityLinkSQL, which build the two
		// fragments everybody else asks for. The second used to be written out
		// at its one call site, and stopped being allowed to be when a second
		// caller wanted it: a predicate about credentials with two hand-written
		// copies is the exact shape this test exists to catch.
		"account_auth.go": 2,
	}, "ask registeredSQL instead, or an account that signs in with Discord or "+
		"Apple will read as unregistered here and registered everywhere else")
}

// TestTheDiscordColumnIsWrittenAndNeverRead keeps the old snowflake column to
// the release it is being retired in.
//
// It is still written beside `account_identities`, so a rolled-back build finds
// every Discord link where it looks. Nothing may read it to decide anything:
// a read of the column would miss every account that signs in with Apple, and
// would go on working right up until the column is dropped. Ask
// discordVerifiedSQL or hasIdentitySQL instead.
func TestTheDiscordColumnIsWrittenAndNeverRead(t *testing.T) {
	assertLiteralConfined(t, "discord_user_id", map[string]int{
		// The column, and the partial unique index that kept one snowflake on
		// one account before the table's primary key did.
		"account_auth.go": 2,
		// The boot reconciliation's two statements, the double write, and the
		// one place a constraint failure on the column is told apart from a
		// taken username.
		"account_identity.go": 4,
		// AnonymizeAccount clearing it, so a rollback does not find a deleted
		// account still holding somebody's Discord.
		"account_admin.go": 1,
	}, "read discordVerifiedSQL or hasIdentitySQL instead; the column misses every "+
		"Apple account and is on its way out")
}

// TestOnlyTheIdentityFilesReadTheIdentityTable keeps the table behind its
// helpers, so the next provider changes one file and not every query that asks
// whether somebody is linked.
func TestOnlyTheIdentityFilesReadTheIdentityTable(t *testing.T) {
	assertLiteralConfinedToFiles(t, "account_identities", []string{
		// The fragments: registeredSQL and the three questions beside it.
		"account_auth.go",
		// The table, its reconciliation, and the linking.
		"account_identity.go",
		// The trigger that queues a revoked token as its row is deleted.
		"identity_revocation.go",
	}, "ask hasIdentitySQL, discordVerifiedSQL or appleLinkedSQL, or add the "+
		"operation to account_identity.go")
}

// assertLiteralConfined fails for any non-test file whose string literals
// mention rule, except the sanctioned ones, which must mention it exactly the
// number of times given — so that a new one needs a reason written here.
func assertLiteralConfined(t *testing.T, rule string, sanctioned map[string]int, advice string) {
	t.Helper()
	for name, lines := range literalsMentioning(t, rule) {
		if allowed, ok := sanctioned[name]; ok {
			if len(lines) != allowed {
				t.Errorf(
					"%s spells out %q in %d string(s) (lines %v), want %d: only the "+
						"sanctioned sites may, and a new one needs a reason here",
					name, rule, len(lines), lines, allowed,
				)
			}
			continue
		}
		t.Errorf("%s spells out %q at line(s) %v; %s", name, rule, lines, advice)
	}
	for name, allowed := range sanctioned {
		if _, found := literalsMentioning(t, rule)[name]; !found && allowed > 0 {
			t.Errorf("%s no longer spells out %q; update the sanctioned count", name, rule)
		}
	}
}

// assertLiteralConfinedToFiles is the same check with no count: the sanctioned
// files own the table and may say its name as often as they need to.
func assertLiteralConfinedToFiles(t *testing.T, rule string, sanctioned []string, advice string) {
	t.Helper()
	allowed := make(map[string]bool, len(sanctioned))
	for _, name := range sanctioned {
		allowed[name] = true
	}
	for name, lines := range literalsMentioning(t, rule) {
		if !allowed[name] {
			t.Errorf("%s spells out %q at line(s) %v; %s", name, rule, lines, advice)
		}
	}
}

// literalsMentioning maps each non-test Go file in this package to the lines of
// the string literals in it that contain rule.
func literalsMentioning(t *testing.T, rule string) map[string][]int {
	t.Helper()
	entries, err := os.ReadDir(".")
	if err != nil {
		t.Fatalf("read package directory: %v", err)
	}
	found := make(map[string][]int)
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
		ast.Inspect(parsed, func(node ast.Node) bool {
			literal, ok := node.(*ast.BasicLit)
			if !ok || literal.Kind != token.STRING {
				return true
			}
			if strings.Contains(literal.Value, rule) {
				found[name] = append(found[name], fileSet.Position(literal.Pos()).Line)
			}
			return true
		})
	}
	for name := range found {
		sort.Ints(found[name])
	}
	return found
}
