package server

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"rps-strategy/backend/internal/game"
	"rps-strategy/backend/internal/persistence"
)

// gaCollector plays Google's collect endpoint and keeps what it was sent.
type gaCollector struct {
	mu       sync.Mutex
	queries  []string
	requests []gaRequest
	received chan struct{}
}

func gaTestSender(t *testing.T) (*gaSender, *gaCollector) {
	t.Helper()
	collector := &gaCollector{received: make(chan struct{}, 64)}
	endpoint := httptest.NewTLSServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/mp/collect" {
			t.Errorf("posted to %s, want /mp/collect", request.URL.Path)
		}
		body, _ := io.ReadAll(request.Body)
		var decoded gaRequest
		if err := json.Unmarshal(body, &decoded); err != nil {
			t.Errorf("collect body is not JSON: %v", err)
		}
		collector.mu.Lock()
		collector.queries = append(collector.queries, request.URL.RawQuery)
		collector.requests = append(collector.requests, decoded)
		collector.mu.Unlock()
		writer.WriteHeader(http.StatusNoContent)
		collector.received <- struct{}{}
	}))
	t.Cleanup(endpoint.Close)
	sender := &gaSender{
		enabled:       true,
		measurementID: "G-TEST123",
		apiSecret:     "test-secret",
		host:          endpoint.URL,
		client:        endpoint.Client(),
		queue:         make(chan gaRequest, gaQueueCapacity),
		limiter:       newRateLimiter(gaRelayBurst, gaRelayWindow),
		now:           time.Now,
	}
	return sender, collector
}

func (collector *gaCollector) wait(t *testing.T) gaRequest {
	t.Helper()
	select {
	case <-collector.received:
	case <-time.After(5 * time.Second):
		t.Fatal("nothing reached the collect endpoint")
	}
	collector.mu.Lock()
	defer collector.mu.Unlock()
	return collector.requests[len(collector.requests)-1]
}

