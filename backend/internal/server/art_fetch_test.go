package server

import (
	"bytes"
	"context"
	"errors"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"rps-strategy/backend/internal/persistence"
)

// smallPNG is a valid opaque-with-alpha PNG of a given side, so a test can talk
// about sizes and formats without carrying a fixture file around.
func smallPNG(t *testing.T, side int) []byte {
	t.Helper()
	return pngOf(t, side, side)
}

func pngOf(t *testing.T, width, height int) []byte {
	t.Helper()
	canvas := image.NewNRGBA(image.Rect(0, 0, width, height))
	for y := 0; y < height; y++ {
		for x := 0; x < width; x++ {
			canvas.Set(x, y, color.NRGBA{R: uint8(x), G: uint8(y), B: 0x40, A: 0xC0})
		}
	}
	var buffer bytes.Buffer
	if err := png.Encode(&buffer, canvas); err != nil {
		t.Fatal(err)
	}
	return buffer.Bytes()
}

func jpegOf(t *testing.T, width, height int) []byte {
	t.Helper()
	canvas := image.NewRGBA(image.Rect(0, 0, width, height))
	for y := 0; y < height; y++ {
		for x := 0; x < width; x++ {
			canvas.Set(x, y, color.RGBA{R: uint8(x), G: uint8(y), B: 0x40, A: 0xFF})
		}
	}
	var buffer bytes.Buffer
	if err := jpeg.Encode(&buffer, canvas, &jpeg.Options{Quality: 90}); err != nil {
		t.Fatal(err)
	}
	return buffer.Bytes()
}

func pieceLimits() persistence.ArtLimits {
	return persistence.ArtRoleLimits["piece"]
}

// The address table is the only fast and complete way to cover the ranges, and
// the ranges are the whole defence. Everything else in this file tests one
// behaviour each; this tests the thing an attacker is actually aiming at.
func TestTheAddressGuardRefusesEverythingThatIsNotPublic(t *testing.T) {
	refused := []string{
		"127.0.0.1", "127.1.2.3", "::1",
		"0.0.0.0", "::",
		"10.0.0.1", "172.16.0.1", "172.31.255.255", "192.168.1.1",
		"169.254.169.254", // the cloud metadata endpoint
		"169.254.0.1",
		"100.64.0.1", "100.127.255.255", // carrier-grade NAT, which IsPrivate misses
		"192.0.0.1", "192.0.2.5", "198.51.100.5", "203.0.113.5",
		"192.88.99.1", "198.18.0.1", "240.0.0.1", "255.255.255.255",
		"224.0.0.1", "ff02::1",
		"fe80::1", "fc00::1", "fd12:3456::1",
		"::ffff:127.0.0.1", "::ffff:10.0.0.1",
		"2002:7f00:1::", "2001::1", "64:ff9b::7f00:1", "100::1",
	}
	for _, address := range refused {
		ip := net.ParseIP(address)
		if ip == nil {
			t.Fatalf("%q is not an address, so the test is wrong", address)
		}
		if !blockedAddress(ip) {
			t.Errorf("%s was allowed, and it should not have been", address)
		}
	}

	allowed := []string{"93.184.216.34", "1.1.1.1", "8.8.8.8", "2606:4700::1111", "2a00:1450::1"}
	for _, address := range allowed {
		ip := net.ParseIP(address)
		if blockedAddress(ip) {
			t.Errorf("%s was refused, and it is an ordinary public address", address)
		}
	}
}

func TestAURLHasToBeAnOrdinaryPublicHTTPSOne(t *testing.T) {
	for _, refused := range []string{
		"http://example.com/a.png",          // not https
		"ftp://example.com/a.png",           // not https
		"https://user:pw@example.com/a.png", // carries a credential
		"https://example.com:8443/a.png",    // not the standard port
		"https://localhost/a.png",           // single label
		"https://build.local/a.png",         // a private zone
		"https://thing.internal/a.png",
		"https://127.0.0.1/a.png",
		"https://[::1]/a.png",
		"https://169.254.169.254/latest/meta-data/",
	} {
		target, err := url.Parse(refused)
		if err != nil {
			t.Fatalf("%q is not a URL, so the test is wrong", refused)
		}
		if err := validateArtURL(target); err == nil {
			t.Errorf("%s was accepted", refused)
		}
	}

	for _, allowed := range []string{
		"https://example.com/a.png",
		"https://cdn.example.co.uk:443/deep/path/a.jpg",
		"https://93.184.216.34/a.png",
	} {
		target, _ := url.Parse(allowed)
		if err := validateArtURL(target); err != nil {
			t.Errorf("%s should be an ordinary URL: %v", allowed, err)
		}
	}
}

