package server

// The mode library, over HTTP.
//
// Publishing is the one route here that changes the world, and it is the
// security boundary for the whole feature: everything a stranger writes arrives
// through it. Four things stand between them and a registered mode — a size cap
// applied before anything is parsed, `DisallowUnknownFields` so a misspelling is
// refused rather than ignored, the same validator the interpreter uses, and a
// token bucket so one account cannot fill the table.
//
// A published mode is immutable and an edit is a new version, which is what
// makes registration one-way: `ModeRegistry.Register` has no opposite, and needs
// none, because a mode once loaded is never wrong.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	"rps-strategy/backend/internal/game"
	"rps-strategy/backend/internal/game/spec"
	"rps-strategy/backend/internal/persistence"
)

// labRequestLimit is generous next to MaxSpecBytes on purpose: the spec is the
// big field, and a request that is only slightly too large should be refused by
// the validator with a message about the spec rather than by the reader with a
// message about bytes.
const labRequestLimit = 64 << 10

var slugPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{1,39}$`)

// ModeIDFor is how a published mode is addressed: `custom:<slug>@<version>`.
//
// The prefix keeps community ids out of the space the built-in modes use, and
// the version is in the id rather than beside it because that is what makes a
// mode immutable — `custom:jumpers@2` is a different mode from `custom:jumpers@1`,
// and a game holding the first is unaffected by the second existing.
func ModeIDFor(slug string, version int) game.ModeID {
	return game.ModeID(fmt.Sprintf("custom:%s@%d", slug, version))
}

/* ------------------------------------------------------------- the language -- */

// getLabLanguage serves the rule-language reference.
//
// The Lab's `lab_describe_language` tool hands this to the agent, so the agent
// learns the format from the same document a person reads — and from the build
// that is actually going to validate what it writes, rather than from whatever
// it remembers.
func (server *Server) getLabLanguage(writer http.ResponseWriter, request *http.Request) {
	_ = request
	writer.Header().Set("Content-Type", "text/markdown; charset=utf-8")
	writer.Header().Set("Cache-Control", "public, max-age=300")
	writer.WriteHeader(http.StatusOK)
	_, _ = writer.Write([]byte(spec.LanguageReference()))
}

/* ------------------------------------------------------------------- modes -- */

type publishModeRequest struct {
	Slug string `json:"slug"`
	// Spec is the whole rule document, exactly as the Lab holds it.
	Spec json.RawMessage `json:"spec"`
	// DerivedFrom names the reusable parts this was built from, for credit. The
	// references themselves are already resolved and inlined by the time a spec
	// is published — see docs/rulespec.md — so this is provenance, not a lookup.
	DerivedFrom []string `json:"derivedFrom,omitempty"`
	Visibility  string   `json:"visibility,omitempty"`
}

type publishModeResponse struct {
	Mode persistence.CustomMode `json:"mode"`
}

func (server *Server) listLabModes(writer http.ResponseWriter, request *http.Request) {
	query := request.URL.Query()
	limit, _ := strconv.Atoi(query.Get("limit"))
	offset, _ := strconv.Atoi(query.Get("offset"))
	owner := query.Get("owner")
	if query.Get("mine") == "1" {
		account, ok := server.requireAnyIdentity(writer, request)
		if !ok {
			return
		}
		owner = account.UserID
	}
	modes, err := server.data.ListModes(request.Context(), query.Get("q"), owner, limit, offset)
	if err != nil {
		writeAPIError(writer, http.StatusInternalServerError, "could not list modes")
		return
	}
	writeJSON(writer, http.StatusOK, map[string]any{"modes": modes})
}

func (server *Server) getLabMode(writer http.ResponseWriter, request *http.Request) {
	mode, err := server.data.Mode(request.Context(), request.PathValue("modeID"))
	if errors.Is(err, persistence.ErrModeNotFound) {
		writeAPIError(writer, http.StatusNotFound, "no mode by that id")
		return
	}
	if err != nil {
		writeAPIError(writer, http.StatusInternalServerError, "could not read that mode")
		return
	}
	writeJSON(writer, http.StatusOK, publishModeResponse{Mode: mode})
}

func (server *Server) publishLabMode(writer http.ResponseWriter, request *http.Request) {
	// Anyone with an identity may publish, guests included: the Lab is meant to
	// be one click from a first visit, and the per-account cap is what keeps
	// "anyone" from meaning "unlimited".
	account, ok := server.requireAnyIdentity(writer, request)
	if !ok {
		return
	}
	if !server.allowModePublish(writer, request, account.UserID) {
		return
	}

	var body publishModeRequest
	request.Body = http.MaxBytesReader(writer, request.Body, labRequestLimit)
	if err := decodeAPIRequest(writer, request, &body); err != nil {
		writeAPIError(writer, http.StatusBadRequest, err.Error())
		return
	}
	slug := strings.ToLower(strings.TrimSpace(body.Slug))
	if !slugPattern.MatchString(slug) {
		writeAPIError(writer, http.StatusBadRequest,
			"a mode's short name is 2 to 40 characters: lower-case letters, digits and dashes")
		return
	}
	if body.Visibility != "" && body.Visibility != "public" && body.Visibility != "unlisted" {
		writeAPIError(writer, http.StatusBadRequest, "visibility is public or unlisted")
		return
	}

	// The same validator the interpreter uses, with the same caps as the Lab's.
	// A spec the Lab accepted and this refused would be a Lab that lied.
	parsed, report := spec.ValidateJSON(body.Spec)
	if err := report.Err(); err != nil {
		writeJSON(writer, http.StatusBadRequest, map[string]any{
			"error":    "that mode's rules are not playable",
			"issues":   report.Errors,
			"warnings": report.Warnings,
		})
		return
	}

	// The pictures the mode refers to have to be there, and have to fit the slot
	// the spec puts them in.
	//
	// Here rather than in spec.Validate, and that is load-bearing: Validate is
	// pure and runs at start-up over every stored mode. If it could fail on a
	// missing picture, taking one down would silently un-publish its mode at the
	// next restart. A published mode outlives its artwork; it just draws letters.
	artIDs, artIssues := server.checkModeArt(request.Context(), account.UserID, parsed)
	if len(artIssues) > 0 {
		writeJSON(writer, http.StatusBadRequest, map[string]any{
			"error":  "that mode's pictures are not ready to publish",
			"issues": artIssues,
		})
		return
	}

	version, err := server.data.NextModeVersion(request.Context(), slug)
	if err != nil {
		writeAPIError(writer, http.StatusInternalServerError, "could not publish that mode")
		return
	}
	modeID := ModeIDFor(slug, version)

	// Registered before it is stored. A mode that cannot be registered is a mode
	// nobody could play, and a row for one would be a row that fails every
	// start-up from here on.
	registered, err := spec.NewMode(modeID, parsed, game.OriginCommunity)
	if err != nil {
		writeAPIError(writer, http.StatusBadRequest, err.Error())
		return
	}

	record := persistence.CustomMode{
		ModeID:      string(modeID),
		Slug:        slug,
		Version:     version,
		OwnerUserID: account.UserID,
		Name:        parsed.Name,
		ShortCode:   parsed.ShortCode,
		Description: parsed.Description,
		Objective:   parsed.Objective,
		Spec:        body.Spec,
		DerivedFrom: body.DerivedFrom,
		Visibility:  body.Visibility,
	}
	if err := server.data.PublishMode(request.Context(), record, artIDs); err != nil {
		switch {
		case errors.Is(err, persistence.ErrTooManyModes):
			writeAPIError(writer, http.StatusConflict,
				fmt.Sprintf("an account may have %d published modes at a time",
					persistence.MaximumModesPerAccount))
		case errors.Is(err, persistence.ErrModeExists):
			writeAPIError(writer, http.StatusConflict, "that mode and version already exist")
		case errors.Is(err, persistence.ErrArtNotFound):
			// Reclaimed between the check above and the insert. Rare, and the
			// foreign key is what makes it a refusal rather than a mode whose
			// pictures are already gone.
			writeAPIError(writer, http.StatusConflict,
				"one of that mode's pictures went away while it was publishing; try again")
		default:
			writeAPIError(writer, http.StatusInternalServerError, "could not publish that mode")
		}
		return
	}
	if err := server.registry.Register(registered.Factory()); err != nil {
		// Stored and unregisterable: the row is fine and this process cannot
		// host it. Say so rather than pretending, and a restart will pick it up.
		log.Printf("publish %s: register: %v", modeID, err)
	}
	server.data.CreditParts(request.Context(), body.DerivedFrom)

	stored, err := server.data.Mode(request.Context(), string(modeID))
	if err != nil {
		writeJSON(writer, http.StatusCreated, publishModeResponse{Mode: record})
		return
	}
	writeJSON(writer, http.StatusCreated, publishModeResponse{Mode: stored})
}

func (server *Server) retireLabMode(writer http.ResponseWriter, request *http.Request) {
	account, ok := server.requireAnyIdentity(writer, request)
	if !ok {
		return
	}
	err := server.data.RetireMode(request.Context(), request.PathValue("modeID"), account.UserID)
	if errors.Is(err, persistence.ErrNotModeOwner) {
		writeAPIError(writer, http.StatusForbidden, "that mode is not yours to retire")
		return
	}
	if err != nil {
		writeAPIError(writer, http.StatusInternalServerError, "could not retire that mode")
		return
	}
	writer.WriteHeader(http.StatusNoContent)
}

/* ------------------------------------------------------------------- parts -- */

type publishPartRequest struct {
	PartID  string          `json:"partId"`
	Kind    string          `json:"kind"`
	Name    string          `json:"name"`
	Summary string          `json:"summary"`
	Params  json.RawMessage `json:"params,omitempty"`
	Body    json.RawMessage `json:"body"`
}

var partKinds = map[string]bool{
	"movement": true, "capture": true, "effect": true,
	"win": true, "draw": true, "turn": true,
}

func (server *Server) listLabParts(writer http.ResponseWriter, request *http.Request) {
	query := request.URL.Query()
	limit, _ := strconv.Atoi(query.Get("limit"))
	parts, err := server.data.ListParts(request.Context(), query.Get("kind"), query.Get("q"), limit)
	if err != nil {
		writeAPIError(writer, http.StatusInternalServerError, "could not list parts")
		return
	}
	writeJSON(writer, http.StatusOK, map[string]any{"parts": parts})
}

func (server *Server) getLabPart(writer http.ResponseWriter, request *http.Request) {
	partID := request.PathValue("partID")
	version := 0
	// `jump@1` addresses a version; `jump` means the newest.
	if name, tail, found := strings.Cut(partID, "@"); found {
		partID = name
		version, _ = strconv.Atoi(tail)
	}
	part, err := server.data.Part(request.Context(), partID, version)
	if errors.Is(err, persistence.ErrPartNotFound) {
		writeAPIError(writer, http.StatusNotFound, "no part by that id")
		return
	}
	if err != nil {
		writeAPIError(writer, http.StatusInternalServerError, "could not read that part")
		return
	}
	writeJSON(writer, http.StatusOK, map[string]any{"part": part})
}

func (server *Server) publishLabPart(writer http.ResponseWriter, request *http.Request) {
	account, ok := server.requireAnyIdentity(writer, request)
	if !ok {
		return
	}
	if !server.allowModePublish(writer, request, account.UserID) {
		return
	}
	var body publishPartRequest
	request.Body = http.MaxBytesReader(writer, request.Body, labRequestLimit)
	if err := decodeAPIRequest(writer, request, &body); err != nil {
		writeAPIError(writer, http.StatusBadRequest, err.Error())
		return
	}
	partID := strings.ToLower(strings.TrimSpace(body.PartID))
	if !slugPattern.MatchString(partID) {
		writeAPIError(writer, http.StatusBadRequest,
			"a part's id is 2 to 40 characters: lower-case letters, digits and dashes")
		return
	}
	if !partKinds[body.Kind] {
		writeAPIError(writer, http.StatusBadRequest, "a part is movement, capture, effect, win, draw or turn")
		return
	}
	if strings.TrimSpace(body.Name) == "" || len([]rune(body.Name)) > 80 {
		writeAPIError(writer, http.StatusBadRequest, "a part needs a name of at most 80 characters")
		return
	}
	if len([]rune(body.Summary)) > 300 {
		writeAPIError(writer, http.StatusBadRequest, "a part's summary is at most 300 characters")
		return
	}
	if len(body.Body) == 0 {
		writeAPIError(writer, http.StatusBadRequest, "a part needs a body")
		return
	}

	version, err := server.data.NextPartVersion(request.Context(), partID)
	if err != nil {
		writeAPIError(writer, http.StatusInternalServerError, "could not publish that part")
		return
	}
	part := persistence.RulePart{
		PartID: partID, Version: version, OwnerUserID: account.UserID,
		Kind: body.Kind, Name: body.Name, Summary: body.Summary,
		Params: body.Params, Body: body.Body,
		PublishedAtMs: time.Now().UnixMilli(),
	}
	if err := server.data.PublishPart(request.Context(), part); err != nil {
		if errors.Is(err, persistence.ErrTooManyRuleParts) {
			writeAPIError(writer, http.StatusConflict,
				fmt.Sprintf("an account may publish %d parts", persistence.MaximumPartsPerAccount))
			return
		}
		writeAPIError(writer, http.StatusInternalServerError, "could not publish that part")
		return
	}
	writeJSON(writer, http.StatusCreated, map[string]any{"part": part})
}

/* ------------------------------------------------------------------ drafts -- */

type saveDraftRequest struct {
	DraftID string          `json:"draftId"`
	Name    string          `json:"name"`
	Spec    json.RawMessage `json:"spec"`
}

func (server *Server) listLabDrafts(writer http.ResponseWriter, request *http.Request) {
	account, ok := server.requireAnyIdentity(writer, request)
	if !ok {
		return
	}
	drafts, err := server.data.Drafts(request.Context(), account.UserID)
	if err != nil {
		writeAPIError(writer, http.StatusInternalServerError, "could not list drafts")
		return
	}
	writeJSON(writer, http.StatusOK, map[string]any{"drafts": drafts})
}

func (server *Server) saveLabDraft(writer http.ResponseWriter, request *http.Request) {
	account, ok := server.requireAnyIdentity(writer, request)
	if !ok {
		return
	}
	var body saveDraftRequest
	request.Body = http.MaxBytesReader(writer, request.Body, labRequestLimit)
	if err := decodeAPIRequest(writer, request, &body); err != nil {
		writeAPIError(writer, http.StatusBadRequest, err.Error())
		return
	}
	if strings.TrimSpace(body.DraftID) == "" || len(body.DraftID) > 64 {
		writeAPIError(writer, http.StatusBadRequest, "a draft needs an id")
		return
	}
	if len(body.Spec) == 0 {
		writeAPIError(writer, http.StatusBadRequest, "a draft needs a spec")
		return
	}
	// Deliberately not validated: a draft is work in progress, and refusing to
	// save one because it is not finished is refusing to save the thing that
	// most needs saving.
	draft := persistence.LabDraft{
		DraftID: body.DraftID, OwnerUserID: account.UserID,
		Name: body.Name, Spec: body.Spec,
	}
	if err := server.data.SaveDraft(request.Context(), draft); err != nil {
		writeAPIError(writer, http.StatusConflict, err.Error())
		return
	}
	writer.WriteHeader(http.StatusNoContent)
}

func (server *Server) deleteLabDraft(writer http.ResponseWriter, request *http.Request) {
	account, ok := server.requireAnyIdentity(writer, request)
	if !ok {
		return
	}
	if err := server.data.DeleteDraft(request.Context(), request.PathValue("draftID"), account.UserID); err != nil {
		writeAPIError(writer, http.StatusInternalServerError, "could not delete that draft")
		return
	}
	writer.WriteHeader(http.StatusNoContent)
}

/* -------------------------------------------------------------- start-up -- */

// loadPublishedModes registers every mode in the library.
//
// A mode that will not load is logged and skipped rather than fatal: one bad row
// — written by an older build of the language, say — should cost that one mode,
// not the server. It stays in the table, so a build that understands it will
// pick it up.
func (server *Server) loadPublishedModes(ctx context.Context) {
	modes, err := server.data.PublishedModes(ctx)
	if err != nil {
		log.Printf("load published modes: %v", err)
		return
	}
	loaded, skipped := 0, 0
	for _, stored := range modes {
		parsed, report := spec.ValidateJSON(stored.Spec)
		if err := report.Err(); err != nil {
			log.Printf("skip mode %s: %v", stored.ModeID, err)
			skipped++
			continue
		}
		mode, err := spec.NewMode(game.ModeID(stored.ModeID), parsed, game.OriginCommunity)
		if err != nil {
			log.Printf("skip mode %s: %v", stored.ModeID, err)
			skipped++
			continue
		}
		// A retired mode keeps its rules and stops taking new games: its archive
		// still replays, and people still hold links to those games.
		if stored.Retired() {
			mode.SetPlayable(false)
		}
		if err := server.registry.Register(mode.Factory()); err != nil {
			log.Printf("skip mode %s: %v", stored.ModeID, err)
			skipped++
			continue
		}
		loaded++
	}
	if loaded > 0 || skipped > 0 {
		log.Printf("mode library: %d loaded, %d skipped", loaded, skipped)
	}
}
