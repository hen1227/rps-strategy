package server

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"image"
	"image/color"
	"image/png"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"rps-strategy/backend/internal/persistence"
)

// iconTestServer is a server with one registered owner holding one bot token.
func iconTestServer(t *testing.T) (*Server, string) {
	t.Helper()
	data, err := persistence.Open(":memory:")
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	t.Cleanup(func() { _ = data.Close() })
	server := NewWithStore(data, nil)

	ctx := t.Context()
	const key = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
	if _, err := data.EnsureAccountWithProfileKey(ctx, "owner", "Owner", key); err != nil {
		t.Fatalf("owner account: %v", err)
	}
	if _, err := data.ClaimAccountWithDiscord(ctx, "owner", "Owner", "discord-owner", "owner"); err != nil {
		t.Fatalf("register owner: %v", err)
	}
	_, token, err := data.MintBotToken(ctx, "owner")
	if err != nil {
		t.Fatalf("mint: %v", err)
	}
	return server, token
}

func iconPNG(t *testing.T, size int, shade uint8) []byte {
	t.Helper()
	picture := image.NewRGBA(image.Rect(0, 0, size, size))
	for x := range size {
		for y := range size {
			picture.Set(x, y, color.RGBA{R: shade, G: uint8(x), B: uint8(y), A: 0xFF})
		}
	}
	var buffer bytes.Buffer
	if err := png.Encode(&buffer, picture); err != nil {
		t.Fatalf("encode: %v", err)
	}
	return buffer.Bytes()
}

