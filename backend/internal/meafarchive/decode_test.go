package meafarchive

import "testing"

// The export is an asset compiled into the binary, so the thing worth pinning
// is that the file is intact and the decoder still agrees with the encoder that
// wrote it. A new export drops in over the old one and this is what says
// whether it arrived in one piece.
//
// The counts are the current file's. They are meant to be edited when the
// export is replaced -- a diff that changes them is a diff that changed the
// data, which is exactly the change worth seeing in a review.
func TestMeafExportIsReadable(t *testing.T) {
	games := Games()
	if len(games) != 4972 {
		t.Fatalf("decoded %d games, want 4972", len(games))
	}
	counts := map[Result]int{}
	moves, named := 0, 0
	for _, game := range games {
		counts[game.Result]++
		moves += len(game.Moves)
		if game.BlueUsername != "" && game.RedUsername != "" {
			named++
		}
	}
	for result, want := range map[Result]int{
		BlueWin: 2602, RedWin: 1831, Draw: 192, Unfinished: 347,
	} {
		if counts[result] != want {
			t.Errorf("%s: %d games, want %d", result, counts[result], want)
		}
	}
	if moves != 255274 {
		t.Errorf("decoded %d moves in total, want 255274", moves)
	}
	// Nine games came through without a name on one side or the other, which
	// is a fact about the source rather than a decoding failure -- the format
	// spells an absent name "-" and means it.
	if named != 4963 {
		t.Errorf("%d games carry both usernames, want 4963", named)
	}
}

// The first line of the export, decoded by hand from the file, so a change to
// the unpacking is caught by something other than a total.
//
// Its first two moves are Blue's b5-a6 and Red's e7-d8, which is what makes
// this a useful vector: it pins the bit order, the origin encoding and the
// direction table all at once, and it pins that Blue moves first.
func TestMeafDecodesAKnownGame(t *testing.T) {
	first := Games()[0]
	if first.Result != Draw {
		t.Fatalf("result %q, want a draw", first.Result)
	}
	if first.BlueUsername != "webgoatguy" || first.RedUsername != "hhhhhh_" {
		t.Fatalf("players %q and %q", first.BlueUsername, first.RedUsername)
	}
	for index, want := range []string{"b5-a6", "e7-d8", "b4-a5", "f8-e7"} {
		if first.Moves[index] != want {
			t.Fatalf("move %d is %q, want %q", index, first.Moves[index], want)
		}
	}
}

// A file that is not the export fails loudly rather than decoding to something
// plausible. The packing cannot express a move to a non-adjacent square, so
// corruption surfaces as a move off the board -- which is checked, rather than
// being allowed to become a game nobody played.
func TestMeafRejectsAMalformedExport(t *testing.T) {
	for name, export := range map[string]string{
		"unknown result":    "x webgoatguy hhhhhh_ Sp0D",
		"wrong field count": "d webgoatguy Sp0D extra field",
		"not base64":        "d webgoatguy hhhhhh_ !!!!",
	} {
		if _, err := Decode(export); err == nil {
			t.Errorf("%s: decoded without complaint", name)
		}
	}
	// A blank line is not corruption -- a trailing newline is how the file
	// ends -- so it is skipped rather than rejected.
	games, err := Decode("d webgoatguy hhhhhh_ Sp0D\n\n")
	if err != nil {
		t.Fatalf("a trailing blank line was rejected: %v", err)
	}
	if len(games) != 1 {
		t.Fatalf("decoded %d games from one line and a blank", len(games))
	}
}
