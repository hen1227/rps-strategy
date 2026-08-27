package server

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"rps-strategy/backend/internal/game/spec"
	"rps-strategy/backend/internal/persistence"
)

// The pictures a mode carries.
//
// Two doors in and one out. The doors differ only in where the bytes come from
// — a base64 body, or a URL this server fetches — and they meet at the same
// persistence.StoreArt, which is what makes "an uploaded picture and a fetched
// one are the same picture" true rather than merely intended.
//
// The way out is public and unauthenticated, like the bot icons it is modelled
// on: a picture is drawn by every client watching a game in that mode, most of
// whom have no relationship with the account that uploaded it.

// artRequestLimit is sized for base64, which is a third larger than the bytes
// it carries, plus the JSON around it. Deliberately not routed through
// decodeAPIRequest, which re-applies a 16 KiB cap of its own and would refuse
// every real picture with a message about JSON.
const artRequestLimit = 4 << 20

// artListLimit is how many of an account's pictures are listed at once. An
// agent is choosing something to reuse, not browsing.
const artListLimit = 60

type uploadArtRequest struct {
	Role string `json:"role"`
	Data string `json:"data"`
	URL  string `json:"url"`
}

type artResponse struct {
	Art persistence.ArtAsset `json:"art"`
	// URL is where the picture is served, relative so it works behind any host.
	URL string `json:"url"`
}

func artResponseFor(asset persistence.ArtAsset) artResponse {
	return artResponse{Art: asset, URL: "/api/lab/art/" + asset.ArtID}
}

// postLabArt stores a picture, from bytes or from a URL.
func (server *Server) postLabArt(writer http.ResponseWriter, request *http.Request) {
	account, ok := server.requireRegistered(writer, request)
	if !ok {
		return
	}

	request.Body = http.MaxBytesReader(writer, request.Body, artRequestLimit)
	decoder := json.NewDecoder(request.Body)
	decoder.DisallowUnknownFields()
	var body uploadArtRequest
	if err := decoder.Decode(&body); err != nil {
		writeAPIError(writer, http.StatusBadRequest, "invalid JSON body")
		return
	}

	role := strings.TrimSpace(body.Role)
	if _, known := persistence.ArtRoleLimits[role]; !known {
		writeAPIError(writer, http.StatusBadRequest,
			`a picture goes in a "piece", the "board" or the "cover"`)
		return
	}
	data := strings.TrimSpace(body.Data)
	url := strings.TrimSpace(body.URL)
	if (data == "") == (url == "") {
		writeAPIError(writer, http.StatusBadRequest,
			"send either the picture itself or a url to fetch it from, not both and not neither")
		return
	}

	var raw []byte
	var sourceURL string
	if data != "" {
		if !server.allowArtUpload(writer, request, account.UserID) {
			return
		}
		decoded, err := decodeArtData(data)
		if err != nil {
			writeAPIError(writer, http.StatusBadRequest, err.Error())
			return
		}
		raw = decoded
	} else {
		if !server.allowArtFetch(writer, request, account.UserID) {
			return
		}
		fetched, err := server.artFetcher.fetch(request.Context(), url, persistence.ArtRoleLimits[role])
		if err != nil {
			writeAPIError(writer, http.StatusBadRequest, err.Error())
			return
		}
		raw = fetched
		sourceURL = url
	}

	asset, err := server.data.StoreArt(request.Context(), account.UserID, role, sourceURL, raw)
	switch {
	case errors.Is(err, persistence.ErrArtInvalid):
		writeAPIError(writer, http.StatusBadRequest, strings.TrimPrefix(err.Error(), "artwork rejected: "))
		return
	case errors.Is(err, persistence.ErrTooMuchArt):
		writeAPIError(writer, http.StatusConflict, err.Error())
		return
	case err != nil:
		writeAPIError(writer, http.StatusInternalServerError, "could not store that picture")
		return
	}
	// 201 whether the row was inserted or found. A 200-versus-201 distinction
	// would be an oracle telling a stranger whether a given picture is already
	// on this server, and the caller gains nothing from knowing.
	writeJSON(writer, http.StatusCreated, artResponseFor(asset))
}

// decodeArtData reads base64, with or without the `data:` wrapper an agent will
// usually have. The declared media type is ignored: the magic bytes decide.
func decodeArtData(data string) ([]byte, error) {
	if strings.HasPrefix(data, "data:") {
		_, after, found := strings.Cut(data, ",")
		if !found {
			return nil, errors.New("that data URL has no comma in it")
		}
		data = after
	}
	data = strings.Join(strings.Fields(data), "")
	for _, encoding := range []*base64.Encoding{base64.StdEncoding, base64.RawStdEncoding} {
		if decoded, err := encoding.DecodeString(data); err == nil {
			return decoded, nil
		}
	}
	return nil, errors.New("the picture is not valid base64")
}

