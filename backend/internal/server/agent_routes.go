package server

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"
)

// The Lab's agent, relayed.
//
// The RPS Lab lets you design a game by describing it, and something has to
// drive the page's WebMCP tools while you do. That something is a model, and a
// model needs a key. There are two honest places to keep one:
//
//   - **Here.** The browser sends the conversation, this relays it to OpenAI and
//     copies the answer back. A visitor with no OpenAI account can use the Lab,
//     and nothing secret is ever in the page. `frontend/.env.production` says in
//     as many words that no secret may go the other way.
//   - **In the browser**, with a key the person pasted. That path needs no
//     server at all and is what runs when this one is unconfigured.
//
// Three properties of this handler are load-bearing, and each is a test:
//
//  1. **It is a relay, not a proxy.** The model, `stream` and `store` are pinned
//     here; a caller cannot name a model, and `DisallowUnknownFields` means one
//     that tries gets a 400 rather than being quietly ignored. Without that this
//     is an open OpenAI endpoint the moment the URL leaks.
//  2. **It is stateless.** The browser owns the conversation and re-sends it
//     whole. Nothing here can drift from what the page actually did.
//  3. **It copies frames without reading them.** No event names are parsed, so
//     this stream and the browser-to-OpenAI stream are byte-identical and the
//     client has exactly one parser to get right.

const (
	// A conversation carries a whole rule document and every tool result so far,
	// which is far more than the 16 KiB most routes here allow.
	agentRequestLimit = 512 << 10
	// The ceiling on one turn. Also what bounds an upstream that stops speaking
	// without closing: the context deadline tears the read down.
	agentStreamDeadline = 5 * time.Minute
	agentUpstreamURL    = "https://api.openai.com/v1/responses"
	// Spending somebody else's money wants a tighter throttle than publishing.
	// Generous for a person designing a game, useless for a script.
	agentStreamBurst  = 60
	agentStreamWindow = time.Hour
	// A run holds a connection open for as long as the model takes, so the
	// natural failure is exhaustion rather than volume.
	agentMaxConcurrent = 8
	agentDefaultModel  = "gpt-5.6-terra"
)

// agentRelay holds the key and the two seams a test reaches through.
//
// `url` and `client` exist for the same reason apnsSender's do: a test must be
// able to watch what was sent without a round trip to OpenAI, and on macOS only
// httptest's own client trusts an httptest certificate. Nothing in production
// sets either.
type agentRelay struct {
	enabled  bool
	apiKey   string
	model    string
	url      string
	client   httpDoer
	limiter  *rateLimiter
	inFlight chan struct{}
}

func newAgentRelay() *agentRelay {
	relay := &agentRelay{
		apiKey:   strings.TrimSpace(os.Getenv("RPS_OPENAI_API_KEY")),
		model:    strings.TrimSpace(os.Getenv("RPS_OPENAI_MODEL")),
		url:      strings.TrimSpace(os.Getenv("RPS_OPENAI_BASE_URL")),
		client:   &http.Client{Timeout: 0},
		limiter:  newRateLimiter(agentStreamBurst, agentStreamWindow),
		inFlight: make(chan struct{}, agentMaxConcurrent),
	}
	if relay.model == "" {
		relay.model = agentDefaultModel
	}
	// Pointing this elsewhere is for an OpenAI-compatible endpoint — a gateway,
	// a self-hosted model, or a scripted one while developing the Lab without
	// spending anything. It must be a full URL to the responses route.
	if relay.url == "" {
		relay.url = agentUpstreamURL
	}
	// Unconfigured is an ordinary state, not a misconfiguration: a fresh
	// checkout has no key, and the Lab still works with one the visitor brings.
	// Worth one line at boot so the reason the chat asks for a key is findable.
	relay.enabled = relay.apiKey != ""
	if !relay.enabled {
		log.Print("Lab agent relay disabled: set RPS_OPENAI_API_KEY to run it on this server")
	}
	return relay
}

func (relay *agentRelay) allow(writer http.ResponseWriter, request *http.Request, userID string) bool {
	for _, key := range []string{"agent-ip:" + clientIP(request), "agent-user:" + userID} {
		allowed, wait := relay.limiter.Allow(key)
		if !allowed {
			writer.Header().Set("Retry-After", strconv.Itoa(int(wait.Seconds())+1))
			writeAPIError(writer, http.StatusTooManyRequests, "too many agent runs; try again shortly")
			return false
		}
	}
	return true
}

/* ------------------------------------------------------------------ status -- */