func TestGAServerEventIsPostedWithTheSecretAndNoAdvertising(t *testing.T) {
	sender, collector := gaTestSender(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go sender.run(ctx)

	sender.serverEvent("game_finished", map[string]any{"mode": "intransitive", "moves": 42})
	got := collector.wait(t)

	if got.ClientID != gaServerClientID {
		t.Errorf("client_id = %q, want the server's own %q", got.ClientID, gaServerClientID)
	}
	if got.Consent != gaNoAdvertising {
		t.Errorf("consent = %+v, want both advertising signals denied", got.Consent)
	}
	if len(got.Events) != 1 || got.Events[0].Name != "game_finished" {
		t.Fatalf("events = %+v", got.Events)
	}
	if got.Events[0].Params["mode"] != "intransitive" {
		t.Errorf("params = %+v", got.Events[0].Params)
	}
	collector.mu.Lock()
	query := collector.queries[0]
	collector.mu.Unlock()
	if !strings.Contains(query, "measurement_id=G-TEST123") || !strings.Contains(query, "api_secret=test-secret") {
		t.Errorf("query = %q, want the measurement ID and secret", query)
	}
}

func TestGADisabledSenderQueuesNothing(t *testing.T) {
	sender := &gaSender{queue: make(chan gaRequest, 1)}
	sender.serverEvent("game_finished", nil)
	if len(sender.queue) != 0 {
		t.Fatal("a disabled sender queued an event")
	}
}

func TestGAFullQueueDropsRatherThanBlocks(t *testing.T) {
	sender := &gaSender{enabled: true, queue: make(chan gaRequest, 1)}
	done := make(chan struct{})
	go func() {
		for range 5 {
			sender.serverEvent("bot_connected", nil)
		}
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("enqueue blocked on a full queue")
	}
	if got := sender.dropped.Load(); got != 4 {
		t.Errorf("dropped = %d, want 4", got)
	}
}

func TestGARelayKeepsOnlyWhatAnEventMayCarry(t *testing.T) {
	now := time.UnixMilli(1_760_000_000_000)
	sender := &gaSender{now: func() time.Time { return now }}
	input := analyticsRelayRequest{
		ClientID:   "123456789.1760000000",
		Platform:   "ios",
		AppVersion: "1.0.0",
		Device:     analyticsRelayDevice{OS: "iOS", OSVersion: "18.1", Model: "iPhone15,2", Language: "de-DE", Region: "de"},
		Events: []analyticsRelayEvent{
			{Name: "page_view", Params: map[string]any{"page_location": "https://rps.henhen1227.com/play"}, TimeMs: now.UnixMilli() - 1000},
			// Reserved by Google.
			{Name: "first_open"},
			// Not a name Google accepts.
			{Name: "Game-Start"},
			// A parameter shape Google has no type for.
			{Name: "game_start", Params: map[string]any{"mode": map[string]any{"nested": true}}},
			// Older than Google will date it.
			{Name: "game_end", TimeMs: now.Add(-73 * time.Hour).UnixMilli()},
			// A clock running ahead, and a flag.
			{Name: "game_end", Params: map[string]any{"result": strings.Repeat("w", 150), "ranked": true}, TimeMs: now.Add(time.Hour).UnixMilli()},
		},
	}
	got, err := sender.relayRequest(input)
	if err != nil {
		t.Fatal(err)
	}
	if len(got.Events) != 2 {
		t.Fatalf("kept %d events, want the page view and the last game_end: %+v", len(got.Events), got.Events)
	}
	if got.Events[0].Params["timestamp_micros"] != now.UnixMicro()-1_000_000 {
		t.Errorf("page_view stamped %v", got.Events[0].Params["timestamp_micros"])
	}
	last := got.Events[1].Params
	if last["timestamp_micros"] != now.UnixMicro() {
		t.Errorf("a future event stamped %v, want now", last["timestamp_micros"])
	}
	if result := last["result"].(string); len(result) != gaMaxValueLength {
		t.Errorf("result is %d long, want clipped to %d", len(result), gaMaxValueLength)
	}
	if last["ranked"] != "true" {
		t.Errorf("ranked = %#v, want the string Google can dimension", last["ranked"])
	}
	if got.UserLocation == nil || got.UserLocation.CountryID != "DE" {
		t.Errorf("user_location = %+v, want DE", got.UserLocation)
	}
	if got.UserProperties["platform"].Value != "ios" || got.UserProperties["app_version"].Value != "1.0.0" {
		t.Errorf("user_properties = %+v", got.UserProperties)
	}
	if got.Device.Model != "iPhone15,2" {
		t.Errorf("device = %+v", got.Device)
	}
}

func TestGARelayRefusesWhatIsNotOneOfOurs(t *testing.T) {
	sender := &gaSender{now: time.Now}
	for _, clientID := range []string{"", "abc", "1.2.3", "user@example.com"} {
		if _, err := sender.relayRequest(analyticsRelayRequest{ClientID: clientID}); err == nil {
			t.Errorf("client ID %q accepted", clientID)
		}
	}
	tooMany := analyticsRelayRequest{ClientID: "1.2", Events: make([]analyticsRelayEvent, gaMaxEventsPerRequest+1)}
	if _, err := sender.relayRequest(tooMany); err == nil {
		t.Error("a batch over Google's limit was accepted")
	}
	for _, region := range []string{"", "D3", "DEU", "419"} {
		got, err := sender.relayRequest(analyticsRelayRequest{
			ClientID: "1.2",
			Device:   analyticsRelayDevice{Region: region},
		})
		if err != nil {
			t.Fatal(err)
		}
		if got.UserLocation != nil {
			t.Errorf("region %q passed on as %+v", region, got.UserLocation)
		}
	}
}

func TestGAClipKeepsWholeCharacters(t *testing.T) {
	// 99 bytes, then a three-byte character straddling the limit.
	value := strings.Repeat("a", 99) + "€"
	if got := gaClip(value, 100); got != strings.Repeat("a", 99) {
		t.Errorf("clipped to %q", got)
	}
}

func TestAnalyticsRelayRoute(t *testing.T) {
	data, err := persistence.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = data.Close() })

	post := func(handler http.Handler, body string) *httptest.ResponseRecorder {
		request := httptest.NewRequest(http.MethodPost, "/api/analytics", strings.NewReader(body))
		request.Header.Set("Content-Type", "application/json")
		recorder := httptest.NewRecorder()
		handler.ServeHTTP(recorder, request)
		return recorder
	}
	batch := `{"clientId":"1.2","platform":"android","events":[{"name":"page_view"}]}`

	t.Run("a server with no stream answers 204 and sends nothing", func(t *testing.T) {
		t.Setenv("RPS_GA_MEASUREMENT_ID", "")
		t.Setenv("RPS_GA_API_SECRET", "")
		server := NewWithStore(data, nil)
		if got := post(server.Routes(), batch).Code; got != http.StatusNoContent {
			t.Errorf("status = %d, want 204", got)
		}
		if len(server.analytics.queue) != 0 {
			t.Error("a disabled server queued the batch")
		}
	})

	t.Run("half-configured is disabled", func(t *testing.T) {
		t.Setenv("RPS_GA_MEASUREMENT_ID", "G-TEST123")
		t.Setenv("RPS_GA_API_SECRET", "")
		if NewWithStore(data, nil).analytics.enabled {
			t.Error("a measurement ID with no secret was enabled")
		}
	})

	t.Run("a configured server queues the batch", func(t *testing.T) {
		t.Setenv("RPS_GA_MEASUREMENT_ID", "G-TEST123")
		t.Setenv("RPS_GA_API_SECRET", "test-secret")
		server := NewWithStore(data, nil)
		handler := server.Routes()
		if got := post(handler, batch).Code; got != http.StatusNoContent {
			t.Fatalf("status = %d, want 204", got)
		}
		if len(server.analytics.queue) != 1 {
			t.Fatalf("queued %d, want 1", len(server.analytics.queue))
		}
		queued := <-server.analytics.queue
		if queued.ClientID != "1.2" || len(queued.Events) != 1 {
			t.Errorf("queued %+v", queued)
		}
		if got := post(handler, `{"clientId":"nope"}`).Code; got != http.StatusBadRequest {
			t.Errorf("a bad client ID answered %d, want 400", got)
		}
		if got := post(handler, `not json`).Code; got != http.StatusBadRequest {
			t.Errorf("a bad body answered %d, want 400", got)
		}
	})

	t.Run("one address is throttled", func(t *testing.T) {
		t.Setenv("RPS_GA_MEASUREMENT_ID", "G-TEST123")
		t.Setenv("RPS_GA_API_SECRET", "test-secret")
		server := NewWithStore(data, nil)
		handler := server.Routes()
		var last int
		for range gaRelayBurst + 1 {
			last = post(handler, batch).Code
			// Drained as it goes, so it is the limiter and not the queue
			// that answers.
			for len(server.analytics.queue) > 0 {
				<-server.analytics.queue
			}
		}
		if last != http.StatusTooManyRequests {
			t.Errorf("request %d answered %d, want 429", gaRelayBurst+1, last)
		}
	})
}

