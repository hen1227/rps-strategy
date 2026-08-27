package botclient

import (
	"os"
	"path/filepath"
	"testing"
)

// The website renders what this package embeds, and the repository shows what
// is in docs/. Those have to be the same document, and go:embed cannot reach
// out of this directory to guarantee it — so this test does.
//
// If it fails, copy the files across:
//
//	cp docs/bots.md docs/rpsi.md backend/internal/botclient/
func TestEmbeddedDocsMatchTheRepositoryCopies(t *testing.T) {
	for _, testCase := range []struct {
		name     string
		embedded string
		source   string
	}{
		{"bots.md", Guide(), filepath.Join("..", "..", "..", "docs", "bots.md")},
		{"rpsi.md", Protocol(), filepath.Join("..", "..", "..", "docs", "rpsi.md")},
	} {
		canonical, err := os.ReadFile(testCase.source)
		if err != nil {
			t.Fatalf("read %s: %v", testCase.source, err)
		}
		if string(canonical) != testCase.embedded {
			t.Errorf(
				"backend/internal/botclient/%s has drifted from %s.\n"+
					"Run: cp docs/bots.md docs/rpsi.md backend/internal/botclient/",
				testCase.name, testCase.source,
			)
		}
	}
}