// connectBot registers a bot over the socket the way rpsbot.py does, answers the
// two handshake frames, and returns the bot_ready it got back.
//
// `icon` is a pointer for the reason the field is: nil is a client that predates
// icons, and empty is a current one whose config names no picture.
func connectBot(t *testing.T, url string, token string, name string, icon *string) botReadyMessage {
	t.Helper()
	connection, _, err := websocket.DefaultDialer.Dial(url, nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	t.Cleanup(func() { _ = connection.Close() })

	registration := map[string]any{
		"type":             "authenticate_bot",
		"clientVersion":    "1.1",
		"token":            token,
		"name":             name,
		"publicPlay":       true,
		"enterTournaments": true,
	}
	if icon != nil {
		registration["icon"] = *icon
	}
	if err := connection.WriteJSON(registration); err != nil {
		t.Fatalf("register: %v", err)
	}

	_ = connection.SetReadDeadline(time.Now().Add(5 * time.Second))
	for {
		_, payload, err := connection.ReadMessage()
		if err != nil {
			t.Fatalf("read: %v", err)
		}
		var frame struct {
			Type  string   `json:"type"`
			Seq   int64    `json:"seq"`
			Lines []string `json:"lines"`
		}
		if err := json.Unmarshal(payload, &frame); err != nil {
			t.Fatalf("decode %s: %v", payload, err)
		}
		switch frame.Type {
		case "engine":
			reply := []string{"readyok"}
			if len(frame.Lines) > 0 && frame.Lines[0] == "rpsi" {
				reply = []string{"id name Stub", "protocol 1", "mode V3", "rpsiok"}
			}
			if err := connection.WriteJSON(map[string]any{
				"type": "engine_reply", "seq": frame.Seq, "lines": reply,
			}); err != nil {
				t.Fatalf("engine reply: %v", err)
			}
		case "bot_ready":
			var ready botReadyMessage
			if err := json.Unmarshal(payload, &ready); err != nil {
				t.Fatalf("decode bot_ready: %v", err)
			}
			return ready
		case "bot_rejected", "authentication_failed":
			t.Fatalf("the bot was refused: %s", payload)
		}
	}
}

func base64Of(raw []byte) *string {
	encoded := base64.StdEncoding.EncodeToString(raw)
	return &encoded
}

// The whole feature, end to end: a client sends a picture with its
// registration, and the website can fetch it by either of the bot's ids.
func TestAnIconSentOnConnectIsServedOverHTTP(t *testing.T) {
	server, token := iconTestServer(t)
	httpServer := httptest.NewServer(server.Routes())
	defer httpServer.Close()
	websocketURL := "ws" + strings.TrimPrefix(httpServer.URL, "http") + "/ws"

	ready := connectBot(t, websocketURL, token, "Pictured", base64Of(iconPNG(t, 128, 0x40)))
	if ready.IconWarning != "" {
		t.Fatalf("a good icon should draw no warning, got %q", ready.IconWarning)
	}

	bot, err := server.data.BotForAccount(t.Context(), ready.UserID)
	if err != nil {
		t.Fatalf("read bot: %v", err)
	}
	if bot.IconSHA256 == "" {
		t.Fatal("the bot should be carrying an icon digest")
	}
	// The roster is what the lobby draws from, so the digest has to be in it.
	roster := server.botRoster()
	if len(roster) != 1 || roster[0].IconSHA256 != bot.IconSHA256 {
		t.Fatalf("the roster does not carry the icon: %#v", roster)
	}

	for _, id := range []string{bot.BotID, bot.UserID} {
		response, err := http.Get(httpServer.URL + "/api/bots/" + id + "/icon.png?v=" + bot.IconSHA256)
		if err != nil {
			t.Fatalf("fetch icon by %q: %v", id, err)
		}
		body, _ := io.ReadAll(response.Body)
		_ = response.Body.Close()
		if response.StatusCode != http.StatusOK {
			t.Fatalf("fetch icon by %q: %s", id, response.Status)
		}
		if got := response.Header.Get("Content-Type"); got != "image/png" {
			t.Fatalf("icon by %q served as %q", id, got)
		}
		if got := response.Header.Get("ETag"); got != `"`+bot.IconSHA256+`"` {
			t.Fatalf("icon by %q has ETag %q", id, got)
		}
		// The digest is in the URL, so this answer can never go stale.
		if got := response.Header.Get("Cache-Control"); !strings.Contains(got, "immutable") {
			t.Fatalf("a digest-stamped URL should be immutable, got %q", got)
		}
		config, err := png.DecodeConfig(bytes.NewReader(body))
		if err != nil || config.Width != 128 {
			t.Fatalf("icon by %q is not a 128px PNG: %v %+v", id, err, config)
		}
	}

	// A page with a dozen bots on it revalidates a dozen icons per reload.
	request, err := http.NewRequest(http.MethodGet, httpServer.URL+"/api/bots/"+bot.BotID+"/icon.png", nil)
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("If-None-Match", `"`+bot.IconSHA256+`"`)
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatalf("revalidate: %v", err)
	}
	_ = response.Body.Close()
	if response.StatusCode != http.StatusNotModified {
		t.Fatalf("expected 304 for a matching ETag, got %s", response.Status)
	}
}

// The guarantee that lets 1.1 ship without touching MinimumVersion: an older
// client sends no icon field at all, and that must not take down a picture its
// owner uploaded from a newer one.
func TestAClientThatSendsNoIconLeavesTheStoredOneAlone(t *testing.T) {
	server, token := iconTestServer(t)
	httpServer := httptest.NewServer(server.Routes())
	defer httpServer.Close()
	websocketURL := "ws" + strings.TrimPrefix(httpServer.URL, "http") + "/ws"

	ready := connectBot(t, websocketURL, token, "Legacy", base64Of(iconPNG(t, 128, 0x80)))
	bot, err := server.data.BotForAccount(t.Context(), ready.UserID)
	if err != nil {
		t.Fatalf("read bot: %v", err)
	}
	digest := bot.IconSHA256
	if digest == "" {
		t.Fatal("expected the first connect to store an icon")
	}

	// The same bot, restarted on a client that has never heard of icons.
	if ready := connectBot(t, websocketURL, token, "Legacy", nil); ready.IconWarning != "" {
		t.Fatalf("an absent icon is not an error, got %q", ready.IconWarning)
	}
	again, err := server.data.Bot(t.Context(), bot.BotID)
	if err != nil {
		t.Fatalf("read bot: %v", err)
	}
	if again.IconSHA256 != digest {
		t.Fatalf("the icon changed on a client that never mentioned one: %q -> %q",
			digest, again.IconSHA256)
	}
}