// analyticsTap replaces a server's sender with one that queues and never
// posts, so a test reads exactly what would have gone to Google.
func analyticsTap(server *Server) chan gaRequest {
	queue := make(chan gaRequest, 16)
	server.analytics = &gaSender{
		enabled: true,
		queue:   queue,
		limiter: newRateLimiter(gaRelayBurst, gaRelayWindow),
		now:     time.Now,
	}
	return queue
}

func TestAFinishedGameIsCountedOnceAndNamesNobody(t *testing.T) {
	server := New(nil)
	queue := analyticsTap(server)
	alice := fakeClient(t, server, "alice", false)
	engine := fakeClient(t, server, "deepblue", true)
	session := server.startConfiguredMatch(testEntry(alice), testEntry(engine), matchSetup{})
	if session == nil {
		t.Fatal("expected a session")
	}
	state, err := session.game.Resign(game.Red)
	if err != nil {
		t.Fatal(err)
	}
	server.finishSession(session, state)
	// A second finish of the same game is the closeOnce's to swallow.
	server.finishSession(session, state)

	if len(queue) != 1 {
		t.Fatalf("queued %d events, want exactly one", len(queue))
	}
	got := <-queue
	if got.ClientID != gaServerClientID || len(got.Events) != 1 || got.Events[0].Name != "game_finished" {
		t.Fatalf("queued %+v", got)
	}
	params := got.Events[0].Params
	if params["players"] != "human_vs_bot" || params["end_reason"] != "resignation" ||
		params["winner"] != "blue" || params["setting"] != "match" {
		t.Errorf("params = %+v", params)
	}
	for key, value := range params {
		if text, ok := value.(string); ok && (strings.Contains(text, "alice") || strings.Contains(text, "deepblue")) {
			t.Errorf("a player's name reached the event as %s=%q", key, text)
		}
	}
}

func TestABotIsCountedOnArrivalNotOnEveryReconnect(t *testing.T) {
	server := New(nil)
	queue := analyticsTap(server)
	first := fakeClient(t, server, "engine", true)
	// fakeClient seats the bot by hand; take it off so registering it is
	// the arrival.
	server.mu.Lock()
	delete(server.bots, first.bot.botID)
	server.mu.Unlock()

	server.registerBot(first)
	if len(queue) != 1 {
		t.Fatalf("a bot's first connection queued %d events, want 1", len(queue))
	}
	if got := <-queue; got.Events[0].Name != "bot_connected" || got.Events[0].Params["bot"] != "engine" {
		t.Errorf("queued %+v", got)
	}

	// Dropped and back within the grace: a blip.
	server.unregisterBot(first)
	second := fakeClient(t, server, "engine", true)
	server.mu.Lock()
	delete(server.bots, second.bot.botID)
	server.mu.Unlock()
	server.registerBot(second)
	if len(queue) != 0 {
		t.Fatalf("a reconnect inside the grace queued %d events", len(queue))
	}

	// Gone for longer than the grace: an arrival again.
	server.unregisterBot(second)
	server.mu.Lock()
	server.botsOfflineAt[second.bot.botID] = time.Now().Add(-botReconnectGracePeriod - time.Second)
	server.mu.Unlock()
	server.registerBot(second)
	if len(queue) != 1 {
		t.Fatalf("a return after the grace queued %d events, want 1", len(queue))
	}
}