type agentStatusResponse struct {
	// Whether this server can run the agent itself. False is ordinary: the page
	// then offers to use a key of the visitor's own.
	Configured bool   `json:"configured"`
	Model      string `json:"model"`
	MaxTurns   int    `json:"maxTurns"`
	MaxWallMs  int    `json:"maxWallMs"`
}

// Unauthenticated, because it reveals nothing: whether a key exists, and which
// model it would run. Never the key, a prefix of it, or its length.
func (server *Server) getAgentStatus(writer http.ResponseWriter, request *http.Request) {
	relay := server.agent
	status := agentStatusResponse{MaxTurns: 12, MaxWallMs: int(agentStreamDeadline / time.Millisecond)}
	if relay != nil && relay.enabled {
		status.Configured = true
		status.Model = relay.model
	}
	writeJSON(writer, http.StatusOK, status)
}

/* ------------------------------------------------------------------ stream -- */

// What the browser may ask for. Note what is absent: the model, `stream` and
// `store`. Those belong to the server, and `DisallowUnknownFields` turns an
// attempt to send one into a 400 rather than something silently dropped.
type agentStreamRequest struct {
	Instructions      string            `json:"instructions"`
	Input             []json.RawMessage `json:"input"`
	Tools             []json.RawMessage `json:"tools"`
	ParallelToolCalls *bool             `json:"parallel_tool_calls,omitempty"`
	MaxOutputTokens   int               `json:"max_output_tokens,omitempty"`
}

type agentUpstreamRequest struct {
	Model             string            `json:"model"`
	Stream            bool              `json:"stream"`
	Store             bool              `json:"store"`
	Include           []string          `json:"include,omitempty"`
	Instructions      string            `json:"instructions,omitempty"`
	Input             []json.RawMessage `json:"input"`
	Tools             []json.RawMessage `json:"tools,omitempty"`
	ParallelToolCalls *bool             `json:"parallel_tool_calls,omitempty"`
	MaxOutputTokens   int               `json:"max_output_tokens,omitempty"`
}

// The body actually sent upstream. `Input` and `Tools` stay opaque — this has no
// reason to understand a conversation — but they are re-marshalled into a struct
// this file owns rather than forwarded as raw bytes, which is what stops a
// caller smuggling a field of its own alongside them.
func (relay *agentRelay) upstreamPayload(body agentStreamRequest) agentUpstreamRequest {
	return agentUpstreamRequest{
		Model:  relay.model,
		Stream: true,
		Store:  false,
		// Reasoning has to survive the tool round trip or the model forgets why
		// it called what it just called. With nothing stored there is no id to
		// point at, so it comes back encrypted and goes out again the same way.
		Include:           []string{"reasoning.encrypted_content"},
		Instructions:      body.Instructions,
		Input:             body.Input,
		Tools:             body.Tools,
		ParallelToolCalls: body.ParallelToolCalls,
		MaxOutputTokens:   body.MaxOutputTokens,
	}
}