// An empty field is the other half of that: it is the only way to take an icon
// down, since the config file is the owner's copy of their bot's identity.
func TestAnEmptyIconFieldTakesThePictureDown(t *testing.T) {
	server, token := iconTestServer(t)
	httpServer := httptest.NewServer(server.Routes())
	defer httpServer.Close()
	websocketURL := "ws" + strings.TrimPrefix(httpServer.URL, "http") + "/ws"

	ready := connectBot(t, websocketURL, token, "Faceless", base64Of(iconPNG(t, 64, 0x10)))
	bot, err := server.data.BotForAccount(t.Context(), ready.UserID)
	if err != nil {
		t.Fatalf("read bot: %v", err)
	}

	empty := ""
	connectBot(t, websocketURL, token, "Faceless", &empty)
	again, err := server.data.Bot(t.Context(), bot.BotID)
	if err != nil {
		t.Fatalf("read bot: %v", err)
	}
	if again.IconSHA256 != "" {
		t.Fatalf("expected the icon to be gone, got %q", again.IconSHA256)
	}
	response, err := http.Get(httpServer.URL + "/api/bots/" + bot.BotID + "/icon.png")
	if err != nil {
		t.Fatalf("fetch: %v", err)
	}
	_ = response.Body.Close()
	if response.StatusCode != http.StatusNotFound {
		t.Fatalf("a bot with no icon should 404, got %s", response.Status)
	}
}

// A picture the server cannot use is a thing to tell the owner about. It must
// not refuse the connection, and it must not erase what is already there.
func TestAnUnusableIconIsReportedAndChangesNothing(t *testing.T) {
	server, token := iconTestServer(t)
	httpServer := httptest.NewServer(server.Routes())
	defer httpServer.Close()
	websocketURL := "ws" + strings.TrimPrefix(httpServer.URL, "http") + "/ws"

	ready := connectBot(t, websocketURL, token, "Hopeful", base64Of(iconPNG(t, 128, 0x20)))
	bot, err := server.data.BotForAccount(t.Context(), ready.UserID)
	if err != nil {
		t.Fatalf("read bot: %v", err)
	}
	digest := bot.IconSHA256

	for _, testCase := range []struct {
		name string
		icon *string
		want string
	}{
		{"too many pixels", base64Of(iconPNG(t, 256, 0x30)), "256x256"},
		{"not a PNG", base64Of([]byte("GIF89a and then some")), "not a PNG"},
		{"not base64", func() *string { junk := "!!!! not base64 !!!!"; return &junk }(), "base64"},
	} {
		ready := connectBot(t, websocketURL, token, "Hopeful", testCase.icon)
		if !strings.Contains(ready.IconWarning, testCase.want) {
			t.Errorf("%s: warning %q should mention %q",
				testCase.name, ready.IconWarning, testCase.want)
		}
		again, err := server.data.Bot(t.Context(), bot.BotID)
		if err != nil {
			t.Fatalf("read bot: %v", err)
		}
		if again.IconSHA256 != digest {
			t.Errorf("%s: the good icon should have survived, %q -> %q",
				testCase.name, digest, again.IconSHA256)
		}
	}
}

func TestAnUnknownBotHasNoIcon(t *testing.T) {
	server, _ := iconTestServer(t)
	httpServer := httptest.NewServer(server.Routes())
	defer httpServer.Close()

	for _, id := range []string{"nosuchbot", "bot-nosuchaccount"} {
		response, err := http.Get(httpServer.URL + "/api/bots/" + id + "/icon.png")
		if err != nil {
			t.Fatalf("fetch %q: %v", id, err)
		}
		_ = response.Body.Close()
		if response.StatusCode != http.StatusNotFound {
			t.Errorf("%q should be a 404, got %s", id, response.Status)
		}
	}
}
