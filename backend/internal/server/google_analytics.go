package server

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"math"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strings"
	"sync/atomic"
	"time"
	"unicode/utf8"

	"rps-strategy/backend/internal/game"
	"rps-strategy/backend/internal/persistence"
)

// Google Analytics, for what no browser tag can see.
//
// The website reports to Google itself, through gtag.js, once a visitor allows
// it (see frontend/src/analytics). Two kinds of event cannot travel that way,
// and this file carries both over GA4's Measurement Protocol:
//
//   - **The apps'.** An iOS or Android build has no tag. It posts its events to
//     POST /api/analytics and this server forwards them with the stream's API
//     secret, which no client could keep: the frontend is public source, and so
//     is anything shipped inside it. Forwarding also means Google is handed this
//     server's address rather than the phone's.
//   - **The server's own.** A finished game and an engine coming online happen
//     whether or not anybody is watching, and a game between two bots has no
//     browser at all. These go out under one fixed client ID and carry no
//     account, device or address, so they describe the site rather than anyone
//     on it.
//
// Disabled is the ordinary state, as for push. A checkout with no measurement ID
// and secret sends nothing anywhere, and the relay answers 204 to an app built
// with analytics on, so the two halves can be configured in either order.
//
// Nothing here may slow a game. Events go onto a bounded queue that one
// goroutine drains; a full queue drops the event rather than wait, and a Google
// outage costs only the events sent into it.

const (
	gaHost = "https://www.google-analytics.com"
	// gaServerClientID is who the server's own events belong to. One fixed ID,
	// so they add one user to the property rather than one per game, and in the
	// two-numbers-and-a-dot shape Google recommends for a client ID.
	gaServerClientID = "1.1"
	gaQueueCapacity  = 512
	gaTimeout        = 5 * time.Second
	// gaRelayRequestLimit is far above what an app's batch of 25 events can
	// reach, and far below what makes the decoder worth attacking.
	gaRelayRequestLimit = 32 << 10
	// A phone posts a batch every quarter minute or so while it is open, and
	// once more when it is put away. A minute's burst is room for a flaky
	// network's retries on top of that.
	gaRelayBurst  = 30
	gaRelayWindow = time.Minute

	// Google's limits, which a request over them is silently trimmed to.
	// Holding to them here means what is dropped is decided here.
	gaMaxEventsPerRequest = 25
	gaMaxParamsPerEvent   = 25
	gaMaxValueLength      = 100
	// Events can be backdated up to three days. Anything older is restamped
	// to three days ago, which misdates it; such an event is a phone that was
	// offline that long, and is dropped instead.
	gaMaxEventAge = 72 * time.Hour
)

// gaNamePattern is the shape Google accepts for event and parameter names.
var gaNamePattern = regexp.MustCompile(`^[a-z][a-z0-9_]{0,39}$`)

// gaClientIDPattern is what the apps generate: two numbers joined by a dot.
// Anything else is not one of ours.
var gaClientIDPattern = regexp.MustCompile(`^[0-9]{1,20}\.[0-9]{1,20}$`)

// gaReservedNames are the event names Google keeps for itself, plus the two a
// web stream may not receive. Sent anyway, they are dropped at Google's end.
var gaReservedNames = map[string]bool{
	"ad_activeview": true, "ad_click": true, "ad_exposure": true, "ad_impression": true,
	"ad_query": true, "ad_reward": true, "adunit_exposure": true, "app_clear_data": true,
	"app_exception": true, "app_install": true, "app_remove": true, "app_store_refund": true,
	"app_update": true, "app_upgrade": true, "dynamic_link_app_open": true,
	"dynamic_link_app_update": true, "dynamic_link_first_open": true, "error": true,
	"firebase_campaign": true, "first_open": true, "first_visit": true,
	"in_app_purchase": true, "notification_dismiss": true, "notification_foreground": true,
	"notification_open": true, "notification_receive": true, "notification_send": true,
	"os_update": true, "screen_view": true, "session_start": true, "user_engagement": true,
}

// gaRequest is the Measurement Protocol body for a web stream.
type gaRequest struct {
	ClientID       string                     `json:"client_id"`
	UserProperties map[string]gaPropertyValue `json:"user_properties,omitempty"`
	UserLocation   *gaUserLocation            `json:"user_location,omitempty"`
	Device         *gaDevice                  `json:"device,omitempty"`
	// Said on every request, so no event is ever eligible for advertising
	// whatever the property's settings say.
	Consent gaConsent `json:"consent"`
	Events  []gaEvent `json:"events"`
}

type gaPropertyValue struct {
	Value string `json:"value"`
}

type gaUserLocation struct {
	CountryID string `json:"country_id,omitempty"`
}

