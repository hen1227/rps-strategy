package notation

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"rps-strategy/backend/internal/game"
)

// The worked example in each notation document is the first record a reader
// checks their own parser against, so it has to be a game that could have
// happened: its FinalFEN the board its moves reach, its clocks what its times
// leave. Both documents once showed a FinalFEN from some other game.
func TestTheDocumentedRecordsReplay(t *testing.T) {
	for _, path := range []string{
		filepath.Join("..", "..", "..", "docs", "notation.md"),
		filepath.Join("..", "..", "docs", "pgn.md"),
	} {
		text, err := os.ReadFile(path)
		if err != nil {
			t.Fatalf("read %s: %v", path, err)
		}
		parsed, err := Parse(documentedRecord(t, path, string(text)))
		if err != nil {
			t.Fatalf("%s: the example record does not parse: %v", path, err)
		}
		if err := game.Verify(parsed.Record); err != nil {
			t.Fatalf("%s: the example record does not replay into its own tags: %v", path, err)
		}
	}
}

// documentedRecord is the fenced block in a document that holds a record: the
// one whose first line is a tag pair.
func documentedRecord(t *testing.T, path, text string) string {
	t.Helper()
	blocks := strings.Split(text, "```")
	for index := 1; index < len(blocks); index += 2 {
		body := blocks[index]
		body = body[strings.IndexByte(body, '\n')+1:]
		if strings.HasPrefix(body, "[Event ") {
			return body
		}
	}
	t.Fatalf("%s: no fenced record found", path)
	return ""
}
