package server

// The Lab's agent relay, without leaving the process.
//
// A fake OpenAI on an httptest TLS server, reached through the client httptest
// hands back — macOS ignores SSL_CERT_FILE, so nothing else trusts the
// certificate. That is what the injectable client on agentRelay is for.
//
// The tests worth having here are not "does it forward bytes". They are:
// does it stay a relay rather than becoming an open proxy on somebody's key,
// does a frame reach the browser before the model has finished talking, and
// does hanging up actually stop the meter running.

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

type fakeOpenAI struct {
	server *httptest.Server
	// What it was asked for, so the tests can assert the shape rather than the
	// mere fact of a request.
	lastPayload agentUpstreamRequest
	lastAuth    string
	calls       int

	// release gates the second frame, so a test can prove the first one arrived
	// before the stream was finished.
	release chan struct{}
	// blocked closes when the handler notices the client has gone.
	blocked chan struct{}
	// status, when set, is answered instead of a stream.
	status int

	holdUntilCancelled bool
}

func newFakeOpenAI(t *testing.T) *fakeOpenAI {
	t.Helper()
	fake := &fakeOpenAI{release: make(chan struct{}), blocked: make(chan struct{})}
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/responses", func(writer http.ResponseWriter, request *http.Request) {
		fake.calls++
		fake.lastAuth = request.Header.Get("Authorization")
		body, _ := io.ReadAll(request.Body)
		_ = json.Unmarshal(body, &fake.lastPayload)

		if fake.status != 0 {
			http.Error(writer, `{"error":{"message":"the key sk-live-abcdef belongs to acme-corp"}}`, fake.status)
			return
		}

		writer.Header().Set("Content-Type", "text/event-stream")
		writer.WriteHeader(http.StatusOK)
		flusher, _ := writer.(http.Flusher)

		_, _ = writer.Write([]byte("event: response.output_text.delta\ndata: {\"item_id\":\"m1\",\"delta\":\"Rock\"}\n\n"))
		flusher.Flush()

		if fake.holdUntilCancelled {
			<-request.Context().Done()
			close(fake.blocked)
			return
		}

		<-fake.release
		_, _ = writer.Write([]byte("event: response.completed\ndata: {\"response\":{\"usage\":{\"input_tokens\":9,\"output_tokens\":2}}}\n\n"))
		flusher.Flush()
	})
	fake.server = httptest.NewTLSServer(mux)
	t.Cleanup(fake.server.Close)
	return fake
}

// agentTestServer wires a Server to the fake the way production wires it to
// OpenAI: poked directly, matching how the Discord and push tests do it.
func agentTestServer(t *testing.T) (labTestServer, *fakeOpenAI) {
	t.Helper()
	harness := newLabTestServer(t)
	fake := newFakeOpenAI(t)
	harness.server.agent = &agentRelay{
		enabled:  true,
		apiKey:   "sk-test-key",
		model:    "test-model",
		url:      fake.server.URL + "/v1/responses",
		client:   fake.server.Client(),
		limiter:  newRateLimiter(agentStreamBurst, agentStreamWindow),
		inFlight: make(chan struct{}, agentMaxConcurrent),
	}
	return harness, fake
}

const agentBody = `{"instructions":"be brief","input":[{"type":"message","role":"user","content":"hi"}],"tools":[]}`

func TestAgentStatusSaysWhetherAKeyIsHereWithoutRevealingIt(t *testing.T) {
	harness, _ := agentTestServer(t)

	response := labRequest(t, harness, http.MethodGet, "/api/lab/agent/status", "")
	if response.StatusCode != http.StatusOK {
		t.Fatalf("status: %d", response.StatusCode)
	}
	body, _ := io.ReadAll(response.Body)
	var status agentStatusResponse
	if err := json.Unmarshal(body, &status); err != nil {
		t.Fatal(err)
	}
	if !status.Configured || status.Model != "test-model" {
		t.Fatalf("expected a configured relay naming its model, got %+v", status)
	}
	if strings.Contains(string(body), "sk-test") {
		t.Fatalf("the key must never appear in a response: %s", body)
	}

	// Unconfigured is an ordinary answer, not an error: the page then offers to
	// use a key the visitor brings.
	harness.server.agent.enabled = false
	response = labRequest(t, harness, http.MethodGet, "/api/lab/agent/status", "")
	body, _ = io.ReadAll(response.Body)
	_ = json.Unmarshal(body, &status)
	if status.Configured || status.Model != "" {
		t.Fatalf("expected an unconfigured relay to name no model, got %+v", status)
	}
}

func TestAgentStreamPinsTheModelAndRefusesToStore(t *testing.T) {
	harness, fake := agentTestServer(t)
	close(fake.release)

	response := labRequest(t, harness, http.MethodPost, "/api/lab/agent/stream", agentBody)
	if response.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(response.Body)
		t.Fatalf("status %d: %s", response.StatusCode, body)
	}
	_, _ = io.ReadAll(response.Body)

	if fake.lastPayload.Model != "test-model" {
		t.Fatalf("the server picks the model, got %q", fake.lastPayload.Model)
	}
	if !fake.lastPayload.Stream || fake.lastPayload.Store {
		t.Fatalf("expected stream:true store:false, got %+v", fake.lastPayload)
	}
	if fake.lastAuth != "Bearer sk-test-key" {
		t.Fatalf("upstream auth: %q", fake.lastAuth)
	}
}

