package botclient

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// The greedy yardstick is a rung of the published scale, so what it plays is
// part of the definition of everybody's rating. These drive the actual file the
// server serves, as a subprocess over the real protocol, because that is the
// only way to check the thing that matters — a test against a Go reimplementation
// of the same rules would agree with itself and say nothing about the engine.

// startingPieces and startingTerritory are a fresh board, in the spelling the
// host uses.
const (
	startingPieces    = "3SSS3/3PPP3/3RRR3/9/9/9/3rrr3/3ppp3/3sss3"
	startingTerritory = "3bbb3/3bbb3/3bbb3/9/9/9/3rrr3/3rrr3/3rrr3"
)

// askGreedy runs the engine over one exchange and returns the move it chose.
func askGreedy(t *testing.T, lines ...string) string {
	t.Helper()
	python, err := exec.LookPath("python3")
	if err != nil {
		t.Skip("python3 is not on this machine")
	}
	// The file the server serves, written out rather than read from the source
	// directory, so this cannot pass against a copy the embed does not carry.
	body, _ := GreedyEngine()
	path := filepath.Join(t.TempDir(), "yardstick_greedy.py")
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatalf("write the engine out: %v", err)
	}

	command := exec.Command(python, path)
	command.Stdin = strings.NewReader(strings.Join(lines, "\n") + "\nquit\n")
	output, err := command.Output()
	if err != nil {
		t.Fatalf("run the engine: %v", err)
	}
	for _, line := range strings.Split(string(output), "\n") {
		if move, found := strings.CutPrefix(line, "bestmove "); found {
			return strings.TrimSpace(move)
		}
	}
	t.Fatalf("the engine answered no move: %q", output)
	return ""
}

func TestGreedyAnswersTheHandshakeInEveryMode(t *testing.T) {
	python, err := exec.LookPath("python3")
	if err != nil {
		t.Skip("python3 is not on this machine")
	}
	body, _ := GreedyEngine()
	path := filepath.Join(t.TempDir(), "yardstick_greedy.py")
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatalf("write the engine out: %v", err)
	}
	command := exec.Command(python, path)
	command.Stdin = strings.NewReader("rpsi\nisready\nquit\n")
	output, err := command.Output()
	if err != nil {
		t.Fatalf("run the engine: %v", err)
	}
	said := string(output)
	// Every rated mode, because a rung missing from one is a mode with a hole in
	// its scale — and it would show up as that mode's board being thin rather
	// than as anything looking like this engine's fault.
	for _, expected := range []string{"rpsiok", "readyok", "mode V3", "mode V5", "mode V6"} {
		if !strings.Contains(said, expected) {
			t.Errorf("the handshake did not say %q: %q", expected, said)
		}
	}
}

// The rule the rung is named for.
func TestGreedyTakesTheCaptureWhenThereIsOne(t *testing.T) {
	// A red piece parked on d4, in front of the blue rank on d3.
	board := "3SSS3/3PPP3/3RRR3/3s5/9/9/3rrr3/3ppp3/3sss3"
	move := askGreedy(t,
		"position fen "+board+" b "+startingTerritory,
		"legalmoves e3-e4 d3-d4 f3-f4",
		"go rtime 1000 btime 1000 rinc 0 binc 0",
	)
	if move != "d3-d4" {
		t.Errorf("a capture was on offer and the engine played %q", move)
	}
}

// The board is rebuilt by replaying the move list, so a capture that only exists
// after a few plies has to be found too. This is the half that would break if
// the replay were wrong, and it would break silently — the engine would go on
// answering with legal moves and simply stop being greedy.
func TestGreedyFindsACaptureThatOnlyExistsAfterReplay(t *testing.T) {
	move := askGreedy(t,
		"position fen "+startingPieces+" b "+startingTerritory+" moves d3-d4 d7-d6 d4-d5",
		"legalmoves d5-d6 e3-e4 f3-f4",
		"go rtime 1000 btime 1000 rinc 0 binc 0",
	)
	if move != "d5-d6" {
		t.Errorf("the capture created by the move list was missed; played %q", move)
	}
}

// With nothing to take it plays at random, and at random means uniformly: a
// yardstick that broke the tie by move order would have a strength that depended
// on the order the server generates moves in.
func TestGreedyPlaysUniformlyWhenThereIsNothingToTake(t *testing.T) {
	if testing.Short() {
		t.Skip("spawns a process per sample")
	}
	seen := map[string]int{}
	const rounds = 60
	for range rounds {
		seen[askGreedy(t,
			"position fen "+startingPieces+" b "+startingTerritory,
			"legalmoves d3-d4 e3-e4 f3-f4",
			"go rtime 1000 btime 1000 rinc 0 binc 0",
		)]++
	}
	if len(seen) != 3 {
		t.Fatalf("three moves were legal and %d were ever played: %v", len(seen), seen)
	}
	// A wide bound on purpose. This is checking that nothing is pinned or
	// ignored, not that the generator is good; at sixty samples a third of the
	// time is twenty, and anything inside five and thirty-five is consistent with
	// uniform. A real bias shows up as a zero, which the length check above has
	// already caught.
	for move, count := range seen {
		if count < 5 || count > 35 {
			t.Errorf("%s came up %d times in %d; the choice is not uniform: %v",
				move, count, rounds, seen)
		}
	}
}

// A yardstick must answer in every mode it declared, and the capture rule is the
// same sentence in all three: the server only offers legal moves, and a legal
// move onto an occupied square is a capture whoever it is.
func TestGreedyIsTheSameEngineInEveryMode(t *testing.T) {
	board := "3SSS3/3PPP3/3RRR3/3s5/9/9/3rrr3/3ppp3/3sss3"
	for _, mode := range []string{"V3", "V5", "V6"} {
		move := askGreedy(t,
			"newgame "+mode,
			"position fen "+board+" b "+startingTerritory,
			"legalmoves e3-e4 d3-d4 f3-f4",
			"go rtime 1000 btime 1000 rinc 0 binc 0",
		)
		if move != "d3-d4" {
			t.Errorf("in %s the engine passed up a capture and played %q", mode, move)
		}
	}
}
