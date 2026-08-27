package spec

import "fmt"

// Where a picture can appear in a mode, and what may go there.
//
// One walk over the document, used by two callers that must never disagree:
// the validator, which reports on what it finds, and ArtReferences, which the
// publish route pins. Two walks would drift, and the drift would be a
// reference nobody validated being pinned — or, worse, a reference nobody
// pinned being published and then swept away underneath a live mode.

// ArtSite is one place a mode names a picture.
type ArtSite struct {
	// Path is where it is, in the words the validator reports errors in.
	Path string
	// Value is what the author wrote: a bundled name, an ArtRef, or "".
	Value string
	// Role is which set of limits the picture has to fit.
	Role string
	// Bundled is whether a bundled artwork name is meaningful here. It is only
	// meaningful on a piece; there is no bundled board or cover to name.
	Bundled bool
}

// ArtSites lists every place this mode could name a picture, in document order
// and including the empty ones, so a caller can report on a slot as easily as
// on a value.
func (spec RuleSpec) ArtSites() []ArtSite {
	sites := make([]ArtSite, 0, len(spec.Pieces)+2)
	for index, piece := range spec.Pieces {
		sites = append(sites, ArtSite{
			Path:    fmt.Sprintf("pieces[%d].art", index),
			Value:   piece.Art,
			Role:    ArtRolePiece,
			Bundled: true,
		})
	}
	sites = append(sites,
		ArtSite{Path: "board.art", Value: spec.Board.Art, Role: ArtRoleBoard},
		ArtSite{Path: "cover", Value: spec.Cover, Role: ArtRoleCover},
	)
	return sites
}

// The roles a picture is uploaded under. A role is not a property of the
// image, it is which slot it was made for — which is why it decides the limits
// at upload and is checked again against the slot the spec puts it in, rather
// than being stored on the asset and trusted later.
const (
	ArtRolePiece = "piece"
	ArtRoleBoard = "board"
	ArtRoleCover = "cover"
)

// ArtReference is one uploaded picture a mode depends on.
type ArtReference struct {
	// Path is where the mode refers to it.
	Path string
	// ID is the digest, with the `img:` prefix stripped.
	ID string
	// Role is the slot it is used in, and therefore the limits it has to fit.
	Role string
}

// ArtReferences is every uploaded picture this mode depends on, deduplicated
// by id and keeping the first place each is named.
//
// This is what the publish route pins. Bundled names are not here: they are
// part of the client, not of the library, and nothing has to be kept for them.
func (spec RuleSpec) ArtReferences() []ArtReference {
	seen := make(map[string]bool)
	refs := make([]ArtReference, 0, len(spec.Pieces)+2)
	for _, site := range spec.ArtSites() {
		id := ArtDigest(site.Value)
		if id == "" || seen[id] {
			continue
		}
		seen[id] = true
		refs = append(refs, ArtReference{Path: site.Path, ID: id, Role: site.Role})
	}
	return refs
}
