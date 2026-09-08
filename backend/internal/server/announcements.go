package server

import (
	"errors"
	"io"
	"log"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

// Saying something to everybody who is here.
//
// The drain next door in deploy_drain.go is the polite way to take the server
// down, and most restarts should go through it. This is for the rest: the
// change that has to ship now, the bug that is eating games, the moment
// somebody has to pull the plug and would rather say sorry than not. There was
// no way to do that at all — the only channel to a player was the chat room of
// a game they happened to be in.
//
// Two decisions are worth stating:
//
//   - **It is held, not just broadcast.** A message sent only to the sockets
//     that happen to be open right now misses the person who reloads two
//     seconds later, which is exactly the person a "back in a minute" was
//     written for. So the notice sits on the server with a lifetime, and every
//     client that connects inside it is told on connection_ready.
//   - **It expires by itself.** An apology for a restart that happened an hour
//     ago is worse than no apology: it makes a working server look broken.
//     Anything not cleared by hand goes on its own, and the default lifetime is
//     short for that reason.
//
// It is not chat, and it is deliberately not addressable: an administrator can
// say one thing to the whole lobby, and if they need a conversation they can
// join a game like everybody else.

// maximumNoticeRunes is a limit on the sentence, not on the thought. Long
// enough for two lines of explanation and an apology; short enough that the
// banner never becomes the page.
const maximumNoticeRunes = 280

// noticeDefaultLifetime is how long an announcement stands when nobody says.
const noticeDefaultLifetime = 15 * time.Minute

// noticeMaximumLifetime is the ceiling on one, because the failure mode of this
// feature is a stale banner nobody remembers posting.
const noticeMaximumLifetime = 6 * time.Hour

// ServerNotice is an announcement as every client is told about it.
type ServerNotice struct {
	// ID changes with every posting, so a client can tell a new notice from a
	// re-broadcast of one it has already shown and dismissed. Without it, a
	// player who closed the banner would have it reappear on the next
	// reconnection.
	ID   string `json:"id"`
	Text string `json:"text"`
	// Tone picks how it reads: "notice" for the ordinary announcement, "warning"
	// for something the player should act on. The client maps these to colours;
	// an unknown one is shown as a notice rather than dropped.
	Tone            string `json:"tone,omitempty"`
	PostedAtUnixMs  int64  `json:"postedAtUnixMs"`
	ExpiresAtUnixMs int64  `json:"expiresAtUnixMs"`
}

// noticeBoard holds the one standing announcement.
type noticeBoard struct {
	mu      sync.RWMutex
	notice  *ServerNotice
	expires time.Time
}

// current returns the notice if there is one and it has not expired.
//
// Expiry is checked on read rather than swept on a timer: there is one of
// these, it is read on every connection, and a sweep would be a scheduler for a
// single pointer.
func (board *noticeBoard) current() *ServerNotice {
	board.mu.RLock()
	notice, expires := board.notice, board.expires
	board.mu.RUnlock()
	if notice == nil || time.Now().After(expires) {
		return nil
	}
	// Copied out, so a caller cannot edit the standing notice by editing what
	// it was handed.
	copied := *notice
	return &copied
}

func (board *noticeBoard) post(notice ServerNotice, expires time.Time) {
	board.mu.Lock()
	board.notice, board.expires = &notice, expires
	board.mu.Unlock()
}

func (board *noticeBoard) clear() bool {
	board.mu.Lock()
	defer board.mu.Unlock()
	had := board.notice != nil && time.Now().Before(board.expires)
	board.notice, board.expires = nil, time.Time{}
	return had
}

// PostNotice puts an announcement in front of everybody and holds it for
// whoever arrives next.
func (server *Server) PostNotice(text, tone string, lifetime time.Duration) ServerNotice {
	if lifetime <= 0 {
		lifetime = noticeDefaultLifetime
	}
	if lifetime > noticeMaximumLifetime {
		lifetime = noticeMaximumLifetime
	}
	now := time.Now()
	expires := now.Add(lifetime)
	// An id that fails to generate is not worth refusing the announcement over
	// — the cost is a client that cannot dedupe a re-broadcast, against an
	// administrator who cannot say the server is going down.
	id, err := randomID()
	if err != nil {
		id = strconv.FormatInt(now.UnixNano(), 36)
	}
	notice := ServerNotice{
		ID:              id,
		Text:            strings.TrimSpace(text),
		Tone:            noticeTone(tone),
		PostedAtUnixMs:  now.UnixMilli(),
		ExpiresAtUnixMs: expires.UnixMilli(),
	}
	server.notices.post(notice, expires)

	log.Printf("announcement (%s): %s", notice.Tone, notice.Text)
	message := ServerMessage{Type: "server_notice", Notice: &notice}
	for _, client := range server.connectedClients() {
		// Engines included, and on purpose: rpsbot.py prints what the server
		// says, so an owner tailing their bot's log finds out that the server
		// is restarting at the same time everybody at a browser does.
		client.Send(message)
	}
	return notice
}

// ClearNotice takes the announcement down everywhere.
func (server *Server) ClearNotice() bool {
	if !server.notices.clear() {
		return false
	}
	// A notice with no text is how the banner is told to go. Sending the same
	// message shape rather than a second type keeps one handler on the client.
	message := ServerMessage{Type: "server_notice", Notice: &ServerNotice{}}
	for _, client := range server.connectedClients() {
		client.Send(message)
	}
	return true
}

// noticeTone keeps the wire honest about a small vocabulary, so a typo in a
// curl command does not reach the client as an unstyled banner.
func noticeTone(tone string) string {
	switch strings.ToLower(strings.TrimSpace(tone)) {
	case "warning", "warn":
		return "warning"
	default:
		return "notice"
	}
}

// utf8Length counts runes, which is what every length limit on this server
// means: a limit in bytes would let one alphabet say half as much as another.
func utf8Length(text string) int {
	return utf8.RuneCountInString(strings.TrimSpace(text))
}

/* --------------------------------------------------------------- routes -- */

type postNoticeRequest struct {
	Text string `json:"text"`
	// Tone is "notice" or "warning". Anything else reads as a notice.
	Tone string `json:"tone"`
	// LifetimeSeconds is how long it stands. Zero takes the default.
	LifetimeSeconds int `json:"lifetimeSeconds"`
}

// postNotice is POST /api/admin/notice.
func (server *Server) postNotice(writer http.ResponseWriter, request *http.Request) {
	var input postNoticeRequest
	if err := decodeAPIRequest(writer, request, &input); err != nil &&
		!errors.Is(err, io.EOF) {
		writeAPIError(writer, http.StatusBadRequest, err.Error())
		return
	}
	text := strings.TrimSpace(input.Text)
	if text == "" {
		writeAPIError(writer, http.StatusBadRequest, "the announcement needs something to say")
		return
	}
	if !utf8.ValidString(text) || utf8Length(text) > maximumNoticeRunes {
		writeAPIError(writer, http.StatusBadRequest,
			"the announcement must be "+strconv.Itoa(maximumNoticeRunes)+
				" characters or fewer")
		return
	}
	notice := server.PostNotice(
		text,
		input.Tone,
		time.Duration(input.LifetimeSeconds)*time.Second,
	)
	writeJSON(writer, http.StatusOK, notice)
}

// clearNotice is DELETE /api/admin/notice.
func (server *Server) clearNotice(writer http.ResponseWriter, _ *http.Request) {
	writeJSON(writer, http.StatusOK, map[string]bool{"cleared": server.ClearNotice()})
}

// getNotice is GET /api/notice, and is public: it is the same sentence the
// banner shows, and a client that reconnects over HTTP before its socket is up
// should be able to read it.
func (server *Server) getNotice(writer http.ResponseWriter, _ *http.Request) {
	notice := server.notices.current()
	if notice == nil {
		writeJSON(writer, http.StatusOK, ServerNotice{})
		return
	}
	writeJSON(writer, http.StatusOK, notice)
}
