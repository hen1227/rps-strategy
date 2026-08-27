package server

import (
	"bytes"
	"errors"
	"net/http"
	"regexp"
	"strings"
	"time"

	"rps-strategy/backend/internal/botclient"
	"rps-strategy/backend/internal/persistence"
)

type updateBotRequest struct {
	Description      string `json:"description"`
	AllowPublicPlay  bool   `json:"allowPublicPlay"`
	EnterTournaments bool   `json:"enterTournaments"`
}

// mintedBotResponse carries the token exactly once. It is never readable
// again: only its hash is stored, so a lost token is rotated rather than
// looked up.
type mintedBotResponse struct {
	Bot   persistence.Bot `json:"bot"`
	Token string          `json:"token"`
}

// createBot mints an unclaimed bot slot for the signed-in owner.
func (server *Server) createBot(writer http.ResponseWriter, request *http.Request) {
	account, ok := server.requireSession(writer, request)
	if !ok {
		return
	}
	bot, token, err := server.data.MintBotToken(request.Context(), account.UserID)
	if err != nil {
		writeBotError(writer, err)
		return
	}
	writeJSON(writer, http.StatusCreated, mintedBotResponse{Bot: bot, Token: token})
}

// ownedBot is a registry row with the two things about it that are not in the
// registry: whether anybody is running it right now, and the graceful shutdown
// it is under if they are.
//
// Both are connection state, so neither can be a column — see bot_shutdown.go.
// Overlaid here rather than fetched separately because the whole point of this
// list is that an owner sees the state of their bots in one place, and a page
// that has to ask twice can show the two halves disagreeing.
type ownedBot struct {
	persistence.Bot
	Online bool           `json:"online"`
	Drain  *BotDrainState `json:"drain,omitempty"`
}

// listMyBots includes unclaimed slots, because an owner needs to see the slot
// they have not finished setting up.
func (server *Server) listMyBots(writer http.ResponseWriter, request *http.Request) {
	account, ok := server.requireSession(writer, request)
	if !ok {
		return
	}
	bots, err := server.data.BotsForOwner(request.Context(), account.UserID)
	if err != nil {
		writeBotError(writer, err)
		return
	}

	entries := make([]ownedBot, 0, len(bots))
	for _, bot := range bots {
		server.mu.RLock()
		client := server.bots[bot.BotID]
		server.mu.RUnlock()
		entry := ownedBot{Bot: bot, Online: client != nil}
		if client != nil && botIsDraining(client) {
			state := server.botDrainState(client)
			entry.Drain = &state
		}
		entries = append(entries, entry)
	}

	writeJSON(writer, http.StatusOK, map[string]any{
		"bots":      entries,
		"limit":     persistence.MaximumBotsPerAccount,
		"remaining": max(persistence.MaximumBotsPerAccount-len(bots), 0),
	})
}

// listBots is the public directory: every claimed, enabled bot, with the ones
// currently connected marked as online.
func (server *Server) listBots(writer http.ResponseWriter, request *http.Request) {
	bots, err := server.data.Bots(request.Context())
	if err != nil {
		writeBotError(writer, err)
		return
	}
	online := make(map[string]bool)
	for _, presence := range server.botRoster() {
		online[presence.BotID] = true
	}
	type directoryEntry struct {
		persistence.Bot
		Online bool `json:"online"`
	}
	entries := make([]directoryEntry, 0, len(bots))
	for _, bot := range bots {
		entries = append(entries, directoryEntry{Bot: bot, Online: online[bot.BotID]})
	}
	writeJSON(writer, http.StatusOK, entries)
}