// Proves the Control hook is actually attached to the transport a request goes
// out on. Written against the *production* fetcher on purpose: every other test
// here injects httptest's own client, whose transport has no hook, so none of
// them can see this — and this is exactly the wiring that gets quietly lost.
func TestTheProductionFetcherRefusesLoopbackEvenWithSomethingListening(t *testing.T) {
	upstream := httptest.NewTLSServer(http.HandlerFunc(
		func(writer http.ResponseWriter, _ *http.Request) {
			writer.Header().Set("Content-Type", "image/png")
			_, _ = writer.Write(smallPNG(t, 64))
		}))
	defer upstream.Close()

	// The hostname check would refuse `127.0.0.1` before dialling, so point at
	// a name that resolves to loopback instead: the guard has to be what stops
	// it, at connect time.
	address := strings.TrimPrefix(upstream.URL, "https://")
	_, port, _ := net.SplitHostPort(address)
	target := "https://localhost." + "example.com:" + port + "/a.png"

	_, err := newArtFetcher().fetch(context.Background(), target, pieceLimits())
	if err == nil {
		t.Fatal("the production fetcher reached a loopback server")
	}
}

// fetcherAgainst builds a fetcher that trusts one test server.
//
// Two seams, and both are needed for different reasons. The client, because on
// macOS it is the only way to exercise real outbound HTTPS at all: crypto/x509
// reads SSL_CERT_FILE only on unix && !darwin, so an httptest certificate is
// trusted by that server's own client and by nothing else. And the URL policy,
// because httptest listens on loopback with a random port — which the real
// policy refuses twice over, correctly.
//
// The widening is exactly one authority. Everything else still goes through
// validateArtURL, which is what keeps the redirect tests below honest: a
// redirect to http:// or to the metadata endpoint is refused here the same way
// it would be in production.
func fetcherAgainst(upstream *httptest.Server) *artFetcher {
	fetcher := newArtFetcher()
	client := upstream.Client()
	client.CheckRedirect = fetcher.client.(*http.Client).CheckRedirect
	client.Timeout = artFetchDeadline
	fetcher.client = client

	allowed := strings.TrimPrefix(upstream.URL, "https://")
	fetcher.allowTarget = func(target *url.URL) error {
		if target.Scheme == "https" && target.Host == allowed {
			return nil
		}
		return validateArtURL(target)
	}
	return fetcher
}

func TestAFetchedPictureIsTheBytesTheHostServed(t *testing.T) {
	want := smallPNG(t, 64)
	upstream := httptest.NewTLSServer(http.HandlerFunc(
		func(writer http.ResponseWriter, _ *http.Request) {
			writer.Header().Set("Content-Type", "image/png")
			_, _ = writer.Write(want)
		}))
	defer upstream.Close()

	got, err := fetcherAgainst(upstream).
		fetch(context.Background(), upstream.URL+"/a.png", pieceLimits())
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != len(want) {
		t.Fatalf("fetched %d bytes, served %d", len(got), len(want))
	}
}

func TestAFetchStopsAtTheByteLimit(t *testing.T) {
	upstream := httptest.NewTLSServer(http.HandlerFunc(
		func(writer http.ResponseWriter, _ *http.Request) {
			writer.Header().Set("Content-Type", "image/png")
			// No Content-Length, so the limit has to hold on the read itself.
			for written := 0; written < pieceLimits().WireBytes*2; written += 4096 {
				if _, err := writer.Write(make([]byte, 4096)); err != nil {
					return
				}
			}
		}))
	defer upstream.Close()

	_, err := fetcherAgainst(upstream).
		fetch(context.Background(), upstream.URL+"/big.png", pieceLimits())
	if err == nil || !strings.Contains(err.Error(), "larger than") {
		t.Fatalf("an oversized body was not stopped: %v", err)
	}
}

func TestAWebPageIsRefusedByName(t *testing.T) {
	upstream := httptest.NewTLSServer(http.HandlerFunc(
		func(writer http.ResponseWriter, _ *http.Request) {
			writer.Header().Set("Content-Type", "text/html; charset=utf-8")
			_, _ = writer.Write([]byte("<!doctype html><title>not a picture</title>"))
		}))
	defer upstream.Close()

	_, err := fetcherAgainst(upstream).
		fetch(context.Background(), upstream.URL+"/page", pieceLimits())
	if err == nil || !strings.Contains(err.Error(), "text/html") {
		t.Fatalf("a web page should be refused by name: %v", err)
	}
}

