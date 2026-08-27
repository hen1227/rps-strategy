package spec

// Replay the conformance corpus through the authoritative interpreter.
//
// The corpus is recorded by the TypeScript reader in the browser and replayed
// here, so a disagreement between the two is a failing test rather than a player
// being told their legal move is illegal. It is the only thing that actually
// holds them together; the comments cross-referencing each other are a courtesy.
//
// The games are played through a real `game.Game` rather than by calling
// `Mode.Move` directly, and that is the point: repetition, the stalemate draw and
// the turn bookkeeping belong to the engine, and the corpus was recorded with
// them applied. Driving the mode alone would test two thirds of the stack and
// disagree about the last third.

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"rps-strategy/backend/internal/game"
)

type corpusSnapshot struct {
	Rows       string `json:"rows"`
	Territory  string `json:"territory"`
	Turn       string `json:"turn"`
	MoveNumber int    `json:"moveNumber"`
	Status     string `json:"status"`
	Winner     string `json:"winner"`
	EndReason  string `json:"endReason"`
}

type corpusCheck struct {
	Ply        int            `json:"ply"`
	LegalMoves string         `json:"legalMoves"`
	After      corpusSnapshot `json:"after"`
}

type corpusGame struct {
	Spec   string        `json:"spec"`
	Seed   int           `json:"seed"`
	Moves  string        `json:"moves"`
	Checks []corpusCheck `json:"checks"`
}

type corpusFile struct {
	Corpus int                 `json:"corpus"`
	Specs  map[string]RuleSpec `json:"specs"`
	Games  []corpusGame        `json:"games"`
}

const corpusPath = "conformance/corpus.json"

// The browser's copy is the one the recorder writes, and this package cannot
// reach outside its own directory at build time — the same constraint
// internal/botclient lives with. So there are two copies and a test that fails
// when they differ, which is the pattern that keeps docs/bots.md honest.
const browserCorpusPath = "../../../../frontend/src/engine/spec/conformance/corpus.json"

func loadCorpus(t *testing.T) corpusFile {
	t.Helper()
	raw, err := os.ReadFile(corpusPath)
	if err != nil {
		t.Fatalf("read the corpus: %v", err)
	}
	var loaded corpusFile
	if err := json.Unmarshal(raw, &loaded); err != nil {
		t.Fatalf("decode the corpus: %v", err)
	}
	if loaded.Corpus != 1 {
		t.Fatalf("this build reads corpus version 1, got %d", loaded.Corpus)
	}
	return loaded
}

func TestTheCorpusMatchesTheBrowsersCopy(t *testing.T) {
	here, err := os.ReadFile(corpusPath)
	if err != nil {
		t.Fatalf("read %s: %v", corpusPath, err)
	}
	browser, err := os.ReadFile(filepath.FromSlash(browserCorpusPath))
	if err != nil {
		t.Skipf("the browser copy is not here to compare against: %v", err)
	}
	if string(here) != string(browser) {
		t.Errorf(
			"the two copies of the conformance corpus differ.\n"+
				"The browser's is the one the recorder writes. Run:\n"+
				"  cd frontend && npm run build:conformance\n"+
				"  cp frontend/src/engine/spec/conformance/corpus.json %s",
			corpusPath,
		)
	}
}

func TestEverySpecInTheCorpusIsValid(t *testing.T) {
	for name, parsed := range loadCorpus(t).Specs {
		if report := Validate(parsed); !report.Valid() {
			t.Errorf("%s: %v", name, report.Err())
		}
	}
}

// squareName is the corpus's own spelling: files are letters, ranks are numbers.
func parseSquare(t *testing.T, text string) game.Position {
	t.Helper()
	if len(text) < 2 {
		t.Fatalf("%q is not a square", text)
	}
	rank, err := strconv.Atoi(text[1:])
	if err != nil {
		t.Fatalf("%q is not a square: %v", text, err)
	}
	return game.Position{X: int(text[0] - 'a'), Y: rank - 1}
}

func moveName(from, to game.Position) string {
	return game.SquareName(from) + "-" + game.SquareName(to)
}

