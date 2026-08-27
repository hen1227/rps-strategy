package spec

import (
	"os"
	"path/filepath"
	"testing"
)

// The repository shows one document and the server serves another, and they have
// to be the same one: the agent designing a mode is reading what this build will
// judge it by. go:embed cannot reach out of this directory to guarantee that, so
// this test does.
//
// If it fails, copy it across:
//
//	cp docs/rulespec.md backend/internal/game/spec/
func TestTheEmbeddedLanguageReferenceMatchesTheRepositoryCopy(t *testing.T) {
	source := filepath.Join("..", "..", "..", "..", "docs", "rulespec.md")
	canonical, err := os.ReadFile(source)
	if err != nil {
		t.Skipf("the repository copy is not here to compare against: %v", err)
	}
	if string(canonical) != LanguageReference() {
		t.Errorf(
			"the embedded rule-language reference is not docs/rulespec.md.\n" +
				"Run: cp docs/rulespec.md backend/internal/game/spec/",
		)
	}
}
