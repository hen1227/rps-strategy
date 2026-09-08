//go:build !meaf

package meafarchive

// Export is empty in a build without the `meaf` tag, because
// games_export.txt is not tracked in this repository. See export_meaf.go for
// why, and for how to get the real thing.
//
// Empty is a working value, not a broken one: Decode skips blank lines, so
// Games returns no games and the meaf.us opening segment compiles to nothing.
// The gap is visible in the segment counts rather than silent.
var Export string