func snapshotOf(mode *Mode, state game.GameState) corpusSnapshot {
	rows := make([]string, 0, state.Grid.Height())
	owners := make([]string, 0, state.Grid.Height())
	// The mode's own alphabet, because a Lizard is not spelled by the engine's
	// six letters.
	symbols := map[string]byte{}
	for _, piece := range mode.Spec().Pieces {
		symbols[piece.ID] = piece.Symbol[0]
	}
	for _, row := range state.Grid {
		pieces := make([]byte, len(row))
		territory := make([]byte, len(row))
		for x, tile := range row {
			pieces[x] = '.'
			if symbol, known := symbols[string(tile.Occupant)]; known {
				if tile.OccupantOwner == game.Red {
					pieces[x] = symbol + ('a' - 'A')
				} else if tile.OccupantOwner == game.Blue {
					pieces[x] = symbol
				}
			}
			switch tile.OwnerColor {
			case game.Red:
				territory[x] = 'r'
			case game.Blue:
				territory[x] = 'b'
			default:
				territory[x] = '.'
			}
		}
		rows = append(rows, string(pieces))
		owners = append(owners, string(territory))
	}
	return corpusSnapshot{
		Rows:       strings.Join(rows, "/"),
		Territory:  strings.Join(owners, "/"),
		Turn:       string(state.CurrentTurn),
		MoveNumber: state.MoveNumber,
		Status:     string(state.Status),
		Winner:     string(state.Winner),
		EndReason:  string(state.EndReason),
	}
}

// The corpus writes an absent ending as JSON null, which decodes to "".
func normalizeEnding(snapshot corpusSnapshot) corpusSnapshot {
	if snapshot.EndReason == "" {
		snapshot.EndReason = ""
	}
	return snapshot
}

func TestTheCorpusReplaysThroughTheAuthoritativeInterpreter(t *testing.T) {
	loaded := loadCorpus(t)
	for _, replay := range loaded.Games {
		t.Run(fmt.Sprintf("%s/seed-%d", replay.Spec, replay.Seed), func(t *testing.T) {
			parsed, known := loaded.Specs[replay.Spec]
			if !known {
				t.Fatalf("the corpus names a spec it does not carry: %s", replay.Spec)
			}
			modeID := game.ModeID("corpus-" + replay.Spec)
			mode, err := NewMode(modeID, parsed, game.OriginCommunity)
			if err != nil {
				t.Fatal(err)
			}
			registry := game.NewModeRegistry()
			registry.MustRegister(mode.Factory())

			live, err := game.NewGameWithRegistry(
				registry, "corpus", modeID,
				game.PlayerProfile{UserID: "red"}, game.PlayerProfile{UserID: "blue"},
			)
			if err != nil {
				t.Fatal(err)
			}

			checks := map[int]corpusCheck{}
			for _, check := range replay.Checks {
				checks[check.Ply] = check
			}

			moves := []string{}
			if replay.Moves != "" {
				moves = strings.Split(replay.Moves, " ")
			}
			for ply, text := range moves {
				check, checked := checks[ply]
				if checked {
					legal := make([]string, 0, 32)
					for _, move := range live.LegalMoves() {
						legal = append(legal, moveName(move.From, move.To))
					}
					sortStrings(legal)
					if got := strings.Join(legal, " "); got != check.LegalMoves {
						t.Fatalf("ply %d legal moves\n  here:    %s\n  browser: %s",
							ply, got, check.LegalMoves)
					}
				}
				parts := strings.SplitN(text, "-", 2)
				from := parseSquare(t, parts[0])
				to := parseSquare(t, parts[1])
				state, err := live.Move(live.Snapshot().CurrentTurn, from, to)
				if err != nil {
					t.Fatalf("ply %d: %s was refused: %v", ply, text, err)
				}
				if checked {
					got := normalizeEnding(snapshotOf(mode, state))
					want := normalizeEnding(check.After)
					if got != want {
						t.Fatalf("ply %d after %s\n  here:    %+v\n  browser: %+v", ply, text, got, want)
					}
				}
			}
		})
	}
}

func sortStrings(list []string) {
	for i := 1; i < len(list); i++ {
		for j := i; j > 0 && list[j] < list[j-1]; j-- {
			list[j], list[j-1] = list[j-1], list[j]
		}
	}
}
