// Package meafarchive holds the meaf.us game export and the reader for it.
//
// meaf.us runs its own server for this game at https://meaf.us/rps2/, with its
// own players and its own several thousand games, and Meaf shared the archive.
// It is worth having beside this site's: it is entirely human play, it is
// larger than everything this site has recorded, and it is independent -- an
// opening that is popular in both places is popular for a reason better than
// one community's habit.
//
// The file is embedded rather than read from disk. It is a fixed input that
// changes only when somebody sends a new one, so embedding makes the binary the
// whole deployment -- no path to configure, no file to forget to copy, and no
// way for production to be compiling an export that differs from the one the
// tests read. It costs half a megabyte of binary.
//
// Refreshing it is: drop the new export in over this one, run the tests, and
// deploy. TestMeafExportIsReadable is what tells you the new file is intact
// before it reaches production.
package meafarchive

import _ "embed"

// Export is the compact export exactly as meaf.us produced it. See Decode for
// the format.
//
//go:embed games_export.txt
var Export string