type gaDevice struct {
	Category               string `json:"category,omitempty"`
	Language               string `json:"language,omitempty"`
	ScreenResolution       string `json:"screen_resolution,omitempty"`
	OperatingSystem        string `json:"operating_system,omitempty"`
	OperatingSystemVersion string `json:"operating_system_version,omitempty"`
	Model                  string `json:"model,omitempty"`
	Brand                  string `json:"brand,omitempty"`
}

type gaConsent struct {
	AdUserData        string `json:"ad_user_data"`
	AdPersonalization string `json:"ad_personalization"`
}

var gaNoAdvertising = gaConsent{AdUserData: "DENIED", AdPersonalization: "DENIED"}

type gaEvent struct {
	Name   string         `json:"name"`
	Params map[string]any `json:"params,omitempty"`
}

// gaSender forwards events to Google Analytics, and knows whether it can.
type gaSender struct {
	enabled       bool
	measurementID string
	apiSecret     string
	host          string
	client        httpDoer
	queue         chan gaRequest
	limiter       *rateLimiter
	dropped       atomic.Int64
	// now is the clock events are stamped and aged by. A test replaces it.
	now func() time.Time
}

func newGASender() *gaSender {
	sender := &gaSender{
		host:    gaHost,
		client:  &http.Client{Timeout: gaTimeout},
		queue:   make(chan gaRequest, gaQueueCapacity),
		limiter: newRateLimiter(gaRelayBurst, gaRelayWindow),
		now:     time.Now,
	}
	measurementID := strings.TrimSpace(os.Getenv("RPS_GA_MEASUREMENT_ID"))
	apiSecret := strings.TrimSpace(os.Getenv("RPS_GA_API_SECRET"))
	switch {
	case measurementID == "" && apiSecret == "":
		// Nothing configured, which is not a mistake and not worth a log line.
	case measurementID == "" || apiSecret == "":
		// Half-configured is refused and named at boot, as for every other
		// credential this server holds, rather than discovered as an empty
		// report a week later.
		log.Printf("Google Analytics disabled: RPS_GA_MEASUREMENT_ID and RPS_GA_API_SECRET are needed together")
	default:
		sender.measurementID = measurementID
		sender.apiSecret = apiSecret
		sender.enabled = true
	}
	return sender
}

// run drains the queue until ctx ends. One request at a time: the volume is a
// handful a minute, and one goroutine is the whole of the concurrency budget
// this deserves.
func (sender *gaSender) run(ctx context.Context) {
	if !sender.enabled {
		return
	}
	for {
		select {
		case <-ctx.Done():
			return
		case request := <-sender.queue:
			if err := sender.post(ctx, request); err != nil && ctx.Err() == nil {
				log.Printf("Google Analytics: %v", err)
			}
		}
	}
}

// enqueue hands a request to the drain without waiting. A full queue means
// Google is slower than events arrive, and the event is the thing to give up.
func (sender *gaSender) enqueue(request gaRequest) {
	if !sender.enabled || len(request.Events) == 0 {
		return
	}
	request.Consent = gaNoAdvertising
	select {
	case sender.queue <- request:
	default:
		// Logged on the first drop and every hundredth after, so an outage
		// is visible without a line per event.
		if count := sender.dropped.Add(1); count == 1 || count%100 == 0 {
			log.Printf("Google Analytics: queue full, %d event batch(es) dropped so far", count)
		}
	}
}

// serverEvent records something the server saw happen, under the server's own
// client ID. params must already be within Google's limits; every caller
// builds them from values this server owns.
func (sender *gaSender) serverEvent(name string, params map[string]any) {
	sender.enqueue(gaRequest{
		ClientID: gaServerClientID,
		Events:   []gaEvent{{Name: name, Params: params}},
	})
}

func (sender *gaSender) post(ctx context.Context, request gaRequest) error {
	body, err := json.Marshal(request)
	if err != nil {
		return fmt.Errorf("encode: %w", err)
	}
	query := url.Values{}
	query.Set("measurement_id", sender.measurementID)
	query.Set("api_secret", sender.apiSecret)
	ctx, cancel := context.WithTimeout(ctx, gaTimeout)
	defer cancel()
	httpRequest, err := http.NewRequestWithContext(
		ctx,
		http.MethodPost,
		sender.host+"/mp/collect?"+query.Encode(),
		bytes.NewReader(body),
	)
	if err != nil {
		return fmt.Errorf("build request: %w", err)
	}
	httpRequest.Header.Set("Content-Type", "application/json")
	response, err := sender.client.Do(httpRequest)
	if err != nil {
		// The URL carries the secret, and *url.Error prints the URL.
		var urlError *url.Error
		if errors.As(err, &urlError) {
			err = urlError.Err
		}
		return fmt.Errorf("send: %w", err)
	}
	defer response.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 4<<10))
	// Google answers 2xx to anything well formed, valid or not; only the
	// debug endpoint says what was wrong with an event. A non-2xx is a
	// malformed request or a bad secret, and worth a line.
	if response.StatusCode/100 != 2 {
		return fmt.Errorf("collect answered %d", response.StatusCode)
	}
	return nil
}

