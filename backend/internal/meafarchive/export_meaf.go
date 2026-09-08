//go:build meaf

package meafarchive

import _ "embed"

// Export is the compact export exactly as meaf.us produced it. See Decode for
// the format.
//
// This file is behind the `meaf` build tag because games_export.txt is not
// tracked: the games are public, but they are Meaf's to publish, and this
// repository is not the place that does it. Deploys build with -tags meaf and
// get the real archive; a clone without the file builds and tests clean and
// simply has no meaf.us segment. See export_stub.go.
//
//go:embed games_export.txt
var Export string