func (server *Server) relayAgentStream(writer http.ResponseWriter, request *http.Request) {
	relay := server.agent
	if relay == nil || !relay.enabled {
		writeAPIError(writer, http.StatusServiceUnavailable,
			"this server has no OpenAI key; bring your own in the Lab")
		return
	}

	// Publishing is open to a guest and so is this, for the same reason: the
	// visitor most likely to want to design a game is the one who never
	// registered. But it spends money, so it happens under *some* name.
	account, ok := server.requireAnyIdentity(writer, request)
	if !ok {
		return
	}
	if !relay.allow(writer, request, account.UserID) {
		return
	}

	select {
	case relay.inFlight <- struct{}{}:
		defer func() { <-relay.inFlight }()
	default:
		writeAPIError(writer, http.StatusTooManyRequests, "too many agent runs at once; try again shortly")
		return
	}

	// Decoded here rather than through decodeAPIRequest, which re-applies a
	// 16 KiB cap of its own and would refuse every conversation past the first
	// few turns.
	request.Body = http.MaxBytesReader(writer, request.Body, agentRequestLimit)
	var body agentStreamRequest
	decoder := json.NewDecoder(request.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&body); err != nil {
		writeAPIError(writer, http.StatusBadRequest, "invalid JSON body: "+err.Error())
		return
	}
	if len(body.Input) == 0 {
		writeAPIError(writer, http.StatusBadRequest, "there is nothing to send")
		return
	}

	// The *request* context, not Background. This is the whole of how the Stop
	// button in the browser stops the meter running: the client hangs up,
	// net/http cancels this, and the upstream read is torn down with it.
	ctx, cancel := context.WithTimeout(request.Context(), agentStreamDeadline)
	defer cancel()

	payload, err := json.Marshal(relay.upstreamPayload(body))
	if err != nil {
		writeAPIError(writer, http.StatusBadRequest, "could not build that request")
		return
	}

	upstream, err := http.NewRequestWithContext(ctx, http.MethodPost, relay.url, bytes.NewReader(payload))
	if err != nil {
		writeAPIError(writer, http.StatusInternalServerError, "could not build that request")
		return
	}
	upstream.Header.Set("Authorization", "Bearer "+relay.apiKey)
	upstream.Header.Set("Content-Type", "application/json")
	upstream.Header.Set("Accept", "text/event-stream")

	response, err := relay.client.Do(upstream)
	if err != nil {
		if ctx.Err() != nil {
			return
		}
		writeAPIError(writer, http.StatusBadGateway, "could not reach OpenAI")
		return
	}
	defer response.Body.Close()

	// Nothing has been streamed yet, so a failure here is still an ordinary JSON
	// error. The upstream body is drained but never echoed: it can name the
	// account the key belongs to.
	if response.StatusCode != http.StatusOK {
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 8<<10))
		writeAPIError(writer, agentRelayStatus(response.StatusCode), agentRelayMessage(response.StatusCode))
		return
	}

	writer.Header().Set("Content-Type", "text/event-stream")
	writer.Header().Set("Cache-Control", "no-cache, no-transform")
	writer.Header().Set("Connection", "keep-alive")
	// For any deployment that buffers proxied responses by default. The nginx in
	// deploy/ already turns buffering off, so this is for the other ones.
	writer.Header().Set("X-Accel-Buffering", "no")
	writer.WriteHeader(http.StatusOK)

	controller := http.NewResponseController(writer)
	// A stream that lasts minutes must outlive any write deadline. There is none
	// set today; this is insurance for the day somebody adds one. Ignored by
	// httptest's recorder, which is why the error is dropped rather than checked.
	_ = controller.SetWriteDeadline(time.Time{})

	// One frame of our own before anything else, namespaced so it can never
	// collide with an event OpenAI adds later. It is how the page reports which
	// model actually ran without having to be told in advance.
	agentRelayFrame(writer, controller, "rps.ready", map[string]string{"model": relay.model})

	reader := bufio.NewReaderSize(response.Body, 64<<10)
	for {
		line, err := reader.ReadBytes('\n')
		if len(line) > 0 {
			if _, writeErr := writer.Write(line); writeErr != nil {
				return // The browser has gone. The deferred cancel stops upstream.
			}
			// A blank line ends an SSE frame, and a frame the client has not been
			// given is a frame that did not arrive in time to matter.
			if len(bytes.TrimSpace(line)) == 0 {
				_ = controller.Flush()
			}
		}
		if err != nil {
			if !errors.Is(err, io.EOF) && ctx.Err() == nil {
				// Too late for a status code, so it goes in the stream.
				agentRelayFrame(writer, controller, "rps.error",
					map[string]string{"message": "the connection to OpenAI ended early"})
			}
			_ = controller.Flush()
			return
		}
		if ctx.Err() != nil {
			return
		}
	}
}

func agentRelayFrame(writer http.ResponseWriter, controller *http.ResponseController, event string, data any) {
	encoded, err := json.Marshal(data)
	if err != nil {
		return
	}
	_, _ = writer.Write([]byte("event: " + event + "\ndata: "))
	_, _ = writer.Write(encoded)
	_, _ = writer.Write([]byte("\n\n"))
	_ = controller.Flush()
}

// What a failure upstream means to the person at the keyboard. Deliberately not
// a passthrough: OpenAI's own message can name the account the key belongs to,
// and its status codes are about our key rather than about their request.
func agentRelayStatus(upstream int) int {
	switch upstream {
	case http.StatusTooManyRequests:
		return http.StatusTooManyRequests
	case http.StatusBadRequest, http.StatusUnprocessableEntity:
		return http.StatusBadRequest
	default:
		return http.StatusBadGateway
	}
}

func agentRelayMessage(upstream int) string {
	switch upstream {
	case http.StatusTooManyRequests:
		return "the model is busy; try again in a moment"
	case http.StatusUnauthorized, http.StatusForbidden:
		return "this server's OpenAI key was refused"
	case http.StatusBadRequest, http.StatusUnprocessableEntity:
		return "the model refused that conversation"
	default:
		return "the model could not be reached"
	}
}