// ---------------------------------------------------------------- the relay --

// analyticsRelayRequest is what an app posts: one install's batch.
type analyticsRelayRequest struct {
	ClientID   string                `json:"clientId"`
	Platform   string                `json:"platform"`
	AppVersion string                `json:"appVersion"`
	Device     analyticsRelayDevice  `json:"device"`
	Events     []analyticsRelayEvent `json:"events"`
}

type analyticsRelayDevice struct {
	Category  string `json:"category"`
	OS        string `json:"os"`
	OSVersion string `json:"osVersion"`
	Model     string `json:"model"`
	Brand     string `json:"brand"`
	Language  string `json:"language"`
	Screen    string `json:"screen"`
	// Region is the two-letter region of the phone's locale, en-GB's GB.
	Region string `json:"region"`
}

type analyticsRelayEvent struct {
	Name   string         `json:"name"`
	Params map[string]any `json:"params"`
	// TimeMs is when it happened on the phone, which is not when it arrives:
	// a batch can sit through a subway ride.
	TimeMs int64 `json:"timeMs"`
}

// relayAnalytics forwards one app's batch.
//
// It is an open door into the property by design — anyone may hold an app —
// so it takes only what an event can carry and nothing that steers the
// property: names and values within Google's limits, no user ID, no address,
// and user properties only the two this route sets itself. Anything else in a
// batch is dropped event by event rather than refusing the whole batch, so one
// build's bad event never silences its good ones.
func (server *Server) relayAnalytics(writer http.ResponseWriter, request *http.Request) {
	sender := server.analytics
	if !sender.enabled {
		writer.WriteHeader(http.StatusNoContent)
		return
	}
	if allowed, _ := sender.limiter.Allow(clientIP(request)); !allowed {
		writeAPIError(writer, http.StatusTooManyRequests, "too many analytics batches")
		return
	}
	request.Body = http.MaxBytesReader(writer, request.Body, gaRelayRequestLimit)
	var input analyticsRelayRequest
	if err := json.NewDecoder(request.Body).Decode(&input); err != nil {
		writeAPIError(writer, http.StatusBadRequest, "invalid JSON body")
		return
	}
	forwarded, err := sender.relayRequest(input)
	if err != nil {
		writeAPIError(writer, http.StatusBadRequest, err.Error())
		return
	}
	sender.enqueue(forwarded)
	writer.WriteHeader(http.StatusNoContent)
}

// relayRequest turns an app's batch into a Measurement Protocol request.
func (sender *gaSender) relayRequest(input analyticsRelayRequest) (gaRequest, error) {
	if !gaClientIDPattern.MatchString(input.ClientID) {
		return gaRequest{}, errors.New("clientId is not an analytics client ID")
	}
	if len(input.Events) > gaMaxEventsPerRequest {
		return gaRequest{}, fmt.Errorf("at most %d events per batch", gaMaxEventsPerRequest)
	}
	output := gaRequest{
		ClientID: input.ClientID,
		UserProperties: map[string]gaPropertyValue{
			"platform":    {Value: gaClip(input.Platform, 36)},
			"app_version": {Value: gaClip(input.AppVersion, 36)},
		},
		Device: &gaDevice{
			Category:               gaClip(input.Device.Category, gaMaxValueLength),
			Language:               gaClip(input.Device.Language, gaMaxValueLength),
			ScreenResolution:       gaClip(input.Device.Screen, gaMaxValueLength),
			OperatingSystem:        gaClip(input.Device.OS, gaMaxValueLength),
			OperatingSystemVersion: gaClip(input.Device.OSVersion, gaMaxValueLength),
			Model:                  gaClip(input.Device.Model, gaMaxValueLength),
			Brand:                  gaClip(input.Device.Brand, gaMaxValueLength),
		},
	}
	for name, property := range output.UserProperties {
		if property.Value == "" {
			delete(output.UserProperties, name)
		}
	}
	// The country is the phone's region setting, which is the one place an
	// app can say where somebody is without asking for their location. The
	// address this arrived from is never passed on, so Google has nothing
	// better to place them by.
	if region := strings.ToUpper(strings.TrimSpace(input.Device.Region)); len(region) == 2 &&
		gaIsLetters(region) {
		output.UserLocation = &gaUserLocation{CountryID: region}
	}
	now := sender.now()
	for _, event := range input.Events {
		if forwarded, ok := gaRelayEvent(event, now); ok {
			output.Events = append(output.Events, forwarded)
		}
	}
	return output, nil
}