func TestAgentStreamRefusesACallerThatNamesAModel(t *testing.T) {
	harness, fake := agentTestServer(t)
	close(fake.release)

	// The whole difference between a relay and an open proxy on our key. A field
	// that were merely ignored would look identical from here and cost nothing
	// to try, so it has to be a refusal.
	body := `{"model":"expensive-model","instructions":"","input":[{"type":"message"}],"tools":[]}`
	response := labRequest(t, harness, http.MethodPost, "/api/lab/agent/stream", body)
	if response.StatusCode != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", response.StatusCode)
	}
	if fake.calls != 0 {
		t.Fatal("nothing should have been sent upstream")
	}
}

func TestAgentStreamReachesTheBrowserBeforeTheModelHasFinished(t *testing.T) {
	harness, fake := agentTestServer(t)

	request, err := http.NewRequest(
		http.MethodPost,
		harness.http.URL+"/api/lab/agent/stream?userId="+labAuthorID,
		strings.NewReader(agentBody),
	)
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Authorization", "Bearer "+labAuthorKey)
	request.Header.Set("Content-Type", "application/json")

	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()

	if got := response.Header.Get("Content-Type"); got != "text/event-stream" {
		t.Fatalf("content type: %q", got)
	}

	reader := bufio.NewReader(response.Body)
	// The relay's own first frame, namespaced so a future OpenAI event cannot
	// shadow it. It is how the page learns which model actually ran.
	if line, _ := reader.ReadString('\n'); !strings.Contains(line, "rps.ready") {
		t.Fatalf("expected a ready frame first, got %q", line)
	}
	if line, _ := reader.ReadString('\n'); !strings.Contains(line, "test-model") {
		t.Fatalf("expected the model in the ready frame, got %q", line)
	}
	_, _ = reader.ReadString('\n')

	// The first real frame must arrive while the fake is still holding the
	// second one. If this blocks, something between here and there is buffering
	// and the whole point of streaming is lost.
	done := make(chan string, 1)
	go func() {
		line, _ := reader.ReadString('\n')
		done <- line
	}()
	select {
	case line := <-done:
		if !strings.Contains(line, "response.output_text.delta") {
			t.Fatalf("expected the first delta, got %q", line)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("the first frame was buffered until the stream ended")
	}

	close(fake.release)
	_, _ = io.ReadAll(response.Body)
}

func TestAgentStreamStopsTheModelWhenTheBrowserHangsUp(t *testing.T) {
	harness, fake := agentTestServer(t)
	fake.holdUntilCancelled = true

	ctx, cancel := context.WithCancel(context.Background())
	request, err := http.NewRequestWithContext(
		ctx,
		http.MethodPost,
		harness.http.URL+"/api/lab/agent/stream?userId="+labAuthorID,
		strings.NewReader(agentBody),
	)
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Authorization", "Bearer "+labAuthorKey)
	request.Header.Set("Content-Type", "application/json")

	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	reader := bufio.NewReader(response.Body)
	for i := 0; i < 3; i++ {
		_, _ = reader.ReadString('\n') // through the ready frame
	}

	// This is the test that says the Stop button stops the billing rather than
	// merely stopping the rendering.
	cancel()
	response.Body.Close()

	select {
	case <-fake.blocked:
	case <-time.After(3 * time.Second):
		t.Fatal("hanging up did not cancel the request to OpenAI")
	}
}

func TestAgentStreamDoesNotEchoWhatOpenAISaid(t *testing.T) {
	harness, fake := agentTestServer(t)
	fake.status = http.StatusUnauthorized

	response := labRequest(t, harness, http.MethodPost, "/api/lab/agent/stream", agentBody)
	if response.StatusCode != http.StatusBadGateway {
		t.Fatalf("expected 502, got %d", response.StatusCode)
	}
	body, _ := io.ReadAll(response.Body)
	// Upstream failures are about our key, not the caller's request, and the
	// message can name the account it belongs to.
	if strings.Contains(string(body), "sk-live") || strings.Contains(string(body), "acme-corp") {
		t.Fatalf("upstream error leaked through: %s", body)
	}
}

func TestAgentStreamRefusesAnOversizedConversation(t *testing.T) {
	harness, fake := agentTestServer(t)
	close(fake.release)

	huge := `{"instructions":"","input":[{"type":"message","content":"` +
		strings.Repeat("x", agentRequestLimit+1024) + `"}],"tools":[]}`
	response := labRequest(t, harness, http.MethodPost, "/api/lab/agent/stream", huge)
	if response.StatusCode != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", response.StatusCode)
	}
	if fake.calls != 0 {
		t.Fatal("nothing should have been sent upstream")
	}
}

func TestAgentStreamIsUnavailableWithoutAKey(t *testing.T) {
	harness, fake := agentTestServer(t)
	harness.server.agent.enabled = false

	response := labRequest(t, harness, http.MethodPost, "/api/lab/agent/stream", agentBody)
	if response.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("expected 503, got %d", response.StatusCode)
	}
	body, _ := io.ReadAll(response.Body)
	// The message has to point at the way out, because for most deployments
	// this is the ordinary state rather than a fault.
	if !strings.Contains(string(body), "bring your own") {
		t.Fatalf("expected the message to name the alternative, got %s", body)
	}
	if fake.calls != 0 {
		t.Fatal("nothing should have been sent upstream")
	}
}