// updateBot changes the settings the website is allowed to change while a bot
// is running. The owner's config file re-asserts its own values on the bot's
// next connect, which is documented rather than prevented.
func (server *Server) updateBot(writer http.ResponseWriter, request *http.Request) {
	bot, ok := server.requireBotOwner(writer, request)
	if !ok {
		return
	}
	var input updateBotRequest
	if err := decodeAPIRequest(writer, request, &input); err != nil {
		writeAPIError(writer, http.StatusBadRequest, err.Error())
		return
	}
	updated, err := server.data.UpdateBotSettings(
		request.Context(), bot.BotID,
		input.AllowPublicPlay, input.EnterTournaments, input.Description,
	)
	if err != nil {
		writeBotError(writer, err)
		return
	}
	server.refreshBotRecord(updated)
	writeJSON(writer, http.StatusOK, updated)
}

// rotateBotToken issues a replacement secret, keeping the bot's account,
// rating and history. This is the answer to a lost config file.
func (server *Server) rotateBotToken(writer http.ResponseWriter, request *http.Request) {
	bot, ok := server.requireBotOwner(writer, request)
	if !ok {
		return
	}
	token, err := server.data.RotateBotToken(request.Context(), bot.BotID)
	if err != nil {
		writeBotError(writer, err)
		return
	}
	// The bot running on the old token is now holding a secret that will not
	// work again, so close it rather than leaving it apparently healthy.
	server.disconnectBot(bot.BotID, "this bot's token was rotated")
	writeJSON(writer, http.StatusOK, mintedBotResponse{Bot: bot, Token: token})
}

func (server *Server) deleteBot(writer http.ResponseWriter, request *http.Request) {
	bot, ok := server.requireBotOwner(writer, request)
	if !ok {
		return
	}
	if err := server.data.RetireBot(request.Context(), bot.BotID); err != nil {
		writeBotError(writer, err)
		return
	}
	server.disconnectBot(bot.BotID, "this bot has been retired")
	writeJSON(writer, http.StatusOK, map[string]bool{"retired": true})
}

// getBotIcon serves a bot's picture, and is public because that picture is
// drawn everywhere the bot's name is.
//
// The digest travels with the bot in every list, so callers ask for
// `?v=<digest>` and that answer keeps for ever: a changed icon is a changed
// URL. A request without it, or with a stale one, gets a minute instead —
// long enough to be worth a cache, short enough that an owner who has just
// fixed their artwork is not looking at the old one all year.
func (server *Server) getBotIcon(writer http.ResponseWriter, request *http.Request) {
	icon, err := server.data.BotIcon(request.Context(), request.PathValue("botID"))
	if err != nil {
		writeBotError(writer, err)
		return
	}
	writer.Header().Set("Content-Type", "image/png")
	// The bytes were re-encoded from a decoded image, so they are a PNG
	// whatever was uploaded — but this is the one route that serves a file
	// somebody else supplied, and the header costs nothing.
	writer.Header().Set("X-Content-Type-Options", "nosniff")
	writer.Header().Set("ETag", `"`+icon.SHA256+`"`)
	if request.URL.Query().Get("v") == icon.SHA256 {
		writer.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	} else {
		writer.Header().Set("Cache-Control", "public, max-age=60")
	}
	// ServeContent for the conditional request handling: a lobby with a dozen
	// bots in it revalidates a dozen icons on every reload.
	http.ServeContent(
		writer, request, "icon.png",
		time.UnixMilli(icon.UpdatedAtUnixMs), bytes.NewReader(icon.PNG),
	)
}

// requireBotOwner resolves the bot in the path and proves the caller may act
// on it, which is either owning it or being an administrator.
func (server *Server) requireBotOwner(
	writer http.ResponseWriter,
	request *http.Request,
) (persistence.Bot, bool) {
	bot, err := server.data.Bot(request.Context(), request.PathValue("botID"))
	if err != nil {
		writeBotError(writer, err)
		return persistence.Bot{}, false
	}
	if server.requestIsAdmin(request) {
		return bot, true
	}
	account, ok := server.requireSession(writer, request)
	if !ok {
		return persistence.Bot{}, false
	}
	if account.UserID != bot.OwnerUserID {
		// Not 403: an owner should not be able to enumerate other people's
		// bot ids by watching which ones answer differently.
		writeAPIError(writer, http.StatusNotFound, "no such bot")
		return persistence.Bot{}, false
	}
	return bot, true
}