// gaRelayEvent checks one event from an app, and reports whether to keep it.
func gaRelayEvent(event analyticsRelayEvent, now time.Time) (gaEvent, bool) {
	if !gaNamePattern.MatchString(event.Name) || gaReservedNames[event.Name] {
		return gaEvent{}, false
	}
	if len(event.Params) > gaMaxParamsPerEvent-1 {
		return gaEvent{}, false
	}
	params := make(map[string]any, len(event.Params)+1)
	for key, value := range event.Params {
		if !gaNamePattern.MatchString(key) || key == "timestamp_micros" {
			return gaEvent{}, false
		}
		switch typed := value.(type) {
		case string:
			params[key] = gaClip(typed, gaMaxValueLength)
		case float64:
			if math.IsNaN(typed) || math.IsInf(typed, 0) {
				return gaEvent{}, false
			}
			params[key] = typed
		case bool:
			// Google has no boolean parameter; a custom dimension reads the
			// string.
			params[key] = fmt.Sprint(typed)
		default:
			return gaEvent{}, false
		}
	}
	if event.TimeMs > 0 {
		happened := time.UnixMilli(event.TimeMs)
		if now.Sub(happened) > gaMaxEventAge {
			return gaEvent{}, false
		}
		// A phone's clock running ahead is stamped now rather than in the
		// future, which Google would also refuse.
		if happened.After(now) {
			happened = now
		}
		params["timestamp_micros"] = happened.UnixMicro()
	}
	return gaEvent{Name: event.Name, Params: params}, true
}

// gaClip trims a value to Google's limit, on a rune boundary.
func gaClip(value string, limit int) string {
	value = strings.TrimSpace(value)
	if len(value) <= limit {
		return value
	}
	cut := limit
	for cut > 0 && !utf8.RuneStart(value[cut]) {
		cut--
	}
	return value[:cut]
}

func gaIsLetters(value string) bool {
	for _, character := range value {
		if character < 'A' || character > 'Z' {
			return false
		}
	}
	return true
}

// ------------------------------------------------------- the server's events --

// gameFinishedEvent describes a finished game without anybody in it: what was
// played and how it ended, never who played it. Every finished game passes
// through finishSession exactly once, which is where this is sent from.
func gameFinishedEvent(session *GameSession, state game.GameState, finishedAt time.Time) map[string]any {
	players := "human_vs_human"
	switch {
	case session.redIsEngine && session.blueIsEngine:
		players = "bot_vs_bot"
	case session.redIsEngine || session.blueIsEngine:
		players = "human_vs_bot"
	}
	setting := "match"
	switch {
	case session.tournament != nil && strings.HasPrefix(session.tournament.tournamentID, "nightly-"):
		setting = "arena"
	case session.tournament != nil:
		setting = "tournament"
	case session.botMatch != nil:
		setting = "bot_series"
	}
	ranked := "casual"
	if session.ranked {
		ranked = "ranked"
	}
	winner := "draw"
	switch state.Winner {
	case game.Red:
		winner = "red"
	case game.Blue:
		winner = "blue"
	}
	return map[string]any{
		"mode":         string(state.Mode.ID),
		"ranked":       ranked,
		"players":      players,
		"setting":      setting,
		"winner":       winner,
		"end_reason":   string(state.EndReason),
		"moves":        state.MoveNumber,
		"duration_sec": int64(finishedAt.Sub(session.startedAt).Seconds()),
		"time_control": fmt.Sprintf(
			"%d+%d",
			state.TimeControl.InitialTimeMs/1000,
			state.TimeControl.IncrementMs/1000,
		),
	}
}

// botConnectedEvent describes an engine coming online: its public name, which
// the leaderboard already prints, and the builds it runs. Never its owner or
// its author, who are people.
func botConnectedEvent(record persistence.Bot, clientVersion string) map[string]any {
	params := map[string]any{"bot": gaClip(record.Name, gaMaxValueLength)}
	if record.EngineName != "" {
		params["engine"] = gaClip(record.EngineName, gaMaxValueLength)
	}
	if record.EngineVersion != "" {
		params["engine_version"] = gaClip(record.EngineVersion, gaMaxValueLength)
	}
	if clientVersion != "" {
		params["client_version"] = gaClip(clientVersion, gaMaxValueLength)
	}
	return params
}

// FlushAnalytics sends what is still queued, for as long as ctx allows. Called
// once on the way out, after the drain goroutine has stopped: the last game of
// a deploy's drain is the one that ends it, and its event would otherwise be
// left in the queue.
func (server *Server) FlushAnalytics(ctx context.Context) {
	sender := server.analytics
	if !sender.enabled {
		return
	}
	for {
		select {
		case request := <-sender.queue:
			if err := sender.post(ctx, request); err != nil {
				log.Printf("Google Analytics: %v", err)
				return
			}
		default:
			return
		}
	}
}