// getLabArt serves a picture. Public, like the bot icons.
func (server *Server) getLabArt(writer http.ResponseWriter, request *http.Request) {
	artID := request.PathValue("artID")
	// A malformed id never reaches the database, so scanning garbage is free.
	if !spec.IsArtRef(artID) {
		writeAPIError(writer, http.StatusNotFound, "no picture by that id")
		return
	}
	image, err := server.data.ArtBytes(request.Context(), artID)
	if err != nil {
		// Unknown, malformed and taken down are one answer, for the reason
		// getBotIcon gives: a different answer is an oracle.
		writeAPIError(writer, http.StatusNotFound, "no picture by that id")
		return
	}
	writer.Header().Set("Content-Type", image.MediaType)
	writer.Header().Set("X-Content-Type-Options", "nosniff")
	// Defence in depth. These bytes are a decoded-and-re-encoded PNG or JPEG so
	// they cannot be a document, but this is the one route that serves a
	// stranger's file to every player, and the header costs nothing.
	writer.Header().Set("Content-Security-Policy", "default-src 'none'; sandbox")
	writer.Header().Set("ETag", `"`+image.Digest+`"`)
	// A day, not a year — the one place this deliberately does not copy
	// getBotIcon. The id is a digest so the bytes can never change, which argues
	// for `immutable` forever; but a takedown has to actually take effect, and
	// there is no way to reach into a browser cache. A day keeps the hit rate
	// near perfect within a session and bounds how long a withdrawn picture can
	// still be on somebody's screen.
	writer.Header().Set("Cache-Control", "public, max-age=86400, immutable")
	http.ServeContent(writer, request, image.Filename(),
		time.UnixMilli(image.CreatedAtMs), bytes.NewReader(image.Bytes))
}

// listLabArt is what this account has already uploaded, so a picture can be
// reused rather than sent again.
func (server *Server) listLabArt(writer http.ResponseWriter, request *http.Request) {
	account, ok := server.requireRegistered(writer, request)
	if !ok {
		return
	}
	assets, err := server.data.ArtForAccount(request.Context(), account.UserID, artListLimit)
	if err != nil {
		writeAPIError(writer, http.StatusInternalServerError, "could not list your pictures")
		return
	}
	listed := make([]artResponse, 0, len(assets))
	for _, asset := range assets {
		listed = append(listed, artResponseFor(asset))
	}
	writeJSON(writer, http.StatusOK, map[string]any{"art": listed})
}

/* -------------------------------------------------------- publishing them -- */

// checkModeArt resolves every picture a mode refers to, and answers with the
// ids to pin or with what is wrong.
//
// The three rules, in the order they are worth thinking about:
//
//  1. It has to exist. A reference to nothing is a permanent hole.
//  2. It has to fit the slot the spec puts it in. A picture uploaded as a cover
//     and used as a piece was never checked for being square.
//  3. It has to be yours, or already pinned by some published mode. Ids are
//     digests, so knowing one means knowing the bytes — but without this a
//     stranger could pin somebody's private draft picture into a published mode
//     and publish it on their behalf. The second half of the rule is what still
//     allows forking somebody's published mode, artwork and all.
func (server *Server) checkModeArt(
	ctx context.Context,
	userID string,
	parsed spec.RuleSpec,
) ([]string, []spec.Issue) {
	references := parsed.ArtReferences()
	if len(references) == 0 {
		return nil, nil
	}
	ids := make([]string, 0, len(references))
	for _, reference := range references {
		ids = append(ids, "img:"+reference.ID)
	}
	assets, err := server.data.ArtAssets(ctx, ids)
	if err != nil {
		return nil, []spec.Issue{{Path: "", Message: "could not read this mode's pictures"}}
	}

	issues := make([]spec.Issue, 0, len(references))
	for index, reference := range references {
		asset, found := assets[ids[index]]
		limits := persistence.ArtRoleLimits[reference.Role]
		switch {
		case !found:
			issues = append(issues, spec.Issue{
				Path:    reference.Path,
				Message: "there is no picture with that id; upload it again",
			})
		case limits.Square && asset.Width != asset.Height:
			issues = append(issues, spec.Issue{
				Path: reference.Path,
				Message: fmt.Sprintf("that picture is %dx%d, and a piece's artwork has to be square",
					asset.Width, asset.Height),
			})
		case asset.Width > limits.MaxSide || asset.Height > limits.MaxSide:
			issues = append(issues, spec.Issue{
				Path: reference.Path,
				Message: fmt.Sprintf("that picture is %dx%d, and %s artwork is at most %dx%d",
					asset.Width, asset.Height, reference.Role, limits.MaxSide, limits.MaxSide),
			})
		case limits.PNGOnly && asset.MediaType != "image/png":
			issues = append(issues, spec.Issue{
				Path:    reference.Path,
				Message: "a piece's artwork has to be a PNG, so it can have transparency",
			})
		case asset.UploaderUserID != userID && !asset.Published:
			issues = append(issues, spec.Issue{
				Path:    reference.Path,
				Message: "that picture is somebody else's and has not been published",
			})
		}
	}
	if len(issues) > 0 {
		return nil, issues
	}
	return ids, nil
}

