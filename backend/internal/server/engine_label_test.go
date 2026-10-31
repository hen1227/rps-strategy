package server

import "testing"

// What an engine calls itself is shown beside the bot's name, so a label the
// name filter refuses is dropped, and an ordinary one is kept as it was sent.
func TestAnEngineLabelTheFilterRefusesIsDropped(t *testing.T) {
	if got := filteredEngineLabel("xXshitlordXx"); got != "" {
		t.Fatalf("expected a filtered label to be dropped, got %q", got)
	}
	for _, label := range []string{"RPSFish 0.4.1", "Henry Abrahamsen", "", "v2"} {
		if got := filteredEngineLabel(label); got != label {
			t.Fatalf("expected %q to be kept, got %q", label, got)
		}
	}
}