// Real content hosts mislabel images constantly, so the header is a hint and
// the magic bytes are the authority — in both directions.
func TestAPictureServedAsOctetStreamIsAcceptedAndAnHTMLPageIsNot(t *testing.T) {
	png := smallPNG(t, 64)
	upstream := httptest.NewTLSServer(http.HandlerFunc(
		func(writer http.ResponseWriter, request *http.Request) {
			writer.Header().Set("Content-Type", "application/octet-stream")
			if strings.Contains(request.URL.Path, "lie") {
				_, _ = writer.Write([]byte("<!doctype html>"))
				return
			}
			_, _ = writer.Write(png)
		}))
	defer upstream.Close()

	fetcher := fetcherAgainst(upstream)
	if _, err := fetcher.fetch(context.Background(), upstream.URL+"/a", pieceLimits()); err != nil {
		t.Fatalf("a mislabelled picture should still be accepted: %v", err)
	}
	if _, err := fetcher.fetch(context.Background(), upstream.URL+"/lie", pieceLimits()); err == nil {
		t.Fatal("a web page wearing an octet-stream header was accepted")
	}
}

func TestAFetchFollowsOnlyAFewRedirectsAndNoneSomewhereWorse(t *testing.T) {
	upstream := httptest.NewTLSServer(http.HandlerFunc(
		func(writer http.ResponseWriter, request *http.Request) {
			switch {
			case strings.HasPrefix(request.URL.Path, "/loop"):
				http.Redirect(writer, request, "/loop2", http.StatusFound)
			case strings.HasPrefix(request.URL.Path, "/plain"):
				http.Redirect(writer, request, "http://example.com/a.png", http.StatusFound)
			case strings.HasPrefix(request.URL.Path, "/inside"):
				http.Redirect(writer, request, "https://169.254.169.254/", http.StatusFound)
			default:
				http.Redirect(writer, request, "/loop", http.StatusFound)
			}
		}))
	defer upstream.Close()

	fetcher := fetcherAgainst(upstream)
	for _, path := range []string{"/loop", "/plain", "/inside"} {
		if _, err := fetcher.fetch(context.Background(), upstream.URL+path, pieceLimits()); err == nil {
			t.Errorf("%s should not have been followed", path)
		}
	}
}

func TestNothingFromTheInboundRequestReachesTheFetch(t *testing.T) {
	var seen http.Header
	upstream := httptest.NewTLSServer(http.HandlerFunc(
		func(writer http.ResponseWriter, request *http.Request) {
			seen = request.Header.Clone()
			writer.Header().Set("Content-Type", "image/png")
			_, _ = writer.Write(smallPNG(t, 64))
		}))
	defer upstream.Close()

	if _, err := fetcherAgainst(upstream).
		fetch(context.Background(), upstream.URL+"/a.png", pieceLimits()); err != nil {
		t.Fatal(err)
	}
	for _, header := range []string{"Authorization", "Cookie", "X-Forwarded-For"} {
		if seen.Get(header) != "" {
			t.Errorf("%s was sent to the host", header)
		}
	}
	if seen.Get("User-Agent") != "rps-strategy-art-fetch/1" {
		t.Errorf("the fetch should say what it is: %q", seen.Get("User-Agent"))
	}
}

func TestOnlySoManyFetchesRunAtOnce(t *testing.T) {
	fetcher := newArtFetcher()
	for range cap(fetcher.inFlight) {
		fetcher.inFlight <- struct{}{}
	}
	_, err := fetcher.fetch(context.Background(), "https://example.com/a.png", pieceLimits())
	if err == nil || !strings.Contains(err.Error(), "at once") {
		t.Fatalf("a full queue should refuse rather than wait: %v", err)
	}
}

func TestAFetchErrorSaysWhatIsWrongWithTheURL(t *testing.T) {
	_, err := newArtFetcher().fetch(context.Background(), "https://169.254.169.254/a.png", pieceLimits())
	if err == nil {
		t.Fatal("the metadata endpoint was allowed")
	}
	var refused *net.AddrError
	if errors.As(err, &refused) {
		t.Fatal("the error should name the address, not the resolver")
	}
	if !strings.Contains(err.Error(), "169.254.169.254") {
		t.Fatalf("the error should name the address it refused: %v", err)
	}
}