// refreshBotRecord pushes a settings change to a connected bot's session, so a
// toggle on the website takes effect without waiting for a restart.
func (server *Server) refreshBotRecord(bot persistence.Bot) {
	server.mu.RLock()
	client := server.bots[bot.BotID]
	server.mu.RUnlock()
	if client == nil {
		return
	}
	client.bot.mu.Lock()
	client.bot.record = bot
	client.bot.mu.Unlock()
	server.broadcastBots()
}

func (server *Server) disconnectBot(botID string, reason string) {
	server.mu.RLock()
	client := server.bots[botID]
	server.mu.RUnlock()
	if client == nil {
		return
	}
	client.Send(ServerMessage{Type: "bot_rejected", Message: reason})
	client.close()
}

func writeBotError(writer http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, persistence.ErrBotNotFound):
		writeAPIError(writer, http.StatusNotFound, "no such bot")
	case errors.Is(err, persistence.ErrBotLimitReached):
		writeAPIError(writer, http.StatusConflict, "this account already has the maximum number of bots")
	case errors.Is(err, persistence.ErrNotRegistered):
		writeAPIError(writer, http.StatusForbidden, "register an account before connecting a bot")
	case errors.Is(err, persistence.ErrAccountDisabled):
		writeAPIError(writer, http.StatusForbidden, "this account is disabled")
	case errors.Is(err, persistence.ErrUsernameTaken):
		writeAPIError(writer, http.StatusConflict, "that bot name is already taken")
	case errors.Is(err, persistence.ErrInvalidUsername):
		writeAPIError(writer, http.StatusBadRequest, err.Error())
	default:
		writeAPIError(writer, http.StatusInternalServerError, "the bot registry is unavailable")
	}
}

// getBotClientScript serves the Python client with its digest in a header, so
// a player can verify the download before running it.
func (server *Server) getBotClientScript(writer http.ResponseWriter, _ *http.Request) {
	body, sum := botclient.Script()
	serveBotFile(writer, "rpsbot.py", body, sum)
}

func (server *Server) getExampleEngine(writer http.ResponseWriter, _ *http.Request) {
	body, sum := botclient.ExampleEngine()
	serveBotFile(writer, "example_engine.py", body, sum)
}

func serveBotFile(writer http.ResponseWriter, name string, body string, sum string) {
	writer.Header().Set("Content-Type", "text/x-python; charset=utf-8")
	writer.Header().Set("X-Script-SHA256", sum)
	writer.Header().Set("Content-Disposition", `attachment; filename="`+name+`"`)
	writer.WriteHeader(http.StatusOK)
	_, _ = writer.Write([]byte(body))
}

// botClientVersion is what the bot guide page and the client both read.
//
// A complete discovery document on purpose: version, minimum, digests, the two
// downloads, and where the protocol is written down. A bot author who has only
// this URL can get everything else from it, which is the whole point of an
// endpoint whose job is telling people how to stay current.
type botClientVersion struct {
	Version        string `json:"version"`
	MinimumVersion string `json:"minimumVersion"`
	SHA256         string `json:"sha256"`
	// These are absolute. They come from RPS_PUBLIC_URL when it is set and
	// otherwise from the address the request arrived on, so the only way they
	// are empty is a request with no usable Host header.
	DownloadURL   string `json:"downloadUrl"`
	ExampleURL    string `json:"exampleUrl"`
	ExampleSHA256 string `json:"exampleSha256"`
	// GuideURL serves the bot guide and the RPSI reference as Markdown, which
	// is where a change to the protocol shows up.
	GuideURL string `json:"guideUrl"`
}