/* --------------------------------------------------------- housekeeping -- */

// artSweepInterval is how often unpinned pictures are reclaimed. Rare on
// purpose: it is a DELETE on the one connection the game loop shares, and
// nothing goes wrong if it is late.
const artSweepInterval = time.Hour

// reclaimArt drops pictures nobody built anything out of, at most hourly.
//
// A draft's artwork has to survive being left alone over a weekend, so what is
// swept is only what is old *and* unpinned — publishing pins, and a published
// mode is immutable, so a pin is forever.
func (server *Server) reclaimArt(ctx context.Context, now time.Time) {
	if now.Sub(server.lastArtSweep) < artSweepInterval {
		return
	}
	server.lastArtSweep = now
	reclaimed, err := server.data.ReclaimUnpinnedArt(ctx, now.Add(-persistence.ArtRetention))
	if err != nil {
		log.Printf("reclaim artwork: %v", err)
		return
	}
	if reclaimed > 0 {
		log.Printf("reclaimed %d unused pictures", reclaimed)
	}
}

/* ----------------------------------------------------- reporting one of them -- */

// artReportReasonLimit matches the ceiling on the other free text a stranger
// can send this server.
const artReportReasonLimit = 300

type reportArtRequest struct {
	Reason string `json:"reason"`
}

// reportLabArt records a complaint about a picture.
//
// requireAnyIdentity, not requireRegistered: uploading needs an account because
// somebody has to be answerable for what is hosted, but *seeing* something
// objectionable is something a guest does, and a guest who cannot report it is
// a guest watching it stay up.
func (server *Server) reportLabArt(writer http.ResponseWriter, request *http.Request) {
	account, ok := server.requireAnyIdentity(writer, request)
	if !ok {
		return
	}
	artID := request.PathValue("artID")
	if !spec.IsArtRef(artID) {
		writeAPIError(writer, http.StatusNotFound, "no picture by that id")
		return
	}
	var body reportArtRequest
	if err := decodeAPIRequest(writer, request, &body); err != nil {
		writeAPIError(writer, http.StatusBadRequest, err.Error())
		return
	}
	reason := strings.TrimSpace(body.Reason)
	if !utf8.ValidString(reason) || utf8.RuneCountInString(reason) > artReportReasonLimit {
		writeAPIError(writer, http.StatusBadRequest,
			fmt.Sprintf("a reason is at most %d characters", artReportReasonLimit))
		return
	}
	if err := server.data.ReportArt(request.Context(), artID, account.UserID, reason); err != nil {
		writeAPIError(writer, http.StatusInternalServerError, "could not record that report")
		return
	}
	// The same answer whether or not the id exists, for the reason serving
	// gives: anything else tells a stranger what is on this server.
	writer.WriteHeader(http.StatusNoContent)
}

/* ------------------------------------------------------------------ admin -- */

func (server *Server) listArtReports(writer http.ResponseWriter, request *http.Request) {
	reports, err := server.data.OpenArtReports(request.Context(), 200)
	if err != nil {
		writeAPIError(writer, http.StatusInternalServerError, "could not read the reports")
		return
	}
	writeJSON(writer, http.StatusOK, map[string]any{"reports": reports})
}

func (server *Server) takeLabArtDown(writer http.ResponseWriter, request *http.Request) {
	artID := request.PathValue("artID")
	if !spec.IsArtRef(artID) {
		writeAPIError(writer, http.StatusNotFound, "no picture by that id")
		return
	}
	var body reportArtRequest
	if err := decodeAPIRequest(writer, request, &body); err != nil {
		writeAPIError(writer, http.StatusBadRequest, err.Error())
		return
	}
	err := server.data.TakeArtDown(request.Context(), artID, body.Reason)
	if errors.Is(err, persistence.ErrArtNotFound) {
		writeAPIError(writer, http.StatusNotFound, "no picture by that id")
		return
	}
	if err != nil {
		writeAPIError(writer, http.StatusInternalServerError, "could not take that picture down")
		return
	}
	writer.WriteHeader(http.StatusNoContent)
}

func (server *Server) keepLabArt(writer http.ResponseWriter, request *http.Request) {
	artID := request.PathValue("artID")
	if !spec.IsArtRef(artID) {
		writeAPIError(writer, http.StatusNotFound, "no picture by that id")
		return
	}
	if err := server.data.KeepArt(request.Context(), artID); err != nil {
		writeAPIError(writer, http.StatusInternalServerError, "could not close those reports")
		return
	}
	writer.WriteHeader(http.StatusNoContent)
}
