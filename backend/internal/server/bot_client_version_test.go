package server

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// The download links are the whole point of this endpoint: a bot author reads
// it to find out what to fetch. They were empty on a server without
// RPS_PUBLIC_URL set, which is both a laptop and a host whose environment file
// predates that variable, so these check that a link comes back and that
// following it actually gets the file the same response advertises.

func TestBotVersionPublishesFollowableLinksWithoutPublicURL(t *testing.T) {
	httpServer := httptest.NewServer(New(nil).Routes())
	defer httpServer.Close()

	version := getBotVersion(t, httpServer.URL, nil)
	for name, link := range map[string]string{
		"downloadUrl": version.DownloadURL,
		"exampleUrl":  version.ExampleURL,
		"guideUrl":    version.GuideURL,
	} {
		if link != httpServer.URL+expectedPaths[name] {
			t.Errorf("%s = %q, want %q", name, link, httpServer.URL+expectedPaths[name])
		}
	}

	for _, download := range []struct {
		link string
		want string
	}{
		{version.DownloadURL, version.SHA256},
		{version.ExampleURL, version.ExampleSHA256},
	} {
		body := get(t, download.link, nil)
		sum := sha256.Sum256(body)
		if got := hex.EncodeToString(sum[:]); got != download.want {
			t.Errorf("%s served a file with digest %s, advertised %s", download.link, got, download.want)
		}
	}

	// The guide link has to lead to the documents, because a protocol change is
	// something a bot author finds out about by reading them.
	var guide struct {
		DownloadURL string `json:"downloadUrl"`
		ExampleURL  string `json:"exampleUrl"`
		Guide       string `json:"guide"`
		Protocol    string `json:"protocol"`
	}
	if err := json.Unmarshal(get(t, version.GuideURL, nil), &guide); err != nil {
		t.Fatal(err)
	}
	if guide.Guide == "" || guide.Protocol == "" {
		t.Error("guideUrl served no guide or no protocol")
	}
	// Two handlers building the same links is exactly how they drift apart.
	if guide.DownloadURL != version.DownloadURL || guide.ExampleURL != version.ExampleURL {
		t.Errorf("guide links %q/%q disagree with version links %q/%q",
			guide.DownloadURL, guide.ExampleURL, version.DownloadURL, version.ExampleURL)
	}
}

var expectedPaths = map[string]string{
	"downloadUrl": botClientPath,
	"exampleUrl":  exampleEnginePath,
	"guideUrl":    botGuidePath,
}

func TestBotVersionPrefersConfiguredPublicURL(t *testing.T) {
	server := New(nil)
	// Trailing slash included: an operator will write one sooner or later, and
	// a doubled slash in a download link is the kind of thing people report.
	server.SetPublicBaseURL("https://api-rps.example.com/")
	httpServer := httptest.NewServer(server.Routes())
	defer httpServer.Close()

	version := getBotVersion(t, httpServer.URL, nil)
	if version.DownloadURL != "https://api-rps.example.com/api/bot/rpsbot.py" {
		t.Errorf("downloadUrl = %q, want the configured host", version.DownloadURL)
	}
	if version.ExampleURL != "https://api-rps.example.com/api/bot/example_engine.py" {
		t.Errorf("exampleUrl = %q, want the configured host", version.ExampleURL)
	}
}

// Behind nginx the process is reached over http on a unix socket while the
// public link is https, so a link built from the request has to read the
// forwarded scheme or it hands people a URL that redirects.
func TestBotVersionHonoursForwardedProtocol(t *testing.T) {
	httpServer := httptest.NewServer(New(nil).Routes())
	defer httpServer.Close()

	version := getBotVersion(t, httpServer.URL, http.Header{
		"X-Forwarded-Proto": []string{"https"},
	})
	if !strings.HasPrefix(version.DownloadURL, "https://") {
		t.Errorf("downloadUrl = %q, want https", version.DownloadURL)
	}
}

func TestRequestOrigin(t *testing.T) {
	for _, testCase := range []struct {
		name      string
		host      string
		forwarded string
		want      string
	}{
		{name: "plain", host: "localhost:8080", want: "http://localhost:8080"},
		{name: "forwarded", host: "api-rps.example.com", forwarded: "https", want: "https://api-rps.example.com"},
		{name: "forwarded chain", host: "api-rps.example.com", forwarded: "https, http", want: "https://api-rps.example.com"},
		{name: "ipv6", host: "[::1]:8080", want: "http://[::1]:8080"},
		{name: "no host", host: "", want: ""},
		// Nothing that could turn one link into another, or smuggle a path.
		{name: "hostile host", host: "evil.example.com/../..", want: ""},
		{name: "spaced host", host: "localhost:8080 evil.example.com", want: ""},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodGet, "/api/bot/version", nil)
			request.Host = testCase.host
			if testCase.forwarded != "" {
				request.Header.Set("X-Forwarded-Proto", testCase.forwarded)
			}
			if got := requestOrigin(request); got != testCase.want {
				t.Errorf("requestOrigin() = %q, want %q", got, testCase.want)
			}
		})
	}
}

func getBotVersion(t *testing.T, baseURL string, header http.Header) botClientVersion {
	t.Helper()
	var version botClientVersion
	if err := json.Unmarshal(get(t, baseURL+"/api/bot/version", header), &version); err != nil {
		t.Fatal(err)
	}
	return version
}

func get(t *testing.T, url string, header http.Header) []byte {
	t.Helper()
	if url == "" {
		t.Fatal("no URL to follow")
	}
	request, err := http.NewRequest(http.MethodGet, url, nil)
	if err != nil {
		t.Fatal(err)
	}
	for name, values := range header {
		request.Header[name] = values
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = response.Body.Close() }()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("GET %s: %s", url, response.Status)
	}
	body, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatal(err)
	}
	return body
}