// getBotGuide is everything the Bots page needs in one request: the current
// version and digests, the download links, and the two documents themselves.
// Serving the documents rather than restating them in the app is what stops
// the page and the repository from telling people different things.
func (server *Server) getBotGuide(writer http.ResponseWriter, request *http.Request) {
	_, sum := botclient.Script()
	_, exampleSum := botclient.ExampleEngine()
	base := server.publicBaseURLFor(request)
	writeJSON(writer, http.StatusOK, map[string]any{
		"version":        botclient.Version(),
		"minimumVersion": botclient.MinimumVersion,
		"sha256":         sum,
		"downloadUrl":    botClientDownloadURL(base),
		"exampleUrl":     publicLink(base, exampleEnginePath),
		"exampleSha256":  exampleSum,
		"guide":          botclient.Guide(),
		"protocol":       botclient.Protocol(),
	})
}

func (server *Server) getBotClientVersion(writer http.ResponseWriter, request *http.Request) {
	_, sum := botclient.Script()
	_, exampleSum := botclient.ExampleEngine()
	base := server.publicBaseURLFor(request)
	writeJSON(writer, http.StatusOK, botClientVersion{
		Version:        botclient.Version(),
		MinimumVersion: botclient.MinimumVersion,
		SHA256:         sum,
		DownloadURL:    botClientDownloadURL(base),
		ExampleURL:     publicLink(base, exampleEnginePath),
		ExampleSHA256:  exampleSum,
		GuideURL:       publicLink(base, botGuidePath),
	})
}

// The paths these links point at. Named because each one is built in more than
// one place, and a download link that is right on the Bots page and wrong in a
// bot's upgrade notice is worse than no link at all.
const (
	botClientPath     = "/api/bot/rpsbot.py"
	exampleEnginePath = "/api/bot/example_engine.py"
	botGuidePath      = "/api/bot/guide"
)

// botClientDownloadURL takes an origin rather than a request, because the bot
// socket hands out this link long after the handshake request is gone.
func botClientDownloadURL(base string) string {
	return publicLink(base, botClientPath)
}

// publicLink is an absolute link, or empty when there is no origin to hang it
// off. Empty rather than a bare path: a relative link looks usable and is not.
// Pasted into a shell it means nothing, and rendered in the web app it resolves
// against whichever origin served the page, which in development is the Expo
// dev server.
func publicLink(base string, path string) string {
	if base == "" {
		return ""
	}
	return base + path
}

// publicBaseURLFor is the origin to build somewhere-a-person-will-paste links
// from.
//
// RPS_PUBLIC_URL wins when it is set: it is the canonical address, and behind a
// unix socket it is the only way the process could know it. The fallback to the
// address the request actually arrived on is what keeps these endpoints honest
// everywhere else — on a laptop, and on a host whose environment file predates
// that variable. Both of those used to publish an empty string, which left
// every caller of /api/bot/version guessing at the download URLs.
func (server *Server) publicBaseURLFor(request *http.Request) string {
	if base := strings.TrimSuffix(server.publicBaseURL, "/"); base != "" {
		return base
	}
	return requestOrigin(request)
}

// hostPattern is what may appear between "://" and the path. Deliberately
// narrow: this string is handed to people to paste into a terminal, so a Host
// header carrying anything stranger than a name and a port produces no link
// rather than a surprising one.
var hostPattern = regexp.MustCompile(`^([A-Za-z0-9.-]+|\[[0-9A-Fa-f:.]+\])(:[0-9]{1,5})?$`)

// requestOrigin is the scheme and host this request reached the server on.
//
// X-Forwarded-Proto is trusted because the only thing in front of this process
// is our own nginx, which sets it (backend/deploy/nginx-api-rps.conf) — and a
// caller who forges it only changes a URL in their own response, since nothing
// here is stored or shown to anybody else.
func requestOrigin(request *http.Request) string {
	if request == nil || !hostPattern.MatchString(request.Host) {
		return ""
	}
	scheme := "http"
	forwarded, _, _ := strings.Cut(request.Header.Get("X-Forwarded-Proto"), ",")
	if strings.EqualFold(strings.TrimSpace(forwarded), "https") || request.TLS != nil {
		scheme = "https"
	}
	return scheme + "://" + request.Host
}
